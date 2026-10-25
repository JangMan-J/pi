// Catalog corrections for providers that have no fork branch of their own (owned by feat/native-providers).
// Kept apart from generate-models.ts so the corrections can be tested without running the generator.

/** Display names for Kimi Coding models whose models.dev name is missing or only repeats the ID. */
const KIMI_CODING_NAMES: Record<string, string> = {
	// models.dev names this model "kimi-for-coding". Kimi upgrades the model behind this ID in place,
	// so the name follows its sibling "Kimi For Coding HighSpeed" rather than a model version.
	"kimi-for-coding": "Kimi For Coding",
};

/** The display name for a Kimi Coding model, given the name models.dev reports for it. */
export function kimiCodingModelName(id: string, sourceName: string | undefined): string {
	if (sourceName && sourceName !== id) return sourceName;
	return KIMI_CODING_NAMES[id] ?? id;
}

/**
 * xAI serves these IDs on /v1/responses but lists them neither in /v1/models nor on models.dev.
 * Each copies the models.dev entry of its base model under its own ID and name.
 * Probed 2026-10-25 with xAI OAuth: POST /v1/responses with model "grok-4.7-build-fast" returned 200
 * and echoed that model ID; GET /v1/models did not list it.
 */
const XAI_UNLISTED_MODELS: Record<string, { base: string; name: string }> = {
	"grok-4.7-build-fast": { base: "grok-4.7", name: "Grok 4.7 Fast" },
};

/** The models.dev xAI models plus each unlisted model whose base model is present. */
export function withXaiUnlistedModels<T extends object>(models: Record<string, T>): Record<string, T> {
	const result = { ...models };
	for (const [id, { base, name }] of Object.entries(XAI_UNLISTED_MODELS)) {
		const baseModel = models[base];
		if (baseModel === undefined || id in models) continue;
		result[id] = { ...baseModel, id, name };
	}
	return result;
}
