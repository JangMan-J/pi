/**
 * Single-request ephemeral projection, TTFB timeouts, hedging, pre-commit validation,
 * and stream-tier execution for virtual models.
 */
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	clampThinkingLevel,
	contentText,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
	type SystemMessage,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
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

function projectSystemHead(
	head: SystemMessage | undefined,
	prefix: string | undefined,
	append: string | undefined,
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
				timestamp: Date.now(),
			};
}

/** Project outbound LLM messages for a single routed call without mutating session state. */
export function projectRoutedTranscript(context: TranscriptContext, route: ModelRoute): TranscriptContext {
	let messages: readonly Message[] = context.messages;
	if (route.messages !== undefined) {
		messages = typeof route.messages === "function" ? route.messages(messages) : route.messages;
	}

	const hasSystemOverride = Boolean(route.systemPromptPrefix || route.systemAppend);
	const allowedSet = route.allowedTools ? new Set(route.allowedTools) : undefined;
	const hasTail =
		route.ephemeralTail !== undefined &&
		(typeof route.ephemeralTail === "string" ? route.ephemeralTail.length > 0 : route.ephemeralTail.length > 0);

	if (!hasSystemOverride && !allowedSet && !hasTail && messages === context.messages) {
		return context;
	}

	let next = messages.slice();
	if (hasSystemOverride) {
		if (next[0]?.role === "system") {
			next[0] = projectSystemHead(next[0], route.systemPromptPrefix, route.systemAppend);
		} else {
			next.unshift(projectSystemHead(undefined, route.systemPromptPrefix, route.systemAppend));
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
			next.push({ role: "user", content: route.ephemeralTail, timestamp: Date.now() });
		} else {
			next.push(...route.ephemeralTail);
		}
	}

	return normalizeContext({ messages: next });
}

/** Rewrite wire payload when `toolChoice: "required"` targets APIs with vendor-specific syntax. */
export function applyRequiredToolChoicePayload(payload: unknown, api: string): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (api === "anthropic-messages") {
		// Anthropic rejects forced tool selection when extended thinking is active; drop thinking for that call.
		const { thinking: _thinking, output_config: _outputConfig, ...rest } = record;
		return { ...rest, tool_choice: { type: "any" } };
	}
	if (api === "google-generative-ai" || api === "google-vertex" || api === "antigravity") {
		const existingConfig =
			record.toolConfig && typeof record.toolConfig === "object" && !Array.isArray(record.toolConfig)
				? (record.toolConfig as Record<string, unknown>)
				: {};
		const existingFnConfig =
			existingConfig.functionCallingConfig &&
			typeof existingConfig.functionCallingConfig === "object" &&
			!Array.isArray(existingConfig.functionCallingConfig)
				? (existingConfig.functionCallingConfig as Record<string, unknown>)
				: {};
		return {
			...record,
			toolConfig: {
				...existingConfig,
				functionCallingConfig: { ...existingFnConfig, mode: "ANY" },
			},
		};
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
	return { ...record, tool_choice: "required" };
}

/** Build `SimpleStreamOptions` for one physical route, applying caps, temperature, and `toolChoice`. */
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
	const previousOnPayload = baseOptions?.onPayload;
	const onPayload: SimpleStreamOptions["onPayload"] =
		toolChoice === "required"
			? async (payload, model) => {
					const withRequired = applyRequiredToolChoicePayload(payload, model.api);
					return previousOnPayload ? await previousOnPayload(withRequired, model) : withRequired;
				}
			: previousOnPayload;

	return {
		...baseOptions,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
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
): TimedStreamHandle {
	const projected = projectRoutedTranscript(context, route);
	const options = buildRoutedStreamOptions(baseOptions, route);
	const outer = createAssistantMessageEventStream();
	const dispatchedAt = Date.now();
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
		timer.unref?.();
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
		const handle = createTimedPhysicalStream(dispatchPhysical, context, route, {
			...baseOptions,
			signal: ownAbort.signal,
		});
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
	hedgeTimer.unref?.();
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
			if (event.type === "done") finalMessage = event.message;
			else if (event.type === "error") finalMessage = event.error;
			outer.push(event);
		}
		if (!finalMessage) finalMessage = await handle.stream.result();
		const timing = handle.getTiming();
		await params.onComplete?.({
			route: committedRoute,
			message: finalMessage,
			ttfbMs: timing.ttfbMs,
			durationMs: timing.durationMs,
		});
		outer.end(finalMessage);
	})();
	return outer;
}
