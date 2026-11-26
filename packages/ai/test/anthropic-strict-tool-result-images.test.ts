import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

interface AnthropicPayload {
	messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const strictModel: Model<"anthropic-messages"> = {
	id: "qwen4-strict-test",
	name: "Qwen4 Strict Test",
	api: "anthropic-messages",
	provider: "fireworks",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1024,
};

const nativeModel: Model<"anthropic-messages"> = {
	...strictModel,
	id: "claude-test",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
};

const assistant: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		{ type: "toolCall", id: "call-2", name: "codemode", arguments: {} },
	],
	api: "anthropic-messages",
	provider: "fireworks",
	model: "qwen4-strict-test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: Date.now(),
};

async function capturePayload(model: Model<"anthropic-messages">, context: Context): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		cacheRetention: "none",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!capturedPayload) throw new Error("Expected payload capture before request");
	return capturedPayload;
}

const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

const history = (): Context["messages"] => [
	{ role: "user", content: "Look at the screenshot", timestamp: Date.now() },
	assistant,
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	},
	{
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "codemode",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
	},
];

describe("Anthropic strict hosts: images in successful tool results", () => {
	// Fireworks qwen4 on the Anthropic-compatible endpoint rejects the whole request with
	// "The qwen4 conversation style supports text inputs, plus image_url parts in system,
	// developer and user messages" when a tool_result carries an image (live probe 2026-11-26).
	it("relocates the images after the turn's tool results on non-Anthropic hosts", async () => {
		const payload = await capturePayload(strictModel, { messages: history() });
		expect(payload.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: "Read image file [image/png]\n(image attached after the tool results)",
					is_error: false,
				},
				{
					type: "tool_result",
					tool_use_id: "call-2",
					content: "done",
					is_error: false,
				},
				{ type: "text", text: "Images from the result of tool call call-1 (read):" },
				image("AAAA"),
			],
		});
	});

	it("keeps images inline on Anthropic's own endpoint", async () => {
		const payload = await capturePayload(nativeModel, { messages: history() });
		expect(payload.messages[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "call-1",
					content: [{ type: "text", text: "Read image file [image/png]" }, image("AAAA")],
					is_error: false,
				},
				{
					type: "tool_result",
					tool_use_id: "call-2",
					content: "done",
					is_error: false,
				},
			],
		});
	});

	it("honors an explicit supportsToolResultImages override on a third-party host", async () => {
		const payload = await capturePayload(
			{ ...strictModel, compat: { supportsToolResultImages: true } },
			{ messages: history() },
		);
		const first = (payload.messages[2]!.content as Array<Record<string, unknown>>)[0]!;
		expect(first.content).toEqual([{ type: "text", text: "Read image file [image/png]" }, image("AAAA")]);
	});

	it("is prefix-stable: growing the history does not change earlier wire bytes", async () => {
		const before = await capturePayload(strictModel, { messages: history() });
		const grown: Context = {
			messages: [
				...history(),
				{
					role: "assistant",
					content: [{ type: "text", text: "I see it." }],
					api: "anthropic-messages",
					provider: "fireworks",
					model: "qwen4-strict-test",
					usage: assistant.usage,
					stopReason: "stop",
					timestamp: Date.now(),
				},
				{ role: "user", content: "And now?", timestamp: Date.now() },
			],
		};
		const after = await capturePayload(strictModel, grown);
		expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(JSON.stringify(before.messages));
	});

	it("still uses the error-result relocation for error results on strict hosts", async () => {
		const messages = history();
		(messages[2] as { isError: boolean }).isError = true;
		const payload = await capturePayload(strictModel, { messages });
		const content = payload.messages[2]!.content as Array<Record<string, unknown>>;
		expect(content).toContainEqual({
			type: "text",
			text: "Images from the error result of tool call call-1 (read):",
		});
	});
});
