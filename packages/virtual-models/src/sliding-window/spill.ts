import { utf8ByteLength } from "@earendil-works/chord/output";
import { isReadToolName, spillThresholdForTool } from "./bounds.ts";
import { portableSha256Hex } from "./memory-store.ts";
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
	readonly details?: unknown;
	readonly config: SlidingWindowConfig;
	/** Called only once an output is over its threshold, so the store opens on the first real spill. */
	readonly store: () => SlidingWindowArtifactStore;
	readonly stage: EphemeralSliceStage;
	/** Whether the active model routes through sliding-window so staged slices will actually be attached. Default: true. */
	readonly canStageSlices?: boolean;
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

	const detailsRec =
		i.details && typeof i.details === "object" && !Array.isArray(i.details)
			? (i.details as Record<string, unknown>)
			: undefined;
	const artifactRec =
		detailsRec?.artifact && typeof detailsRec.artifact === "object" && !Array.isArray(detailsRec.artifact)
			? (detailsRec.artifact as Record<string, unknown>)
			: undefined;
	const artifactPartial = artifactRec?.partial === true;
	const artifactSourcePath = typeof artifactRec?.sourcePath === "string" ? artifactRec.sourcePath : undefined;
	const artifactSourceSha256 = typeof artifactRec?.sourceSha256 === "string" ? artifactRec.sourceSha256 : undefined;

	const path =
		typeof i.input?.path === "string"
			? i.input.path
			: typeof i.input?.file_path === "string"
				? i.input.file_path
				: typeof i.input?.filePath === "string"
					? i.input.filePath
					: artifactSourcePath;
	const isRead = isReadToolName(i.toolName);
	const isPartialRead =
		artifactPartial || (artifactSourceSha256 !== undefined && portableSha256Hex(i.rawText) !== artifactSourceSha256);
	const meta = await i.store().put(i.rawText, {
		toolName: i.toolName,
		...(isRead && path && !isPartialRead ? { sourcePath: path, ...(i.cwd ? { cwd: i.cwd } : {}) } : {}),
		...(isRead && path && isPartialRead ? { label: path, bindSource: false } : {}),
	});
	const staged =
		(i.canStageSlices ?? true) && isRead && !i.isError && i.config.stageReadSlices && path
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
