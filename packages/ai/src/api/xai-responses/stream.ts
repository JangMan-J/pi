import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	TranscriptContext,
} from "../../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { getDeclaredTools, resolveTranscript } from "../../utils/transcript.ts";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import type { OpenAIResponsesOptions } from "../openai-responses.ts";
import { processResponsesStream } from "../openai-responses-shared.ts";
import {
	resolveLivenessTimeoutMs,
	resolveLoopNoveltyThreshold,
	resolveLoopRecoveryLimit,
	resolveMaxRequestImageBytes,
	resolveMaxStoredContextTokens,
	resolveSseUrl,
	storeResponsesEnabled,
} from "./config.ts";
import { isStoredResponseTooLargeMessage } from "./continuation.ts";
import { limitContextImageBytes, sanitizeContextMessages } from "./history.ts";
import { resolveXaiCompat } from "./models.ts";
import {
	buildResponseCreate,
	prepareResponseOptions,
	projectAssistantResponse,
	requestHeaders,
	resolveApiKey,
} from "./payload.ts";
import { RepetitionDetector } from "./repetition-detector.ts";
import {
	isPlainEvent,
	isReplayableTransportError,
	iterateXaiSseSessionEvents,
	normalizeWireRecordWithSize,
	normalizeXaiErrorMessage,
	XaiSseTransportError,
} from "./sse-events.ts";
import {
	estimateStoredRequestTokens,
	hasStoredResponseTooLarge,
	markStoredResponseTooLarge,
} from "./stored-context.ts";

export const EMPTY_THINKING_CONTINUATION_PROMPT =
	"Your previous reply had only thinking and no user-visible text or tool calls. Continue the work. Do not reconstruct the thinking. Take the next concrete action or write the user-facing result.";
export const DOOM_LOOP_RECOVERY_REMINDER =
	"<system_reminder>Your messages have been flagged as looping. Your response has been flagged as repeating the same text pattern. Avoid excessive repetition. If you are having trouble ask the user for guidance.</system_reminder>";

function isEmptyThinkingStop(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop" || message.content.length === 0) {
		return false;
	}
	return message.content.every((block) => block.type === "thinking");
}

function hasPriorAssistantTurn(context: TranscriptContext): boolean {
	return context.messages.some((msg) => msg.role === "assistant");
}

/**
 * Wrap the raw SSE event iterator with client-side & server-side doom-loop detection
 * during `thinking` (before any visible text or tool calls have been emitted to the caller)
 * and track completed `function_call` items so `CompleteToolCalls` length salvage knows
 * whether all tool calls in `output.content` finished cleanly.
 */
async function* monitorStreamEvents(
	events: AsyncGenerator<Record<string, unknown>>,
	options: {
		lowNoveltyThreshold: number;
		canAbortForDoomLoop: () => boolean;
		getTriggeredServerDoomLoop: () => string[] | undefined;
		onFunctionCallDone: (callId: string) => void;
	},
): AsyncGenerator<Record<string, unknown>> {
	let thinkingDetector = new RepetitionDetector({
		contentKind: "thinking",
		lowNoveltyThreshold: options.lowNoveltyThreshold,
	});
	for await (const event of events) {
		const serverTriggers = options.getTriggeredServerDoomLoop();
		if (serverTriggers && serverTriggers.length > 0 && options.canAbortForDoomLoop()) {
			throw new XaiSseTransportError(`xAI server doom-loop check triggered: ${serverTriggers.join(", ")}`, {
				kind: "doom_loop",
				outputStarted: false,
				triggers: serverTriggers,
			});
		}

		const type = typeof event.type === "string" ? event.type : "";
		if (type === "response.doom_loop_check") {
			continue;
		}
		if (type === "response.output_item.added") {
			thinkingDetector = new RepetitionDetector({
				contentKind: "thinking",
				lowNoveltyThreshold: options.lowNoveltyThreshold,
			});
		} else if (
			(type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") &&
			typeof event.delta === "string"
		) {
			const detection = thinkingDetector.append(event.delta);
			if (detection && options.canAbortForDoomLoop()) {
				throw new XaiSseTransportError(`xAI thinking repetition detected (${detection.kind})`, {
					kind: "doom_loop",
					outputStarted: false,
					triggers: [`client_${detection.kind}@thinking`],
				});
			}
		} else if (type === "response.output_item.done" && isPlainEvent(event.item)) {
			const item = event.item;
			if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string") {
				options.onFunctionCallDone(item.call_id);
			}
		}
		yield event;
	}
}

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();
	const compat = resolveXaiCompat(model);
	const normalizedContext = resolveTranscript(context, compat.supportsMidConvoSystemMessages);

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = resolveApiKey(options);
			const sessionId = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
			const providerContext = limitContextImageBytes(
				sanitizeContextMessages(normalizedContext, model),
				resolveMaxRequestImageBytes(options?.env),
				sessionId || undefined,
			);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(providerContext.messages),
				compat.supportsOpenAIGrammarTools,
			);

			const storageConfigured = storeResponsesEnabled(options?.env) && Boolean(sessionId);
			let payload = buildResponseCreate(model, providerContext, options);
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined && nextPayload !== null && typeof nextPayload === "object") {
				payload = nextPayload as Record<string, unknown>;
			}

			let payloadNormalized = false;
			let storeResponses = false;
			if (storageConfigured) {
				const normalized = normalizeWireRecordWithSize(payload);
				payload = normalized.payload;
				payloadNormalized = true;
				const maxStoredContextTokens = resolveMaxStoredContextTokens(options?.env);
				const rejectedStore = hasStoredResponseTooLarge(sessionId, providerContext.messages);
				let overThreshold = false;
				if (maxStoredContextTokens !== undefined) {
					const contextTokens = estimateStoredRequestTokens(providerContext.messages, normalized.tokenEstimate);
					overThreshold = contextTokens >= maxStoredContextTokens;
				}
				storeResponses = !overThreshold && !rejectedStore;
			}
			if (payloadNormalized) {
				payload.store = storeResponses;
				payload.stream = true;
			} else {
				payload = { ...payload, store: storeResponses, stream: true };
			}
			delete payload.previous_response_id;
			delete payload.type;

			eventStream.push({ type: "start", partial: output });

			const livenessTimeoutMs = resolveLivenessTimeoutMs(options?.timeoutMs, options?.env);
			const lowNoveltyThreshold = resolveLoopNoveltyThreshold(options?.env);
			const maxDoomLoopRetries = resolveLoopRecoveryLimit(options?.env);
			const priorAssistantExists = hasPriorAssistantTurn(providerContext);

			let doomLoopAttempt = 0;
			let emptyThinkingRetried = false;
			let activePayload: Record<string, unknown> = payload;
			let activeStoreResponses = storeResponses;

			while (true) {
				const completedCallIds = new Set<string>();
				let serverDoomTriggers: string[] | undefined;
				const attemptController = new AbortController();
				const attemptSignal = options?.signal
					? AbortSignal.any([options.signal, attemptController.signal])
					: attemptController.signal;

				const canAbortForDoomLoop = () =>
					doomLoopAttempt < maxDoomLoopRetries && output.content.every((block) => block.type === "thinking");

				const rawEvents = iterateXaiSseSessionEvents({
					url: resolveSseUrl(model.baseUrl, options?.env),
					headers: requestHeaders(apiKey, options, model.headers, model.id),
					createPayload: activePayload,
					sessionId: sessionId || undefined,
					signal: attemptSignal,
					livenessTimeoutMs,
					fetch: options?.fetch,
					onOpen: (response) => options?.onResponse?.(response, model),
					onDoomLoopTrigger: (triggers) => {
						serverDoomTriggers = triggers;
						if (canAbortForDoomLoop()) {
							attemptController.abort();
						}
					},
					projectStoredOutput: () => {
						if (
							output.stopReason === "pending" ||
							output.stopReason === "error" ||
							output.stopReason === "aborted"
						) {
							return undefined;
						}
						return projectAssistantResponse(model, output);
					},
					storeResponses: activeStoreResponses,
				});

				const monitoredEvents = monitorStreamEvents(rawEvents, {
					lowNoveltyThreshold,
					canAbortForDoomLoop,
					getTriggeredServerDoomLoop: () => serverDoomTriggers,
					onFunctionCallDone: (callId) => completedCallIds.add(callId),
				});

				try {
					await processResponsesStream(
						monitoredEvents as unknown as Parameters<typeof processResponsesStream>[0],
						output,
						eventStream,
						model,
						{
							onProviderStreamEvent: options?.onProviderStreamEvent,
							serviceTier: options?.serviceTier,
							grammarToolInputProperties,
						},
					);
				} catch (error) {
					const isDoomAbort =
						!options?.signal?.aborted &&
						((error instanceof XaiSseTransportError && error.kind === "doom_loop") ||
							(serverDoomTriggers !== undefined && serverDoomTriggers.length > 0)) &&
						doomLoopAttempt < maxDoomLoopRetries &&
						output.content.every((block) => block.type === "thinking");

					if (isDoomAbort) {
						doomLoopAttempt += 1;
						// Never replay orphaned reasoning signatures on recovery turns (`doom_loop_recovery.rs:4-6`).
						output.content = [];
						output.stopReason = "pending";
						output.errorMessage = undefined;
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("xai_doom_loop_recovery", error, {
								attempt: doomLoopAttempt,
								triggers: serverDoomTriggers ?? [],
							}),
						);
						const baseInput = Array.isArray(payload.input) ? [...payload.input] : [];
						baseInput.push({
							role: "user",
							content: [{ type: "input_text", text: DOOM_LOOP_RECOVERY_REMINDER }],
						});
						activePayload = {
							...payload,
							input: baseInput,
							store: false,
						};
						activeStoreResponses = false;
						continue;
					}
					throw error;
				}

				// LengthPolicy::CompleteToolCalls (`xai-grok-sampler/src/stream/responses.rs:651-704`):
				// When an incomplete response stopped for length/time limit after completing tool calls,
				// promote stopReason to "toolUse" so the agent executes the completed tool calls.
				if (output.stopReason === "length") {
					const toolCalls = output.content.filter((block) => block.type === "toolCall");
					if (
						toolCalls.length > 0 &&
						toolCalls.every((tc) => completedCallIds.has(tc.id.split("|")[0] ?? tc.id))
					) {
						output.stopReason = "toolUse";
					}
				}

				// In-stream empty-thinking continuation on multi-step turns (`empty-thinking.ts`).
				if (!emptyThinkingRetried && priorAssistantExists && isEmptyThinkingStop(output)) {
					emptyThinkingRetried = true;
					const projectedThinking = projectAssistantResponse(model, output);
					const baseInput = Array.isArray(payload.input) ? [...payload.input] : [];
					output.stopReason = "pending";
					activePayload = {
						...payload,
						input: [
							...baseInput,
							...projectedThinking,
							{
								role: "user",
								content: [{ type: "input_text", text: EMPTY_THINKING_CONTINUATION_PROMPT }],
							},
						],
						store: false,
					};
					activeStoreResponses = false;
					continue;
				}

				break;
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "pending") {
				throw new Error("xAI SSE stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			eventStream.push({
				type: "done",
				reason: output.stopReason,
				message: output,
			});
			eventStream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: unknown }).index;
				delete (block as { partialJson?: unknown }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			const aborted =
				options?.signal?.aborted === true ||
				(error instanceof Error && (error.name === "AbortError" || error.message === "Request was aborted"));
			const errorMessage = error instanceof Error ? error.message : String(error);
			if (!aborted && output.content.length > 0 && isStoredResponseTooLargeMessage(errorMessage)) {
				markStoredResponseTooLarge(typeof options?.sessionId === "string" ? options.sessionId : undefined);
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
				output.errorMessage = undefined;
				eventStream.push({
					type: "done",
					reason: output.stopReason,
					message: output,
				});
				eventStream.end();
				return;
			}
			output.stopReason = aborted ? "aborted" : "error";
			output.errorMessage = normalizeXaiErrorMessage(errorMessage, isReplayableTransportError(error));
			eventStream.push({ type: "error", reason: output.stopReason, error: output });
			eventStream.end();
		}
	})();

	return eventStream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = resolveApiKey(options);
	const prepared = prepareResponseOptions(model, context, options, apiKey);
	return stream(model, context, prepared);
};
