import type { Model, OpenAIResponsesCompat, ThinkingLevelMap } from "../../src/types.ts";
import { addMissing, defineProvider, modelsDevModels } from "../define.ts";

const BASE_URL = "https://api.meta.ai/v1";
const META_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
	supportsStrictMode: true,
	supportsMidConvoSystemMessages: true,
	supportsToolSearch: true,
};
const FULL_EFFORT_MAP: ThinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
const EXTRA_MODELS: Model<"openai-responses">[] = [
	{
		id: "muse-wonder-1.0-contributor",
		name: "Muse Wonder Contributor",
		api: "openai-responses",
		provider: "meta",
		baseUrl: BASE_URL,
		compat: { ...META_RESPONSES_COMPAT },
		reasoning: true,
		thinkingLevelMap: { ...FULL_EFFORT_MAP },
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1007997,
		maxTokens: 128000,
	},
	{
		id: "muse-wonder-full-1.0",
		name: "Muse Wonder Full",
		api: "openai-responses",
		provider: "meta",
		baseUrl: BASE_URL,
		compat: { ...META_RESPONSES_COMPAT },
		reasoning: true,
		thinkingLevelMap: { ...FULL_EFFORT_MAP },
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1007997,
		maxTokens: 128000,
	},
	{
		id: "muse-wonder-full-1.0-contributor",
		name: "Muse Wonder Full Contributor",
		api: "openai-responses",
		provider: "meta",
		baseUrl: BASE_URL,
		compat: { ...META_RESPONSES_COMPAT },
		reasoning: true,
		thinkingLevelMap: { ...FULL_EFFORT_MAP },
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1007997,
		maxTokens: 128000,
	},
];

export default defineProvider({
	id: "meta",
	models: (ctx) =>
		addMissing(
			modelsDevModels(ctx, "meta", {
				api: "openai-responses",
				baseUrl: BASE_URL,
				compat: META_RESPONSES_COMPAT,
				defaultContextWindow: 1007997,
				defaultMaxTokens: 128000,
				map: (model) => {
					if (model.id === "muse-spark-1.3-contributor") model.thinkingLevelMap = { ...FULL_EFFORT_MAP };
					return model;
				},
			}),
			structuredClone(EXTRA_MODELS),
		),
});
