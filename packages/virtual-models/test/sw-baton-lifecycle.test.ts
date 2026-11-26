import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import {
	type Api,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type ConversationStreamOptions,
	createRegistry,
	defineExtension,
	defineTool,
	type EntryRecord,
	GenerationTask,
	Harness,
	type HookApi,
	hook,
	MemoryStorage,
	ResetEntry,
	type TaskId,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { BatonStateDoc, VirtualModelStateDoc } from "../src/durable/docs.ts";
import { getVirtualRequestScope, type VirtualModelDefinition, withVirtualModelRouting } from "../src/index.ts";
import { createBatonLifecycle } from "../src/sliding-window/baton-lifecycle.ts";
import { MemorySlidingWindowArtifactStore } from "../src/sliding-window/memory-store.ts";
import {
	createSlidingWindowState,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
} from "../src/sliding-window/state.ts";

const context: Context = BACKGROUND_CONTEXT;

async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const items: EntryRecord[] = [];
	let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
	do {
		const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

function textOf(msg: Message | undefined): string {
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	return msg.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for condition");
}

describe("createBatonLifecycle (S17)", () => {
	it("is self-sufficient without legacy virtual-models/sliding-window bridges or node:* built-ins and registers all 6 tasks + 5 hooks", async () => {
		const filePath = fileURLToPath(new URL("../src/sliding-window/baton-lifecycle.ts", import.meta.url));
		const source = await readFile(filePath, "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
		expect(source).not.toMatch(/["']node:/);
		expect(source).not.toMatch(/(?:^|\n)\s*import\s+(?!type\s)[^;]*["']@earendil-works\/pi-ai["']/);

		const state = createSlidingWindowState();
		const lifecycle = createBatonLifecycle(state);
		expect(lifecycle.tasks.map((t) => t.definition.name)).toEqual([
			"sliding-window.baton-write",
			"sliding-window.baton-clear",
			"sliding-window.baton-prep",
			"sliding-window.baton-launch",
			"sliding-window.round",
			"sliding-window.finish",
		]);
		expect(typeof lifecycle.hooks.beforeAgentStart).toBe("function");
		expect(typeof lifecycle.hooks.beforeRequest).toBe("function");
		expect(typeof lifecycle.hooks.afterResponse).toBe("function");
		expect(typeof lifecycle.hooks.afterTools).toBe("function");
		expect(typeof lifecycle.hooks.afterRun).toBe("function");
		await state.close();
	});

	it("hydrates scoped slices in beforeRequest, merges disableContinuation onto { messages, streamOptions }, and persists hydratedPaths + inner virtual routeState", async () => {
		const physProv = fauxProvider({
			provider: "phys",
			models: [{ id: "m-main", contextWindow: 32_000, maxTokens: 1024 }],
		});
		const baseModels = createModels();
		baseModels.setProvider(physProv.provider);
		const physical = baseModels.getModel("phys", "m-main")!;

		const recordedOutcomes: Array<{
			purpose: string;
			turnIndex: number;
			toolResultCount: number;
			prevCount: number;
		}> = [];
		const innerRouter: VirtualModelDefinition = {
			provider: "inner-router",
			id: "smart",
			name: "Smart Inner Router",
			contextWindow: 32_000,
			maxTokens: 1024,
			route(req) {
				const prev = (req.state as { count?: number } | undefined)?.count ?? 0;
				return {
					model: physical,
					thinkingLevel: "off",
					state: { count: prev + 1 },
				};
			},
			onOutcome(outcome) {
				const prev = (outcome.state as { count?: number } | undefined)?.count ?? 0;
				recordedOutcomes.push({
					purpose: outcome.purpose,
					turnIndex: outcome.turnIndex,
					toolResultCount: outcome.toolResults.length,
					prevCount: prev,
				});
				return { count: prev + 10 };
			},
		};

		const store = new MemorySlidingWindowArtifactStore();
		const putMeta = store.put("export const answer = 42;\n", {
			toolName: "read",
			sourcePath: "src/answer.ts",
			cwd: "/workspace",
		});

		const state = createSlidingWindowState({
			cwd: "/workspace",
			artifactStore: store,
			target: { provider: "inner-router", modelId: "smart" },
		});
		const outerStub: VirtualModelDefinition = {
			provider: state.vProvider,
			id: state.vId,
			name: state.vName,
			async route(req) {
				const s = req.state as {
					narrowTail?: string;
					innerDef?: VirtualModelDefinition;
					innerModel?: Model<Api>;
					innerState?: unknown;
				};
				if (s && typeof s === "object") {
					state.routedRequestMeta.set(s, { purpose: req.purpose, turnIndex: req.turnIndex });
				}
				const innerRoute = await s.innerDef!.route({
					...req,
					model: s.innerModel!,
					state: s.innerState,
				});
				return {
					...innerRoute,
					...(s.narrowTail ? { ephemeralTail: s.narrowTail, disableContinuation: true } : {}),
				};
			},
		};
		const routedModels = withVirtualModelRouting(baseModels, { models: [innerRouter, outerStub] });
		state.setBoundModels(routedModels);

		const lifecycle = createBatonLifecycle(state);

		// Direct unit check on S01's { messages, streamOptions } seam:
		const directStore = new MemorySlidingWindowArtifactStore();
		const directPutMeta = directStore.put("export const answer = 42;\n", {
			toolName: "read",
			sourcePath: "src/answer.ts",
			cwd: "/workspace",
		});
		const directState = createSlidingWindowState({
			cwd: "/workspace",
			artifactStore: directStore,
			target: physical,
		});
		const directLifecycle = createBatonLifecycle(directState);
		const incomingStreamOpts: ConversationStreamOptions = {
			timeoutMs: 9_876,
			headers: { "x-caller": "preserved" },
		};
		const fakeConvId = 1 as unknown as ConversationId;
		const mockApi = {
			taskId: 1 as unknown as TaskId,
			conversationId: fakeConvId,
			models: baseModels,
			now: () => 1_000,
			snapshot: async (doc: { readonly definition: { readonly kind: string } }) => {
				if (doc.definition.kind === SlidingWindowStateDoc.definition.kind) {
					return { hydrate: { allowedPaths: ["src/answer.ts"], hydratedPaths: [] } };
				}
				if (doc.definition.kind === VirtualModelStateDoc.definition.kind) {
					return { forkGuard: { disableContinuation: true } };
				}
				return undefined;
			},
			entries: async () => ({ items: [], next: undefined }),
		} as unknown as HookApi;

		const initialMsgs: Message[] = [{ role: "user", content: "hello", timestamp: 500 }];
		const hookResult = await directLifecycle.hooks.beforeRequest!(
			{ messages: initialMsgs, streamOptions: incomingStreamOpts },
			mockApi,
			context,
		);
		expect(hookResult).toBeDefined();
		expect(hookResult?.messages).toBe(initialMsgs);
		expect(hookResult?.streamOptions).toEqual({
			timeoutMs: 9_876,
			headers: { "x-caller": "preserved" },
			disableContinuation: true,
		});
		const attached = getVirtualRequestScope(hookResult);
		expect(attached?.disableContinuation).toBe(true);
		const scopeState = attached?.state as { narrowTail?: string } | undefined;
		expect(scopeState?.narrowTail).toContain(`ref="${directPutMeta.ref}"`);
		expect(scopeState?.narrowTail).toContain("export const answer = 42;");
		await directState.close();
		expect(putMeta.ref).toBe(directPutMeta.ref);

		// End-to-end Harness check with inner virtual model + tool round + terminal text turn:
		const pingTool = defineTool({
			name: "ping",
			description: "Ping tool",
			parameters: obj({ value: str() }),
			execute: async (args) => ({ output: [{ type: "text", text: `pong:${args.value}` }] }),
		});

		const seenOptions: Array<SimpleStreamOptions | undefined> = [];
		physProv.setResponses([
			(_ctx, opts) => {
				seenOptions.push(opts);
				return {
					...fauxAssistantMessage([fauxToolCall("ping", { value: "one" })], { stopReason: "toolUse" }),
					usage: {
						input: 300,
						output: 30,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 330,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
			(_ctx, opts) => {
				seenOptions.push(opts);
				return {
					...fauxAssistantMessage("Final answer after tool."),
					usage: {
						input: 360,
						output: 25,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 385,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		]);

		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.tools", tools: [pingTool] }));
		registry.install(
			defineExtension({
				name: "test.baton-lifecycle",
				tasks: lifecycle.tasks,
				hooks: [hook(GenerationTask, lifecycle.hooks)],
			}),
		);

		const test2Reports: unknown[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry,
				onReport: (r) => test2Reports.push(r),
				settings: {
					compaction: { enabled: false },
					stream: { timeoutMs: 7_777 },
				},
			},
			context,
		);
		harness.resume();
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: state.vProvider, modelId: state.vId } },
			});
			await root.commit(async (tx) => {
				const swDoc = await tx.doc(SlidingWindowStateDoc, root.id);
				swDoc.hydrate = {
					allowedPaths: ["src/answer.ts"],
					hydratedPaths: [],
				};
			}, context);

			const sub = await root.submit({ type: "input", content: "Use hydrated slice and ping" }, context);
			expect((await sub.wait(context)).status).toBe("done");
			await root.waitForIdle(context);
			expect(test2Reports).toEqual([]);

			expect(seenOptions).toHaveLength(2);
			expect(seenOptions[0]?.disableContinuation, JSON.stringify(seenOptions[0])).toBe(true);
			expect(seenOptions[0]?.timeoutMs).toBe(7_777);

			// WindowRoundTask flushed tool-round outcome (1 toolResult), afterResponse flushed final text outcome (0 toolResults),
			// and WindowFinishTask persisted hydratedPaths + VirtualModelStateDoc.routeState.
			expect(recordedOutcomes).toHaveLength(2);
			expect(recordedOutcomes[0]?.toolResultCount).toBe(1);
			expect(recordedOutcomes[1]?.toolResultCount).toBe(0);

			const swAfter = await harness.snapshot(SlidingWindowStateDoc, root.id, context);
			expect(swAfter?.hydrate?.hydratedPaths).toEqual(["src/answer.ts"]);

			const vmAfter = await harness.snapshot(VirtualModelStateDoc, root.id, context);
			expect(vmAfter?.routeState).toEqual({ count: 22 });
		} finally {
			await state.close();
			await harness.close(context);
		}
	});

	it("runs soft-ceiling BatonLaunchTask -> BatonPrepTask, cancels via BatonClearTask, and swaps via BatonWriteTask with study-notes harvesting", async () => {
		const mainProv = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-sonnet", contextWindow: 40_000, maxTokens: 4096 },
				{ id: "claude-haiku", contextWindow: 40_000, maxTokens: 2048 },
			],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);

		let cancelNext = false;
		const state = createSlidingWindowState({
			target: models.getModel("anthropic", "claude-sonnet")!,
			softCeilingTokens: 600,
			hardCeilingTokens: 1_800,
			keepRecentTokens: 150,
			batonModel: "anthropic/claude-haiku",
			anchorFirstUser: true,
			renderExtraSections: ({ epoch }) => [`- **Extra:** epoch=${epoch}`],
			onBeforeSwap: ({ summary }) => {
				if (cancelNext) return { cancel: true };
				return {
					summary: `${summary}\n\n- **BeforeSwap:** confirmed`,
					data: { tag: "s17" },
				};
			},
		});
		const lifecycle = createBatonLifecycle(state);

		const readTool = defineTool({
			name: "read",
			description: "Read file",
			parameters: obj({ path: str() }),
			execute: async (args) => ({ output: [{ type: "text", text: `file:${args.path}` }] }),
		});

		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.read", tools: [readTool] }));
		registry.install(
			defineExtension({
				name: "test.baton-lifecycle",
				tasks: lifecycle.tasks,
				hooks: [hook(GenerationTask, lifecycle.hooks)],
			}),
		);

		const seenMainRequests: TranscriptContext[] = [];
		const isHelperReq = (ctx: TranscriptContext) =>
			ctx.messages.some((m) => typeof m.content === "string" && m.content.includes("Aged-Out Prose"));
		const mainOrHelper =
			(reply: ReturnType<typeof fauxAssistantMessage>) =>
			(ctx: TranscriptContext): ReturnType<typeof fauxAssistantMessage> => {
				if (isHelperReq(ctx)) {
					return {
						...fauxAssistantMessage("- Synthesized haiku prose digest"),
						usage: {
							input: 120,
							output: 30,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 150,
							cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
						},
					};
				}
				seenMainRequests.push(ctx);
				return reply;
			};

		mainProv.setResponses([
			mainOrHelper(fauxAssistantMessage([fauxToolCall("read", { path: "src/core.ts" })], { stopReason: "toolUse" })),
			mainOrHelper(
				fauxAssistantMessage([
					{
						type: "thinking",
						thinking:
							"Post-read invariant: core.ts owns lifecycle state, baton epoch transitions, and durable hydrated slice persistence across runs.",
					},
					{ type: "text", text: `Studied src/core.ts ${"r".repeat(1_200)}` },
				]),
			),
			mainOrHelper(fauxAssistantMessage(`Turn 2 warms prompt past soft ceiling ${"w".repeat(2_000)}`)),
			mainOrHelper(fauxAssistantMessage("Turn 3 launched baton prep")),
			mainOrHelper(fauxAssistantMessage("Helper slot 1")),
		]);

		const test3Reports: unknown[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, onReport: (r) => test3Reports.push(r), settings: { compaction: { enabled: false } } },
			context,
		);
		harness.resume();
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "anthropic", modelId: "claude-sonnet" } },
			});

			// Turn 1: below soft ceiling during tool round so read + post-read thinking complete cleanly
			await (await root.submit({ type: "input", content: "ROOT ANCHOR: inspect src/core.ts" }, context)).wait(
				context,
			);
			// Turn 2: crosses softCeilingTokens (600) on its response
			await (await root.submit({ type: "input", content: `Expand analysis ${"e".repeat(1_400)}` }, context)).wait(
				context,
			);
			// Turn 3: beforeAgentStart sees lastUsageTokens >= 600 and launches BatonLaunchTask -> BatonPrepTask
			await (await root.submit({ type: "input", content: "Trigger background baton prep" }, context)).wait(context);
			expect(test3Reports).toEqual([]);
			await waitFor(() => state.inspect(root.id).note.startsWith("ready"));

			const stagedSnap = await harness.snapshot(BatonStateDoc, root.id, context);
			expect(stagedSnap?.staged?.proseDigest).toBe("- Synthesized haiku prose digest");

			// Cancel via onBeforeSwap -> BatonClearTask removes staged while keeping epoch 0
			cancelNext = true;
			mainProv.setResponses([mainOrHelper(fauxAssistantMessage("Cancelled swap turn"))]);
			await (await root.submit({ type: "input", content: "Turn while swap cancelled" }, context)).wait(context);
			await root.waitForIdle(context);
			expect(state.inspect(root.id).epoch).toBe(0);
			expect((await harness.snapshot(BatonStateDoc, root.id, context))?.staged).toBeUndefined();

			// Re-stage and let swap commit via BatonWriteTask
			cancelNext = false;
			mainProv.setResponses([
				mainOrHelper(fauxAssistantMessage("Re-arm prep")),
				mainOrHelper(fauxAssistantMessage("Helper slot 2")),
			]);
			await (await root.submit({ type: "input", content: "Re-arm baton prep" }, context)).wait(context);
			await waitFor(() => state.inspect(root.id).note.startsWith("ready"));

			let postSwapPromptTokens = 0;
			mainProv.setResponses([
				(ctx) => {
					seenMainRequests.push(ctx);
					const reply = fauxAssistantMessage("Post-swap answer");
					postSwapPromptTokens = ctx.messages.length;
					return reply;
				},
			]);
			await (await root.submit({ type: "input", content: "Execute staged swap" }, context)).wait(context);
			await root.waitForIdle(context);
			expect(postSwapPromptTokens).toBeGreaterThan(0);

			const baton = await harness.snapshot(BatonStateDoc, root.id, context);
			expect(baton?.epoch).toBe(1);
			expect(baton?.staged).toBeUndefined();
			expect(baton?.handoffSummary).toContain("Extra:** epoch=1");
			expect(baton?.handoffSummary).toContain("BeforeSwap:** confirmed");
			expect(baton?.harvestedStudyNotes).toContain("<study_notes>");

			const ledgerDoc = await harness.snapshot(SlidingWindowLedgerDoc, root.id, context);
			expect(ledgerDoc?.epoch).toBe(1);
			expect(ledgerDoc?.lastProseDigest).toBe("- Synthesized haiku prose digest");

			const usage = await harness.snapshot(UsageDoc, root.id, context);
			expect(usage?.sidecars?.["baton:anthropic/claude-haiku"]?.totalTokens).toBeGreaterThan(0);

			const lastReqUsers = seenMainRequests.at(-1)!.messages.filter((m) => m.role === "user");
			expect(textOf(lastReqUsers[0])).toContain("ROOT ANCHOR");
			expect(textOf(lastReqUsers[1])).toContain("<!-- sliding-window epoch 1");

			const resets = (await allEntries(root)).filter((e) => ResetEntry.is(e));
			expect(resets).toHaveLength(1);
			expect(resets[0]?.data).toEqual({ slidingWindow: true, epoch: 1, custom: { tag: "s17" } });
			expect(state.inspect(root.id).probe?.actual).toBeGreaterThan(0);
		} finally {
			await state.close();
			await harness.close(context);
		}
	});

	it("executes mid-run WindowRoundTask burst fallback with anchorFirstUser=false and fences stale BatonPrepTask epochs", async () => {
		const mainProv = fauxProvider({
			provider: "main-burst",
			models: [{ id: "m-burst", contextWindow: 4_000, maxTokens: 512 }],
		});
		const slowHelper = fauxProvider({
			provider: "helper-burst",
			models: [{ id: "h-slow", contextWindow: 8_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);
		models.setProvider(slowHelper.provider);

		let releaseHelper!: () => void;
		const helperBlocked = new Promise<void>((resolve) => {
			releaseHelper = resolve;
		});
		let helperStartedResolve!: () => void;
		const helperStarted = new Promise<void>((resolve) => {
			helperStartedResolve = resolve;
		});

		slowHelper.setResponses([
			async () => {
				helperStartedResolve();
				await helperBlocked;
				return {
					...fauxAssistantMessage("- Stale epoch 0 helper digest"),
					usage: {
						input: 90,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
				};
			},
		]);

		const stepTool = defineTool({
			name: "step",
			description: "Step tool",
			parameters: obj({ payload: str() }),
			execute: async (args) => ({ output: [{ type: "text", text: `ack:${args.payload}` }] }),
		});

		const state = createSlidingWindowState({
			batonModel: "helper-burst/h-slow",
			softCeilingTokens: 150,
			hardCeilingTokens: 450,
			keepTail: false,
			anchorFirstUser: false,
		});
		const lifecycle = createBatonLifecycle(state);

		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.step", tools: [stepTool] }));
		registry.install(
			defineExtension({
				name: "test.baton-lifecycle",
				tasks: lifecycle.tasks,
				hooks: [hook(GenerationTask, lifecycle.hooks)],
			}),
		);

		mainProv.setResponses([
			() => fauxAssistantMessage([fauxToolCall("step", { payload: "w".repeat(1_200) })], { stopReason: "toolUse" }),
			async () => {
				await helperStarted;
				return fauxAssistantMessage([fauxToolCall("step", { payload: "b".repeat(800) })], {
					stopReason: "toolUse",
				});
			},
			() => fauxAssistantMessage("Completed after mid-run burst swap."),
		]);

		const reports: unknown[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models,
				registry,
				settings: { compaction: { enabled: false } },
				onReport: (report) => reports.push(report),
			},
			context,
		);
		harness.resume();
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "main-burst", modelId: "m-burst" } },
			});
			await root.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, root.id)).target = {
					provider: "main-burst",
					modelId: "m-burst",
				};
			}, context);

			const sub = await root.submit(
				{ type: "input", content: `Run autonomous burst loop ${"u".repeat(700)}` },
				context,
			);
			expect((await sub.wait(context)).status).toBe("done");
			await root.waitForIdle(context);
			expect(reports).toEqual([]);

			const prepTask = (await harness.snapshot(BatonStateDoc, root.id, context))?.preparingTaskId;
			releaseHelper();
			if (prepTask !== undefined) await harness.waitForTask(prepTask, context);
			await waitFor(async () => {
				const usage = await harness.snapshot(UsageDoc, root.id, context);
				return Boolean(usage?.sidecars?.["baton:helper-burst/h-slow"]);
			});

			const batonAfter = await harness.snapshot(BatonStateDoc, root.id, context);
			expect(batonAfter?.epoch).toBe(1);
			expect(batonAfter?.anchorUser0).toBeUndefined();
			expect(batonAfter?.staged).toBeUndefined();
			expect(batonAfter?.handoffSummary).toContain("burst-fallback");

			const resets = (await allEntries(root)).filter((e) => ResetEntry.is(e));
			expect(resets).toHaveLength(1);
			expect(resets[0]?.model).toHaveLength(1);
		} finally {
			await state.close();
			await harness.close(context);
		}
	});
});
