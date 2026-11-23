import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type ToolResultMessage,
	type TranscriptContext,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { withVirtualModelRouting } from "@earendil-works/pi-ai/virtual-models";
import {
	AgentDoc,
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	hookTask,
	LiveDoc,
	MemoryStorage,
	type NextTaskState,
	ResetEntry,
	ToolResultEntry,
	ToolTask,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyForkGuardToRoute,
	attachVirtualRequestScope,
	BatonStateDoc,
	computeContextCacheSnapshot,
	computeMessageCacheSnapshot,
	createCacheGuardedFork,
	type PreparedVirtualRoute,
	type RoutedStreamCompletion,
	VirtualModelStateDoc,
} from "@earendil-works/pi-durable/virtual-models";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { allEntries, textOf } from "./chat-support.ts";
import { addSection } from "./harness-support.ts";
import { context } from "./session-support.ts";

function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: input * 1e-6,
			output: output * 2e-6,
			cacheRead: cacheRead * 1e-7,
			cacheWrite: cacheWrite * 1.2e-6,
			total: input * 1e-6 + output * 2e-6,
		},
	};
}

function makeTestTools() {
	const files = new Map<string, string>([
		[
			"src/pricing.ts",
			[
				"export function computeSubtotal(items: number[]): number {",
				"  return items.reduce((a, b) => a + b, 0);",
				"}",
				"// padding ".repeat(12),
			].join("\n"),
		],
	]);
	const executedCalls: Array<{ name: string; args: unknown }> = [];

	const read = defineTool({
		name: "read",
		description: "Read a file",
		parameters: obj({ path: str() }),
		execute: async (args) => {
			executedCalls.push({ name: "read", args });
			return { output: [{ type: "text", text: files.get(args.path) ?? "missing" }] };
		},
	});
	const edit = defineTool({
		name: "edit",
		description: "Edit a file",
		parameters: obj({ path: str(), content: opt(str()) }),
		execute: async (args) => {
			executedCalls.push({ name: "edit", args });
			if (args.content !== undefined) files.set(args.path, args.content);
			return { output: [{ type: "text", text: `Edited ${args.path}` }] };
		},
	});
	const webSearch = defineTool({
		name: "web_search",
		description: "Search the web",
		parameters: obj({ query: str() }),
		execute: async (args) => {
			executedCalls.push({ name: "web_search", args });
			return { output: [{ type: "text", text: `Results for ${args.query}` }] };
		},
	});

	return { files, executedCalls, tools: [read, edit, webSearch] };
}

describe("durable virtual-models substrate seams", () => {
	it("keeps GenerationTask.version at 3 and wires routing, sidecar spend + latest context usage, thinkingLevel, and cache snapshots", async () => {
		expect(GenerationTask.definition.version).toBe(3);

		const fast = fauxProvider({
			provider: "fast-prov",
			models: [{ id: "fast-1", contextWindow: 16_000, maxTokens: 1000 }],
		});
		const deep = fauxProvider({
			provider: "deep-prov",
			models: [{ id: "deep-1", contextWindow: 128_000, maxTokens: 8000, reasoning: true }],
		});
		const models = createModels();
		models.setProvider(fast.provider);
		models.setProvider(deep.provider);

		const StateSyncTask = defineTask<{ routeState: Record<string, number> }, { phase: "commit" }, null>({
			name: "test.state-sync",
			version: 1,
			initial: () => ({ phase: "commit" }),
			phases: {
				commit: async (task, runtime, ctx) => {
					await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, null>> => {
						(await tx.doc(VirtualModelStateDoc, runtime.conversationId)).routeState = task.input.routeState;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, ctx);
				},
			},
			abort: async (_t, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});

		const recordedOutcomes: Array<{ physicalModel: string; toolResultsCount: number; turnIndex: number }> = [];
		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "auto",
					name: "Auto Router",
					thinkingLevels: ["off", "low", "high"],
					route(req) {
						const prev = (req.state as { turns?: number } | undefined)?.turns ?? 0;
						return {
							model: models.getModel("fast-prov", "fast-1")!,
							thinkingLevel: "off",
							state: { turns: prev + 1 },
							validate: () => ({
								action: "escalate",
								model: models.getModel("deep-prov", "deep-1")!,
								thinkingLevel: "high",
							}),
						};
					},
					onOutcome(outcome) {
						recordedOutcomes.push({
							physicalModel: `${outcome.route.model.provider}/${outcome.route.model.id}`,
							toolResultsCount: outcome.toolResults.length,
							turnIndex: outcome.turnIndex,
						});
						return {
							turns: (outcome.state as { turns?: number } | undefined)?.turns ?? 1,
							lastTools: outcome.toolResults.length,
						};
					},
				},
			],
		});

		let pendingCompletion:
			| { prepared: PreparedVirtualRoute; completion: RoutedStreamCompletion; state: unknown }
			| undefined;
		let pendingState: Record<string, number> | undefined;

		const hostExt = defineExtension({
			name: "hot-pluggable-router-host",
			tasks: [StateSyncTask],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async ({ messages }, api, ctx) => {
						const stateDoc = await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx);
						const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
						const agent = await api.snapshot(AgentDoc, api.conversationId, ctx);
						const state = pendingState ?? (stateDoc?.routeState as Record<string, number> | undefined);
						const cache = computeMessageCacheSnapshot(messages, (p, m) => routedModels.getPhysicalModel(p, m), {
							now: api.now(),
						});
						const vModel = routedModels.getModel("router", "auto")!;
						const turnIndex = live?.run?.turns ?? 0;
						const prepared = await routedModels.prepareVirtualRoute(vModel, messages, {
							purpose: turnIndex > 0 ? "continuation" : "prompt",
							turnIndex,
							thinkingLevel: agent?.thinkingLevel ?? "off",
							state,
							cache,
						});
						if (prepared.route.state !== undefined) pendingState = prepared.route.state as Record<string, number>;
						return attachVirtualRequestScope(
							{ messages },
							{
								prepared,
								state,
								cache,
								deferOutcomeToHost: true,
								onComplete: async (completion) => {
									pendingCompletion = { prepared, completion, state: pendingState };
								},
							},
						);
					},
					afterResponse: async (msg) => {
						if (msg.stopReason !== "toolUse" && pendingCompletion) {
							const next = await pendingCompletion.prepared.definition.onOutcome?.({
								virtualModel: pendingCompletion.prepared.request.model,
								route: pendingCompletion.completion.route,
								purpose: pendingCompletion.prepared.request.purpose,
								turnIndex: pendingCompletion.prepared.request.turnIndex,
								message: pendingCompletion.completion.message,
								toolResults: [],
								ttfbMs: pendingCompletion.completion.ttfbMs,
								durationMs: pendingCompletion.completion.durationMs,
								aborted: false,
								state: pendingCompletion.state,
							});
							if (next) pendingState = next as Record<string, number>;
							pendingCompletion = undefined;
						}
					},
					afterTools: async (_aid, rids, api, ctx) => {
						if (!pendingCompletion) return undefined;
						const toolResults: ToolResultMessage[] = [];
						for (const id of rids) {
							const entry = await api.entry(ToolResultEntry, id, ctx);
							for (const m of entry?.model ?? []) if (m.role === "toolResult") toolResults.push(m);
						}
						const next = await pendingCompletion.prepared.definition.onOutcome?.({
							virtualModel: pendingCompletion.prepared.request.model,
							route: pendingCompletion.completion.route,
							purpose: pendingCompletion.prepared.request.purpose,
							turnIndex: pendingCompletion.prepared.request.turnIndex,
							message: pendingCompletion.completion.message,
							toolResults,
							ttfbMs: pendingCompletion.completion.ttfbMs,
							durationMs: pendingCompletion.completion.durationMs,
							aborted: false,
							state: pendingCompletion.state,
						});
						if (next) pendingState = next as Record<string, number>;
						pendingCompletion = undefined;
						return pendingState ? { tasks: [hookTask(StateSyncTask, { routeState: pendingState })] } : undefined;
					},
					afterRun: async () =>
						pendingState ? { tasks: [hookTask(StateSyncTask, { routeState: pendingState })] } : undefined,
				}),
			],
		});

		const { tools } = makeTestTools();
		const registry = createRegistry();
		registry.install(hostExt);
		registry.install(defineExtension({ name: "app-tools", tools }));

		const nowMs = 1_000_000;
		fast.setResponses([
			{ ...fauxAssistantMessage("draft one", { timestamp: nowMs }), usage: makeUsage(110, 10) },
			{ ...fauxAssistantMessage("draft two", { timestamp: nowMs }), usage: makeUsage(240, 12) },
		]);
		deep.setResponses([
			{
				...fauxAssistantMessage([fauxToolCall("read", { path: "src/pricing.ts" })], {
					stopReason: "toolUse",
					timestamp: nowMs,
				}),
				usage: makeUsage(80, 15, 20),
			},
			{
				...fauxAssistantMessage("Analyzed pricing cleanly.", { timestamp: nowMs }),
				usage: makeUsage(90, 20, 60),
			},
		]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: routedModels, registry, now: () => nowMs },
			context,
		);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "auto" }, thinkingLevel: "low" },
		});

		await (await root.submit({ type: "input", content: "Inspect pricing.ts" }, context)).wait(context);
		await root.waitForIdle(context);

		const assistantEntries = (await allEntries(root)).filter((e) => AssistantEntry.is(e));
		expect(assistantEntries).toHaveLength(2);
		expect(assistantEntries[0]!.model?.[0]).toMatchObject({
			role: "assistant",
			provider: "deep-prov",
			model: "deep-1",
			thinkingLevel: "high",
		});

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		// Cumulative sidecar spend sums both drafts (input 110 + 240 = 350), while sidecarContext holds only the latest draft's context fill (< cumulative)!
		const cumulativeSidecar = usage?.sidecars?.["draft:fast-prov/fast-1"]?.totalTokens ?? 0;
		const latestContext = usage?.sidecarContext?.["draft:fast-prov/fast-1"]?.contextTokens ?? 0;
		expect(cumulativeSidecar).toBeGreaterThan(0);
		expect(latestContext).toBeGreaterThan(0);
		expect(latestContext).toBeLessThan(cumulativeSidecar);

		expect(recordedOutcomes).toEqual([
			{ physicalModel: "deep-prov/deep-1", toolResultsCount: 1, turnIndex: 0 },
			{ physicalModel: "deep-prov/deep-1", toolResultsCount: 0, turnIndex: 1 },
		]);
		expect((await harness.snapshot(VirtualModelStateDoc, root.id, context))?.routeState).toEqual({
			turns: 2,
			lastTools: 0,
		});

		const view = await root.context(context);
		const snap = computeContextCacheSnapshot(view, (p, m) => routedModels.getPhysicalModel(p, m), {
			now: nowMs + 10_000,
		});
		expect(snap.cacheFreeBoundary).toBe(false);
		const lastMsg = assistantEntries.at(-1)!.model![0]!;
		const expectedWarm =
			lastMsg.role === "assistant" ? lastMsg.usage.cacheRead + lastMsg.usage.cacheWrite || lastMsg.usage.input : 0;
		expect(snap.get("deep-prov", "deep-1")?.warmTokens).toBe(expectedWarm);

		await harness.close(context);
	});

	it("lets a hot-pluggable extension rewrite tool_result receipts and inject/evict ephemeralTail via route(req.state)", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const seenWireContexts: TranscriptContext[] = [];
		const activeSlices = new Map<string, string>();

		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "smart",
					name: "Smart",
					route: (req) => {
						const slices = (req.state as { slices?: string[] } | undefined)?.slices ?? [];
						return {
							model: models.getModel("anthropic", "claude-sonnet")!,
							thinkingLevel: "off",
							...(slices.length > 0 ? { ephemeralTail: slices.join("\n\n") } : {}),
						};
					},
				},
			],
		});

		const receiptExt = defineExtension({
			name: "ext-receipts",
			hooks: [
				hook(ToolTask, {
					afterTool: async (call, result) => {
						const path = (call.arguments as { path?: string } | undefined)?.path;
						if (!path || result.isError) return undefined;
						if (call.name === "edit") {
							activeSlices.delete(path);
							return undefined;
						}
						if (call.name === "read") {
							const full = result.output?.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? "";
							activeSlices.set(path, `<slice path="${path}">\n${full}\n</slice>`);
							return { ...result, output: [{ type: "text", text: `[receipt path=${path} ref:abc123]` }] };
						}
						return undefined;
					},
				}),
				hook(GenerationTask, {
					beforeRequest: async ({ messages }) =>
						attachVirtualRequestScope({ messages }, { state: { slices: [...activeSlices.values()] } }),
					beforeProviderRequest: ({ model, payload }) =>
						activeSlices.size > 0 && model.api === "anthropic-messages"
							? {
									payload: anchorAnthropicCacheBeforeEphemeralTail(
										payload,
										[...activeSlices.values()].join("\n\n"),
									),
								}
							: undefined,
				}),
			],
		});

		const { tools } = makeTestTools();
		const registry = createRegistry();
		registry.install(receiptExt);
		registry.install(defineExtension({ name: "app-tools", tools }));

		prov.setResponses([
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/pricing.ts" })], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("edit", { path: "src/pricing.ts", content: "updated" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Done.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routedModels, registry }, context);
		harness.resume();
		const root = await harness.root(context, { agent: { model: { provider: "router", modelId: "smart" } } });

		await (await root.submit({ type: "input", content: "Read and edit pricing" }, context)).wait(context);
		await root.waitForIdle(context);

		const toolEntries = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		expect(textOf(toolEntries[0]?.model?.[0])).toBe("[receipt path=src/pricing.ts ref:abc123]");
		expect(textOf(seenWireContexts[1]?.messages.at(-1))).toContain("export function computeSubtotal");
		expect(textOf(seenWireContexts[2]?.messages.at(-1))).not.toContain("<slice");

		await harness.close(context);
	});

	it("runs beforeAgentStart baton swap with HookTask, preserving firstUser (cch) and recording helper context usage", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const BatonWriteTask = defineTask<
			{ epoch: number; anchor: JsonValue; summary: string },
			{ phase: "commit" },
			null
		>({
			name: "test.baton-write",
			version: 1,
			initial: () => ({ phase: "commit" }),
			phases: {
				commit: async (task, runtime, ctx) => {
					await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, null>> => {
						const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
						doc.epoch = task.input.epoch;
						doc.anchorUser0 = task.input.anchor as JsonRepresentation<UserMessage>;
						doc.handoffSummary = task.input.summary;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, ctx);
				},
			},
			abort: async (_t, runtime, ctx) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
			},
		});

		const seenRequests: TranscriptContext[] = [];
		let runs = 0;
		const batonExt = defineExtension({
			name: "ext-baton",
			tasks: [BatonWriteTask],
			hooks: [
				hook(GenerationTask, {
					beforeAgentStart: async (event, api, ctx) => {
						runs += 1;
						if (runs < 2) return undefined;
						const batonDoc = await api.snapshot(BatonStateDoc, api.conversationId, ctx);
						const anchor =
							(batonDoc?.anchorUser0 as UserMessage | undefined) ??
							event.view.messages.find((m): m is UserMessage => m.role === "user")!;
						const summary = "Concise baton summary of prior work.";
						const handoff: UserMessage = { role: "user", content: summary, timestamp: api.now() };
						return {
							reset: { model: [anchor, handoff] },
							tasks: [
								hookTask(BatonWriteTask, {
									epoch: 1,
									anchor: copyJson(anchor, { omitUndefinedProperties: true }),
									summary,
								}),
							],
							sidecarUsage: [
								{
									kind: "helper_b",
									provider: "anthropic",
									modelId: "claude-haiku",
									usage: makeUsage(185_000, 1_200, 40_000),
								},
							],
						};
					},
				}),
			],
		});

		const registry = createRegistry();
		registry.install(batonExt);
		prov.setResponses([
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("First turn reply.");
			},
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("Post-swap reply.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "anthropic", modelId: "claude-sonnet" } },
		});

		await (await root.submit({ type: "input", content: "ANCHOR USER PROMPT FOR CCH" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Follow-up after swap" }, context)).wait(context);
		await root.waitForIdle(context);

		const users = seenRequests[1]!.messages.filter((m) => m.role === "user");
		expect(textOf(users[0])).toBe("ANCHOR USER PROMPT FOR CCH");
		expect(textOf(users[1])).toBe("Concise baton summary of prior work.");
		expect(textOf(users[2])).toBe("Follow-up after swap");
		expect((await allEntries(root)).some((e) => ResetEntry.is(e))).toBe(true);
		expect((await harness.snapshot(BatonStateDoc, root.id, context))?.epoch).toBe(1);

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.sidecarContext?.["helper_b:anthropic/claude-haiku"]?.contextTokens).toBe(226_200);

		await harness.close(context);
	});

	it("guards forks for Meta (sessionId + frozen tool declarations + beforeTool block), OpenAI (disableContinuation), and Kimi K3 (thinking epoch)", async () => {
		const metaProv = fauxProvider({
			provider: "meta",
			models: [{ id: "llama-maverick", contextWindow: 128_000, maxTokens: 4096, reasoning: true }],
		});
		const models = createModels();
		models.setProvider(metaProv.provider);

		const captured: Array<{
			sessionId?: string;
			disableContinuation?: boolean;
			reasoning?: string;
			tools: string[];
		}> = [];
		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "fork-aware",
					name: "Fork Aware",
					thinkingLevels: ["off", "low", "medium"],
					route: (req) =>
						applyForkGuardToRoute(
							{ model: models.getModel("meta", "llama-maverick")!, thinkingLevel: req.thinkingLevel },
							(req.state as { guard?: Parameters<typeof applyForkGuardToRoute>[1] } | undefined)?.guard,
						),
				},
			],
		});

		const guardExt = defineExtension({
			name: "ext-fork-guard",
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async ({ messages }, api, ctx) => {
						const guard = (await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx))?.forkGuard;
						return guard
							? attachVirtualRequestScope(
									{ messages },
									{ state: { guard }, disableContinuation: guard.disableContinuation },
								)
							: undefined;
					},
				}),
				hook(ToolTask, {
					beforeTool: async (call, api, ctx) => {
						const guard = (await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx))?.forkGuard;
						if (guard?.allowedTools && !guard.allowedTools.includes(call.name)) {
							return { block: guard.blockedToolReason ?? `Blocked ${call.name}` };
						}
						return undefined;
					},
				}),
			],
		});

		const { tools, executedCalls } = makeTestTools();
		const registry = createRegistry();
		registry.install(guardExt);
		registry.install(defineExtension({ name: "meta-tools", tools }));
		addSection(registry, "sys", () => "System instructions", { tag: false });

		metaProv.setResponses([
			(ctx, opts) => {
				captured.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Ring 1 warm.");
			},
			(ctx, opts) => {
				captured.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage([fauxToolCall("web_search", { query: "secret" })], { stopReason: "toolUse" });
			},
			(ctx, opts) => {
				captured.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Fork done.");
			},
		]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models: routedModels, registry, settings: { stream: { disableContinuation: true } } },
			context,
		);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "fork-aware" }, thinkingLevel: "medium" },
		});
		await (await root.submit({ type: "input", content: "Warm Ring 1" }, context)).wait(context);
		await root.waitForIdle(context);

		const parentAnswerId = (await allEntries(root)).findLast((e) => AssistantEntry.is(e))!.id;
		const fork = await createCacheGuardedFork(
			root,
			parentAnswerId,
			{
				ownership: { kind: "ownerless" },
				agent: { thinkingLevel: "off" },
				allowedTools: ["read"],
				blockedToolReason: "web_search is disabled on guarded fork",
			},
			context,
		);

		await (await fork.submit({ type: "input", content: "Run on fork" }, context)).wait(context);
		await fork.waitForIdle(context);

		expect(captured[1]!.sessionId).toBe(captured[0]!.sessionId);
		expect(captured[1]!.disableContinuation).toBe(true);
		expect(captured[1]!.reasoning).toBe("medium");
		expect(captured[1]!.tools).toEqual(["read", "edit", "web_search"]);
		expect(executedCalls.filter((c) => c.name === "web_search")).toHaveLength(0);
		expect(textOf((await allEntries(fork)).find((e) => ToolResultEntry.is(e))?.model?.[0])).toContain(
			"web_search is disabled on guarded fork",
		);

		await harness.close(context);
	});

	it("resolves virtual contextWindow + compaction maxTokens and records compaction sidecar spend", async () => {
		const mainProv = fauxProvider({
			provider: "main-prov",
			models: [{ id: "small-win", contextWindow: 400, maxTokens: 200 }],
		});
		const draftSumProv = fauxProvider({
			provider: "draft-sum-prov",
			models: [{ id: "draft-sum-1", contextWindow: 16_000, maxTokens: 1000 }],
		});
		const sumProv = fauxProvider({
			provider: "sum-prov",
			models: [{ id: "sum-1", contextWindow: 32_000, maxTokens: 2000 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);
		models.setProvider(draftSumProv.provider);
		models.setProvider(sumProv.provider);

		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "windowed",
					name: "Windowed",
					route: (req) =>
						req.purpose === "compaction"
							? {
									model: models.getModel("draft-sum-prov", "draft-sum-1")!,
									thinkingLevel: "off",
									validate: () => ({
										action: "escalate",
										model: models.getModel("sum-prov", "sum-1")!,
										thinkingLevel: "off",
									}),
								}
							: { model: models.getModel("main-prov", "small-win")!, thinkingLevel: "off" },
				},
			],
		});

		mainProv.setResponses([
			fauxAssistantMessage(`Reply one ${"y".repeat(600)}`),
			fauxAssistantMessage("Reply two after threshold compaction."),
		]);
		draftSumProv.setResponses([{ ...fauxAssistantMessage("weak draft"), usage: makeUsage(50, 12) }]);
		sumProv.setResponses([{ ...fauxAssistantMessage("## Goal\nCompacted summary."), usage: makeUsage(60, 18) }]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry: createRegistry(),
				settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10, backgroundTokens: 0 } },
			},
			context,
		);
		harness.resume();
		const root = await harness.root(context, { agent: { model: { provider: "router", modelId: "windowed" } } });

		await (await root.submit({ type: "input", content: `Heavy prompt ${"z".repeat(800)}` }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Trigger threshold compaction" }, context)).wait(context);
		await root.waitForIdle(context);

		expect((await allEntries(root)).some((e) => e.kind === "pi.compaction")).toBe(true);
		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.models["sum-prov/sum-1"]).toBeDefined();
		expect(usage?.sidecars?.["draft:draft-sum-prov/draft-sum-1"]).toBeDefined();

		await harness.close(context);
	});

	it("Tier 5 Finding #10: skips resolveContextWindow (and eager virtualModel.route) when compaction.enabled === false", async () => {
		const prov = fauxProvider({
			provider: "f10-prov",
			models: [{ id: "f10-1", contextWindow: 16_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const routeCalls: Array<{ purpose: string; state: unknown }> = [];
		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "no-eager-route",
					name: "No Eager Route",
					route(req) {
						routeCalls.push({ purpose: req.purpose, state: req.state });
						return {
							model: models.getModel("f10-prov", "f10-1")!,
							thinkingLevel: "off",
						};
					},
				},
			],
		});

		prov.setResponses([fauxAssistantMessage("Single route call.")]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry: createRegistry(),
				settings: { compaction: { enabled: false } },
			},
			context,
		);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "no-eager-route" } },
		});

		await (await root.submit({ type: "input", content: "Hello" }, context)).wait(context);
		await root.waitForIdle(context);

		expect(routeCalls).toHaveLength(1);
		expect(routeCalls[0]?.purpose).toBe("prompt");

		// When compaction.enabled === true, resolveContextWindow still calls route() so threshold compaction works
		routeCalls.length = 0;
		prov.setResponses([fauxAssistantMessage("With compaction enabled.")]);
		await root.commit(async (tx) => {
			(await tx.doc(AgentDoc, root.id)).compaction = { enabled: true };
		}, context);
		await (await root.submit({ type: "input", content: "Second" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(routeCalls.length).toBeGreaterThanOrEqual(2);

		await harness.close(context);
	});
});
