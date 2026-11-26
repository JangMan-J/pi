import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Api, Model, Models, ModelThinkingLevel, Tool, Usage } from "@earendil-works/pi-ai";
import type {
	Agent,
	AgentState,
	CompactionSettings,
	ContextView,
	ConversationId,
	ConversationInit,
	ConversationOwnership,
	EntryId,
	Extension,
	HarnessSettings,
	HookApi,
	ModelRef,
	RegistryReader,
	Seq,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ModelRouteRequest, VirtualModelDefinition, VirtualModels } from "../core/types.ts";
import type { CacheGuardedForkOptions } from "../durable/docs.ts";

export type BatonThinkingLevel = "off" | "minimal" | "low";

export interface PutArtifactOptions {
	readonly toolName: string;
	readonly sourcePath?: string;
	readonly cwd?: string;
	readonly label?: string;
	readonly nowMs?: number;
	/** When false, store the blob for recall without binding `artifact_sources` / `sourceSha256`. Default: true. */
	readonly bindSource?: boolean;
}

export type ArtifactMeta = {
	readonly ref: string;
	readonly sha256: string;
	readonly toolName: string;
	readonly byteLen: number;
	readonly lineCount: number;
	readonly sourcePath?: string;
	readonly sourceSha256?: string;
	readonly label?: string;
	readonly createdAtMs: number;
};

export interface RecallOptions {
	readonly ref: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly query?: string;
	readonly contextLines?: number;
	readonly maxLines?: number;
	readonly cwd?: string;
}

export interface RecallResult {
	readonly found: boolean;
	readonly meta?: ArtifactMeta;
	readonly staleSource?: {
		readonly path: string;
		readonly snapshotSha256: string;
		readonly currentSha256: string | null;
	};
	readonly text: string;
	readonly returnedLines: number;
}

export interface StoredArtifactEntry {
	readonly meta: ArtifactMeta;
	readonly text: string;
}

export interface LiveFileSnapshot {
	readonly text: string;
	readonly sha256: string;
}

export interface SlidingWindowArtifactStore {
	put(rawText: string, options: PutArtifactOptions): ArtifactMeta | Promise<ArtifactMeta>;
	recall(options: RecallOptions): RecallResult | Promise<RecallResult>;
	getMeta?(rawRef: string): ArtifactMeta | undefined | Promise<ArtifactMeta | undefined>;
	listRecent?(limit?: number): ArtifactMeta[] | Promise<ArtifactMeta[]>;
	readFullText?(rawRef: string): string | undefined | Promise<string | undefined>;
	getLatestBySourcePath?(
		sourcePath: string,
		cwd?: string,
	): StoredArtifactEntry | undefined | Promise<StoredArtifactEntry | undefined>;
	readLiveFile?(
		sourcePath: string,
		cwd?: string,
	): LiveFileSnapshot | undefined | Promise<LiveFileSnapshot | undefined>;
	close?(): void | Promise<void>;
}

export type ReadRecord = {
	readonly path: string;
	readonly ref?: string;
	readonly sha256?: string;
	readonly sourceSha256?: string;
	readonly lines?: number;
	readonly turn?: number;
	readonly lastTurn: number;
};

export type EditRecord = {
	readonly path: string;
	readonly op: "edit" | "write";
	readonly lastTurn: number;
};

/** Zero-LLM facts, updated deterministically after every tool call. */
export type MechanicalLedger = {
	readonly epoch: number;
	readonly turnCount: number;
	readonly filesRead: ReadRecord[];
	readonly filesEdited: EditRecord[];
	readonly recentRefs: ArtifactMeta[];
	readonly recentErrors: string[];
	readonly lastProseDigest?: string;
};

export interface RawTurn {
	readonly id: string;
	readonly role: "user" | "assistant" | "toolResult" | "other";
	readonly text: string;
	readonly toolCalls?: Array<{ readonly name: string; readonly label?: string }>;
	readonly estimatedTokens: number;
	/** True where a cut may begin: a user message with no pending tool results following it. */
	readonly safeCutPoint: boolean;
}

export interface SwapProjectionInput {
	readonly reportedTokens: number;
	readonly estimatedPrompt: number;
	readonly estimatedDropped: number;
	readonly estimatedTrailing: number;
	readonly summaryTokens: number;
	readonly estimatedAdded?: number;
}

export interface SwapProbe {
	readonly epoch: number;
	readonly estimated: number;
	readonly actual?: number;
}

export interface StagedSlice {
	readonly key: string;
	readonly path: string;
	readonly ref: string;
	readonly text: string;
	readonly bytes: number;
	ttlTurns: number;
}

export interface SymbolSpan {
	readonly kind: string;
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface BuildPreviewOptions {
	readonly toolName: string;
	readonly rawText: string;
	readonly meta: ArtifactMeta;
	readonly isError?: boolean;
	readonly stagedInEphemeralTail?: boolean;
}

export interface SlidingWindowBounds {
	readonly softCeilingTokens: number;
	readonly hardCeilingTokens: number;
	readonly keepRecentTokens: number;
}

export interface SlidingWindowConfig {
	readonly softCeilingTokens: number;
	readonly hardCeilingTokens: number;
	readonly keepRecentTokens: number;
	readonly softCeilingRatio: number;
	readonly hardCeilingRatio: number;
	readonly keepRecentRatio?: number;
	readonly keepTail: boolean;
	readonly batonModel: string;
	readonly batonThinkingLevel: BatonThinkingLevel;
	readonly batonMaxTokens: number;
	readonly spillEnabled: boolean;
	readonly spillThresholdBytes: number;
	readonly readSpillThresholdBytes: number;
	readonly searchSpillThresholdBytes: number;
	readonly toolThresholds?: Readonly<Record<string, number>>;
	readonly stageReadSlices: boolean;
	readonly maxStageBytes: number;
	readonly sliceTtlTurns: number;
}

export interface SlidingWindowTargetContext {
	readonly conversationId?: ConversationId;
	readonly agent?: Agent;
	readonly models?: Models;
	readonly routeRequest?: ModelRouteRequest;
}

export type SlidingWindowTarget =
	| Model<Api>
	| ModelRef
	| ((ctx: SlidingWindowTargetContext) => Model<Api> | ModelRef | undefined);

export interface SlidingWindowSectionContext {
	readonly conversationId: ConversationId;
	readonly epoch: number;
	readonly ledger: MechanicalLedger;
	readonly fallback: boolean;
	readonly api: HookApi;
	readonly context: Context;
}

export interface SlidingWindowBeforeSwapContext extends SlidingWindowSectionContext {
	readonly view: ContextView;
	readonly keepFrom: EntryId | null;
	readonly proseDigest: string;
	readonly summary: string;
	readonly tokensBefore: number;
	readonly keptTokens: number;
}

export interface SlidingWindowBeforeSwapResult {
	readonly cancel?: boolean;
	readonly summary?: string;
	readonly extraSections?: readonly string[];
	readonly data?: JsonValue;
}

export interface SlidingWindowPreviewContext {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
	readonly rawText: string;
	readonly isError: boolean;
	readonly meta: ArtifactMeta;
	readonly stagedInEphemeralTail: boolean;
}

export interface SlidingWindowOptions {
	/** Dynamic enable/disable toggle. Recall tool declaration stays registered for prompt-cache stability. Default: true. */
	readonly enabled?: boolean | ((conversationId: ConversationId) => boolean);
	/** Dynamic physical target model or resolver; when omitted, resolves from AgentDoc.model per turn. */
	readonly target?: SlidingWindowTarget;
	/** Virtual model catalog identity registered by wrapModels(). Default: { provider: "sliding-window", id: "active", name: "Sliding Window" }. */
	readonly virtualModel?: { readonly provider?: string; readonly id?: string; readonly name?: string };
	/** Working directory used for path normalization and stale-source file checks. */
	readonly cwd?: string;
	/** Custom extension name. Default: "pi.sliding-window". */
	readonly extensionName?: string;

	// Window & ceiling bounds
	readonly softCeilingTokens?: number;
	readonly hardCeilingTokens?: number;
	readonly keepRecentTokens?: number;
	readonly softCeilingRatio?: number;
	readonly hardCeilingRatio?: number;
	readonly keepRecentRatio?: number;
	readonly keepTail?: boolean;
	readonly anchorFirstUser?: boolean | ((model: Model<Api> | ModelRef | undefined) => boolean);

	// Background baton helper
	readonly batonModel?: string;
	readonly batonThinkingLevel?: BatonThinkingLevel;
	readonly batonMaxTokens?: number;

	// Pre-commit spill & ephemeral staging
	readonly spillEnabled?: boolean;
	readonly spillThresholdBytes?: number;
	readonly readSpillThresholdBytes?: number;
	readonly searchSpillThresholdBytes?: number;
	readonly toolThresholds?: Readonly<Record<string, number>>;
	readonly stageReadSlices?: boolean;
	readonly maxStageBytes?: number;
	readonly sliceTtlTurns?: number;
	readonly artifactStore?: SlidingWindowArtifactStore;

	/** Maximum number of per-conversation in-memory states to retain in LRU order. Default: 256. */
	readonly maxTrackedConversations?: number;

	// Generic extensibility hooks
	readonly renderExtraSections?: (
		ctx: SlidingWindowSectionContext,
	) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
	readonly onBeforeSwap?: (
		ctx: SlidingWindowBeforeSwapContext,
	) => SlidingWindowBeforeSwapResult | undefined | Promise<SlidingWindowBeforeSwapResult | undefined>;
	readonly previewToolOutput?: (ctx: SlidingWindowPreviewContext) => string | undefined | Promise<string | undefined>;
}

export type SlidingWindowHydratePolicy = {
	allowedPaths: string[];
	hydratedPaths: string[];
	maxHydrateBytes?: number;
};

export type SlidingWindowStateValue = {
	enabled?: boolean;
	hydrate?: SlidingWindowHydratePolicy;
};

export type CheckpointLineageValue = {
	parentConversationId?: ConversationId;
	atEntryId?: EntryId;
	atSeq?: Seq;
	sliceId?: string;
	allowedPaths?: string[];
};

export type SlidingWindowTargetValue = {
	target?: ModelRef;
};

/**
 * Options of `seedCheckpointedConversation()`: a fresh conversation seeded from a parent's checkpoint at one
 * entry. Fields the seed does not name follow the parent's `asOf` state; `modelTools`, `extensions`, and `maxTurns`
 * are never inherited, and a task-owned conversation's copied `pi.agent` is replaced whole.
 */
export type SeedCheckpointedConversationOptions = {
	readonly ownership: ConversationOwnership;
	readonly sliceId?: string;
	/** System prompt; omitted: the parent's `asOf` `pi.agent.instructions`, and no instructions section when unset. */
	readonly systemPrompt?: string;
	/** Child tools (declaration or registration); falls back to the parent's `asOf` declared tools. */
	readonly tools?: readonly (Tool | ToolRegistration)[];
	readonly modelTools?: AgentState["modelTools"];
	readonly extensions?: AgentState["extensions"];
	readonly taskPrompt: string;
	readonly dispatchSummary?: string;
	readonly studyNotes?: string;
	readonly targetModel?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly cwd?: string;
	readonly maxTurns?: number;
	readonly compaction?: CompactionSettings;
	readonly allowedTools?: readonly string[];
	readonly blockedToolReason?: string;
	readonly allowedPaths?: readonly string[];
	readonly maxHydrateBytes?: number;
	readonly slidingWindow?: boolean;
	/** Optional virtual sliding-window catalog ref (`AgentDoc.model`); defaults to `sliding-window/active` when registered and `slidingWindow !== false`. */
	readonly slidingWindowModel?: ModelRef;
	readonly copyProviderSession?: boolean;
	readonly preserveToolDeclarations?: boolean;
	readonly disableContinuation?: boolean;
	readonly preserveThinkingLevel?: boolean;
	readonly parentThinkingLevel?: ModelThinkingLevel;
	readonly preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	readonly allowThinkingEpochFlip?: boolean;
	/** Model catalog and registry of the seed, defaulting to the Harness's own. */
	readonly models?: Models;
	readonly registry?: RegistryReader;
	readonly settings?: HarnessSettings;
	/** Runs in the creating commit after the seed; table reads throw there. */
	readonly init?: ConversationInit;
};

export interface SlidingWindowInspection {
	readonly enabled: boolean;
	readonly epoch: number;
	readonly note: string;
	readonly lastUsageTokens: number | undefined;
	readonly probe: SwapProbe | undefined;
	readonly ledger: MechanicalLedger;
	readonly stagedSlices: number;
	readonly bounds: SlidingWindowBounds;
}

export interface SlidingWindowHandle {
	readonly extension: Extension;
	readonly recallTool: ToolRegistration;
	readonly virtualModel: VirtualModelDefinition;
	readonly selection: ModelRef;
	wrapModels<TModels extends Models>(models: TModels): VirtualModels;
	inspect(conversationId: ConversationId | string): SlidingWindowInspection;
	setEnabled(enabled: boolean, conversationId?: ConversationId | string): void;
	release(conversationId: ConversationId | string): void;
	close(): Promise<void>;
}

export interface SlidingWindowForkOptions extends CacheGuardedForkOptions {
	/** Copy parent's ProviderDoc.sessionId onto the fork for warm shard affinity. Default: true. */
	readonly copyProviderSession?: boolean;
	/** Preserve parent's non-"off" thinking level against accidental "off" resets. Default: true. */
	readonly preserveThinkingLevel?: boolean;
	/** Inherit parent's BatonStateDoc as of `at`. Set false to start the fork at epoch 0. Default: true. */
	readonly inheritBatonState?: boolean;
	/** Enable or disable sliding-window management on the fork (written to SlidingWindowStateDoc, fork: "initial"). */
	readonly slidingWindow?: boolean;
	/** Optional initial per-conversation target override written to SlidingWindowTargetDoc on the fork. */
	readonly target?: ModelRef;
}

export interface BatonResult {
	readonly proseDigest: string;
	readonly model: Model<Api>;
	readonly usage: Usage;
	readonly durationMs: number;
}
