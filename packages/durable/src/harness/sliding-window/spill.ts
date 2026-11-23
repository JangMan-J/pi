import { utf8ByteLength } from "@earendil-works/chord/output";
import { isReadToolName, spillThresholdForTool } from "./bounds.ts";
import { buildMechanicalPreview } from "./preview.ts";
import type { EphemeralSliceStage } from "./staging.ts";
import type {
	ArtifactMeta,
	SlidingWindowArtifactStore,
	SlidingWindowConfig,
	SlidingWindowPreviewContext,
} from "./types.ts";

/** Tools whose output is already a bounded slice of a spilled artifact. */
export const SPILL_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["recall"]);

export interface SpillInput {
	readonly toolName: string;
	readonly input?: Record<string, unknown>;
	readonly rawText: string;
	readonly isError: boolean;
	readonly cwd?: string;
	readonly config: SlidingWindowConfig;
	/** Called only once an output is over its threshold, so the store opens on the first real spill. */
	readonly store: () => SlidingWindowArtifactStore;
	readonly stage: EphemeralSliceStage;
	readonly previewToolOutput?: (ctx: SlidingWindowPreviewContext) => string | undefined | Promise<string | undefined>;
}

export interface SpillOutput {
	/** What replaces the output in history. */
	readonly previewText: string;
	readonly meta: ArtifactMeta;
	/** The full text rides ModelRoute.ephemeralTail for the next turns. */
	readonly staged: boolean;
}

/**
 * Pre-commit spill: over the per-tool threshold the full output goes to the content-addressed store and a
 * short mechanical (or caller-provided) preview + ref replaces it. An un-edited read is staged so the model
 * can edit from the exact text next turn without a recall round-trip.
 */
export async function spillToolOutput(i: SpillInput): Promise<SpillOutput | undefined> {
	if (!i.config.spillEnabled || SPILL_EXEMPT_TOOLS.has(i.toolName) || i.rawText.length === 0) return undefined;
	if (utf8ByteLength(i.rawText) <= spillThresholdForTool(i.toolName, i.config)) return undefined;

	const path =
		typeof i.input?.path === "string"
			? i.input.path
			: typeof i.input?.file_path === "string"
				? i.input.file_path
				: undefined;
	const isRead = isReadToolName(i.toolName);
	const meta = await i.store().put(i.rawText, {
		toolName: i.toolName,
		...(isRead && path ? { sourcePath: path, ...(i.cwd ? { cwd: i.cwd } : {}) } : {}),
	});
	const staged =
		isRead && !i.isError && i.config.stageReadSlices && path
			? i.stage.stage({ path, ...(i.cwd ? { cwd: i.cwd } : {}), ref: meta.ref, text: i.rawText })
			: false;
	const customPreview = i.previewToolOutput
		? await i.previewToolOutput({
				toolName: i.toolName,
				input: i.input ?? {},
				rawText: i.rawText,
				isError: i.isError,
				meta,
				stagedInEphemeralTail: staged,
			})
		: undefined;
	const previewText =
		customPreview ??
		buildMechanicalPreview({
			toolName: i.toolName,
			rawText: i.rawText,
			meta,
			isError: i.isError,
			stagedInEphemeralTail: staged,
		});
	return { previewText, meta, staged };
}
