import type { Provider, RefreshModelsContext } from "../models.ts";
import type { AnyModel, Model } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { personalizeOpenRouterCatalog } from "./openrouter.ts";

const REGIONAL_HOST = /^[a-z0-9-]+\.openrouter\.ai$/;

/**
 * Whether `baseUrl` points at an OpenRouter in-region routing host such as
 * `https://us.openrouter.ai/api/v1` or `https://eu.openrouter.ai/api/v1`.
 */
export function isOpenRouterRegionalBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.protocol === "https:" && REGIONAL_HOST.test(url.hostname) && url.pathname.startsWith("/api");
	} catch {
		return false;
	}
}

function withOrigin(baseUrl: string, origin: string): string {
	const url = new URL(baseUrl);
	return `${origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * models.json applies a provider `baseUrl` to every model, so Anthropic Messages models
 * arrive with the `/api/v1` base. The Anthropic SDK appends `/v1/messages` itself, so they
 * need the `/api` base instead.
 */
function requestModel<T extends Model<any>>(model: T): T {
	return model.api === "anthropic-messages" ? { ...model, baseUrl: model.baseUrl.replace(/\/v1\/?$/, "") } : model;
}

/**
 * A second OpenRouter provider bound to an in-region routing host. It keeps every model's
 * own protocol, images and classifiers from the `openrouter` provider, and narrows the list
 * live with `GET {baseUrl}/models/user` on the regional host, so only models with endpoints
 * in that region (and the key's prices and limits there) are listed.
 */
export function openRouterRegionalProvider(source: Provider, id: string, name: string, baseUrl: string): Provider {
	const origin = new URL(baseUrl).origin;
	const rebase = (model: AnyModel): AnyModel => ({
		...model,
		provider: id,
		baseUrl: withOrigin(model.baseUrl, origin),
	});
	const sourceModels = (): AnyModel[] => (source.getAllModels?.() ?? source.getModels()).map(rebase);
	let regionalModels: readonly AnyModel[] = [];
	const getAllModels = (): readonly AnyModel[] => regionalModels;

	return {
		...source,
		id,
		name,
		baseUrl,
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		filterModels: undefined,
		filterAllModels: undefined,
		refreshModels: async (context: RefreshModelsContext) => {
			const restored = (context.stored?.models ?? []).filter((model) => model.provider === id);
			if (
				!(await context.publish({
					update: () => {
						regionalModels = restored;
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted || !context.credential) return;
			const catalog = sourceModels();
			const regional = await personalizeOpenRouterCatalog(catalog, {
				...context,
				baseUrl: context.baseUrl ?? baseUrl,
			});
			if (context.signal.aborted) return;
			if (regional.status === "unavailable")
				throw new Error(`${name}: ${baseUrl}/models/user rejected the key (${regional.reason})`);
			await context.publish({
				persist: { models: [...regional.models], checkedAt: Date.now() },
				update: () => {
					regionalModels = regional.models;
				},
			});
		},
		stream: (model, context, options) => source.stream(requestModel(model), context, options),
		streamSimple: (model, context, options) => source.streamSimple(requestModel(model), context, options),
		fetchDeferred: source.fetchDeferred
			? (model, handle, options) => source.fetchDeferred!(requestModel(model), handle, options)
			: undefined,
		cancelDeferred: source.cancelDeferred
			? (model, handle, options) => source.cancelDeferred!(requestModel(model), handle, options)
			: undefined,
	};
}
