import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadMetaOAuth } from "../auth/oauth/load.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { Model, ModelCost, OpenAIResponsesCompat, ThinkingLevelMap } from "../types.ts";
import { META_MODELS } from "./meta.models.ts";

const DEFAULT_META_BASE_URL = "https://api.meta.ai/v1";
const DEFAULT_META_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const META_CONTEXT_WINDOW = 1_007_997;
export const META_MAX_TOKENS = 128_000;

export const META_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
	"x-api-version": "1.0.0",
	"x-client-id": "tbh:tui",
};

export const META_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
	supportsStrictMode: true,
	supportsMidConvoSystemMessages: true,
	supportsToolSearch: true,
};

const DEFAULT_META_INPUT_LIMITS: NonNullable<Model<"openai-responses">["inputLimits"]> = {
	images: {
		resize: {
			maxWidth: 2000,
			maxHeight: 2000,
			maxBytes: 4718592,
			jpegQuality: 80,
		},
	},
};

const META_FULL_EFFORT_MAP: ThinkingLevelMap = {
	off: null,
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

const META_SPARK_COST: ModelCost = { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 };
const META_WONDER_COST: ModelCost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 };
const META_CONTRIBUTOR_COST: ModelCost = { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 };

const EXTRA_META_MODELS: ReadonlyArray<{ id: string; name: string; cost: ModelCost }> = [
	{ id: "muse-wonder-1.0-contributor", name: "Muse Wonder Contributor", cost: META_CONTRIBUTOR_COST },
	{ id: "muse-wonder-full-1.0", name: "Muse Wonder Full", cost: META_WONDER_COST },
	{ id: "muse-wonder-full-1.0-contributor", name: "Muse Wonder Full Contributor", cost: META_CONTRIBUTOR_COST },
];

export function buildMetaModels(
	catalog: Record<string, Model<"openai-responses">> | readonly Model<"openai-responses">[],
): Model<"openai-responses">[] {
	const rawList = Array.isArray(catalog) ? catalog : Object.values(catalog);
	const models = rawList.map((model): Model<"openai-responses"> => {
		const isFullEffort = model.id.startsWith("muse-spark-1.3") || model.id.startsWith("muse-wonder");
		return {
			...model,
			contextWindow: META_CONTEXT_WINDOW,
			maxTokens: META_MAX_TOKENS,
			thinkingLevelMap: isFullEffort ? { ...META_FULL_EFFORT_MAP } : model.thinkingLevelMap,
			compat: { ...META_RESPONSES_COMPAT, ...model.compat },
			inputLimits: model.inputLimits ?? DEFAULT_META_INPUT_LIMITS,
		};
	});

	for (const extra of EXTRA_META_MODELS) {
		if (!models.some((model) => model.id === extra.id)) {
			models.push({
				type: "chat",
				id: extra.id,
				name: extra.name,
				api: "openai-responses",
				provider: "meta",
				baseUrl: DEFAULT_META_BASE_URL,
				reasoning: true,
				input: ["text", "image"],
				cost: { ...extra.cost },
				contextWindow: META_CONTEXT_WINDOW,
				maxTokens: META_MAX_TOKENS,
				thinkingLevelMap: { ...META_FULL_EFFORT_MAP },
				compat: { ...META_RESPONSES_COMPAT },
				inputLimits: DEFAULT_META_INPUT_LIMITS,
			});
		}
	}

	return models;
}

interface MuseCodeModelMetadata {
	name?: string;
	is_hidden?: boolean;
	reasoning?: boolean;
	tool_call?: boolean;
	cost?: { input?: number; output?: number; cached?: number } | null;
	limit?: { context?: number; output?: number } | null;
	modalities?: { input?: string[]; output?: string[] } | null;
	variants?: Record<string, unknown> | null;
}

interface MuseCodeCatalogRow {
	id?: string;
	metadata?: {
		"muse-code"?: MuseCodeModelMetadata;
	};
}

function resolveCatalogUrl(baseUrl: string | undefined): string {
	const raw = (baseUrl || DEFAULT_META_BASE_URL).trim().replace(/\/+$/, "");
	const origin = raw.endsWith("/v1") ? raw.slice(0, -3) : raw;
	return `${origin}/muse-code/models`;
}

function humanizeMetaModelId(id: string): string {
	return id
		.split("-")
		.map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function inferMetaCost(id: string, rawCost: MuseCodeModelMetadata["cost"]): ModelCost {
	if (
		rawCost &&
		typeof rawCost.input === "number" &&
		Number.isFinite(rawCost.input) &&
		typeof rawCost.output === "number" &&
		Number.isFinite(rawCost.output)
	) {
		return {
			input: rawCost.input,
			output: rawCost.output,
			cacheRead: typeof rawCost.cached === "number" && Number.isFinite(rawCost.cached) ? rawCost.cached : 0,
			cacheWrite: 0,
		};
	}
	if (id.endsWith("-contributor")) return { ...META_CONTRIBUTOR_COST };
	if (id.includes("wonder")) return { ...META_WONDER_COST };
	return { ...META_SPARK_COST };
}

function buildMetaThinkingLevelMap(
	variants: Record<string, unknown> | null | undefined,
	fallback: ThinkingLevelMap | undefined,
): ThinkingLevelMap {
	if (!variants || typeof variants !== "object") {
		return fallback ?? { ...META_FULL_EFFORT_MAP };
	}
	const supported = new Set(Object.keys(variants));
	return {
		off: null,
		minimal: supported.has("minimal") ? "minimal" : null,
		low: supported.has("low") ? "low" : null,
		medium: supported.has("medium") ? "medium" : null,
		high: supported.has("high") ? "high" : null,
		xhigh: supported.has("xhigh") ? "xhigh" : null,
		max: supported.has("max") ? "max" : null,
	};
}

function mergeWithBaseline(
	baselineById: ReadonlyMap<string, Model<"openai-responses">>,
	models: readonly Model<"openai-responses">[],
): Model<"openai-responses">[] {
	const merged = new Map<string, Model<"openai-responses">>(baselineById);
	for (const model of models) {
		const base = baselineById.get(model.id);
		if (base) {
			merged.set(model.id, {
				...model,
				name: base.name,
				cost: base.cost,
				contextWindow: model.contextWindow || base.contextWindow,
				maxTokens: model.maxTokens || base.maxTokens,
				reasoning: base.reasoning,
				thinkingLevelMap: model.thinkingLevelMap ?? base.thinkingLevelMap,
				compat: { ...META_RESPONSES_COMPAT, ...base.compat, ...model.compat },
				inputLimits: model.inputLimits ?? base.inputLimits,
			});
		} else {
			merged.set(model.id, {
				...model,
				compat: { ...META_RESPONSES_COMPAT, ...model.compat },
				inputLimits: model.inputLimits ?? DEFAULT_META_INPUT_LIMITS,
			});
		}
	}
	return [...merged.values()];
}

export function metaProvider(): Provider<"openai-responses"> {
	const baseline = buildMetaModels(META_MODELS);
	const baselineById = new Map(baseline.map((model) => [model.id, model]));
	let models: Model<"openai-responses">[] = [...baseline];

	const provider = createProvider({
		id: "meta",
		name: "Meta",
		baseUrl: DEFAULT_META_BASE_URL,
		headers: { ...META_DEFAULT_HEADERS },
		auth: {
			apiKey: envApiKeyAuth("Meta Model API key", ["META_API_KEY"]),
			oauth: lazyOAuth({
				name: "Meta (Muse subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Meta",
				load: loadMetaOAuth,
			}),
		},
		models: baseline,
		api: openAIResponsesApi(),
	});

	return {
		...provider,
		getModels: () => models,
		getAllModels: () => models,
		async refreshModels(context) {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-responses"> =>
						model.provider === "meta" && isModelType(model, "chat") && model.api === "openai-responses",
				);
				if (restored.length > 0) {
					const next = mergeWithBaseline(baselineById, restored);
					if (
						!(await context.publish({
							update: () => {
								models = next;
							},
						}))
					) {
						return;
					}
				}
			}

			if (!context.allowNetwork || !context.credential || context.signal.aborted) return;
			const apiKey = context.credential.type === "oauth" ? context.credential.access : context.credential.key;
			if (!apiKey) return;

			const configuredInterval = Number.parseInt(process.env.PI_META_CATALOG_REFRESH_INTERVAL_MS ?? "", 10);
			const refreshInterval =
				Number.isFinite(configuredInterval) && configuredInterval >= 0
					? configuredInterval
					: DEFAULT_META_REFRESH_INTERVAL_MS;
			const checkedAt = context.stored?.checkedAt ?? 0;
			const now = Date.now();
			if (!context.force && checkedAt > 0 && now >= checkedAt && now - checkedAt < refreshInterval) return;

			const baseUrl = context.baseUrl ?? DEFAULT_META_BASE_URL;
			let response: Response;
			try {
				response = await fetch(resolveCatalogUrl(baseUrl), {
					method: "GET",
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`,
						...META_DEFAULT_HEADERS,
					},
					signal: AbortSignal.any([AbortSignal.timeout(15_000), context.signal]),
				});
			} catch {
				return;
			}
			if (!response.ok || context.signal.aborted) return;

			let payload: { data?: MuseCodeCatalogRow[] } | null = null;
			try {
				payload = (await response.json()) as { data?: MuseCodeCatalogRow[] };
			} catch {
				return;
			}
			if (!Array.isArray(payload?.data) || payload.data.length === 0) return;

			const discovered: Model<"openai-responses">[] = [];
			for (const row of payload.data) {
				const id = typeof row?.id === "string" ? row.id.trim() : "";
				if (!id) continue;
				const mc = row.metadata?.["muse-code"];
				if (!mc || mc.is_hidden === true || mc.tool_call !== true) continue;
				const base = baselineById.get(id);
				const inputModalities = mc.modalities?.input;
				const supportsImage = Array.isArray(inputModalities)
					? inputModalities.includes("image")
					: (base?.input.includes("image") ?? true);
				discovered.push({
					type: "chat",
					id,
					name: base?.name ?? (mc.name && mc.name !== id ? mc.name : humanizeMetaModelId(id)),
					api: "openai-responses",
					provider: "meta",
					baseUrl,
					reasoning: mc.reasoning ?? base?.reasoning ?? true,
					input: supportsImage ? ["text", "image"] : ["text"],
					cost: base?.cost ?? inferMetaCost(id, mc.cost),
					contextWindow: mc.limit?.context ?? base?.contextWindow ?? META_CONTEXT_WINDOW,
					maxTokens: mc.limit?.output ?? base?.maxTokens ?? META_MAX_TOKENS,
					thinkingLevelMap: buildMetaThinkingLevelMap(mc.variants, base?.thinkingLevelMap),
					compat: { ...META_RESPONSES_COMPAT, ...base?.compat },
					inputLimits: base?.inputLimits ?? DEFAULT_META_INPUT_LIMITS,
				});
			}

			if (discovered.length === 0 || context.signal.aborted) return;
			const next = mergeWithBaseline(baselineById, discovered);
			await context.publish({
				persist: { models: next, checkedAt: Date.now() },
				update: () => {
					models = next;
				},
			});
		},
	};
}
