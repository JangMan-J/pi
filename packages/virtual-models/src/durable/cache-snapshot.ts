/**
 * KV-cache snapshot derivation for virtual-model routing, extracted from pi-durable's durable virtual-model
 * harness so `@earendil-works/pi-virtual-models/durable` stands alone: no legacy re-export or `node:` imports
 * beyond the durable substrate itself.
 */
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { AssistantEntry, CompactionEntry, type ContextView, ResetEntry } from "@earendil-works/pi-durable";
import { DEFAULT_PROMPT_CACHE_TTL_MS, type ModelRouteCacheSnapshot, type WarmCacheEntry } from "../core/types.ts";

const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["error", "aborted", "deferred"]);
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Clock and TTL overrides for `computeContextCacheSnapshot` and `computeMessageCacheSnapshot`. */
export interface ComputeContextCacheSnapshotOptions {
	/** Base prompt-cache TTL in ms when `cacheWrite1h` was not used (defaults to `DEFAULT_PROMPT_CACHE_TTL_MS`, 5 min). */
	readonly ttlMs?: number;
	/** Reference timestamp in ms (`api.now()` in durable hooks; defaults to `Date.now()`). */
	readonly now?: number;
}

/** Derive an unexpired KV-cache snapshot from active durable `ContextView` entries. */
export function computeContextCacheSnapshot(
	view: ContextView,
	getPhysicalModel: (provider: string, modelId: string) => Model<Api> | undefined,
	opts?: ComputeContextCacheSnapshotOptions,
): ModelRouteCacheSnapshot {
	const initialBoundaryReason: "initial" | "compaction" | "branch_summary" =
		view.head !== undefined && CompactionEntry.is(view.head)
			? "compaction"
			: view.head !== undefined && ResetEntry.is(view.head) && view.head.model?.length
				? "branch_summary"
				: "initial";

	const assistantMessages: AssistantMessage[] = [];
	for (const entry of view.entries) {
		if (!AssistantEntry.is(entry) || !entry.model) continue;
		for (const msg of entry.model) {
			if (msg.role === "assistant") assistantMessages.push(msg);
		}
	}
	return buildCacheSnapshot(assistantMessages, getPhysicalModel, initialBoundaryReason, opts);
}

/** Derive an unexpired KV-cache snapshot directly from active `Message[]` in a request hook. */
export function computeMessageCacheSnapshot(
	messages: readonly Message[],
	getPhysicalModel: (provider: string, modelId: string) => Model<Api> | undefined,
	opts?: ComputeContextCacheSnapshotOptions,
): ModelRouteCacheSnapshot {
	const assistantMessages: AssistantMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") assistantMessages.push(msg);
	}
	return buildCacheSnapshot(assistantMessages, getPhysicalModel, "initial", opts);
}

function buildCacheSnapshot(
	assistantMessages: readonly AssistantMessage[],
	getPhysicalModel: (provider: string, modelId: string) => Model<Api> | undefined,
	initialBoundaryReason: "initial" | "compaction" | "branch_summary",
	opts?: ComputeContextCacheSnapshotOptions,
): ModelRouteCacheSnapshot {
	const baseTtlMs = opts?.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS;
	const now = opts?.now ?? Date.now();
	const byKey = new Map<string, WarmCacheEntry>();
	let sawEligibleResponse = false;

	for (const msg of assistantMessages) {
		if (EXCLUDED_STOP_REASONS.has(msg.stopReason)) continue;
		const physical = getPhysicalModel(msg.provider, msg.model);
		if (!physical) continue;
		sawEligibleResponse = true;
		const cached = (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0);
		const warmTokens = cached > 0 ? cached : (msg.usage.input ?? 0);
		const effectiveTtlMs = (msg.usage.cacheWrite1h ?? 0) > 0 ? Math.max(baseTtlMs, ONE_HOUR_MS) : baseTtlMs;
		const timestamp = msg.timestamp || now;
		const expiresAtMs = timestamp + effectiveTtlMs;
		if (expiresAtMs <= now) continue;
		const key = `${physical.provider}\0${physical.id}`;
		const prev = byKey.get(key);
		if (!prev || timestamp >= prev.lastRefreshedAtMs) {
			byKey.set(key, {
				provider: physical.provider,
				modelId: physical.id,
				warmTokens,
				lastRefreshedAtMs: timestamp,
				expiresAtMs,
			});
		}
	}

	const entries = [...byKey.values()].sort((a, b) => b.lastRefreshedAtMs - a.lastRefreshedAtMs);
	if (entries.length === 0) {
		return {
			cacheFreeBoundary: true,
			boundaryReason: sawEligibleResponse ? "expired" : initialBoundaryReason,
			entries: [],
			get: () => undefined,
		};
	}
	return {
		cacheFreeBoundary: false,
		entries,
		get: (provider: string, modelId: string) => byKey.get(`${provider}\0${modelId}`),
	};
}
