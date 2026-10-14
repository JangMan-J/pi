export type ContinuationState = {
	responseId: string;
	coveredItemCount: number;
	coveredInputDigest: string;
};

export type ContinuationRequestContext = {
	fullInput: readonly unknown[];
};

class Fnv64Digest {
	private h1 = 0x811c9dc5;
	private h2 = 0x811c9dc5;
	private count = 0;

	update(text: string): void {
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			this.h1 = Math.imul(this.h1 ^ (c & 0xff), 0x01000193);
			this.h2 = Math.imul(this.h2 ^ ((c >>> 8) ^ (i & 0xff)), 0x01000193);
			this.count += 1;
		}
	}

	digest(): string {
		return `fnv64:${(this.h1 >>> 0).toString(16).padStart(8, "0")}${(this.h2 >>> 0).toString(16).padStart(8, "0")}:${this.count.toString(16)}`;
	}
}

export function continuationInputDigest(input: readonly unknown[], itemCount = input.length): string {
	if (!Number.isSafeInteger(itemCount) || itemCount < 0 || itemCount > input.length) {
		throw new RangeError("Continuation item count is outside the input range");
	}
	return digestInputParts([{ input, itemCount }]);
}

function digestInputParts(parts: ReadonlyArray<{ input: readonly unknown[]; itemCount: number }>): string {
	const hash = new Fnv64Digest();
	let totalItemCount = 0;
	for (const part of parts) {
		totalItemCount += part.itemCount;
	}
	hash.update(`a${totalItemCount}:`);
	for (const part of parts) {
		for (let index = 0; index < part.itemCount; index += 1) {
			updateJsonDigest(hash, part.input[index]);
		}
	}
	return hash.digest();
}

function updateJsonDigest(hash: Fnv64Digest, value: unknown): void {
	if (value === null) {
		hash.update("z");
		return;
	}
	if (typeof value === "boolean") {
		hash.update(value ? "b1" : "b0");
		return;
	}
	if (typeof value === "number") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new TypeError("Continuation input must contain only JSON values");
		}
		hash.update(`n${serialized};`);
		return;
	}
	if (typeof value === "string") {
		hash.update(`s${value.length}:${value}`);
		return;
	}
	if (Array.isArray(value)) {
		hash.update(`a${value.length}:`);
		for (const item of value) {
			updateJsonDigest(hash, item);
		}
		return;
	}
	if (!isPlainRecord(value)) {
		throw new TypeError("Continuation input must contain only JSON values");
	}
	const keys = Object.keys(value).sort();
	hash.update(`o${keys.length}:`);
	for (const key of keys) {
		hash.update(`k${key.length}:${key}`);
		updateJsonDigest(hash, value[key]);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function continuationInput(payload: Record<string, unknown>): readonly unknown[] {
	const input = payload.input;
	return Array.isArray(input) ? input : [];
}

export function planStoredRequest(
	base: Record<string, unknown>,
	state: Readonly<ContinuationState> | undefined,
): { context: ContinuationRequestContext; payload: Record<string, unknown>; resetChain: boolean } {
	const payload: Record<string, unknown> = { ...base, store: true };
	delete payload.previous_response_id;
	const fullInput = [...continuationInput(payload)];

	if (!state) {
		return {
			context: { fullInput },
			payload,
			resetChain: false,
		};
	}

	const coveredItemCount = state.coveredItemCount;
	const validCoveredItemCount =
		Number.isSafeInteger(coveredItemCount) && coveredItemCount >= 0 && fullInput.length > coveredItemCount;
	let prefixIntact = false;
	if (validCoveredItemCount) {
		try {
			prefixIntact = continuationInputDigest(fullInput, coveredItemCount) === state.coveredInputDigest;
		} catch {
			prefixIntact = false;
		}
	}
	if (!prefixIntact) {
		return {
			context: { fullInput },
			payload,
			resetChain: true,
		};
	}

	const continued: Record<string, unknown> = {
		...payload,
		input: fullInput.slice(coveredItemCount),
		previous_response_id: state.responseId,
	};
	return {
		context: { fullInput },
		payload: continued,
		resetChain: false,
	};
}

const STORED_TERMINAL_TYPES = new Set(["response.completed", "response.incomplete"]);

export function readStoredResponse(event: Record<string, unknown>): { responseId: string } | undefined {
	if (!STORED_TERMINAL_TYPES.has(typeof event.type === "string" ? event.type : "")) {
		return undefined;
	}
	const response = isPlainRecord(event.response) ? event.response : undefined;
	if (!response || typeof response.id !== "string" || response.id === "") {
		return undefined;
	}
	return { responseId: response.id };
}

export function nextContinuationState(
	context: ContinuationRequestContext,
	stored: { responseId: string },
	projectedOutput: readonly unknown[],
): ContinuationState {
	return {
		coveredInputDigest: digestInputParts([
			{ input: context.fullInput, itemCount: context.fullInput.length },
			{ input: projectedOutput, itemCount: projectedOutput.length },
		]),
		coveredItemCount: context.fullInput.length + projectedOutput.length,
		responseId: stored.responseId,
	};
}

export function isContinuationRejection(event: Record<string, unknown>): boolean {
	if (event.type !== "error") {
		return false;
	}
	const code = typeof event.code === "string" ? event.code.toLowerCase() : "";
	if (code.includes("previous_response")) {
		return true;
	}
	const nestedError = isPlainRecord(event.error) ? event.error : undefined;
	const nestedCode = typeof nestedError?.code === "string" ? nestedError.code.toLowerCase() : "";
	if (nestedCode.includes("previous_response")) {
		return true;
	}
	const param = typeof event.param === "string" ? event.param.toLowerCase() : "";
	const nestedParam = typeof nestedError?.param === "string" ? nestedError.param.toLowerCase() : "";
	if (param === "previous_response_id" || nestedParam === "previous_response_id") {
		return true;
	}
	const message = typeof event.message === "string" ? event.message.toLowerCase() : "";
	return (
		message.includes("previous_response_id") ||
		(message.includes("previous response") && message.includes("not found")) ||
		(message.includes("response with id=") && message.includes("not found"))
	);
}

export function isStoredResponseTooLargeMessage(message: string): boolean {
	return message.toLowerCase().includes("too large to store");
}

export function isStoredResponseTooLarge(event: Record<string, unknown>): boolean {
	if (event.type === "error" || event.type === "api_error") {
		return isStoredResponseTooLargeMessage(eventMessage(event));
	}
	if (event.type !== "response.failed") {
		return false;
	}
	const response = isPlainRecord(event.response) ? event.response : undefined;
	const nestedError = isPlainRecord(response?.error) ? response.error : undefined;
	const nestedMessage = typeof nestedError?.message === "string" ? nestedError.message : "";
	return isStoredResponseTooLargeMessage(nestedMessage);
}

function eventMessage(event: Record<string, unknown>): string {
	if (typeof event.message === "string") {
		return event.message;
	}
	const nestedError = isPlainRecord(event.error) ? event.error : undefined;
	return typeof nestedError?.message === "string" ? nestedError.message : "";
}
