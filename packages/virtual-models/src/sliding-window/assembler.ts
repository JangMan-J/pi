import type { Models } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import { isVirtualModelsRuntime, withVirtualModelRouting } from "../core/runtime.ts";
import type { VirtualModels } from "../core/types.ts";
import {
	assistantText,
	type BatonModelResolution,
	type CompleteFn,
	type ModelLookup,
	resolveBatonModel,
	runBatonSynthesis,
} from "./baton.ts";
import { type BatonLifecycle, createBatonLifecycle } from "./baton-lifecycle.ts";
import {
	DEFAULT_BATON_MAX_TOKENS,
	DEFAULT_BATON_MODEL,
	DEFAULT_HARD_CEILING_RATIO,
	DEFAULT_HARD_CEILING_TOKENS,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_MAX_STAGE_BYTES,
	DEFAULT_READ_SPILL_THRESHOLD_BYTES,
	DEFAULT_SEARCH_SPILL_THRESHOLD_BYTES,
	DEFAULT_SLICE_TTL_TURNS,
	DEFAULT_SLIDING_WINDOW_CONFIG,
	DEFAULT_SOFT_CEILING_RATIO,
	DEFAULT_SOFT_CEILING_TOKENS,
	DEFAULT_SPILL_THRESHOLD_BYTES,
	effectiveWindowBounds,
	formatBytes,
	formatTokens,
	isReadToolName,
	isSearchToolName,
	normalizeSlidingWindowConfig,
	parseTokenCount,
	spillThresholdForTool,
} from "./bounds.ts";
import { calibrationRatio, projectSwapTokens, swapErrorPct } from "./fit.ts";
import { createSlidingWindowFork } from "./fork.ts";
import {
	type ExportCheckpointedForkResult,
	type ExportCheckpointedForkStorageOptions,
	exportCheckpointedForkToStorage,
} from "./fork-export.ts";
import {
	buildBatonPrompts,
	buildProseTranscript,
	createEmptyLedger,
	fallbackProse,
	reconstructLedgerFromView,
	recordToolResult,
	renderBatonSummary,
	renderLedgerBlock,
} from "./ledger.ts";
import {
	createLayeredArtifactStore,
	MemorySlidingWindowArtifactStore,
	normalizeRefId,
	portableSha256Hex,
} from "./memory-store.ts";
import { buildMechanicalPreview, extractSymbolOutline } from "./preview.ts";
import { createRecallTool } from "./recall-tool.ts";
import { createSlidingWindowVirtualModel } from "./router.ts";
import {
	applyCheckpointedSeed,
	buildCheckpointedSeedPlan,
	type CheckpointedSeedParams,
	type CheckpointedSeedPlan,
	type ParentCheckpointDocs,
	readParentCheckpointDocs,
	seedCheckpointedConversation,
} from "./seed-plan.ts";
import { SPILL_EXEMPT_TOOLS, type SpillInput, type SpillOutput, spillToolOutput } from "./spill.ts";
import { EphemeralSliceStage, normalizeSliceKey } from "./staging.ts";
import {
	CheckpointLineageDoc,
	createSlidingWindowState,
	DEFAULT_SLIDING_WINDOW_MODEL_ID,
	DEFAULT_SLIDING_WINDOW_PROVIDER,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
} from "./state.ts";
import { createSlidingWindowToolHooks } from "./tool-hooks.ts";
import { blockText, chooseKeepFrom, estimateTextTokens, selectCut, turnFromMessages, viewTurns } from "./turns.ts";
import type { SlidingWindowHandle, SlidingWindowOptions } from "./types.ts";

export {
	applyCheckpointedSeed,
	assistantText,
	type BatonLifecycle,
	type BatonModelResolution,
	blockText,
	buildBatonPrompts,
	buildCheckpointedSeedPlan,
	buildMechanicalPreview,
	buildProseTranscript,
	calibrationRatio,
	type CheckpointedSeedParams,
	type CheckpointedSeedPlan,
	CheckpointLineageDoc,
	chooseKeepFrom,
	type CompleteFn,
	createEmptyLedger,
	createLayeredArtifactStore,
	createSlidingWindowFork,
	DEFAULT_BATON_MAX_TOKENS,
	DEFAULT_BATON_MODEL,
	DEFAULT_HARD_CEILING_RATIO,
	DEFAULT_HARD_CEILING_TOKENS,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_MAX_STAGE_BYTES,
	DEFAULT_READ_SPILL_THRESHOLD_BYTES,
	DEFAULT_SEARCH_SPILL_THRESHOLD_BYTES,
	DEFAULT_SLICE_TTL_TURNS,
	DEFAULT_SLIDING_WINDOW_CONFIG,
	DEFAULT_SLIDING_WINDOW_MODEL_ID,
	DEFAULT_SLIDING_WINDOW_PROVIDER,
	DEFAULT_SOFT_CEILING_RATIO,
	DEFAULT_SOFT_CEILING_TOKENS,
	DEFAULT_SPILL_THRESHOLD_BYTES,
	effectiveWindowBounds,
	EphemeralSliceStage,
	estimateTextTokens,
	type ExportCheckpointedForkResult,
	type ExportCheckpointedForkStorageOptions,
	exportCheckpointedForkToStorage,
	extractSymbolOutline,
	fallbackProse,
	formatBytes,
	formatTokens,
	isReadToolName,
	isSearchToolName,
	MemorySlidingWindowArtifactStore,
	type ModelLookup,
	normalizeRefId,
	normalizeSliceKey,
	normalizeSlidingWindowConfig,
	type ParentCheckpointDocs,
	parseTokenCount,
	portableSha256Hex,
	projectSwapTokens,
	readParentCheckpointDocs,
	reconstructLedgerFromView,
	recordToolResult,
	renderBatonSummary,
	renderLedgerBlock,
	resolveBatonModel,
	runBatonSynthesis,
	seedCheckpointedConversation,
	selectCut,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
	SPILL_EXEMPT_TOOLS,
	type SpillInput,
	type SpillOutput,
	spillThresholdForTool,
	spillToolOutput,
	swapErrorPct,
	turnFromMessages,
	viewTurns,
};
export * from "./types.ts";

export function createSlidingWindow(options: SlidingWindowOptions = {}): SlidingWindowHandle {
	const state = createSlidingWindowState(options);
	const recallTool = createRecallTool(state);
	const virtualModel = createSlidingWindowVirtualModel(state);
	const lifecycle = createBatonLifecycle(state);
	const extension = defineExtension({
		name: options.extensionName ?? "pi.sliding-window",
		tools: [recallTool],
		tasks: lifecycle.tasks,
		hooks: [hook(ToolTask, createSlidingWindowToolHooks(state)), hook(GenerationTask, lifecycle.hooks)],
	});
	return {
		extension,
		recallTool,
		virtualModel,
		selection: { provider: state.vProvider, modelId: state.vId },
		wrapModels<TModels extends Models>(models: TModels): VirtualModels {
			if (isVirtualModelsRuntime(models)) {
				models.registerVirtualModel(virtualModel);
				state.setBoundModels(models);
				return models;
			}
			const wrapped = withVirtualModelRouting(models, { models: [virtualModel] });
			state.setBoundModels(wrapped);
			return wrapped;
		},
		inspect: (conversationId) => state.inspect(conversationId),
		setEnabled: (enabled, conversationId) => state.setEnabled(enabled, conversationId),
		release: (conversationId) => state.release(conversationId),
		close: () => state.close(),
	};
}
