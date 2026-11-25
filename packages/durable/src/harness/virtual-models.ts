/**
 * Durable virtual-model substrate for hot-pluggable `defineExtension(...)` modules.
 *
 * Typical extension wiring across `pi-durable` seams:
 * - Read any `defineDoc` (`BatonStateDoc`, `VirtualModelStateDoc`, `UsageDoc`, `ProviderDoc`, or your own)
 *   in any hook via `await api.snapshot(Doc, api.conversationId, context)` (`HookApi extends DocumentReader`).
 * - Pass durable docs and in-memory slices into `VirtualModelDefinition.route(req)` by returning
 *   `attachVirtualRequestScope({ messages }, { state, cache })` from `GenerationHooks.beforeRequest`
 *   (`req.state` and `req.cache` receive them directly).
 * - Rewrite large tool outputs to short receipts before SQLite commit in `ToolHooks.afterTool`, attach active
 *   slices onto `ModelRoute.ephemeralTail` inside `route()`, and block disallowed tools in `ToolHooks.beforeTool`
 *   when `preserveToolDeclarations: true` freezes wire schemas.
 * - Track Helper B's cumulative spend in `UsageDoc.sidecars` and its latest per-call context window fill in
 *   `UsageDoc.sidecarContext[key].contextTokens` via `recordSidecarUsage(...)` or `BeforeAgentStartResult.sidecarUsage`.
 * - Execute ~250k baton swaps in `GenerationHooks.beforeAgentStart` by returning
 *   `{ reset: { model: [anchorUser0, handoffMessage] }, tasks, sidecarUsage }`.
 */
import type { Context } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	DEFAULT_PROMPT_CACHE_TTL_MS,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type WarmCacheEntry,
} from "@earendil-works/pi-ai/virtual-models";
import { AssistantEntry, CompactionEntry, ResetEntry } from "../entries.ts";
import type { ConversationId, EntryId, Tx } from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { ProviderDoc } from "./provider.ts";
import {
	BatonStateDoc,
	type BatonStateValue,
	type ForkCacheGuard,
	type StagedBaton,
	VirtualModelStateDoc,
	type VirtualModelStateValue,
} from "./sliding-window/virtual-models-docs.ts";
import type { ContextView, Conversation, ConversationCreateOptions } from "./types.ts";

export {
	BatonStateDoc,
	type BatonStateValue,
	type ForkCacheGuard,
	type StagedBaton,
	VirtualModelStateDoc,
	type VirtualModelStateValue,
};

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
		...(route.disableContinuation === true || guard?.disableContinuation !== undefined
			? { disableContinuation: route.disableContinuation === true || guard?.disableContinuation === true }
			: {}),
		...(guard?.preserveToolDeclarations !== undefined
			? { preserveToolDeclarations: guard.preserveToolDeclarations }
			: {}),
		...(guard?.allowedTools !== undefined ? { allowedTools: guard.allowedTools } : {}),
		...(guard?.blockedToolReason !== undefined ? { blockedToolReason: guard.blockedToolReason } : {}),
	};
}

/** Options for `createCacheGuardedFork()`, extending `ConversationCreateOptions`. */
export interface CacheGuardedForkOptions extends ConversationCreateOptions {
	/** Explicit parent thinking level to preserve across the epoch (defaults to reading parent's `AgentDoc`). */
	readonly parentThinkingLevel?: ModelThinkingLevel;
	/** Non-`"off"` fallback thinking level enforced if the fork or route selects `"off"` (defaults to parent's level). */
	readonly preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	/** Set `true` only when intentionally resetting the thinking epoch (allows flipping to `"off"` on Kimi K3). */
	readonly allowThinkingEpochFlip?: boolean;
	/** Execution-time tool allowlist recorded on `VirtualModelStateDoc.forkGuard` for `ToolHooks.beforeTool`. */
	readonly allowedTools?: readonly string[];
	/** Custom error text returned when `ToolHooks.beforeTool` blocks a tool outside `allowedTools`. */
	readonly blockedToolReason?: string;
	/** Suppress stateful wire continuations on the fork (defaults to `true`). */
	readonly disableContinuation?: boolean;
	/** Freeze outbound wire tool declarations so Meta `shapeMetaWireTools()` suffixes never shift (defaults to `true`). */
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
	ENCRYPTED_REASONING_COMMENTARY_PROMPT,
	executeRoutedStream,
	findLatestResponse,
	getVirtualRequestScope,
	harvestPostReadStudyNotes,
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
	type StudyNoteHarvestOptions,
	suppressAssistantText,
	type ToolCallStartEvent,
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
export type {
	ArtifactMeta,
	BatonResult,
	BatonThinkingLevel,
	BuildPreviewOptions,
	EditRecord,
	LiveFileSnapshot,
	MechanicalLedger,
	PutArtifactOptions,
	RawTurn,
	ReadRecord,
	RecallOptions,
	RecallResult,
	SlidingWindowArtifactStore,
	SlidingWindowBeforeSwapContext,
	SlidingWindowBeforeSwapResult,
	SlidingWindowBounds,
	SlidingWindowConfig,
	SlidingWindowForkOptions,
	SlidingWindowHandle,
	SlidingWindowHydratePolicy,
	SlidingWindowInspection,
	SlidingWindowOptions,
	SlidingWindowPreviewContext,
	SlidingWindowSectionContext,
	SlidingWindowTarget,
	SlidingWindowTargetContext,
	SlidingWindowTargetValue,
	StagedSlice,
	StoredArtifactEntry,
	SwapProbe,
	SwapProjectionInput,
	SymbolSpan,
} from "./sliding-window/types.ts";
export {
	createLayeredArtifactStore,
	createSlidingWindow,
	createSlidingWindowFork,
	DEFAULT_SLIDING_WINDOW_MODEL_ID,
	DEFAULT_SLIDING_WINDOW_PROVIDER,
	type ExportCheckpointedForkResult,
	type ExportCheckpointedForkStorageOptions,
	exportCheckpointedForkToStorage,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	type SlidingWindowStateValue,
	SlidingWindowTargetDoc,
} from "./sliding-window.ts";
