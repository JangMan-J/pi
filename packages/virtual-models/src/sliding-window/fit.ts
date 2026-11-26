import type { SwapProbe, SwapProjectionInput } from "./types.ts";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** reported / estimated for this model; 1 when there is nothing to compare. Clamped so one odd turn cannot skew it. */
export function calibrationRatio(reportedTokens: number, estimatedPrompt: number): number {
	if (reportedTokens <= 0 || estimatedPrompt <= 0) return 1;
	return clamp(reportedTokens / estimatedPrompt, 0.5, 2);
}

/** Predicted prompt size of the first request after the swap. */
export function projectSwapTokens(i: SwapProjectionInput): number {
	const ratio = calibrationRatio(i.reportedTokens, i.estimatedPrompt);
	const projected =
		i.reportedTokens -
		ratio * i.estimatedDropped +
		ratio * i.estimatedTrailing +
		ratio * (i.estimatedAdded ?? 0) +
		i.summaryTokens * ratio;
	return Math.max(0, Math.round(projected));
}

/** Signed error of the prediction in percent (positive: we over-estimated). */
export function swapErrorPct(p: SwapProbe): number | undefined {
	if (p.actual === undefined || p.actual <= 0) return undefined;
	return Math.round(((p.estimated - p.actual) / p.actual) * 100);
}
