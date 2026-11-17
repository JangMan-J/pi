import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as output from "../../src/core/output-guard.ts";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

initTheme("dark");
const secret = "<hidden_marker/>";
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function routed(options: HarnessOptions = {}, hiddenTurns = 1, useAlias = false): Promise<Harness> {
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
						const hidden = count++ < hiddenTurns;
						return {
							model: ctx.modelRegistry.find("faux", "default")!,
							thinkingLevel: "off",
							...(useAlias ? { suppressTextDisplay: hidden } : { suppressStream: hidden }),
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

describe("routed stream suppression", () => {
	it.each([false, true])(
		"hides prose, thinking and deltas while retaining tools and canonical history (alias=%s)",
		async (useAlias) => {
			const hiddenProse = "<internal_notes>Internal findings</internal_notes>";
			let canonical: AssistantMessage | undefined;
			let entryId: string | undefined;
			const harness = await routed(
				{
					extensionFactories: [
						(pi) => {
							pi.on("turn_end", (event, ctx) => {
								if (event.turnIndex !== 0 || event.message.role !== "assistant") return;
								canonical = event.message;
								entryId = event.messageEntryId;
								const entry = ctx.sessionManager.getEntry(entryId);
								expect(entry?.type === "message" && entry.message).toBe(canonical);
								expect(JSON.stringify(canonical)).toContain(hiddenProse);
							});
						},
					],
				},
				1,
				useAlias,
			);
			harness.setResponses([
				fauxAssistantMessage(
					[
						{ type: "text", text: hiddenProse },
						{ type: "thinking", thinking: "hidden thought", thinkingSignature: "canonical-signature" },
						{ ...fauxToolCall("echo", {}), thoughtSignature: "canonical-tool-signature" },
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("final answer"),
			]);
			await harness.session.prompt("go");
			expect(entryId).toBeTruthy();
			expect(JSON.stringify(harness.events.map(toJsonEvent))).not.toContain(hiddenProse);
			expect(JSON.stringify(harness.events)).not.toContain("hidden thought");
			expect(canonical?.content).toContainEqual({
				type: "thinking",
				thinking: "hidden thought",
				thinkingSignature: "canonical-signature",
			});
			const stored = harness.sessionManager.getEntry(entryId!);
			if (stored?.type !== "message") throw new Error("Missing canonical entry");
			expect(stored.message).toBe(canonical);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
			const firstEnd = harness.eventsOfType("message_end").find((event) => event.message.role === "assistant")!;
			expect(firstEnd.message).toMatchObject({ content: [{ type: "toolCall" }] });
			expect(firstEnd.message).not.toBe(canonical);
			expect(JSON.stringify(harness.events)).toContain("final answer");
		},
	);

	it("never exposes a hidden turn through getLastAssistantText", async () => {
		const harness = await routed();
		harness.setResponses([fauxAssistantMessage(secret)]);
		await harness.session.prompt("go");
		expect(harness.session.getLastAssistantText()).toBeUndefined();
	});

	it.each(["text", "json"] as const)("prints only the visible turn in print mode (%s)", async (mode) => {
		const harness = await routed();
		harness.setResponses([
			fauxAssistantMessage([{ type: "text", text: secret }, fauxToolCall("echo", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("visible output"),
		]);
		const chunks: string[] = [];
		vi.spyOn(output, "writeRawStdout").mockImplementation((text) => {
			chunks.push(text);
		});
		const host = { session: harness.session, setRebindSession() {}, async dispose() {} };
		const code = await runPrintMode(host as Parameters<typeof runPrintMode>[0], { mode, initialMessage: "go" });
		expect(code).toBe(0);
		expect(chunks.join("")).not.toContain(secret);
		expect(chunks.join("")).toContain("visible output");
	});

	it("renders diagnostic only when a suppressed turn ends in error", async () => {
		const harness = await routed({ settings: { retry: { enabled: false } } });
		harness.setResponses([
			fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "failed thought", thinkingSignature: "sig" },
					{ type: "text", text: secret },
				],
				{ stopReason: "error", errorMessage: "provider diagnostic" },
			),
		]);
		await harness.session.prompt("go");
		const canonical = harness.session.messages.at(-1) as AssistantMessage;
		const rendered = new AssistantMessageComponent(JSON.parse(JSON.stringify(canonical))).render(80).join("\n");
		expect(rendered).toContain("provider diagnostic");
		expect(rendered).not.toContain(secret);
		expect(rendered).not.toContain("failed thought");
	});
});
