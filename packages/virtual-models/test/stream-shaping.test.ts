import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type Api,
	createModels,
	fauxProvider,
	type Message,
	type Model,
	type SystemMessage,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { anchorAnthropicCacheBeforeEphemeralTail } from "../src/core/cache-anchor.ts";
import { projectRoutedTranscript } from "../src/core/projection.ts";
import { applyRequiredToolChoicePayload, buildRoutedStreamOptions } from "../src/core/tool-choice.ts";
import type { ModelRoute } from "../src/core/types.ts";

const makeTool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: {} },
});

const makePhysicalModel = (overrides: Partial<Model<Api>> = {}): Model<Api> => {
	const prov = fauxProvider({
		provider: "shaping-test",
		models: [{ id: "m-1", contextWindow: 32_000, maxTokens: 1000, reasoning: true }],
	});
	const models = createModels();
	models.setProvider(prov.provider);
	return { ...models.getModel("shaping-test", "m-1")!, ...overrides } as Model<Api>;
};

describe("core stream shaping (S08)", () => {
	it("is self-sufficient without pi-ai/virtual-models or pi-durable imports in projection, cache-anchor, or tool-choice", () => {
		for (const rel of [
			"../src/core/projection.ts",
			"../src/core/cache-anchor.ts",
			"../src/core/tool-choice.ts",
		]) {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
			expect(src).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
			expect(src).not.toMatch(/@earendil-works\/pi-durable/);
		}
	});

	it("projectRoutedTranscript transforms system prompts, tool declarations, messages, and ephemeralTail", () => {
		const model = makePhysicalModel();
		const sysWithSections: SystemMessage = {
			role: "system",
			content: "Base prompt",
			sections: { existing: "keep" },
			toolsAdded: [makeTool("read"), makeTool("write")],
			timestamp: 100,
		};
		const userMsg: Message = { role: "user", content: "hi", timestamp: 200 };
		const ctx: TranscriptContext = { messages: [sysWithSections, userMsg] } as TranscriptContext;

		// No-op returns exact context reference
		const noopRoute: ModelRoute = { model, thinkingLevel: "off" };
		expect(projectRoutedTranscript(ctx, noopRoute)).toBe(ctx);

		// System prefix/append + allowedTools filtering + string ephemeralTail
		const filtered = projectRoutedTranscript(ctx, {
			model,
			thinkingLevel: "off",
			systemPromptPrefix: "PREFIX: ",
			systemAppend: "EXTRA",
			allowedTools: ["read"],
			ephemeralTail: "EPHEMERAL",
		});
		const sysOut = filtered.messages[0] as SystemMessage;
		expect(sysOut.content).toBe("PREFIX: Base prompt");
		expect(sysOut.sections).toEqual({ existing: "keep", "pi.virtual.append": "EXTRA" });
		expect(sysOut.toolsAdded?.map((t) => t.name)).toEqual(["read"]);
		expect(filtered.messages.at(-1)).toEqual({
			role: "user",
			content: "EPHEMERAL",
			timestamp: 200,
		});

		// preserveToolDeclarations keeps toolsAdded frozen verbatim
		const frozen = projectRoutedTranscript(ctx, {
			model,
			thinkingLevel: "off",
			allowedTools: ["read"],
			preserveToolDeclarations: true,
		});
		expect((frozen.messages[0] as SystemMessage).toolsAdded?.map((t) => t.name)).toEqual(["read", "write"]);

		// Missing leading system message inserts one and uses fallbackTimestamp when messages have none
		const bareCtx: TranscriptContext = {
			messages: [{ role: "user", content: "only user" } as unknown as Message],
		} as TranscriptContext;
		const withInserted = projectRoutedTranscript(
			bareCtx,
			{
				model,
				thinkingLevel: "off",
				messages: (msgs) => msgs.slice(),
				systemPromptPrefix: "PRE ",
				systemAppend: "APP",
				ephemeralTail: [{ role: "user", content: "tail-msg", timestamp: 500 }],
			},
			999,
		);
		expect(withInserted.messages[0]).toEqual({
			role: "system",
			content: "PRE \n\nAPP",
			timestamp: 999,
		});
		expect(withInserted.messages.at(-1)).toEqual({ role: "user", content: "tail-msg", timestamp: 500 });
	});

	it("anchorAnthropicCacheBeforeEphemeralTail relocates cache_control onto canonical prefix", () => {
		// Non-object / empty tail returns unchanged
		expect(anchorAnthropicCacheBeforeEphemeralTail(null, "tail")).toBeNull();
		const noTailPayload = { messages: [{ role: "user", content: "u" }] };
		expect(anchorAnthropicCacheBeforeEphemeralTail(noTailPayload, "")).toBe(noTailPayload);

		// String canonical message + string ephemeralTail + trailing synthetic effort turn
		const payload = {
			messages: [
				{ role: "user", content: "canonical question" },
				{ role: "system", content: [], output_config: { effort: "high" } },
				{
					role: "user",
					content: [{ type: "text", text: "ephemeral slice", cache_control: { type: "ephemeral" } }],
				},
			],
		};
		const anchored = anchorAnthropicCacheBeforeEphemeralTail(payload, "ephemeral slice") as {
			messages: Array<Record<string, unknown>>;
		};
		expect(anchored.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "canonical question", cache_control: { type: "ephemeral" } }],
		});
		expect(anchored.messages[2]).toEqual({
			role: "user",
			content: [{ type: "text", text: "ephemeral slice" }],
		});

		// Array canonical message + grouped toolResult Message[] tail
		const tailMsgs: Message[] = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "read",
				content: [{ type: "text", text: "r1" }],
				isError: false,
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "t2",
				toolName: "read",
				content: [{ type: "text", text: "r2" }],
				isError: false,
				timestamp: 2,
			},
		];
		const arrPayload = {
			messages: [
				{ role: "user", content: [{ type: "text", text: "canon" }] },
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "t1", content: "r1" },
						{ type: "tool_result", tool_use_id: "t2", content: "r2", cache_control: { type: "ephemeral" } },
					],
				},
			],
		};
		const anchoredArr = anchorAnthropicCacheBeforeEphemeralTail(arrPayload, tailMsgs) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(anchoredArr.messages[0]).toEqual({
			role: "user",
			content: [{ type: "text", text: "canon", cache_control: { type: "ephemeral" } }],
		});
		expect(anchoredArr.messages[1]).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: "r1" },
				{ type: "tool_result", tool_use_id: "t2", content: "r2" },
			],
		});
	});

	it("applyRequiredToolChoicePayload handles Anthropic, Gemini/Antigravity, Bedrock, Meta, and OpenAI", () => {
		expect(
			applyRequiredToolChoicePayload(
				{ model: "claude", thinking: { type: "enabled" }, output_config: { effort: "high" } },
				"anthropic-messages",
			),
		).toEqual({ model: "claude", tool_choice: { type: "any" } });

		expect(
			applyRequiredToolChoicePayload(
				{ request: { toolConfig: { functionCallingConfig: { allowedFunctionNames: ["read"] } } } },
				"antigravity-api",
			),
		).toEqual({
			request: {
				toolConfig: { functionCallingConfig: { allowedFunctionNames: ["read"], mode: "ANY" } },
			},
		});

		expect(applyRequiredToolChoicePayload({ contents: [] }, "google-generative-ai")).toEqual({
			contents: [],
			toolConfig: { functionCallingConfig: { mode: "ANY" } },
		});

		expect(
			applyRequiredToolChoicePayload({ toolConfig: { tools: [] } }, "bedrock-converse-stream"),
		).toEqual({
			toolConfig: { tools: [], toolChoice: { any: {} } },
		});
		const bedrockNoTools = { messages: [] };
		expect(applyRequiredToolChoicePayload(bedrockNoTools, "bedrock-converse-stream")).toBe(bedrockNoTools);

		const metaPayload = { messages: [] };
		expect(applyRequiredToolChoicePayload(metaPayload, "openai-completions", { provider: "meta" })).toBe(
			metaPayload,
		);
		expect(
			applyRequiredToolChoicePayload(metaPayload, "openai-completions", { baseUrl: "https://api.meta.ai/v1" }),
		).toBe(metaPayload);

		expect(applyRequiredToolChoicePayload({ messages: [] }, "openai-completions")).toEqual({
			messages: [],
			tool_choice: "required",
		});
	});

	it("buildRoutedStreamOptions caps maxTokens, clamps reasoning, and composes onPayload", async () => {
		const anthropicModel = makePhysicalModel({ api: "anthropic-messages", maxTokens: 500 });
		const opts = buildRoutedStreamOptions(
			{
				maxTokens: 2000,
				onPayload: (p) => ({ ...(p as Record<string, unknown>), hookRan: true }),
			},
			{
				model: anthropicModel,
				thinkingLevel: "high",
				temperature: 0.2,
				sessionId: "sess-1",
				disableContinuation: true,
				toolChoice: "required",
				ephemeralTail: "tail",
			},
		);

		expect(opts.maxTokens).toBe(500);
		expect(opts.temperature).toBe(0.2);
		expect(opts.sessionId).toBe("sess-1");
		expect(opts.disableContinuation).toBe(true);
		expect(opts.reasoning).toBe("high");
		expect(opts.toolChoice).toBeUndefined();
		expect(opts.onPayload).toBeTypeOf("function");

		const shaped = await opts.onPayload?.(
			{
				thinking: { type: "enabled" },
				messages: [
					{ role: "user", content: "q" },
					{ role: "user", content: [{ type: "text", text: "tail", cache_control: { type: "ephemeral" } }] },
				],
			},
			anthropicModel,
		);
		expect(shaped).toEqual({
			messages: [
				{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: [{ type: "text", text: "tail" }] },
			],
			tool_choice: { type: "any" },
			hookRan: true,
		});

		const autoOpts = buildRoutedStreamOptions(undefined, {
			model: makePhysicalModel({ reasoning: false }),
			thinkingLevel: "high",
			toolChoice: "auto",
		});
		expect(autoOpts.reasoning).toBeUndefined();
		expect(autoOpts.toolChoice).toBe("auto");
		expect(autoOpts.onPayload).toBeUndefined();
	});
});
