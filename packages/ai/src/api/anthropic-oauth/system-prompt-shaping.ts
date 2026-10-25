// Adapted from @gotgenes/pi-anthropic-auth 3.4.2 (MIT, Christopher D. Lasher).
// See LICENSE in this directory.
import {
	MINIMAL_ANTHROPIC_OAUTH_PROMPT,
	PI_DEFAULT_PROMPT_PREFIX,
	PI_DOCS_SECTION_ANCHOR,
	PI_OWNED_SECTIONS,
	PI_TOOLS_FILLER_ANCHOR,
	TEXT_REPLACEMENTS,
} from "./constants.ts";
import { namedSection, parseSystemPromptChunks, renderSystemPromptChunks } from "./system-prompt-sections.ts";

/** Returns undefined only for Pi's recognized documentation section. */
function shapeSection(name: string, body: string): string | undefined {
	if (name !== "preamble" && !PI_OWNED_SECTIONS.includes(name)) return body;
	let text = body;
	for (const rule of TEXT_REPLACEMENTS) text = text.replaceAll(rule.match, rule.replacement);
	if (name === "preamble" && text.startsWith(PI_DEFAULT_PROMPT_PREFIX)) return MINIMAL_ANTHROPIC_OAUTH_PROMPT;
	if (name === "docs" && text.startsWith(PI_DOCS_SECTION_ANCHOR)) return undefined;
	if (name === "tools") {
		const paragraphs = text.split(/\n\n+/);
		const kept = paragraphs.filter((paragraph) => !paragraph.trimStart().startsWith(PI_TOOLS_FILLER_ANCHOR));
		if (kept.length !== paragraphs.length) return kept.join("\n\n").trim();
	}
	return text;
}

/** Only Pi's unique, single-preamble structure is safe to rewrite. */
function hasUnambiguousPiPrompt(chunks: ReturnType<typeof parseSystemPromptChunks>): boolean {
	const first = chunks[0];
	if (!first || first.name !== null || !first.body.startsWith(PI_DEFAULT_PROMPT_PREFIX)) return false;
	const names = new Set<string>();
	let hasOwnedSection = false;
	for (const [index, chunk] of chunks.entries()) {
		if (chunk.name === null) {
			if (index !== 0) return false;
			continue;
		}
		if (names.has(chunk.name)) return false;
		names.add(chunk.name);
		if (PI_OWNED_SECTIONS.includes(chunk.name)) hasOwnedSection = true;
	}
	return hasOwnedSection;
}

/** Unknown prompts and project/skill sections pass through unchanged. */
export function shapeSystemPrompt(text: string): string {
	if (!text.startsWith(PI_DEFAULT_PROMPT_PREFIX)) return text;
	const chunks = parseSystemPromptChunks(text);
	if (!hasUnambiguousPiPrompt(chunks)) return text;
	return renderSystemPromptChunks(
		chunks.flatMap((chunk, index) => {
			const name = chunk.name ?? (index === 0 ? "preamble" : undefined);
			if (name === undefined) return [chunk];
			const shaped = shapeSection(name, chunk.body);
			if (shaped === undefined) return [];
			if (shaped === chunk.body) return [chunk];
			return [chunk.name === null ? { name: null, raw: shaped, body: shaped } : namedSection(chunk.name, shaped)];
		}),
	);
}

const SECTION_UPDATE_FRAME =
	/^(?:Updated system prompt section "([a-z][a-z0-9_-]*)":\n\n|Removed system prompt section "([a-z][a-z0-9_-]*)"\.$)/gm;
const SHAPED_UPDATE_SECTIONS = new Set(["preamble", ...PI_OWNED_SECTIONS]);

/** Apply the same rules to native mid-conversation system updates. */
export function shapeSystemUpdateText(text: string): string | undefined {
	const frames = [...text.matchAll(SECTION_UPDATE_FRAME)];
	if (!frames.length) return text;
	// An unknown outer section can contain frame-shaped user bytes. Keep the whole
	// message rather than guessing where its value ends.
	if (frames.some((frame) => !SHAPED_UPDATE_SECTIONS.has(frame[1] ?? frame[2]!))) return text;
	const parts: string[] = [];
	const leading = text.slice(0, frames[0]!.index).trim();
	if (leading) parts.push(leading);
	for (const [index, frame] of frames.entries()) {
		const removed = frame[2];
		if (removed !== undefined) {
			if (removed !== "docs") parts.push(frame[0]);
			continue;
		}
		const name = frame[1]!;
		const end = frames[index + 1]?.index ?? text.length;
		const value = text.slice(frame.index + frame[0].length, end).trimEnd();
		const section = parseSystemPromptChunks(value);
		const tagged = section.length === 1 && section[0]!.name === name && section[0]!.raw === value;
		if (name !== "preamble" && !tagged) return text;
		const shaped = shapeSection(name, tagged ? section[0]!.body : value);
		if (shaped !== undefined) parts.push(`${frame[0]}${tagged ? namedSection(name, shaped).raw : shaped}`);
	}
	return parts.length ? parts.join("\n\n") : undefined;
}
