import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentMessage } from "../../src/core/message-presentation.ts";
import * as output from "../../src/core/output-guard.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

initTheme("dark");
const secret = "<no_recon/>";
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function routed(options: HarnessOptions = {}, hiddenTurns = 1): Promise<Harness> {
	let count = 0;
	const harness = await createHarness({
		...options,
		tools: [
			{
				name: "echo",
				label: "Echo",
				description: "Echo",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
			},
		],
		extensionFactories: [
			...(options.extensionFactories ?? []),
			(pi) => {
				pi.registerVirtualModel({
					provider: "router",
					id: "silent",
					name: "Silent",
					route(_request, ctx) {
						return {
							model: ctx.modelRegistry.find("faux", "default")!,
							thinkingLevel: "off",
							suppressTextDisplay: count++ < hiddenTurns,
						};
					},
				});
			},
		],
		models: [{ id: "default" }],
	});
	harnesses.push(harness);
	await harness.session.setModel(harness.session.modelRuntime.getModel("router", "silent")!);
	return harness;
}

describe("routed text presentation", () => {
	it("hides scout prose, thinking and deltas, retaining tools, canonical identity and persisted IDs", async () => {
		const scoutBrief = "<scout_brief>Internal findings</scout_brief>";
		let canonical: AssistantMessage | undefined;
		let entryId: string | undefined;
		const harness = await routed({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event, ctx) => {
						if (event.turnIndex !== 0 || event.message.role !== "assistant") return;
						canonical = event.message;
						entryId = event.messageEntryId;
						const entry = ctx.sessionManager.getEntry(entryId);
						expect(entry?.type === "message" && entry.message).toBe(canonical);
						expect(JSON.stringify(canonical)).toContain(scoutBrief);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "text", text: scoutBrief },
					{ type: "thinking", thinking: "hidden thought", thinkingSignature: "canonical-signature" },
					{ ...fauxToolCall("echo", {}), thoughtSignature: "canonical-tool-signature" },
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("architect"),
		]);
		await harness.session.prompt("go");
		expect(entryId).toBeTruthy();
		expect(JSON.stringify(harness.events.map(toJsonEvent))).not.toContain(scoutBrief);
		expect(JSON.stringify(harness.events)).not.toContain("hidden thought");
		expect(canonical?.content).toContainEqual({
			type: "thinking",
			thinking: "hidden thought",
			thinkingSignature: "canonical-signature",
		});
		const stored = harness.sessionManager.getEntry(entryId!);
		if (stored?.type !== "message") throw new Error("Missing canonical entry");
		expect(stored.message).toBe(canonical);
		expect(JSON.stringify(stored.message)).toContain("canonical-signature");
		expect(JSON.stringify(stored.message)).toContain("canonical-tool-signature");
		expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).toContain("hidden thought");
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
		const toolStart = harness
			.eventsOfType("message_update")
			.find((event) => event.assistantMessageEvent.type === "toolcall_start");
		expect(toolStart && toJsonEvent(toolStart).assistantMessageEvent).toMatchObject({
			type: "toolcall_start",
			contentIndex: 0,
			toolName: "echo",
		});
		const scoutEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant")!;
		expect(scoutEnd.message).toMatchObject({ content: [{ type: "toolCall" }] });
		expect(scoutEnd.message).not.toBe(canonical);
		for (const event of harness.eventsOfType("message_update")) {
			const update = event.assistantMessageEvent;
			if (update.type === "toolcall_start" || update.type === "toolcall_delta" || update.type === "toolcall_end") {
				expect(update.contentIndex).toBe(0);
				expect(update.partial.content).toHaveLength(1);
			}
		}
		const scoutEvents = harness.events.slice(0, harness.events.indexOf(scoutEnd));
		expect(
			scoutEvents.filter(
				(event) => event.type === "message_update" && /^(text|thinking)_/.test(event.assistantMessageEvent.type),
			),
		).toEqual([]);
		const architectEvents = harness.events.slice(harness.events.indexOf(scoutEnd) + 1);
		expect(
			architectEvents.some(
				(event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
			),
		).toBe(true);
		expect(harness.session.messages).toContain(canonical);
		expect(JSON.stringify(harness.session.messages)).toContain(scoutBrief);
		expect(JSON.stringify(harness.events)).toContain("architect");
	});

	it("continues after a hidden text-only boundary edit without blank bubbles", async () => {
		let edited = false;
		const harness = await routed({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (edited) return;
						edited = true;
						expect(JSON.stringify(event.message)).toContain(secret);
						return {
							entries: [
								{ type: "context_edit", targetId: event.messageEntryId, replacement: null },
								{ type: "custom_message", customType: "handoff", content: "continue", display: false },
							],
							continue: true,
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage(secret), fauxAssistantMessage("architect")]);
		await harness.session.prompt("go");
		expect(harness.faux.state.callCount).toBe(2);
		const first = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant")!;
		if (first.message.role !== "assistant") throw new Error("Expected assistant");
		expect(new AssistantMessageComponent(first.message).render(80)).toEqual([]);
		const stored = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (stored?.type !== "message" || stored.message.role !== "assistant") throw new Error("Missing canonical");
		expect(new AssistantMessageComponent(JSON.parse(JSON.stringify(stored.message))).render(80)).toEqual([]);
		expect(JSON.stringify(harness.events.map(toJsonEvent))).not.toContain(secret);
		expect(JSON.stringify(harness.session.messages)).not.toContain(secret);
	});

	it.each(["error", "aborted"] as const)(
		"restores full content and diagnostics on terminal %s events",
		async (stopReason) => {
			const harness = await routed({ settings: { retry: { enabled: false } } });
			harness.setResponses([
				fauxAssistantMessage(
					[
						{ type: "thinking", thinking: "failed thought", thinkingSignature: "failed-signature" },
						{ type: "text", text: secret },
					],
					{ stopReason, errorMessage: "diagnostic" },
				),
			]);
			await harness.session.prompt("go");
			const message = harness.session.messages.at(-1);
			if (message?.role !== "assistant") throw new Error("Expected assistant");
			expect(presentMessage(message)).toBe(message);
			expect(message.content).toEqual([
				{ type: "thinking", thinking: "failed thought", thinkingSignature: "failed-signature" },
				{ type: "text", text: secret },
			]);
			const terminalMessages = [
				harness.eventsOfType("message_end").at(-1)?.message,
				harness.eventsOfType("turn_end").at(-1)?.message,
				harness.eventsOfType("agent_end").at(-1)?.messages.at(-1),
			];
			for (const terminalMessage of terminalMessages) {
				expect(terminalMessage).toBe(message);
				expect(terminalMessage).toMatchObject({ content: message.content, stopReason, errorMessage: "diagnostic" });
			}
			const jsonEvents = harness.events.map(toJsonEvent);
			for (const type of ["message_end", "turn_end", "agent_end"]) {
				const terminal = jsonEvents.findLast((event) => event.type === type);
				expect(JSON.stringify(terminal)).toContain(secret);
				expect(JSON.stringify(terminal)).toContain("diagnostic");
			}
			expect(new AssistantMessageComponent(message).render(80).join("\n")).toContain("diagnostic");
		},
	);

	it("leaves direct requests canonical", async () => {
		const harness = await routed();
		harness.setResponses([fauxAssistantMessage(secret)]);
		const message = await harness.session.modelRuntime
			.streamSimple(harness.session.model!, { messages: [] })
			.result();
		expect(presentMessage(message)).toBe(message);
		expect(message.content).toEqual([{ type: "text", text: secret }]);
	});

	it("resets suppression when switching back to a physical model", async () => {
		const harness = await routed();
		harness.setResponses([fauxAssistantMessage(secret), fauxAssistantMessage("physical answer")]);
		await harness.session.prompt("scout");
		await harness.session.setModel(harness.getModel());
		await harness.session.prompt("answer");
		expect(JSON.stringify(harness.events)).not.toContain(secret);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			content: [{ type: "text", text: "physical answer" }],
		});
	});

	it.each(["text", "json"] as const)("prints the architect after a hidden tool scout in %s", async (mode) => {
		const harness = await routed();
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: secret }, fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("architect"),
		]);
		const chunks: string[] = [];
		vi.spyOn(output, "writeRawStdout").mockImplementation((text) => {
			chunks.push(text);
		});
		const host = { session: harness.session, setRebindSession() {}, async dispose() {} };
		const code = await runPrintMode(host as Parameters<typeof runPrintMode>[0], { mode, initialMessage: "go" });
		expect(code).toBe(0);
		expect(chunks.join("")).not.toContain(secret);
		expect(chunks.join("")).toContain("architect");
		if (mode === "text") expect(chunks).toEqual(["architect\n"]);
	});

	it.each(["text", "json"] as const)("does not leak a final hidden turn through print %s", async (mode) => {
		const harness = await routed();
		harness.setResponses([fauxAssistantMessage(secret)]);
		const chunks: string[] = [];
		vi.spyOn(output, "writeRawStdout").mockImplementation((text) => {
			chunks.push(text);
		});
		const host = { session: harness.session, setRebindSession() {}, async dispose() {} };
		// Print only needs these host operations in a run with no session replacement.
		const code = await runPrintMode(host as Parameters<typeof runPrintMode>[0], { mode, initialMessage: "go" });
		expect(code).toBe(0);
		expect(chunks.join("")).not.toContain(secret);
		expect(JSON.stringify(harness.session.messages)).toContain(secret);
		if (mode === "text") expect(chunks).toEqual([]);
		else expect(chunks.map((chunk) => JSON.parse(chunk)).some((event) => event.type === "agent_end")).toBe(true);
		expect(presentMessage(harness.session.messages.at(-1)!)).toMatchObject({ content: [] });
	});
});
