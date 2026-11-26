import type { Message } from "@earendil-works/pi-ai";

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
