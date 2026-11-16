import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	messages?: Array<{ role: string; content: Array<{ type: string; text?: string; data?: string }> }>;
	thinking?: unknown;
	betas?: string[];
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Test Claude",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
		compat: { forceAdaptiveThinking: true },
	};
}

function assistantWith(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		provider: "anthropic",
		api: "anthropic-messages",
		model: "claude-test",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	reasoning?: "medium",
): Promise<AnthropicPayload> {
	let captured: AnthropicPayload | undefined;
	await streamSimple(model, context, {
		apiKey: "fake-key",
		reasoning,
		onPayload: (payload) => {
			captured = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("Expected payload capture before request");
	return captured;
}

function replayContext(thinkingSignature: string | undefined): Context {
	return {
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			assistantWith([
				{ type: "thinking", thinking: "", thinkingSignature, redacted: true },
				{ type: "text", text: "answer" },
			]),
			{ role: "user", content: "second", timestamp: 2 },
		],
	};
}

describe("Anthropic replay robustness", () => {
	it("skips a redacted thinking block whose opaque payload is missing", async () => {
		const payload = await capturePayload(makeModel("https://api.anthropic.com"), replayContext(undefined));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("skips a redacted thinking block whose payload is blank", async () => {
		const payload = await capturePayload(makeModel("https://api.anthropic.com"), replayContext("  "));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([{ type: "text", text: "answer" }]);
	});

	it("replays a redacted thinking block with its opaque payload", async () => {
		const payload = await capturePayload(makeModel("https://api.anthropic.com"), replayContext("opaque-data"));
		const assistant = payload.messages?.find((message) => message.role === "assistant");
		expect(assistant?.content).toEqual([
			{ type: "redacted_thinking", data: "opaque-data" },
			{ type: "text", text: "answer" },
		]);
	});

	it("binds adaptive thinking blocks with drop_block on Anthropic's endpoint", async () => {
		const payload = await capturePayload(
			makeModel("https://api.anthropic.com"),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			"medium",
		);
		expect(payload.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		expect(payload.betas).toContain("thinking-binding-controls-2026-08-01");
	});

	it("leaves adaptive thinking unbound on other Messages endpoints", async () => {
		const payload = await capturePayload(
			makeModel("https://gateway.example.com"),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			"medium",
		);
		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.betas ?? []).not.toContain("thinking-binding-controls-2026-08-01");
	});
});
