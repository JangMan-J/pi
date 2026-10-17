import type { Model, TranscriptContext } from "../../types.ts";

const MAX_TRACKED_SESSIONS = 128;

type ThinkingBlock = {
	type: "thinking";
	thinking?: string;
	thinkingSignature?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isResponsesThinkingSignature(signature: string): boolean {
	if (!signature.startsWith("{")) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(signature);
		return isRecord(parsed);
	} catch {
		return false;
	}
}

function sanitizeContentBlock(block: unknown): unknown {
	if (!isRecord(block) || block.type !== "thinking") {
		return block;
	}
	const thinking = block as ThinkingBlock;
	if (!thinking.thinkingSignature || isResponsesThinkingSignature(thinking.thinkingSignature)) {
		return block;
	}
	const { thinkingSignature: _dropped, ...rest } = thinking;
	return rest;
}

function isFailedAssistantMessage(message: unknown): boolean {
	return (
		isRecord(message) &&
		message.role === "assistant" &&
		(message.stopReason === "error" || message.stopReason === "aborted")
	);
}

function sanitizeMessage(
	message: unknown,
	targetModel?: Pick<Model<"openai-responses">, "id" | "provider" | "api">,
): unknown {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return message;
	}
	const isSameProviderResponses =
		targetModel !== undefined && message.provider === targetModel.provider && message.api === targetModel.api;
	return {
		...message,
		// Preserve encrypted reasoning signatures and tool call IDs across xAI model tier switches
		// (e.g. grok-4.7 <-> grok-4.7-build-fast <-> grok-4.6) instead of downgrading thinking to text.
		...(isSameProviderResponses ? { model: targetModel.id } : {}),
		content: message.content.map(sanitizeContentBlock),
	};
}

export function sanitizeContextMessages(
	context: TranscriptContext,
	targetModel?: Pick<Model<"openai-responses">, "id" | "provider" | "api">,
): TranscriptContext {
	return {
		...context,
		messages: context.messages
			.filter((message) => !isFailedAssistantMessage(message))
			.map((message) => sanitizeMessage(message, targetModel)) as TranscriptContext["messages"],
	};
}

type ImageRef = {
	blockIndex: number;
	bytes: number;
	key: string;
	messageIndex: number;
};

const omittedImageKeysBySession = new Map<string, Set<string>>();

export function clearOmittedImages(sessionId: string | undefined): void {
	const key = sessionId?.trim();
	if (key) {
		omittedImageKeysBySession.delete(key);
	}
}

function imageBytes(block: Record<string, unknown>): number {
	return typeof block.data === "string" ? block.data.length : 0;
}

function omittedImageText(block: Record<string, unknown>): string {
	const mime = typeof block.mimeType === "string" && block.mimeType.trim() !== "" ? block.mimeType : "image";
	return `[omitted earlier screenshot: ${mime}]`;
}

/** Fast, browser-safe 64-bit FNV-1a fingerprint + length for image deduplication. */
function imageKey(block: Record<string, unknown>): string {
	const data = typeof block.data === "string" ? block.data : "";
	let h1 = 0x811c9dc5;
	let h2 = 0x811c9dc5;
	const step = Math.max(1, Math.floor(data.length / 4096));
	for (let i = 0; i < data.length; i += step) {
		const code = data.charCodeAt(i);
		h1 = Math.imul(h1 ^ (code & 0xff), 0x01000193);
		h2 = Math.imul(h2 ^ (code >>> 8), 0x01000193);
	}
	return `${data.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

function omittedSet(sessionId: string | undefined): Set<string> | undefined {
	const key = sessionId?.trim();
	if (!key) {
		return undefined;
	}
	let omitted = omittedImageKeysBySession.get(key);
	if (omitted) {
		omittedImageKeysBySession.delete(key);
		omittedImageKeysBySession.set(key, omitted);
		return omitted;
	}
	if (omittedImageKeysBySession.size >= MAX_TRACKED_SESSIONS) {
		const oldest = omittedImageKeysBySession.keys().next().value;
		if (oldest !== undefined) {
			omittedImageKeysBySession.delete(oldest);
		}
	}
	omitted = new Set<string>();
	omittedImageKeysBySession.set(key, omitted);
	return omitted;
}

export function limitContextImageBytes(
	context: TranscriptContext,
	maxBytes: number,
	sessionId?: string,
): TranscriptContext {
	if (!Number.isFinite(maxBytes) || maxBytes < 0) {
		return context;
	}
	const sessionOmitted = omittedSet(sessionId);
	const images: ImageRef[] = [];
	let totalBytes = 0;

	context.messages.forEach((message, messageIndex) => {
		if (!isRecord(message) || !Array.isArray(message.content)) {
			return;
		}
		message.content.forEach((block, blockIndex) => {
			if (!isRecord(block) || block.type !== "image") {
				return;
			}
			const bytes = imageBytes(block);
			const key = imageKey(block);
			images.push({ blockIndex, bytes, key, messageIndex });
			if (!sessionOmitted?.has(key)) {
				totalBytes += bytes;
			}
		});
	});

	if (images.length === 0) {
		return context;
	}

	const keep = new Set<string>();
	let keptBytes = 0;
	for (let index = images.length - 1; index >= 0; index -= 1) {
		const image = images[index]!;
		if (sessionOmitted?.has(image.key)) {
			continue;
		}
		if (keptBytes + image.bytes <= maxBytes) {
			keep.add(`${image.messageIndex}:${image.blockIndex}`);
			keptBytes += image.bytes;
		} else {
			sessionOmitted?.add(image.key);
		}
	}

	if (keep.size === images.length && totalBytes <= maxBytes) {
		return context;
	}

	const droppedByMessage = new Map<number, Set<number>>();
	for (const image of images) {
		if (keep.has(`${image.messageIndex}:${image.blockIndex}`)) {
			continue;
		}
		const dropped = droppedByMessage.get(image.messageIndex) ?? new Set<number>();
		dropped.add(image.blockIndex);
		droppedByMessage.set(image.messageIndex, dropped);
	}

	return {
		...context,
		messages: context.messages.map((message, messageIndex) => {
			const dropped = droppedByMessage.get(messageIndex);
			if (!dropped || !isRecord(message) || !Array.isArray(message.content)) {
				return message;
			}
			return {
				...message,
				content: message.content.map((block, blockIndex) => {
					if (!dropped.has(blockIndex) || !isRecord(block)) {
						return block;
					}
					return {
						type: "text",
						text: omittedImageText(block),
					};
				}),
			};
		}) as TranscriptContext["messages"],
	};
}
