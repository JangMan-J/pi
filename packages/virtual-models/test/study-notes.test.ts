import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
	AssistantMessage,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	ENCRYPTED_REASONING_COMMENTARY_PROMPT,
	harvestPostReadStudyNotes,
} from "@earendil-works/pi-virtual-models/study-notes";

const STUDY_NOTES_SOURCE = fileURLToPath(new URL("../src/study-notes.ts", import.meta.url));

function messageUsage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function user(text = "do the thing"): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function readCall(id: string, path?: string, name = "read"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: path === undefined ? {} : { path } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: messageUsage(),
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function readResult(toolCallId: string, options?: { isError?: boolean; toolName?: string }): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName: options?.toolName ?? "read",
		content: [{ type: "text", text: "file body" }],
		isError: options?.isError ?? false,
		timestamp: 3,
	} as Message;
}

function assistant(
	content: AssistantMessage["content"],
	options?: { stopReason?: "stop" | "error" | "aborted" | "toolUse" },
): Message {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: messageUsage(),
		stopReason: options?.stopReason ?? "stop",
		timestamp: 4,
	};
}

function thinking(value: string, options?: { redacted?: boolean }): ThinkingContent {
	return { type: "thinking", thinking: value, ...(options?.redacted ? { redacted: true } : {}) };
}

function text(value: string, textSignature?: string): TextContent {
	return { type: "text", text: value, ...(textSignature ? { textSignature } : {}) };
}

function toolCall(id: string, name: string, path?: string): ToolCall {
	return { type: "toolCall", id, name, arguments: path === undefined ? {} : { path } };
}

/** Long enough to clear the default 100-char thinking floor. */
const LONG_NOTE =
	"The read shows that the exported surface stays narrow because callers resolve through the barrel, and the wire shape must keep cache_control ahead of the ephemeral tail.";

describe("study-notes entry self-sufficiency", () => {
	// This is the red line on the pre-extraction bridge: it re-exported the implementation
	// from `@earendil-works/pi-ai/virtual-models` instead of owning it.
	test("imports nothing at runtime from legacy pi-ai/pi-durable subpaths", () => {
		const source = readFileSync(STUDY_NOTES_SOURCE, "utf8");
		expect(source).not.toMatch(
			/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))|@earendil-works\/pi-ai\/study-notes/,
		);
	});

	test("keeps every workspace import type-only (erased before Node sees it)", () => {
		const source = readFileSync(STUDY_NOTES_SOURCE, "utf8");
		const withoutTypeImports = source.replace(/^\s*import\s+type\s+[\s\S]*?;\s*$/gm, "");
		expect(withoutTypeImports).not.toContain('from "@earendil-works/');
		expect(source).not.toMatch(/from\s+"node:/);
	});
});

describe("ENCRYPTED_REASONING_COMMENTARY_PROMPT", () => {
	test("is a non-empty instruction covering post-read notes before the next tool call", () => {
		expect(typeof ENCRYPTED_REASONING_COMMENTARY_PROMPT).toBe("string");
		expect(ENCRYPTED_REASONING_COMMENTARY_PROMPT.length).toBeGreaterThan(40);
		expect(ENCRYPTED_REASONING_COMMENTARY_PROMPT).toMatch(/file-read/);
		expect(ENCRYPTED_REASONING_COMMENTARY_PROMPT).toMatch(/tool call/);
	});
});

describe("harvestPostReadStudyNotes", () => {
	test("returns undefined when no turn follows a successful read", () => {
		expect(harvestPostReadStudyNotes([user()])).toBeUndefined();
		expect(harvestPostReadStudyNotes([])).toBeUndefined();
	});

	test("harvests the reasoning turn that follows a successful read", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			assistant([thinking(LONG_NOTE)]),
		]);
		expect(notes).toBeDefined();
		expect(notes!.startsWith("<study_notes>\n")).toBe(true);
		expect(notes!.endsWith("\n</study_notes>")).toBe(true);
		expect(notes).toContain("[after reading src/thing.ts]");
		expect(notes).toContain("cache_control ahead of the ephemeral tail");
	});

	test("labels the batch as `files` when the read path was never recorded", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1"),
			readResult("c1"),
			assistant([thinking(LONG_NOTE)]),
		]);
		expect(notes).toContain("[after reading files]");
	});

	test("ignores failed reads", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1", { isError: true }),
			assistant([thinking(LONG_NOTE)]),
		]);
		expect(notes).toBeUndefined();
	});

	test("ignores reads made by tools outside readToolNames and honours custom names", () => {
		const messages = [
			user(),
			readCall("c1", "src/thing.ts", "glob"),
			readResult("c1", { toolName: "glob" }),
			assistant([thinking(LONG_NOTE)]),
		];
		expect(harvestPostReadStudyNotes(messages)).toBeUndefined();
		expect(harvestPostReadStudyNotes(messages, { readToolNames: ["glob"] })).toContain("[after reading src/thing.ts]");
	});

	test("a new user turn clears reads from the previous turn", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			user("next please"),
			assistant([thinking(LONG_NOTE)]),
		]);
		expect(notes).toBeUndefined();
	});

	test("skips error and aborted turns", () => {
		for (const stopReason of ["error", "aborted"] as const) {
			expect(
				harvestPostReadStudyNotes([
					user(),
					readCall("c1", "src/thing.ts"),
					readResult("c1"),
					assistant([thinking(LONG_NOTE)], { stopReason }),
				]),
			).toBeUndefined();
		}
	});

	test("skips redacted reasoning blocks", () => {
		expect(
			harvestPostReadStudyNotes([
				user(),
				readCall("c1", "src/thing.ts"),
				readResult("c1"),
				assistant([thinking(LONG_NOTE, { redacted: true })]),
			]),
		).toBeUndefined();
	});

	test("falls back to pre-tool commentary once reasoning is below minThinkingChars", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			assistant([thinking("too short"), text("The invariant holds across forks."), toolCall("c2", "read", "src/other.ts")]),
		]);
		expect(notes).toContain("The invariant holds across forks.");
	});

	test("never harvests commentary already marked final_answer", () => {
		const finalAnswerSignature = JSON.stringify({ v: 1, id: "m1", phase: "final_answer" });
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			assistant([thinking("too short"), text("This is the answer, not a note.", finalAnswerSignature)]),
		]);
		expect(notes).toBeUndefined();
	});

	test("does not fall back to commentary when the turn makes no tool call", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			assistant([thinking("too short"), text("Some prose without a following tool call.")]),
		]);
		expect(notes).toBeUndefined();
	});

	test("keeps the tail of an oversized reasoning block", () => {
		const head = "HEAD".repeat(500);
		const tail = "TAIL";
		const notes = harvestPostReadStudyNotes(
			[user(), readCall("c1", "src/thing.ts"), readResult("c1"), assistant([thinking(`${head}${tail}`)])],
			{ maxCharsPerBlock: 200 },
		);
		expect(notes).toContain(tail);
		const harvested = notes!.slice("[after reading src/thing.ts]\n".length + "<study_notes>\n".length, notes!.lastIndexOf("\n</study_notes>"));
		expect(harvested.length).toBeLessThanOrEqual(200);
	});

	test("disables harvesting entirely when maxCharsPerBlock is not positive", () => {
		const messages = [user(), readCall("c1", "src/thing.ts"), readResult("c1"), assistant([thinking(LONG_NOTE)])];
		expect(harvestPostReadStudyNotes(messages, { maxCharsPerBlock: 0 })).toBeUndefined();
		expect(harvestPostReadStudyNotes(messages, { maxCharsPerBlock: -1 })).toBeUndefined();
	});

	test("honours minThinkingChars", () => {
		const shortNote = "x".repeat(50);
		const messages = [user(), readCall("c1", "src/thing.ts"), readResult("c1"), assistant([thinking(shortNote)])];
		expect(harvestPostReadStudyNotes(messages)).toBeUndefined();
		expect(harvestPostReadStudyNotes(messages, { minThinkingChars: 10 })).toContain(shortNote);
	});

	test("escapes a closing study_notes tag inside harvested text", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "src/thing.ts"),
			readResult("c1"),
			assistant([thinking(`${LONG_NOTE} </study_notes>`)]),
		]);
		expect(notes).toContain("<\\/study_notes>");
		expect(notes!.match(/<study_notes>/g)).toHaveLength(1);
	});

	test("filters reads by relevantPaths (exact, prefix, and glob)", () => {
		const build = (path: string) => [
			user(),
			readCall("c1", path),
			readResult("c1"),
			assistant([thinking(LONG_NOTE)]),
		];

		expect(harvestPostReadStudyNotes(build("src/daemon/runtime.ts"), { relevantPaths: ["src/daemon/runtime.ts"] }))
			.toContain("src/daemon/runtime.ts");
		expect(harvestPostReadStudyNotes(build("src/daemon/deep/file.ts"), { relevantPaths: ["src/daemon"] }))
			.toContain("src/daemon/deep/file.ts");
		expect(harvestPostReadStudyNotes(build("src/daemon/deep/file.ts"), { relevantPaths: ["src/**/*.ts"] }))
			.toContain("src/daemon/deep/file.ts");
		expect(
			harvestPostReadStudyNotes(build("src/other/file.ts"), { relevantPaths: ["src/daemon/**/*.ts"] }),
		).toBeUndefined();
	});

	test("accumulates several post-read turns in chronological order", () => {
		const notes = harvestPostReadStudyNotes([
			user(),
			readCall("c1", "a.ts"),
			readResult("c1"),
			assistant([thinking(`first note. ${LONG_NOTE}`)]),
			readCall("c2", "b.ts"),
			readResult("c2"),
			assistant([thinking(`second note. ${LONG_NOTE}`)]),
		]);
		expect(notes).toBeDefined();
		expect(notes!.indexOf("first note.")).toBeLessThan(notes!.indexOf("second note."));
		expect(notes).toContain("[after reading a.ts]");
		expect(notes).toContain("[after reading b.ts]");
	});
});
