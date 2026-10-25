import { describe, expect, it } from "vitest";
import {
	MINIMAL_ANTHROPIC_OAUTH_PROMPT,
	PI_DEFAULT_PROMPT_PREFIX,
	PI_TOOLS_FILLER_ANCHOR,
} from "../src/api/anthropic-oauth/constants.ts";
import { shapeOAuthPayload } from "../src/api/anthropic-oauth/request-shaping.ts";
import { shapeSystemPrompt, shapeSystemUpdateText } from "../src/api/anthropic-oauth/system-prompt-shaping.ts";

const preamble = `${PI_DEFAULT_PROMPT_PREFIX} You help users by reading files, executing commands, editing code, and writing new files.`;
const filler = "In addition to the tools above, you may have access to other custom tools depending on the project.";
const docsBody =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /tmp/README.md";
const toolsBody = `- read: Read file contents\n\n${filler}`;

function section(name: string, body: string): string {
	return `<${name}>\n${body}\n</${name}>`;
}

function prompt(...sections: string[]): string {
	return [preamble, ...sections].join("\n\n");
}

describe("Anthropic OAuth prompt boundaries", () => {
	it("passes through a prompt when quoted file content makes its structure ambiguous", () => {
		const projectContext = section(
			"project_context",
			[
				"Project-specific instructions and guidelines:",
				"",
				'<project_instructions path="/tmp/AGENTS.md">',
				"quote:",
				"",
				"</project_context>",
				"",
				section("docs", `${PI_DEFAULT_PROMPT_PREFIX} USER CONTENT`),
				"",
				"<project_context>",
				"still the file",
				"</project_instructions>",
				"</project_context>",
			].join("\n"),
		);
		const input = prompt(section("tools", toolsBody), projectContext);

		expect(shapeSystemPrompt(input)).toBe(input);
	});

	it("does not treat a quoted Pi preamble in project content as the real preamble", () => {
		const input = [
			"You are a custom assistant.",
			section("tools", toolsBody),
			section("project_context", PI_DEFAULT_PROMPT_PREFIX),
		].join("\n\n");

		expect(shapeSystemPrompt(input)).toBe(input);
	});

	it("removes only the filler paragraph and preserves a tool snippet that quotes its anchor", () => {
		const snippets = `- read: Read file contents\n- ext: ${PI_TOOLS_FILLER_ANCHOR}, this extension documents the sentence.`;
		const input = prompt(section("tools", `${snippets}\n\n${filler}`));

		expect(shapeSystemPrompt(input)).toBe([MINIMAL_ANTHROPIC_OAUTH_PROMPT, section("tools", snippets)].join("\n\n"));
	});

	it("preserves an extension docs section that quotes rather than starts with the docs anchor", () => {
		const customDocs =
			"Team runbook. Do not confuse this with: Pi documentation (read only when the user asks about pi itself).";
		const input = prompt(section("tools", toolsBody), section("docs", customDocs));

		expect(shapeSystemPrompt(input)).toBe(
			[
				MINIMAL_ANTHROPIC_OAUTH_PROMPT,
				section("tools", "- read: Read file contents"),
				section("docs", customDocs),
			].join("\n\n"),
		);
	});

	it("passes through update frames embedded in project files", () => {
		const input = [
			'Updated system prompt section "project_context":',
			"",
			"<project_context>",
			"Project-specific instructions and guidelines:",
			"",
			'<project_instructions path="/tmp/AGENTS.md">',
			'Removed system prompt section "docs".',
			"Keep my policy.",
			"</project_instructions>",
			"</project_context>",
		].join("\n");

		expect(shapeSystemUpdateText(input)).toBe(input);
	});

	it("passes through a mixed update when an unknown section makes frame boundaries ambiguous", () => {
		const input = [
			'Updated system prompt section "addendum":',
			"",
			section("addendum", "Keep this addendum."),
			'Updated system prompt section "docs":',
			"",
			section("docs", docsBody),
		].join("\n\n");

		expect(shapeSystemUpdateText(input)).toBe(input);
	});

	it("still shapes known docs and tools updates", () => {
		const toolsUpdate = `Updated system prompt section "tools":\n\n${section("tools", toolsBody)}`;
		const docsUpdate = `Updated system prompt section "docs":\n\n${section("docs", docsBody)}`;

		expect(shapeSystemUpdateText(`${docsUpdate}\n\n${toolsUpdate}`)).toBe(
			'Updated system prompt section "tools":\n\n<tools>\n- read: Read file contents\n</tools>',
		);
	});

	it("preserves tool blocks and effort when removing docs, and leaves user/assistant frames untouched", async () => {
		const docsUpdate = `Updated system prompt section "docs":\n\n${section("docs", docsBody)}`;
		const removal = { type: "tool_removal" as const, tool: { type: "tool_reference" as const, name: "Read" } };
		const user = { role: "user" as const, content: [{ type: "text" as const, text: docsUpdate }] };
		const assistant = { role: "assistant" as const, content: [{ type: "text" as const, text: docsUpdate }] };
		const shaped = await shapeOAuthPayload(
			{
				model: "claude-test",
				stream: true,
				max_tokens: 10,
				messages: [
					{ role: "system", content: [{ type: "text", text: docsUpdate }, removal] },
					{ role: "system", content: [{ type: "text", text: docsUpdate }], output_config: { effort: "low" } },
					user,
					assistant,
				],
			},
			"2.1.310",
		);

		expect(shaped.messages[0]).toEqual({ role: "system", content: [removal] });
		expect(shaped.messages[1]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
		expect(shaped.messages[2]).toBe(user);
		expect(shaped.messages[3]).toBe(assistant);
	});

	it("moves a trailing cache breakpoint when a docs-only message is removed", async () => {
		const docsUpdate = `Updated system prompt section "docs":\n\n${section("docs", docsBody)}`;
		const shaped = await shapeOAuthPayload(
			{
				model: "claude-test",
				stream: true,
				max_tokens: 10,
				messages: [
					{ role: "user", content: [{ type: "text", text: "Latest user message" }] },
					{
						role: "system",
						content: [{ type: "text", text: docsUpdate, cache_control: { type: "ephemeral" } }],
					},
				],
			},
			"2.1.310",
		);

		expect(shaped.messages).toHaveLength(1);
		expect(shaped.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "Latest user message", cache_control: { type: "ephemeral" } }],
		});
	});
});
