import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { readFile } from "node:fs/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	AssistantEntry,
	type Conversation,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	hook,
	MemoryStorage,
	type Registry,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { VirtualModelStateDoc } from "../src/durable/docs.ts";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { createSlidingWindowToolHooks } from "../src/sliding-window/tool-hooks.ts";
import { EphemeralSliceStage } from "../src/sliding-window/staging.ts";
import { MemorySlidingWindowArtifactStore } from "../src/sliding-window/memory-store.ts";
import { createEmptyLedger } from "../src/sliding-window/ledger.ts";
import { normalizeSlidingWindowConfig } from "../src/sliding-window/bounds.ts";
import type { ConvState, SlidingWindowState } from "../src/sliding-window/state.ts";
import type { MechanicalLedger } from "../src/sliding-window/types.ts";

const context: Context = BACKGROUND_CONTEXT;

/** Raw entries of a conversation, oldest first. */
async function allEntries(conversation: Conversation, callContext: Context = context) {
	const page = await conversation.entries({}, 1000, undefined, callContext);
	return [...page.items].reverse();
}

/** Text of the first text content of a message. */
function textOf(message: { role: string; content: unknown } | undefined): string | undefined {
	if (message === undefined || message.role === "system") return undefined;
	if (typeof message.content === "string") return message.content;
	const text = (message.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
	return text?.type === "text" ? text.text : undefined;
}

/** One `ConvState` the hooks can drive; `hydrated` pre-set so the no-op hydrate is honest. */
function makeConvState(): ConvState {
	return {
		hydrated: true,
		ledger: createEmptyLedger(),
		ledgerDirty: false,
		stage: new EphemeralSliceStage({ maxTotalBytes: 49_152, ttlTurns: 2 }),
		pendingHydratedPaths: [],
		awaitingFirstResponse: false,
		note: "",
	} as ConvState;
}

/** A minimal `SlidingWindowState` collaborator over one fixed `ConvState` and one in-memory artifact store. */
function makeState(
	c: ConvState,
	opts: { enabled?: boolean; canStageSlices?: boolean; cwd?: string } = {},
): SlidingWindowState {
	const store = new MemorySlidingWindowArtifactStore();
	const config = normalizeSlidingWindowConfig({
		spillThresholdBytes: 64,
		readSpillThresholdBytes: 64,
		searchSpillThresholdBytes: 64,
	});
	return {
		options: { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) },
		config,
		vProvider: "sliding-window",
		vId: "active",
		vName: "Sliding Window",
		staticTarget: undefined,
		states: new Map(),
		routedRequestMeta: new WeakMap(),
		boundModels: undefined,
		setBoundModels() {},
		getStore: () => store,
		conv: () => c,
		isEnabled: () => opts.enabled ?? true,
		isSlidingWindowRef: () => opts.canStageSlices ?? false,
		resolveTarget: () => undefined,
		resolveTargetModel: () => undefined,
		hydrate: async () => {},
		commitPendingConvDocs: async () => {},
		inspect: () => {
			throw new Error("inspect is not exercised by tool-hook tests");
		},
		setEnabled() {},
		release() {},
		close: async () => {},
	} as SlidingWindowState;
}

/** Install the extracted hooks on a registry, exactly as the sliding-window extension does. */
function installHooks(registry: Registry, state: SlidingWindowState): void {
	registry.install(defineExtension({ name: "test.sw-hooks", hooks: [hook(ToolTask, createSlidingWindowToolHooks(state))] }));
}

function bigText(prefix: string, bytes = 4_000): string {
	return prefix + "x".repeat(bytes);
}

describe("sliding-window tool hooks", () => {
	it("keeps the extracted tool-hooks source free of legacy re-export imports", async () => {
		const text = await readFile(new URL("../src/sliding-window/tool-hooks.ts", import.meta.url), "utf8");
		expect(text).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
		expect(text).not.toMatch(/from "node:/);
	});

	it("blocks tools outside a guarded fork's allowedTools in beforeTool", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const c = makeConvState();
		const state = makeState(c);
		const registry = createRegistry();
		installHooks(registry, state);
		registry.install(
			defineExtension({
				name: "app-tools",
				tools: [
					defineTool({
						name: "web_search",
						description: "Search the web",
						parameters: obj({ query: str() }),
						execute: async () => ({ output: [{ type: "text", text: "should not run" }] }),
					}),
				],
			}),
		);

		prov.setResponses([
			fauxAssistantMessage([fauxToolCall("web_search", { query: "secret" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Done after block."),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "anthropic", modelId: "claude-sonnet" } },
		});
		await root.commit(async (tx) => {
			(await tx.doc(VirtualModelStateDoc, root.id)).forkGuard = {
				disableContinuation: true,
				preserveToolDeclarations: true,
				allowedTools: ["read"],
				blockedToolReason: "web_search is disabled on guarded fork",
			};
		}, context);

		await (await root.submit({ type: "input", content: "Search something" }, context)).wait(context);
		await root.waitForIdle(context);

		const toolEntries = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		expect(textOf(toolEntries[0]?.model?.[0])).toContain("web_search is disabled on guarded fork");

		await harness.close(context);
	});

	it("spills oversized read output to a receipt, records the ledger, and stages the slice when the model routes through sliding-window", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const c = makeConvState();
		const state = makeState(c, { canStageSlices: true, cwd: "/repo" });
		const registry = createRegistry();
		installHooks(registry, state);
		registry.install(
			defineExtension({
				name: "app-tools",
				tools: [
					defineTool({
						name: "read",
						description: "Read a file",
						parameters: obj({ path: str() }),
						execute: async () => ({ output: [{ type: "text", text: bigText("file body ") }] }),
					}),
				],
			}),
		);

		prov.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/big.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Got the receipt."),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "anthropic", modelId: "claude-sonnet" }, cwd: "/repo" },
		});

		await (await root.submit({ type: "input", content: "Read the big file" }, context)).wait(context);
		await root.waitForIdle(context);

		const raw = bigText("file body ");
		const toolEntries = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		const committed = textOf(toolEntries[0]?.model?.[0]) ?? "";
		expect(committed.length).toBeLessThan(raw.length);
		expect(committed).not.toBe(raw);

		const ledger: MechanicalLedger = c.ledger;
		expect(c.ledgerDirty).toBe(true);
		const read = ledger.filesRead.find((r) => r.path === "src/big.ts");
		expect(read?.ref).toBeDefined();
		expect(read?.sha256).toBeDefined();

		const staged = c.stage.list();
		expect(staged).toHaveLength(1);
		expect(staged[0]!.path).toBe("src/big.ts");
		expect(staged[0]!.ref).toBe(read?.ref);
		expect(state.getStore().readFullText?.(read!.ref!)).toBe(raw);

		await harness.close(context);
	});

	it("evicts a staged slice for a path on successful edit and keeps it on error", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const c = makeConvState();
		c.stage.stage({ path: "src/live.ts", cwd: "/repo", ref: "sha256:stale", text: "staged verbatim text" });
		const state = makeState(c, { cwd: "/repo" });
		let failNext = false;
		const registry = createRegistry();
		installHooks(registry, state);
		registry.install(
			defineExtension({
				name: "app-tools",
				tools: [
					defineTool({
						name: "edit",
						description: "Edit a file",
						parameters: obj({ path: str() }),
						execute: async () => {
							if (failNext) {
								failNext = false;
								return { isError: true, output: [{ type: "text", text: "edit refused" }] };
							}
							return { output: [{ type: "text", text: "Edited src/live.ts" }] };
						},
					}),
				],
			}),
		);

		prov.setResponses([
			fauxAssistantMessage("First, a failing edit."),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/live.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/live.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Edited for real."),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: { provider: "anthropic", modelId: "claude-sonnet" }, cwd: "/repo" },
		});

		// First run: the edit fails, so the staged slice must survive.
		failNext = true;
		await (await root.submit({ type: "input", content: "Try an edit" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(c.stage.list()).toHaveLength(1);
		expect(c.ledger.filesEdited).toHaveLength(0);

		// Second run: the edit succeeds, so the stale staged slice is evicted and the ledger records the edit.
		await (await root.submit({ type: "input", content: "Edit again" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(c.stage.list()).toHaveLength(0);
		expect(c.ledgerDirty).toBe(true);
		expect(c.ledger.filesEdited.map((e) => e.path)).toEqual(["src/live.ts"]);

		await harness.close(context);
	});
});
