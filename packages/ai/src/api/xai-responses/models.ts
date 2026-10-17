import type { Model, OpenAIResponsesCompat } from "../../types.ts";

export const XAI_RESPONSES_API = "openai-responses" as const;
export const XAI_FAST_MODEL_ID = "grok-4.7-build-fast";
export const XAI_FAST_MODEL_NAME = "Grok 4.7 Fast";
export const XAI_500K_CONTEXT_WINDOW = 500_000;

const MODERN_GROK_IDS = new Set(["grok-4.6", "grok-4.7", XAI_FAST_MODEL_ID]);

export function isModernGrokModel(modelId: string): boolean {
	return MODERN_GROK_IDS.has(modelId) || modelId.startsWith("grok-4.6") || modelId.startsWith("grok-4.7");
}

export function resolveXaiCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	const modern = isModernGrokModel(model.id);
	return {
		supportsDeveloperRole: modern ? false : (model.compat?.supportsDeveloperRole ?? true),
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? "openai",
		supportsLongCacheRetention: false,
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

export function buildXaiModels(
	catalog: Record<string, Model<"openai-responses">> | readonly Model<"openai-responses">[],
): Model<"openai-responses">[] {
	const rawList = Array.isArray(catalog) ? catalog : Object.values(catalog);
	const models = rawList.map((model): Model<"openai-responses"> => {
		const modern = isModernGrokModel(model.id);
		return {
			...model,
			...(modern ? { contextWindow: XAI_500K_CONTEXT_WINDOW } : {}),
			compat: {
				...model.compat,
				supportsLongCacheRetention: false,
				supportsStrictMode: false,
				supportsOpenAIGrammarTools: false,
				...(modern ? { supportsDeveloperRole: false } : {}),
			},
		};
	});

	if (models.some((model) => model.id === XAI_FAST_MODEL_ID)) {
		return models;
	}

	const grok47 = models.find((model) => model.id === "grok-4.7");
	if (!grok47) {
		return models;
	}

	return [
		...models,
		{
			...grok47,
			id: XAI_FAST_MODEL_ID,
			name: XAI_FAST_MODEL_NAME,
			contextWindow: XAI_500K_CONTEXT_WINDOW,
			cost: {
				input: 4,
				output: 12,
				cacheRead: 1,
				cacheWrite: 0,
				tiers: [
					{
						inputTokensAbove: 200_000,
						input: 6,
						output: 18,
						cacheRead: 1.5,
						cacheWrite: 0,
					},
				],
			},
		},
	];
}
