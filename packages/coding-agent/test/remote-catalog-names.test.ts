import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { withPersonalizedCatalog, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

function model(id: string, name: string, contextWindow = 1000): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 100,
	};
}

function builtinProvider(): Provider {
	return createProvider({
		id: "test-provider",
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: [model("named", "Named Model"), model("renamed", "Old Name")],
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

async function refresh(provider: Provider): Promise<void> {
	const store = new InMemoryModelsStore();
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: true,
		signal: new AbortController().signal,
	});
}

afterEach(() => vi.restoreAllMocks());

it.each([
	["remote", (provider: Provider) => withRemoteCatalog(provider, "https://pi.dev")],
	[
		"personalized",
		(provider: Provider) => withPersonalizedCatalog(provider, async (catalog) => catalog, "https://pi.dev"),
	],
])("a %s catalog name that only repeats the ID keeps the built-in name", async (_kind, wrap) => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
		Response.json({
			named: model("named", "named", 2000),
			renamed: model("renamed", "New Name"),
			bare: model("bare", "bare"),
		}),
	);
	const provider = wrap(builtinProvider());
	await refresh(provider);

	const byId = new Map(provider.getModels().map((entry) => [entry.id, entry]));
	// The remote entry still wins for everything but a name that only repeats the ID.
	expect(byId.get("named")).toMatchObject({ name: "Named Model", contextWindow: 2000 });
	expect(byId.get("renamed")?.name).toBe("New Name");
	expect(byId.get("bare")?.name).toBe("bare");
});
