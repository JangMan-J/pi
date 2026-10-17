import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { xaiProvider } from "../src/providers/xai.ts";
import type { AssistantMessage, Context, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type CapturedRequest = {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
};

function sseResponse(events: Record<string, unknown>[]): Response {
	const lines = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(`${lines}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function completedResponse(id = "resp_xai_test"): Response {
	return sseResponse([
		{
			type: "response.completed",
			sequence_number: 0,
			response: {
				id,
				status: "completed",
				output: [],
				usage: {
					input_tokens: 10,
					output_tokens: 5,
					total_tokens: 15,
					input_tokens_details: { cached_tokens: 2 },
				},
			},
		},
	]);
}

function getProviderModel(id: string): Model<"openai-responses"> {
	const model = xaiProvider()
		.getModels()
		.find((m) => m.id === id);
	if (!model) {
		throw new Error(`Model ${id} not found in xaiProvider().getModels()`);
	}
	return model as Model<"openai-responses">;
}

async function captureRequest(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions = { apiKey: "xai-test-token" },
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		captured = {
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.clone().text()) as Record<string, unknown>,
		};
		return completedResponse();
	});

	const result = await xaiProvider().stream(model, normalizeContext(context), options).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(captured).toBeDefined();
	return captured!;
}

describe("xAI native provider (Grok 4.7 / 4.7 Fast improvements)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers grok-4.7-build-fast with tiered 500k pricing and compat defaults", () => {
		const fastModel = getProviderModel("grok-4.7-build-fast");
		expect(fastModel).toMatchObject({
			id: "grok-4.7-build-fast",
			name: "Grok 4.7 Fast",
			api: "openai-responses",
			provider: "xai",
			reasoning: true,
			contextWindow: 500000,
			maxTokens: 500000,
			cost: {
				input: 4,
				output: 12,
				cacheRead: 1,
				cacheWrite: 0,
				tiers: [
					{
						inputTokensAbove: 200000,
						input: 6,
						output: 18,
						cacheRead: 1.5,
						cacheWrite: 0,
					},
				],
			},
			compat: {
				supportsLongCacheRetention: false,
				supportsStrictMode: false,
				supportsOpenAIGrammarTools: false,
				supportsDeveloperRole: false,
			},
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
		});
	});

	it("omits strict: true on tools, uses role: system, sets stream_tool_calls: true, and sends doom-loop headers on 4.7 family", async () => {
		const model = getProviderModel("grok-4.7-build-fast");
		const captured = await captureRequest(
			model,
			{
				systemPrompt: "Follow instructions carefully.",
				messages: [{ role: "user", content: "Read foo.ts", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read file",
						parameters: {
							type: "object",
							properties: {
								path: { type: "string" },
								offset: { type: "number" },
							},
							required: ["path"],
						} as unknown as Tool["parameters"],
					},
				],
			},
			{
				apiKey: "xai-test-token",
				sessionId: "conv-47-fast",
				reasoningEffort: "high",
			},
		);

		// System prompt uses role: "system" on 4.7 family
		expect(captured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "system",
					content: "Follow instructions carefully.",
				}),
			]),
		);

		// Tools omit strict: true and preserve optional fields without anyOf: null rewriting
		const tools = captured.body.tools as Array<Record<string, unknown>>;
		expect(tools).toHaveLength(1);
		expect(tools[0]).not.toHaveProperty("strict");
		const params = tools[0].parameters as { required?: string[]; properties?: Record<string, unknown> };
		expect(params.required).toEqual(["path"]);

		// stream_tool_calls and concise reasoning summary enabled on 4.7 family
		expect(captured.body.stream_tool_calls).toBe(true);
		expect(captured.body.reasoning).toEqual({
			effort: "high",
			summary: "concise",
		});

		// Server-side doom-loop & affinity headers
		expect(captured.headers.get("x-grok-doom-loop-check")).toBe("1024");
		expect(captured.headers.get("x-grok-exact-repetition-check")).toBe("64");
		expect(captured.headers.get("x-grok-conv-id")).toBe("conv-47-fast");
		expect(captured.headers.get("session_id")).toBe("conv-47-fast");
		expect(captured.headers.get("x-client-request-id")).toBeTruthy();

		// Even if withRemoteCatalog (pi.dev / models-store.json) overwrites model.compat with stale flags,
		// request shaping still enforces role: "system" and omits strict: true on Grok 4.7.
		const overwrittenModel: Model<"openai-responses"> = {
			...getProviderModel("grok-4.7"),
			compat: {
				supportsDeveloperRole: true,
				supportsStrictMode: true,
				supportsOpenAIGrammarTools: true,
				supportsLongCacheRetention: true,
			},
		};
		const overwrittenCaptured = await captureRequest(overwrittenModel, {
			systemPrompt: "System survives remote catalog overwrite.",
			messages: [{ role: "user", content: "Ping", timestamp: 1 }],
			tools: [
				{
					name: "read",
					description: "Read file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					} as unknown as Tool["parameters"],
				},
			],
		});
		expect(overwrittenCaptured.body.input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "system",
					content: "System survives remote catalog overwrite.",
				}),
			]),
		);
		expect((overwrittenCaptured.body.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("strict");
	});

	it("preserves encrypted reasoning signatures and compound call_id|fc_id across grok-4.7 and grok-4.7-build-fast", async () => {
		const fastModel = getProviderModel("grok-4.7-build-fast");
		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "xai",
			model: "grok-4.7",
			stopReason: "toolUse",
			timestamp: 2,
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [
				{
					type: "thinking",
					thinking: "Inspecting target file",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: "rs_cross_tier_1",
						encrypted_content: "enc_blob_xyz",
						status: "in_progress",
						summary: [{ type: "summary_text", text: "Inspecting target file" }],
						content: [{ text: "raw reasoning text without type" }],
					}),
				},
				{
					type: "toolCall",
					id: "call_abc|fc_xyz",
					name: "read",
					arguments: { path: "src/index.ts" },
				},
			],
		};

		const captured = await captureRequest(fastModel, {
			messages: [
				{ role: "user", content: "Check src/index.ts", timestamp: 1 },
				priorAssistant,
				{
					role: "toolResult",
					toolCallId: "call_abc|fc_xyz",
					toolName: "read",
					content: [{ type: "text", text: "export const x = 1;" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		const inputItems = captured.body.input as Array<Record<string, unknown>>;
		const reasoningItem = inputItems.find((item) => item.type === "reasoning");
		expect(reasoningItem).toBeDefined();
		expect(reasoningItem!.encrypted_content).toBe("enc_blob_xyz");
		// Sanitized: status stripped, content[].type injected as reasoning_text
		expect(reasoningItem).not.toHaveProperty("status");
		expect(reasoningItem!.content).toEqual([{ type: "reasoning_text", text: "raw reasoning text without type" }]);

		const functionCallItem = inputItems.find((item) => item.type === "function_call");
		expect(functionCallItem).toMatchObject({
			type: "function_call",
			call_id: "call_abc",
			id: "fc_xyz",
			name: "read",
		});
	});

	it("rewrites totalTokens from usage.context_details and salvages incomplete max_time_limit tool calls", async () => {
		const model = getProviderModel("grok-4.7");
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			sseResponse([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_salvage_1",
						call_id: "call_salvage_1",
						name: "read",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.done",
					output_index: 0,
					item_id: "fc_salvage_1",
					arguments: '{"path":"README.md"}',
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_salvage_1",
						call_id: "call_salvage_1",
						name: "read",
						arguments: '{"path":"README.md"}',
					},
				},
				{
					type: "response.incomplete",
					sequence_number: 4,
					response: {
						id: "resp_incomplete_1",
						status: "incomplete",
						incomplete_details: { reason: "max_time_limit" },
						output: [],
						usage: {
							input_tokens: 5000,
							output_tokens: 200,
							total_tokens: 5200,
							input_tokens_details: { cached_tokens: 4000 },
							output_tokens_details: { reasoning_tokens: 100 },
							context_details: {
								prompt_text_tokens: 1800,
								prompt_Arena_tokens: 200,
							},
						},
					},
				},
			]),
		);

		const result = await xaiProvider()
			.stream(model, normalizeContext({ messages: [{ role: "user", content: "Read README", timestamp: 1 }] }), {
				apiKey: "xai-test-token",
			})
			.result();

		// Complete tool call on incomplete/length turn is salvaged into toolUse
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{
				type: "toolCall",
				id: "call_salvage_1|fc_salvage_1",
				name: "read",
				arguments: { path: "README.md" },
			},
		]);
		// Live context window footprint computed from context_details + output_tokens = 1800 + 200 + 200 = 2200
		expect(result.usage.totalTokens).toBe(2200);
	});

	it("recovers in-stream when response.doom_loop_check fires a confident thinking tail_repetition trigger", async () => {
		const model = getProviderModel("grok-4.7-build-fast");
		const capturedBodies: Array<Record<string, unknown>> = [];

		vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async (input, init) => {
				const req = new Request(input, init);
				capturedBodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
				return sseResponse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "reasoning", id: "rs_loop", summary: [] },
					},
					{
						type: "response.reasoning_summary_part.added",
						output_index: 0,
						summary_index: 0,
						part: { type: "summary_text", text: "" },
					},
					{
						type: "response.reasoning_summary_text.delta",
						output_index: 0,
						summary_index: 0,
						delta: "Wait let me re-check...",
					},
					{
						type: "response.doom_loop_check",
						triggers: ["tail_repetition:32@thinking"],
					},
				]);
			})
			.mockImplementationOnce(async (input, init) => {
				const req = new Request(input, init);
				capturedBodies.push(JSON.parse(await req.text()) as Record<string, unknown>);
				return sseResponse([
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg_recovered", role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.content_part.added",
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					},
					{
						type: "response.output_text.delta",
						output_index: 0,
						content_index: 0,
						delta: "Recovered cleanly.",
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_recovered",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "Recovered cleanly.", annotations: [] }],
						},
					},
					{
						type: "response.completed",
						sequence_number: 5,
						response: {
							id: "resp_recovered",
							status: "completed",
							output: [],
							usage: {
								input_tokens: 12,
								output_tokens: 4,
								total_tokens: 16,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				]);
			});

		const result = await xaiProvider()
			.stream(model, normalizeContext({ messages: [{ role: "user", content: "Solve task", timestamp: 1 }] }), {
				apiKey: "xai-test-token",
				sessionId: "conv-doom-loop",
			})
			.result();

		expect(capturedBodies).toHaveLength(2);
		expect(result.stopReason).toBe("stop");
		// Interrupted thinking block is discarded so no orphaned signature is persisted
		const thinkingBlocks = result.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(0);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "xai_doom_loop_recovery",
				}),
			]),
		);
		const textBlocks = result.content.filter((b) => b.type === "text");
		expect(textBlocks).toEqual([{ type: "text", text: "Recovered cleanly.", textSignature: expect.any(String) }]);
	});

	it("injects delayed long-reasoning and tool-call stationarity system reminders when thresholds are reached", async () => {
		const model = getProviderModel("grok-4.7-build-fast");
		const makeReadTurn = (ts: number, thinkingText = "short"): [AssistantMessage, Context["messages"][number]] => [
			{
				role: "assistant",
				api: "openai-responses",
				provider: "xai",
				model: "grok-4.7-build-fast",
				stopReason: "toolUse",
				timestamp: ts,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [
					{ type: "thinking", thinking: thinkingText },
					{ type: "toolCall", id: `call_${ts}|fc_${ts}`, name: "read", arguments: { path: "same.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: `call_${ts}|fc_${ts}`,
				toolName: "read",
				content: [{ type: "text", text: "same content" }],
				isError: false,
				timestamp: ts + 1,
			},
		];

		const longThinking = "x".repeat(4100);
		const messages: Context["messages"] = [
			{ role: "user", content: "Fix bug", timestamp: 1 },
			...makeReadTurn(2),
			...makeReadTurn(4),
			...makeReadTurn(6, longThinking), // Turn with >4000 chars of thinking (1 step ago relative to trailing assistant)
			...makeReadTurn(8),
		];

		const captured = await captureRequest(model, { messages });
		const inputItems = captured.body.input as Array<Record<string, unknown>>;
		const reminderTexts = inputItems
			.flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<Record<string, unknown>>) : []))
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.filter((text) => text.includes("<system_reminder>"));
		expect(reminderTexts).toHaveLength(2);
		expect(reminderTexts.join("\n")).toContain("Keep reasoning brief and focused");
		expect(reminderTexts.join("\n")).toContain("called the same tool with identical arguments repeatedly");
	});
});
