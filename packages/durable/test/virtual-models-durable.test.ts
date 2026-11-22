import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Message,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { withVirtualModelRouting } from "@earendil-works/pi-ai/virtual-models";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	ProviderDoc,
	ResetEntry,
	ToolResultEntry,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	BatonStateDoc,
	computeContextCacheSnapshot,
	createCacheGuardedFork,
	createVirtualModelsExtension,
	getActiveEphemeralSlices,
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
	const files = new Map<string, string>();
	files.set(
		"src/pricing.ts",
		[
			"export function computeSubtotal(items: number[]): number {",
			"  return items.reduce((a, b) => a + b, 0);",
			"}",
			"export function applyDiscount(total: number, pct: number): number {",
			"  return total * (1 - pct);",
			"}",
			"// padding ".repeat(15),
		].join("\n"),
	);
	const executedCalls: Array<{ name: string; args: unknown }> = [];

	const read = defineTool({
		name: "read",
		description: "Read a file",
		parameters: obj({ path: str() }),
		execute: async (args) => {
			executedCalls.push({ name: "read", args });
			const content = files.get(args.path) ?? "missing";
			return { output: [{ type: "text", text: content }] };
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

describe("durable virtual-models integration", () => {
	it("routes turns, records draft sidecar usage in UsageDoc, preserves physical thinkingLevel, and delivers durable toolResults to onOutcome", async () => {
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

		const recordedOutcomes: Array<{
			physicalModel: string;
			toolResultsCount: number;
			turnIndex: number;
			state: unknown;
		}> = [];
		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "auto",
					name: "Auto Router",
					thinkingLevels: ["off", "low", "high"],
					route(req) {
						const prevState =
							typeof req.state === "object" && req.state !== null ? (req.state as Record<string, unknown>) : {};
						const prevTurnCount = typeof prevState.turns === "number" ? prevState.turns : 0;
						return {
							model: models.getModel("fast-prov", "fast-1")!,
							thinkingLevel: "off",
							state: { ...prevState, turns: prevTurnCount + 1 },
							validate() {
								return {
									action: "escalate",
									model: models.getModel("deep-prov", "deep-1")!,
									thinkingLevel: "high",
								};
							},
						};
					},
					onOutcome(outcome) {
						recordedOutcomes.push({
							physicalModel: `${outcome.route.model.provider}/${outcome.route.model.id}`,
							toolResultsCount: outcome.toolResults.length,
							turnIndex: outcome.turnIndex,
							state: outcome.state,
						});
						const prev =
							typeof outcome.state === "object" && outcome.state !== null && "turns" in outcome.state
								? Number((outcome.state as { turns: number }).turns)
								: 1;
						return { turns: prev, lastTools: outcome.toolResults.length };
					},
				},
			],
		});

		const { tools } = makeTestTools();
		const vmExt = createVirtualModelsExtension({ receipts: { enabled: false } });
		const registry = createRegistry();
		registry.install(vmExt);
		registry.install(defineExtension({ name: "app-tools", tools }));

		const nowMs = 1_000_000;
		fast.setResponses([
			fauxAssistantMessage("draft response number one", { timestamp: nowMs }),
			fauxAssistantMessage("draft response number two", { timestamp: nowMs }),
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
			agent: {
				model: { provider: "router", modelId: "auto" },
				thinkingLevel: "low",
			},
		});

		const sub = await root.submit({ type: "input", content: "Inspect pricing.ts" }, context);
		expect((await sub.wait(context)).status).toBe("done");
		await root.waitForIdle(context);

		const entries = await allEntries(root);
		const assistantEntries = entries.filter((e) => AssistantEntry.is(e));
		expect(assistantEntries).toHaveLength(2);
		expect(assistantEntries[0]!.model?.[0]).toMatchObject({
			role: "assistant",
			provider: "deep-prov",
			model: "deep-1",
			thinkingLevel: "high",
		});

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.models["deep-prov/deep-1"]).toBeDefined();
		// Both escalated turns' draft outputs (estimated by faux) accumulated into UsageDoc.sidecars.
		expect(usage?.sidecars?.["draft:fast-prov/fast-1"]?.output).toBeGreaterThanOrEqual(8);
		expect(usage?.sidecars?.["draft:fast-prov/fast-1"]?.totalTokens).toBeGreaterThan(0);

		expect(recordedOutcomes).toEqual([
			{ physicalModel: "deep-prov/deep-1", toolResultsCount: 1, turnIndex: 0, state: { turns: 1 } },
			{ physicalModel: "deep-prov/deep-1", toolResultsCount: 0, turnIndex: 1, state: { turns: 2, lastTools: 1 } },
		]);

		const persistedState = await harness.snapshot(VirtualModelStateDoc, root.id, context);
		expect(persistedState?.routeState).toEqual({ turns: 2, lastTools: 0 });

		const view = await root.context(context);
		const cacheSnap = computeContextCacheSnapshot(view, (p, m) => routedModels.getPhysicalModel(p, m), {
			now: nowMs + 10_000,
		});
		const lastAssistant = assistantEntries.at(-1)!.model![0]!;
		const expectedWarmTokens =
			lastAssistant.role === "assistant"
				? (lastAssistant.usage.cacheRead ?? 0) + (lastAssistant.usage.cacheWrite ?? 0)
				: 0;
		expect(expectedWarmTokens).toBeGreaterThan(0);
		expect(cacheSnap.cacheFreeBoundary).toBe(false);
		expect(cacheSnap.get("deep-prov", "deep-1")?.warmTokens).toBe(expectedWarmTokens);

		const expiredSnap = computeContextCacheSnapshot(view, (p, m) => routedModels.getPhysicalModel(p, m), {
			now: nowMs + 10 * 60_000,
		});
		expect(expiredSnap.cacheFreeBoundary).toBe(true);
		expect(expiredSnap.boundaryReason).toBe("expired");

		await harness.close(context);
	});

	it("stores short receipts in ToolResultEntry, attaches full text in ephemeralTail, and drops on edit or idle turns", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const seenWireContexts: TranscriptContext[] = [];
		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "smart",
					name: "Smart",
					route: () => ({ model: models.getModel("anthropic", "claude-sonnet")!, thinkingLevel: "off" }),
				},
			],
		});

		const { tools } = makeTestTools();
		const vmExt = createVirtualModelsExtension({
			receipts: { enabled: true, minChars: 40, maxIdleTurns: 2 },
		});
		const registry = createRegistry();
		registry.install(vmExt);
		registry.install(defineExtension({ name: "app-tools", tools }));

		prov.setResponses([
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/pricing.ts" })], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Turn 1 saw pricing implementation cleanly.");
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Unrelated math: 2 + 2 = 4.");
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Unrelated greeting response.");
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Fourth response after idle drop.");
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/pricing.ts" })], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("edit", { path: "src/pricing.ts", content: "updated file" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				seenWireContexts.push(ctx);
				return fauxAssistantMessage("Edit completed.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routedModels, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "smart" } },
		});

		await (await root.submit({ type: "input", content: "Inspect pricing" }, context)).wait(context);
		await root.waitForIdle(context);

		const entriesAfterRead = await allEntries(root);
		const toolEntry = entriesAfterRead.find((e) => ToolResultEntry.is(e));
		const storedToolText = textOf(toolEntry?.model?.[0]);
		expect(storedToolText).toContain("[receipt ref:");
		expect(storedToolText).toContain("path: src/pricing.ts");
		expect(storedToolText).toContain("symbols: export function computeSubtotal");
		expect(storedToolText).not.toContain("// padding");

		// Continuation turn after read saw the full file ephemerally at the tail.
		expect(textOf(seenWireContexts[1]?.messages.at(-1))).toContain("export function applyDiscount");
		expect(textOf(seenWireContexts[1]?.messages.at(-1))).toContain("// padding");
		expect(getActiveEphemeralSlices(vmExt, root.id)).toHaveLength(1);

		// Two unrelated turns go by -> dropped from ephemeralTail cleanly.
		await (await root.submit({ type: "input", content: "What is 2+2?" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(getActiveEphemeralSlices(vmExt, root.id)).toHaveLength(1);

		await (await root.submit({ type: "input", content: "Say hello" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(getActiveEphemeralSlices(vmExt, root.id)).toHaveLength(0);

		await (await root.submit({ type: "input", content: "Confirm tail clean" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(textOf(seenWireContexts[4]?.messages.at(-1))).not.toContain("ephemeral-slice");

		// Re-read then edit succeeds -> drops slice immediately on edit success.
		await (await root.submit({ type: "input", content: "Read and update pricing" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(getActiveEphemeralSlices(vmExt, root.id)).toHaveLength(0);
		expect(textOf(seenWireContexts[7]?.messages.at(-1))).not.toContain("ephemeral-slice");

		await harness.close(context);
	});

	it("runs beforeAgentStart baton swap preserving anchor firstUser (cch), keeping trigger user visible, and logging helper sidecar spend", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const seenRequests: TranscriptContext[] = [];
		const vmExt = createVirtualModelsExtension({
			receipts: { enabled: false },
			baton: {
				swapAfterTokens: 40,
				summarize: async ({ anchorUser, recordSidecar }) => {
					expect(textOf(anchorUser)).toBe("ANCHOR USER PROMPT FOR CCH");
					recordSidecar("anthropic", "claude-haiku", makeUsage(120, 35), "baton_helper");
					return "Concise baton summary of prior work.";
				},
			},
		});
		const registry = createRegistry();
		registry.install(vmExt);

		prov.setResponses([
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("A".repeat(400));
			},
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("Continuing after baton swap.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "anthropic", modelId: "claude-sonnet" } },
		});

		await (await root.submit({ type: "input", content: "ANCHOR USER PROMPT FOR CCH" }, context)).wait(context);
		await root.waitForIdle(context);

		// Second user turn exceeds swapAfterTokens -> beforeAgentStart appends ResetEntry keeping ANCHOR USER PROMPT first!
		await (await root.submit({ type: "input", content: "Follow-up task after heavy turn" }, context)).wait(context);
		await root.waitForIdle(context);

		const secondWireMessages = seenRequests[1]!.messages;
		const userMessages = secondWireMessages.filter((m) => m.role === "user");
		expect(textOf(userMessages[0])).toBe("ANCHOR USER PROMPT FOR CCH");
		expect(textOf(userMessages[1])).toContain("Concise baton summary of prior work.");
		expect(textOf(userMessages[2])).toBe("Follow-up task after heavy turn");

		const entries = await allEntries(root);
		expect(entries.some((e) => ResetEntry.is(e))).toBe(true);

		const batonState = await harness.snapshot(BatonStateDoc, root.id, context);
		expect(batonState?.epoch).toBe(1);
		expect(textOf(batonState?.anchorUser0 as Message)).toBe("ANCHOR USER PROMPT FOR CCH");

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.sidecars?.["baton_helper:anthropic/claude-haiku"]).toMatchObject({
			input: 120,
			output: 35,
		});

		await harness.close(context);
	});

	it("guards forks for Meta (copied sessionId + frozen tool declarations + beforeTool block), OpenAI (disableContinuation), and Kimi K3 (thinking epoch)", async () => {
		const metaProv = fauxProvider({
			provider: "meta",
			models: [{ id: "llama-maverick", contextWindow: 128_000, maxTokens: 4096, reasoning: true }],
		});
		const models = createModels();
		models.setProvider(metaProv.provider);

		const capturedCalls: Array<{
			sessionId?: string;
			disableContinuation?: boolean;
			reasoning?: string;
			declaredToolNames: string[];
		}> = [];

		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "fork-aware",
					name: "Fork Aware",
					thinkingLevels: ["off", "low", "medium"],
					route: (req) => ({
						model: models.getModel("meta", "llama-maverick")!,
						thinkingLevel: req.thinkingLevel,
					}),
				},
			],
		});

		const { tools, executedCalls } = makeTestTools();
		const vmExt = createVirtualModelsExtension({ receipts: { enabled: false } });
		const registry = createRegistry();
		registry.install(vmExt);
		registry.install(defineExtension({ name: "meta-tools", tools }));
		addSection(registry, "sys", () => "System instructions", { tag: false });

		metaProv.setResponses([
			(ctx, opts) => {
				capturedCalls.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					declaredToolNames: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Ring 1 warm response.");
			},
			// Fork attempts web_search (declared on wire, blocked at execution in beforeTool!), then succeeds cleanly.
			(ctx, opts) => {
				capturedCalls.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					declaredToolNames: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage([fauxToolCall("web_search", { query: "secret" })], { stopReason: "toolUse" });
			},
			(ctx, opts) => {
				capturedCalls.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					declaredToolNames: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Fork completed safely.");
			},
		]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry,
				settings: { stream: { disableContinuation: true } },
			},
			context,
		);
		harness.resume();

		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "fork-aware" }, thinkingLevel: "medium" },
		});
		await (await root.submit({ type: "input", content: "Warm Ring 1" }, context)).wait(context);
		await root.waitForIdle(context);

		const rootEntries = await allEntries(root);
		const parentAnswerId = rootEntries.findLast((e) => AssistantEntry.is(e))!.id;
		const parentProvider = await harness.snapshot(ProviderDoc, root.id, context);
		expect(parentProvider?.sessionId).toBeTruthy();

		// Create fork trying to drop thinking to "off" (Kimi K3 guard should keep "medium") and restricting to ["read"].
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

		const forkProvider = await harness.snapshot(ProviderDoc, fork.id, context);
		expect(forkProvider?.sessionId).toBe(parentProvider?.sessionId);

		await (await fork.submit({ type: "input", content: "Run on fork" }, context)).wait(context);
		await fork.waitForIdle(context);

		expect(capturedCalls).toHaveLength(3);
		// Parent & fork share identical sessionId, disableContinuation, non-"off" reasoning, and identical wire tool list.
		expect(capturedCalls[1]!.sessionId).toBe(capturedCalls[0]!.sessionId);
		expect(capturedCalls[0]!.disableContinuation).toBe(true);
		expect(capturedCalls[1]!.disableContinuation).toBe(true);
		expect(capturedCalls[1]!.reasoning).toBe("medium");
		expect(capturedCalls[1]!.declaredToolNames).toEqual(["read", "edit", "web_search"]);
		expect(capturedCalls[1]!.declaredToolNames).toEqual(capturedCalls[0]!.declaredToolNames);

		// web_search was declared for Meta cache parity, but blocked in beforeTool so execute never ran!
		expect(executedCalls.filter((c) => c.name === "web_search")).toHaveLength(0);
		const forkEntries = await allEntries(fork);
		const blockedResult = forkEntries.find((e) => ToolResultEntry.is(e));
		expect(blockedResult?.model?.[0]?.role === "toolResult" && blockedResult.model[0].isError).toBe(true);
		expect(textOf(blockedResult?.model?.[0])).toContain("web_search is disabled on guarded fork");

		await harness.close(context);
	});

	it("routes compaction through virtual models and records physical model and sidecar spend in UsageDoc", async () => {
		const mainProv = fauxProvider({
			provider: "main-prov",
			models: [{ id: "main-1", contextWindow: 100_000, maxTokens: 4000 }],
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
					id: "compacting",
					name: "Compacting",
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
							: {
									model: models.getModel("main-prov", "main-1")!,
									thinkingLevel: "off",
								},
				},
			],
		});

		mainProv.setResponses([
			fauxAssistantMessage("Detailed first answer ".repeat(10)),
			fauxAssistantMessage("Detailed second answer ".repeat(10)),
		]);
		draftSumProv.setResponses([{ ...fauxAssistantMessage("weak draft summary"), usage: makeUsage(50, 12) }]);
		sumProv.setResponses([{ ...fauxAssistantMessage("## Goal\nCompacted summary."), usage: makeUsage(60, 18) }]);

		const registry = createRegistry();
		registry.install(createVirtualModelsExtension({ receipts: { enabled: false } }));

		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry,
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 1000 } },
			},
			context,
		);
		harness.resume();

		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "compacting" } },
		});
		await (await root.submit({ type: "input", content: "Turn one prompt" }, context)).wait(context);
		await (await root.submit({ type: "input", content: "Turn two prompt" }, context)).wait(context);
		await root.waitForIdle(context);

		const compactId = await root.compact(undefined, context);
		const compactSettled = await harness.waitForTask(compactId, context);
		expect(compactSettled.state.outcome.status).toBe("completed");

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.models["main-prov/main-1"]).toBeDefined();
		expect(usage?.models["sum-prov/sum-1"]).toBeDefined();
		expect(usage?.sidecars?.["draft:draft-sum-prov/draft-sum-1"]?.input).toBeGreaterThan(0);
		expect(usage?.sidecars?.["draft:draft-sum-prov/draft-sum-1"]?.output).toBe(5);
		expect(usage?.sidecars?.["draft:draft-sum-prov/draft-sum-1"]?.totalTokens).toBeGreaterThan(5);

		await harness.close(context);
	});

	it("resolves physical contextWindow for threshold compaction on virtual models and preserves ephemeralTail on failed edit", async () => {
		const physProv = fauxProvider({
			provider: "phys-prov",
			models: [{ id: "small-win", contextWindow: 400, maxTokens: 200 }],
		});
		const models = createModels();
		models.setProvider(physProv.provider);

		const routedModels = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "windowed",
					name: "Windowed",
					// Virtual catalog entry intentionally starts with contextWindow: 0.
					route: () => ({ model: models.getModel("phys-prov", "small-win")!, thinkingLevel: "off" }),
				},
			],
		});

		const failingEdit = defineTool({
			name: "edit",
			description: "Failing edit",
			parameters: obj({ path: str(), fail: opt(str()) }),
			execute: async (args) => {
				if (args.fail === "yes") {
					return { isError: true, output: [{ type: "text", text: "edit failed" }] };
				}
				return { output: [{ type: "text", text: "edit ok" }] };
			},
		});
		const read = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async () => ({
				output: [{ type: "text", text: `export function big() {\n  return 1;\n}\n${"x".repeat(120)}` }],
			}),
		});

		const vmExt = createVirtualModelsExtension({ receipts: { enabled: true, minChars: 40, maxIdleTurns: 3 } });
		const registry = createRegistry();
		registry.install(vmExt);
		registry.install(defineExtension({ name: "edit-tools", tools: [read, failingEdit] }));

		physProv.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/a.ts", fail: "yes" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Noted failed edit; slice kept."),
			fauxAssistantMessage(`First turn reply ${"y".repeat(600)}`),
			// Threshold compaction summary before second user prompt!
			fauxAssistantMessage("## Goal\nCompacted threshold summary."),
			fauxAssistantMessage("Second turn after threshold compaction."),
		]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry,
				settings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10, backgroundTokens: 0 } },
			},
			context,
		);
		harness.resume();

		const root = await harness.root(context, {
			agent: { model: { provider: "router", modelId: "windowed" } },
		});
		await (await root.submit({ type: "input", content: "Inspect and try edit" }, context)).wait(context);
		await root.waitForIdle(context);
		// Failed edit must NOT evict the active slice!
		expect(getActiveEphemeralSlices(vmExt, root.id)).toHaveLength(1);

		await (await root.submit({ type: "input", content: `Heavy prompt ${"z".repeat(800)}` }, context)).wait(context);
		await root.waitForIdle(context);

		await (await root.submit({ type: "input", content: "Trigger threshold compaction" }, context)).wait(context);
		await root.waitForIdle(context);

		const entries = await allEntries(root);
		expect(entries.some((e) => e.kind === "pi.compaction")).toBe(true);

		await harness.close(context);
	});
});
