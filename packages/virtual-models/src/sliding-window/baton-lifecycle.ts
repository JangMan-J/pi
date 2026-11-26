import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { Api, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	type Agent,
	AgentDoc,
	type AnyTask,
	type BeforeAgentStartReset,
	type BeforeAgentStartSidecarUsage,
	type ContextView,
	type ConversationStreamOptions,
	defineTask,
	type EntryId,
	type GenerationHooks,
	type HookTask,
	hookTask,
	type NextTaskState,
	ResetEntry,
	type RunSummary,
	recordSidecarUsage,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import { isVirtualModel } from "../core/predicates.ts";
import { attachVirtualRequestScope } from "../core/runtime.ts";
import { computeMessageCacheSnapshot } from "../durable/cache-snapshot.ts";
import { BatonStateDoc, VirtualModelStateDoc } from "../durable/docs.ts";
import { harvestPostReadStudyNotes } from "../study-notes.ts";
import { resolveBatonModel, runBatonSynthesis } from "./baton.ts";
import { effectiveWindowBounds } from "./bounds.ts";
import { projectSwapTokens } from "./fit.ts";
import { buildProseTranscript, fallbackProse, renderBatonSummary } from "./ledger.ts";
import { portableSha256Hex } from "./memory-store.ts";
import { normalizeSliceKey } from "./staging.ts";
import {
	type BatonPrepInput,
	type ConvState,
	lastReportedTokens,
	promptTokensOf,
	resolvePortablePath,
	resolveRefToPhysical,
	SlidingWindowLedgerDoc,
	type SlidingWindowState,
	SlidingWindowStateDoc,
	toJson,
} from "./state.ts";
import { chooseKeepFrom, estimateTextTokens, selectCut, viewTurns } from "./turns.ts";
import type { BatonResult, RawTurn } from "./types.ts";

export interface BatonLifecycle {
	readonly tasks: readonly AnyTask[];
	readonly hooks: Partial<GenerationHooks>;
}

function projectPostSwap(
	view: ContextView,
	tokens: number,
	keepFrom: string | null,
	summary: string,
	anchor: Message | undefined,
): number {
	const lastUserIdx = view.entries.findLastIndex(
		(_e, i) => !(view.head !== undefined && i === 0) && (view.contributions[i] ?? []).some((m) => m.role === "user"),
	);
	const keptAt = keepFrom === null ? lastUserIdx : view.entries.findIndex((e) => String(e.id) === keepFrom);
	const boundary = keptAt < 0 ? view.entries.length : keptAt;
	const lastAssistantIdx = view.entries.findLastIndex((_e, i) =>
		(view.contributions[i] ?? []).some((m) => m.role === "assistant"),
	);
	const split = lastAssistantIdx < 0 ? view.entries.length : lastAssistantIdx;
	let estimatedPrompt = 0;
	let estimatedDropped = 0;
	let estimatedTrailing = 0;
	view.contributions.forEach((msgs, i) => {
		for (const m of msgs) {
			const t = estimateMessageTokens(m);
			const dropped = i < boundary && m.role !== "system";
			if (i < split) {
				estimatedPrompt += t;
				if (dropped) estimatedDropped += t;
			} else if (!dropped) {
				estimatedTrailing += t;
			}
		}
	});
	return projectSwapTokens({
		reportedTokens: tokens,
		estimatedPrompt,
		estimatedDropped,
		estimatedTrailing,
		summaryTokens: estimateTextTokens(summary),
		estimatedAdded: anchor ? estimateMessageTokens(anchor) : 0,
	});
}

export function createBatonLifecycle(state: SlidingWindowState): BatonLifecycle {
	const { options, config, vProvider, states, routedRequestMeta } = state;

	const buildPrepInput = (
		c: ConvState,
		turns: readonly RawTurn[],
		tokens: number,
		keepRecentTokens: number,
		activeModel: Model<Api> | undefined,
	): BatonPrepInput | undefined => {
		const cut = selectCut(turns, config.keepTail, keepRecentTokens);
		if (cut.aged.length === 0) return undefined;
		const preparedThroughId = turns.at(-1)?.id;
		const prose = buildProseTranscript(cut.aged);
		return {
			epoch: c.ledger.epoch,
			prose,
			...(c.ledger.lastProseDigest !== undefined ? { previousDigest: c.ledger.lastProseDigest } : {}),
			batonModel: config.batonModel,
			batonThinkingLevel: config.batonThinkingLevel,
			batonMaxTokens: config.batonMaxTokens,
			...(activeModel && !isVirtualModel(activeModel)
				? { activeProvider: activeModel.provider, activeModelId: activeModel.id }
				: {}),
			firstKeptId: cut.firstKeptId,
			keptTokens: cut.keptTokens,
			...(preparedThroughId ? { preparedThroughId } : {}),
			tokens,
		};
	};

	const BatonWriteTask = defineTask<
		{
			epoch: number;
			anchor?: JsonValue;
			summary: string;
			swappedAtTokens: number;
			ledger: JsonValue;
			harvestedStudyNotes?: string;
		},
		{ phase: "commit" },
		null
	>({
		name: "sliding-window.baton-write",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, null>> => {
					const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
					doc.epoch = task.input.epoch;
					if (task.input.anchor !== undefined) {
						doc.anchorUser0 = task.input.anchor as JsonRepresentation<UserMessage>;
					} else {
						delete doc.anchorUser0;
					}
					doc.handoffSummary = task.input.summary;
					doc.swappedAtTokens = task.input.swappedAtTokens;
					doc.data = task.input.ledger;
					delete doc.staged;
					delete doc.preparingTaskId;
					if (task.input.harvestedStudyNotes !== undefined) {
						doc.harvestedStudyNotes = task.input.harvestedStudyNotes;
					}
					const ledgerDoc = await tx.doc(SlidingWindowLedgerDoc, runtime.conversationId);
					Object.assign(ledgerDoc, copyJson(task.input.ledger, { omitUndefinedProperties: true }));
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const BatonClearTask = defineTask<Record<string, never>, { phase: "commit" }, null>({
		name: "sliding-window.baton-clear",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (_task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
					delete doc.staged;
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const BatonPrepTask = defineTask<BatonPrepInput, { phase: "synthesize" }, null>({
		name: "sliding-window.baton-prep",
		version: 1,
		initial: () => ({ phase: "synthesize" }),
		phases: {
			synthesize: async (task, runtime, ctx) => {
				const models = runtime.models;
				let available: readonly Model<Api>[] = [];
				try {
					available = await models.getAvailable();
				} catch {
					// resolveBatonModel falls back cleanly
				}
				const activeModel =
					task.input.activeProvider && task.input.activeModelId
						? resolveRefToPhysical(
								{ provider: task.input.activeProvider, modelId: task.input.activeModelId },
								models,
							)
						: undefined;
				const resolution = resolveBatonModel(task.input.batonModel, task.input.batonThinkingLevel, activeModel, {
					find: (p, id) => models.getModel(p, id),
					getAvailable: () => available,
				});
				if (!resolution) {
					await runtime.commit(async (tx) => {
						const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
						return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
					}, ctx);
					const c = states.get(String(runtime.conversationId));
					if (c) c.note = "helper failed: no helper model available";
					return;
				}
				const cInRam = states.get(String(runtime.conversationId));
				if (cInRam) cInRam.note = `preparing via ${resolution.model.id}`;

				let res: BatonResult;
				try {
					res = await runBatonSynthesis({
						model: resolution.model,
						thinkingLevel: resolution.thinkingLevel,
						maxTokens: task.input.batonMaxTokens,
						previousDigest: task.input.previousDigest,
						prose: task.input.prose,
						signal: runtime.signal,
						complete: (model, context, opts) => {
							const now = runtime.now();
							return models.completeSimple(
								model,
								{
									messages: [
										{ role: "system", content: context.systemPrompt, timestamp: now },
										...context.messages.map((m) => ({
											role: "user" as const,
											content: m.content,
											timestamp: m.timestamp,
										})),
									],
								},
								{ ...opts, cacheRetention: "none" },
							);
						},
					});
				} catch (err) {
					await runtime.commit(async (tx) => {
						const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
						return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
					}, ctx);
					if (cInRam && !runtime.signal.aborted) {
						cInRam.note = `helper failed: ${err instanceof Error ? err.message : String(err)}`;
					}
					return;
				}

				await runtime.commit(async (tx) => {
					await recordSidecarUsage(
						tx,
						runtime.conversationId,
						"baton",
						res.model.provider,
						res.model.id,
						res.usage,
					);
					const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
					if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
					if (baton.epoch === task.input.epoch) {
						baton.staged = {
							firstKeptId: task.input.firstKeptId,
							proseDigest: res.proseDigest,
							keptTokens: task.input.keptTokens,
							...(task.input.preparedThroughId ? { preparedThroughId: task.input.preparedThroughId } : {}),
							provider: res.model.provider,
							modelId: res.model.id,
							durationMs: res.durationMs,
						};
					}
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);

				if (cInRam) {
					cInRam.note = `ready (${res.durationMs}ms, ${res.model.id}, prepared at ${task.input.tokens})`;
				}
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
				if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
				return { status: "terminal" as const, outcome: { status: "aborted" as const } };
			}, ctx);
		},
	});

	const BatonLaunchTask = defineTask<BatonPrepInput, { phase: "commit" }, null>({
		name: "sliding-window.baton-launch",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
					if (!baton.preparingTaskId && !baton.staged && baton.epoch === task.input.epoch) {
						const prepId = await tx.createTask(BatonPrepTask, task.input, {
							ownership: { kind: "conversation" },
							conversationId: runtime.conversationId,
							background: true,
						});
						baton.preparingTaskId = prepId;
						const c = states.get(String(runtime.conversationId));
						if (c) c.note = "preparing";
					}
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const WindowRoundTask = defineTask<
		{ readonly assistant: EntryId; readonly results: EntryId[] },
		{ phase: "commit" },
		null
	>({
		name: "sliding-window.round",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				const c = state.conv(String(runtime.conversationId));
				await state.hydrate(c, runtime, ctx);

				if (c.pendingCompletion) {
					const pending = c.pendingCompletion;
					c.pendingCompletion = undefined;
					if (pending.innerDef.onOutcome) {
						const toolResults: ToolResultMessage[] = [];
						for (const resultId of task.input.results) {
							const entry = await runtime.entry(ToolResultEntry, resultId, ctx);
							const msg = entry?.model?.[0];
							if (msg && msg.role === "toolResult") {
								toolResults.push(msg as ToolResultMessage);
							}
						}
						const nextState = await pending.innerDef.onOutcome({
							virtualModel: pending.innerModel,
							route: pending.completion.route,
							purpose: pending.purpose,
							turnIndex: pending.turnIndex,
							message: pending.completion.message,
							toolResults,
							ttfbMs: pending.completion.ttfbMs,
							durationMs: pending.completion.durationMs,
							aborted: pending.completion.message.stopReason === "aborted",
							state: pending.innerState,
						});
						if (nextState !== undefined) {
							c.pendingInnerState = nextState;
							c.pendingRouteStateToSave = toJson(nextState);
						}
					}
				}

				const enabled = state.isEnabled(runtime.conversationId, c);
				const view = await runtime.context(runtime.conversationId, ctx);
				const tokens = c.lastUsageTokens ?? lastReportedTokens(view.messages);

				type PreparedMidRunSwap = {
					readonly expectedEpoch: number;
					readonly nextEpoch: number;
					readonly keepEntryId: EntryId | "self";
					readonly resetModel: UserMessage[];
					readonly summary: string;
					readonly proseDigest: string;
					readonly anchor?: UserMessage;
					readonly data: JsonValue;
					readonly probeEstimated: number;
					readonly fallback: boolean;
					readonly harvestedStudyNotes?: string;
				};
				let preparedSwap: PreparedMidRunSwap | undefined;
				let cancelStaged = false;
				let prepInput: BatonPrepInput | undefined;

				if (enabled && !c.awaitingFirstResponse && tokens) {
					const agent = await runtime.agent(ctx);
					const baton = await runtime.snapshot(BatonStateDoc, runtime.conversationId, ctx);
					const activeModel = state.resolveTargetModel({
						conversationId: runtime.conversationId,
						targetRef: c.targetRef,
						agent,
						models: runtime.models,
					});
					if (activeModel && !isVirtualModel(activeModel)) c.lastPhysicalModel = activeModel;
					const { softCeilingTokens, hardCeilingTokens, keepRecentTokens } = effectiveWindowBounds(
						config,
						activeModel?.contextWindow,
					);
					const turns = viewTurns(view, (m) => estimateMessageTokens(m));
					const keptTokensFrom = (keepFrom: string | null) => {
						if (keepFrom === null) return 0;
						const at = turns.findIndex((t) => t.id === keepFrom);
						return at < 0 ? 0 : turns.slice(at).reduce((n, t) => n + t.estimatedTokens, 0);
					};

					const prepareSwap = async (opts: {
						keepFrom: string | null;
						proseDigest: string;
						fallback: boolean;
					}): Promise<PreparedMidRunSwap | undefined> => {
						const expectedEpoch = baton?.epoch ?? c.ledger.epoch;
						const nextEpoch = Math.max(c.ledger.epoch, expectedEpoch) + 1;
						const anchorTarget = activeModel ?? agent.model;
						const shouldAnchor =
							typeof options.anchorFirstUser === "function"
								? options.anchorFirstUser(anchorTarget)
								: (options.anchorFirstUser ?? true);
						const anchor = shouldAnchor
							? ((baton?.anchorUser0 as unknown as UserMessage | undefined) ??
								(view.messages.find((m) => m.role === "user") as UserMessage | undefined))
							: undefined;
						if (shouldAnchor && !anchor) return undefined;

						const keptTokens = keptTokensFrom(opts.keepFrom);
						const extraSections = await options.renderExtraSections?.({
							conversationId: runtime.conversationId,
							epoch: nextEpoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api: runtime,
							context: ctx,
						});
						let summary = renderBatonSummary({
							ledger: c.ledger,
							proseDigest: opts.proseDigest,
							epoch: nextEpoch,
							tokensBefore: tokens,
							keptTokens,
							fallback: opts.fallback,
							...(extraSections ? { extraSections } : {}),
						});
						const beforeRes = await options.onBeforeSwap?.({
							conversationId: runtime.conversationId,
							epoch: nextEpoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api: runtime,
							context: ctx,
							view,
							keepFrom: (opts.keepFrom as EntryId | null) ?? null,
							proseDigest: opts.proseDigest,
							summary,
							tokensBefore: tokens,
							keptTokens,
						});
						if (beforeRes?.cancel) {
							cancelStaged = true;
							return undefined;
						}
						if (beforeRes?.summary !== undefined) {
							summary = beforeRes.summary;
						} else if (beforeRes?.extraSections !== undefined) {
							summary = renderBatonSummary({
								ledger: c.ledger,
								proseDigest: opts.proseDigest,
								epoch: nextEpoch,
								tokensBefore: tokens,
								keptTokens,
								fallback: opts.fallback,
								extraSections: beforeRes.extraSections,
							});
						}

						const keepIdx =
							opts.keepFrom === null
								? view.entries.length
								: view.entries.findIndex((e) => String(e.id) === opts.keepFrom);
						const agedMessages = view.contributions.slice(0, keepIdx < 0 ? view.entries.length : keepIdx).flat();
						const newlyHarvested = harvestPostReadStudyNotes(agedMessages);
						const combinedNotes = [baton?.harvestedStudyNotes?.trim(), newlyHarvested?.trim()]
							.filter((s): s is string => Boolean(s && s.length > 0))
							.join("\n\n");

						const keepEntry =
							opts.keepFrom === null ? undefined : view.entries.find((e) => String(e.id) === opts.keepFrom);
						const handoff: UserMessage = { role: "user", content: summary, timestamp: runtime.now() };
						const resetModel: UserMessage[] = anchor ? [anchor, handoff] : [handoff];
						const probeEstimated = projectPostSwap(view, tokens, opts.keepFrom, summary, anchor);
						return {
							expectedEpoch,
							nextEpoch,
							keepEntryId: keepEntry ? keepEntry.id : "self",
							resetModel,
							summary,
							proseDigest: opts.proseDigest,
							...(anchor ? { anchor } : {}),
							data: {
								slidingWindow: true,
								epoch: nextEpoch,
								...(beforeRes?.data !== undefined ? { custom: beforeRes.data } : {}),
							},
							probeEstimated,
							fallback: opts.fallback,
							...(combinedNotes ? { harvestedStudyNotes: combinedNotes } : {}),
						};
					};

					const staged = baton?.staged;
					if (
						staged &&
						tokens >= softCeilingTokens &&
						(staged.firstKeptId === null || turns.some((t) => t.id === staged.firstKeptId))
					) {
						const keepFrom = chooseKeepFrom({
							stagedFirstKeptId: staged.firstKeptId,
							...(staged.preparedThroughId ? { preparedThroughId: staged.preparedThroughId } : {}),
							turns,
							midRun: true,
						});
						preparedSwap = await prepareSwap({
							keepFrom,
							proseDigest: staged.proseDigest,
							fallback: false,
						});
					} else if (tokens >= hardCeilingTokens) {
						const cut = selectCut(turns, config.keepTail, keepRecentTokens);
						const keepFrom = chooseKeepFrom({ stagedFirstKeptId: cut.firstKeptId, turns, midRun: true });
						const users = turns.filter((t) => t.role === "user").map((t) => t.text);
						preparedSwap = await prepareSwap({
							keepFrom,
							proseDigest: fallbackProse(c.ledger, users),
							fallback: true,
						});
					} else if (tokens >= softCeilingTokens && !baton?.preparingTaskId && !baton?.staged) {
						prepInput = buildPrepInput(c, turns, tokens, keepRecentTokens, activeModel);
					}
				}

				await runtime.commit(async (tx) => {
					if (preparedSwap) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (batonDoc.epoch === preparedSwap.expectedEpoch) {
							await tx.appendEntry(runtime.conversationId, {
								kind: ResetEntry.kind,
								head: preparedSwap.keepEntryId,
								model: preparedSwap.resetModel,
								data: preparedSwap.data,
							});
							c.ledger = {
								...c.ledger,
								epoch: preparedSwap.nextEpoch,
								lastProseDigest: preparedSwap.proseDigest,
							};
							c.ledgerDirty = true;
							c.probe = { epoch: preparedSwap.nextEpoch, estimated: preparedSwap.probeEstimated };
							c.awaitingFirstResponse = true;
							c.lastUsageTokens = undefined;
							c.note = preparedSwap.fallback
								? `burst fallback epoch ${preparedSwap.nextEpoch}`
								: `swapped epoch ${preparedSwap.nextEpoch}`;

							batonDoc.epoch = preparedSwap.nextEpoch;
							if (preparedSwap.anchor !== undefined) {
								batonDoc.anchorUser0 = toJson(preparedSwap.anchor) as JsonRepresentation<UserMessage>;
							} else {
								delete batonDoc.anchorUser0;
							}
							batonDoc.handoffSummary = preparedSwap.summary;
							batonDoc.swappedAtTokens = tokens;
							batonDoc.data = toJson(c.ledger);
							delete batonDoc.staged;
							delete batonDoc.preparingTaskId;
							if (preparedSwap.harvestedStudyNotes !== undefined) {
								batonDoc.harvestedStudyNotes = preparedSwap.harvestedStudyNotes;
							}
						}
					} else if (cancelStaged) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						delete batonDoc.staged;
						c.note = "swap cancelled";
					} else if (prepInput) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (!batonDoc.preparingTaskId && !batonDoc.staged && batonDoc.epoch === prepInput.epoch) {
							const prepId = await tx.createTask(BatonPrepTask, prepInput, {
								ownership: { kind: "conversation" },
								conversationId: runtime.conversationId,
								background: true,
							});
							batonDoc.preparingTaskId = prepId;
							c.note = "preparing";
						}
					}

					await state.commitPendingConvDocs(tx, runtime.conversationId, c);
					// Always return null (AfterToolsDecision) so GenerationTask does not report a missing decision.
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const WindowFinishTask = defineTask<{ readonly run?: RunSummary }, { phase: "commit" }, null>({
		name: "sliding-window.finish",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (_task, runtime, ctx) => {
				const c = state.conv(String(runtime.conversationId));
				await runtime.commit(async (tx) => {
					await state.commitPendingConvDocs(tx, runtime.conversationId, c);
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const hooks: Partial<GenerationHooks> = {
		beforeRequest: async ({ messages, streamOptions }, api, ctx) => {
			const c = state.conv(String(api.conversationId));
			await state.hydrate(c, api, ctx);
			const swState = await api.snapshot(SlidingWindowStateDoc, api.conversationId, ctx);
			const vmState = await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx);
			const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
			const guard = vmState?.forkGuard;
			const enabled = state.isEnabled(api.conversationId, c);
			const effectiveCwd = agentState?.cwd ?? options.cwd;

			// Scoped HydratePolicy (read via api.env or store.readLiveFile / store.getLatestBySourcePath, zero node:*).
			if (enabled && config.stageReadSlices && swState?.hydrate?.allowedPaths?.length) {
				const store = state.getStore();
				const hydratedSet = new Set(
					[...swState.hydrate.hydratedPaths, ...c.pendingHydratedPaths].map((p) =>
						normalizeSliceKey(p, effectiveCwd),
					),
				);
				const maxHydrateBytes = swState.hydrate.maxHydrateBytes ?? config.maxStageBytes;
				const effectiveHydrateBudget = Math.min(maxHydrateBytes, config.maxStageBytes);
				const pendingKeySet = new Set(c.pendingHydratedPaths.map((p) => normalizeSliceKey(p, effectiveCwd)));
				let usedHydrateBytes = 0;
				for (const s of c.stage.list()) {
					if (pendingKeySet.has(s.key)) usedHydrateBytes += s.bytes;
				}
				const env = await api.env?.(ctx).catch(() => undefined);

				for (const relPath of swState.hydrate.allowedPaths) {
					const normKey = normalizeSliceKey(relPath, effectiveCwd);
					if (hydratedSet.has(normKey)) continue;

					const ledgerRec = c.ledger.filesRead.find((r) => normalizeSliceKey(r.path, effectiveCwd) === normKey);
					const stored = await store.getLatestBySourcePath?.(relPath, effectiveCwd);
					const storedRef = ledgerRec?.ref ?? stored?.meta.ref;
					const storedSourceSha = ledgerRec?.sourceSha256 ?? ledgerRec?.sha256 ?? stored?.meta.sourceSha256;

					let live: { text: string; sha256: string } | undefined;
					if (env) {
						try {
							const readRes = await env.readTextFile(resolvePortablePath(relPath, effectiveCwd), ctx);
							if (readRes.ok) {
								live = { text: readRes.value, sha256: portableSha256Hex(readRes.value) };
							}
						} catch {
							live = undefined;
						}
					}
					if (!live && store.readLiveFile) {
						live = await store.readLiveFile(relPath, effectiveCwd);
					}

					let ref: string | undefined;
					let text: string | undefined;
					if (live) {
						if (storedRef && storedSourceSha && live.sha256 === storedSourceSha) {
							const candidateText =
								stored?.meta.ref === storedRef ? stored.text : await store.readFullText?.(storedRef);
							if (candidateText !== undefined && portableSha256Hex(candidateText) === live.sha256) {
								ref = storedRef;
								text = candidateText;
							} else {
								text = live.text;
								ref = portableSha256Hex(live.text).slice(0, 12);
							}
						} else {
							text = live.text;
							const storedMeta = storedRef
								? stored?.meta.ref === storedRef
									? stored.meta
									: await store.getMeta?.(storedRef)
								: undefined;
							ref =
								storedRef && storedMeta?.sha256 === live.sha256
									? storedRef
									: portableSha256Hex(live.text).slice(0, 12);
						}
					} else if (storedRef) {
						ref = storedRef;
						text = stored?.text ?? (await store.readFullText?.(storedRef));
					}

					if (text === undefined || ref === undefined) continue;
					const bytes = utf8ByteLength(text);
					if (usedHydrateBytes + bytes > effectiveHydrateBudget) continue;
					if (c.stage.stage({ path: relPath, ...(effectiveCwd ? { cwd: effectiveCwd } : {}), ref, text })) {
						usedHydrateBytes += bytes;
						c.pendingHydratedPaths.push(relPath);
						hydratedSet.add(normKey);
					}
				}
			}

			if (!enabled || !config.stageReadSlices) {
				c.pendingHydratedPaths = [];
			} else if (c.pendingHydratedPaths.length > 0) {
				const survivingKeys = new Set(c.stage.list().map((s) => s.key));
				c.pendingHydratedPaths = c.pendingHydratedPaths.filter((p) =>
					survivingKeys.has(normalizeSliceKey(p, effectiveCwd)),
				);
			}

			const tail = enabled && config.stageReadSlices ? c.stage.render() : undefined;
			const resolved = state.resolveTarget({
				conversationId: api.conversationId,
				targetRef: c.targetRef,
				models: api.models,
				...(agentState?.model ? { agent: { model: agentState.model } as Agent } : {}),
			});
			if (resolved?.kind === "physical") c.lastPhysicalModel = resolved.model;

			if (!tail && !guard && !resolved) return undefined;

			const disableContinuation =
				Boolean(tail) || guard?.disableContinuation === true ? true : guard?.disableContinuation;
			const nextStreamOptions: ConversationStreamOptions | undefined =
				disableContinuation !== undefined ? { ...streamOptions, disableContinuation } : streamOptions;
			const baseResult: {
				readonly messages: readonly Message[];
				readonly streamOptions?: ConversationStreamOptions;
			} = {
				messages,
				...(nextStreamOptions !== undefined ? { streamOptions: nextStreamOptions } : {}),
			};

			if (resolved?.kind === "virtual") {
				const cache = computeMessageCacheSnapshot(
					messages,
					(provider, modelId) => resolveRefToPhysical({ provider, modelId }, api.models),
					{ now: api.now() },
				);
				const innerState = c.pendingInnerState !== undefined ? c.pendingInnerState : vmState?.routeState;
				const scopeState = {
					...(tail ? { narrowTail: tail } : {}),
					...(guard ? { guard } : {}),
					innerDef: resolved.definition,
					innerModel: resolved.model,
					innerState,
				};
				return attachVirtualRequestScope(baseResult, {
					cache,
					deferOutcomeToHost: true,
					state: scopeState,
					...(disableContinuation !== undefined ? { disableContinuation } : {}),
					onStateChange: (nextState) => {
						c.pendingInnerState = nextState;
						c.pendingRouteStateToSave = toJson(nextState);
					},
					onRouteCommitted: (route) => {
						if (!isVirtualModel(route.model)) c.lastPhysicalModel = route.model;
					},
					onComplete: (completion) => {
						const meta = routedRequestMeta.get(scopeState);
						c.pendingCompletion = {
							innerDef: resolved.definition,
							innerModel: resolved.model,
							innerState: c.pendingInnerState !== undefined ? c.pendingInnerState : innerState,
							purpose: completion.purpose ?? meta?.purpose ?? "prompt",
							turnIndex: completion.turnIndex ?? meta?.turnIndex ?? c.ledger.turnCount,
							completion,
						};
					},
				});
			}

			return attachVirtualRequestScope(baseResult, {
				state: {
					...(tail ? { narrowTail: tail } : {}),
					...(guard ? { guard } : {}),
					...(resolved ? { target: resolved.model } : {}),
				},
				...(disableContinuation !== undefined ? { disableContinuation } : {}),
			});
		},
		afterResponse: async (message, api) => {
			const c = state.conv(String(api.conversationId));
			const hasToolCalls = message.stopReason === "toolUse" && message.content.some((b) => b.type === "toolCall");
			if (!hasToolCalls && c.pendingCompletion) {
				const pending = c.pendingCompletion;
				c.pendingCompletion = undefined;
				if (pending.innerDef.onOutcome) {
					const nextState = await pending.innerDef.onOutcome({
						virtualModel: pending.innerModel,
						route: pending.completion.route,
						purpose: pending.purpose,
						turnIndex: pending.turnIndex,
						message: pending.completion.message,
						toolResults: [],
						ttfbMs: pending.completion.ttfbMs,
						durationMs: pending.completion.durationMs,
						aborted: pending.completion.message.stopReason === "aborted",
						state: pending.innerState,
					});
					if (nextState !== undefined) {
						c.pendingInnerState = nextState;
						c.pendingRouteStateToSave = toJson(nextState);
					}
				}
			}

			if (message.provider === vProvider || message.stopReason === "error" || message.stopReason === "aborted") {
				return;
			}
			const physical = api.models.getModel(message.provider, message.model);
			if (physical && !isVirtualModel(physical)) c.lastPhysicalModel = physical;
			const tokens = promptTokensOf(message.usage);
			if (tokens <= 0) return;
			c.lastUsageTokens = tokens;
			c.stage.advanceTurn();
			c.ledger = { ...c.ledger, turnCount: c.ledger.turnCount + 1 };
			c.ledgerDirty = true;
			if (c.awaitingFirstResponse) {
				c.awaitingFirstResponse = false;
				if (c.probe && c.probe.actual === undefined) c.probe = { ...c.probe, actual: tokens };
			}
		},
		afterTools: async (assistant, results, api, ctx) => {
			const c = state.conv(String(api.conversationId));
			await state.hydrate(c, api, ctx);
			const enabled = state.isEnabled(api.conversationId, c);
			if (!enabled && !c.pendingCompletion && c.pendingHydratedPaths.length === 0 && !c.ledgerDirty) {
				return undefined;
			}
			return { tasks: [hookTask(WindowRoundTask, { assistant, results: [...results] })] };
		},
		afterRun: async (run, api, ctx) => {
			const c = state.conv(String(api.conversationId));
			if (
				!c.ledgerDirty &&
				c.pendingHydratedPaths.length === 0 &&
				c.pendingRouteStateToSave === undefined &&
				!state.isEnabled(api.conversationId, c)
			) {
				return undefined;
			}
			await state.hydrate(c, api, ctx);
			if (!c.ledgerDirty && c.pendingHydratedPaths.length === 0 && c.pendingRouteStateToSave === undefined) {
				return undefined;
			}
			return { tasks: [hookTask(WindowFinishTask, { run })] };
		},
		beforeAgentStart: async (
			event,
			api,
			ctx,
		): Promise<
			| {
					reset?: BeforeAgentStartReset;
					tasks: HookTask[];
					sidecarUsage?: BeforeAgentStartSidecarUsage[];
			  }
			| undefined
		> => {
			const c = state.conv(String(api.conversationId));
			await state.hydrate(c, api, ctx, event.view);
			if (!state.isEnabled(api.conversationId, c)) return undefined;
			if (c.awaitingFirstResponse) return undefined;

			const view = event.view;
			const tokens = c.lastUsageTokens ?? lastReportedTokens(view.messages);
			if (!tokens) return undefined;

			const activeModel = state.resolveTargetModel({
				conversationId: api.conversationId,
				targetRef: c.targetRef,
				agent: event.agent,
				models: api.models,
			});
			if (activeModel && !isVirtualModel(activeModel)) c.lastPhysicalModel = activeModel;
			const { softCeilingTokens, hardCeilingTokens, keepRecentTokens } = effectiveWindowBounds(
				config,
				activeModel?.contextWindow,
			);
			const turns = viewTurns(view, (m) => estimateMessageTokens(m));
			const baton = await api.snapshot(BatonStateDoc, api.conversationId, ctx);

			const keptTokensFrom = (keepFrom: string | null) => {
				if (keepFrom === null) return 0;
				const at = turns.findIndex((t) => t.id === keepFrom);
				return at < 0 ? 0 : turns.slice(at).reduce((n, t) => n + t.estimatedTokens, 0);
			};

			const swap = async (opts: { keepFrom: string | null; proseDigest: string; fallback: boolean }) => {
				const epoch = Math.max(c.ledger.epoch, baton?.epoch ?? 0) + 1;
				const anchorTarget = activeModel ?? event.agent.model;
				const shouldAnchor =
					typeof options.anchorFirstUser === "function"
						? options.anchorFirstUser(anchorTarget)
						: (options.anchorFirstUser ?? true);
				const anchor = shouldAnchor
					? ((baton?.anchorUser0 as unknown as UserMessage | undefined) ??
						(view.messages.find((m) => m.role === "user") as UserMessage | undefined))
					: undefined;
				if (shouldAnchor && !anchor) return undefined;

				const keptTokens = keptTokensFrom(opts.keepFrom);
				const extraSections = await options.renderExtraSections?.({
					conversationId: api.conversationId,
					epoch,
					ledger: c.ledger,
					fallback: opts.fallback,
					api,
					context: ctx,
				});
				let summary = renderBatonSummary({
					ledger: c.ledger,
					proseDigest: opts.proseDigest,
					epoch,
					tokensBefore: tokens,
					keptTokens,
					fallback: opts.fallback,
					...(extraSections ? { extraSections } : {}),
				});
				const beforeRes = await options.onBeforeSwap?.({
					conversationId: api.conversationId,
					epoch,
					ledger: c.ledger,
					fallback: opts.fallback,
					api,
					context: ctx,
					view,
					keepFrom: (opts.keepFrom as EntryId | null) ?? null,
					proseDigest: opts.proseDigest,
					summary,
					tokensBefore: tokens,
					keptTokens,
				});
				if (beforeRes?.cancel) {
					c.note = "swap cancelled";
					return { tasks: [hookTask(BatonClearTask, {})] };
				}
				if (beforeRes?.summary !== undefined) {
					summary = beforeRes.summary;
				} else if (beforeRes?.extraSections !== undefined) {
					summary = renderBatonSummary({
						ledger: c.ledger,
						proseDigest: opts.proseDigest,
						epoch,
						tokensBefore: tokens,
						keptTokens,
						fallback: opts.fallback,
						extraSections: beforeRes.extraSections,
					});
				}

				const keepIdx =
					opts.keepFrom === null
						? view.entries.length
						: view.entries.findIndex((e) => String(e.id) === opts.keepFrom);
				const agedMessages = view.contributions.slice(0, keepIdx < 0 ? view.entries.length : keepIdx).flat();
				const newlyHarvested = harvestPostReadStudyNotes(agedMessages);
				const combinedNotes = [baton?.harvestedStudyNotes?.trim(), newlyHarvested?.trim()]
					.filter((s): s is string => Boolean(s && s.length > 0))
					.join("\n\n");

				const keepEntry =
					opts.keepFrom === null ? undefined : view.entries.find((e) => String(e.id) === opts.keepFrom);
				const handoff: UserMessage = { role: "user", content: summary, timestamp: api.now() };
				const resetModel: UserMessage[] = anchor ? [anchor, handoff] : [handoff];

				c.ledger = { ...c.ledger, epoch, lastProseDigest: opts.proseDigest };
				c.ledgerDirty = false;
				c.probe = { epoch, estimated: projectPostSwap(view, tokens, opts.keepFrom, summary, anchor) };
				c.awaitingFirstResponse = true;
				c.lastUsageTokens = undefined;
				c.note = opts.fallback ? `burst fallback epoch ${epoch}` : `swapped epoch ${epoch}`;
				return {
					reset: {
						...(keepEntry ? { head: keepEntry.id } : {}),
						model: resetModel,
						data: {
							slidingWindow: true,
							epoch,
							...(beforeRes?.data !== undefined ? { custom: beforeRes.data } : {}),
						},
					},
					tasks: [
						hookTask(BatonWriteTask, {
							epoch,
							...(anchor ? { anchor: toJson(anchor) } : {}),
							summary,
							swappedAtTokens: tokens,
							ledger: toJson(c.ledger),
							...(combinedNotes ? { harvestedStudyNotes: combinedNotes } : {}),
						}),
					],
				};
			};

			const staged = baton?.staged;
			if (
				staged &&
				tokens >= softCeilingTokens &&
				(staged.firstKeptId === null || turns.some((t) => t.id === staged.firstKeptId))
			) {
				const keepFrom = chooseKeepFrom({
					stagedFirstKeptId: staged.firstKeptId,
					...(staged.preparedThroughId ? { preparedThroughId: staged.preparedThroughId } : {}),
					turns,
					midRun: false,
				});
				return swap({
					keepFrom,
					proseDigest: staged.proseDigest,
					fallback: false,
				});
			}

			if (tokens >= hardCeilingTokens) {
				const cut = selectCut(turns, config.keepTail, keepRecentTokens);
				const keepFrom = chooseKeepFrom({ stagedFirstKeptId: cut.firstKeptId, turns, midRun: false });
				const users = turns.filter((t) => t.role === "user").map((t) => t.text);
				return swap({ keepFrom, proseDigest: fallbackProse(c.ledger, users), fallback: true });
			}

			if (tokens >= softCeilingTokens && !baton?.preparingTaskId && !baton?.staged) {
				const prepInput = buildPrepInput(c, turns, tokens, keepRecentTokens, activeModel);
				if (prepInput) {
					return { tasks: [hookTask(BatonLaunchTask, prepInput)] };
				}
			}
			return undefined;
		},
	};

	return {
		tasks: [BatonWriteTask, BatonClearTask, BatonPrepTask, BatonLaunchTask, WindowRoundTask, WindowFinishTask],
		hooks,
	};
}
