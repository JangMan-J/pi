import type { Message } from "@earendil-works/pi-ai";
import type { ContextView } from "../types.ts";
import type { RawTurn } from "./types.ts";

export function estimateTextTokens(text: string): number {
	return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}

/** Text of a message `content`: a string, or the text blocks of a block array. Everything else is ignored. */
export function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const b of content as Array<Record<string, unknown>>) {
		if (b.type === "text" && typeof b.text === "string") out.push(b.text);
	}
	return out.join("\n");
}

type AnyMessage = { role?: string; content?: unknown; toolCallId?: string };

function defaultEstimate(m: unknown): number {
	const msg = m as AnyMessage;
	const text = blockText(msg.content);
	const blocks = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
	const extra = blocks
		.filter((b) => b.type === "toolCall" || b.type === "thinking")
		.reduce((n, b) => n + JSON.stringify(b).length, 0);
	return estimateTextTokens(text) + Math.ceil(extra / 4);
}

/**
 * Guard matching `CompactionTask`'s `isCandidate`: a user entry is NOT a safe cut point if a `toolResult`
 * answering the preceding assistant turn's `toolCall` still follows this entry before the next assistant turn.
 */
function hasPendingToolResultAfter(contributions: ContextView["contributions"], index: number): boolean {
	let calls: ReadonlySet<string> = new Set();
	for (let before = index - 1; before >= 0; before--) {
		const assistant = contributions[before]!.findLast((message) => message.role === "assistant");
		if (assistant === undefined) continue;
		calls = new Set(assistant.content.flatMap((content) => (content.type === "toolCall" ? [content.id] : [])));
		break;
	}
	if (calls.size === 0) return false;
	for (let after = index; after < contributions.length; after++) {
		for (const [position, message] of contributions[after]!.entries()) {
			if (message.role === "assistant" && (after > index || position > 0)) return false;
			if (message.role === "toolResult" && calls.has(message.toolCallId)) return true;
		}
	}
	return false;
}

/**
 * One RawTurn for the model messages one history entry contributes. User messages without pending tool results
 * and assistant messages (matching `CompactionTask.isCandidate`) are valid cut points.
 */
export function turnFromMessages(
	id: string,
	messages: readonly unknown[],
	estimate: (m: unknown) => number = defaultEstimate,
	safeUserCut = true,
): RawTurn {
	const first = (messages[0] ?? {}) as AnyMessage;
	const estimatedTokens = messages.reduce<number>((n, m) => n + estimate(m), 0);
	if (first.role === "user") {
		return { id, role: "user", text: blockText(first.content), estimatedTokens, safeCutPoint: safeUserCut };
	}
	if (first.role === "assistant") {
		const blocks = Array.isArray(first.content) ? (first.content as Array<Record<string, unknown>>) : [];
		const toolCalls = blocks
			.filter((b) => b.type === "toolCall")
			.map((b) => {
				const args = (b.arguments ?? {}) as Record<string, unknown>;
				const label = typeof args.path === "string" ? args.path : undefined;
				return { name: String(b.name), ...(label ? { label } : {}) };
			});
		return { id, role: "assistant", text: blockText(blocks), toolCalls, estimatedTokens, safeCutPoint: true };
	}
	if (first.role === "toolResult") return { id, role: "toolResult", text: "", estimatedTokens, safeCutPoint: false };
	return { id, role: "other", text: "", estimatedTokens: 0, safeCutPoint: false };
}

/** One turn per entry of the active context, never the head marker, with pending-toolResult cut safety. */
export function viewTurns(view: ContextView, estimate: (m: Message) => number): RawTurn[] {
	const turns: RawTurn[] = [];
	view.entries.forEach((entry, i) => {
		if (view.head !== undefined && i === 0) return;
		const msgs = view.contributions[i] ?? [];
		if (msgs.length === 0) return;
		const safeUserCut = msgs[0]?.role === "user" && !hasPendingToolResultAfter(view.contributions, i);
		turns.push(turnFromMessages(String(entry.id), msgs, (m) => estimate(m as Message), safeUserCut));
	});
	return turns;
}

/**
 * Choose where a swap cuts. keepTail=false: no tail (firstKeptId null, clean baton).
 * keepTail=true: keep roughly keepRecentTokens, starting at a safe user message.
 */
export function selectCut(
	turns: readonly RawTurn[],
	keepTail: boolean,
	keepRecentTokens: number,
): { firstKeptId: string | null; aged: readonly RawTurn[]; keptTokens: number; totalTokens: number } {
	const totalTokens = turns.reduce((s, t) => s + t.estimatedTokens, 0);
	if (!keepTail || turns.length === 0) return { firstKeptId: null, aged: turns, keptTokens: 0, totalTokens };

	let kept = 0;
	let cut = -1;
	for (let i = turns.length - 1; i >= 0; i--) {
		kept += turns[i]!.estimatedTokens;
		if (turns[i]!.safeCutPoint && kept >= keepRecentTokens) {
			cut = i;
			break;
		}
	}
	// Never cut at index 0 (nothing aged out) — fall back to a clean baton.
	if (cut <= 0) return { firstKeptId: null, aged: turns, keptTokens: 0, totalTokens };
	return {
		firstKeptId: turns[cut]!.id,
		aged: turns.slice(0, cut),
		keptTokens: turns.slice(cut).reduce((s, t) => s + t.estimatedTokens, 0),
		totalTokens,
	};
}

/**
 * Where a swap keeps from. Covers everything after `preparedThroughId` when staged without a tail cut,
 * never starting on a toolResult (walks back to its preceding assistant turn).
 */
export function chooseKeepFrom(o: {
	stagedFirstKeptId: string | null;
	preparedThroughId?: string;
	turns: readonly RawTurn[];
	midRun: boolean;
}): string | null {
	let idx: number | undefined;
	if (o.stagedFirstKeptId) {
		const stagedIdx = o.turns.findIndex((t) => t.id === o.stagedFirstKeptId);
		if (stagedIdx < 0) return o.stagedFirstKeptId;
		idx = stagedIdx;
	} else {
		const at = o.preparedThroughId ? o.turns.findIndex((t) => t.id === o.preparedThroughId) : -1;
		if (at >= 0 && at + 1 < o.turns.length) {
			idx = o.turns[at + 1]!.role === "toolResult" ? at : at + 1;
		}
	}
	const preparedIdx =
		o.stagedFirstKeptId === null && o.preparedThroughId ? o.turns.findIndex((t) => t.id === o.preparedThroughId) : -1;
	if (o.midRun) {
		// Never clamp to index 0 (anchorUser0 is preserved), and only pull back to lastUser > 0 if
		// that user turn arrived after preparedThroughId (unsummarized) or is already inside the kept tail.
		const lastUser = o.turns.findLastIndex((t) => t.role === "user");
		if (lastUser > 0 && ((preparedIdx >= 0 && lastUser > preparedIdx) || (idx !== undefined && lastUser >= idx))) {
			idx = idx === undefined ? lastUser : Math.min(idx, lastUser);
		}
	}
	if (idx !== undefined) {
		while (idx > 0 && (o.turns[idx]!.role === "toolResult" || !o.turns[idx]!.safeCutPoint)) {
			idx -= 1;
		}
		if (idx === 0) idx = undefined;
	}
	return idx === undefined ? null : o.turns[idx]!.id;
}
