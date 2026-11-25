import type { Message, TextContent, ThinkingContent, ToolCall } from "../types.ts";

/** Options controlling post-read study-note harvesting across reasoning and commentary models. */
export interface StudyNoteHarvestOptions {
	/** Keep notes from turns immediately following a non-error read matching one of these paths/globs (omitted = any non-error read). */
	readonly relevantPaths?: readonly string[];
	/** Minimum non-heading chars in `block.thinking` before falling back to pre-tool `commentary` text. Default: 100. */
	readonly minThinkingChars?: number;
	/** Tail cap per harvested block so raw-CoT models (DeepSeek V4) do not flood executor prefills. Default: 1500. */
	readonly maxCharsPerBlock?: number;
	/** Read tool names recognized on preceding ToolResultMessages. Default: ["read", "tool_read"]. */
	readonly readToolNames?: readonly string[];
}

/** System-prompt guidance for encrypted-reasoning models so pre-tool `commentary` carries durable technical notes. */
export const ENCRYPTED_REASONING_COMMENTARY_PROMPT =
	"After each file-read batch, state 2-3 concise sentences of technical invariants and cross-file constraints before your next tool call.";

const DEFAULT_READ_TOOL_NAMES = ["read", "tool_read"] as const;

function normalizePosixStudyPath(raw: string): { path: string; isAbsolute: boolean } {
	const slash = raw.trim().replaceAll("\\", "/");
	const driveMatch = /^[A-Za-z]:\//.exec(slash);
	const prefix = driveMatch ? driveMatch[0] : slash.startsWith("/") ? "/" : "";
	const body = prefix ? slash.slice(prefix.length) : slash;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (!prefix) parts.push("..");
			continue;
		}
		parts.push(part);
	}
	const joined = parts.join("/");
	if (prefix) return { path: `${prefix}${joined}`, isAbsolute: true };
	return { path: joined || ".", isAbsolute: false };
}

function globPatternToRegex(pattern: string, isAbsolute: boolean): RegExp {
	let body = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					body += "(?:.*/)?";
					i += 2;
				} else {
					body += ".*";
					i += 1;
				}
			} else {
				body += "[^/]*";
			}
		} else if (ch === "?") {
			body += "[^/]";
		} else if ("\\.^$+()[]{}|".includes(ch)) {
			body += `\\${ch}`;
		} else {
			body += ch;
		}
	}
	return isAbsolute ? new RegExp(`^${body}$`) : new RegExp(`(?:^|/)${body}$`);
}

function matchesStudyPath(actualRaw: string, patterns: readonly string[]): boolean {
	const actual = normalizePosixStudyPath(actualRaw);
	if (!actual.path || actual.path === ".") return false;
	for (const rawPattern of patterns) {
		if (!rawPattern.trim()) continue;
		const pattern = normalizePosixStudyPath(rawPattern);
		if (!pattern.path || pattern.path === ".") continue;
		if (pattern.path.includes("*") || pattern.path.includes("?")) {
			if (globPatternToRegex(pattern.path, pattern.isAbsolute).test(actual.path)) return true;
			continue;
		}
		if (actual.path === pattern.path) return true;
		if (actual.path.startsWith(`${pattern.path}/`)) return true;
		if (
			!pattern.isAbsolute &&
			(actual.path.endsWith(`/${pattern.path}`) || actual.path.includes(`/${pattern.path}/`))
		) {
			return true;
		}
	}
	return false;
}

function extractReadPathArg(args: ToolCall["arguments"]): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

function parseTextPhase(signature: string | undefined): "commentary" | "final_answer" | undefined {
	if (!signature || !signature.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(signature) as { v?: unknown; phase?: unknown };
		if (parsed.v === 1 && (parsed.phase === "commentary" || parsed.phase === "final_answer")) {
			return parsed.phase;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function cleanThinkingNote(blocks: readonly ThinkingContent[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.redacted) continue;
		const stripped = block.thinking
			.replace(/^\s*\*\*[^\n]+\*\*\s*$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		if (stripped.length > 0) parts.push(stripped);
	}
	return parts.join("\n\n");
}

function extractCommentaryNote(blocks: readonly TextContent[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (parseTextPhase(block.textSignature) === "final_answer") continue;
		const trimmed = block.text.trim();
		if (trimmed.length > 0) parts.push(trimmed);
	}
	return parts.join("\n\n");
}

function escapeStudyNotesFence(text: string): string {
	return text.replace(/<\/study_notes/gi, "<\\/study_notes");
}

/**
 * Harvest chronological post-read reasoning or pre-tool commentary notes across all model families
 * into a fence-escaped `<study_notes>` XML block suitable for checkpoint fork handoffs.
 */
export function harvestPostReadStudyNotes(
	messages: readonly Message[],
	options?: StudyNoteHarvestOptions,
): string | undefined {
	const minThinkingChars = options?.minThinkingChars ?? 100;
	const maxCharsPerBlock = options?.maxCharsPerBlock ?? 1500;
	if (maxCharsPerBlock <= 0) return undefined;

	const readTools = new Set((options?.readToolNames ?? DEFAULT_READ_TOOL_NAMES).map((name) => name.toLowerCase()));
	const relevantPaths = options?.relevantPaths;
	const toolCallById = new Map<string, { name: string; path?: string }>();
	let precedingReads: Array<{ path?: string }> = [];
	const entries: string[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			continue;
		}
		if (msg.role === "user") {
			precedingReads = [];
			continue;
		}
		if (msg.role === "toolResult") {
			const paired = toolCallById.get(msg.toolCallId);
			const toolName = paired?.name ?? msg.toolName;
			if (!msg.isError && readTools.has(toolName.toLowerCase())) {
				if (relevantPaths === undefined) {
					precedingReads.push({ path: paired?.path });
				} else if (paired?.path && matchesStudyPath(paired.path, relevantPaths)) {
					precedingReads.push({ path: paired.path });
				}
			}
			continue;
		}
		if (msg.role === "assistant") {
			const reads = precedingReads;
			precedingReads = [];

			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				if (block.type === "toolCall") {
					toolCallById.set(block.id, { name: block.name, path: extractReadPathArg(block.arguments) });
				}
			}

			if (reads.length === 0 || msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}

			const thinkingBlocks = content.filter((block): block is ThinkingContent => block.type === "thinking");
			const cleanedThinking = cleanThinkingNote(thinkingBlocks);

			let note = "";
			if (cleanedThinking.length >= minThinkingChars) {
				if (cleanedThinking.length > maxCharsPerBlock) {
					const sliced = cleanedThinking.slice(-maxCharsPerBlock);
					note = sliced.trimStart() || sliced;
				} else {
					note = cleanedThinking;
				}
			} else if (content.some((block) => block.type === "toolCall")) {
				const textBlocks = content.filter((block): block is TextContent => block.type === "text");
				const commentary = extractCommentaryNote(textBlocks);
				if (commentary.length > 0) {
					note =
						commentary.length > maxCharsPerBlock ? commentary.slice(0, maxCharsPerBlock).trimEnd() : commentary;
				}
			}

			if (!note) continue;

			const uniquePaths: string[] = [];
			const seenPaths = new Set<string>();
			for (const read of reads) {
				if (!read.path || seenPaths.has(read.path)) continue;
				seenPaths.add(read.path);
				uniquePaths.push(read.path);
			}
			const pathsLabel = uniquePaths.length > 0 ? uniquePaths.join(", ") : "files";
			entries.push(`[after reading ${escapeStudyNotesFence(pathsLabel)}]\n${escapeStudyNotesFence(note)}`);
		}
	}

	if (entries.length === 0) return undefined;
	return `<study_notes>\n${entries.join("\n\n")}\n</study_notes>`;
}
