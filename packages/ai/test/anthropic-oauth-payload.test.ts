import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/anthropic-messages.ts";
import { buildBillingHeader, shapeOAuthPayload } from "../src/api/anthropic-oauth/request-shaping.ts";
import { CLAUDE_CODE_VERSION_ENV } from "../src/api/anthropic-oauth/version.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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
});

describe("native Claude Code version recovery", () => {
	it("retries one named floor, updates billing and UA together, then remembers it", async () => {
		const wire = capture([() => rejection("2.1.900"), success]);
		const onPayload = vi.fn();
		const onResponse = vi.fn();
		const result = await stream(model, context, { apiKey, fetch: wire.fetch, onPayload, onResponse }).result();
		expect(result.stopReason).toBe("stop");
		expect(wire.payloads).toHaveLength(2);
		expect(billing(wire.payloads[1]!)).toContain("cc_version=2.1.900.");
		expect(wire.headers[1]!.get("user-agent")).toBe("claude-cli/2.1.900");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(onResponse).toHaveBeenCalledTimes(1);
		const next = capture();
		await stream(model, context, { apiKey, fetch: next.fetch }).result();
		expect(billing(next.payloads[0]!)).toContain("cc_version=2.1.900.");
	});
	it("stops after one recovery even with an ordinary retry budget", async () => {
		const wire = capture([() => rejection("2.1.901"), () => rejection("2.1.902")]);
		const result = await stream(model, context, { apiKey, fetch: wire.fetch, maxRetries: 3 }).result();
		expect(wire.payloads).toHaveLength(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(CLAUDE_CODE_VERSION_ENV);
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
