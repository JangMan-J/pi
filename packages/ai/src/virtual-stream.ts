/**
 * Single-request ephemeral projection, TTFB timeouts, hedging, pre-commit validation,
 * and stream-tier execution for virtual models in `@earendil-works/pi-ai`.
 */
import { clampThinkingLevel } from "./models.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	SimpleStreamOptions,
	SystemMessage,
	TranscriptContext,
	Usage,
} from "./types.ts";
import { createAssistantMessageEventStream } from "./utils/event-stream.ts";
import { contentText } from "./utils/text.ts";
import { normalizeContext } from "./utils/transcript.ts";
import type {
	ModelRoute,
	ModelRouteHedge,
	ModelRouteRequest,
	ModelRouteToolChoice,
	VirtualModelDefinition,
	VirtualStreamRequest,
} from "./virtual-models.ts";

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

export interface RoutedStreamCompletion<TState = unknown> {
	route: ModelRoute<TState>;
	message: AssistantMessage;
	ttfbMs: number;
	durationMs: number;
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function hasCountedUsage(usage: Usage): boolean {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 || usage.cost.total > 0;
}

function isContentEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return true;
		case "done":
			return event.message.stopReason !== "error" && event.message.stopReason !== "aborted";
		case "start":
		case "error":
			return false;
	}
}

function hasNonEmptyEphemeralTail(tail: ModelRoute["ephemeralTail"]): tail is string | readonly Message[] {
	return tail !== undefined && (typeof tail === "string" ? tail.length > 0 : tail.length > 0);
}

function resolveStableTimestamp(messages: readonly Message[], fallbackTimestamp?: number): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const ts = messages[i]?.timestamp;
		if (typeof ts === "number" && Number.isFinite(ts)) return ts;
	}
	return fallbackTimestamp ?? Date.now();
}

function projectSystemHead(
	head: SystemMessage | undefined,
	prefix: string | undefined,
	append: string | undefined,
	fallbackTimestamp: number,
): SystemMessage {
	const baseText = head ? contentText(head.content) : "";
	const prefixed = prefix ? `${prefix}${baseText}` : baseText;
	if (head?.sections && append) {
		return {
			...head,
			content: prefixed,
			sections: { ...head.sections, "pi.virtual.append": append },
		};
	}
	const content = append ? (prefixed.length > 0 ? `${prefixed}\n\n${append}` : append) : prefixed;
	return head
		? { ...head, content }
		: {
				role: "system",
				content,
				timestamp: fallbackTimestamp,
			};
}

/**
 * Project outbound LLM messages for a single routed call without mutating transcript state.
 * When `route.preserveToolDeclarations` is true, outbound `toolsAdded` stay frozen verbatim
 * (keeping Meta `shapeMetaWireTools()` suffixes and cache prefixes identical).
 */
export function projectRoutedTranscript(
	context: TranscriptContext,
	route: ModelRoute,
	fallbackTimestamp?: number,
): TranscriptContext {
	let messages: readonly Message[] = context.messages;
	if (route.messages !== undefined) {
		messages = typeof route.messages === "function" ? route.messages(messages) : route.messages;
	}

	const hasSystemOverride = Boolean(route.systemPromptPrefix || route.systemAppend);
	const allowedSet =
		route.allowedTools && route.preserveToolDeclarations !== true ? new Set(route.allowedTools) : undefined;
	const hasTail = hasNonEmptyEphemeralTail(route.ephemeralTail);

	if (!hasSystemOverride && !allowedSet && !hasTail && messages === context.messages) {
		return context;
	}

	const stableTimestamp = resolveStableTimestamp(messages, fallbackTimestamp);
	let next = messages.slice();
	if (hasSystemOverride) {
		if (next[0]?.role === "system") {
			next[0] = projectSystemHead(next[0], route.systemPromptPrefix, route.systemAppend, stableTimestamp);
		} else {
			next.unshift(projectSystemHead(undefined, route.systemPromptPrefix, route.systemAppend, stableTimestamp));
		}
	}

	if (allowedSet) {
		next = next.map((message) => {
			if (message.role !== "system" || !message.toolsAdded) return message;
			const filtered = message.toolsAdded.filter((tool) => allowedSet.has(tool.name));
			if (filtered.length === message.toolsAdded.length) return message;
			const { toolsAdded: _previous, ...rest } = message;
			return filtered.length > 0 ? { ...rest, toolsAdded: filtered } : rest;
		});
	}

	if (hasTail && route.ephemeralTail !== undefined) {
		if (typeof route.ephemeralTail === "string") {
			next.push({ role: "user", content: route.ephemeralTail, timestamp: stableTimestamp });
		} else {
			next.push(...route.ephemeralTail);
		}
	}

	return normalizeContext({ messages: next });
}

const ANTHROPIC_CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_addition", "tool_removal"]);

function countAnthropicTailTurns(tail: string | readonly Message[]): number {
	if (typeof tail === "string") return tail.length > 0 ? 1 : 0;
	let count = 0;
	let inToolResultRun = false;
	for (const message of tail) {
		if (message.role === "toolResult") {
			if (!inToolResultRun) {
				count++;
				inToolResultRun = true;
			}
			continue;
		}
		inToolResultRun = false;
		count++;
	}
	return count;
}

function isSyntheticAnthropicEffortTurn(message: Record<string, unknown>): boolean {
	return (
		message.role === "system" &&
		Array.isArray(message.content) &&
		message.content.length === 0 &&
		"output_config" in message
	);
}

/**
 * Anthropic places a single conversation `cache_control` breakpoint on the last user/system block.
 * When `ephemeralTail` is present, relocate that breakpoint onto the last preceding canonical block
 * so single-turn tails never waste cache writes or miss the cache on subsequent turns.
 */
export function anchorAnthropicCacheBeforeEphemeralTail(
	payload: unknown,
	ephemeralTail: string | readonly Message[],
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.messages)) return payload;
	const tailTurns = countAnthropicTailTurns(ephemeralTail);
	if (tailTurns <= 0) return payload;

	const rawMessages = record.messages as Array<Record<string, unknown>>;
	let remainingTailTurns = tailTurns;
	let canonicalEndIndex = rawMessages.length - 1;
	while (canonicalEndIndex >= 0 && remainingTailTurns > 0) {
		const msg = rawMessages[canonicalEndIndex];
		if (msg && !isSyntheticAnthropicEffortTurn(msg)) {
			remainingTailTurns--;
		}
		canonicalEndIndex--;
	}
	if (remainingTailTurns > 0 || canonicalEndIndex < 0) return payload;

	let anchorMsgIndex = -1;
	let anchorBlockIndex = -1;
	for (let i = canonicalEndIndex; i >= 0; i--) {
		const msg = rawMessages[i];
		if (!msg || isSyntheticAnthropicEffortTurn(msg)) continue;
		if (msg.role !== "user" && msg.role !== "system") continue;
		if (typeof msg.content === "string") {
			anchorMsgIndex = i;
			break;
		}
		if (Array.isArray(msg.content)) {
			for (let b = msg.content.length - 1; b >= 0; b--) {
				const block = msg.content[b] as Record<string, unknown> | undefined;
				if (block && typeof block.type === "string" && ANTHROPIC_CACHEABLE_BLOCK_TYPES.has(block.type)) {
					anchorMsgIndex = i;
					anchorBlockIndex = b;
					break;
				}
			}
			if (anchorMsgIndex !== -1) break;
		}
	}
	if (anchorMsgIndex === -1) return payload;

	let extractedCacheControl: unknown;
	const nextMessages = rawMessages.slice();
	for (let i = canonicalEndIndex + 1; i < nextMessages.length; i++) {
		const msg = nextMessages[i];
		if (!msg || !Array.isArray(msg.content)) continue;
		let clonedContent: Array<Record<string, unknown>> | undefined;
		for (let b = msg.content.length - 1; b >= 0; b--) {
			const block = msg.content[b] as Record<string, unknown> | undefined;
			if (!block || block.cache_control === undefined) continue;
			extractedCacheControl ??= block.cache_control;
			clonedContent ??= (msg.content as Array<Record<string, unknown>>).slice();
			const { cache_control: _dropped, ...rest } = block;
			clonedContent[b] = rest;
		}
		if (clonedContent) {
			nextMessages[i] = { ...msg, content: clonedContent };
		}
	}
	if (extractedCacheControl === undefined) return payload;

	const anchorMsg = nextMessages[anchorMsgIndex]!;
	if (typeof anchorMsg.content === "string") {
		nextMessages[anchorMsgIndex] = {
			...anchorMsg,
			content: [{ type: "text", text: anchorMsg.content, cache_control: extractedCacheControl }],
		};
	} else if (Array.isArray(anchorMsg.content) && anchorBlockIndex >= 0) {
		const clonedContent = (anchorMsg.content as Array<Record<string, unknown>>).slice();
		const targetBlock = clonedContent[anchorBlockIndex]!;
		if (targetBlock.cache_control === undefined) {
			clonedContent[anchorBlockIndex] = { ...targetBlock, cache_control: extractedCacheControl };
			nextMessages[anchorMsgIndex] = { ...anchorMsg, content: clonedContent };
		}
	}

	return { ...record, messages: nextMessages };
}

function withGeminiAnyToolConfig(target: Record<string, unknown>): Record<string, unknown> {
	const existingConfig =
		target.toolConfig && typeof target.toolConfig === "object" && !Array.isArray(target.toolConfig)
			? (target.toolConfig as Record<string, unknown>)
			: {};
	const existingFnConfig =
		existingConfig.functionCallingConfig &&
		typeof existingConfig.functionCallingConfig === "object" &&
		!Array.isArray(existingConfig.functionCallingConfig)
			? (existingConfig.functionCallingConfig as Record<string, unknown>)
			: {};
	return {
		...target,
		toolConfig: {
			...existingConfig,
			functionCallingConfig: { ...existingFnConfig, mode: "ANY" },
		},
	};
}

/** Rewrite wire payload when `toolChoice: "required"` targets APIs with vendor-specific syntax. */
export function applyRequiredToolChoicePayload(
	payload: unknown,
	api: string,
	modelMeta?: { provider?: string; baseUrl?: string },
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (api === "anthropic-messages") {
		const { thinking: _thinking, output_config: _outputConfig, ...rest } = record;
		return { ...rest, tool_choice: { type: "any" } };
	}
	if (api === "antigravity-api" || api === "antigravity") {
		if (record.request && typeof record.request === "object" && !Array.isArray(record.request)) {
			return { ...record, request: withGeminiAnyToolConfig(record.request as Record<string, unknown>) };
		}
		return withGeminiAnyToolConfig(record);
	}
	if (api === "google-generative-ai" || api === "google-vertex") {
		return withGeminiAnyToolConfig(record);
	}
	if (api === "bedrock-converse-stream") {
		const existingConfig =
			record.toolConfig && typeof record.toolConfig === "object" && !Array.isArray(record.toolConfig)
				? (record.toolConfig as Record<string, unknown>)
				: undefined;
		if (!existingConfig) return payload;
		return {
			...record,
			toolConfig: { ...existingConfig, toolChoice: { any: {} } },
		};
	}
	if (modelMeta?.provider === "meta" || modelMeta?.baseUrl?.includes("api.meta.ai")) {
		return payload;
	}
	return { ...record, tool_choice: "required" };
}

/** Build `SimpleStreamOptions` for one physical route, applying caps, temperature, session overrides, and `toolChoice`. */
export function buildRoutedStreamOptions(
	baseOptions: SimpleStreamOptions | undefined,
	route: ModelRoute,
): SimpleStreamOptions {
	const modelLimit = route.model.maxTokens;
	const requestedMax = route.maxTokens ?? baseOptions?.maxTokens;
	const maxTokens = requestedMax !== undefined && modelLimit > 0 ? Math.min(requestedMax, modelLimit) : requestedMax;
	const clampedLevel = clampThinkingLevel(route.model, route.thinkingLevel);
	const reasoning = clampedLevel === "off" ? undefined : clampedLevel;
	const toolChoice: ModelRouteToolChoice | undefined = route.toolChoice;
	const simpleToolChoice = toolChoice === "auto" || toolChoice === "none" ? toolChoice : baseOptions?.toolChoice;
	const hasTail = hasNonEmptyEphemeralTail(route.ephemeralTail);
	const previousOnPayload = baseOptions?.onPayload;
	const onPayload: SimpleStreamOptions["onPayload"] =
		toolChoice === "required" || hasTail
			? async (payload, model) => {
					let shaped = payload;
					if (hasTail && route.ephemeralTail !== undefined && model.api === "anthropic-messages") {
						shaped = anchorAnthropicCacheBeforeEphemeralTail(shaped, route.ephemeralTail);
					}
					if (toolChoice === "required") {
						shaped = applyRequiredToolChoicePayload(shaped, model.api, model);
					}
					return previousOnPayload ? await previousOnPayload(shaped, model) : shaped;
				}
			: previousOnPayload;

	return {
		...baseOptions,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
		...(route.sessionId !== undefined ? { sessionId: route.sessionId } : {}),
		...(route.disableContinuation !== undefined ? { disableContinuation: route.disableContinuation } : {}),
		reasoning,
		...(simpleToolChoice !== undefined ? { toolChoice: simpleToolChoice } : {}),
		...(onPayload ? { onPayload } : {}),
	};
}

interface TimedStreamHandle {
	stream: AssistantMessageEventStream;
	getTiming(): { ttfbMs: number; durationMs: number };
}

function createTimedPhysicalStream(
	dispatchPhysical: PhysicalStreamDispatcher,
	context: TranscriptContext,
	route: ModelRoute,
	baseOptions: SimpleStreamOptions | undefined,
	fallbackTimestamp?: number,
): TimedStreamHandle {
	const dispatchedAt = Date.now();
	const projected = projectRoutedTranscript(context, route, fallbackTimestamp ?? dispatchedAt);
	const options = buildRoutedStreamOptions(baseOptions, route);
	const outer = createAssistantMessageEventStream();
	let firstContentAt: number | undefined;
	let finishedAt: number | undefined;

	const ttfbTimeoutMs = route.ttfbTimeoutMs;
	const ttfbController = ttfbTimeoutMs !== undefined && ttfbTimeoutMs > 0 ? new AbortController() : undefined;
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const effectiveSignal = ttfbController
		? options.signal
			? AbortSignal.any([options.signal, ttfbController.signal])
			: ttfbController.signal
		: options.signal;

	const clearTtfbTimer = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
	};

	if (ttfbController && ttfbTimeoutMs !== undefined) {
		timer = setTimeout(() => {
			timer = undefined;
			if (firstContentAt !== undefined || options.signal?.aborted) return;
			timedOut = true;
			ttfbController.abort();
		}, ttfbTimeoutMs);
		if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
			timer.unref();
		}
	}

	void (async () => {
		let finalMessage: AssistantMessage | undefined;
		try {
			const source = await dispatchPhysical(route.model, projected, {
				...options,
				signal: effectiveSignal,
			});
			for await (const event of source) {
				if (timedOut) break;
				if (firstContentAt === undefined && isContentEvent(event)) {
					firstContentAt = Date.now();
					clearTtfbTimer();
				}
				if (event.type === "done") {
					clearTtfbTimer();
					finalMessage = event.message;
					outer.push(event);
				} else if (event.type === "error") {
					clearTtfbTimer();
					if (!timedOut) {
						finalMessage = event.error;
						outer.push(event);
					}
				} else {
					outer.push(event);
				}
			}
			if (!timedOut && !finalMessage) {
				finalMessage = await source.result();
			}
		} catch (error) {
			clearTtfbTimer();
			if (!timedOut) {
				const aborted = Boolean(options.signal?.aborted);
				const stopReason = aborted ? "aborted" : "error";
				finalMessage = {
					role: "assistant",
					content: [],
					api: route.model.api,
					provider: route.model.provider,
					model: route.model.id,
					thinkingLevel: clampThinkingLevel(route.model, route.thinkingLevel),
					usage: ZERO_USAGE,
					stopReason,
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason: stopReason, error: finalMessage });
			}
		} finally {
			clearTtfbTimer();
			finishedAt = Date.now();
		}

		if (timedOut && !options.signal?.aborted) {
			const timeoutMessage: AssistantMessage = {
				role: "assistant",
				content: [],
				api: route.model.api,
				provider: route.model.provider,
				model: route.model.id,
				thinkingLevel: clampThinkingLevel(route.model, route.thinkingLevel),
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: `Request timed out waiting for first token after ${ttfbTimeoutMs}ms`,
				timestamp: Date.now(),
			};
			outer.push({ type: "error", reason: "error", error: timeoutMessage });
			outer.end(timeoutMessage);
			return;
		}

		outer.end(finalMessage);
	})();

	return {
		stream: outer,
		getTiming: () => {
			const end = finishedAt ?? Date.now();
			const ttfbEnd = firstContentAt ?? end;
			return {
				ttfbMs: Math.max(0, ttfbEnd - dispatchedAt),
				durationMs: Math.max(0, end - dispatchedAt),
			};
		},
	};
}

function streamHedgedRoute<TState>(
	dispatchPhysical: PhysicalStreamDispatcher,
	context: TranscriptContext,
	primaryRoute: ModelRoute<TState>,
	hedge: ModelRouteHedge,
	baseOptions: SimpleStreamOptions | undefined,
	recordSidecarUsage: SidecarUsageRecorder | undefined,
	onCommitRoute: (winner: ModelRoute<TState>) => void,
): TimedStreamHandle {
	const outer = createAssistantMessageEventStream();
	const dispatchedAt = Date.now();
	let committedHandle: TimedStreamHandle | undefined;
	let finishedAt: number | undefined;

	const hedgeRoute: ModelRoute<TState> = {
		...primaryRoute,
		model: hedge.model,
		thinkingLevel: clampThinkingLevel(hedge.model, hedge.thinkingLevel ?? primaryRoute.thinkingLevel),
		disableContinuation: true,
		hedge: undefined,
	};

	const primaryAbort = new AbortController();
	const hedgeAbort = new AbortController();
	const outerSignal = baseOptions?.signal;
	const onOuterAbort = () => {
		primaryAbort.abort();
		hedgeAbort.abort();
	};
	outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

	let winner: "primary" | "hedge" | undefined;
	let hedgeLaunched = false;
	let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
	let primaryFailedMessage: AssistantMessage | undefined;
	let hedgeFailedMessage: AssistantMessage | undefined;
	let finishedCount = 0;

	const clearHedgeTimer = () => {
		if (!hedgeTimer) return;
		clearTimeout(hedgeTimer);
		hedgeTimer = undefined;
	};

	const finalizeBothFailed = () => {
		const expected = hedgeLaunched ? 2 : 1;
		if (winner !== undefined || finishedCount < expected) return;
		clearHedgeTimer();
		outerSignal?.removeEventListener("abort", onOuterAbort);
		finishedAt = Date.now();
		const reported = primaryFailedMessage ?? hedgeFailedMessage;
		const sidecar = reported === primaryFailedMessage ? hedgeFailedMessage : primaryFailedMessage;
		if (sidecar && hasCountedUsage(sidecar.usage)) {
			recordSidecarUsage?.(
				"hedge",
				sidecar.provider,
				sidecar.responseModel ?? sidecar.model,
				sidecar.usage,
				"failed hedge",
			);
		}
		if (reported) {
			outer.push({
				type: "error",
				reason: reported.stopReason === "aborted" ? "aborted" : "error",
				error: reported,
			});
			outer.end(reported);
		} else {
			outer.end();
		}
	};

	const runContender = (
		label: "primary" | "hedge",
		route: ModelRoute<TState>,
		ownAbort: AbortController,
		otherAbort: AbortController,
	) => {
		const handle = createTimedPhysicalStream(
			dispatchPhysical,
			context,
			route,
			{
				...baseOptions,
				signal: ownAbort.signal,
			},
			dispatchedAt,
		);
		let pendingStart: AssistantMessageEvent | undefined;
		void (async () => {
			let resultMessage: AssistantMessage | undefined;
			for await (const event of handle.stream) {
				if (winner !== undefined && winner !== label) {
					if (event.type === "done") resultMessage = event.message;
					else if (event.type === "error") resultMessage = event.error;
					continue;
				}
				if (winner === undefined) {
					if (event.type === "start") {
						pendingStart = event;
						continue;
					}
					if (event.type === "error") {
						resultMessage = event.error;
						if (label === "primary") {
							primaryFailedMessage = event.error;
							if (!hedgeLaunched && !outerSignal?.aborted) {
								clearHedgeTimer();
								launchHedge();
							}
						} else {
							hedgeFailedMessage = event.error;
						}
						continue;
					}
					winner = label;
					committedHandle = handle;
					clearHedgeTimer();
					otherAbort.abort();
					onCommitRoute(route);
					if (pendingStart) outer.push(pendingStart);
				}
				if (event.type === "done") resultMessage = event.message;
				else if (event.type === "error") resultMessage = event.error;
				outer.push(event);
			}
			if (!resultMessage) {
				resultMessage = await handle.stream.result();
			}
			if (winner === label) {
				outerSignal?.removeEventListener("abort", onOuterAbort);
				finishedAt = Date.now();
				outer.end(resultMessage);
				return;
			}
			if (winner !== undefined && resultMessage && hasCountedUsage(resultMessage.usage)) {
				recordSidecarUsage?.(
					"hedge",
					resultMessage.provider,
					resultMessage.responseModel ?? resultMessage.model,
					resultMessage.usage,
					"cancelled hedge",
				);
			}
			finishedCount++;
			finalizeBothFailed();
		})();
	};

	const launchHedge = () => {
		if (hedgeLaunched || winner !== undefined || outerSignal?.aborted) return;
		hedgeLaunched = true;
		runContender("hedge", hedgeRoute, hedgeAbort, primaryAbort);
	};

	hedgeTimer = setTimeout(launchHedge, Math.max(0, hedge.afterMs));
	if (
		typeof hedgeTimer === "object" &&
		hedgeTimer !== null &&
		"unref" in hedgeTimer &&
		typeof hedgeTimer.unref === "function"
	) {
		hedgeTimer.unref();
	}
	runContender("primary", primaryRoute, primaryAbort, hedgeAbort);

	return {
		stream: outer,
		getTiming: () => {
			if (committedHandle) return committedHandle.getTiming();
			const end = finishedAt ?? Date.now();
			return { ttfbMs: Math.max(0, end - dispatchedAt), durationMs: Math.max(0, end - dispatchedAt) };
		},
	};
}

function streamValidatedRoute<TState>(
	dispatchSingleOrHedged: (route: ModelRoute<TState>) => TimedStreamHandle,
	primaryRoute: ModelRoute<TState>,
	validate: NonNullable<ModelRoute<TState>["validate"]>,
	resolvePhysicalModel: (provider: string, modelId: string) => Model<Api>,
	recordSidecarUsage: SidecarUsageRecorder | undefined,
	onCommitRoute: (committed: ModelRoute<TState>) => void,
	onUpdateState: (state: TState) => void,
): TimedStreamHandle {
	const outer = createAssistantMessageEventStream();
	let activeHandle = dispatchSingleOrHedged({ ...primaryRoute, validate: undefined });

	void (async () => {
		const buffered: AssistantMessageEvent[] = [];
		let candidate: AssistantMessage | undefined;
		for await (const event of activeHandle.stream) {
			buffered.push(event);
			if (event.type === "done") candidate = event.message;
			else if (event.type === "error") candidate = event.error;
		}
		if (!candidate) candidate = await activeHandle.stream.result();

		if (
			candidate.stopReason === "toolUse" ||
			candidate.stopReason === "error" ||
			candidate.stopReason === "aborted"
		) {
			for (const event of buffered) outer.push(event);
			outer.end(candidate);
			return;
		}

		const decision = await validate(candidate);
		if (decision.state !== undefined) onUpdateState(decision.state);

		if (decision.action === "accept") {
			for (const event of buffered) outer.push(event);
			outer.end(candidate);
			return;
		}

		if (hasCountedUsage(candidate.usage)) {
			recordSidecarUsage?.(
				"draft",
				candidate.provider,
				candidate.responseModel ?? candidate.model,
				candidate.usage,
				"escalated draft",
			);
		}

		const targetModel = resolvePhysicalModel(decision.model.provider, decision.model.id);
		const escalatedRoute: ModelRoute<TState> = {
			...primaryRoute,
			model: targetModel,
			thinkingLevel: clampThinkingLevel(targetModel, decision.thinkingLevel ?? primaryRoute.thinkingLevel),
			...(decision.ephemeralTail !== undefined ? { ephemeralTail: decision.ephemeralTail } : {}),
			...(decision.maxTokens !== undefined ? { maxTokens: decision.maxTokens } : {}),
			...(decision.temperature !== undefined ? { temperature: decision.temperature } : {}),
			...(decision.sessionId !== undefined ? { sessionId: decision.sessionId } : {}),
			...(decision.disableContinuation !== undefined ? { disableContinuation: decision.disableContinuation } : {}),
			...(decision.state !== undefined ? { state: decision.state } : {}),
			hedge: undefined,
			validate: undefined,
		};
		onCommitRoute(escalatedRoute);
		activeHandle = dispatchSingleOrHedged(escalatedRoute);
		let escalatedResult: AssistantMessage | undefined;
		for await (const event of activeHandle.stream) {
			if (event.type === "done") escalatedResult = event.message;
			else if (event.type === "error") escalatedResult = event.error;
			outer.push(event);
		}
		if (!escalatedResult) escalatedResult = await activeHandle.stream.result();
		outer.end(escalatedResult);
	})();

	return {
		stream: outer,
		getTiming: () => activeHandle.getTiming(),
	};
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

/** Execute a routed virtual-model request across single-dispatch, hedge, validation, or custom `stream()`. */
export function executeRoutedStream<TState = unknown>(
	params: ExecuteRoutedStreamParams<TState>,
): AssistantMessageEventStream {
	let committedRoute = params.initialRoute;
	const commitRoute = (next: ModelRoute<TState>) => {
		committedRoute = next;
		params.onCommitRoute?.(next);
	};

	const dispatchSingleOrHedged = (route: ModelRoute<TState>): TimedStreamHandle => {
		const validatedTarget = params.resolvePhysicalModel(route.model.provider, route.model.id);
		const normalizedRoute: ModelRoute<TState> = {
			...route,
			model: validatedTarget,
			thinkingLevel: clampThinkingLevel(validatedTarget, route.thinkingLevel),
		};
		if (normalizedRoute.hedge) {
			const hedgeTarget = params.resolvePhysicalModel(
				normalizedRoute.hedge.model.provider,
				normalizedRoute.hedge.model.id,
			);
			return streamHedgedRoute(
				params.dispatchPhysical,
				params.context,
				normalizedRoute,
				{ ...normalizedRoute.hedge, model: hedgeTarget },
				params.baseOptions,
				params.recordSidecarUsage,
				commitRoute,
			);
		}
		return createTimedPhysicalStream(params.dispatchPhysical, params.context, normalizedRoute, params.baseOptions);
	};

	const dispatchFullRoute = (route: ModelRoute<TState>): TimedStreamHandle => {
		if (route.validate) {
			return streamValidatedRoute(
				dispatchSingleOrHedged,
				route,
				route.validate,
				params.resolvePhysicalModel,
				params.recordSidecarUsage,
				commitRoute,
				(state) => params.onUpdateState?.(state),
			);
		}
		return dispatchSingleOrHedged(route);
	};

	const seenToolCallStartIndices = new Set<number>();
	const notifyToolCallStart = (event: AssistantMessageEvent): void => {
		if (event.type !== "toolcall_start" || !params.definition.onToolCallStart) return;
		if (seenToolCallStartIndices.has(event.contentIndex)) return;
		const block = event.partial.content[event.contentIndex];
		if (!block || block.type !== "toolCall" || !block.name) return;
		seenToolCallStartIndices.add(event.contentIndex);
		try {
			const maybePromise = params.definition.onToolCallStart({
				toolName: block.name,
				turnIndex: params.request.turnIndex,
				request: params.request,
			}) as unknown;
			if (
				maybePromise !== null &&
				typeof maybePromise === "object" &&
				"then" in maybePromise &&
				typeof (maybePromise as PromiseLike<void>).then === "function"
			) {
				Promise.resolve(maybePromise).catch(() => {});
			}
		} catch {
			// Pre-warm/telemetry hooks must never abort or stall the active stream.
		}
	};

	if (params.definition.stream) {
		const outer = createAssistantMessageEventStream();
		const dispatchedAt = Date.now();
		let firstContentAt: number | undefined;
		let lastDispatchedTiming: (() => { ttfbMs: number; durationMs: number }) | undefined;

		const streamRequest: VirtualStreamRequest<TState> = {
			...params.request,
			dispatch: (route) => {
				commitRoute(route);
				if (route.state !== undefined) params.onUpdateState?.(route.state);
				if (route.statusLabel !== undefined) params.onStatus?.(route.statusLabel);
				const handle = dispatchFullRoute(route);
				lastDispatchedTiming = handle.getTiming;
				return handle.stream;
			},
			recordUsage: (kind, provider, modelId, usage, note) => {
				if (hasCountedUsage(usage)) {
					params.recordSidecarUsage?.(kind, provider, modelId, usage, note);
				}
			},
			setState: (state) => params.onUpdateState?.(state),
			setStatus: (label) => params.onStatus?.(label),
		};

		void (async () => {
			let finalMessage: AssistantMessage | undefined;
			try {
				const customStream = await params.definition.stream!(streamRequest);
				for await (const event of customStream) {
					if (firstContentAt === undefined && isContentEvent(event)) {
						firstContentAt = Date.now();
					}
					notifyToolCallStart(event);
					if (event.type === "done") finalMessage = event.message;
					else if (event.type === "error") finalMessage = event.error;
					outer.push(event);
				}
				if (!finalMessage) finalMessage = await customStream.result();
			} catch (error) {
				const aborted = Boolean(params.baseOptions?.signal?.aborted);
				const stopReason = aborted ? "aborted" : "error";
				finalMessage = {
					role: "assistant",
					content: [],
					api: committedRoute.model.api,
					provider: committedRoute.model.provider,
					model: committedRoute.model.id,
					thinkingLevel: clampThinkingLevel(committedRoute.model, committedRoute.thinkingLevel),
					usage: ZERO_USAGE,
					stopReason,
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason: stopReason, error: finalMessage });
			}
			const now = Date.now();
			const timing = lastDispatchedTiming
				? lastDispatchedTiming()
				: {
						ttfbMs: Math.max(0, (firstContentAt ?? now) - dispatchedAt),
						durationMs: Math.max(0, now - dispatchedAt),
					};
			if (finalMessage) {
				await params.onComplete?.({
					route: committedRoute,
					message: finalMessage,
					ttfbMs: timing.ttfbMs,
					durationMs: timing.durationMs,
				});
			}
			outer.end(finalMessage);
		})();

		return outer;
	}

	const outer = createAssistantMessageEventStream();
	const handle = dispatchFullRoute(committedRoute);
	void (async () => {
		let finalMessage: AssistantMessage | undefined;
		for await (const event of handle.stream) {
			notifyToolCallStart(event);
			if (event.type === "done") finalMessage = event.message;
			else if (event.type === "error") finalMessage = event.error;
			outer.push(event);
		}
		if (!finalMessage) finalMessage = await handle.stream.result();
		const timing = handle.getTiming();
		if (finalMessage) {
			await params.onComplete?.({
				route: committedRoute,
				message: finalMessage,
				ttfbMs: timing.ttfbMs,
				durationMs: timing.durationMs,
			});
		}
		outer.end(finalMessage);
	})();

	return outer;
}
