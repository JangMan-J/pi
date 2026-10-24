import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { Provider, RefreshModelsContext } from "../src/models.ts";
import type { ModelsStoreEntry } from "../src/models-store.ts";
import {
	addGenericEndpointProviders,
	type GenericEndpointConfig,
	genericEndpointProvider,
} from "../src/providers/generic-endpoint.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface RecordedRequest {
	url: string;
	headers: Record<string, string>;
}

function stubFetch(handler: (url: string) => Response): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		return handler(url);
	});
	return requests;
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "test-key" },
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal: new AbortController().signal,
		...overrides,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("genericEndpointProvider", () => {
	it("discovers OpenAI-responses models, mapping rich fields and defaulting bare ids", async () => {
		const requests = stubFetch(() =>
			Response.json({
				data: [
					{
						id: "rich-model",
						display_name: "Rich Model",
						input_modalities: ["text", "image"],
						output_modalities: ["text"],
						context_length: 262_144,
						max_output_length: 131_072,
						pricing: { prompt: "0.000001", completion: "0.000003", input_cache_read: "0.0000001" },
						supported_features: ["tools", "reasoning"],
						access: { available: true },
					},
					{ id: "bare-model" },
					{ id: "bare-model" },
					{ id: "locked-model", access: { available: false } },
					{ id: "image-out-model", output_modalities: ["image"] },
				],
			}),
		);
		const provider = genericEndpointProvider({
			id: "abliteration",
			api: "openai-responses",
			baseUrl: "https://api.example.test/v1/",
		});

		await provider.refreshModels!(refreshContext({ baseUrl: "https://api.example.test/v1/" }));

		expect(requests).toEqual([
			{
				url: "https://api.example.test/v1/models",
				headers: { accept: "application/json", authorization: "Bearer test-key" },
			},
		]);
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["rich-model", "bare-model"]);
		expect(models[0]).toMatchObject({
			name: "Rich Model",
			api: "openai-responses",
			provider: "abliteration",
			baseUrl: "https://api.example.test/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: 131_072,
		});
		expect(models[1]).toMatchObject({
			name: "bare-model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
	});

	it("discovers Anthropic models with x-api-key auth and cursor pagination", async () => {
		const requests = stubFetch((url) =>
			url.includes("after_id=m1")
				? Response.json({ data: [{ id: "m2", display_name: "Model 2" }], has_more: false })
				: Response.json({
						data: [{ id: "m1", display_name: "Model 1", max_input_tokens: 200_000, max_tokens: 64_000 }],
						has_more: true,
					}),
		);
		const provider = genericEndpointProvider({
			id: "anthropic-gateway",
			api: "anthropic-messages",
			baseUrl: "https://gateway.example.test",
		});

		await provider.refreshModels!(refreshContext({ baseUrl: "https://gateway.example.test" }));

		expect(requests.map((request) => request.url)).toEqual([
			"https://gateway.example.test/v1/models?limit=1000",
			"https://gateway.example.test/v1/models?limit=1000&after_id=m1",
		]);
		expect(requests[0].headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["m1", "m2"]);
		expect(models[0]).toMatchObject({
			name: "Model 1",
			api: "anthropic-messages",
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	});

	it("discovers Google models, stripping the models/ prefix and skipping non-chat methods", async () => {
		const requests = stubFetch(() =>
			Response.json({
				models: [
					{
						name: "models/gemini-example",
						displayName: "Gemini Example",
						inputTokenLimit: 1_048_576,
						outputTokenLimit: 65_536,
						supportedGenerationMethods: ["generateContent"],
						thinking: true,
					},
					{ name: "models/embed-example", supportedGenerationMethods: ["embedContent"] },
				],
			}),
		);
		const provider = genericEndpointProvider({
			id: "google-gateway",
			api: "google-generative-ai",
			baseUrl: "https://gateway.example.test/v1beta",
		});

		await provider.refreshModels!(refreshContext({ baseUrl: "https://gateway.example.test/v1beta" }));

		expect(requests[0].url).toBe("https://gateway.example.test/v1beta/models?pageSize=1000");
		expect(requests[0].headers).toMatchObject({ "x-goog-api-key": "test-key" });
		expect(provider.getModels()).toMatchObject([
			{
				id: "gemini-example",
				name: "Gemini Example",
				input: ["text", "image"],
				reasoning: true,
				contextWindow: 1_048_576,
				maxTokens: 65_536,
			},
		]);
	});

	it("keeps restored stored models when the model list request fails", async () => {
		stubFetch(() => new Response("", { status: 401 }));
		const storedModel: Model<"openai-completions"> = {
			id: "cached-model",
			name: "Cached Model",
			api: "openai-completions",
			provider: "local",
			baseUrl: "http://localhost:11434/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 8_192,
		};
		const stored: ModelsStoreEntry = { models: [storedModel], checkedAt: Date.now() };
		const provider = genericEndpointProvider({
			id: "local",
			api: "openai-completions",
			baseUrl: "http://localhost:11434/v1",
		});

		await expect(provider.refreshModels!(refreshContext({ stored }))).rejects.toThrow("401");
		expect(provider.getModels().map((model) => model.id)).toEqual(["cached-model"]);
	});
});

describe("addGenericEndpointProviders", () => {
	it("registers only empty, supported, non-builtin endpoint entries", () => {
		const configs: Record<string, GenericEndpointConfig> = {
			abliteration: { api: "openai-responses", baseUrl: "https://api.abliteration.ai/v1" },
			ollama: { api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: [] },
			openai: { api: "openai-responses", baseUrl: "https://proxy.example.test/v1" },
			explicit: { api: "openai-completions", baseUrl: "https://x.example.test/v1", models: [{ id: "hand" }] },
			radiusGateway: { oauth: "radius", baseUrl: "https://gateway.example.test" },
			unsupported: { api: "bedrock-converse-stream", baseUrl: "https://bedrock.example.test" },
			noBase: { api: "openai-completions" },
		};
		const builtin = genericEndpointProvider({
			id: "openai",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
		});
		const providers = new Map<string, Provider>([["openai", builtin as Provider]]);

		addGenericEndpointProviders(providers, {
			getProviderIds: () => Object.keys(configs),
			getProvider: (providerId) => configs[providerId],
		});

		expect([...providers.keys()].sort()).toEqual(["abliteration", "ollama", "openai"]);
		expect(providers.get("openai")).toBe(builtin);
		expect(providers.get("abliteration")).toMatchObject({
			id: "abliteration",
			baseUrl: "https://api.abliteration.ai/v1",
		});
	});
});

describe("generic endpoint compatibility defaults", () => {
	it("discovers bare completions models with conservative compatibility", async () => {
		stubFetch(() => Response.json({ data: [{ id: "text-model" }] }));
		const provider = genericEndpointProvider({
			id: "local",
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
		});
		await provider.refreshModels!(refreshContext());
		expect(provider.getModels()[0]).toMatchObject({
			reasoning: false,
			input: ["text"],
			compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
		});
		let payload: Record<string, unknown> | undefined;
		await streamCompletions(
			provider.getModels()[0] as Model<"openai-completions">,
			normalizeContext({ systemPrompt: "System", messages: [{ role: "user", content: "Hi", timestamp: 0 }] }),
			{
				apiKey: "test",
				maxTokens: 42,
				onPayload: (value) => {
					payload = JSON.parse(JSON.stringify(value));
					throw new Error("captured");
				},
			},
		).result();
		expect(payload).toMatchObject({
			model: "text-model",
			max_tokens: 42,
			messages: [
				{ role: "system", content: "System" },
				{ role: "user", content: "Hi" },
			],
		});
		expect(payload).not.toHaveProperty("store");
		expect(payload).not.toHaveProperty("max_completion_tokens");
	});
});
