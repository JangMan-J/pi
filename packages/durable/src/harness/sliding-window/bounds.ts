import type { BatonThinkingLevel, SlidingWindowBounds, SlidingWindowConfig } from "./types.ts";

export const DEFAULT_SOFT_CEILING_TOKENS = 136_000;
export const DEFAULT_HARD_CEILING_TOKENS = 180_000;
export const DEFAULT_KEEP_RECENT_TOKENS = 30_000;
export const DEFAULT_SOFT_CEILING_RATIO = 0.7;
export const DEFAULT_HARD_CEILING_RATIO = 0.82;
export const DEFAULT_BATON_MODEL = "auto";
export const DEFAULT_BATON_MAX_TOKENS = 1_200;
export const DEFAULT_SPILL_THRESHOLD_BYTES = 6_144;
export const DEFAULT_READ_SPILL_THRESHOLD_BYTES = 8_192;
export const DEFAULT_SEARCH_SPILL_THRESHOLD_BYTES = 4_096;
export const DEFAULT_MAX_STAGE_BYTES = 49_152;
export const DEFAULT_SLICE_TTL_TURNS = 2;

export const DEFAULT_SLIDING_WINDOW_CONFIG: SlidingWindowConfig = {
	softCeilingTokens: DEFAULT_SOFT_CEILING_TOKENS,
	hardCeilingTokens: DEFAULT_HARD_CEILING_TOKENS,
	keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
	softCeilingRatio: DEFAULT_SOFT_CEILING_RATIO,
	hardCeilingRatio: DEFAULT_HARD_CEILING_RATIO,
	keepTail: true,
	batonModel: DEFAULT_BATON_MODEL,
	batonThinkingLevel: "off",
	batonMaxTokens: DEFAULT_BATON_MAX_TOKENS,
	spillEnabled: true,
	spillThresholdBytes: DEFAULT_SPILL_THRESHOLD_BYTES,
	readSpillThresholdBytes: DEFAULT_READ_SPILL_THRESHOLD_BYTES,
	searchSpillThresholdBytes: DEFAULT_SEARCH_SPILL_THRESHOLD_BYTES,
	stageReadSlices: true,
	maxStageBytes: DEFAULT_MAX_STAGE_BYTES,
	sliceTtlTurns: DEFAULT_SLICE_TTL_TURNS,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function clampRatio(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, value));
}

export function normalizeSlidingWindowConfig(raw?: Partial<SlidingWindowConfig>): SlidingWindowConfig {
	const src = raw ?? {};
	const softCeilingTokens = clampInt(
		src.softCeilingTokens,
		DEFAULT_SLIDING_WINDOW_CONFIG.softCeilingTokens,
		1,
		2_000_000,
	);
	const hardCeilingTokens = Math.max(
		softCeilingTokens,
		clampInt(src.hardCeilingTokens, DEFAULT_SLIDING_WINDOW_CONFIG.hardCeilingTokens, 1, 2_000_000),
	);
	const keepRecentTokens = clampInt(
		src.keepRecentTokens,
		DEFAULT_SLIDING_WINDOW_CONFIG.keepRecentTokens,
		0,
		Math.max(0, softCeilingTokens - 1),
	);
	const softCeilingRatio = clampRatio(
		src.softCeilingRatio,
		DEFAULT_SLIDING_WINDOW_CONFIG.softCeilingRatio,
		0.01,
		0.99,
	);
	const hardCeilingRatio = Math.max(
		softCeilingRatio,
		clampRatio(src.hardCeilingRatio, DEFAULT_SLIDING_WINDOW_CONFIG.hardCeilingRatio, 0.01, 0.99),
	);
	const keepRecentRatio =
		src.keepRecentRatio !== undefined ? clampRatio(src.keepRecentRatio, 0.15, 0.01, 0.99) : undefined;
	const batonThinkingLevel: BatonThinkingLevel =
		src.batonThinkingLevel === "minimal" || src.batonThinkingLevel === "low" ? src.batonThinkingLevel : "off";
	const batonModel =
		typeof src.batonModel === "string" && src.batonModel.trim().length > 0
			? src.batonModel.trim()
			: DEFAULT_SLIDING_WINDOW_CONFIG.batonModel;

	return {
		softCeilingTokens,
		hardCeilingTokens,
		keepRecentTokens,
		softCeilingRatio,
		hardCeilingRatio,
		...(keepRecentRatio !== undefined ? { keepRecentRatio } : {}),
		keepTail: typeof src.keepTail === "boolean" ? src.keepTail : DEFAULT_SLIDING_WINDOW_CONFIG.keepTail,
		batonModel,
		batonThinkingLevel,
		batonMaxTokens: clampInt(src.batonMaxTokens, DEFAULT_SLIDING_WINDOW_CONFIG.batonMaxTokens, 64, 16_384),
		spillEnabled:
			typeof src.spillEnabled === "boolean" ? src.spillEnabled : DEFAULT_SLIDING_WINDOW_CONFIG.spillEnabled,
		spillThresholdBytes: clampInt(
			src.spillThresholdBytes,
			DEFAULT_SLIDING_WINDOW_CONFIG.spillThresholdBytes,
			128,
			1_048_576,
		),
		readSpillThresholdBytes: clampInt(
			src.readSpillThresholdBytes,
			DEFAULT_SLIDING_WINDOW_CONFIG.readSpillThresholdBytes,
			128,
			1_048_576,
		),
		searchSpillThresholdBytes: clampInt(
			src.searchSpillThresholdBytes,
			DEFAULT_SLIDING_WINDOW_CONFIG.searchSpillThresholdBytes,
			128,
			1_048_576,
		),
		...(src.toolThresholds ? { toolThresholds: { ...src.toolThresholds } } : {}),
		stageReadSlices:
			typeof src.stageReadSlices === "boolean" ? src.stageReadSlices : DEFAULT_SLIDING_WINDOW_CONFIG.stageReadSlices,
		maxStageBytes: clampInt(src.maxStageBytes, DEFAULT_SLIDING_WINDOW_CONFIG.maxStageBytes, 1_024, 1_048_576),
		sliceTtlTurns: clampInt(src.sliceTtlTurns, DEFAULT_SLIDING_WINDOW_CONFIG.sliceTtlTurns, 1, 32),
	};
}

export function isReadToolName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower === "read" || lower.endsWith("_read_file") || lower.endsWith("__read");
}

export function isSearchToolName(name: string): boolean {
	const lower = name.toLowerCase();
	return (
		lower === "grep" ||
		lower === "find" ||
		lower === "ls" ||
		lower === "search_code" ||
		lower === "ast_search" ||
		lower.includes("search")
	);
}

export function spillThresholdForTool(toolName: string, config: SlidingWindowConfig): number {
	const lower = toolName.toLowerCase();
	if (config.toolThresholds) {
		const exact = config.toolThresholds[toolName] ?? config.toolThresholds[lower];
		if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0) return exact;
	}
	if (isReadToolName(toolName)) return config.readSpillThresholdBytes;
	if (isSearchToolName(toolName)) return config.searchSpillThresholdBytes;
	return config.spillThresholdBytes;
}

/** Parse shorthand like "136k", "30k", "180000", "0.2m" into integer tokens. */
export function parseTokenCount(raw: string): number | undefined {
	const trimmed = raw.trim().toLowerCase().replace(/_/g, "");
	const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(trimmed);
	if (!match) return undefined;
	const num = Number.parseFloat(match[1]!);
	if (!Number.isFinite(num) || num <= 0) return undefined;
	const mult = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.round(num * mult);
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		const k = tokens / 1_000;
		return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
	}
	return String(tokens);
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) {
		const kib = bytes / 1024;
		return Number.isInteger(kib) ? `${kib} KiB` : `${kib.toFixed(1)} KiB`;
	}
	return `${bytes} B`;
}

/** Scale soft/hard ceilings and tail size safely against the active physical model's context window. */
export function effectiveWindowBounds(
	config: SlidingWindowConfig,
	physicalContextWindow: number | undefined,
): SlidingWindowBounds {
	if (!physicalContextWindow || physicalContextWindow <= 0) {
		return {
			softCeilingTokens: config.softCeilingTokens,
			hardCeilingTokens: config.hardCeilingTokens,
			keepRecentTokens: Math.min(config.keepRecentTokens, Math.max(0, config.softCeilingTokens - 1)),
		};
	}
	const ratioHard = Math.floor(physicalContextWindow * config.hardCeilingRatio);
	const hardCeilingTokens = Math.max(
		1,
		Math.min(config.hardCeilingTokens, ratioHard > 0 ? ratioHard : config.hardCeilingTokens),
	);
	const ratioSoft = Math.floor(physicalContextWindow * config.softCeilingRatio);
	const softCeilingTokens = Math.max(
		1,
		Math.min(config.softCeilingTokens, ratioSoft > 0 ? ratioSoft : config.softCeilingTokens, hardCeilingTokens),
	);
	const ratioTail =
		config.keepRecentRatio !== undefined
			? Math.floor(physicalContextWindow * config.keepRecentRatio)
			: Math.floor(softCeilingTokens * 0.45);
	const keepRecentTokens = Math.max(
		0,
		Math.min(config.keepRecentTokens, ratioTail, Math.max(0, softCeilingTokens - 1)),
	);
	return { softCeilingTokens, hardCeilingTokens, keepRecentTokens };
}
