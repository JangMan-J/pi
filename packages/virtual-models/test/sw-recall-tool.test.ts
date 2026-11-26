import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { createRecallTool } from "../src/sliding-window/recall-tool.ts";
import type { SlidingWindowState } from "../src/sliding-window/state.ts";
import type { RecallOptions, SlidingWindowArtifactStore } from "../src/sliding-window/types.ts";

const RECALL_TOOL_SOURCE = fileURLToPath(new URL("../src/sliding-window/recall-tool.ts", import.meta.url));

type RecallCall = RecallOptions;

const AGENT_CWD = "/agent/dir";
const LAUNCH_CWD = "/launch/dir";

function context(): Context {
	return {} as Context;
}

/** A store that records every recall request and answers with a fixed text. */
function recordingStore(text = "recalled output"): { store: SlidingWindowArtifactStore; calls: RecallCall[] } {
	const calls: RecallCall[] = [];
	const store = {
		recall(options: RecallOptions) {
			calls.push(options);
			return { text };
		},
	} as unknown as SlidingWindowArtifactStore;
	return { store, calls };
}

function state(options: { cwd?: string; store: SlidingWindowArtifactStore }): SlidingWindowState {
	return {
		options: options.cwd === undefined ? {} : { cwd: options.cwd },
		getStore: () => options.store,
	} as unknown as SlidingWindowState;
}

function api(agentCwd: string | undefined): ToolExecutionApi {
	return {
		conversationId: 1,
		snapshot: async () => (agentCwd === undefined ? undefined : { cwd: agentCwd }),
	} as unknown as ToolExecutionApi;
}

describe("recall tool module self-sufficiency", () => {
	test("imports nothing from the legacy virtual-models subpaths", () => {
		const source = readFileSync(RECALL_TOOL_SOURCE, "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
	});
});

describe("createRecallTool metadata", () => {
	test("registers a safe, model-and-tools `recall` tool with the documented parameters", () => {
		const { store } = recordingStore();
		const tool = createRecallTool(state({ store }));

		expect(tool.name).toBe("recall");
		expect(tool.replay).toBe("safe");
		expect(tool.callers).toEqual(["model", "tools"]);
		expect(tool.description).toMatch(/ref:<hash>/);
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				ref: { type: "string" },
				startLine: { type: "integer", minimum: 1 },
				endLine: { type: "integer", minimum: 1 },
				query: { type: "string" },
				contextLines: { type: "integer", minimum: 0, maximum: 30 },
			},
		});
	});
});

describe("createRecallTool execute", () => {
	test("returns the store text as a single text block", async () => {
		const { store } = recordingStore("the recalled slice");
		const tool = createRecallTool(state({ store }));

		await expect(tool.execute({ ref: "ref:abc" }, api(AGENT_CWD), context())).resolves.toEqual({
			output: [{ type: "text", text: "the recalled slice" }],
		});
	});

	test("prefers AgentDoc.cwd over the launch cwd", async () => {
		const { store, calls } = recordingStore();
		const tool = createRecallTool(state({ cwd: LAUNCH_CWD, store }));

		await tool.execute({ ref: "ref:abc" }, api(AGENT_CWD), context());

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ ref: "ref:abc", cwd: AGENT_CWD });
	});

	test("falls back to the configured cwd when the agent document has none", async () => {
		const { store, calls } = recordingStore();
		const tool = createRecallTool(state({ cwd: LAUNCH_CWD, store }));

		await tool.execute({ ref: "ref:abc" }, api(undefined), context());

		expect(calls[0]).toMatchObject({ ref: "ref:abc", cwd: LAUNCH_CWD });
	});

	test("omits cwd entirely when neither source provides one", async () => {
		const { store, calls } = recordingStore();
		const tool = createRecallTool(state({ store }));

		await tool.execute({ ref: "ref:abc" }, api(undefined), context());

		expect(calls[0]).not.toHaveProperty("cwd");
	});

	test("forwards range and query arguments verbatim", async () => {
		const { store, calls } = recordingStore();
		const tool = createRecallTool(state({ store }));

		await tool.execute(
			{ ref: "ref:xyz", startLine: 10, endLine: 20, query: "needle", contextLines: 3 },
			api(AGENT_CWD),
			context(),
		);

		expect(calls[0]).toEqual({
			ref: "ref:xyz",
			startLine: 10,
			endLine: 20,
			query: "needle",
			contextLines: 3,
			cwd: AGENT_CWD,
		});
	});

	test("propagates store failures instead of returning empty output", async () => {
		const store = {
			recall: () => {
				throw new Error("store exploded");
			},
		} as unknown as SlidingWindowArtifactStore;
		const tool = createRecallTool(state({ store }));

		await expect(tool.execute({ ref: "ref:abc" }, api(AGENT_CWD), context())).rejects.toThrow("store exploded");
	});
});
