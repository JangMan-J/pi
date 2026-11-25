import type { JsonRepresentation, JsonValue } from "@earendil-works/chord/json";
import type { ModelThinkingLevel, UserMessage } from "@earendil-works/pi-ai";
import { defineDoc } from "../../documents.ts";
import type { TaskId } from "../../types.ts";

/**
 * Provider KV-cache and continuation invariants stored on a cache-guarded fork (`VirtualModelStateDoc.forkGuard`)
 * and applied onto outbound routes via `applyForkGuardToRoute()`.
 */
export type ForkCacheGuard = {
	/**
	 * Suppress stateful provider continuations (`previous_response_id`, OpenAI WS `lastResponseId`, Anthropic
	 * `threadState`) so forks and `ephemeralTail` requests never mutate or mismatch Ring 1's active session state.
	 */
	disableContinuation?: boolean;
	/**
	 * Keep outbound `SystemMessage.toolsAdded` / `Context.tools` declarations frozen verbatim even when `allowedTools`
	 * restricts execution. Prevents Meta `shapeMetaWireTools()` deterministic case/collision suffix shifts
	 * (`web_search` -> `Web_search` / `_2`) and KV prefix invalidation; enforce `allowedTools` in `ToolHooks.beforeTool`.
	 */
	preserveToolDeclarations?: boolean;
	/** Tool names permitted to execute on this fork; block all others in `ToolHooks.beforeTool`. */
	allowedTools?: string[];
	/** Diagnostic text returned to the model when `ToolHooks.beforeTool` blocks a tool not in `allowedTools`. */
	blockedToolReason?: string;
	/** Thinking level active on the parent conversation when the fork was created. */
	parentThinkingLevel?: ModelThinkingLevel;
	/**
	 * Non-`"off"` fallback thinking level enforced when a route or fork attempts `"off"` inside an active thinking epoch.
	 * Prevents Kimi K3 (`thinkingFormat: "kimi"`) from flipping `thinking: { type: "enabled", keep: "all" }` to
	 * `{ type: "disabled" }`, which invalidates the prompt cache.
	 */
	preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	/**
	 * Inherited Ring 1 `ProviderDoc.sessionId` so Meta (`x-meta-ai-gateway-session-id`) and Kimi K3
	 * (`prompt_cache_key = clamp(sessionId, 64)`) route to the warm gateway shard.
	 */
	sessionId?: string;
};

/** State persisted in `VirtualModelStateDoc` for one conversation (rewindable across forks via `asOf`). */
export type VirtualModelStateValue = {
	/** Arbitrary JSON router state returned by `ModelRoute.state` / `VirtualModelDefinition.onOutcome`. */
	routeState?: JsonValue;
	/** Cache-guard invariants populated by `createCacheGuardedFork()` when this conversation is a guarded fork. */
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

/** Durable staged baton snapshot persisted in `BatonStateDoc` by `BatonPrepTask`. */
export type StagedBaton = {
	firstKeptId: string | null;
	proseDigest: string;
	keptTokens: number;
	preparedThroughId?: string;
	provider: string;
	modelId: string;
	durationMs: number;
};

/**
 * State persisted in `BatonStateDoc` across `<250k` / `1M` context handoffs ("baton passes").
 * Readable in any hook via `await api.snapshot(BatonStateDoc, api.conversationId, context)` and writable
 * inside any `HookTask` commit (`tx.doc(BatonStateDoc, runtime.conversationId)`).
 */
export type BatonStateValue = {
	/** Monotonic handoff counter (`0` before the first baton swap). */
	epoch: number;
	/**
	 * Immutable root `UserMessage` captured from turn 0 and re-emitted at `ResetEntry.model[0]`
	 * (`[anchorUser0, handoffSummary]`) on every swap. Preserves leading-message hashes placed ahead of `system`
	 * (such as Anthropic OAuth's `x-anthropic-billing-header` `cch` hash of `firstUser`).
	 */
	anchorUser0?: JsonRepresentation<UserMessage>;
	/** Latest helper-prepared summary placed after `anchorUser0` on `ResetEntry.model`. */
	handoffSummary?: string;
	/** Estimated context token count at which the latest swap fired. */
	swappedAtTokens?: number;
	/** Extension-defined JSON payload (e.g. incremental helper ledger, disk spill `ref:<digest>` index). */
	data?: JsonValue;
	/** In-flight durable `BatonPrepTask` ID, if one is currently synthesizing a staged baton. */
	preparingTaskId?: TaskId;
	/** Durably staged baton synthesis awaiting swap trigger. */
	staged?: StagedBaton;
	/** Post-read study notes harvested across aged turns for checkpoint fork continuity. */
	harvestedStudyNotes?: string;
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
