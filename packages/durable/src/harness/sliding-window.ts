import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import type { Api, Message, Model, Models, Usage, UserMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRoute,
	type VirtualModelDefinition,
	type VirtualModels,
	withVirtualModelRouting,
} from "@earendil-works/pi-ai/virtual-models";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { defineDoc } from "../documents.ts";
import { defineTask } from "../tasks.ts";
import type { ConversationId, EntryId, NextTaskState } from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { defineExtension, defineTool, hook, hookTask } from "./define.ts";
import { GenerationTask } from "./generation.ts";
import { resolveBatonModel, runBatonSynthesis } from "./sliding-window/baton.ts";
import { effectiveWindowBounds, normalizeSlidingWindowConfig } from "./sliding-window/bounds.ts";
import { projectSwapTokens } from "./sliding-window/fit.ts";
import {
	buildProseTranscript,
	createEmptyLedger,
	fallbackProse,
	recordToolResult,
	renderBatonSummary,
} from "./sliding-window/ledger.ts";
import { MemorySlidingWindowArtifactStore } from "./sliding-window/memory-store.ts";
import { spillToolOutput } from "./sliding-window/spill.ts";
import { EphemeralSliceStage } from "./sliding-window/staging.ts";
import { blockText, chooseKeepFrom, estimateTextTokens, selectCut, viewTurns } from "./sliding-window/turns.ts";
import type {
	MechanicalLedger,
	RawTurn,
	SlidingWindowArtifactStore,
	SlidingWindowBounds,
	SlidingWindowConfig,
	SlidingWindowForkOptions,
	SlidingWindowHandle,
	SlidingWindowInspection,
	SlidingWindowOptions,
	SlidingWindowTargetContext,
	SwapProbe,
} from "./sliding-window/types.ts";
import { ToolTask } from "./tool.ts";
import type {
	Agent,
	BeforeAgentStartReset,
	BeforeAgentStartSidecarUsage,
	ContextView,
	Conversation,
	HookApi,
	HookTask,
	ModelRef,
	ToolRegistration,
} from "./types.ts";
import {
	applyForkGuardToRoute,
	attachVirtualRequestScope,
	BatonStateDoc,
	copyParentProviderSession,
	type ForkCacheGuard,
	VirtualModelStateDoc,
} from "./virtual-models.ts";

export { assistantText, resolveBatonModel, runBatonSynthesis } from "./sliding-window/baton.ts";
export {
	DEFAULT_SLIDING_WINDOW_CONFIG,
	effectiveWindowBounds,
	formatBytes,
	formatTokens,
	isReadToolName,
	isSearchToolName,
	normalizeSlidingWindowConfig,
	parseTokenCount,
	spillThresholdForTool,
} from "./sliding-window/bounds.ts";
export { calibrationRatio, projectSwapTokens, swapErrorPct } from "./sliding-window/fit.ts";
export {
	buildBatonPrompts,
	buildProseTranscript,
	createEmptyLedger,
	fallbackProse,
	recordToolResult,
	renderBatonSummary,
	renderLedgerBlock,
} from "./sliding-window/ledger.ts";
export { MemorySlidingWindowArtifactStore, normalizeRefId, portableSha256Hex } from "./sliding-window/memory-store.ts";
export { buildMechanicalPreview, extractSymbolOutline } from "./sliding-window/preview.ts";
export { SPILL_EXEMPT_TOOLS, spillToolOutput } from "./sliding-window/spill.ts";
export { EphemeralSliceStage, normalizeSliceKey } from "./sliding-window/staging.ts";
export {
	blockText,
	chooseKeepFrom,
	estimateTextTokens,
	selectCut,
	turnFromMessages,
	viewTurns,
} from "./sliding-window/turns.ts";
export * from "./sliding-window/types.ts";

export const DEFAULT_SLIDING_WINDOW_PROVIDER = "sliding-window";
export const DEFAULT_SLIDING_WINDOW_MODEL_ID = "active";

export type SlidingWindowStateValue = {
	enabled?: boolean;
};

/** Per-conversation sliding-window enable state; forkable via `fork: "initial"`. */
export const SlidingWindowStateDoc = defineDoc<SlidingWindowStateValue>({
	kind: "sliding-window.state",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

interface ConvState {
	hydrated: boolean;
	persistedEnabled?: boolean;
	ledger: MechanicalLedger;
	stage: EphemeralSliceStage;
	staged?: {
		firstKeptId: string | null;
		proseDigest: string;
		keptTokens: number;
		preparedThroughId?: string;
		provider: string;
		modelId: string;
		usage: Usage;
	};
	job?: AbortController;
	lastUsageTokens?: number;
	lastPhysicalModel?: Model<Api>;
	awaitingFirstResponse: boolean;
	probe?: SwapProbe;
	note: string;
}

const toJson = <T>(value: T): JsonValue => copyJson(value, { omitUndefinedProperties: true }) as JsonValue;

function promptTokensOf(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function lastReportedTokens(messages: readonly Message[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.usage) {
			const t = promptTokensOf(m.usage);
			if (t > 0) return t;
		}
	}
	return undefined;
}

const MAX_FORK_ENABLED_HINTS = 1024;
const forkEnabledHints = new Map<string, boolean>();

function recordForkEnabledHint(conversationId: ConversationId | string, enabled: boolean): void {
	const id = String(conversationId);
	if (forkEnabledHints.has(id)) {
		forkEnabledHints.delete(id);
	} else if (forkEnabledHints.size >= MAX_FORK_ENABLED_HINTS) {
		const oldest = forkEnabledHints.keys().next().value;
		if (oldest !== undefined) forkEnabledHints.delete(oldest);
	}
	forkEnabledHints.set(id, enabled);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isMechanicalLedger(value: unknown): value is MechanicalLedger {
	if (!isPlainObject(value)) return false;
	if (!Array.isArray(value.filesRead)) return false;
	if (!Array.isArray(value.filesEdited)) return false;
	if (!Array.isArray(value.recentRefs)) return false;
	if (!Array.isArray(value.recentErrors)) return false;
	if (typeof value.turnCount !== "number" || !Number.isFinite(value.turnCount)) return false;
	if (value.epoch !== undefined && (typeof value.epoch !== "number" || !Number.isFinite(value.epoch))) return false;
	if (value.lastProseDigest !== undefined && typeof value.lastProseDigest !== "string") return false;
	return true;
}

function isModelObject(value: unknown): value is Model<Api> {
	return typeof value === "object" && value !== null && "api" in value && "id" in value && "provider" in value;
}

function resolveRefToPhysical(ref: ModelRef | undefined, models: Models | undefined): Model<Api> | undefined {
	if (!ref || !models) return undefined;
	const physical = isVirtualModelsRuntime(models)
		? models.getPhysicalModel(ref.provider, ref.modelId)
		: models.getModel(ref.provider, ref.modelId);
	return physical && !isVirtualModel(physical) ? physical : undefined;
}

export function createSlidingWindow(options: SlidingWindowOptions = {}): SlidingWindowHandle {
	const vProvider = options.virtualModel?.provider?.trim() || DEFAULT_SLIDING_WINDOW_PROVIDER;
	const vId = options.virtualModel?.id?.trim() || DEFAULT_SLIDING_WINDOW_MODEL_ID;
	const vName = options.virtualModel?.name?.trim() || "Sliding Window";

	const config: SlidingWindowConfig = normalizeSlidingWindowConfig({
		...(options.softCeilingTokens !== undefined ? { softCeilingTokens: options.softCeilingTokens } : {}),
		...(options.hardCeilingTokens !== undefined ? { hardCeilingTokens: options.hardCeilingTokens } : {}),
		...(options.keepRecentTokens !== undefined ? { keepRecentTokens: options.keepRecentTokens } : {}),
		...(options.softCeilingRatio !== undefined ? { softCeilingRatio: options.softCeilingRatio } : {}),
		...(options.hardCeilingRatio !== undefined ? { hardCeilingRatio: options.hardCeilingRatio } : {}),
		...(options.keepRecentRatio !== undefined ? { keepRecentRatio: options.keepRecentRatio } : {}),
		...(options.keepTail !== undefined ? { keepTail: options.keepTail } : {}),
		...(options.batonModel !== undefined ? { batonModel: options.batonModel } : {}),
		...(options.batonThinkingLevel !== undefined ? { batonThinkingLevel: options.batonThinkingLevel } : {}),
		...(options.batonMaxTokens !== undefined ? { batonMaxTokens: options.batonMaxTokens } : {}),
		...(options.spillEnabled !== undefined ? { spillEnabled: options.spillEnabled } : {}),
		...(options.spillThresholdBytes !== undefined ? { spillThresholdBytes: options.spillThresholdBytes } : {}),
		...(options.readSpillThresholdBytes !== undefined
			? { readSpillThresholdBytes: options.readSpillThresholdBytes }
			: {}),
		...(options.searchSpillThresholdBytes !== undefined
			? { searchSpillThresholdBytes: options.searchSpillThresholdBytes }
			: {}),
		...(options.toolThresholds !== undefined ? { toolThresholds: options.toolThresholds } : {}),
		...(options.stageReadSlices !== undefined ? { stageReadSlices: options.stageReadSlices } : {}),
		...(options.maxStageBytes !== undefined ? { maxStageBytes: options.maxStageBytes } : {}),
		...(options.sliceTtlTurns !== undefined ? { sliceTtlTurns: options.sliceTtlTurns } : {}),
	});

	const states = new Map<string, ConvState>();
	const enabledOverrides = new Map<string, boolean>();
	let globalEnabledOverride: boolean | undefined;
	let boundModels: Models | undefined;
	let ownStore: SlidingWindowArtifactStore | undefined;

	const getStore = (): SlidingWindowArtifactStore => {
		if (options.artifactStore) return options.artifactStore;
		if (!ownStore) ownStore = new MemorySlidingWindowArtifactStore();
		return ownStore;
	};

	const conv = (id: string): ConvState => {
		let s = states.get(id);
		if (!s) {
			s = {
				hydrated: false,
				ledger: createEmptyLedger(),
				stage: new EphemeralSliceStage({ maxTotalBytes: config.maxStageBytes, ttlTurns: config.sliceTtlTurns }),
				awaitingFirstResponse: false,
				note: "idle",
			};
			states.set(id, s);
		}
		return s;
	};

	const resolveEnabledOption = (
		enabled: SlidingWindowOptions["enabled"],
		conversationId: ConversationId | string,
	): boolean => {
		if (typeof enabled === "function") return enabled(conversationId as ConversationId);
		return enabled ?? true;
	};

	const isEnabled = (conversationId: ConversationId | string, c?: ConvState): boolean => {
		const id = String(conversationId);
		const perConv = enabledOverrides.get(id);
		if (perConv !== undefined) return perConv;
		if (c?.persistedEnabled !== undefined) return c.persistedEnabled;
		const forkHint = forkEnabledHints.get(id);
		if (forkHint !== undefined) return forkHint;
		if (globalEnabledOverride !== undefined) return globalEnabledOverride;
		return resolveEnabledOption(options.enabled, conversationId);
	};

	const resolveTargetModel = (ctx: SlidingWindowTargetContext): Model<Api> | undefined => {
		const models = ctx.models ?? boundModels;
		const resolvedSpec = typeof options.target === "function" ? options.target(ctx) : options.target;
		if (resolvedSpec) {
			if (isModelObject(resolvedSpec)) {
				return !isVirtualModel(resolvedSpec) ? resolvedSpec : resolveRefToPhysical(ctx.agent?.model, models);
			}
			const fromRef = resolveRefToPhysical(resolvedSpec, models);
			if (fromRef) return fromRef;
		}
		const stateTarget = (ctx.routeRequest?.state as { target?: Model<Api> } | undefined)?.target;
		if (stateTarget && !isVirtualModel(stateTarget)) return stateTarget;
		const agentModel = resolveRefToPhysical(ctx.agent?.model, models);
		if (agentModel) return agentModel;
		if (ctx.conversationId !== undefined) {
			const c = states.get(String(ctx.conversationId));
			if (c?.lastPhysicalModel && !isVirtualModel(c.lastPhysicalModel)) return c.lastPhysicalModel;
		}
		return undefined;
	};

	const staticTarget =
		options.target && typeof options.target !== "function" && isModelObject(options.target)
			? options.target
			: undefined;

	const virtualModel: VirtualModelDefinition = {
		provider: vProvider,
		id: vId,
		name: staticTarget ? `${vName} • ${staticTarget.id}` : vName,
		thinkingLevels: staticTarget
			? [...getSupportedThinkingLevels(staticTarget)]
			: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: staticTarget ? staticTarget.contextWindow : 0,
		maxTokens: staticTarget ? staticTarget.maxTokens : 0,
		...(staticTarget ? { input: staticTarget.input } : {}),
		route(req) {
			const reqState = req.state as { narrowTail?: string; guard?: ForkCacheGuard; target?: Model<Api> } | undefined;
			const physical = resolveTargetModel({ models: boundModels, routeRequest: req });
			if (!physical) {
				throw new Error(
					`Sliding window virtual model ${vProvider}/${vId} requires a physical target model (pass options.target or configure AgentDoc.model)`,
				);
			}
			const tail = reqState?.narrowTail;
			const turn =
				req.purpose === "prompt" ||
				req.purpose === "continuation" ||
				req.purpose === "retry" ||
				req.purpose === "subagent";
			const baseRoute: ModelRoute = {
				model: physical,
				thinkingLevel: req.thinkingLevel,
				...(tail && turn ? { ephemeralTail: tail } : {}),
			};
			return reqState?.guard ? applyForkGuardToRoute(baseRoute, reqState.guard) : baseRoute;
		},
	};

	const BatonWriteTask = defineTask<
		{ epoch: number; anchor?: JsonValue; summary: string; swappedAtTokens: number; ledger: JsonValue },
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
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const recallTool = defineTool({
		name: "recall",
		description:
			"Read lines or search inside a spilled tool output by its ref (shown as ref:<hash>). Use startLine/endLine for a range, or query for matching lines with context.",
		parameters: obj({
			ref: str(),
			startLine: opt(int({ minimum: 1 })),
			endLine: opt(int({ minimum: 1 })),
			query: opt(str()),
			contextLines: opt(int({ minimum: 0, maximum: 30 })),
		}),
		replay: "safe",
		callers: ["model", "tools"],
		async execute(args) {
			const r = await getStore().recall({ ...args, ...(options.cwd ? { cwd: options.cwd } : {}) });
			return { output: [{ type: "text", text: r.text }] };
		},
	});

	const hydrate = async (c: ConvState, api: HookApi, ctx: Context) => {
		const id = String(api.conversationId);
		const swState = await api.snapshot(SlidingWindowStateDoc, api.conversationId, ctx);
		if (swState?.enabled !== undefined) c.persistedEnabled = swState.enabled;
		forkEnabledHints.delete(id);
		if (c.hydrated) return;
		c.hydrated = true;
		const baton = await api.snapshot(BatonStateDoc, api.conversationId, ctx);
		const batonData: unknown = baton?.data;
		c.ledger = isMechanicalLedger(batonData)
			? {
					epoch: batonData.epoch,
					turnCount: batonData.turnCount,
					filesRead: [...batonData.filesRead],
					filesEdited: [...batonData.filesEdited],
					recentRefs: [...batonData.recentRefs],
					recentErrors: [...batonData.recentErrors],
					...(batonData.lastProseDigest !== undefined ? { lastProseDigest: batonData.lastProseDigest } : {}),
				}
			: createEmptyLedger();
		if (baton) c.ledger = { ...c.ledger, epoch: baton.epoch };
	};

	const startBaton = (
		c: ConvState,
		api: HookApi,
		turns: RawTurn[],
		tokens: number,
		keepRecentTokens: number,
		activeModel: Model<Api> | undefined,
	) => {
		if (c.job || c.staged) return;
		const cut = selectCut(turns, config.keepTail, keepRecentTokens);
		if (cut.aged.length === 0) return;
		const abort = new AbortController();
		c.job = abort;
		c.note = "preparing";
		const models = api.models;
		const preparedThroughId = turns.at(-1)?.id;
		const prose = buildProseTranscript(cut.aged);
		void (async () => {
			let available: readonly Model<Api>[] = [];
			try {
				available = await models.getAvailable();
			} catch {
				// resolveBatonModel falls back to activeModel
			}
			const resolution = resolveBatonModel(config.batonModel, config.batonThinkingLevel, activeModel, {
				find: (p, id) => models.getModel(p, id),
				getAvailable: () => available,
			});
			if (!resolution) throw new Error("no helper model available");
			c.note = `preparing via ${resolution.model.id}`;
			const res = await runBatonSynthesis({
				model: resolution.model,
				thinkingLevel: resolution.thinkingLevel,
				maxTokens: config.batonMaxTokens,
				previousDigest: c.ledger.lastProseDigest,
				prose,
				signal: abort.signal,
				complete: (model, context, opts) => {
					const now = api.now();
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
			if (abort.signal.aborted) return;
			c.staged = {
				firstKeptId: cut.firstKeptId,
				proseDigest: res.proseDigest,
				keptTokens: cut.keptTokens,
				...(preparedThroughId ? { preparedThroughId } : {}),
				provider: res.model.provider,
				modelId: res.model.id,
				usage: res.usage,
			};
			c.note = `ready (${res.durationMs}ms, ${res.model.id}, prepared at ${tokens})`;
		})()
			.catch((err) => {
				if (!abort.signal.aborted) c.note = `helper failed: ${err instanceof Error ? err.message : String(err)}`;
			})
			.finally(() => {
				if (c.job === abort) c.job = undefined;
			});
	};

	const projectPostSwap = (
		view: ContextView,
		tokens: number,
		keepFrom: string | null,
		summary: string,
		anchor: Message | undefined,
	): number => {
		const lastUserIdx = view.entries.findLastIndex(
			(_e, i) =>
				!(view.head !== undefined && i === 0) && (view.contributions[i] ?? []).some((m) => m.role === "user"),
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
	};

	const extension = defineExtension({
		name: options.extensionName ?? "pi.sliding-window",
		tools: [recallTool as ToolRegistration],
		tasks: [BatonWriteTask],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, ctx) => {
					const guard = (await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx))?.forkGuard;
					if (guard?.allowedTools && !guard.allowedTools.includes(call.name)) {
						return { block: guard.blockedToolReason ?? `Tool ${call.name} is blocked on this fork` };
					}
					return undefined;
				},
				afterTool: async (call, result, api, ctx) => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					if (!isEnabled(api.conversationId, c)) return undefined;
					if (call.name === "recall" || call.parent !== undefined) return undefined;

					const args = (call.arguments ?? {}) as Record<string, unknown>;
					const raw = blockText(result.output);
					const path =
						typeof args.path === "string"
							? args.path
							: typeof args.file_path === "string"
								? args.file_path
								: undefined;
					const isError = result.isError === true;
					if ((call.name === "edit" || call.name === "write") && !isError && path) {
						c.stage.evict(path, options.cwd);
					}

					const spill = await spillToolOutput({
						toolName: call.name,
						input: args,
						rawText: raw,
						isError,
						...(options.cwd ? { cwd: options.cwd } : {}),
						config,
						store: getStore,
						stage: c.stage,
						...(options.previewToolOutput ? { previewToolOutput: options.previewToolOutput } : {}),
					});
					c.ledger = recordToolResult(c.ledger, call.name, args, {
						isError,
						...(spill ? { spilled: spill.meta } : {}),
						...(isError ? { errorText: raw } : {}),
					});
					if (!spill) return undefined;
					const prior =
						result.details && typeof result.details === "object" && !Array.isArray(result.details)
							? result.details
							: {};
					return {
						...result,
						output: [{ type: "text", text: spill.previewText }],
						details: {
							...prior,
							slidingWindow: { ref: spill.meta.ref, bytes: spill.meta.byteLen, lines: spill.meta.lineCount },
						},
					};
				},
			}),
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, ctx) => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					const vmState = await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx);
					const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
					const guard = vmState?.forkGuard;
					const enabled = isEnabled(api.conversationId, c);
					const tail = enabled && config.stageReadSlices ? c.stage.render() : undefined;
					const target = resolveTargetModel({
						conversationId: api.conversationId,
						models: api.models,
						...(agentState?.model ? { agent: { model: agentState.model } as Agent } : {}),
					});
					if (target && !isVirtualModel(target)) c.lastPhysicalModel = target;
					if (!tail && !guard && !target) return undefined;
					return attachVirtualRequestScope(
						{ messages },
						{
							state: {
								...(tail ? { narrowTail: tail } : {}),
								...(guard ? { guard } : {}),
								...(target ? { target } : {}),
							},
							...(guard?.disableContinuation !== undefined
								? { disableContinuation: guard.disableContinuation }
								: {}),
						},
					);
				},
				afterResponse: async (message, api) => {
					if (
						message.provider === vProvider ||
						message.stopReason === "error" ||
						message.stopReason === "aborted"
					) {
						return;
					}
					const c = conv(String(api.conversationId));
					const physical = api.models.getModel(message.provider, message.model);
					if (physical && !isVirtualModel(physical)) c.lastPhysicalModel = physical;
					const tokens = promptTokensOf(message.usage);
					if (tokens <= 0) return;
					c.lastUsageTokens = tokens;
					c.stage.advanceTurn();
					c.ledger = { ...c.ledger, turnCount: c.ledger.turnCount + 1 };
					if (c.awaitingFirstResponse) {
						c.awaitingFirstResponse = false;
						if (c.probe && c.probe.actual === undefined) c.probe = { ...c.probe, actual: tokens };
					}
				},
				beforeAgentStart: async (
					event,
					api,
					ctx,
				): Promise<
					| {
							reset: BeforeAgentStartReset;
							tasks: HookTask[];
							sidecarUsage?: BeforeAgentStartSidecarUsage[];
					  }
					| undefined
				> => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					if (!isEnabled(api.conversationId, c)) return undefined;
					if (c.awaitingFirstResponse) return undefined;

					const view = event.view;
					const tokens = c.lastUsageTokens ?? lastReportedTokens(view.messages);
					if (!tokens) return undefined;

					const activeModel = resolveTargetModel({
						conversationId: api.conversationId,
						agent: event.agent,
						models: api.models,
					});
					if (activeModel) c.lastPhysicalModel = activeModel;
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

					const swap = async (opts: {
						keepFrom: string | null;
						proseDigest: string;
						fallback: boolean;
						sidecar?: Usage;
						provider?: string;
						modelId?: string;
					}) => {
						const epoch = c.ledger.epoch + 1;
						const baton = await api.snapshot(BatonStateDoc, api.conversationId, ctx);
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
							c.job?.abort();
							c.job = undefined;
							c.staged = undefined;
							c.note = "swap cancelled";
							return undefined;
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

						const keepEntry =
							opts.keepFrom === null ? undefined : view.entries.find((e) => String(e.id) === opts.keepFrom);
						const handoff: UserMessage = { role: "user", content: summary, timestamp: api.now() };
						const resetModel: UserMessage[] = anchor ? [anchor, handoff] : [handoff];

						c.job?.abort();
						c.job = undefined;
						c.ledger = { ...c.ledger, epoch, lastProseDigest: opts.proseDigest };
						c.probe = { epoch, estimated: projectPostSwap(view, tokens, opts.keepFrom, summary, anchor) };
						c.awaitingFirstResponse = true;
						c.lastUsageTokens = undefined;
						c.staged = undefined;
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
								}),
							],
							...(opts.sidecar && opts.provider && opts.modelId
								? {
										sidecarUsage: [
											{ kind: "baton", provider: opts.provider, modelId: opts.modelId, usage: opts.sidecar },
										],
									}
								: {}),
						};
					};

					const staged = c.staged;
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
							sidecar: staged.usage,
							provider: staged.provider,
							modelId: staged.modelId,
						});
					}

					if (tokens >= hardCeilingTokens) {
						const cut = selectCut(turns, config.keepTail, keepRecentTokens);
						const keepFrom = chooseKeepFrom({ stagedFirstKeptId: cut.firstKeptId, turns, midRun: false });
						const users = turns.filter((t) => t.role === "user").map((t) => t.text);
						return swap({ keepFrom, proseDigest: fallbackProse(c.ledger, users), fallback: true });
					}

					if (tokens >= softCeilingTokens) {
						startBaton(c, api, turns, tokens, keepRecentTokens, activeModel);
					}
					return undefined;
				},
			}),
		],
	});

	return {
		extension,
		recallTool: recallTool as ToolRegistration,
		virtualModel,
		selection: { provider: vProvider, modelId: vId },
		wrapModels<TModels extends Models>(models: TModels): VirtualModels {
			if (isVirtualModelsRuntime(models)) {
				models.registerVirtualModel(virtualModel);
				boundModels = models;
				return models;
			}
			const wrapped = withVirtualModelRouting(models, { models: [virtualModel] });
			boundModels = wrapped;
			return wrapped;
		},
		inspect(conversationId: ConversationId | string): SlidingWindowInspection {
			const c = conv(String(conversationId));
			const liveTarget = resolveTargetModel({
				conversationId: conversationId as ConversationId,
				...(boundModels ? { models: boundModels } : {}),
			});
			const contextWindow =
				liveTarget?.contextWindow ?? c.lastPhysicalModel?.contextWindow ?? staticTarget?.contextWindow;
			const bounds: SlidingWindowBounds = effectiveWindowBounds(config, contextWindow);
			return {
				enabled: isEnabled(conversationId, c),
				epoch: c.ledger.epoch,
				note: c.note,
				lastUsageTokens: c.lastUsageTokens,
				probe: c.probe,
				ledger: c.ledger,
				stagedSlices: c.stage.list().length,
				bounds,
			};
		},
		setEnabled(enabled: boolean, conversationId?: ConversationId | string): void {
			if (conversationId !== undefined) {
				const id = String(conversationId);
				enabledOverrides.set(id, enabled);
				forkEnabledHints.delete(id);
				const existing = states.get(id);
				if (existing) existing.persistedEnabled = enabled;
			} else {
				enabledOverrides.clear();
				globalEnabledOverride = enabled;
			}
		},
		async close(): Promise<void> {
			for (const c of states.values()) c.job?.abort();
			if (ownStore) {
				await ownStore.close?.();
				ownStore = undefined;
			} else if (options.artifactStore?.close) {
				await options.artifactStore.close();
			}
		},
	};
}

/**
 * Create a cache-guarded fork with sliding-window & baton state controls.
 * Preserves provider session shard affinity (`copyProviderSession`), thinking epoch (`preserveThinkingLevel`),
 * frozen tool declarations + execution-time `allowedTools`, `disableContinuation`, and optional baton/window overrides.
 */
export async function createSlidingWindowFork(
	parent: Conversation,
	at: EntryId,
	options: SlidingWindowForkOptions,
	context: Context,
): Promise<Conversation> {
	const {
		copyProviderSession = true,
		preserveThinkingLevel = true,
		inheritBatonState = true,
		slidingWindow,
		parentThinkingLevel,
		preservedThinkingLevel,
		allowThinkingEpochFlip,
		allowedTools,
		blockedToolReason,
		disableContinuation = true,
		preserveToolDeclarations = true,
		init,
		...createOptions
	} = options;

	const fork = await parent.fork(
		at,
		{
			...createOptions,
			init: async (tx, forkId) => {
				const sessionId = copyProviderSession ? await copyParentProviderSession(tx, parent.id, forkId) : undefined;
				const parentAgent = await tx.doc(AgentDoc, parent.id);
				const forkAgent = await tx.doc(AgentDoc, forkId);
				const epochLevel = parentThinkingLevel ?? parentAgent.thinkingLevel;
				const effectiveAllowFlip = allowThinkingEpochFlip === true || preserveThinkingLevel === false;
				const guardedLevel =
					!effectiveAllowFlip && epochLevel !== undefined && epochLevel !== "off"
						? (preservedThinkingLevel ?? epochLevel)
						: undefined;
				if (guardedLevel !== undefined && forkAgent.thinkingLevel === "off") {
					forkAgent.thinkingLevel = guardedLevel;
				}
				const vmState = await tx.doc(VirtualModelStateDoc, forkId);
				vmState.forkGuard = {
					disableContinuation,
					preserveToolDeclarations,
					...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
					...(blockedToolReason !== undefined ? { blockedToolReason } : {}),
					...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
					...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
				};
				if (inheritBatonState === false) {
					const baton = await tx.doc(BatonStateDoc, forkId);
					baton.epoch = 0;
					delete baton.anchorUser0;
					delete baton.handoffSummary;
					delete baton.swappedAtTokens;
					delete baton.data;
				}
				if (slidingWindow !== undefined) {
					(await tx.doc(SlidingWindowStateDoc, forkId)).enabled = slidingWindow;
				}
				await init?.(tx, forkId);
			},
		},
		context,
	);
	if (slidingWindow !== undefined) {
		recordForkEnabledHint(fork.id, slidingWindow);
	}
	return fork;
}
