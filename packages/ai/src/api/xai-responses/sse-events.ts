import { debugEnabled, resolveLivenessTimeoutMs } from "./config.ts";
import {
	type ContinuationRequestContext,
	type ContinuationState,
	isContinuationRejection,
	isStoredResponseTooLarge,
	nextContinuationState,
	planStoredRequest as planStoredRequestForChain,
	readStoredResponse,
} from "./continuation.ts";
import { extractConfidentDoomLoopTriggers } from "./repetition-detector.ts";
import { markStoredResponseTooLarge } from "./stored-context.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INBOUND_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_SESSION_REQUESTS = 64;
const MAX_TIMER_MS = 2_147_000_000;
const MAX_TRACKED_SESSIONS = 128;
const normalizedWireRecords = new WeakSet<Record<string, unknown>>();
const textEncoder = new TextEncoder();

const CAPACITY_ERROR_PATTERN =
	/\b(?:currently at capacity|due to high demand|temporarily unavailable|currently degraded)\b/i;

const TERMINAL_TYPES = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

const OUTPUT_EVENT_PREFIXES = [
	"response.code_execution_call.",
	"response.code_interpreter_call.",
	"response.content_part.",
	"response.custom_tool_call_input.",
	"response.file_search_call.",
	"response.function_call_arguments.",
	"response.mcp_call.",
	"response.output_item.",
	"response.output_text.",
	"response.reasoning",
	"response.refusal.",
	"response.web_search_call.",
	"response.x_search_call.",
];

export class XaiSseTransportError extends Error {
	readonly outputStarted: boolean;
	readonly kind: "connect" | "doom_loop" | "lifecycle" | "liveness" | "protocol" | "queue" | "socket";
	readonly status?: number;
	readonly triggers?: string[];

	constructor(
		message: string,
		options: {
			kind?: "connect" | "doom_loop" | "lifecycle" | "liveness" | "protocol" | "queue" | "socket";
			outputStarted?: boolean;
			status?: number;
			triggers?: string[];
		} = {},
	) {
		super(message);
		this.name = "XaiSseTransportError";
		this.kind = options.kind ?? "socket";
		this.outputStarted = options.outputStarted ?? false;
		this.status = options.status;
		this.triggers = options.triggers;
	}
}

export type OpenXaiEventsOptions = {
	url: string;
	headers: Record<string, string>;
	createPayload: Record<string, unknown>;
	signal?: AbortSignal;
	livenessTimeoutMs?: number;
	connectTimeoutMs?: number;
	maxInboundFrameBytes?: number;
	fetch?: typeof globalThis.fetch;
	onOpen?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
	onDoomLoopTrigger?: (triggers: string[]) => void;
};

export type XaiSseSessionEventsOptions = OpenXaiEventsOptions & {
	sessionId?: string;
	projectStoredOutput?: () => readonly unknown[] | undefined;
	storeResponses?: boolean;
};

export type XaiSseSessionPoolOptions = {
	maxInboundFrameBytes?: number;
	maxPendingRequests?: number;
};

function utf8ByteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function isPlainEvent(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite `response.usage.total_tokens` from `context_details.input_tokens + output_tokens`
 * (matching `xai-grok-sampler/src/client.rs:124-166`) and normalize `incomplete_details.reason`
 * (`max_time_limit` / `max_prompt_tokens` -> `max_output_tokens`) so `processResponsesStream`
 * preserves partial completions instead of throwing `stopReason: "error"`.
 */
export function normalizeTerminalResponseEvent(payload: Record<string, unknown>): Record<string, unknown> {
	const type = payload.type;
	if (type !== "response.completed" && type !== "response.incomplete") {
		return payload;
	}
	if (!isPlainEvent(payload.response)) {
		return payload;
	}
	let responseModified = false;
	const response: Record<string, unknown> = { ...payload.response };

	if (isPlainEvent(response.usage) && isPlainEvent(response.usage.context_details)) {
		const details = response.usage.context_details;
		const promptText = typeof details.prompt_text_tokens === "number" ? details.prompt_text_tokens : 0;
		const promptArena = typeof details.prompt_Arena_tokens === "number" ? details.prompt_Arena_tokens : 0;
		const ctxInput =
			typeof details.input_tokens === "number"
				? details.input_tokens
				: promptText + promptArena > 0
					? promptText + promptArena
					: undefined;
		const ctxOutput =
			typeof details.output_tokens === "number"
				? details.output_tokens
				: typeof response.usage.output_tokens === "number"
					? response.usage.output_tokens
					: undefined;
		if (ctxInput !== undefined && ctxOutput !== undefined && ctxInput + ctxOutput > 0) {
			response.usage = {
				...response.usage,
				total_tokens: ctxInput + ctxOutput,
			};
			responseModified = true;
		}
	}

	if (type === "response.incomplete") {
		const details = isPlainEvent(response.incomplete_details) ? response.incomplete_details : undefined;
		const reason = typeof details?.reason === "string" ? details.reason : undefined;
		if (reason !== "max_output_tokens") {
			response.incomplete_details = {
				...details,
				reason: "max_output_tokens",
				xai_original_reason: reason ?? "unknown",
			};
			responseModified = true;
		}
	}

	return responseModified ? { ...payload, response } : payload;
}

function normalizeEvent(payload: Record<string, unknown>): Record<string, unknown> {
	const envelopeType = payload.type;
	if (envelopeType === "response.completed" || envelopeType === "response.incomplete") {
		return normalizeTerminalResponseEvent(payload);
	}
	if (envelopeType !== "error" && envelopeType !== "api_error" && envelopeType !== undefined) {
		return payload;
	}
	const nested = isPlainEvent(payload.error) ? payload.error : undefined;
	let message: string | undefined;
	if (typeof payload.message === "string") {
		message = payload.message;
	} else if (typeof nested?.message === "string") {
		message = nested.message;
	} else if (nested) {
		message = JSON.stringify(nested);
	}
	if (message === undefined) {
		return payload;
	}
	const param = payload.param ?? nested?.param;
	return {
		type: "error",
		code: payload.code ?? nested?.code ?? payload.status,
		message,
		...(param !== undefined ? { param } : {}),
	};
}

function isAbortError(error: Error | undefined): boolean {
	return error?.name === "AbortError" || error?.message === "Request was aborted";
}

function abortError(): Error {
	return Object.assign(new Error("Request was aborted"), { name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw abortError();
	}
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	throwIfAborted(signal);
	if (!signal) {
		return promise;
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<T>((_resolve, reject) => {
		onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

export function normalizeWireRecordWithSize(value: Record<string, unknown>): {
	payload: Record<string, unknown>;
	tokenEstimate: number;
} {
	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized !== "string") {
			throw new TypeError("not serializable");
		}
		const parsed: unknown = JSON.parse(serialized);
		if (isPlainEvent(parsed)) {
			const nonAsciiBytes = Math.max(0, utf8ByteLength(serialized) - serialized.length);
			normalizedWireRecords.add(parsed);
			return {
				payload: parsed,
				tokenEstimate: Math.ceil(serialized.length / 4 + nonAsciiBytes / 2),
			};
		}
	} catch {
		// Fall through to static error.
	}
	throw new TypeError("xAI Responses payload must be a JSON-serializable object");
}

function normalizeWireRecord(value: Record<string, unknown>): Record<string, unknown> {
	return normalizeWireRecordWithSize(value).payload;
}

function fullContextPayload(value: Record<string, unknown>, alreadyNormalized = false): Record<string, unknown> {
	const payload = alreadyNormalized ? { ...value } : normalizeWireRecord(value);
	payload.store = false;
	payload.stream = true;
	delete payload.previous_response_id;
	delete payload.type;
	return payload;
}

const CREDENTIAL_HEADER_NAMES = new Set(["api-key", "authorization", "cookie", "x-api-key"]);

function canonicalHeaders(headers: Record<string, string>, omitCredentials = false): Array<[string, string]> {
	return Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value] as [string, string])
		.filter(([name]) => !omitCredentials || !CREDENTIAL_HEADER_NAMES.has(name))
		.sort(([leftName, leftValue], [rightName, rightValue]) => {
			if (leftName !== rightName) {
				return leftName.localeCompare(rightName);
			}
			return leftValue.localeCompare(rightValue);
		});
}

function continuationTransportIdentity(options: XaiSseSessionEventsOptions): string {
	return JSON.stringify({
		connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
		headers: canonicalHeaders(options.headers, true),
		livenessTimeoutMs: options.livenessTimeoutMs ?? resolveLivenessTimeoutMs(),
		url: normalizeHttpUrl(options.url),
	});
}

function normalizeHttpUrl(url: string): string {
	return url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
}

function isModelOutputEvent(event: Record<string, unknown>): boolean {
	const type = typeof event.type === "string" ? event.type : "";
	return OUTPUT_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

function eventErrorCode(event: Record<string, unknown>): string | undefined {
	if (event.type !== "error") return undefined;
	if (typeof event.code === "string") return event.code;
	if (isPlainEvent(event.error) && typeof event.error.code === "string") {
		return event.error.code;
	}
	return undefined;
}

function isConnectionLimitReached(event: Record<string, unknown>): boolean {
	return eventErrorCode(event) === "websocket_connection_limit_reached";
}

export function isReplayableTransportError(error: unknown): error is XaiSseTransportError {
	return (
		error instanceof XaiSseTransportError &&
		!isAbortError(error) &&
		(error.kind === "connect" || error.kind === "liveness" || error.kind === "socket")
	);
}

export function isTerminalEventType(type: string): boolean {
	return TERMINAL_TYPES.has(type);
}

function isTransientHttpStatus(status: number): boolean {
	return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isDomainErrorEvent(event: Record<string, unknown>): boolean {
	if (isContinuationRejection(event) || isStoredResponseTooLarge(event)) {
		return true;
	}
	const message = typeof event.message === "string" ? event.message : "";
	return CAPACITY_ERROR_PATTERN.test(message);
}

async function runWithTimeout<T>(
	work: () => Promise<T>,
	timeoutMs: number,
	onTimeout: () => XaiSseTransportError,
	signal?: AbortSignal,
): Promise<T> {
	throwIfAborted(signal);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const timeoutPromise = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(onTimeout());
		}, timeoutMs);
		timer.unref?.();
		if (signal) {
			onAbort = () => reject(abortError());
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
	try {
		return await Promise.race([work(), timeoutPromise]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		if (signal && onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

async function readBoundedText(
	response: Response,
	maxBytes: number,
	timeoutMs: number,
	onTimeout: () => XaiSseTransportError,
	signal?: AbortSignal,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let totalBytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await runWithTimeout(() => reader.read(), timeoutMs, onTimeout, signal);
			if (done) {
				text += decoder.decode();
				break;
			}
			if (value) {
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					throw new XaiSseTransportError(
						`xAI SSE error payload size (${totalBytes} bytes) is larger than max (${maxBytes} bytes)`,
						{ kind: "protocol", outputStarted: false, status: response.status },
					);
				}
				text += decoder.decode(value, { stream: true });
			}
		}
		return text;
	} finally {
		reader.releaseLock();
	}
}

function parseErrorBody(rawBody: string, status: number): Record<string, unknown> | undefined {
	const trimmed = rawBody.replace(/^\uFEFF/, "").trim();
	if (!trimmed) return undefined;
	let jsonCandidate = trimmed;
	if (trimmed.startsWith("data:")) {
		const dataLines = trimmed
			.split(/\r\n|\n|\r/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""));
		if (dataLines.length > 0) {
			jsonCandidate = dataLines.join("\n").trim();
		}
	}
	try {
		const parsed: unknown = JSON.parse(jsonCandidate);
		if (isPlainEvent(parsed)) {
			return normalizeEvent(parsed);
		}
	} catch {
		// Fall back to plain text error handling below.
	}
	return {
		code: status,
		message: trimmed,
		type: "error",
	};
}

export async function* requestXaiSseEvents(
	options: OpenXaiEventsOptions,
	maxInboundFrameBytes = DEFAULT_MAX_INBOUND_FRAME_BYTES,
): AsyncGenerator<Record<string, unknown>> {
	throwIfAborted(options.signal);
	const connectTimeoutMs = Math.max(
		1,
		Math.min(Math.floor(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS), MAX_TIMER_MS),
	);
	const livenessTimeoutMs = Math.max(
		1,
		Math.min(Math.floor(options.livenessTimeoutMs ?? resolveLivenessTimeoutMs()), MAX_TIMER_MS),
	);
	const maxFrameBytes = Math.max(1, Math.floor(options.maxInboundFrameBytes ?? maxInboundFrameBytes));
	const fetchFn = options.fetch ?? globalThis.fetch;
	const httpUrl = normalizeHttpUrl(options.url);
	const requestController = new AbortController();
	let abortedByCaller = false;
	let timedOutError: XaiSseTransportError | undefined;
	const onCallerAbort = () => {
		abortedByCaller = true;
		requestController.abort();
	};
	if (options.signal?.aborted) {
		onCallerAbort();
		throw abortError();
	}
	options.signal?.addEventListener("abort", onCallerAbort, { once: true });

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let outputStarted = false;
	let completed = false;

	try {
		const initialTimeoutMs = Math.min(connectTimeoutMs, livenessTimeoutMs);
		const initialTimeoutKind = connectTimeoutMs <= livenessTimeoutMs ? "connect" : "liveness";
		let response: Response;
		try {
			response = await runWithTimeout(
				() =>
					fetchFn(httpUrl, {
						method: "POST",
						headers: {
							Accept: "text/event-stream",
							"Content-Type": "application/json",
							...options.headers,
						},
						body: JSON.stringify(options.createPayload),
						signal: requestController.signal,
					}),
				initialTimeoutMs,
				() => {
					timedOutError = new XaiSseTransportError(
						initialTimeoutKind === "connect"
							? `xAI SSE connect timed out after ${initialTimeoutMs}ms`
							: `xAI SSE stream silent for ${initialTimeoutMs}ms`,
						{ kind: initialTimeoutKind, outputStarted: false },
					);
					requestController.abort();
					return timedOutError;
				},
				options.signal,
			);
		} catch (error) {
			if (abortedByCaller || options.signal?.aborted) throw abortError();
			if (timedOutError) throw timedOutError;
			if (isAbortError(error instanceof Error ? error : undefined)) throw abortError();
			if (error instanceof XaiSseTransportError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new XaiSseTransportError(message, { kind: "connect", outputStarted: false });
		}

		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key.toLowerCase()] = value;
		});

		await awaitWithAbort(
			Promise.resolve().then(() =>
				options.onOpen?.({
					status: response.status,
					headers: responseHeaders,
				}),
			),
			options.signal,
		);

		if (!response.ok) {
			const rawError = await readBoundedText(
				response,
				maxFrameBytes,
				livenessTimeoutMs,
				() => {
					timedOutError = new XaiSseTransportError(`xAI SSE stream silent for ${livenessTimeoutMs}ms`, {
						kind: "liveness",
						outputStarted: false,
						status: response.status,
					});
					requestController.abort();
					return timedOutError;
				},
				options.signal,
			);
			const parsedError = parseErrorBody(rawError, response.status);
			if (isTransientHttpStatus(response.status) && (!parsedError || !isDomainErrorEvent(parsedError))) {
				const detail = typeof parsedError?.message === "string" ? parsedError.message : `HTTP ${response.status}`;
				throw new XaiSseTransportError(`xAI SSE HTTP ${response.status}: ${detail}`, {
					kind: "socket",
					outputStarted: false,
					status: response.status,
				});
			}
			const errorEvent = parsedError ?? {
				code: response.status,
				message: `HTTP ${response.status}`,
				type: "error",
			};
			completed = true;
			yield errorEvent.type === "error" ? errorEvent : { ...errorEvent, type: "error" };
			return;
		}

		if (!response.body) {
			throw new XaiSseTransportError("xAI SSE stream ended before a terminal event", {
				kind: "socket",
				outputStarted: false,
			});
		}

		reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let firstChunk = true;
		let pendingLine = "";
		let pendingCr = false;
		const dataLines: string[] = [];
		let currentEventBytes = 0;

		const parseDataEvent = (rawData: string): Record<string, unknown> | undefined => {
			if (rawData.trim() === "[DONE]") {
				return undefined;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(rawData);
			} catch {
				throw new XaiSseTransportError("xAI SSE sent invalid JSON", {
					kind: "protocol",
					outputStarted,
				});
			}
			if (!isPlainEvent(parsed)) {
				throw new XaiSseTransportError("xAI SSE sent a non-object frame", {
					kind: "protocol",
					outputStarted,
				});
			}
			if (parsed.type === "response.doom_loop_check") {
				const triggers = extractConfidentDoomLoopTriggers(parsed);
				if (triggers.length > 0) {
					options.onDoomLoopTrigger?.(triggers);
				}
				return { type: "response.doom_loop_check", triggers };
			}
			const terminalTriggers = extractConfidentDoomLoopTriggers(parsed);
			if (terminalTriggers.length > 0) {
				options.onDoomLoopTrigger?.(terminalTriggers);
			}
			return normalizeEvent(parsed);
		};

		const consumeLine = (line: string): Record<string, unknown> | undefined => {
			if (line === "") {
				currentEventBytes = 0;
				if (dataLines.length === 0) return undefined;
				const rawData = dataLines.join("\n");
				dataLines.length = 0;
				return parseDataEvent(rawData);
			}
			if (line.startsWith(":")) {
				if (dataLines.length === 0) currentEventBytes = 0;
				return undefined;
			}
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "data") dataLines.push(value);
			return undefined;
		};

		const checkEventBytes = (addedBytes: number): void => {
			currentEventBytes += addedBytes;
			if (currentEventBytes > maxFrameBytes) {
				throw new XaiSseTransportError(
					`xAI SSE frame payload size (${currentEventBytes} bytes) is larger than max (${maxFrameBytes} bytes)`,
					{ kind: "protocol", outputStarted },
				);
			}
		};

		while (true) {
			throwIfAborted(options.signal);
			let readResult: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
			try {
				readResult = await runWithTimeout(
					() => reader!.read(),
					livenessTimeoutMs,
					() => {
						timedOutError = new XaiSseTransportError(`xAI SSE stream silent for ${livenessTimeoutMs}ms`, {
							kind: "liveness",
							outputStarted,
						});
						requestController.abort();
						return timedOutError;
					},
					options.signal,
				);
			} catch (error) {
				if (abortedByCaller || options.signal?.aborted) throw abortError();
				if (timedOutError) throw timedOutError;
				if (isAbortError(error instanceof Error ? error : undefined)) throw abortError();
				if (error instanceof XaiSseTransportError) throw error;
				const message = error instanceof Error ? error.message : String(error);
				throw new XaiSseTransportError(message, { kind: "socket", outputStarted });
			}

			const { done, value } = readResult;
			let chunkText = done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (firstChunk && chunkText.length > 0) {
				firstChunk = false;
				if (chunkText.charCodeAt(0) === 0xfeff) {
					chunkText = chunkText.slice(1);
				}
			}
			if (pendingCr) {
				pendingCr = false;
				if (chunkText.startsWith("\n")) {
					chunkText = chunkText.slice(1);
				}
			}

			let start = 0;
			for (let index = 0; index < chunkText.length; index += 1) {
				const code = chunkText.charCodeAt(index);
				if (code === 0x0d || code === 0x0a) {
					const segment = chunkText.slice(start, index);
					checkEventBytes(utf8ByteLength(segment) + 1);
					const line = pendingLine + segment;
					pendingLine = "";
					if (code === 0x0d) {
						if (index + 1 < chunkText.length && chunkText.charCodeAt(index + 1) === 0x0a) {
							index += 1;
						} else if (index + 1 === chunkText.length && !done) {
							pendingCr = true;
						}
					}
					start = index + 1;
					const event = consumeLine(line);
					if (event) {
						if (isModelOutputEvent(event)) outputStarted = true;
						const eventType = typeof event.type === "string" ? event.type : "";
						const terminal = isTerminalEventType(eventType);
						if (terminal) completed = true;
						yield event;
						throwIfAborted(options.signal);
						if (terminal) return;
					}
				}
			}

			if (start < chunkText.length) {
				const tail = chunkText.slice(start);
				checkEventBytes(utf8ByteLength(tail));
				pendingLine += tail;
			}

			if (done) {
				if (pendingLine.length > 0) {
					const trailing = pendingLine;
					pendingLine = "";
					const event = consumeLine(trailing);
					if (event) {
						if (isModelOutputEvent(event)) outputStarted = true;
						const eventType = typeof event.type === "string" ? event.type : "";
						if (isTerminalEventType(eventType)) completed = true;
						yield event;
						throwIfAborted(options.signal);
						if (completed) return;
					}
				}
				if (dataLines.length > 0) {
					const event = consumeLine("");
					if (event) {
						if (isModelOutputEvent(event)) outputStarted = true;
						const eventType = typeof event.type === "string" ? event.type : "";
						if (isTerminalEventType(eventType)) completed = true;
						yield event;
						throwIfAborted(options.signal);
						if (completed) return;
					}
				}
				break;
			}
		}

		if (!completed) {
			throw new XaiSseTransportError("xAI SSE stream ended before a terminal event", {
				kind: "socket",
				outputStarted,
			});
		}
	} finally {
		options.signal?.removeEventListener("abort", onCallerAbort);
		if (reader) {
			try {
				await reader.cancel();
			} catch {
				// Ignore stream cancellation errors during teardown.
			}
			reader.releaseLock();
		}
		requestController.abort();
	}
}

class XaiSseSession {
	private active = false;
	private continuation: ContinuationState | undefined;
	private continuationTransportKey: string | undefined;
	private disposed = false;
	private pendingAcquires = 0;
	private releaseQueue: Promise<void> = Promise.resolve();
	private requestContext: ContinuationRequestContext | undefined;
	private resolveDisposed!: () => void;
	private readonly disposeController = new AbortController();
	private readonly disposedPromise: Promise<void>;
	private readonly sessionId: string | undefined;
	private readonly poolOptions: Required<XaiSseSessionPoolOptions>;

	constructor(sessionId: string | undefined, poolOptions: Required<XaiSseSessionPoolOptions>) {
		this.sessionId = sessionId;
		this.poolOptions = poolOptions;
		this.disposedPromise = new Promise<void>((resolve) => {
			this.resolveDisposed = resolve;
		});
	}

	get isUnused(): boolean {
		return !this.active && this.pendingAcquires === 0 && !this.continuation;
	}

	async *iterate(options: XaiSseSessionEventsOptions): AsyncGenerator<Record<string, unknown>> {
		const release = await this.acquire(options.signal);
		let clearStoredChainOnExit = false;
		try {
			this.throwIfDisposed();
			this.active = true;

			const wirePayload = normalizedWireRecords.has(options.createPayload)
				? options.createPayload
				: normalizeWireRecord(options.createPayload);
			const storeResponses = options.storeResponses === true;
			clearStoredChainOnExit = storeResponses;
			const nextContinuationKey = continuationTransportIdentity(options);
			if (!storeResponses) {
				this.clearContinuation();
			}
			if (this.continuation && this.continuationTransportKey !== nextContinuationKey) {
				this.clearContinuation();
			}

			let continuationFallbackUsed = false;
			let forceFullContext = false;
			let forceStoreFalse = false;
			let responseReported = false;
			let transportReplayed = false;
			const onOpen: OpenXaiEventsOptions["onOpen"] = async (response) => {
				if (responseReported) return;
				responseReported = true;
				await options.onOpen?.(response);
			};
			const requestSignal = options.signal
				? AbortSignal.any([options.signal, this.disposeController.signal])
				: this.disposeController.signal;

			while (true) {
				this.throwIfDisposed();
				const continuation = forceFullContext || forceStoreFalse ? undefined : this.continuation;
				const payload =
					storeResponses && !forceStoreFalse
						? this.planStoredRequest(wirePayload, continuation)
						: fullContextPayload(wirePayload, true);

				let outputStarted = false;
				let retryConnectionLimit = false;
				let retryContinuationFallback = false;
				let retryStoreFalse = false;
				let yieldedTerminal = false;
				try {
					for await (const event of requestXaiSseEvents(
						{
							...options,
							createPayload: payload,
							onOpen,
							signal: requestSignal,
						},
						this.poolOptions.maxInboundFrameBytes,
					)) {
						if (isModelOutputEvent(event)) {
							outputStarted = true;
						}
						if (isConnectionLimitReached(event) && !transportReplayed && !outputStarted) {
							transportReplayed = true;
							retryConnectionLimit = true;
							break;
						}
						if (
							storeResponses &&
							typeof payload.previous_response_id === "string" &&
							!continuationFallbackUsed &&
							!outputStarted &&
							isContinuationRejection(event)
						) {
							continuationFallbackUsed = true;
							retryContinuationFallback = true;
							break;
						}
						if (storeResponses && !forceStoreFalse && isStoredResponseTooLarge(event)) {
							markStoredResponseTooLarge(this.sessionId);
							this.clearContinuation();
							if (!outputStarted) {
								retryStoreFalse = true;
								break;
							}
							if (!yieldedTerminal) {
								yield {
									response: { status: "completed" },
									type: "response.completed",
								};
							}
							continue;
						}
						const eventType = typeof event.type === "string" ? event.type : "";
						if (isTerminalEventType(eventType) && eventType !== "error") {
							yieldedTerminal = true;
						}
						const stored = storeResponses && !forceStoreFalse ? readStoredResponse(event) : undefined;
						try {
							yield event;
						} finally {
							if (stored) {
								this.observeStoredTerminal(stored, options.projectStoredOutput, nextContinuationKey);
								clearStoredChainOnExit = false;
							}
						}
					}
				} catch (error) {
					if (this.disposed) throw this.disposedError();
					if (isAbortError(error instanceof Error ? error : undefined)) throw error;
					if (!(error instanceof XaiSseTransportError)) throw error;
					if (!transportReplayed && isReplayableTransportError(error) && !error.outputStarted) {
						transportReplayed = true;
						continue;
					}
					throw error;
				}

				if (retryConnectionLimit || retryContinuationFallback || retryStoreFalse) {
					this.throwIfDisposed();
					if (retryContinuationFallback || retryStoreFalse) {
						this.clearContinuation();
						forceFullContext = true;
					}
					if (retryStoreFalse) {
						forceStoreFalse = true;
					}
					continue;
				}
				return;
			}
		} finally {
			if (clearStoredChainOnExit) {
				this.clearContinuation();
			}
			this.active = false;
			release();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.disposeController.abort();
		this.resolveDisposed();
	}

	private async acquire(signal?: AbortSignal): Promise<() => void> {
		this.throwIfDisposed();
		if (this.pendingAcquires >= this.poolOptions.maxPendingRequests) {
			throw new XaiSseTransportError("xAI Responses session request queue is full", { kind: "queue" });
		}
		this.pendingAcquires += 1;
		const previous = this.releaseQueue;
		let release!: () => void;
		this.releaseQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const acquired = await awaitWithAbort(
				Promise.race([previous.then(() => true), this.disposedPromise.then(() => false)]),
				signal,
			);
			if (!acquired) throw this.disposedError();
		} catch (error) {
			void previous.then(release, release);
			throw error;
		} finally {
			this.pendingAcquires -= 1;
		}
		return release;
	}

	private disposedError(): XaiSseTransportError {
		return new XaiSseTransportError("xAI Responses session was disposed", { kind: "lifecycle" });
	}

	private throwIfDisposed(): void {
		if (this.disposed) throw this.disposedError();
	}

	private planStoredRequest(
		base: Record<string, unknown>,
		continuation: ContinuationState | undefined,
	): Record<string, unknown> {
		const plan = planStoredRequestForChain(base, continuation);
		if (plan.resetChain) {
			this.clearContinuation();
		}
		plan.payload.stream = true;
		delete plan.payload.type;
		this.requestContext = plan.context;
		return plan.payload;
	}

	private observeStoredTerminal(
		stored: { responseId: string },
		projectStoredOutput: (() => readonly unknown[] | undefined) | undefined,
		transportKey: string,
	): void {
		const context = this.requestContext;
		this.requestContext = undefined;
		if (!context || !projectStoredOutput) {
			this.clearContinuation();
			return;
		}
		try {
			const projectedOutput = projectStoredOutput();
			if (!projectedOutput) {
				this.clearContinuation();
				return;
			}
			this.continuation = nextContinuationState(context, stored, projectedOutput);
			this.continuationTransportKey = transportKey;
		} catch {
			this.clearContinuation();
		}
	}

	private clearContinuation(): void {
		this.continuation = undefined;
		this.continuationTransportKey = undefined;
		this.requestContext = undefined;
	}
}

export class XaiSseSessionPool {
	private readonly options: Required<XaiSseSessionPoolOptions>;
	private readonly sessionsById = new Map<string, XaiSseSession>();

	constructor(options: XaiSseSessionPoolOptions = {}) {
		this.options = {
			maxInboundFrameBytes: Math.max(1, Math.floor(options.maxInboundFrameBytes ?? DEFAULT_MAX_INBOUND_FRAME_BYTES)),
			maxPendingRequests: Math.max(
				1,
				Math.floor(options.maxPendingRequests ?? DEFAULT_MAX_PENDING_SESSION_REQUESTS),
			),
		};
	}

	async *iterate(options: XaiSseSessionEventsOptions): AsyncGenerator<Record<string, unknown>> {
		const sessionId = options.sessionId?.trim();
		if (!sessionId) {
			const session = new XaiSseSession(undefined, this.options);
			try {
				yield* session.iterate({ ...options, sessionId: undefined, storeResponses: false });
			} finally {
				session.dispose();
			}
			return;
		}

		let session = this.sessionsById.get(sessionId);
		if (session) {
			this.sessionsById.delete(sessionId);
			this.sessionsById.set(sessionId, session);
		} else {
			if (this.sessionsById.size >= MAX_TRACKED_SESSIONS) {
				const oldestKey = this.sessionsById.keys().next().value;
				if (oldestKey !== undefined) {
					this.sessionsById.get(oldestKey)?.dispose();
					this.sessionsById.delete(oldestKey);
				}
			}
			session = new XaiSseSession(sessionId, this.options);
			this.sessionsById.set(sessionId, session);
		}

		try {
			yield* session.iterate({ ...options, sessionId });
		} finally {
			if (session.isUnused && this.sessionsById.get(sessionId) === session) {
				this.sessionsById.delete(sessionId);
				session.dispose();
			}
		}
	}
}

export const defaultXaiSseSessionPool = new XaiSseSessionPool();

export async function* iterateXaiSseSessionEvents(
	options: XaiSseSessionEventsOptions,
): AsyncGenerator<Record<string, unknown>> {
	yield* defaultXaiSseSessionPool.iterate(options);
}

export function normalizeXaiErrorMessage(message: string, replayableTransportError: boolean): string {
	const trimmed = message.trim() || "An unknown xAI Responses error occurred";
	if (trimmed.startsWith("xAI ") || trimmed.startsWith("Request was aborted")) {
		return trimmed;
	}
	if (replayableTransportError) {
		return `xAI Responses transport error: ${trimmed}`;
	}
	return `xAI API error: ${trimmed}`;
}

export { debugEnabled };
