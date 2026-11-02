import { expect, it } from "vitest";
import { buildCatalog } from "../catalog/build.ts";
import { PROVIDERS } from "../catalog/providers/index.ts";
import type { CatalogSources } from "../catalog/sources/index.ts";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import type { Api, Model } from "../src/types.ts";

function sourceModel(id: string, context: number, output: number): ModelsDevV2Model {
	return {
		id,
		type: "chat",
		name: id,
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		limit: { context, output },
		api: { responses: { base_url: "https://example.test/v1" } },
	};
}

it.each([true, false])("generates upstream OpenAI limits and Meta catalog limits (listed=%s)", (listed) => {
	const ids = [
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
	];
	const sources: CatalogSources = {
		modelsDev: {
			openai: {
				models: listed ? Object.fromEntries(ids.map((id) => [id, sourceModel(id, 1000000, 128000)])) : {},
			},
			meta: { models: { "muse-custom": sourceModel("muse-custom", 90000, 12000) } },
		},
		modelsDevDecisions: {},
		openRouter: { chat: [], images: [], classifiers: [] },
		aiGateway: { chat: [], classifiers: [] },
		nvidiaModelIds: new Map(),
		radius: [],
	};
	const catalogs = buildCatalog(PROVIDERS, sources, false);
	const read = (provider: string) =>
		Object.fromEntries(catalogs[provider].chat.map((model) => [model.id, model])) as Record<string, Model<Api>>;
	for (const id of ids) {
		expect(read("openai")[id].contextWindow, id).toBe(272000);
		expect(read("openai-codex")[id].contextWindow, id).toBe(id === "gpt-6.1-sol" ? 500000 : 272000);
	}
	expect(read("meta")["muse-custom"]).toMatchObject({ contextWindow: 90000, maxTokens: 12000 });
});
