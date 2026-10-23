import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ProviderStreams } from "../types.ts";
import { type OpenRouterPricing, openRouterCost } from "./openrouter-api.ts";
import { isOpenRouterRegionalBaseUrl, openRouterRegionalProvider } from "./openrouter-regional.ts";

/**
 * Protocols with a standard `GET /models` list endpoint that pi can discover
 * models from. The discovery URL and auth header follow the same convention
 * the protocol's stream implementation uses for `baseUrl`:
 *
 * - OpenAI Completions/Responses: `GET {baseUrl}/models`, `Authorization: Bearer`
 *   (`baseUrl` includes the version prefix, e.g. `https://host/v1`).
 * - Anthropic Messages: `GET {baseUrl}/v1/models`, `x-api-key`
 *   (`baseUrl` has no version prefix, matching the Anthropic SDK).
 * - Google Generative AI: `GET {baseUrl}/models`, `x-goog-api-key`
 *   (`baseUrl` includes the version prefix, e.g. `.../v1beta`).
 */
export type GenericEndpointApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export const GENERIC_ENDPOINT_APIS: readonly GenericEndpointApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
];

export function isGenericEndpointApi(api: string | undefined): api is GenericEndpointApi {
	return api !== undefined && (GENERIC_ENDPOINT_APIS as readonly string[]).includes(api);
}

export interface GenericEndpointProviderOptions {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	api: GenericEndpointApi;
	baseUrl: string;
	/** Environment variables consulted for an API key after a stored credential. Default: none. */
	envVars?: readonly string[];
}

const GENERIC_MODELS_TIMEOUT_MS = 15_000;
// Same fallbacks models.json model definitions use when an endpoint does not
// advertise limits (the plain OpenAI `/models` shape carries only an id).
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function streamsFor(api: GenericEndpointApi): ProviderStreams {
	switch (api) {
		case "openai-completions":
			return openAICompletionsApi();
		case "openai-responses":
			return openAIResponsesApi();
		case "anthropic-messages":
			return anthropicMessagesApi();
		case "google-generative-ai":
			return googleGenerativeAIApi();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(entry: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = entry[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function positiveNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function modalities(entry: Record<string, unknown>, kind: "input" | "output"): string[] | undefined {
	const direct = stringList(entry[`${kind}_modalities`]);
	if (direct.length > 0) return direct;
	const architecture = isRecord(entry.architecture) ? entry.architecture : undefined;
	const nested = architecture ? stringList(architecture[`${kind}_modalities`]) : [];
	if (nested.length > 0) return nested;
	// OpenRouter also encodes modalities as one string, e.g. "text+image->text".
	const modality = architecture && typeof architecture.modality === "string" ? architecture.modality : undefined;
	if (modality?.includes("->")) {
		const [input, output] = modality.split("->");
		return (kind === "input" ? input : output).split("+").filter(Boolean);
	}
	return undefined;
}

function supportsReasoning(entry: Record<string, unknown>): boolean {
	if (entry.reasoning === true || entry.thinking === true) return true;
	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
	const thinking = capabilities && isRecord(capabilities.thinking) ? capabilities.thinking : undefined;
	if (thinking?.supported === true) return true;
	const advertised = [...stringList(entry.supported_features), ...stringList(entry.supported_parameters)];
	return advertised.includes("reasoning") || advertised.includes("include_reasoning");
}

function inputModalities(entry: Record<string, unknown>): ("text" | "image")[] {
	const capabilities = isRecord(entry.capabilities) ? entry.capabilities : undefined;
	const imageInput = capabilities && isRecord(capabilities.image_input) ? capabilities.image_input : undefined;
	if (imageInput?.supported === true) return ["text", "image"];
	const known = (modalities(entry, "input") ?? []).filter(
		(modality): modality is "text" | "image" => modality === "text" || modality === "image",
	);
	return known.length > 0 ? known : ["text"];
}

/** Map one OpenAI/Anthropic-dialect `/models` entry. Extra OpenRouter-style fields are used when present. */
function modelFromListEntry(
	providerId: string,
	api: GenericEndpointApi,
	baseUrl: string,
	entry: Record<string, unknown>,
): Model<GenericEndpointApi> | undefined {
	const id = stringField(entry, "id");
	if (!id) return undefined;
	const access = isRecord(entry.access) ? entry.access : undefined;
	if (access?.available === false) return undefined;
	const output = modalities(entry, "output");
	if (output && !output.includes("text")) return undefined;
	const topProvider = isRecord(entry.top_provider) ? entry.top_provider : undefined;
	const pricing = isRecord(entry.pricing) ? (entry.pricing as OpenRouterPricing) : undefined;
	return {
		id,
		name: stringField(entry, "display_name", "displayName", "name") ?? id,
		api,
		provider: providerId,
		baseUrl,
		reasoning: supportsReasoning(entry),
		input: inputModalities(entry),
		cost: pricing ? openRouterCost(pricing) : { ...ZERO_COST },
		contextWindow:
			positiveNumber(
				topProvider?.context_length,
				entry.context_length,
				entry.max_input_tokens,
				entry.contextWindow,
			) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens:
			positiveNumber(
				entry.max_output_length,
				entry.max_completion_tokens,
				topProvider?.max_completion_tokens,
				entry.max_tokens,
				entry.maxTokens,
			) ?? DEFAULT_MAX_TOKENS,
	};
}

/** Map one Google-dialect `/models` entry (`name: "models/<id>"`). */
function googleModelFromListEntry(
	providerId: string,
	baseUrl: string,
	entry: Record<string, unknown>,
): Model<"google-generative-ai"> | undefined {
	const name = stringField(entry, "name");
	if (!name) return undefined;
	const methods = stringList(entry.supportedGenerationMethods);
	if (methods.length > 0 && !methods.includes("generateContent")) return undefined;
	const id = name.startsWith("models/") ? name.slice("models/".length) : name;
	return {
		id,
		name: stringField(entry, "displayName", "display_name") ?? id,
		api: "google-generative-ai",
		provider: providerId,
		baseUrl,
		reasoning: entry.thinking === true,
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: positiveNumber(entry.inputTokenLimit) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: positiveNumber(entry.outputTokenLimit) ?? DEFAULT_MAX_TOKENS,
	};
}

function listEntries(body: unknown, key: "data" | "models"): Record<string, unknown>[] {
	const entries = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body[key]) ? body[key] : undefined;
	if (!entries) throw new Error(`Invalid model list response: expected an array or "${key}" array`);
	return entries.filter(isRecord);
}

async function fetchJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		headers: { accept: "application/json", ...headers },
		signal: AbortSignal.any([signal, AbortSignal.timeout(GENERIC_MODELS_TIMEOUT_MS)]),
	});
	if (!response.ok) throw new Error(`Model list request failed: ${response.status} ${url}`);
	return response.json();
}

async function fetchGenericModels(
	options: GenericEndpointProviderOptions,
	context: RefreshModelsContext,
): Promise<Model<GenericEndpointApi>[]> {
	const baseUrl = (context.baseUrl ?? options.baseUrl).replace(/\/+$/, "");
	const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	const models: Model<GenericEndpointApi>[] = [];
	const seen = new Set<string>();
	const push = (model: Model<GenericEndpointApi> | undefined) => {
		if (model && !seen.has(model.id)) {
			seen.add(model.id);
			models.push(model);
		}
	};

	if (options.api === "google-generative-ai") {
		let pageToken: string | undefined;
		do {
			const url = new URL(`${baseUrl}/models`);
			url.searchParams.set("pageSize", "1000");
			if (pageToken) url.searchParams.set("pageToken", pageToken);
			const body = await fetchJson(url.toString(), key ? { "x-goog-api-key": key } : {}, context.signal);
			for (const entry of listEntries(body, "models")) push(googleModelFromListEntry(options.id, baseUrl, entry));
			pageToken = isRecord(body) && typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
		} while (pageToken && !context.signal.aborted);
		return models;
	}

	if (options.api === "anthropic-messages") {
		let afterId: string | undefined;
		let hasMore = false;
		do {
			const url = new URL(`${baseUrl}/v1/models`);
			url.searchParams.set("limit", "1000");
			if (afterId) url.searchParams.set("after_id", afterId);
			const body = await fetchJson(
				url.toString(),
				{ "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
				context.signal,
			);
			for (const entry of listEntries(body, "data")) {
				push(modelFromListEntry(options.id, options.api, baseUrl, entry));
				if (typeof entry.id === "string") afterId = entry.id;
			}
			hasMore = isRecord(body) && body.has_more === true;
		} while (hasMore && afterId && !context.signal.aborted);
		return models;
	}

	const body = await fetchJson(`${baseUrl}/models`, key ? { authorization: `Bearer ${key}` } : {}, context.signal);
	for (const entry of listEntries(body, "data")) push(modelFromListEntry(options.id, options.api, baseUrl, entry));
	return models;
}

/**
 * A provider for one generic protocol endpoint whose models are discovered
 * from the endpoint's own model list instead of a static catalog. The list is
 * fetched with the effective credential on refresh and persisted through the
 * models store, so the endpoint only needs `api` + `baseUrl` (+ a key) to
 * populate its models. Explicit model metadata can still be layered on top
 * by the caller (e.g. models.json `modelOverrides`).
 */
export function genericEndpointProvider(options: GenericEndpointProviderOptions): Provider<GenericEndpointApi> {
	if (!isGenericEndpointApi(options.api)) throw new Error(`Unsupported generic endpoint api: ${options.api}`);
	if (!options.baseUrl) throw new Error(`Provider ${options.id}: "baseUrl" is required for a generic endpoint.`);
	const name = options.name ?? options.id;
	return createProvider<GenericEndpointApi>({
		id: options.id,
		name,
		baseUrl: options.baseUrl,
		auth: { apiKey: envApiKeyAuth(`${name} API key`, options.envVars ?? []) },
		models: [],
		fetchModels: (context) => fetchGenericModels(options, context),
		api: streamsFor(options.api),
	});
}

/** The models.json provider fields generic endpoint registration reads. */
export interface GenericEndpointConfig {
	name?: string;
	api?: string;
	baseUrl?: string;
	oauth?: string;
	/** Explicit model definitions; a non-empty list opts out of discovery. */
	models?: readonly unknown[];
}

/** Structural view of a models.json-style config source. */
export interface GenericEndpointConfigSource {
	getProviderIds(): readonly string[];
	getProvider(providerId: string): GenericEndpointConfig | undefined;
}

/**
 * Register a generic endpoint provider for each config entry that names a
 * supported `api` and `baseUrl` but lists no models (an OpenRouter in-region
 * host such as `https://us.openrouter.ai/api/v1` gets a regional OpenRouter
 * provider instead, and needs no `api`), skipping provider ids
 * already present in `providers` (built-ins keep their own catalogs) and
 * entries claimed by another mechanism (`oauth`).
 */
export function addGenericEndpointProviders(
	providers: Map<string, Provider>,
	source: GenericEndpointConfigSource,
): void {
	for (const providerId of source.getProviderIds()) {
		if (providers.has(providerId)) continue;
		const config = source.getProvider(providerId);
		if (!config?.baseUrl || config.oauth || config.models?.length) continue;
		const openrouter = providers.get("openrouter");
		if (openrouter && isOpenRouterRegionalBaseUrl(config.baseUrl)) {
			providers.set(
				providerId,
				openRouterRegionalProvider(openrouter, providerId, config.name ?? providerId, config.baseUrl),
			);
			continue;
		}
		if (!isGenericEndpointApi(config.api)) continue;
		providers.set(
			providerId,
			genericEndpointProvider({ id: providerId, name: config.name, api: config.api, baseUrl: config.baseUrl }),
		);
	}
}
