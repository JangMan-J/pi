import type { Context } from "@earendil-works/chord/context";
import type { JsonRepresentation, JsonValue } from "@earendil-works/chord/json";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_PROMPT_CACHE_TTL_MS,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type WarmCacheEntry,
} from "@earendil-works/pi-ai/virtual-models";
import { defineDoc } from "../documents.ts";
import { AssistantEntry, CompactionEntry, ResetEntry } from "../entries.ts";
import type { ConversationId, EntryId, Tx } from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { ProviderDoc } from "./provider.ts";
import type { ContextView, Conversation, ConversationCreateOptions } from "./types.ts";

export type ForkCacheGuard = {
	disableContinuation?: boolean;
	preserveToolDeclarations?: boolean;
	allowedTools?: string[];
	blockedToolReason?: string;
	parentThinkingLevel?: ModelThinkingLevel;
	preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	sessionId?: string;
};

export type VirtualModelStateValue = {
	routeState?: JsonValue;
	forkGuard?: ForkCacheGuard;
};

/** Per-conversation durable router state and fork cache-guard metadata; rewindable across forks. */
export const VirtualModelStateDoc = defineDoc<VirtualModelStateValue>({
	kind: "virtual-models.state",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});

export type BatonStateValue = {
	epoch: number;
	anchorUser0?: JsonRepresentation<UserMessage>;
	handoffSummary?: string;
	swappedAtTokens?: number;
	data?: JsonValue;
};

/** Per-conversation baton epoch & stable `firstUser` anchor (`cch` invariant); rewindable across forks. */
export const BatonStateDoc = defineDoc<BatonStateValue>({
	kind: "virtual-models.baton",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ epoch: 0 }),
	checkpointWhen: () => true,
});

const EXCLUDED_STOP_REASONS: ReadonlySet<AssistantMessage["stopReason"]> = new Set(["error", "aborted", "deferred"]);
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ComputeContextCacheSnapshotOptions {
	readonly ttlMs?: number;
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

/**
 * Copy Ring 1's `ProviderDoc.sessionId` onto a forked conversation inside its atomic `init` commit,
 * keeping gateway/shard routing (`x-meta-ai-gateway-session-id`, Kimi `prompt_cache_key`) on the warm shard.
 */
export async function copyParentProviderSession(
	tx: Tx,
	parentId: ConversationId,
	forkId: ConversationId,
): Promise<string | undefined> {
	const parentSessionId = (await tx.doc(ProviderDoc, parentId)).sessionId;
	if (parentSessionId !== undefined) {
		(await tx.doc(ProviderDoc, forkId)).sessionId = parentSessionId;
	}
	return parentSessionId;
}

/** Apply `ForkCacheGuard` and inherited `sessionId` constraints onto a resolved `ModelRoute`. */
export function applyForkGuardToRoute(
	route: ModelRoute,
	guard: ForkCacheGuard | undefined,
	sessionId?: string,
): ModelRoute {
	if (!guard && !sessionId) return route;
	const guardedThinking =
		guard?.preservedThinkingLevel !== undefined && route.thinkingLevel === "off"
			? guard.preservedThinkingLevel
			: route.thinkingLevel;
	const effectiveSession = route.sessionId ?? guard?.sessionId ?? sessionId;
	return {
		...route,
		thinkingLevel: guardedThinking,
		...(effectiveSession !== undefined ? { sessionId: effectiveSession } : {}),
		...(guard?.disableContinuation !== undefined ? { disableContinuation: guard.disableContinuation } : {}),
		...(guard?.preserveToolDeclarations !== undefined
			? { preserveToolDeclarations: guard.preserveToolDeclarations }
			: {}),
		...(guard?.allowedTools !== undefined ? { allowedTools: guard.allowedTools } : {}),
		...(guard?.blockedToolReason !== undefined ? { blockedToolReason: guard.blockedToolReason } : {}),
	};
}

export interface CacheGuardedForkOptions extends ConversationCreateOptions {
	readonly parentThinkingLevel?: ModelThinkingLevel;
	readonly preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	readonly allowThinkingEpochFlip?: boolean;
	readonly allowedTools?: readonly string[];
	readonly blockedToolReason?: string;
	readonly disableContinuation?: boolean;
	readonly preserveToolDeclarations?: boolean;
}

/**
 * Fork a conversation while preserving Ring 1's `ProviderDoc.sessionId`, disabling wire continuation mismatch
 * (`disableContinuation: true`), freezing declared tool schemas (`preserveToolDeclarations: true`), and guarding
 * non-`"off"` thinking epochs (Kimi K3 `keep: "all"` invariant).
 */
export async function createCacheGuardedFork(
	parent: Conversation,
	at: EntryId,
	options: CacheGuardedForkOptions,
	context: Context,
): Promise<Conversation> {
	const {
		parentThinkingLevel,
		preservedThinkingLevel,
		allowThinkingEpochFlip,
		allowedTools,
		blockedToolReason,
		disableContinuation = true,
		preserveToolDeclarations = true,
		init,
		...createOptions
	} = options;

	return parent.fork(
		at,
		{
			...createOptions,
			init: async (tx, forkId) => {
				const sessionId = await copyParentProviderSession(tx, parent.id, forkId);
				const parentAgent = await tx.doc(AgentDoc, parent.id);
				const forkAgent = await tx.doc(AgentDoc, forkId);
				const epochLevel = parentThinkingLevel ?? parentAgent.thinkingLevel;
				const guardedLevel =
					!allowThinkingEpochFlip && epochLevel !== undefined && epochLevel !== "off"
						? (preservedThinkingLevel ?? epochLevel)
						: undefined;
				if (guardedLevel !== undefined && forkAgent.thinkingLevel === "off") {
					forkAgent.thinkingLevel = guardedLevel;
				}
				const state = await tx.doc(VirtualModelStateDoc, forkId);
				state.forkGuard = {
					disableContinuation,
					preserveToolDeclarations,
					...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
					...(blockedToolReason !== undefined ? { blockedToolReason } : {}),
					...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
					...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
				};
				await init?.(tx, forkId);
			},
		},
		context,
	);
}

export {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyRequiredToolChoicePayload,
	attachVirtualRequestScope,
	buildRoutedStreamOptions,
	createVirtualModel,
	DEFAULT_PROMPT_CACHE_TTL_MS,
	EMPTY_ROUTE_CACHE_SNAPSHOT,
	executeRoutedStream,
	findLatestResponse,
	getVirtualRequestScope,
	isStatefulRoutePurpose,
	isStreamSuppressedRoute,
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type ModelRouteHedge,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type ModelRouteReason,
	type ModelRouteRequest,
	type ModelRouteToolChoice,
	type ModelRouteValidationDecision,
	type PreparedVirtualRoute,
	presentAssistantMessage,
	projectRoutedTranscript,
	type ResolveVirtualModelOptions,
	type RoutedStreamCompletion,
	suppressAssistantText,
	VIRTUAL_MODEL_API,
	type VirtualModelDefinition,
	type VirtualModels,
	type VirtualStreamOptions,
	type VirtualStreamRequest,
	type VirtualStreamRequestScope,
	type WarmCacheEntry,
	type WithVirtualModelRoutingOptions,
	withVirtualModelRouting,
	withVirtualModels,
} from "@earendil-works/pi-ai/virtual-models";
