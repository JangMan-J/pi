/**
 * Framework-agnostic virtual-model catalog types, presentation helpers, and route catalog composition.
 *
 * A virtual model appears in a `Provider`/`Models` catalog with `api: "pi-virtual"` and routes each
 * request to a physical model and optional per-request envelope before dispatch.
 */
import { lazyStream } from "./api/lazy.ts";
import { ModelsError } from "./auth/resolve.ts";
import type { Provider } from "./models.ts";
import type {
	AnyModel,
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	ModelThinkingLevel,
	TextContent,
	ThinkingContent,
	ThinkingLevelMap,
	ToolCall,
	ToolResultMessage,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { isModelType } from "./utils/model-operations.ts";

/** API id of virtual catalog entries. Requests for it fail unless routed first. */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Default prompt-cache TTL assumed when cache activity is observed without explicit provider metadata. */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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

export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

/** Whether a route suppresses streamed assistant text and thinking on presentation surfaces. */
export function isStreamSuppressedRoute(route: Pick<ModelRoute, "suppressStream" | "suppressTextDisplay">): boolean {
	return route.suppressStream === true || route.suppressTextDisplay === true;
}

/** Latest successful response. Its model is physical: failed or aborted requests are skipped. */
export function findLatestResponse<TMessage extends { role: string }>(
	messages: readonly TMessage[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			message &&
			message.role === "assistant" &&
			"stopReason" in message &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted"
		) {
			return message as unknown as AssistantMessage;
		}
	}
	return undefined;
}

/** Presentation-only metadata attached to an assistant message when stream text display is suppressed. */
type PresentedAssistantMessage = AssistantMessage & { suppressTextDisplay?: boolean };

/** Mark a routed response as stream-suppressed without replacing its canonical identity. */
export function suppressAssistantText(message: AssistantMessage): void {
	(message as PresentedAssistantMessage).suppressTextDisplay = true;
}

/** Project a message for display; canonical history and model context stay untouched. */
export function presentAssistantMessage<TMessage extends { role: string }>(message: TMessage): TMessage {
	if (message.role !== "assistant" || !(message as unknown as PresentedAssistantMessage).suppressTextDisplay) {
		return message;
	}
	const assistant = message as unknown as AssistantMessage;
	return {
		...assistant,
		content: assistant.content.filter((block) => block.type !== "text" && block.type !== "thinking"),
	} as unknown as TMessage;
}

/** True when the message is a routed turn whose prose and thinking never reach presentation surfaces. */
export function isTextSuppressed(message: { role: string }): boolean {
	return (
		message.role === "assistant" && Boolean((message as unknown as PresentedAssistantMessage).suppressTextDisplay)
	);
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
export function unroutedVirtualStream(model: Model<Api>): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		throw new ModelsError("stream", `Virtual model ${model.provider}/${model.id} must be routed before streaming`);
	});
}

/**
 * Add virtual models to a provider's catalog. Without a provider, the result is a keyless provider
 * that only lists the virtual models. A virtual model hides a physical chat model with the same id.
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
			stream: unroutedVirtualStream,
			streamSimple: unroutedVirtualStream,
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
		stream: (model, context: TranscriptContext, options) =>
			isVirtualModel(model) ? unroutedVirtualStream(model) : provider.stream(model, context, options),
		streamSimple: (model, context, options) =>
			isVirtualModel(model) ? unroutedVirtualStream(model) : provider.streamSimple(model, context, options),
	};
}

/** Options controlling post-read study-note harvesting across reasoning and commentary models. */
export interface StudyNoteHarvestOptions {
	/** Keep notes from turns immediately following a non-error read matching one of these paths/globs (omitted = any non-error read). */
	readonly relevantPaths?: readonly string[];
	/** Minimum non-heading chars in `block.thinking` before falling back to pre-tool `commentary` text. Default: 100. */
	readonly minThinkingChars?: number;
	/** Tail cap per harvested block so raw-CoT models (DeepSeek V4) do not flood executor prefills. Default: 1500. */
	readonly maxCharsPerBlock?: number;
	/** Read tool names recognized on preceding ToolResultMessages. Default: ["read", "tool_read"]. */
	readonly readToolNames?: readonly string[];
}

/** System-prompt guidance for encrypted-reasoning models so pre-tool `commentary` carries durable technical notes. */
export const ENCRYPTED_REASONING_COMMENTARY_PROMPT =
	"After each file-read batch, state 2-3 concise sentences of technical invariants and cross-file constraints before your next tool call.";

const DEFAULT_READ_TOOL_NAMES = ["read", "tool_read"] as const;

function normalizePosixStudyPath(raw: string): { path: string; isAbsolute: boolean } {
	const slash = raw.trim().replaceAll("\\", "/");
	const driveMatch = /^[A-Za-z]:\//.exec(slash);
	const prefix = driveMatch ? driveMatch[0] : slash.startsWith("/") ? "/" : "";
	const body = prefix ? slash.slice(prefix.length) : slash;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (!prefix) parts.push("..");
			continue;
		}
		parts.push(part);
	}
	const joined = parts.join("/");
	if (prefix) return { path: `${prefix}${joined}`, isAbsolute: true };
	return { path: joined || ".", isAbsolute: false };
}

function globPatternToRegex(pattern: string, isAbsolute: boolean): RegExp {
	let body = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					body += "(?:.*/)?";
					i += 2;
				} else {
					body += ".*";
					i += 1;
				}
			} else {
				body += "[^/]*";
			}
		} else if (ch === "?") {
			body += "[^/]";
		} else if ("\\.^$+()[]{}|".includes(ch)) {
			body += `\\${ch}`;
		} else {
			body += ch;
		}
	}
	return isAbsolute ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`);
}

function matchesStudyPath(actualRaw: string, patterns: readonly string[]): boolean {
	const actual = normalizePosixStudyPath(actualRaw);
	if (!actual.path || actual.path === ".") return false;
	for (const rawPattern of patterns) {
		if (!rawPattern.trim()) continue;
		const pattern = normalizePosixStudyPath(rawPattern);
		if (!pattern.path || pattern.path === ".") continue;
		if (pattern.path.includes("*") || pattern.path.includes("?")) {
			if (globPatternToRegex(pattern.path, pattern.isAbsolute).test(actual.path)) return true;
			continue;
		}
		if (actual.path === pattern.path) return true;
		if (actual.path.startsWith(`${pattern.path}/`)) return true;
		if (
			!pattern.isAbsolute &&
			(actual.path.endsWith(`/${pattern.path}`) || actual.path.includes(`/${pattern.path}/`))
		) {
			return true;
		}
	}
	return false;
}

function extractReadPathArg(args: ToolCall["arguments"]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function parseTextPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
	if (!signature || !signature.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
		if (parsed.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) {
			return parsed.phase;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function cleanThinkingNote(blocks: readonly ThinkingContent[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.redacted) continue;
		const stripped = block.thinking
			.replace(/^\s*\*\*[^\n]+\*\*\s*$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (stripped.length > 0) parts.push(stripped);
	}
	return parts.join("\n\n");
}

function extractCommentaryNote(blocks: readonly TextContent[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (parseTextPhase(block.textSignature) === "final_answer") continue;
		const trimmed = block.text.trim();
		if (trimmed.length > 0) parts.push(trimmed);
	}
	return parts.join("\n\n");
}

function escapeStudyNotesFence(text: string): string {
	return text.replace(/<\/study_notes/gi, "<\\/study_notes");
}

/**
 * Harvest chronological post-read reasoning or pre-tool commentary notes across all model families
 * into a fence-escaped `<study_notes>` XML block suitable for checkpoint fork handoffs.
 */
export function harvestPostReadStudyNotes(
	messages: readonly Message[],
	options?: StudyNoteHarvestOptions,
): string | undefined {
	const minThinkingChars = options?.minThinkingChars ?? 100;
	const maxCharsPerBlock = options?.maxCharsPerBlock ?? 1500;
	if (maxCharsPerBlock <= 0) return undefined;

	const readTools = new Set((options?.readToolNames ?? DEFAULT_READ_TOOL_NAMES).map((name) => name.toLowerCase()));
	const relevantPaths = options?.relevantPaths;
	const toolCallById = new Map<string, { name: string; path?: string }>();
	let precedingReads: Array<{ path?: string }> = [];
	const entries: string[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			continue;
		}
		if (msg.role === "user") {
			precedingReads = [];
			continue;
		}
		if (msg.role === "toolResult") {
			const paired = toolCallById.get(msg.toolCallId);
			const toolName = paired?.name ?? msg.toolName;
			if (!msg.isError && readTools.has(toolName.toLowerCase())) {
				if (relevantPaths === undefined) {
					precedingReads.push({ path: paired?.path });
				} else if (paired?.path && matchesStudyPath(paired.path, relevantPaths)) {
					precedingReads.push({ path: paired.path });
				}
			}
			continue;
		}
		if (msg.role === "assistant") {
			const reads = precedingReads;
			precedingReads = [];

			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				if (block.type === "toolCall") {
					toolCallById.set(block.id, { name: block.name, path: extractReadPathArg(block.arguments) });
				}
			}

			if (reads.length === 0 || msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}

			const thinkingBlocks = content.filter((block): block is ThinkingContent => block.type === "thinking");
			const cleanedThinking = cleanThinkingNote(thinkingBlocks);

			let note = "";
			if (cleanedThinking.length >= minThinkingChars) {
				if (cleanedThinking.length > maxCharsPerBlock) {
					const sliced = cleanedThinking.slice(-maxCharsPerBlock);
					note = sliced.trimStart() || sliced;
				} else {
					note = cleanedThinking;
				}
			} else if (content.some((block) => block.type === "toolCall")) {
				const textBlocks = content.filter((block): block is TextContent => block.type === "text");
				const commentary = extractCommentaryNote(textBlocks);
				if (commentary.length > 0) {
					note =
						commentary.length > maxCharsPerBlock ? commentary.slice(0, maxCharsPerBlock).trimEnd() : commentary;
				}
			}

			if (!note) continue;

			const uniquePaths: string[] = [];
			const seenPaths = new Set<string>();
			for (const read of reads) {
				if (!read.path || seenPaths.has(read.path)) continue;
				seenPaths.add(read.path);
				uniquePaths.push(read.path);
			}
			const pathsLabel = uniquePaths.length > 0 ? uniquePaths.join(", ") : "files";
			entries.push(`[after reading ${escapeStudyNotesFence(pathsLabel)}]\n${escapeStudyNotesFence(note)}`);
		}
	}

	if (entries.length === 0) return undefined;
	return `<study_notes>\n${entries.join("\n\n")}\n</study_notes>`;
}
