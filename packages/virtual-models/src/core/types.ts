/**
 * Framework-agnostic virtual-model catalog types, request envelopes, and stream execution contracts.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	Models,
	ModelThinkingLevel,
	SimpleStreamOptions,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import type { ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Default prompt-cache TTL assumed when cache activity is observed without explicit provider metadata. */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Coarse compatibility category of why a request is being routed. */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";

/** Exact harness operation requesting a routed model. */
export type ModelRoutePurpose =
	| "prompt"
	| "continuation"
	| "retry"
	| "compaction"
	| "branch_summary"
	| "subagent"
	| "direct";

/** Live prompt-cache entry tracked on the active transcript segment for one physical model. */
export interface WarmCacheEntry {
	provider: string;
	modelId: string;
	warmTokens: number;
	lastRefreshedAtMs: number;
	expiresAtMs: number;
}

/** Snapshot of unexpired KV-cache state at route time. */
export interface ModelRouteCacheSnapshot {
	/** True when switching physical models right now forfeits zero unexpired cached prompt tokens. */
	cacheFreeBoundary: boolean;
	/** Why no unexpired cache exists on the current segment, when `cacheFreeBoundary` is true. */
	boundaryReason?: "initial" | "compaction" | "branch_summary" | "expired";
	/** Unexpired prompt-cache entries ordered from most to least recently refreshed. */
	entries: readonly WarmCacheEntry[];
	/** Look up an unexpired cache entry for a physical `(provider, modelId)`. */
	get(provider: string, modelId: string): WarmCacheEntry | undefined;
}

/** Empty cache snapshot used when routing without branch/conversation history. */
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
	afterMs: number;
	model: Model<Api>;
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

/** Request inputs delivered to `VirtualModelDefinition.route()`. */
export interface ModelRouteRequest<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	reason: ModelRouteReason;
	purpose: ModelRoutePurpose;
	isSubagent?: boolean;
	boundaryContinuation?: boolean;
	turnIndex: number;
	previous?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	failed?: { model: Model<Api>; thinkingLevel?: ModelThinkingLevel; message: AssistantMessage };
	state?: TState;
	cache: ModelRouteCacheSnapshot;
	messages: readonly Message[];
	signal?: AbortSignal;
	setStatus?: (label: string | undefined) => void;
}

/** Physical model, thinking level, and optional single-request execution envelope. */
export interface ModelRoute<TState = unknown> {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	state?: TState;
	messages?: readonly Message[] | ((messages: readonly Message[]) => readonly Message[]);
	systemPromptPrefix?: string;
	systemAppend?: string;
	/**
	 * Single-turn content or messages appended at the very end of the outbound request without persisting to the
	 * transcript (e.g. full file slices backing short `tool_result` receipts). On `anthropic-messages`,
	 * `anchorAnthropicCacheBeforeEphemeralTail()` automatically keeps `cache_control` ahead of this tail.
	 */
	ephemeralTail?: string | readonly Message[];
	/** Outbound tool allowlist (filters schemas unless `preserveToolDeclarations: true` freezes wire declarations). */
	allowedTools?: readonly string[];
	/**
	 * When true, keep outbound `SystemMessage.toolsAdded` / `Context.tools` declarations frozen verbatim even when
	 * `allowedTools` is set (enforcing the allowlist strictly at tool execution time in `beforeTool`, so Meta
	 * `shapeMetaWireTools()` collision suffixes and provider KV prefixes stay identical on forks).
	 */
	preserveToolDeclarations?: boolean;
	blockedToolReason?: string;
	toolChoice?: ModelRouteToolChoice;
	maxTokens?: number;
	temperature?: number;
	/** Override outbound provider `sessionId` (e.g. Ring 1 warm-shard affinity on Meta / Kimi K3). */
	sessionId?: string;
	/** Suppress stateful continuation (`previous_response_id` / WS `lastResponseId` / `threadState`) for this call. */
	disableContinuation?: boolean;
	ttfbTimeoutMs?: number;
	keepCacheWarm?: boolean;
	statusLabel?: string;
	suppressStream?: boolean;
	suppressTextDisplay?: boolean;
	hedge?: ModelRouteHedge;
	validate?: (
		candidate: AssistantMessage,
	) => ModelRouteValidationDecision<TState> | Promise<ModelRouteValidationDecision<TState>>;
}

/** Post-turn / post-response telemetry delivered to `VirtualModelDefinition.onOutcome`. */
export interface ModelRouteOutcome<TState = unknown> {
	virtualModel: Model<Api>;
	route: ModelRoute<TState>;
	purpose: ModelRoutePurpose;
	turnIndex: number;
	message: AssistantMessage;
	toolResults: readonly ToolResultMessage[];
	ttfbMs: number;
	durationMs: number;
	aborted: boolean;
	state?: TState;
}

/** Stream-tier request passed to `VirtualModelDefinition.stream` for custom speculation or racing. */
export interface VirtualStreamRequest<TState = unknown> extends ModelRouteRequest<TState> {
	dispatch: (route: ModelRoute<TState>) => AssistantMessageEventStream;
	recordUsage: (kind: string, provider: string, modelId: string, usage: Usage, note?: string) => void;
	setState: (state: TState) => void;
	setStatus: (label: string | undefined) => void;
}

/** Payload delivered to `VirtualModelDefinition.onToolCallStart` when a routed stream begins emitting a tool call. */
export interface ToolCallStartEvent<TState = unknown> {
	toolName: string;
	turnIndex: number;
	request: ModelRouteRequest<TState>;
}

/** Virtual model catalog entry and routing contract. */
export interface VirtualModelDefinition<TState = unknown> {
	provider: string;
	id: string;
	name: string;
	thinkingLevels?: readonly ModelThinkingLevel[];
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	route(request: ModelRouteRequest<TState>): ModelRoute<TState> | Promise<ModelRoute<TState>>;
	stream?(request: VirtualStreamRequest<TState>): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	onToolCallStart?(event: ToolCallStartEvent<TState>): void;
	onOutcome?(
		outcome: ModelRouteOutcome<TState>,
	): TState | undefined | void | Promise<TState | undefined> | Promise<void>;
}

export type PhysicalStreamDispatcher = (
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type SidecarUsageRecorder = (
	kind: string,
	provider: string,
	modelId: string,
	usage: Usage,
	note?: string,
) => void;

export interface TimedStreamHandle {
	stream: AssistantMessageEventStream;
	getTiming(): { ttfbMs: number; durationMs: number };
}

export interface RoutedStreamCompletion<TState = unknown> {
	route: ModelRoute<TState>;
	message: AssistantMessage;
	ttfbMs: number;
	durationMs: number;
	readonly purpose?: ModelRoutePurpose;
	readonly turnIndex?: number;
}

export interface ExecuteRoutedStreamParams<TState = unknown> {
	definition: VirtualModelDefinition<TState>;
	request: ModelRouteRequest<TState>;
	initialRoute: ModelRoute<TState>;
	context: TranscriptContext;
	baseOptions?: SimpleStreamOptions;
	dispatchPhysical: PhysicalStreamDispatcher;
	resolvePhysicalModel: (provider: string, modelId: string) => Model<Api>;
	recordSidecarUsage?: SidecarUsageRecorder;
	onCommitRoute?: (route: ModelRoute<TState>) => void;
	onUpdateState?: (state: TState) => void;
	onStatus?: (label: string | undefined) => void;
	onComplete?: (completion: RoutedStreamCompletion<TState>) => Promise<void> | void;
}

/** Options for resolving a virtual model route ahead of or during a request. */
export interface ResolveVirtualModelOptions {
	reason?: ModelRouteReason;
	purpose?: ModelRoutePurpose;
	isSubagent?: boolean;
	boundaryContinuation?: boolean;
	turnIndex?: number;
	thinkingLevel: ModelThinkingLevel;
	signal?: AbortSignal;
	failed?: AssistantMessage;
	state?: unknown;
	cache?: ModelRouteCacheSnapshot;
	setStatus?: (label: string | undefined) => void;
}

/** Prepared virtual route bundle passed into `executeRoutedStream`. */
export interface PreparedVirtualRoute {
	definition: VirtualModelDefinition;
	request: ModelRouteRequest;
	route: ModelRoute;
}

/**
 * Per-request metadata carried across `Models.streamSimple` / `Models.completeSimple` calls
 * without leaking onto HTTP wire payloads. Preserved across object spread `{ ...options }`.
 */
export interface VirtualStreamRequestScope {
	readonly purpose?: ModelRoutePurpose;
	readonly isSubagent?: boolean;
	readonly boundaryContinuation?: boolean;
	readonly turnIndex?: number;
	/** Forward `disableContinuation` onto `SimpleStreamOptions` even for physical models (e.g. guarded forks). */
	readonly disableContinuation?: boolean;
	readonly failed?: AssistantMessage;
	/** Delivered as `request.state` to `VirtualModelDefinition.route(request)` (e.g. `BatonStateDoc` + active slices). */
	readonly state?: unknown;
	/** Delivered as `request.cache` to `VirtualModelDefinition.route(request)` (from `computeContextCacheSnapshot`). */
	readonly cache?: ModelRouteCacheSnapshot;
	/** Pre-resolved route bundle when the host hook (`beforeRequest`) already invoked `prepareVirtualRoute()`. */
	readonly prepared?: PreparedVirtualRoute;
	/** When true, skip firing `onOutcome` on stream end so the host can include `toolResults` after `afterTools`. */
	readonly deferOutcomeToHost?: boolean;
	readonly onStateChange?: (state: unknown) => Promise<void> | void;
	readonly onRouteCommitted?: (route: ModelRoute) => void;
	readonly onComplete?: (completion: RoutedStreamCompletion) => Promise<void> | void;
	readonly onSidecarUsage?: SidecarUsageRecorder;
	readonly setStatus?: (label: string | undefined) => void;
}

/** Extended options accepted by `VirtualModels.streamSimple` and `completeSimple`. */
export interface VirtualStreamOptions extends ModelsSimpleStreamOptions {
	purpose?: ModelRoutePurpose;
	isSubagent?: boolean;
	boundaryContinuation?: boolean;
	turnIndex?: number;
	failed?: AssistantMessage;
	state?: unknown;
	cache?: ModelRouteCacheSnapshot;
	onSidecarUsage?: SidecarUsageRecorder;
	setStatus?: (label: string | undefined) => void;
}

/** Options accepted by `withVirtualModelRouting()`. */
export interface WithVirtualModelRoutingOptions {
	/** Optional initial virtual models to register immediately. */
	readonly models?: readonly VirtualModelDefinition[];
	/** Optional host auth-availability check override per provider ID. */
	readonly hasConfiguredAuth?: (providerId: string) => Promise<boolean> | boolean;
}

/** `Models` wrapper with virtual-model registration, lookup, pre-resolution, and routed dispatch. */
export interface VirtualModels extends Models {
	registerVirtualModel(definition: VirtualModelDefinition): void;
	unregisterVirtualModel(providerId: string, modelId: string): boolean;
	getDefinition(provider: string, id: string): VirtualModelDefinition | undefined;
	getVirtualModelDefinition(providerId: string, modelId: string): VirtualModelDefinition | undefined;
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined;
	resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: ResolveVirtualModelOptions,
	): Promise<ModelRoute>;
	prepareVirtualRoute(
		model: Model<Api>,
		messages: readonly Message[],
		options: ResolveVirtualModelOptions,
	): Promise<PreparedVirtualRoute>;
	requirePhysicalTarget(virtualName: string, providerId: string, modelId: string): Promise<Model<Api>>;
}
