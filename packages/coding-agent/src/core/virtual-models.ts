/**
 * Virtual models are catalog entries that route each request to a physical model.
 *
 * The selection (`model_change`, `agent.state.model`, `ctx.model`) may name a virtual model.
 * Everything below the routing step only sees physical models: providers stream them and
 * assistant messages record them. A virtual model never reaches a provider.
 *
 * Virtual models belong to a provider id but are not provider models. `ModelRuntime` keeps them
 * separately and adds them to the provider's catalog with `withVirtualModels()`, so any provider,
 * including one with physical models, can list several virtual models.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AnyModel,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	getPromptCacheTtlMs,
	isModelType,
	lazyStream,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { CACHE_TTL_MS } from "./cache-stats.ts";
import type { SessionEntry } from "./session-manager.ts";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Custom entry type that stores router state on the session branch. */
export const VIRTUAL_MODEL_STATE_ENTRY = "pi.virtual-model-state";

/** Data of a `pi.virtual-model-state` custom entry. */
export interface VirtualModelStateData<TState = unknown> {
	provider: string;
	modelId: string;
	state: TState;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Coarse compatibility category of why a request is being routed.
 * - `user`: first request after a message the user wrote (prompt, steering, or follow-up)
 * - `continuation`: any other request in the agent loop, including after tool results, extension messages, or boundary continuations
 * - `retry`: automatic retry after a failed request, including after compaction for a context overflow
 * - `direct`: a request outside the agent loop, such as compaction, branch summary, or an extension call
 */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

/**
 * Exact harness purpose of a routed request.
 * - `prompt`: initial request answering a user prompt, steering message, or follow-up message
 * - `continuation`: follow-on request within the agent loop (tool results, custom messages, or boundary `continue: true`)
 * - `retry`: automatic retry after a transient failure or overflow compaction
 * - `compaction`: context compaction summary generation
 * - `branch_summary`: `/tree` navigation branch summary generation
 * - `subagent`: initial prompt of a subagent session
 * - `direct`: any other direct `streamSimple` / `completeSimple` call outside the session turn loop
 */
export type ModelRoutePurpose =
	| "prompt"
	| "continuation"
	| "retry"
	| "compaction"
	| "branch_summary"
	| "subagent"
	| "direct";

/** Map a specific route purpose to its coarse `ModelRouteReason`. */
export function purposeToReason(purpose: ModelRoutePurpose): ModelRouteReason {
	switch (purpose) {
		case "prompt":
		case "subagent":
			return "user";
		case "continuation":
			return "continuation";
		case "retry":
			return "retry";
		case "compaction":
		case "branch_summary":
		case "direct":
			return "direct";
	}
}

/** Whether a route purpose belongs to a conversational turn that may persist router state. */
export function isStatefulRoutePurpose(purpose: ModelRoutePurpose): boolean {
	return purpose === "prompt" || purpose === "continuation" || purpose === "retry" || purpose === "subagent";
}

/** Live prompt-cache entry tracked on the current session branch for one physical model. */
export interface WarmCacheEntry {
	provider: string;
	modelId: string;
	/** Cached prompt tokens valid on the current branch prefix. */
	warmTokens: number;
	/** Epoch timestamp in milliseconds when the cache entry was written or last warmed. */
	lastRefreshedAtMs: number;
	/** Epoch timestamp in milliseconds when the provider's prompt-cache TTL expires. */
	expiresAtMs: number;
}

/** Snapshot of unexpired KV-cache state on the session branch at route time. */
export interface ModelRouteCacheSnapshot {
	/** True when switching physical models right now forfeits zero unexpired cached prompt tokens. */
	cacheFreeBoundary: boolean;
	/** Why no unexpired cache exists on the current segment, when `cacheFreeBoundary` is true. */
	boundaryReason?: "initial" | "compaction" | "branch_summary" | "expired";
	/** Unexpired prompt-cache entries on this branch, ordered from most to least recently refreshed. */
	entries: readonly WarmCacheEntry[];
	/** Look up an unexpired cache entry for a physical `(provider, modelId)`. */
	get(provider: string, modelId: string): WarmCacheEntry | undefined;
}

/** Empty cache snapshot used when routing without a session branch. */
export const EMPTY_ROUTE_CACHE_SNAPSHOT: ModelRouteCacheSnapshot = {
	cacheFreeBoundary: true,
	boundaryReason: "initial",
	entries: [],
	get: () => undefined,
};

/** Tool-calling mode applied ephemerally to a single routed request. */
export type ModelRouteToolChoice = "auto" | "none" | "required";

/** Secondary physical target launched if the primary route emits no tokens within `afterMs`. */
export interface ModelRouteHedge {
	/** Delay in milliseconds before racing `model` when the primary stream has emitted no content. */
	afterMs: number;
	/** Backup physical model to race against the stalled primary stream. */
	model: Model<Api>;
	/** Thinking level for `model` (defaults to the primary route's `thinkingLevel`). */
	thinkingLevel?: ModelThinkingLevel;
}

/** Decision returned by pre-commit candidate validation (`ModelRoute.validate`). */
export type ModelRouteValidationDecision<TState = unknown> =
	| { action: "accept"; state?: TState }
	| {
			action: "escalate";
			model: Model<Api>;
			thinkingLevel?: ModelThinkingLevel;
			ephemeralTail?: string | readonly Message[];
			maxTokens?: number;
			temperature?: number;
			sessionId?: string;
			disableContinuation?: boolean;
			state?: TState;
	  };

export interface ModelRouteRequest<TState = unknown> {
	/** The selected virtual model. */
	model: Model<Api>;
	/** The selected thinking level. Its meaning is up to the router. */
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	/** Specific harness operation requesting a model. */
	purpose: ModelRoutePurpose;
	/** True when routing inside a subagent session. */
	isSubagent?: boolean;
	/** True when this continuation was scheduled by a `turn_end` or `agent_before_settle` `continue: true` hook. */
	boundaryContinuation?: boolean;
	/** Zero-based turn index within the active agent run (0 for initial turn and non-run requests). */
	turnIndex: number;
	/** Physical model, thinking level, and message of the latest successful response in `messages`. */
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	/**
	 * For `retry`: the failed request, which `messages` no longer contains. `message` carries its
	 * `stopReason` and `errorMessage`. Absent when the router itself failed.
	 */
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	/**
	 * Router state last stored on this session branch. Passed read-only for `compaction`,
	 * `branch_summary`, and `direct` calls when a session branch is available.
	 */
	state?: TState;
	/** Unexpired prompt-cache state across physical models on this session branch. */
	cache: ModelRouteCacheSnapshot;
	/** Conversation for this request, including system messages. */
	messages: readonly Message[];
	signal?: AbortSignal;
	/** Update the live working status indicator while async routing runs. */
	setStatus?: (label: string | undefined) => void;
}

/** Physical model, thinking level, and optional single-request execution envelope. */
export interface ModelRoute<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	/**
	 * New router state, stored on the session branch unless it is `request.state` itself. Return
	 * `request.state` or undefined to keep the current state. Must be JSON-serializable. Ignored for
	 * non-turn requests (`compaction`, `branch_summary`, `direct`).
	 */
	state?: TState;
	/** Ephemeral message slice or transform for this single outbound request; never persisted. */
	messages?: readonly Message[] | ((messages: readonly Message[]) => readonly Message[]);
	/** Text prepended ephemerally to `system[0]` for this single outbound request. */
	systemPromptPrefix?: string;
	/** Text appended ephemerally to `system[0]` for this single outbound request. */
	systemAppend?: string;
	/** Trailing control prompt (`user` message text) or LLM messages appended ephemerally to this single request. */
	ephemeralTail?: string | readonly Message[];
	/** Ephemeral allowlist of tool names declared and executable for this single turn, without mutating `agent.state.tools`. */
	allowedTools?: readonly string[];
	/** Custom error text returned to the model if it attempts a tool outside `allowedTools`. */
	blockedToolReason?: string;
	/** Ephemeral tool-choice constraint for this single outbound request. */
	toolChoice?: ModelRouteToolChoice;
	/** Per-request output token cap. */
	maxTokens?: number;
	/** Per-request sampling temperature override. */
	temperature?: number;
	/** Per-request provider session / cache-affinity ID override (for cache-guarded forks or isolated sidecars). */
	sessionId?: string;
	/** Skip server-side thread/WebSocket continuation state for this call so one-off or forked requests never clobber the active thread. */
	disableContinuation?: boolean;
	/** Abort the physical request with a retryable timeout error if no content arrives within this many milliseconds. */
	ttfbTimeoutMs?: number;
	/** Whether `CacheWarmer` may keep this physical request's prompt cache warm (defaults to true). */
	keepCacheWarm?: boolean;
	/** Working indicator label shown while this routed request streams. */
	statusLabel?: string;
	/** Hide assistant text and thinking from presentation surfaces while keeping canonical history intact. */
	suppressStream?: boolean;
	/** Compatibility alias for `suppressStream`. */
	suppressTextDisplay?: boolean;
	/** Optional TTFB hedge target raced if the primary model stalls before its first token. */
	hedge?: ModelRouteHedge;
	/** Optional pre-commit validator for non-tool responses; buffers candidate output before emitting or escalating. */
	validate?: (
		candidate: AssistantMessage,
	) => ModelRouteValidationDecision<TState> | Promise<ModelRouteValidationDecision<TState>>;
}

/** Post-turn / post-response telemetry delivered to `VirtualModelDefinition.onOutcome`. */
export interface ModelRouteOutcome<TState = unknown> {
	/** Selected virtual model that routed the request. */
	virtualModel: Model<Api>;
	/** Final physical route that produced `message` (reflects hedge winner or validation escalation). */
	route: ModelRoute<TState>;
	/** Specific harness purpose under which the request ran. */
	purpose: ModelRoutePurpose;
	/** Zero-based turn index within the run (0 outside a run). */
	turnIndex: number;
	/** Completed physical assistant response (including `"error"` or `"aborted"` stop reasons). */
	message: AssistantMessage;
	/** Tool results produced by this turn's tool batch (empty when no tools ran). */
	toolResults: readonly ToolResultMessage[];
	/** Milliseconds from physical dispatch to the first streamed content event. */
	ttfbMs: number;
	/** Milliseconds from physical dispatch to stream completion (excluding tool execution time). */
	durationMs: number;
	/** True when `message.stopReason === "aborted"`. */
	aborted: boolean;
	/** Current router state on the session branch. */
	state?: TState;
}

/** Stream-tier request passed to `VirtualModelDefinition.stream` for custom speculation or racing. */
export interface VirtualStreamRequest<TState = unknown> extends ModelRouteRequest<TState> {
	/** Dispatch one physical route through the runtime's full auth and ephemeral projection pipeline. */
	dispatch: (route: ModelRoute<TState>) => AssistantMessageEventStream;
	/** Attribute sidecar token/cost usage (aborted hedges, discarded drafts, judges) to the session without adding messages. */
	recordUsage: (kind: string, provider: string, modelId: string, usage: Usage, note?: string) => void;
	/** Persist updated router state on the session branch (ignored on read-only purposes). */
	setState: (state: TState) => void;
	/** Update the live working indicator message. */
	setStatus: (label: string | undefined) => void;
}

export interface VirtualModelDefinition<TState = unknown> {
	/** Provider the virtual model is listed under. May be a provider with physical models. */
	provider: string;
	/** Model id. Must not be the id of a physical model of `provider`. */
	id: string;
	name: string;
	/** Thinking levels offered for selection. Defaults to `["off"]`. */
	thinkingLevels?: readonly ModelThinkingLevel[];
	/**
	 * Limits shown before the first route resolves. Afterwards, Pi uses the limits of the active
	 * physical route. Unset limits are unknown (0).
	 */
	contextWindow?: number;
	maxTokens?: number;
	/** Input types accepted for selection. Defaults to text and images; routed models without image support get placeholders. */
	input?: ("text" | "image")[];
	/** Pick the physical model, which must have credentials, thinking level, and optional execution envelope for one request. */
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
	/** Optional stream-level execution hook for custom hedging, racing, or multi-model speculation. */
	stream?(request: VirtualStreamRequest<TState>): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	/** Optional closed-loop callback invoked when a routed physical response (and any turn tool batch) completes or aborts. */
	onOutcome?(
		outcome: ModelRouteOutcome<TState>,
	): TState | undefined | void | Promise<TState | undefined> | Promise<void>;
}

/** Whether a model or message names a virtual model. Failed routing leaves the virtual model on its message. */
export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

/** Whether a route suppresses streamed assistant text and thinking on presentation surfaces. */
export function isStreamSuppressedRoute(route: Pick<ModelRoute, "suppressStream" | "suppressTextDisplay">): boolean {
	return route.suppressStream === true || route.suppressTextDisplay === true;
}

/** Latest successful response. Its model is physical: failed or aborted requests, including failed routing, are skipped. */
export function findLatestResponse(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted") {
			return message;
		}
	}
	return undefined;
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

/** Build the catalog entry of a virtual model. */
export function createVirtualModel(
	definition: Omit<VirtualModelDefinition, "route" | "stream" | "onOutcome">,
): Model<Api> {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	return {
		id: definition.id,
		name: definition.name,
		api: VIRTUAL_MODEL_API,
		provider: definition.provider,
		baseUrl: "",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
		input: definition.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 0,
		maxTokens: definition.maxTokens ?? 0,
	};
}

/** Stream for a virtual model that was not routed, e.g. `stream()` with API-specific options. */
function unroutedStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		throw new Error(`Virtual model ${model.provider}/${model.id} must be routed before streaming`);
	});
}

/**
 * Add virtual models to a provider's catalog. Without a provider, the result is a keyless provider
 * that only lists the virtual models. A virtual model hides a physical chat model with the same id,
 * which a catalog refresh can add after registration. Availability follows the provider's auth.
 */
export function withVirtualModels(
	providerId: string,
	provider: Provider | undefined,
	virtualModels: readonly Model<Api>[],
): Provider {
	if (!provider) {
		return {
			id: providerId,
			name: providerId,
			auth: { apiKey: { name: "Virtual model", resolve: async () => ({ auth: {}, source: "virtual" }) } },
			getModels: () => virtualModels,
			stream: unroutedStream,
			streamSimple: unroutedStream,
		};
	}
	const ids = new Set(virtualModels.map((model) => model.id));
	const physical = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => !isVirtualModel(model) && !(isModelType(model, "chat") && ids.has(model.id)));
	const virtual = <TModel extends AnyModel>(models: readonly TModel[]) =>
		models.filter((model) => isVirtualModel(model));
	const { filterModels, filterAllModels } = provider;
	return {
		...provider,
		getModels: () => [...physical(provider.getModels()), ...virtualModels],
		getAllModels: () => [...physical(provider.getAllModels?.() ?? provider.getModels()), ...virtualModels],
		filterModels: (models, credential) => {
			const real = physical(models);
			return [...(filterModels?.(real, credential) ?? real), ...virtual(models)];
		},
		filterAllModels:
			filterAllModels &&
			((models, credential) => [...filterAllModels(physical(models), credential), ...virtual(models)]),
		stream: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.stream(model, context, options),
		streamSimple: (model, context, options) =>
			isVirtualModel(model) ? unroutedStream(model) : provider.streamSimple(model, context, options),
	};
}
