/**
 * The `recall` tool: reads lines or searches inside a spilled tool output by its `ref:<hash>`.
 *
 * Extracted from the inline `defineTool` block that lived in
 * `packages/durable/src/harness/sliding-window.ts`, taking the two pieces of state it closed
 * over (`getStore()` and `options.cwd`) through `SlidingWindowState` instead.
 */
import { AgentDoc, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import type { SlidingWindowState } from "./state.ts";

export function createRecallTool(state: SlidingWindowState): ToolRegistration {
	return defineTool({
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
		async execute(args, api, ctx) {
			const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
			const effectiveCwd = agentState?.cwd ?? state.options.cwd;
			const r = await state.getStore().recall({ ...args, ...(effectiveCwd ? { cwd: effectiveCwd } : {}) });
			return { output: [{ type: "text", text: r.text }] };
		},
	});
}
