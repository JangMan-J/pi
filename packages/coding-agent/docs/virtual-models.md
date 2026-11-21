# Virtual Models

A virtual model is a selectable catalog entry that routes each request to a physical model and shapes its execution envelope. Use one to route by task, KV-cache locality, latency, or provider health while the user selects a single model.

Register virtual models from an [extension](extensions.md) or via `modelRuntime.registerVirtualModel()`. They appear in `/model`, `--model`, scoped models, and settings like any other model. A virtual model can be listed under any provider, including one with physical models, such as `openai-codex/auto`.

## Selection and dispatch

A virtual model separates selection from physical dispatch:

```
selected (virtual model, virtual level)  ->  dispatched (physical model, physical level, envelope)
router/auto:low                          ->  anthropic/claude-sonnet-4-5:high
```

The virtual thinking level is an input to the router; its meaning is up to the router.

| | Selection | Dispatch |
|---|---|---|
| Recorded in | `model_change` and `thinking_level_change` entries | Each assistant message: `provider`, `api`, `model`, `thinkingLevel` |
| Visible as | `ctx.model`, `ctx.thinkingLevel`, `PI_MODEL`, `PI_REASONING_LEVEL`, `/model` | `ctx.routedModel`, `session.routedModel`, and each response's assistant message |

Providers only receive physical models. Resuming a session restores the virtual selection from its latest `model_change` entry, falling back to the physical model that answered last if the virtual model is no longer registered.

In interactive mode, the footer shows the active routed model next to the selection (`auto • high → claude-sonnet-4-5 • medium`), checks subscription status against the routed model, and `/session` attributes costs per physical model (including sidecar usage from hedging, draft validation, and prompt-cache warming).

Context limits (`getContextUsage()`, image resizing, compaction checks) reflect the active physical route immediately once `route()` resolves. If a request routes to a model whose context window is smaller than the current projection, Pi compacts before sending the request while preserving the chosen route. `CacheWarmer` keeps the active physical route's prompt cache warm across idle pauses unless `keepCacheWarm: false` is set on the route.

## Register a virtual model

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerVirtualModel<{ failures: number }>({
    provider: "router",
    id: "auto",
    name: "Auto",
    thinkingLevels: ["low", "high"],
    route(request, ctx) {
      // Stay sticky when a physical model already has warm prompt-cache tokens.
      if (request.purpose === "continuation" && request.previous) {
        return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? "medium" };
      }
      if (request.purpose === "compaction" || request.purpose === "branch_summary") {
        return { model: ctx.modelRegistry.find("anthropic", "claude-haiku-4-5")!, thinkingLevel: "off" };
      }
      const escalate = (request.state?.failures ?? 0) > 0 || request.thinkingLevel === "high";
      const id = escalate ? "claude-sonnet-4-5" : "claude-haiku-4-5";
      return {
        model: ctx.modelRegistry.find("anthropic", id)!,
        thinkingLevel: escalate ? "high" : "medium",
        ttfbTimeoutMs: 8000,
      };
    },
    onOutcome(outcome) {
      if (outcome.toolResults.some((r) => r.isError)) {
        return { failures: (outcome.state?.failures ?? 0) + 1 };
      }
    },
  });
}
```

## Request inputs (`ModelRouteRequest`)

`route(request, ctx)` runs before every request made with the virtual model:

| Field | Meaning |
|---|---|
| `model`, `thinkingLevel` | Selected virtual model and level |
| `purpose` | Exact harness operation: `"prompt" \| "continuation" \| "retry" \| "compaction" \| "branch_summary" \| "subagent" \| "direct"` |
| `reason` | Coarse category: `"user" \| "continuation" \| "retry" \| "direct"` (`turn_end` and `agent_before_settle` `continue: true` stay `"continuation"` even when `context_edit: null` drops the prior assistant message, with `boundaryContinuation: true`) |
| `isSubagent` | `true` when routing inside a subagent session (`sessionRole: "subagent"` or `PI_SUBAGENT=1`) |
| `turnIndex` | Zero-based turn index within the current agent run (`0` outside a run) |
| `previous` | `{ model, thinkingLevel, message }` of the latest successful response in `messages` |
| `failed` | For `retry`: `{ model, thinkingLevel, message }` of the failed physical attempt |
| `state` | Router state stored on this session branch (passed read-only on `compaction`, `branch_summary`, and `direct` calls) |
| `cache` | Live KV-cache snapshot on the branch: `cacheFreeBoundary`, `boundaryReason` (`"initial" \| "compaction" \| "branch_summary" \| "expired"`), `entries`, and `cache.get(provider, modelId)` returning `{ warmTokens, lastRefreshedAtMs, expiresAtMs }` |
| `messages` | Outbound LLM conversation for this request |
| `signal` | Request abort signal |
| `setStatus(label)` | Update the live working indicator while async routing runs |

## Ephemeral single-request envelope (`ModelRoute`)

`route()` returns `{ model, thinkingLevel }` plus any optional per-request overrides. Ephemeral overrides apply only to that single outbound call and are never written to `SessionManager`:

| Field | Meaning |
|---|---|
| `state` | Next router state (stored when changed on stateful purposes; return `undefined` or `request.state` to keep unchanged) |
| `messages` | Replacement `Message[]` slice or `(messages) => Message[]` transform for this call |
| `systemPromptPrefix`, `systemAppend` | Ephemeral text prepended or appended to `system[0]` |
| `ephemeralTail` | One-shot trailing `string` (sent as a `user` message) or `Message[]` appended to this call only (on Anthropic, the conversation `cache_control` breakpoint stays anchored on the preceding canonical block rather than the throwaway tail) |
| `allowedTools`, `blockedToolReason` | Filters outbound `toolsAdded` declarations and blocks disallowed tool calls in `_beforeToolCall` without mutating `agent.state.tools` |
| `toolChoice` | `"auto" \| "none" \| "required"` for this call |
| `maxTokens`, `temperature` | Per-request output token cap and temperature |
| `sessionId` | Per-request provider session / cache-affinity ID override |
| `disableContinuation` | Skips server-side thread/WebSocket continuation state for this call (set automatically on hedged backup legs) |
| `ttfbTimeoutMs` | Aborts stalled providers before first content with a retryable timeout error |
| `keepCacheWarm` | Set `false` to skip `CacheWarmer` for one-off routes (defaults to `true`) |
| `statusLabel` | Working indicator message shown while this routed request streams |
| `suppressStream` | Hides assistant text and thinking from TUI, print, JSON, and `getLastAssistantText()` while preserving tool calls and canonical history (`suppressTextDisplay` is supported as an alias) |
| `hedge` | `{ afterMs, model, thinkingLevel? }`: races `model` if primary emits no content within `afterMs`, aborts the loser, and records loser tokens as `"hedge"` usage |
| `validate` | `(candidate) => { action: "accept", state? } \| { action: "escalate", model, ... }`: buffers non-tool responses before display and either emits or escalates cleanly (recording discarded candidate tokens as `"draft"` usage) |

## Stream-level tier (`stream`) and closed loop (`onOutcome`)

- **`stream?(request, ctx)`**: Optional full stream-tier hook for custom multi-model racing or speculation. `request.dispatch(route)` runs a physical route through auth and ephemeral projection; `request.recordUsage(kind, provider, modelId, usage, note?)` attributes sidecar tokens without adding messages; `request.setState(state)` persists router state.
- **`onOutcome?(outcome, ctx)`**: Invoked after every routed physical response (and its tool batch, or error/abort) with `{ virtualModel, route, purpose, turnIndex, message, toolResults, ttfbMs, durationMs, aborted, state }`. Returning a new state persists it on the session branch.
- **`pi.setVirtualModelState(provider, id, state)`**: Explicitly persists router state from any extension command or hook.
- **`pi.appendUsage(kind, provider, model, usage, note?)`**: Records background helper or sidecar model usage in the session ledger without adding a conversation message.
- **`ctx.getRouteCacheSnapshot()`**: Reads unexpired prompt-cache state (`warmTokens`, `expiresAtMs`, `cacheFreeBoundary`) from any extension boundary or hook.
