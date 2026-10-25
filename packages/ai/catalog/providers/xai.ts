import { withXaiUnlistedModels } from "../../scripts/native-providers.ts";
import { defineProvider, mergeThinking, modelsDevModels } from "../define.ts";

// Retired or unsuitable for pi's built-in catalog.
const EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-build-0.1",
	"grok-code-fast-1",
]);

export default defineProvider({
	id: "xai",
	models: (ctx) => {
		const xai = ctx.sources.modelsDev.xai;
		const sources = xai?.models
			? {
					...ctx.sources,
					modelsDev: {
						...ctx.sources.modelsDev,
						xai: { ...xai, models: withXaiUnlistedModels(xai.models) },
					},
				}
			: ctx.sources;
		return modelsDevModels({ ...ctx, sources }, "xai", {
			api: "openai-responses",
			baseUrl: "https://api.x.ai/v1",
			compat: { supportsLongCacheRetention: false },
			include: (source) => !EXCLUDED_MODEL_IDS.has(source.id),
		});
	},
	finalize: (model) => {
		// Models without verified effort options must not send the undocumented
		// "none"/"minimal" efforts.
		if (model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
			mergeThinking(model, { off: null, minimal: null });
		}
	},
});
