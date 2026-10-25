import {
	MINIMAL_ANTHROPIC_OAUTH_PROMPT,
	PI_DEFAULT_PROMPT_PREFIX,
	PI_DOCS_SECTION_ANCHOR,
	PI_OWNED_SECTIONS,
	PI_TOOLS_FILLER_ANCHOR,
} from "@earendil-works/pi-ai/api/anthropic-oauth/constants";
import {
	parseSystemPromptChunks,
	renderSystemPromptChunks,
} from "@earendil-works/pi-ai/api/anthropic-oauth/system-prompt-sections";
import { shapeSystemPrompt } from "@earendil-works/pi-ai/api/anthropic-oauth/system-prompt-shaping";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

function buildPrompt(): string {
	return buildSystemPrompt({
		cwd: "/tmp/project",
		selectedTools: ["read", "bash"],
		toolSnippets: { read: "Read file contents", bash: "Execute shell commands" },
		promptGuidelines: ["Keep the extension guideline"],
		appendSystemPrompt: "Keep the appended note",
		contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "Keep all project instructions" }],
		sections: { my_ext: "Keep the extension section" },
	});
}

describe("Anthropic OAuth system prompt drift", () => {
	it("matches the real builder anchors and round-trips its prompt byte-for-byte", () => {
		const built = buildPrompt();
		expect(built.startsWith(PI_DEFAULT_PROMPT_PREFIX)).toBe(true);
		const chunks = parseSystemPromptChunks(built);
		expect(chunks[0]?.name).toBeNull();
		for (const name of PI_OWNED_SECTIONS) expect(chunks.some((chunk) => chunk.name === name)).toBe(true);
		expect(chunks.find((chunk) => chunk.name === "docs")?.body).toContain(PI_DOCS_SECTION_ANCHOR);
		expect(chunks.find((chunk) => chunk.name === "tools")?.body).toContain(PI_TOOLS_FILLER_ANCHOR);
		expect(renderSystemPromptChunks(chunks)).toBe(built);
	});

	it("shapes only Pi-owned content and preserves all appended sections", () => {
		const shaped = shapeSystemPrompt(buildPrompt());
		expect(shaped.startsWith(MINIMAL_ANTHROPIC_OAUTH_PROMPT)).toBe(true);
		expect(shaped).not.toContain("<docs>");
		expect(shaped).not.toContain(PI_TOOLS_FILLER_ANCHOR);
		expect(shaped).toContain("- read: Read file contents");
		expect(shaped).toContain("- bash: Execute shell commands");
		expect(shaped).toContain("- Keep the extension guideline");
		expect(shaped).toContain("<addendum>\nKeep the appended note\n</addendum>");
		expect(shaped).toContain("Keep all project instructions");
		expect(shaped).toContain("<cwd>\n/tmp/project\n</cwd>");
		expect(shaped.endsWith("<my_ext>\nKeep the extension section\n</my_ext>")).toBe(true);
	});
});
