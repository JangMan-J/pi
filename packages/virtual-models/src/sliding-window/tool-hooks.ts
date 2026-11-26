/**
 * `ToolTask` hooks for the sliding-window runtime, extracted from pi-durable's sliding-window harness so
 * `@earendil-works/pi-virtual-models/sliding-window` stands alone: fork-guard enforcement before the call,
 * artifact spill + stage eviction + mechanical-ledger dirty tracking after it.
 */
import { AgentDoc, type ToolHooks } from "@earendil-works/pi-durable";
import { VirtualModelStateDoc } from "../durable/docs.ts";
import { recordToolResult } from "./ledger.ts";
import { spillToolOutput } from "./spill.ts";
import type { SlidingWindowState } from "./state.ts";
import { blockText } from "./turns.ts";

/**
 * Fork-guard enforcement (`beforeTool`) and pre-commit spill, stage eviction, and ledger recording (`afterTool`),
 * driven by the caller's `SlidingWindowState` collaborator (`conv`, `hydrate`, `isEnabled`, `getStore`, config).
 */
export function createSlidingWindowToolHooks(state: SlidingWindowState): ToolHooks {
	return {
		beforeTool: async (call, api, ctx) => {
			const guard = (await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx))?.forkGuard;
			if (guard?.allowedTools && !guard.allowedTools.includes(call.name)) {
				return { block: guard.blockedToolReason ?? `Tool ${call.name} is blocked on this fork` };
			}
			return undefined;
		},
		afterTool: async (call, result, api, ctx) => {
			const c = state.conv(String(api.conversationId));
			await state.hydrate(c, api, ctx);
			if (!state.isEnabled(api.conversationId, c)) return undefined;
			if (call.name === "recall" || call.parent !== undefined) return undefined;

			const args = (call.arguments ?? {}) as Record<string, unknown>;
			const raw = blockText(result.output);
			const path =
				typeof args.path === "string"
					? args.path
					: typeof args.file_path === "string"
						? args.file_path
						: typeof args.filePath === "string"
							? args.filePath
							: undefined;
			const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
			const effectiveCwd = agentState?.cwd ?? state.options.cwd;
			const canStageSlices = state.isSlidingWindowRef(agentState?.model);

			const isError = result.isError === true;
			if ((call.name === "edit" || call.name === "write") && !isError && path) {
				c.stage.evict(path, effectiveCwd);
			}

			const spill = await spillToolOutput({
				toolName: call.name,
				input: args,
				rawText: raw,
				isError,
				...(effectiveCwd ? { cwd: effectiveCwd } : {}),
				...(result.details !== undefined ? { details: result.details } : {}),
				config: state.config,
				store: () => state.getStore(),
				stage: c.stage,
				canStageSlices,
				...(state.options.previewToolOutput ? { previewToolOutput: state.options.previewToolOutput } : {}),
			});
			c.ledger = recordToolResult(c.ledger, call.name, args, {
				isError,
				...(spill ? { spilled: spill.meta } : {}),
				...(isError ? { errorText: raw } : {}),
			});
			c.ledgerDirty = true;
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
					slidingWindow: {
						ref: spill.meta.ref,
						bytes: spill.meta.byteLen,
						lines: spill.meta.lineCount,
						...(spill.meta.sourceSha256 ? { sourceSha256: spill.meta.sourceSha256 } : {}),
					},
				},
			};
		},
	};
}
