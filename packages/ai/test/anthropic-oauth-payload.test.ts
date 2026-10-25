import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/anthropic-messages.ts";
import { buildBillingHeader, shapeOAuthPayload } from "../src/api/anthropic-oauth/request-shaping.ts";
import { CLAUDE_CODE_VERSION_ENV } from "../src/api/anthropic-oauth/version.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

beforeEach(() => vi.stubEnv(CLAUDE_CODE_VERSION_ENV, undefined));
afterEach(() => vi.unstubAllEnvs());

const apiKey = "sk-ant-oat-synthetic";
const pin = { [CLAUDE_CODE_VERSION_ENV]: "2.1.280" };
const model: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
};
const prompt =
	"You are an expert coding assistant operating inside pi, a coding agent harness.\n\n<tools>\n- read: Read files\n\nIn addition to the tools above, more tools may exist.\n</tools>\n\n<docs>\nPi documentation (read only when the user asks about pi itself): docs here\n</docs>\n\n<project_context>\nKeep ALL project instructions.\n</project_context>\n\n<skills>\nkeep skills\n</skills>\n\n<cwd>\n/home/u/project\n</cwd>";
const context = normalizeContext({ systemPrompt: prompt, messages: [{ role: "user", content: "Hi", timestamp: 1 }] });
function success(): Response {
	return new Response(
		[
			{
				type: "message_start",
				message: { id: "msg_mock", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "native-ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream", "x-test": "yes" } },
	);
}
function rejection(version?: string, code = "claude_code_version_too_old", status = 400) {
	return Response.json(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message: version ? `Claude Code version ${version} or newer is required.` : "Unsupported client",
				details: { error_code: code },
			},
		},
		{ status },
	);
}
function capture(responses: (() => Response)[] = [success]) {
	const payloads: MessageCreateParamsStreaming[] = [];
	const headers: Headers[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		payloads.push(JSON.parse(String(init?.body)) as MessageCreateParamsStreaming);
		headers.push(new Headers(init?.headers));
		return responses[Math.min(payloads.length - 1, responses.length - 1)]!();
	};
	return { payloads, headers, fetch };
}
function billing(payload: MessageCreateParamsStreaming): string | undefined {
	return Array.isArray(payload.system)
		? payload.system.find((block) => block.text.startsWith("x-anthropic-billing-header:"))?.text
		: undefined;
}
function withoutBilling(payload: MessageCreateParamsStreaming): MessageCreateParamsStreaming {
	return {
		...payload,
		system: Array.isArray(payload.system)
			? payload.system.filter((block) => !block.text.startsWith("x-anthropic-billing-header:"))
			: payload.system,
	};
}

describe("native Anthropic OAuth shaping", () => {
	it.each([
		["Hi", "d7b", "3639e"],
		["Hello native subscriptions", "5d9", "a1748"],
		["abcd😀x🌍hello こんにちは", "159", "3e1f2"],
	])("matches the billing recipe for %s", async (text, suffix, cch) => {
		expect(await buildBillingHeader(text!, "2.1.280")).toBe(
			`x-anthropic-billing-header: cc_version=2.1.280.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`,
		);
	});

	it.each([stream, streamSimple])("shapes both direct entry points after an async replacement hook", async (call) => {
		const wire = capture();
		const onResponse = vi.fn();
		const onPayload = vi.fn(async (payload: unknown) => {
			await Promise.resolve();
			return { ...(payload as MessageCreateParamsStreaming), system: prompt };
		});
		const result = await call(model, context, {
			apiKey,
			env: pin,
			fetch: wire.fetch,
			onPayload,
			onResponse,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "native-ok" }]);
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledWith(
			expect.objectContaining({ status: 200, headers: expect.objectContaining({ "x-test": "yes" }) }),
			model,
		);
		const system = wire.payloads[0]!.system;
		expect(system).toEqual([
			{
				type: "text",
				text: "x-anthropic-billing-header: cc_version=2.1.280.d7b; cc_entrypoint=sdk-cli; cch=3639e;",
			},
			expect.objectContaining({ text: expect.stringContaining("Keep ALL project instructions.") }),
		]);
		const text = JSON.stringify(system);
		expect(text).toContain("You are an expert coding assistant.");
		expect(text).toContain("keep skills");
		expect(text).toContain("/home/u/project");
		expect(text).not.toContain("Pi documentation");
		expect(text).not.toContain("In addition to the tools above");
		expect(wire.headers[0]!.get("user-agent")).toBe("claude-cli/2.1.280");
		expect(wire.headers[0]!.get("authorization")).toBe(`Bearer ${apiKey}`);
	});

	it("preserves extension fields added before OAuth shaping", async () => {
		const wire = capture();
		const result = await stream(model, context, {
			apiKey,
			env: pin,
			fetch: wire.fetch,
			onPayload: async (payload) => {
				await Promise.resolve();
				return {
					...(payload as MessageCreateParamsStreaming),
					service_tier: "auto",
					x_extension_marker: "preserved",
				};
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads[0]).toMatchObject({ service_tier: "auto", x_extension_marker: "preserved" });
		expect(billing(wire.payloads[0]!)).toBeDefined();
	});

	it("runs natively through Models with stored subscription credentials", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: apiKey,
			refresh: "fake-refresh",
			expires: Date.now() + 3600000,
		}));
		const models = createModels({ credentials });
		models.setProvider(anthropicProvider());
		const wire = capture();
		const result = await models.streamSimple(model, context, { fetch: wire.fetch, env: pin }).result();
		expect(result.stopReason).toBe("stop");
		expect(billing(wire.payloads[0]!)).toBeDefined();
	});

	it("preserves generated managed-effort markers on every flagged catalog model", async () => {
		const managedModels = Object.values(ANTHROPIC_MODELS).filter(
			(candidate) => candidate.compat?.supportsMidConvoEffort === true,
		);
		expect(managedModels.length).toBeGreaterThan(0);
		for (const managedModel of managedModels) {
			const previous: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "First answer" }],
				api: managedModel.api,
				provider: managedModel.provider,
				model: managedModel.id,
				providerThinkingLevel: "medium",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			};
			const wire = capture();
			const result = await streamSimple(
				managedModel,
				normalizeContext({
					systemPrompt: "Custom prompt",
					messages: [
						{ role: "user", content: "First question", timestamp: 1 },
						previous,
						{ role: "user", content: "Second question", timestamp: 3 },
					],
				}),
				{ apiKey, env: pin, fetch: wire.fetch, reasoning: "low" },
			).result();
			expect(result.stopReason, managedModel.id).toBe("stop");
			expect(billing(wire.payloads[0]!), managedModel.id).toBeDefined();
			expect(
				wire.payloads[0]!.messages.filter((message) => message.role === "system" && message.output_config),
				managedModel.id,
			).toEqual([
				{ role: "system", content: [], output_config: { effort: "medium" } },
				{ role: "system", content: [], output_config: { effort: "low" } },
			]);
		}
	});

	it("shapes in-place hook mutations and preserves custom user-agent precedence", async () => {
		const wire = capture();
		await stream(model, context, {
			apiKey,
			env: pin,
			fetch: wire.fetch,
			headers: { "User-Agent": "caller" },
			onPayload: (payload) => {
				(payload as MessageCreateParamsStreaming).system = "Custom prompt";
			},
		}).result();
		expect(wire.headers[0]!.get("user-agent")).toBe("caller");
		expect(wire.payloads[0]!.system).toContainEqual({ type: "text", text: "Custom prompt" });
	});

	it("restores streaming after an in-place payload hook disables it", async () => {
		const wire = capture();
		const result = await stream(model, context, {
			apiKey,
			env: pin,
			fetch: wire.fetch,
			onPayload: (payload) => {
				(payload as { stream: boolean }).stream = false;
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads[0]!.stream).toBe(true);
	});

	it("cancels the response body when the response hook throws", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const result = await stream(model, context, {
			apiKey,
			env: pin,
			fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			onResponse: () => {
				throw new Error("response hook failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("response hook failed");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("does not cancel the body after normal completion", async () => {
		const response = success();
		const cancel = vi.spyOn(response.body!, "cancel");
		const result = await stream(model, context, { apiKey, env: pin, fetch: async () => response }).result();
		expect(result.stopReason).toBe("stop");
		expect(cancel).not.toHaveBeenCalled();
	});

	it("cancels the body and preserves the error when a provider event hook throws", async () => {
		const response = success();
		const cancel = vi.spyOn(response.body!, "cancel");
		const result = await stream(model, context, {
			apiKey,
			env: pin,
			fetch: async () => response,
			onProviderStreamEvent: () => {
				throw new Error("provider event failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("provider event failed");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("preserves the original hook error when body cancellation rejects", async () => {
		const cancel = vi.fn().mockRejectedValue(new Error("cancel failed"));
		const body = new ReadableStream<Uint8Array>({ cancel });
		const result = await stream(model, context, {
			apiKey,
			env: pin,
			fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
			onResponse: () => {
				throw new Error("response hook failed");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("response hook failed");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("preserves identity and cache blocks on an ordinary OAuth request", async () => {
		const wire = capture();
		await stream(model, context, { apiKey, env: pin, fetch: wire.fetch }).result();
		const system = wire.payloads[0]!.system;
		expect(Array.isArray(system)).toBe(true);
		if (!Array.isArray(system)) return;
		expect(system[0]).toEqual({ type: "text", text: billing(wire.payloads[0]!) });
		expect(system[1]).toMatchObject({
			type: "text",
			text: "You are Claude Code, Anthropic's official CLI for Claude.",
			cache_control: { type: "ephemeral" },
		});
		expect(system[2]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
		expect(system.filter((block) => block.cache_control !== undefined)).toHaveLength(2);
	});

	it("applies forced tool choice compatibility without OAuth prompt or billing shaping", async () => {
		const wire = capture();
		const result = await stream(
			{ ...model, id: "claude-opus-5-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
			context,
			{ apiKey: "sk-ant-api-synthetic", thinkingEnabled: true, toolChoice: "any", fetch: wire.fetch },
		).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads[0]!.tool_choice).toEqual({ type: "auto" });
		expect(billing(wire.payloads[0]!)).toBeUndefined();
		expect(JSON.stringify(wire.payloads[0]!.system)).toContain("Pi documentation");
	});

	it("normalizes a named Claude Code tool in tool_choice and the tool list", async () => {
		const wire = capture();
		const result = await stream(
			{ ...model, id: "claude-opus-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
			normalizeContext({
				systemPrompt: "Use the read tool.",
				messages: [{ role: "user", content: "Read the file", timestamp: 1 }],
				tools: [
					{
						name: "read",
						description: "Read a file",
						parameters: { type: "object", properties: {}, required: [] },
					},
				],
			}),
			{
				apiKey,
				thinkingEnabled: true,
				toolChoice: { type: "tool", name: "read" },
				fetch: wire.fetch,
			},
		).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads[0]!.tools?.[0]).toMatchObject({ name: "Read" });
		expect(wire.payloads[0]!.tool_choice).toEqual({ type: "tool", name: "Read" });
	});

	it.each(["any", "none"] as const)(
		"preserves OAuth tool_choice type %s without requiring a tool name",
		async (type) => {
			const wire = capture();
			const result = await stream(
				{ ...model, id: "claude-opus-5", reasoning: true, compat: { forceAdaptiveThinking: true } },
				normalizeContext({
					systemPrompt: "Use tools when useful.",
					messages: [{ role: "user", content: "Hi", timestamp: 1 }],
					tools: [
						{
							name: "read",
							description: "Read a file",
							parameters: { type: "object", properties: {}, required: [] },
						},
					],
				}),
				{ apiKey, thinkingEnabled: true, toolChoice: type, fetch: wire.fetch },
			).result();
			expect(result.stopReason).toBe("stop");
			expect(wire.payloads[0]!.tool_choice).toEqual({ type });
		},
	);

	it.each(["key", "headers", "copilot", "client"])("does not shape %s requests", async (kind) => {
		const wire = capture();
		const result = await stream(kind === "copilot" ? { ...model, provider: "github-copilot" } : model, context, {
			...(kind === "headers"
				? { headers: { Authorization: `Bearer ${apiKey}` } }
				: { apiKey: kind === "key" ? "sk-ant-api-synthetic" : apiKey }),
			...(kind === "client" ? { client: new Anthropic({ apiKey: "api-key", fetch: wire.fetch }) } : {}),
			fetch: wire.fetch,
			env: pin,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(billing(wire.payloads[0]!)).toBeUndefined();
		expect(JSON.stringify(wire.payloads[0]!.system)).toContain("Pi documentation");
		expect(wire.headers[0]!.get("x-claude-code-session-id")).toBeNull();
	});

	it("sends a UUIDv4 x-claude-code-session-id that is stable per session", async () => {
		const wire = capture();
		const send = (sessionId?: string) =>
			stream(model, context, { apiKey, env: pin, fetch: wire.fetch, sessionId }).result();
		await send("01a115f3-4c34-7791-bbfc-c9688e9c0db4");
		await send("01a115f3-4c34-7791-bbfc-c9688e9c0db4");
		await send("other-session");
		await send();
		await send();
		const ids = wire.headers.map((headers) => headers.get("x-claude-code-session-id"));
		for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(ids[4]).toBe(ids[3]);
		expect(ids[3]).not.toBe(ids[0]);
	});

	it("preserves signed assistant order, system tool updates, and empty effort messages", async () => {
		const assistant: MessageCreateParamsStreaming["messages"][number] = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "reason", signature: "signed" },
				{ type: "tool_use", id: "call", name: "Read", input: {} },
				{ type: "text", text: "after tool" },
			],
		};
		const effort: MessageCreateParamsStreaming["messages"][number] = {
			role: "system",
			content: [],
			output_config: { effort: "low" },
		};
		const params: MessageCreateParamsStreaming = {
			model: model.id,
			stream: true,
			max_tokens: 10,
			messages: [
				{ role: "user", content: "Hi" },
				assistant,
				{
					role: "system",
					content: [
						{
							type: "text",
							text: 'Updated system prompt section "docs":\n\n<docs>\nPi documentation (read only when the user asks about pi itself): docs\n</docs>',
						},
					],
				},
				effort,
				{
					role: "system",
					content: [
						{ type: "tool_removal", tool: { type: "tool_reference", name: "Read" } },
						{
							type: "tool_addition",
							tool: { type: "tool_definition", definition: { name: "Write", input_schema: { type: "object" } } },
						},
					],
				},
			],
			system: prompt,
		};
		const shaped = await shapeOAuthPayload(params, "2.1.280");
		expect(shaped.messages).toHaveLength(4);
		expect(shaped.messages[1]).toBe(assistant);
		expect(shaped.messages[2]).toEqual(effort);
		expect(shaped.messages[3]).toEqual(params.messages[4]);
		expect(await shapeOAuthPayload(shaped, "2.1.280")).toEqual(shaped);
	});

	it("preserves unknown prompts and omits billing when the first user message has no text", async () => {
		const params: MessageCreateParamsStreaming = {
			model: model.id,
			stream: true,
			max_tokens: 10,
			system: "unfamiliar prompt",
			messages: [
				{
					role: "user",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }],
				},
				{ role: "user", content: "later text" },
			],
		};
		const shaped = await shapeOAuthPayload(params, "2.1.280");
		expect(shaped.system).toEqual([{ type: "text", text: "unfamiliar prompt" }]);
		expect(await buildBillingHeader("", "2.1.280")).toBeUndefined();
	});

	it("injects frontier completion and JSON tool rules into shaped prompts", async () => {
		const shaped = await shapeOAuthPayload(
			{
				model: "claude-opus-5-5",
				stream: true,
				max_tokens: 10,
				system: prompt,
				messages: [{ role: "user", content: "Plan, then build" }],
			},
			"2.1.310",
		);
		const systemText = JSON.stringify(shaped.system);
		expect(systemText).toContain("order of operations within the turn, not a stopping point");
		expect(systemText).toContain("never serialize XML parameter tags inside JSON arguments");
	});

	it.each([
		"claude-opus-5-5",
		"claude-sonnet-5-5",
		"claude-fable-5-1",
		"claude-mythos-5-1",
		"claude-opus-5.5",
		"anthropic/claude-sonnet-5.5",
		"~anthropic/claude-fable-5.1-20260101",
		"claude-mythos-5.1-20260101",
		"claude-opus.5.5",
		"claude-sonnet.5.5",
	])("downgrades forced tool_choice on %s, which rejects it with adaptive thinking", async (modelId) => {
		const shaped = await shapeOAuthPayload(
			{
				model: modelId,
				stream: true,
				max_tokens: 10,
				thinking: { type: "adaptive" },
				tool_choice: { type: "any", disable_parallel_tool_use: true },
				messages: [{ role: "user", content: "Hi" }],
			},
			"2.1.310",
		);
		expect(shaped.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5"])(
		"preserves forced tool_choice on %s with adaptive thinking",
		async (modelId) => {
			const shaped = await shapeOAuthPayload(
				{
					model: modelId,
					stream: true,
					max_tokens: 10,
					thinking: { type: "adaptive" },
					tool_choice: { type: "tool", name: "read" },
					messages: [{ role: "user", content: "Hi" }],
				},
				"2.1.310",
			);
			expect(shaped.tool_choice).toEqual({ type: "tool", name: "read" });
		},
	);

	it.each(["any", "tool"] as const)("downgrades tool_choice type %s with manual extended thinking", async (type) => {
		const shaped = await shapeOAuthPayload(
			{
				model: "claude-sonnet-4-5",
				stream: true,
				max_tokens: 2048,
				thinking: { type: "enabled", budget_tokens: 1024 },
				tool_choice: type === "tool" ? { type, name: "read" } : { type },
				messages: [{ role: "user", content: "Hi" }],
			},
			"2.1.310",
		);
		expect(shaped.tool_choice).toEqual({ type: "auto" });
	});
});

describe("native Claude Code version recovery", () => {
	it("tracks the bundled version, learned floor, equal/lower floors, and repeated rejection in order", async () => {
		const initial = capture();
		await stream(model, context, { apiKey, fetch: initial.fetch }).result();
		expect(initial.headers[0]!.get("user-agent")).toBe("claude-cli/2.1.310");
		expect(billing(initial.payloads[0]!)).toBe(
			"x-anthropic-billing-header: cc_version=2.1.310.077; cc_entrypoint=sdk-cli; cch=3639e;",
		);

		const wire = capture([() => rejection("2.1.900"), success]);
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		const result = await stream(model, context, { apiKey, fetch: wire.fetch, onPayload, onResponse }).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads).toHaveLength(2);
		expect(billing(wire.payloads[1]!)).toBe(
			"x-anthropic-billing-header: cc_version=2.1.900.b15; cc_entrypoint=sdk-cli; cch=3639e;",
		);
		expect(wire.payloads[1]!.system).toHaveLength((wire.payloads[0]!.system as unknown[]).length);
		expect(withoutBilling(wire.payloads[1]!)).toEqual(withoutBilling(wire.payloads[0]!));
		expect(wire.headers[1]!.get("user-agent")).toBe("claude-cli/2.1.900");
		expect(wire.headers[1]!.get("x-claude-code-session-id")).toBe(wire.headers[0]!.get("x-claude-code-session-id"));
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
		const next = capture();
		await stream(model, context, { apiKey, fetch: next.fetch }).result();
		expect(billing(next.payloads[0]!)).toContain("cc_version=2.1.900.");

		for (const required of ["2.1.900", "2.1.899"]) {
			const rejected = capture([() => rejection(required), success]);
			const rejectedResult = await stream(model, context, { apiKey, fetch: rejected.fetch }).result();
			expect(rejectedResult.stopReason).toBe("error");
			expect(rejected.payloads).toHaveLength(1);
			expect(billing(rejected.payloads[0]!)).toContain("cc_version=2.1.900.");
			expect(rejected.headers[0]!.get("user-agent")).toBe("claude-cli/2.1.900");
		}

		const repeated = capture([() => rejection("2.1.901"), () => rejection("2.1.902")]);
		const repeatedResult = await stream(model, context, { apiKey, fetch: repeated.fetch, maxRetries: 3 }).result();
		expect(repeated.payloads).toHaveLength(2);
		expect(repeatedResult.stopReason).toBe("error");
		expect(repeatedResult.errorMessage).toContain(CLAUDE_CODE_VERSION_ENV);
	});
	it.each(["pin", "no-floor", "unrelated", "non-400"])("does not recover %s", async (kind) => {
		const wire = capture([
			() =>
				rejection(
					kind === "no-floor" ? undefined : "2.1.999",
					kind === "unrelated" ? "different_error" : undefined,
					kind === "non-400" ? 403 : 400,
				),
		]);
		const result = await stream(model, context, {
			apiKey,
			fetch: wire.fetch,
			...(kind === "pin" ? { env: pin } : {}),
		}).result();
		expect(wire.payloads).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		if (kind === "pin") expect(result.errorMessage).toContain("is pinned");
	});
	it("rejects an invalid version before sending", async () => {
		const wire = capture();
		const result = await stream(model, context, {
			apiKey,
			fetch: wire.fetch,
			env: { [CLAUDE_CODE_VERSION_ENV]: "invalid" },
		}).result();
		expect(result.errorMessage).toContain("bare X.Y.Z");
		expect(wire.payloads).toHaveLength(0);
	});
	it("honors an aborted signal before dispatch", async () => {
		const wire = capture();
		const controller = new AbortController();
		controller.abort();
		const result = await stream(model, context, { apiKey, fetch: wire.fetch, signal: controller.signal }).result();
		expect(result.stopReason).toBe("aborted");
		expect(wire.payloads).toHaveLength(0);
	});
});
