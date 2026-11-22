/**
 * Virtual models are catalog entries that route each request to a physical model.
 *
 * Pure routing contracts, catalog composition, and message presentation live in
 * `@earendil-works/pi-ai/virtual-models`. This module re-exports them and provides the
 * `coding-agent` session-branch selection, persisted state, and branch cache-snapshot adapters.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	getPromptCacheTtlMs,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	findLatestResponse as aiFindLatestResponse,
	EMPTY_ROUTE_CACHE_SNAPSHOT,
	isVirtualModel,
	type ModelRouteCacheSnapshot,
	type WarmCacheEntry,
} from "@earendil-works/pi-ai/virtual-models";
import { CACHE_TTL_MS } from "./cache-stats.ts";
import type { SessionEntry } from "./session-manager.ts";

export {
	createVirtualModel,
	EMPTY_ROUTE_CACHE_SNAPSHOT,
	isStatefulRoutePurpose,
	isStreamSuppressedRoute,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type ModelRouteHedge,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type ModelRouteReason,
	type ModelRouteRequest,
	type ModelRouteToolChoice,
	type ModelRouteValidationDecision,
	purposeToReason,
	VIRTUAL_MODEL_API,
	type VirtualModelDefinition,
	type VirtualStreamRequest,
	type WarmCacheEntry,
	withVirtualModels,
} from "@earendil-works/pi-ai/virtual-models";

/** Custom entry type that stores router state on the session branch. */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

/** Data of a `pi.virtual-model-state` custom entry. */
export interface VirtualModelStateData<TState = unknown> {
	provider: string;
	modelId: string;
	state: TState;
}

/** Latest successful response. Its model is physical: failed or aborted requests, including failed routing, are skipped. */
export function findLatestResponse(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	return aiFindLatestResponse(messages as readonly { role: string }[]);
}

/**
 * The model selection a session branch records. A virtual `model_change` holds until the next
 * `model_change`, because responses name the physical models it routed to. Otherwise the latest
 * physical response wins, as in sessions without virtual models. A virtual model that is no longer
 * registered does not hold, so the selection falls back to the physical model that answered last.
 *
 * Only the last `model_change` can hold, so this looks up at most one model in the catalog.
 */
export function getBranchSelection(
	branch: readonly SessionEntry[],
	getModel: (provider: string, modelId: string) => Model<Api> | undefined,
): { provider: string; modelId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") {
			return { provider: entry.provider, modelId: entry.modelId };
		}
		if (entry.type === "message" && entry.message.role === "assistant" && !isVirtualModel(entry.message)) {
			const response = { provider: entry.message.provider, modelId: entry.message.model };
			const change = findLastModelChange(branch, i);
			const model = change && getModel(change.provider, change.modelId);
			return change && model && isVirtualModel(model) ? change : response;
		}
	}
	return undefined;
}

function findLastModelChange(
	branch: readonly SessionEntry[],
	before: number,
): { provider: string; modelId: string } | undefined {
	for (let i = before - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "model_change") return { provider: entry.provider, modelId: entry.modelId };
	}
	return undefined;
}

/** Latest router state a session branch stores for a virtual model. */
export function getVirtualModelState(branch: readonly SessionEntry[], provider: string, modelId: string): unknown {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
		const data = entry.data as VirtualModelStateData | undefined;
		if (data?.provider === provider && data.modelId === modelId) return data.state;
	}
	return undefined;
}

interface TrackedCacheEntry extends WarmCacheEntry {
	ttlMs: number;
	entryIndex: number;
}

/** Compute unexpired prompt-cache state across physical models on `branch`. */
export function computeBranchCacheSnapshot(
	branch: readonly SessionEntry[],
	getPhysicalModel: (provider: string, modelId: string) => Model<Api> | undefined,
	options: {
		nowMs?: number;
		cacheOptions?: Pick<SimpleStreamOptions, "cacheRetention" | "env">;
	} = {},
): ModelRouteCacheSnapshot {
	if (branch.length === 0) return EMPTY_ROUTE_CACHE_SNAPSHOT;
	const nowMs = options.nowMs ?? Date.now();
	let segmentStart = -1;
	let initialBoundary: "initial" | "compaction" | "branch_summary" = "initial";
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "compaction") {
			segmentStart = i;
			initialBoundary = "compaction";
			break;
		}
		if (entry.type === "branch_summary") {
			segmentStart = i;
			initialBoundary = "branch_summary";
			break;
		}
	}

	const tracked = new Map<string, TrackedCacheEntry>();
	const entryIndexById = new Map<string, number>();
	const promptTokensBeforeIndex = new Map<number, number>();
	let latestPromptTokens = 0;
	let hasResponseInSegment = false;

	for (let i = segmentStart + 1; i < branch.length; i++) {
		const entry = branch[i];
		entryIndexById.set(entry.id, i);
		promptTokensBeforeIndex.set(i, latestPromptTokens);

		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "error" &&
			entry.message.stopReason !== "aborted" &&
			!isVirtualModel(entry.message)
		) {
			hasResponseInSegment = true;
			const { usage } = entry.message;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			const model = getPhysicalModel(entry.message.provider, entry.message.model);
			const ttlMs =
				(model ? getPromptCacheTtlMs(model, options.cacheOptions) : undefined) ??
				(usage.cacheRead + usage.cacheWrite > 0 ? CACHE_TTL_MS : undefined);
			if (promptTokens > 0) latestPromptTokens = promptTokens;
			if (ttlMs !== undefined && promptTokens > 0) {
				const key = `${entry.message.provider}/${entry.message.model}`;
				tracked.set(key, {
					provider: entry.message.provider,
					modelId: entry.message.model,
					warmTokens: promptTokens,
					lastRefreshedAtMs: entry.message.timestamp,
					expiresAtMs: entry.message.timestamp + ttlMs,
					ttlMs,
					entryIndex: i,
				});
			}
			continue;
		}

		if (entry.type === "usage" && entry.kind === "cache_warm") {
			const promptTokens = entry.usage.input + entry.usage.cacheRead + entry.usage.cacheWrite;
			const refreshedAtMs = Date.parse(entry.timestamp);
			if (!Number.isFinite(refreshedAtMs)) continue;
			const key = `${entry.provider}/${entry.model}`;
			const existing = tracked.get(key);
			const model = getPhysicalModel(entry.provider, entry.model);
			const ttlMs =
				existing?.ttlMs ?? (model ? getPromptCacheTtlMs(model, options.cacheOptions) : undefined) ?? CACHE_TTL_MS;
			const warmTokens = promptTokens > 0 ? promptTokens : (existing?.warmTokens ?? 0);
			if (warmTokens <= 0) continue;
			if (promptTokens > 0) latestPromptTokens = promptTokens;
			tracked.set(key, {
				provider: entry.provider,
				modelId: entry.model,
				warmTokens,
				lastRefreshedAtMs: refreshedAtMs,
				expiresAtMs: refreshedAtMs + ttlMs,
				ttlMs,
				entryIndex: existing?.entryIndex ?? i,
			});
			continue;
		}

		if (entry.type === "context_edit") {
			const targetIndex = entryIndexById.get(entry.targetId);
			if (targetIndex === undefined) continue;
			const validPrefixTokens = promptTokensBeforeIndex.get(targetIndex) ?? 0;
			for (const [key, item] of tracked) {
				if (item.entryIndex >= targetIndex) {
					if (validPrefixTokens <= 0) tracked.delete(key);
					else item.warmTokens = Math.min(item.warmTokens, validPrefixTokens);
				}
			}
		}
	}

	const entries: WarmCacheEntry[] = [...tracked.values()]
		.filter((item) => item.expiresAtMs > nowMs && item.warmTokens > 0)
		.sort((a, b) => b.lastRefreshedAtMs - a.lastRefreshedAtMs)
		.map(({ ttlMs: _ttl, entryIndex: _idx, ...entry }) => entry);
	const byKey = new Map(entries.map((entry) => [`${entry.provider}/${entry.modelId}`, entry]));
	const cacheFreeBoundary = entries.length === 0;
	const boundaryReason = !hasResponseInSegment
		? initialBoundary
		: cacheFreeBoundary && tracked.size > 0
			? "expired"
			: undefined;

	return {
		cacheFreeBoundary,
		...(boundaryReason ? { boundaryReason } : {}),
		entries,
		get: (provider, modelId) => byKey.get(`${provider}/${modelId}`),
	};
}
