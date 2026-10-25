import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	META_REASONING_ONLY_PLACEHOLDER,
	repairMetaConversationStructure,
	stream as streamOpenAIResponses,
} from "../src/api/openai-responses.ts";
import { metaOAuth } from "../src/auth/oauth/meta.ts";
import type { ProviderAuthInteraction } from "../src/auth/types.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { buildMetaModels, metaProvider } from "../src/providers/meta.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

const CLIENT_ID = "1031625952748946";
const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MINT_URL = "https://api.meta.ai/muse-code/key";
const MODELS_URL = "https://api.meta.ai/muse-code/models";
const DAY_MS = 24 * 60 * 60 * 1000;

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function getUrl(input: unknown): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (input instanceof Request) return input.url;
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

function createInteraction(events: Array<Record<string, unknown>>): ProviderAuthInteraction {
	return {
		signal: new AbortController().signal,
		prompt: async () => {
			throw new Error("Meta login should not prompt");
		},
		notify: (event) => events.push(event),
	};
}

describe("Meta OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("logs in with the device flow and mints a Model API key", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-09-03T00:00:00Z");
		vi.setSystemTime(startTime);

		const events: Array<Record<string, unknown>> = [];
		const pollResponses = [
			jsonResponse({ error: "authorization_pending" }, 400),
			jsonResponse({ access_token: "identity-token", token_type: "Bearer" }),
		];

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = getUrl(input);
				if (url === DEVICE_AUTHORIZATION_URL) {
					expect(init?.method).toBe("POST");
					expect(new URLSearchParams(String(init?.body)).get("client_id")).toBe(CLIENT_ID);
					return jsonResponse({
						device_code: "device-code-123",
						user_code: "ABCD-1234",
						verification_uri: "https://auth.meta.com/oauth/device/",
						verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-1234",
						interval: 5,
						expires_in: 600,
					});
				}
				if (url === DEVICE_TOKEN_URL) {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
					expect(params.get("client_id")).toBe(CLIENT_ID);
					expect(params.get("device_code")).toBe("device-code-123");
					const response = pollResponses.shift();
					if (!response) throw new Error("Unexpected extra token poll");
					return response;
				}
				if (url === MINT_URL) {
					expect(init?.method).toBe("POST");
					expect(init?.headers).toMatchObject({ Authorization: "Bearer identity-token" });
					return jsonResponse({ api_key: "LLM|minted-key" });
				}
				throw new Error(`Unexpected fetch URL: ${url}`);
			}),
		);

		const credentialPromise = metaOAuth.login(createInteraction(events));
		for (let i = 0; i < 5 && events.length === 0; i++) {
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(events[0]).toEqual({
			type: "device_code",
			userCode: "ABCD-1234",
			verificationUri: "https://auth.meta.com/oauth/device/?code=ABCD-1234",
			intervalSeconds: 5,
			expiresInSeconds: 600,
		});

		await vi.advanceTimersByTimeAsync(10000);
		await expect(credentialPromise).resolves.toEqual({
			type: "oauth",
			refresh: "identity-token",
			access: "LLM|minted-key",
			expires: startTime.getTime() + 10000 + DAY_MS,
		});
	});

	it("re-mints the API key from the stored identity token on refresh", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-09-03T12:00:00Z");
		vi.setSystemTime(now);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				expect(getUrl(input)).toBe(MINT_URL);
				expect(init?.headers).toMatchObject({ Authorization: "Bearer identity-token" });
				return jsonResponse({ api_key: "LLM|fresh-key" });
			}),
		);

		await expect(
			metaOAuth.refresh(
				{ type: "oauth", refresh: "identity-token", access: "LLM|old-key", expires: 1 },
				new AbortController().signal,
			),
		).resolves.toEqual({
			type: "oauth",
			refresh: "identity-token",
			access: "LLM|fresh-key",
			expires: now.getTime() + DAY_MS,
		});
	});

	it("reports the setup URL when Meta issues no key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ require_payment: true, action_url: "https://dev.meta.ai/billing" })),
		);
		await expect(
			metaOAuth.refresh(
				{ type: "oauth", refresh: "identity-token", access: "", expires: 1 },
				new AbortController().signal,
			),
		).rejects.toThrow("Complete setup at https://dev.meta.ai/billing");
	});

	it("uses the minted key as the request api key", async () => {
		await expect(
			metaOAuth.toAuth({ type: "oauth", refresh: "identity-token", access: "LLM|key", expires: 1 }),
		).resolves.toEqual({ apiKey: "LLM|key" });
	});
});

describe("Meta provider catalog & Responses wire behavior", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("ships muse-wonder-full-1.0, contributor variants, 1007997/128000 limits, and max effort on spark-1.3-contributor", () => {
		const models = new Map(
			metaProvider()
				.getModels()
				.map((m) => [m.id, m]),
		);
		const wonderFull = models.get("muse-wonder-full-1.0")!;
		expect(wonderFull).toMatchObject({
			id: "muse-wonder-full-1.0",
			provider: "meta",
			api: "openai-responses",
			contextWindow: 1007997,
			maxTokens: 128000,
			compat: {
				supportsLongCacheRetention: false,
				supportsStrictMode: false,
				supportsMidConvoSystemMessages: true,
				supportsToolSearch: true,
			},
		});
		expect(getSupportedThinkingLevels(wonderFull)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
		expect(models.get("muse-wonder-full-1.0-contributor")?.cost.input).toBe(0.1);
		expect(models.get("muse-wonder-1.0-contributor")?.cost.input).toBe(0.1);
		expect(getSupportedThinkingLevels(models.get("muse-spark-1.3-contributor")!)).toContain("max");
	});

	it("refreshes /muse-code/models and preserves baseline models over stale stored snapshots", async () => {
		const provider = metaProvider();
		expect(provider.headers).toEqual({
			"x-api-version": "1.0.0",
			"x-client-id": "tbh:tui",
		});

		const staleSpark = {
			...getModel("meta", "muse-spark-1.3"),
			compat: undefined,
		} as Model<"openai-responses">;

		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				expect(getUrl(input)).toBe(MODELS_URL);
				expect(init?.headers).toMatchObject({
					Authorization: "Bearer LLM|minted-key",
					"x-api-version": "1.0.0",
					"x-client-id": "tbh:tui",
				});
				return jsonResponse({
					object: "list",
					data: [
						{
							id: "muse-wonder-full-2.0",
							object: "model",
							metadata: {
								"muse-code": {
									name: "Muse Wonder Full 2.0",
									is_hidden: false,
									reasoning: true,
									tool_call: true,
									limit: { context: 1007997, output: 128000 },
									modalities: { input: ["text", "image"], output: ["text"] },
									variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} },
								},
							},
						},
						{
							id: "muse-image-1.0",
							object: "model",
							metadata: {
								"muse-code": {
									name: "Muse Image",
									is_hidden: true,
									tool_call: false,
								},
							},
						},
					],
				});
			}),
		);

		let persistedModels: readonly unknown[] | undefined;
		await provider.refreshModels?.({
			allowNetwork: true,
			force: true,
			credential: { type: "oauth", refresh: "id", access: "LLM|minted-key", expires: Date.now() + 60_000 },
			stored: { models: [staleSpark], checkedAt: 1 },
			signal: new AbortController().signal,
			publish: async (pub) => {
				if (pub.persist) persistedModels = pub.persist.models;
				pub.update?.();
				return true;
			},
		});

		const ids = provider.getModels().map((m) => m.id);
		expect(ids).toContain("muse-wonder-full-1.0");
		expect(ids).toContain("muse-wonder-full-2.0");
		expect(ids).not.toContain("muse-image-1.0");
		expect(persistedModels?.length).toBeGreaterThanOrEqual(10);

		const discovered = provider.getModels().find((m) => m.id === "muse-wonder-full-2.0");
		expect(discovered).toMatchObject({
			name: "Muse Wonder Full 2.0",
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1007997,
			maxTokens: 128000,
			compat: {
				supportsLongCacheRetention: false,
				supportsStrictMode: false,
				supportsMidConvoSystemMessages: true,
				supportsToolSearch: true,
			},
		});
		expect(getSupportedThinkingLevels(discovered!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("sends Meta gateway headers, auto tool choice, default high reasoning, and preserves fc_ tool call IDs", async () => {
		const wonderFull = metaProvider()
			.getModels()
			.find((m) => m.id === "muse-wonder-full-1.0")!;
		const model: Model<"openai-responses"> = {
			...wonderFull,
			// Simulate remote catalog stripping compat so getCompat(model) fallback is exercised
			compat: undefined,
		};

		let capturedHeaders: Headers | undefined;
		let capturedPayload: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = new Headers(init?.headers);
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "meta",
			model: "muse-wonder-full-1.0",
			content: [
				{
					type: "toolCall",
					id: "call_01a13a2b0cda757cbdca177a687a8165|fc_01a13a2b0cda757cbdca177a687a8165",
					name: "ping",
					arguments: { value: "hi" },
				},
			],
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 20,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const stream = streamOpenAIResponses(
			model,
			normalizeContext({
				systemPrompt: "Be concise.",
				messages: [
					{ role: "user", content: "Ping once", timestamp: Date.now() },
					priorAssistant,
					{
						role: "toolResult",
						toolCallId: "call_01a13a2b0cda757cbdca177a687a8165|fc_01a13a2b0cda757cbdca177a687a8165",
						toolName: "ping",
						content: [{ type: "text", text: "pong" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "system", content: "Mid-convo update", timestamp: Date.now() },
					{ role: "user", content: "Done?", timestamp: Date.now() },
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
						constrainedSampling: { type: "json_schema", strict: "prefer" },
					},
				],
			}),
			{
				apiKey: "LLM|test-key",
				sessionId: "sess-meta-42",
				cacheRetention: "long",
				toolChoice: "auto",
				onPayload: (payload) => {
					capturedPayload = payload as Record<string, unknown>;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedHeaders?.get("x-api-version")).toBe("1.0.0");
		expect(capturedHeaders?.get("x-client-id")).toBe("tbh:tui");
		expect(capturedHeaders?.get("x-meta-ai-gateway-session-id")).toBe("sess-meta-42");
		expect(capturedHeaders?.get("session_id")).toBeNull();

		expect(capturedPayload).toMatchObject({
			model: "muse-wonder-full-1.0",
			prompt_cache_key: "sess-meta-42",
			tool_choice: "auto",
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			tools: [
				expect.objectContaining({
					name: "ping",
					parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
				}),
			],
		});
		// Meta's strict flag only validates, so tools go without it and with their schema unrewritten.
		expect((capturedPayload?.tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("strict");
		expect(capturedPayload?.prompt_cache_retention).toBeUndefined();

		const inputItems = capturedPayload?.input as Array<Record<string, unknown>>;
		const replayedCall = inputItems.find((item) => item.type === "function_call");
		const replayedOutput = inputItems.find((item) => item.type === "function_call_output");
		const midConvoDev = inputItems.filter((item) => item.role === "developer");
		expect(replayedCall).toMatchObject({
			type: "function_call",
			id: "fc_01a13a2b0cda757cbdca177a687a8165",
			call_id: "call_01a13a2b0cda757cbdca177a687a8165",
		});
		expect(replayedOutput).toMatchObject({
			type: "function_call_output",
			call_id: "call_01a13a2b0cda757cbdca177a687a8165",
		});
		expect(midConvoDev.length).toBe(2);
	});
});

describe("Meta audit regressions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	it.each(["none", "required", { type: "function", name: "ping" }] as const)(
		"honors tool choice %j",
		async (toolChoice) => {
			const fetch = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(
					new Response(
						'data: {"type":"response.completed","response":{"id":"done","status":"completed","output":[]}}\n\n',
					),
				);
			let payload: Record<string, unknown> | undefined;
			const result = await streamOpenAIResponses(
				metaProvider().getModels()[0],
				normalizeContext({
					messages: [{ role: "user", content: "Ping", timestamp: 0 }],
					tools: [{ name: "ping", description: "Ping", parameters: Type.Object({}) }],
				}),
				{
					apiKey: "test",
					toolChoice,
					onPayload: (value) => {
						payload = value as Record<string, unknown>;
					},
				},
			).result();
			if (toolChoice === "none") {
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(payload).not.toHaveProperty("tools");
				expect(payload).not.toHaveProperty("tool_choice");
				expect(fetch).toHaveBeenCalledOnce();
			} else {
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("Meta does not support required or forced tool choice");
				expect(fetch).not.toHaveBeenCalled();
			}
		},
	);
	it("keeps catalog baseline limits and uses constants only when missing", () => {
		const base = metaProvider().getModels()[0];
		expect(buildMetaModels([{ ...base, contextWindow: 90000, maxTokens: 12000 }])[0]).toMatchObject({
			contextWindow: 90000,
			maxTokens: 12000,
		});
		expect(buildMetaModels([{ ...base, contextWindow: 0, maxTokens: 0 }])[0]).toMatchObject({
			contextWindow: 1007997,
			maxTokens: 128000,
		});
	});
	it.each([undefined, { input: null, output: -1, cached: -1 }, { input: 0 }])(
		"prefers live metadata with baseline fallback for %j",
		async (partialCost) => {
			const provider = metaProvider();
			const base = provider.getModels()[0];
			vi.stubEnv("PI_META_CATALOG_REFRESH_INTERVAL_MS", "0");
			const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					data: [
						{
							id: base.id,
							metadata: {
								"muse-code": {
									tool_call: true,
									name: "Live name",
									reasoning: false,
									cost: { input: 2, output: 8, cached: 0.5 },
									limit: { context: 90000, output: 12000 },
								},
							},
						},
					],
				}),
			);
			await provider.refreshModels!({
				allowNetwork: true,
				credential: { type: "api_key", key: "test" },
				stored: { models: [base], checkedAt: Date.now() },
				signal: new AbortController().signal,
				publish: async (pub) => {
					pub.update?.();
					return true;
				},
			});
			expect(fetch).toHaveBeenCalledOnce();
			expect(provider.getModels().find((m) => m.id === base.id)).toMatchObject({
				name: "Live name",
				reasoning: false,
				cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 90000,
				maxTokens: 12000,
			});
			fetch.mockResolvedValue(
				Response.json({
					data: [{ id: base.id, metadata: { "muse-code": { tool_call: true, cost: partialCost } } }],
				}),
			);
			await provider.refreshModels!({
				allowNetwork: true,
				force: true,
				credential: { type: "api_key", key: "test" },
				signal: new AbortController().signal,
				publish: async (pub) => {
					pub.update?.();
					return true;
				},
			});
			expect(provider.getModels().find((m) => m.id === base.id)).toMatchObject({
				name: base.name,
				cost: { ...base.cost, ...(partialCost?.input === 0 ? { input: 0 } : {}) },
				reasoning: base.reasoning,
			});
		},
	);
});

describe("Meta conversation structure", () => {
	afterEach(() => vi.restoreAllMocks());
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const reasoning = (id: string) => ({ type: "reasoning", id, summary: [], encrypted_content: "enc" });
	const assistantText = (text: string, phase?: string) => ({
		type: "message",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
		status: "completed",
		id: `msg_${text.length}`,
		...(phase ? { phase } : {}),
	});
	const call = { type: "function_call", call_id: "call_1", name: "codemode", arguments: '{"code":"1"}' };
	const user = { role: "user", content: [{ type: "input_text", text: "next" }] };
	type Input = Parameters<typeof repairMetaConversationStructure>[0];

	async function payloadFor(messages: Parameters<typeof normalizeContext>[0]["messages"]) {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				'data: {"type":"response.completed","response":{"id":"done","status":"completed","output":[]}}\n\n',
			),
		);
		let payload: { input: Array<Record<string, unknown>> } | undefined;
		await streamOpenAIResponses(
			metaProvider().getModels()[0],
			normalizeContext({
				messages,
				tools: [
					{ name: "codemode", description: "Run JavaScript", parameters: Type.Object({ code: Type.String() }) },
				],
			}),
			{
				apiKey: "test",
				onPayload: (value) => {
					payload = value as typeof payload;
				},
			},
		).result();
		return payload!.input;
	}

	it("tags phase-less text before a call as commentary, through reasoning and other text", () => {
		const input = [user, assistantText("Checking."), reasoning("rs_1"), assistantText("Running it."), call] as Input;
		repairMetaConversationStructure(input);
		expect(input.map((item) => (item as { phase?: string }).phase)).toEqual([
			undefined,
			"commentary",
			undefined,
			"commentary",
			undefined,
		]);
	});

	it("leaves final text and existing phases alone", () => {
		const input = [assistantText("Done."), user, assistantText("Same model.", "final_answer"), call] as Input;
		repairMetaConversationStructure(input);
		expect((input[0] as { phase?: string }).phase).toBeUndefined();
		expect((input[2] as { phase?: string }).phase).toBe("final_answer");
	});

	it("closes a reasoning-only turn with a minimal assistant message before the next user message", () => {
		const input = [user, reasoning("rs_1"), reasoning("rs_2"), user] as Input;
		repairMetaConversationStructure(input);
		expect(input.map((item) => (item as { type?: string; role?: string }).type ?? "user")).toEqual([
			"user",
			"reasoning",
			"reasoning",
			"message",
			"user",
		]);
		expect(input[3]).toMatchObject({
			role: "assistant",
			phase: "final_answer",
			content: [{ type: "output_text", text: META_REASONING_ONLY_PLACEHOLDER }],
		});
	});

	it("does not touch reasoning already followed by text or a call", () => {
		const input = [reasoning("rs_1"), assistantText("Hi."), user, reasoning("rs_2"), call] as Input;
		repairMetaConversationStructure(input);
		expect(input).toHaveLength(5);
	});

	it("tags text from another model's codemode turn after a switch to Meta", async () => {
		const input = await payloadFor([
			{ role: "user", content: "Read the file.", timestamp: 1 },
			{
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				content: [
					{ type: "text", text: "Let me run that." },
					{ type: "toolCall", id: "toolu_1", name: "codemode", arguments: { code: "text(1)" } },
				],
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "codemode",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: 3,
			},
		]);
		const text = input.find((item) => item.type === "message" && item.role === "assistant");
		expect(text).toMatchObject({ phase: "commentary" });
		expect(input.findIndex((item) => item.type === "function_call")).toBeGreaterThan(input.indexOf(text!));
	});

	it("closes a same-model turn that hit the output limit during reasoning", async () => {
		const model = metaProvider().getModels()[0];
		const input = await payloadFor([
			{ role: "user", content: "Think hard.", timestamp: 1 },
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoning("rs_1")) }],
				usage: zeroUsage,
				stopReason: "length",
				timestamp: 2,
			},
			{ role: "user", content: "Continue.", timestamp: 3 },
		]);
		const at = input.findIndex((item) => item.type === "reasoning");
		expect(input[at + 1]).toMatchObject({ role: "assistant", content: [{ text: META_REASONING_ONLY_PLACEHOLDER }] });
		expect(input[at + 2]).toMatchObject({ role: "user" });
	});
});
