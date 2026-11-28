/**
 * Stream-tier execution for routed virtual models: TTFB-timed physical dispatch, hedged racing,
 * pre-commit validation with escalation, and custom `stream()` orchestration.
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { projectRoutedTranscript } from "./projection.ts";
import { buildRoutedStreamOptions } from "./tool-choice.ts";
import type {
	ExecuteRoutedStreamParams,
	ModelRoute,
	ModelRouteHedge,
	PhysicalStreamDispatcher,
	SidecarUsageRecorder,
	TimedStreamHandle,
	VirtualStreamRequest,
} from "./types.ts";

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
					purpose: params.request.purpose,
					turnIndex: params.request.turnIndex,
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
				purpose: params.request.purpose,
				turnIndex: params.request.turnIndex,
			});
		}
		outer.end(finalMessage);
	})();

	return outer;
}
