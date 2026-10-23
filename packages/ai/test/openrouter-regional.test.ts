import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, RefreshModelsContext } from "../src/models.ts";
import { addGenericEndpointProviders } from "../src/providers/generic-endpoint.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";
import { isOpenRouterRegionalBaseUrl } from "../src/providers/openrouter-regional.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const US = "https://us.openrouter.ai/api/v1";

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

function regional(source: Provider = openrouterProvider()): Provider {
	const providers = new Map<string, Provider>([["openrouter", source]]);
	addGenericEndpointProviders(providers, {
		getProviderIds: () => ["openrouter-us"],
		getProvider: () => ({ name: "OpenRouter (US)", baseUrl: US }),
	});
	const provider = providers.get("openrouter-us");
	if (!provider) throw new Error("openrouter-us not registered");
	return provider;
}

afterEach(() => vi.restoreAllMocks());

describe("OpenRouter in-region providers", () => {
	it("recognizes only regional OpenRouter hosts", () => {
		expect(isOpenRouterRegionalBaseUrl(US)).toBe(true);
		expect(isOpenRouterRegionalBaseUrl("https://eu.openrouter.ai/api/v1")).toBe(true);
		expect(isOpenRouterRegionalBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
		expect(isOpenRouterRegionalBaseUrl("https://us.openrouter.ai.evil.com/api/v1")).toBe(false);
		expect(isOpenRouterRegionalBaseUrl("not a url")).toBe(false);
	});

	it("lists the regional host's models with their own protocols and regional base URLs", async () => {
		const source = openrouterProvider();
		const anthropic = source.getModels().find((model) => model.api === "anthropic-messages");
		const openai = source.getModels().find((model) => model.api === "openai-completions");
		if (!anthropic || !openai) throw new Error("catalog lacks an anthropic-messages or openai-completions model");
		const requests: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			requests.push(String(input));
			return Response.json({ data: [{ id: anthropic.id }, { id: openai.id }] });
		});

		const provider = regional(source);
		expect(provider.getModels()).toEqual([]);
		await provider.refreshModels?.(refreshContext({ baseUrl: US }));

		expect(requests).toEqual([`${US}/models/user`]);
		const listed = provider.getModels();
		expect(listed.map((model) => model.id)).toEqual([anthropic.id, openai.id]);
		expect(listed.every((model) => model.provider === "openrouter-us")).toBe(true);
		expect(listed.find((model) => model.id === anthropic.id)).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://us.openrouter.ai/api",
		});
		expect(listed.find((model) => model.id === openai.id)).toMatchObject({ api: "openai-completions", baseUrl: US });
	});

	it("keeps the stored list when the regional host rejects the key", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }));
		const provider = regional();
		await expect(provider.refreshModels?.(refreshContext({ baseUrl: US }))).rejects.toThrow(/rejected the key/);
		expect(provider.getModels()).toEqual([]);
	});

	it("sends Anthropic Messages requests to /api even when models.json forces the /api/v1 base", () => {
		const source = openrouterProvider();
		const seen: string[] = [];
		const spy = {
			...source,
			streamSimple: (model: Model<any>) => {
				seen.push(model.baseUrl);
				return undefined as never;
			},
		};
		const provider = regional(spy);
		const anthropic = source.getModels().find((model) => model.api === "anthropic-messages")!;
		const openai = source.getModels().find((model) => model.api === "openai-completions")!;
		provider.streamSimple({ ...anthropic, baseUrl: US }, normalizeContext({ messages: [] }));
		provider.streamSimple({ ...openai, baseUrl: US }, normalizeContext({ messages: [] }));
		expect(seen).toEqual(["https://us.openrouter.ai/api", US]);
	});
});
