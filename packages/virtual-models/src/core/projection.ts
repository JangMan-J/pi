import type { Message, SystemMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai/utils/text";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { ModelRoute } from "./types.ts";

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
