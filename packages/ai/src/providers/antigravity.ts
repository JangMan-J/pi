import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog } from "../api/antigravity/client.ts";
import { buildAntigravityCatalog, humanizePublicId } from "../api/antigravity/grouping.ts";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from "../api/antigravity/models.ts";
import type { AntigravityRouting } from "../api/antigravity/types.ts";
import { antigravityEnv } from "../api/antigravity/util.ts";
import { antigravityApi } from "../api/antigravity-api.ts";
import { generateImages } from "../api/antigravity-images.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { ImageModel, Model } from "../types.ts";

export type AntigravityModel = Model<"antigravity-api"> & {
	antigravityModelEnum?: string;
	antigravityRouting?: AntigravityRouting;
	antigravityModelEnums?: Record<string, string>;
};

type AntigravityProviderModel = AntigravityModel | ImageModel<"antigravity-images">;

/** Google-account subscription access, independent of coding-agent extensions. */
export function antigravityProvider(): Provider<"antigravity-api"> {
	const baseline: AntigravityModel[] = ANTIGRAVITY_MODELS.map((model) => ({
		...model,
		api: "antigravity-api",
		provider: "antigravity",
		baseUrl: DEFAULT_ENDPOINT,
	}));
	const imageBaseline: ImageModel<"antigravity-images">[] = [
		"gemini-3-pro-image",
		"gemini-3.1-flash-image",
		"gemini-3-pro-image-preview",
	].map((id) => ({
		type: "image",
		id,
		name: `${humanizePublicId(id)} (Antigravity)`,
		api: "antigravity-images",
		provider: "antigravity",
		baseUrl: DEFAULT_ENDPOINT,
		input: ["text"],
		output: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	let models: AntigravityProviderModel[] = [...baseline, ...imageBaseline];
	const oauth = lazyOAuth({ name: "Antigravity (Google account)", isSubscription: true, load: loadAntigravityOAuth });
	const provider = createProvider({
		id: "antigravity",
		name: "Antigravity",
		baseUrl: DEFAULT_ENDPOINT,
		auth: { oauth },
		models,
		api: antigravityApi(),
		images: { "antigravity-images": { generateImages } },
	});
	return {
		...provider,
		getModels: () => models.filter((model): model is AntigravityModel => isModelType(model, "chat")),
		getAllModels: () => models,
		async refreshModels(context) {
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is AntigravityProviderModel =>
						model.provider === "antigravity" &&
						((isModelType(model, "chat") && model.api === "antigravity-api") ||
							(isModelType(model, "image") && model.api === "antigravity-images")),
				);
				if (restored.length)
					await context.publish({
						update: () => {
							const merged = new Map<string, AntigravityProviderModel>();
							for (const model of [...baseline, ...imageBaseline, ...restored]) {
								merged.set(`${model.type ?? "chat"}:${model.id}`, model);
							}
							models = [...merged.values()];
						},
					});
			}
			if (!context.allowNetwork || context.credential?.type !== "oauth") return;
			const configuredInterval = Number.parseInt(
				antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS") ?? "",
				10,
			);
			const refreshInterval =
				Number.isFinite(configuredInterval) && configuredInterval >= 0 ? configuredInterval : 4 * 60 * 60 * 1000;
			const checkedAt = context.stored?.checkedAt ?? 0;
			const now = Date.now();
			if (!context.force && checkedAt > 0 && now >= checkedAt && now - checkedAt < refreshInterval) return;
			const auth = await oauth.toAuth(context.credential);
			const credential = JSON.parse(auth.apiKey!) as { token: string; projectId: string };
			const catalog = await fetchAvailableModelsCatalog(credential.token, credential.projectId, {
				signal: context.signal,
			});
			// Empty discovery is not a new catalog: preserve models, routes, enums, and freshness.
			if (!catalog.models || Object.keys(catalog.models).length === 0) return;
			const grouped = buildAntigravityCatalog(catalog.models, {
				models: baseline,
				routing: ANTIGRAVITY_ROUTING,
			});
			const enums = Object.fromEntries(
				Object.entries(catalog.models ?? {}).flatMap(([id, info]) =>
					typeof info.model === "string" ? [[id, info.model]] : [],
				),
			);
			const images = new Map(imageBaseline.map((model) => [model.id, model]));
			for (const [id, info] of Object.entries(catalog.models ?? {})) {
				if (
					info.isInternal ||
					id.length > 80 ||
					!/^(gemini-[a-z0-9.+-]*image[a-z0-9.+-]*|imagen-[a-z0-9.+-]+)$/i.test(id)
				)
					continue;
				images.set(id, {
					...imageBaseline[0]!,
					id,
					name: typeof info.displayName === "string" ? info.displayName : `${humanizePublicId(id)} (Antigravity)`,
					input: info.supportsImages === true ? ["text", "image"] : ["text"],
				});
			}
			const next: AntigravityProviderModel[] = grouped.models.map((model) => ({
				...model,
				api: "antigravity-api",
				provider: "antigravity",
				baseUrl: DEFAULT_ENDPOINT,
				antigravityRouting: grouped.routing[model.id],
				antigravityModelEnums: enums,
			}));
			next.push(...images.values());
			await context.publish({
				persist: { models: next, checkedAt: Date.now() },
				update: () => {
					models = next;
				},
			});
		},
	};
}
