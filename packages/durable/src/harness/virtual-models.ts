import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	Models,
	ModelThinkingLevel,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	anchorAnthropicCacheBeforeEphemeralTail,
	attachVirtualRequestScope,
	DEFAULT_PROMPT_CACHE_TTL_MS,
	isStatefulRoutePurpose,
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type PreparedVirtualRoute,
	type RoutedStreamCompletion,
	type WarmCacheEntry,
} from "@earendil-works/pi-ai/virtual-models";
import { defineDoc } from "../documents.ts";
import { AssistantEntry, CompactionEntry, ResetEntry, ToolResultEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type { ConversationId, EntryId, NextTaskState, Tx } from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { defineExtension, hook, hookTask } from "./define.ts";
import { GenerationTask } from "./generation.ts";
import { LiveDoc } from "./live.ts";
import { ProviderDoc } from "./provider.ts";
import { ToolTask } from "./tool.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartResult,
	BeforeAgentStartSidecarUsage,
	ContextView,
	Conversation,
	ConversationCreateOptions,
	Extension,
	HookApi,
	HookTask,
	ModelRef,
	ToolExecutionResult,
	ToolHookCall,
} from "./types.ts";

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

/**
 * Derive an unexpired KV-cache snapshot from active durable `ContextView` entries.
 */
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

export interface CacheGuardedForkOptions extends ConversationCreateOptions {
	/**
	 * Explicit parent thinking level to preserve across the epoch. When omitted, reads `AgentDoc` of `parent`.
	 * For providers like Kimi K3 (`thinking: { type: "enabled", keep: "all" }` vs `{ type: "disabled" }`),
	 * attempts to flip from non-`"off"` down to `"off"` are automatically guarded back to non-`"off"`.
	 */
	readonly parentThinkingLevel?: ModelThinkingLevel;
	/** Replacement non-`"off"` thinking level when guarding an `"off"` downgrade (defaults to parent's level). */
	readonly preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	/** Opt out of the Kimi K3 thinking epoch guard if an intentional cache-busting reset is desired. */
	readonly allowThinkingEpochFlip?: boolean;
	/** Tool allowlist enforced in `ToolHooks.beforeTool` while keeping declared wire tools frozen. */
	readonly allowedTools?: readonly string[];
	readonly blockedToolReason?: string;
	/** Default `true` on cache-guarded forks to protect WebSocket/gateway continuation state. */
	readonly disableContinuation?: boolean;
	/** Default `true` on cache-guarded forks so Meta `shapeMetaWireTools()` suffixes stay identical. */
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

/** Synchronous pure-JS FNV-1a 64-bit digest (hex) with zero `node:*` imports for browser/worker parity. */
function fnv1aHex64(input: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x811c9dc5 ^ 0x9e3779b9;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		h1 ^= code;
		h1 = Math.imul(h1, 0x01000193);
		h2 ^= code + (i & 0xff);
		h2 = Math.imul(h2, 0x01000193);
	}
	return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export interface EphemeralSliceRecord {
	readonly ref: string;
	readonly path: string;
	readonly lineRange: string;
	readonly fileHash: string;
	readonly symbolOutline?: string;
	readonly fullText: string;
	justCaptured: boolean;
	deliveredCount: number;
	turnsSinceReferenced: number;
	referencedThisTurn: boolean;
}

export interface EphemeralReceiptOptions {
	readonly enabled?: boolean;
	/** Tool names eligible for short receipt compaction (defaults to `["read", "grep", "search"]`). */
	readonly tools?: readonly string[];
	/** Successful mutating tools whose target file drops active slices (defaults to `["edit", "write"]`). */
	readonly mutationTools?: readonly string[];
	/** Minimum output text length before receipt replacement activates (defaults to `128`). */
	readonly minChars?: number;
	/** Unreferenced turns after delivery before dropping from `ephemeralTail` (defaults to `2`). */
	readonly maxIdleTurns?: number;
	/** Optional override predicate controlling whether a tool result is replaced with a receipt. */
	readonly shouldCompact?: (call: ToolHookCall, text: string) => boolean;
}

export interface VirtualModelBatonOptions {
	/** Estimated context token count at which `beforeAgentStart` triggers a baton swap (e.g. `250_000`). */
	readonly swapAfterTokens?: number;
	/** Out-of-band physical model used if no custom `summarize` function is given. */
	readonly helperModel?: ModelRef;
	/** Optional custom out-of-band baton summarizer. */
	readonly summarize?: (input: {
		readonly conversationId: ConversationId;
		readonly messages: readonly Message[];
		readonly estimatedTokens: number;
		readonly models: Models;
		readonly anchorUser?: UserMessage;
		readonly recordSidecar: (provider: string, modelId: string, usage: Usage, kind?: string) => void;
		readonly signal?: AbortSignal;
	}) => Promise<string>;
	/** Optional notification callback invoked when a baton swap is emitted. */
	readonly onSwap?: (info: {
		readonly epoch: number;
		readonly estimatedTokens: number;
		readonly summary: string;
	}) => void;
}

export interface CreateVirtualModelsExtensionOptions {
	readonly name?: string;
	readonly baton?: VirtualModelBatonOptions;
	readonly receipts?: EphemeralReceiptOptions;
	readonly cacheTtlMs?: number;
	/** Optional fallback tool allowlist when no route or forkGuard specifies one. */
	readonly defaultAllowedTools?: readonly string[];
}

type BatonSyncInput = {
	epoch: number;
	handoffSummary: string;
	swappedAtTokens: number;
	anchorUser0?: JsonRepresentation<UserMessage>;
};

const BatonSyncTask = defineTask<BatonSyncInput, { phase: "commit" }, { ok: true }>({
	name: "virtual-models.baton-sync",
	version: 1,
	initial: () => ({ phase: "commit" }),
	phases: {
		commit: async (task, runtime, context) => {
			await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, { ok: true }>> => {
				const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
				doc.epoch = task.input.epoch;
				doc.handoffSummary = task.input.handoffSummary;
				doc.swappedAtTokens = task.input.swappedAtTokens;
				if (task.input.anchorUser0 !== undefined) doc.anchorUser0 = task.input.anchorUser0;
				return { status: "terminal", outcome: { status: "completed", result: { ok: true } } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

type StateSyncInput = {
	routeState: JsonValue;
};

const VirtualStateSyncTask = defineTask<StateSyncInput, { phase: "commit" }, { ok: true }>({
	name: "virtual-models.state-sync",
	version: 1,
	initial: () => ({ phase: "commit" }),
	phases: {
		commit: async (task, runtime, context) => {
			await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, { ok: true }>> => {
				const doc = await tx.doc(VirtualModelStateDoc, runtime.conversationId);
				doc.routeState = task.input.routeState;
				return { status: "terminal", outcome: { status: "completed", result: { ok: true } } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

type ExtensionMemoryState = {
	readonly slicesByConversation: Map<ConversationId, Map<string, EphemeralSliceRecord>>;
	readonly activeRoutes: Map<ConversationId, { route: ModelRoute; prepared?: PreparedVirtualRoute }>;
	readonly pendingCompletions: Map<
		ConversationId,
		{ prepared: PreparedVirtualRoute; completion: RoutedStreamCompletion; state?: unknown }
	>;
	readonly pendingStateSyncs: Map<ConversationId, JsonValue>;
};

const EXTENSION_MEMORY = new WeakMap<Extension, ExtensionMemoryState>();

/** Inspect active in-memory `ephemeralTail` slice records for one conversation (testing/diagnostics). */
export function getActiveEphemeralSlices(
	extension: Extension,
	conversationId: ConversationId,
): readonly EphemeralSliceRecord[] {
	const mem = EXTENSION_MEMORY.get(extension);
	const byKey = mem?.slicesByConversation.get(conversationId);
	return byKey ? [...byKey.values()] : [];
}

/** Read the last routed decision observed by this extension for a conversation. */
export function getLastRoutedDecision(extension: Extension, conversationId: ConversationId): ModelRoute | undefined {
	return EXTENSION_MEMORY.get(extension)?.activeRoutes.get(conversationId)?.route;
}

function normalizePath(path: string): string {
	return path.replace(/^\.\//, "");
}

function extractToolFilePath(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;
	const raw = args.path ?? args.filePath ?? args.file_path ?? args.targetFile;
	return typeof raw === "string" && raw.length > 0 ? normalizePath(raw) : undefined;
}

function extractLineRange(args: Record<string, unknown> | undefined, text: string): string {
	const lineCount = text.length === 0 ? 0 : text.split("\n").length;
	const startRaw =
		typeof args?.offset === "number" ? args.offset : typeof args?.startLine === "number" ? args.startLine : 1;
	const limitRaw = typeof args?.limit === "number" ? args.limit : undefined;
	const endRaw =
		typeof args?.endLine === "number"
			? args.endLine
			: limitRaw !== undefined
				? startRaw + Math.max(0, limitRaw - 1)
				: startRaw + Math.max(0, lineCount - 1);
	return `${startRaw}-${endRaw}`;
}

function extractSymbolOutline(text: string): string | undefined {
	const matches: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (
			/^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum|def|fn|struct|impl)\s+[A-Za-z0-9_$]+/.test(
				trimmed,
			)
		) {
			matches.push(trimmed.slice(0, 80));
			if (matches.length >= 6) break;
		}
	}
	return matches.length > 0 ? matches.join("; ") : undefined;
}

function formatToolReceipt(
	slice: Pick<EphemeralSliceRecord, "ref" | "path" | "lineRange" | "fileHash" | "symbolOutline">,
): string {
	const lines = [
		`[receipt ${slice.ref}]`,
		`path: ${slice.path}`,
		`lines: ${slice.lineRange}`,
		`hash: ${slice.fileHash}`,
	];
	if (slice.symbolOutline) lines.push(`symbols: ${slice.symbolOutline}`);
	lines.push("(Full text buffered ephemerally in host memory; omitted from durable transcript.)");
	return lines.join("\n");
}

function formatEphemeralTail(slices: readonly EphemeralSliceRecord[]): string {
	return slices
		.map(
			(s) =>
				`<ephemeral-slice ref="${s.ref}" path="${s.path}" lines="${s.lineRange}" hash="${s.fileHash}">\n${s.fullText}\n</ephemeral-slice>`,
		)
		.join("\n\n");
}

function textMentionsSlice(text: string, slice: EphemeralSliceRecord): boolean {
	if (!text) return false;
	if (text.includes(slice.ref) || text.includes(slice.path)) return true;
	const base = slice.path.split("/").at(-1);
	return base !== undefined && base.length > 2 && text.includes(base);
}

function tailUserPromptMentionsSlice(messages: readonly Message[], slice: EphemeralSliceRecord): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role === "assistant") break;
		if (msg.role !== "user") continue;
		const text =
			typeof msg.content === "string"
				? msg.content
				: msg.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		if (textMentionsSlice(text, slice)) return true;
	}
	return false;
}

function assistantMentionsSlice(message: AssistantMessage, slice: EphemeralSliceRecord): boolean {
	for (const block of message.content) {
		if (block.type === "text" && textMentionsSlice(block.text, slice)) return true;
		if (block.type === "toolCall") {
			const call = block as ToolCall;
			if (textMentionsSlice(JSON.stringify(call.arguments ?? {}), slice)) return true;
		}
	}
	return false;
}

function extractResultText(result: ToolExecutionResult): string {
	if (!result.output) return "";
	return result.output
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function estimateContextTotal(messages: readonly Message[]): number {
	let sum = 0;
	let latestUsageTokens = 0;
	for (const message of messages) {
		sum += estimateMessageTokens(message);
		if (message.role === "assistant" && !EXCLUDED_STOP_REASONS.has(message.stopReason)) {
			latestUsageTokens = Math.max(latestUsageTokens, calculateContextTokens(message.usage));
		}
	}
	return Math.max(sum, latestUsageTokens);
}

function combineEphemeralTails(
	routeTail: string | readonly Message[] | undefined,
	sliceTailText: string | undefined,
	now: number,
): string | readonly Message[] | undefined {
	if (!sliceTailText) return routeTail;
	if (routeTail === undefined) return sliceTailText;
	if (typeof routeTail === "string") return `${routeTail}\n\n${sliceTailText}`;
	return [...routeTail, { role: "user", content: sliceTailText, timestamp: now }];
}

function applyForkGuardToRoute(
	route: ModelRoute,
	guard: ForkCacheGuard | undefined,
	sessionId: string | undefined,
): ModelRoute {
	if (!guard && !sessionId) return route;
	const guardedThinking =
		guard?.preservedThinkingLevel !== undefined && route.thinkingLevel === "off"
			? guard.preservedThinkingLevel
			: route.thinkingLevel;
	return {
		...route,
		thinkingLevel: guardedThinking,
		...(sessionId !== undefined && route.sessionId === undefined ? { sessionId } : {}),
		...(guard?.sessionId !== undefined && route.sessionId === undefined ? { sessionId: guard.sessionId } : {}),
		...(guard?.disableContinuation !== undefined ? { disableContinuation: guard.disableContinuation } : {}),
		...(guard?.preserveToolDeclarations !== undefined
			? { preserveToolDeclarations: guard.preserveToolDeclarations }
			: {}),
		...(guard?.allowedTools !== undefined ? { allowedTools: guard.allowedTools } : {}),
		...(guard?.blockedToolReason !== undefined ? { blockedToolReason: guard.blockedToolReason } : {}),
	};
}

/**
 * Create the durable Pi extension wiring virtual-model routing, cache snapshots, short tool receipts with
 * in-memory `ephemeralTail`, Anthropic `cache_control` anchoring, fork tool/session/thinking guards,
 * sidecar spend reporting, and configurable baton swaps.
 */
export function createVirtualModelsExtension(options: CreateVirtualModelsExtensionOptions = {}): Extension {
	const name = options.name ?? "virtual-models";
	const sliceTools = new Set(options.receipts?.tools ?? ["read", "grep", "search"]);
	const mutationTools = new Set(options.receipts?.mutationTools ?? ["edit", "write"]);
	const minChars = options.receipts?.minChars ?? 128;
	const maxIdleTurns = Math.max(1, options.receipts?.maxIdleTurns ?? 2);
	const receiptsEnabled = options.receipts?.enabled ?? true;

	const mem: ExtensionMemoryState = {
		slicesByConversation: new Map(),
		activeRoutes: new Map(),
		pendingCompletions: new Map(),
		pendingStateSyncs: new Map(),
	};

	const queueStateSync = (conversationId: ConversationId, state: unknown): void => {
		if (state === undefined) return;
		mem.pendingStateSyncs.set(conversationId, copyJson(state, { omitUndefinedProperties: true }));
	};

	const drainStateSyncTasks = (conversationId: ConversationId): HookTask[] => {
		const nextState = mem.pendingStateSyncs.get(conversationId);
		if (nextState === undefined) return [];
		mem.pendingStateSyncs.delete(conversationId);
		return [hookTask(VirtualStateSyncTask, { routeState: nextState })];
	};

	const deliverDeferredOutcome = async (
		conversationId: ConversationId,
		toolResults: readonly ToolResultMessage[],
	): Promise<void> => {
		const pending = mem.pendingCompletions.get(conversationId);
		if (!pending) return;
		mem.pendingCompletions.delete(conversationId);
		const onOutcome = pending.prepared.definition.onOutcome;
		if (!onOutcome) return;
		const outcome: ModelRouteOutcome = {
			virtualModel: pending.prepared.request.model,
			route: pending.completion.route,
			purpose: pending.prepared.request.purpose,
			turnIndex: pending.prepared.request.turnIndex,
			message: pending.completion.message,
			toolResults,
			ttfbMs: pending.completion.ttfbMs,
			durationMs: pending.completion.durationMs,
			aborted: pending.completion.message.stopReason === "aborted",
			state: pending.state,
		};
		const nextState = await onOutcome(outcome);
		if (nextState !== undefined && isStatefulRoutePurpose(pending.prepared.request.purpose)) {
			queueStateSync(conversationId, nextState);
		}
	};

	const ext = defineExtension({
		name,
		tasks: [BatonSyncTask, VirtualStateSyncTask],
		hooks: [
			hook(GenerationTask, {
				beforeAgentStart: async (
					event: BeforeAgentStartEvent,
					api: HookApi,
					context: Context,
				): Promise<BeforeAgentStartResult | undefined> => {
					const baton = options.baton;
					if (!baton || baton.swapAfterTokens === undefined) return undefined;
					const estimatedTokens = estimateContextTotal(event.view.messages);
					if (estimatedTokens < baton.swapAfterTokens) return undefined;

					const batonDoc = await api.snapshot(BatonStateDoc, api.conversationId, context);
					const firstUserInView = event.view.messages.find((m): m is UserMessage => m.role === "user");
					const anchorUser0 = (batonDoc?.anchorUser0 as UserMessage | undefined) ?? firstUserInView;
					const nextEpoch = (batonDoc?.epoch ?? 0) + 1;

					const sidecarUsage: BeforeAgentStartSidecarUsage[] = [];
					let summaryText: string;
					if (baton.summarize) {
						summaryText = await baton.summarize({
							conversationId: api.conversationId,
							messages: event.view.messages,
							estimatedTokens,
							models: api.models,
							anchorUser: anchorUser0,
							recordSidecar: (provider, modelId, usage, kind = "baton_helper") => {
								sidecarUsage.push({ kind, provider, modelId, usage });
							},
							signal: context.abortSignal,
						});
					} else if (baton.helperModel) {
						const helperModel = api.models.getModel(baton.helperModel.provider, baton.helperModel.modelId);
						if (!helperModel) {
							summaryText = `[Baton epoch ${nextEpoch} handoff at ~${estimatedTokens} tokens]`;
						} else {
							const helperRes = await api.models.completeSimple(helperModel, {
								systemPrompt:
									"Summarize the active engineering state concisely for a clean context baton handoff.",
								messages: [
									{
										role: "user",
										content: `Produce a concise baton handoff summary (${event.view.messages.length} messages, ~${estimatedTokens} tokens).`,
										timestamp: api.now(),
									},
								],
							});
							sidecarUsage.push({
								kind: "baton_helper",
								provider: helperRes.provider,
								modelId: helperRes.model,
								usage: helperRes.usage,
							});
							summaryText =
								helperRes.content
									.filter((b): b is { type: "text"; text: string } => b.type === "text")
									.map((b) => b.text)
									.join("\n") || `[Baton epoch ${nextEpoch} handoff at ~${estimatedTokens} tokens]`;
						}
					} else {
						summaryText = `[Baton epoch ${nextEpoch} handoff at ~${estimatedTokens} tokens]`;
					}

					const now = api.now();
					const handoffMessage: UserMessage = {
						role: "user",
						content: `<baton-handoff epoch="${nextEpoch}" tokens="${estimatedTokens}">\n${summaryText}\n</baton-handoff>`,
						timestamp: now,
					};
					const resetModel: Message[] = anchorUser0 ? [anchorUser0, handoffMessage] : [handoffMessage];
					baton.onSwap?.({ epoch: nextEpoch, estimatedTokens, summary: summaryText });

					const anchorJson = anchorUser0
						? (copyJson(anchorUser0, { omitUndefinedProperties: true }) as JsonRepresentation<UserMessage>)
						: undefined;
					return {
						reset: {
							model: resetModel,
							data: { batonEpoch: nextEpoch, swappedAtTokens: estimatedTokens },
						},
						tasks: [
							hookTask(BatonSyncTask, {
								epoch: nextEpoch,
								handoffSummary: summaryText,
								swappedAtTokens: estimatedTokens,
								...(anchorJson !== undefined ? { anchorUser0: anchorJson } : {}),
							}),
						],
						...(sidecarUsage.length > 0 ? { sidecarUsage } : {}),
					};
				},

				beforeRequest: async ({ messages }, api, context) => {
					const conversationId = api.conversationId;
					mem.pendingCompletions.delete(conversationId);
					const agent = await api.snapshot(AgentDoc, conversationId, context);
					const live = await api.snapshot(LiveDoc, conversationId, context);
					const providerDoc = await api.snapshot(ProviderDoc, conversationId, context);
					const stateDoc = await api.snapshot(VirtualModelStateDoc, conversationId, context);

					const activeSlicesMap = mem.slicesByConversation.get(conversationId);
					const activeSlices = activeSlicesMap ? [...activeSlicesMap.values()] : [];
					for (const slice of activeSlices) {
						slice.referencedThisTurn = tailUserPromptMentionsSlice(messages, slice);
						if (slice.referencedThisTurn) slice.turnsSinceReferenced = 0;
						slice.deliveredCount += 1;
					}
					const ephemeralTailText = activeSlices.length > 0 ? formatEphemeralTail(activeSlices) : undefined;

					const modelRef = agent?.model;
					const model = modelRef ? api.models.getModel(modelRef.provider, modelRef.modelId) : undefined;
					if (!model) return undefined;

					const guard = stateDoc?.forkGuard;
					const pendingState = mem.pendingStateSyncs.get(conversationId);
					const currentState = pendingState !== undefined ? pendingState : stateDoc?.routeState;
					const now = api.now();
					const getPhysical = (providerId: string, modelId: string): Model<Api> | undefined =>
						isVirtualModelsRuntime(api.models)
							? api.models.getPhysicalModel(providerId, modelId)
							: api.models.getModel(providerId, modelId);

					const cache = computeMessageCacheSnapshot(messages, getPhysical, {
						ttlMs: options.cacheTtlMs,
						now,
					});

					if (isVirtualModel(model) && isVirtualModelsRuntime(api.models)) {
						const turnIndex = live?.run?.turns ?? 0;
						const purpose: ModelRoutePurpose = turnIndex > 0 ? "continuation" : "prompt";
						const prepared = await api.models.prepareVirtualRoute(model, messages, {
							purpose,
							turnIndex,
							thinkingLevel: agent?.thinkingLevel ?? "off",
							signal: context.abortSignal,
							state: currentState,
							cache,
						});
						const guardedRoute = applyForkGuardToRoute(prepared.route, guard, providerDoc?.sessionId);
						const mergedRoute: ModelRoute = {
							...guardedRoute,
							...(ephemeralTailText
								? { ephemeralTail: combineEphemeralTails(guardedRoute.ephemeralTail, ephemeralTailText, now) }
								: {}),
						};
						const enrichedPrepared: PreparedVirtualRoute = {
							...prepared,
							route: mergedRoute,
						};
						mem.activeRoutes.set(conversationId, { route: mergedRoute, prepared: enrichedPrepared });
						const carrier = attachVirtualRequestScope(
							{ messages },
							{
								prepared: enrichedPrepared,
								cache,
								state: currentState,
								deferOutcomeToHost: true,
								onRouteCommitted: (committed) => {
									mem.activeRoutes.set(conversationId, { route: committed, prepared: enrichedPrepared });
									if (committed.state !== undefined && committed.state !== currentState) {
										queueStateSync(conversationId, committed.state);
									}
								},
								onStateChange: (nextState) => {
									queueStateSync(conversationId, nextState);
								},
								onComplete: async (completion) => {
									mem.pendingCompletions.set(conversationId, {
										prepared: enrichedPrepared,
										completion,
										state: mem.pendingStateSyncs.get(conversationId) ?? currentState,
									});
								},
							},
						);
						return carrier;
					}

					if (guard || ephemeralTailText) {
						mem.activeRoutes.set(conversationId, {
							route: applyForkGuardToRoute(
								{
									model,
									thinkingLevel: agent?.thinkingLevel ?? "off",
									...(ephemeralTailText ? { ephemeralTail: ephemeralTailText } : {}),
								},
								guard,
								providerDoc?.sessionId,
							),
						});
					} else {
						mem.activeRoutes.delete(conversationId);
					}
					if (ephemeralTailText || guard?.disableContinuation !== undefined) {
						const nextMessages = ephemeralTailText
							? [...messages, { role: "user" as const, content: ephemeralTailText, timestamp: now }]
							: messages;
						return guard?.disableContinuation !== undefined
							? attachVirtualRequestScope(
									{ messages: nextMessages },
									{ disableContinuation: guard.disableContinuation },
								)
							: { messages: nextMessages };
					}
					return undefined;
				},

				beforeProviderRequest: ({ model, payload }, api) => {
					const active = mem.activeRoutes.get(api.conversationId);
					const tail = active?.route.ephemeralTail;
					if (!tail || model.api !== "anthropic-messages") return undefined;
					return { payload: anchorAnthropicCacheBeforeEphemeralTail(payload, tail) };
				},

				afterResponse: async (message, api) => {
					const conversationId = api.conversationId;
					const slices = mem.slicesByConversation.get(conversationId);
					if (slices && message.stopReason !== "error" && message.stopReason !== "aborted") {
						for (const [key, slice] of slices.entries()) {
							if (assistantMentionsSlice(message, slice)) {
								slice.referencedThisTurn = true;
							}
							if (slice.justCaptured) {
								slice.justCaptured = false;
							} else if (slice.referencedThisTurn) {
								slice.turnsSinceReferenced = 0;
							} else {
								slice.turnsSinceReferenced += 1;
								if (slice.turnsSinceReferenced >= maxIdleTurns) slices.delete(key);
							}
							slice.referencedThisTurn = false;
						}
						if (slices.size === 0) mem.slicesByConversation.delete(conversationId);
					}
					const hasToolCalls =
						message.stopReason === "toolUse" && message.content.some((block) => block.type === "toolCall");
					if (!hasToolCalls) {
						await deliverDeferredOutcome(conversationId, []);
					}
				},

				afterTools: async (_assistantId, resultIds, api, context) => {
					const conversationId = api.conversationId;
					const toolResults: ToolResultMessage[] = [];
					for (const id of resultIds) {
						const entry = await api.entry(ToolResultEntry, id, context);
						if (!entry?.model) continue;
						for (const m of entry.model) {
							if (m.role === "toolResult") toolResults.push(m);
						}
					}
					await deliverDeferredOutcome(conversationId, toolResults);
					const tasks = drainStateSyncTasks(conversationId);
					return tasks.length > 0 ? { tasks } : undefined;
				},

				afterRun: async (_run, api) => {
					const tasks = drainStateSyncTasks(api.conversationId);
					return tasks.length > 0 ? { tasks } : undefined;
				},
			}),

			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					const conversationId = api.conversationId;
					const active = mem.activeRoutes.get(conversationId)?.route;
					const guard = (await api.snapshot(VirtualModelStateDoc, conversationId, context))?.forkGuard;
					const allowed = guard?.allowedTools ?? active?.allowedTools ?? options.defaultAllowedTools;
					if (allowed !== undefined && !allowed.includes(call.name)) {
						return {
							block:
								guard?.blockedToolReason ??
								active?.blockedToolReason ??
								`Tool "${call.name}" is blocked on this route.`,
						};
					}
					return undefined;
				},

				afterTool: async (call, result, api) => {
					if (!receiptsEnabled || result.isError) return undefined;
					const conversationId = api.conversationId;
					const args = call.arguments as Record<string, unknown> | undefined;
					const filePath = extractToolFilePath(args);

					if (mutationTools.has(call.name) && filePath !== undefined) {
						const slices = mem.slicesByConversation.get(conversationId);
						if (slices) {
							for (const [key, slice] of slices.entries()) {
								if (slice.path === filePath) slices.delete(key);
							}
							if (slices.size === 0) mem.slicesByConversation.delete(conversationId);
						}
						return undefined;
					}

					if (!sliceTools.has(call.name) || !result.output) return undefined;
					const fullText = extractResultText(result);
					const compact = options.receipts?.shouldCompact
						? options.receipts.shouldCompact(call, fullText)
						: fullText.length >= minChars;
					if (!compact) return undefined;

					const resolvedPath = filePath ?? call.name;
					const lineRange = extractLineRange(args, fullText);
					const fileHash = fnv1aHex64(fullText);
					const ref = `ref:${fnv1aHex64(`${resolvedPath}\0${lineRange}\0${fileHash}`)}`;
					const symbolOutline = extractSymbolOutline(fullText);

					let slices = mem.slicesByConversation.get(conversationId);
					if (!slices) {
						slices = new Map();
						mem.slicesByConversation.set(conversationId, slices);
					}
					const key = `${resolvedPath}#${lineRange}`;
					slices.set(key, {
						ref,
						path: resolvedPath,
						lineRange,
						fileHash,
						...(symbolOutline !== undefined ? { symbolOutline } : {}),
						fullText,
						justCaptured: true,
						deliveredCount: 0,
						turnsSinceReferenced: 0,
						referencedThisTurn: false,
					});

					return {
						...result,
						output: [
							{
								type: "text",
								text: formatToolReceipt({ ref, path: resolvedPath, lineRange, fileHash, symbolOutline }),
							},
						],
					};
				},
			}),
		],
	});

	EXTENSION_MEMORY.set(ext, mem);
	return ext;
}

export {
	attachVirtualRequestScope,
	createVirtualModel,
	isStatefulRoutePurpose,
	isVirtualModel,
	isVirtualModelsRuntime,
	presentAssistantMessage,
	suppressAssistantText,
	withVirtualModelRouting,
} from "@earendil-works/pi-ai/virtual-models";
