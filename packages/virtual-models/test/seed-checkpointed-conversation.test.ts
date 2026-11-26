import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	getCurrentTools,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	type EntryRecord,
	Harness,
	MemoryStorage,
	ProviderDoc,
	ROOT_CONVERSATION_ID,
	SystemEntry,
	type TaskId,
	UserEntry,
} from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { BatonStateDoc, VirtualModelStateDoc } from "../src/durable/docs.ts";
import { exportCheckpointedForkToStorage } from "../src/sliding-window/fork-export.ts";
import { createSlidingWindow } from "../src/sliding-window/index.ts";
import {
	applyCheckpointedSeed,
	buildCheckpointedSeedPlan,
	readParentCheckpointDocs,
	seedCheckpointedConversation,
} from "../src/sliding-window/seed-plan.ts";
import {
	CheckpointLineageDoc,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
} from "../src/sliding-window/state.ts";

const context: Context = BACKGROUND_CONTEXT;

async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

function setup(modelIds: readonly string[] = ["m"]) {
	const prov = fauxProvider({
		provider: "p",
		models: modelIds.map((id) => ({ id, contextWindow: 64_000, maxTokens: 1024, reasoning: true })),
	});
	const models = createModels();
	models.setProvider(prov.provider);
	const registry = createRegistry();
	return { prov, models, registry };
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return done;
}

function aborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_, reject) => {
		if (signal === undefined) {
			reject(new Error("Provider request has no abort signal"));
			return;
		}
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

describe("sliding-window seed self-sufficiency", () => {
	it("seed-plan.ts and fork-export.ts import no legacy virtual-models entry and no node: module", () => {
		const legacyImport = /@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/;
		const seedPlan = readFileSync(
			fileURLToPath(new URL("../src/sliding-window/seed-plan.ts", import.meta.url)),
			"utf8",
		);
		const forkExport = readFileSync(
			fileURLToPath(new URL("../src/sliding-window/fork-export.ts", import.meta.url)),
			"utf8",
		);
		expect(seedPlan).not.toMatch(legacyImport);
		expect(forkExport).not.toMatch(legacyImport);
		expect(seedPlan).not.toMatch(/from "node:/);
		expect(forkExport).not.toMatch(/from "node:/);
	});
});

describe("seedCheckpointedConversation", () => {
	it("seeds a child in a non-empty live store without clobbering the root conversation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-vm-seed-"));
		const database = await openNodeSqliteDatabase(join(directory, "session.sqlite"));
		const store = await openStore(sqliteBackend(database), context);
		const storage = await StoreStorage.open(store, "vm.seed-test", context);
		const { prov, models, registry } = setup();
		const sw = createSlidingWindow({ target: models.getModel("p", "m")! });
		const routed = sw.wrapModels(models);
		registry.install(sw.extension);
		const seedTool = defineTool({
			name: "seed_tool",
			description: "A tool visible at the checkpoint",
			parameters: obj({ value: str() }),
			execute: async () => ({ output: [] }),
		});
		registry.install(defineExtension({ name: "seed-tools", tools: [seedTool] }));
		let harness: Harness | undefined;
		try {
			harness = await Harness.open(storage, { models: routed, registry }, context);
			const root = await harness.root(context, {
				agent: { model: { provider: "p", modelId: "m" }, tools: [seedTool] },
			});
			const requests: { disableContinuation?: boolean; systems: number; tools: string[] }[] = [];
			prov.setResponses([
				fauxAssistantMessage("parent", { timestamp: 10_000 }),
				(ctx, opts) => {
					requests.push({
						disableContinuation: opts?.disableContinuation,
						systems: ctx.messages.filter((message) => message.role === "system").length,
						tools: getCurrentTools(ctx.messages).map((tool) => tool.name),
					});
					return fauxAssistantMessage("child", { timestamp: 20_000 });
				},
			]);
			await (await root.submit({ type: "input", content: "parent input" }, context)).wait(context);
			const rootEntries = await allEntries(root);
			const rootAgent = await harness.snapshot(AgentDoc, root.id, context);
			const rootProvider = await harness.snapshot(ProviderDoc, root.id, context);
			const at = rootEntries.findLast((entry) => AssistantEntry.is(entry))!.id;

			const child = await seedCheckpointedConversation(
				harness,
				root.id,
				at,
				{ ownership: { kind: "ownerless" }, taskPrompt: "seeded task", slidingWindow: false },
				context,
			);
			expect(child.id).not.toBe(ROOT_CONVERSATION_ID);
			expect((await storage.conversation(child.id, context))?.parent).toBeUndefined();
			expect((await allEntries(child)).filter((entry) => SystemEntry.is(entry))).toHaveLength(1);

			await (await child.submit({ type: "input", content: "turn one" }, context)).wait(context);
			expect(requests).toEqual([{ disableContinuation: true, systems: 1, tools: ["seed_tool"] }]);
			expect((await allEntries(child)).filter((entry) => SystemEntry.is(entry))).toHaveLength(1);
			expect(await allEntries(root)).toEqual(rootEntries);
			expect(await harness.snapshot(AgentDoc, root.id, context)).toEqual(rootAgent);
			expect(await harness.snapshot(ProviderDoc, root.id, context)).toEqual(rootProvider);
			expect(root.id).toBe(ROOT_CONVERSATION_ID);
		} finally {
			await harness?.close(context);
			await storage.close(context);
			await store.close(context);
			await sw.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("captures two-phase asOf state without read-after-write errors", async () => {
		const storage = new MemoryStorage();
		const { prov, models, registry } = setup(["m", "after"]);
		const beforeTool = defineTool({
			name: "before_tool",
			description: "Before",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		const afterTool = defineTool({
			name: "after_tool",
			description: "After",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		registry.install(defineExtension({ name: "tools", tools: [beforeTool, afterTool] }));
		prov.setResponses([fauxAssistantMessage("parent", { timestamp: 10_000 })]);
		const harness = await Harness.open(storage, { models, registry }, context);
		try {
			const root = await harness.root(context, {
				agent: {
					model: { provider: "p", modelId: "m" },
					thinkingLevel: "low",
					tools: [beforeTool],
					instructions: "before instructions",
					cwd: "/before",
				},
			});
			await root.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "p", modelId: "m" };
				const ledger = await tx.doc(SlidingWindowLedgerDoc, root.id);
				ledger.epoch = 2;
				ledger.turnCount = 3;
				ledger.filesRead.push({ path: "before.ts", lastTurn: 3 });
				const baton = await tx.doc(BatonStateDoc, root.id);
				baton.epoch = 4;
				baton.harvestedStudyNotes = "before notes";
			}, context);
			await (await root.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
			const at = (await allEntries(root)).findLast((entry) => AssistantEntry.is(entry))!.id;

			await root.configure(
				{
					model: { provider: "p", modelId: "after" },
					thinkingLevel: "high",
					tools: [afterTool],
					instructions: "after instructions",
					cwd: "/after",
				},
				context,
			);
			await root.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "p", modelId: "after" };
				const ledger = await tx.doc(SlidingWindowLedgerDoc, root.id);
				ledger.epoch = 90;
				ledger.turnCount = 91;
				ledger.filesRead = [{ path: "after.ts", lastTurn: 91 }];
				const baton = await tx.doc(BatonStateDoc, root.id);
				baton.epoch = 92;
				baton.harvestedStudyNotes = "after notes";
			}, context);

			let initialized = false;
			const child = await seedCheckpointedConversation(
				harness,
				root.id,
				at,
				{
					ownership: { kind: "ownerless" },
					taskPrompt: "asOf task",
					slidingWindow: false,
					init: async (tx, childId) => {
						const agent = await tx.doc(AgentDoc, childId);
						expect(agent.instructions).toBe("before instructions");
						(await tx.doc(ProviderDoc, childId)).sessionId = "from-init";
						initialized = true;
					},
				},
				context,
			);
			expect(initialized).toBe(true);
			expect(await harness.snapshot(AgentDoc, child.id, context)).toEqual({
				model: { provider: "p", modelId: "m" },
				thinkingLevel: "low",
				tools: ["before_tool"],
				instructions: "before instructions",
				cwd: "/before",
				compaction: { enabled: true },
			});
			expect(await harness.snapshot(SlidingWindowTargetDoc, child.id, context)).toEqual({
				target: { provider: "p", modelId: "m" },
			});
			expect(await harness.snapshot(SlidingWindowLedgerDoc, child.id, context)).toMatchObject({
				epoch: 2,
				turnCount: 3,
				filesRead: [{ path: "before.ts", lastTurn: 3 }],
			});
			expect(await harness.snapshot(BatonStateDoc, child.id, context)).toMatchObject({
				epoch: 0,
				harvestedStudyNotes: "before notes",
			});
			expect(await harness.snapshot(SlidingWindowStateDoc, child.id, context)).toEqual({ enabled: false });
			expect((await harness.snapshot(VirtualModelStateDoc, child.id, context))?.forkGuard).toMatchObject({
				disableContinuation: true,
				parentThinkingLevel: "low",
			});
			expect((await harness.snapshot(ProviderDoc, child.id, context))?.sessionId).toBe("from-init");

			const options = { ownership: { kind: "ownerless" }, taskPrompt: "invalid", slidingWindow: false } as const;
			await expect(
				seedCheckpointedConversation(harness, 999_999 as unknown as ConversationId, at, options, context),
			).rejects.toThrow("Conversation 999999 does not exist");
			await expect(
				seedCheckpointedConversation(harness, root.id, 999_999 as unknown as EntryId, options, context),
			).rejects.toThrow("Entry 999999 is not visible");
		} finally {
			await harness.close(context);
		}
	});

	it("honors explicit task and ownerless conversation ownership", async () => {
		{
			const storage = new MemoryStorage();
			const { prov, models, registry } = setup();
			let harness!: Harness;
			let parentId: ConversationId = ROOT_CONVERSATION_ID;
			let at = 0 as unknown as EntryId;
			let child: Conversation | undefined;
			let requestReached!: () => void;
			const reached = new Promise<void>((resolve) => {
				requestReached = resolve;
			});
			const SeedWave = defineTask<null, { phase: "seed" }, null>({
				name: "test.seed-wave-task-owned",
				version: 1,
				initial: () => ({ phase: "seed" }),
				phases: {
					seed: async (task, runtime, ctx) => {
						child = await seedCheckpointedConversation(
							harness,
							parentId,
							at,
							{
								ownership: { kind: "task", taskId: task.id },
								taskPrompt: "owned child",
								slidingWindow: false,
							},
							ctx,
						);
						await child.submit({ type: "input", content: "busy owned child" }, ctx);
						await aborted(runtime.signal).catch(() => {});
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "failed", error: { message: "aborted" } } }),
							ctx,
						);
					},
				},
				abort: async (_task, runtime, ctx) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
			});
			registry.install(defineExtension({ name: "seed-wave", tasks: [SeedWave] }));
			prov.setResponses([
				fauxAssistantMessage("parent"),
				(_ctx, opts) => {
					requestReached();
					return aborted(opts?.signal);
				},
			]);
			harness = await Harness.open(storage, { models, registry }, context);
			try {
				const parent = await harness.root(context, { agent: { model: { provider: "p", modelId: "m" } } });
				parentId = parent.id;
				await (await parent.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
				at = (await allEntries(parent)).findLast((entry) => AssistantEntry.is(entry))!.id;
				const wave: TaskId = await parent.commit(
					(tx) => tx.createTask(SeedWave, null, { ownership: { kind: "conversation" } }),
					context,
				);
				await reached;
				expect(child).toBeDefined();
				expect(await settled(parent.waitForIdle(context))).toBe(false);
				await parent.abort(context);
				expect((await harness.waitForTask(wave, context)).state.outcome.status).toBe("aborted");

				prov.setResponses([fauxAssistantMessage("manual answer")]);
				const manual = await child!.submit({ type: "input", content: "manual after wave" }, context);
				expect(await manual.wait(context)).toMatchObject({ status: "done" });
			} finally {
				await harness.close(context);
			}
		}

		{
			const { prov, models, registry } = setup();
			prov.setResponses([fauxAssistantMessage("parent")]);
			const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			try {
				const parent = await harness.root(context, { agent: { model: { provider: "p", modelId: "m" } } });
				await (await parent.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
				const at = (await allEntries(parent)).findLast((entry) => AssistantEntry.is(entry))!.id;
				const child = await seedCheckpointedConversation(
					harness,
					parent.id,
					at,
					{ ownership: { kind: "ownerless" }, taskPrompt: "ownerless child", slidingWindow: false },
					context,
				);
				prov.setResponses([
					async (_ctx, opts) => {
						await Promise.race([released, aborted(opts?.signal)]);
						return fauxAssistantMessage("released");
					},
				]);
				const running = await child.submit({ type: "input", content: "busy ownerless child" }, context);
				expect(await settled(running.wait(context))).toBe(false);
				await parent.waitForIdle(context);
				const allIdle = harness.waitForIdle(context);
				expect(await settled(allIdle)).toBe(false);
				await parent.abort(context);
				expect(await settled(running.wait(context))).toBe(false);
				release();
				expect(await running.wait(context)).toMatchObject({ status: "done" });
				await allIdle;
			} finally {
				release();
				await harness.close(context);
			}
		}
	});

	it("resets AgentDoc instead of leaking the coordinator agent state", async () => {
		const { prov, models, registry } = setup();
		const coordinatorTool = defineTool({
			name: "coordinator_tool",
			description: "Coordinator only",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		const childTool = defineTool({
			name: "child_tool",
			description: "Child only",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		const coordinatorExtension = defineExtension({ name: "coordinator", tools: [coordinatorTool] });
		registry.install(coordinatorExtension);
		registry.install(defineExtension({ name: "child", tools: [childTool] }));
		let harness!: Harness;
		let parentId: ConversationId = ROOT_CONVERSATION_ID;
		let at = 0 as unknown as EntryId;
		let explicitChild: Conversation | undefined;
		let defaultChild: Conversation | undefined;
		const SeedWave = defineTask<null, { phase: "seed" }, null>({
			name: "test.seed-wave-clean-agent",
			version: 1,
			initial: () => ({ phase: "seed" }),
			phases: {
				seed: async (task, runtime, ctx) => {
					explicitChild = await seedCheckpointedConversation(
						harness,
						parentId,
						at,
						{
							ownership: { kind: "task", taskId: task.id },
							taskPrompt: "explicit child",
							systemPrompt: "explicit instructions",
							tools: [childTool],
							modelTools: [childTool.name],
							extensions: ["child"],
							targetModel: { provider: "p", modelId: "m" },
							thinkingLevel: "medium",
							cwd: "/explicit-child",
							maxTurns: 7,
							compaction: { reserveTokens: 123 },
							slidingWindow: false,
						},
						ctx,
					);
					defaultChild = await seedCheckpointedConversation(
						harness,
						parentId,
						at,
						{
							ownership: { kind: "task", taskId: task.id },
							taskPrompt: "default child",
							slidingWindow: false,
						},
						ctx,
					);
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
						ctx,
					);
				},
			},
			abort: async (_task, runtime, ctx) =>
				runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
		});
		registry.install(defineExtension({ name: "seed-wave", tasks: [SeedWave] }));
		prov.setResponses([fauxAssistantMessage("parent")]);
		harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const coordinator = await harness.root(context, {
				agent: {
					instructions: "coordinator instructions",
					tools: [coordinatorTool],
					modelTools: [coordinatorTool],
					model: { provider: "p", modelId: "m" },
					thinkingLevel: "high",
					cwd: "/coordinator",
					compaction: { reserveTokens: 9_999 },
					extensions: [coordinatorExtension],
					maxTurns: 99,
				},
			});
			const parent = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "p", modelId: "m" }, tools: [] } },
				context,
			);
			parentId = parent.id;
			await (await parent.submit({ type: "input", content: "clean parent" }, context)).wait(context);
			at = (await allEntries(parent)).findLast((entry) => AssistantEntry.is(entry))!.id;
			const wave = await coordinator.commit(
				(tx) => tx.createTask(SeedWave, null, { ownership: { kind: "conversation" } }),
				context,
			);
			await harness.waitForTask(wave, context);

			expect(await harness.snapshot(AgentDoc, explicitChild!.id, context)).toEqual({
				instructions: "explicit instructions",
				tools: ["child_tool"],
				modelTools: ["child_tool"],
				extensions: ["child"],
				model: { provider: "p", modelId: "m" },
				thinkingLevel: "medium",
				cwd: "/explicit-child",
				maxTurns: 7,
				compaction: { reserveTokens: 123 },
			});
			expect(await harness.snapshot(AgentDoc, defaultChild!.id, context)).toEqual({
				tools: [],
				model: { provider: "p", modelId: "m" },
				thinkingLevel: "off",
				compaction: { enabled: true },
			});
		} finally {
			await harness.close(context);
		}
	});

	it("records checkpoint lineage provenance", async () => {
		const { prov, models, registry } = setup();
		const sw = createSlidingWindow({ target: models.getModel("p", "m")! });
		const routed = sw.wrapModels(models);
		registry.install(sw.extension);
		prov.setResponses([fauxAssistantMessage("parent", { timestamp: 10_000 })]);
		const storage = new MemoryStorage();
		const harness = await Harness.open(storage, { models: routed, registry }, context);
		try {
			const parent = await harness.root(context, { agent: { model: { provider: "p", modelId: "m" } } });
			await (await parent.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
			const at = (await allEntries(parent)).findLast((entry) => AssistantEntry.is(entry))!.id;
			const entryRec = await storage.entry(parent.id, at, context);
			const child = await seedCheckpointedConversation(
				harness,
				parent.id,
				at,
				{
					ownership: { kind: "ownerless" },
					taskPrompt: "lineage",
					sliceId: "slice-7",
					allowedPaths: ["src/a.ts", "src/b.ts"],
					slidingWindow: false,
				},
				context,
			);
			expect(await harness.snapshot(CheckpointLineageDoc, child.id, context)).toEqual({
				parentConversationId: parent.id,
				atEntryId: at,
				atSeq: entryRec!.commitSeq,
				sliceId: "slice-7",
				allowedPaths: ["src/a.ts", "src/b.ts"],
			});
		} finally {
			await harness.close(context);
			await sw.close();
		}
	});

	it("seeds through the standalone readCheckpoint plan/apply pipeline", async () => {
		const storage = new MemoryStorage();
		const { prov, models, registry } = setup();
		const seedTool = defineTool({
			name: "pipeline_tool",
			description: "Pipeline",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		registry.install(defineExtension({ name: "pipeline-tools", tools: [seedTool] }));
		prov.setResponses([fauxAssistantMessage("parent", { timestamp: 10_000 })]);
		const harness = await Harness.open(storage, { models, registry }, context);
		try {
			const root = await harness.root(context, {
				agent: {
					model: { provider: "p", modelId: "m" },
					tools: [seedTool],
					instructions: "pipeline instructions",
				},
			});
			await (await root.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
			const at = (await allEntries(root)).findLast((entry) => AssistantEntry.is(entry))!.id;

			const checkpoint = await harness.readCheckpoint(root.id, at, context);
			const entryRec = await storage.entry(root.id, at, context);
			const docs = await readParentCheckpointDocs(storage, root.id, entryRec, context);
			expect(docs.agentState?.instructions).toBe("pipeline instructions");

			const plan = buildCheckpointedSeedPlan({
				view: checkpoint.view,
				parentAgent: checkpoint.agent,
				parentAgentState: docs.agentState,
				parentBaton: docs.baton,
				parentLedger: docs.ledger,
				parentVmState: docs.vmState,
				parentTarget: docs.target,
				parentSessionId: docs.providerSessionId,
				lineage: {
					parentConversationId: root.id,
					atEntryId: at,
					atSeq: checkpoint.commitSeq,
				},
				models: checkpoint.models,
				registry: checkpoint.registry,
				settings: checkpoint.settings,
				taskPrompt: "pipeline task",
				slidingWindow: false,
			});
			expect(plan.atTimestamp).toBe(10_000);
			expect(plan.slidingWindowEnabled).toBe(false);
			expect(plan.system.sections?.instructions).toContain("pipeline instructions");

			const child = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					init: (tx, childId) => applyCheckpointedSeed(tx, childId, plan),
				},
				context,
			);
			expect(await harness.snapshot(AgentDoc, child.id, context)).toEqual({
				instructions: "pipeline instructions",
				tools: ["pipeline_tool"],
				model: { provider: "p", modelId: "m" },
				thinkingLevel: "off",
				compaction: { enabled: true },
			});
			const childEntries = await allEntries(child);
			expect(childEntries.filter((entry) => SystemEntry.is(entry))).toHaveLength(1);
			const user = childEntries.find((entry) => UserEntry.is(entry))!;
			expect(user.model?.[0]).toMatchObject({ role: "user", content: "pipeline task" });
			expect(await harness.snapshot(CheckpointLineageDoc, child.id, context)).toEqual({
				parentConversationId: root.id,
				atEntryId: at,
				atSeq: checkpoint.commitSeq,
			});
		} finally {
			await harness.close(context);
		}
	});
});

describe("exportCheckpointedForkToStorage", () => {
	it("exports frozen checkpoint entries and documents into an isolated storage", async () => {
		const { prov, models, registry } = setup();
		const exportTool = defineTool({
			name: "export_tool",
			description: "Exported",
			parameters: obj({}),
			execute: async () => ({ output: [] }),
		});
		registry.install(defineExtension({ name: "export-tools", tools: [exportTool] }));
		prov.setResponses([fauxAssistantMessage("parent", { timestamp: 10_000 })]);
		const parentStorage = new MemoryStorage();
		const harness = await Harness.open(parentStorage, { models, registry }, context);
		const targetStorage = new MemoryStorage();
		try {
			const parent = await harness.root(context, {
				agent: {
					model: { provider: "p", modelId: "m" },
					tools: [exportTool],
					instructions: "parent instructions",
				},
			});
			await (await parent.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
			const parentEntries = await allEntries(parent);
			const at = parentEntries.findLast((entry) => AssistantEntry.is(entry))!.id;

			const result = await exportCheckpointedForkToStorage(
				{
					parent,
					parentStorage,
					at,
					targetStorage,
					models,
					registry,
					systemPrompt: "export instructions",
					taskPrompt: "export task",
					slidingWindow: false,
				},
				context,
			);
			expect(result.conversationId).toBe(ROOT_CONVERSATION_ID);
			expect(result.atTimestamp).toBe(10_000);
			expect(result.anchorTimestamp).toBeGreaterThan(0);

			// The target storage stays open (closeTargetStorage defaults to false).
			const childHarness = await Harness.open(targetStorage, { models, registry }, context);
			try {
				const child = await childHarness.root(context);
				expect(child.id).toBe(result.conversationId);
				const entries = await allEntries(child);
				const systems = entries.filter((entry) => SystemEntry.is(entry));
				expect(systems).toHaveLength(1);
				const system = systems[0]!.model?.find((m): m is SystemMessage => m.role === "system");
				expect(system?.sections?.instructions).toContain("export instructions");
				expect(system?.toolsAdded?.map((tool) => tool.name)).toEqual(["export_tool"]);
				const user = entries.find((entry) => UserEntry.is(entry))!.model?.[0];
				expect(user).toMatchObject({ role: "user", content: "export task", timestamp: result.anchorTimestamp });
				const assistant = entries.find((entry) => AssistantEntry.is(entry))!.model?.[0];
				expect(assistant).toMatchObject({ role: "assistant", timestamp: 10_000 });
				expect(await childHarness.snapshot(AgentDoc, child.id, context)).toMatchObject({
					instructions: "export instructions",
					tools: ["export_tool"],
					compaction: { enabled: true },
				});
				expect(await childHarness.snapshot(SlidingWindowStateDoc, child.id, context)).toEqual({ enabled: false });
				expect((await childHarness.snapshot(VirtualModelStateDoc, child.id, context))?.forkGuard).toMatchObject({
					disableContinuation: true,
				});
			} finally {
				await childHarness.close(context);
			}
			expect(await allEntries(parent)).toEqual(parentEntries);
		} finally {
			await harness.close(context);
			await targetStorage.close(context);
		}
	});

	it("falls back to parent harness snapshots without parent storage", async () => {
		const { prov, models, registry } = setup();
		prov.setResponses([fauxAssistantMessage("parent", { timestamp: 10_000 })]);
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const targetStorage = new MemoryStorage();
		try {
			const parent = await harness.root(context, { agent: { model: { provider: "p", modelId: "m" } } });
			await parent.commit(async (tx) => {
				const baton = await tx.doc(BatonStateDoc, parent.id);
				baton.harvestedStudyNotes = "snapshot notes";
			}, context);
			await (await parent.submit({ type: "input", content: "checkpoint" }, context)).wait(context);
			const at = (await allEntries(parent)).findLast((entry) => AssistantEntry.is(entry))!.id;

			const result = await exportCheckpointedForkToStorage(
				{
					parent,
					parentHarness: harness,
					at,
					targetStorage,
					models,
					registry,
					systemPrompt: "fallback instructions",
					taskPrompt: "fallback task",
					slidingWindow: false,
				},
				context,
			);
			expect(result.studyNotes).toBe("snapshot notes");

			const childHarness = await Harness.open(targetStorage, { models, registry }, context);
			try {
				const child = await childHarness.root(context);
				expect(await childHarness.snapshot(BatonStateDoc, child.id, context)).toMatchObject({
					epoch: 0,
					harvestedStudyNotes: "snapshot notes",
				});
				const assistant = (await allEntries(child)).find((entry) => AssistantEntry.is(entry))!.model?.[0];
				expect(assistant?.content).toEqual([
					{
						type: "text",
						text: "snapshot notes\n\nCheckpoint exported. Executing scoped task directly on hydrated context.",
					},
				]);
			} finally {
				await childHarness.close(context);
			}
		} finally {
			await harness.close(context);
			await targetStorage.close(context);
		}
	});
});
