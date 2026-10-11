import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAvailableRuntimeModel } from "../src/api/antigravity/client.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { type AntigravityModel, antigravityProvider } from "../src/providers/antigravity.ts";
import type { ThinkingLevel } from "../src/types.ts";

async function setup(project: string, modelsStore = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("antigravity", async () => ({
		type: "oauth",
		access: "fake-token",
		refresh: "fake-refresh",
		expires: Date.now() + 3600000,
		projectId: project,
	}));
	const models = createModels({ credentials, modelsStore });
	models.setProvider(antigravityProvider());
	return { models, modelsStore };
}
async function sentModel(models: ReturnType<typeof createModels>, id: string, reasoning?: ThinkingLevel) {
	let payload: { model: string; request: { labels: { model_enum: string } } } | undefined;
	const result = await models.completeSimple(
		models.getModel("antigravity", id)!,
		{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
		{
			reasoning,
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response(
					'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
				);
			},
		},
	);
	expect(result.stopReason).toBe("stop");
	return payload!;
}

const refreshEnvNames = [
	"ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS",
	"ANTIGRAVITY_REFRESH_INTERVAL_MS",
	"NOAGY_CATALOG_REFRESH_INTERVAL_MS",
	"NOAGY_REFRESH_INTERVAL_MS",
];
beforeEach(() => {
	for (const name of refreshEnvNames) vi.stubEnv(name, undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Antigravity native catalog", () => {
	it("groups variants with family-specific capabilities and routes each effort", async () => {
		const { models, modelsStore } = await setup("project-a");
		const fetch = vi.fn(async () =>
			Response.json({
				models: {
					"gemini-9-pro-low": { displayName: "Gemini 9 Pro (Low)", model: "ENUM_LOW" },
					"gemini-9-pro-high": { displayName: "Gemini 9 Pro (High)", model: "ENUM_HIGH" },
					"claude-sonnet-9-thinking": { displayName: "Claude Sonnet 9 (Thinking)", supportsImages: false },
					"gemini-internal": { isInternal: true },
					"gemini-9-image": {},
				},
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect((await models.refresh({ allowNetwork: true })).errors.size).toBe(0);
		const pro = models.getModel("antigravity", "gemini-9-pro")!;
		expect(pro).toMatchObject({
			cost: models.getModel("antigravity", "gemini-3.1-pro")!.cost,
			contextWindow: models.getModel("antigravity", "gemini-3.1-pro")!.contextWindow,
			thinkingLevelMap: { low: "low", high: "high", medium: null },
		});
		expect(models.getModel("antigravity", "gemini-9-pro-low")).toBeUndefined();
		expect(models.getModel("antigravity", "gemini-internal")).toBeUndefined();
		expect(models.getModel("antigravity", "gemini-9-image")).toBeUndefined();
		expect(models.getModel("antigravity", "claude-sonnet-9")).toMatchObject({
			cost: models.getModel("antigravity", "claude-sonnet-4-6")!.cost,
			input: ["text"],
		});
		expect(await sentModel(models, pro.id, "low")).toMatchObject({
			model: "gemini-9-pro-low",
			request: { labels: { model_enum: "ENUM_LOW" } },
		});
		expect(await sentModel(models, pro.id, "high")).toMatchObject({
			model: "gemini-9-pro-high",
			request: { labels: { model_enum: "ENUM_HIGH" } },
		});
		expect((await sentModel(models, pro.id)).model).toBe("gemini-9-pro-low");
		const calls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(calls);

		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });
		expect(restored.models.getModel("antigravity", pro.id)).toMatchObject(pro);
		expect((await sentModel(restored.models, pro.id, "high")).model).toBe("gemini-9-pro-high");
	});

	// Upstream pi-antigravity #43: empty discovery must not replace last-known-good state.
	it.each(["empty", "failed"])(
		"preserves discovered chat/image models, routing, and freshness after %s discovery",
		async (failure) => {
			const { models, modelsStore } = await setup("project-a");
			vi.stubGlobal("fetch", async () =>
				Response.json({
					models: {
						"gemini-9-pro-low": { model: "ENUM_LOW" },
						"gemini-9-image": { supportsImages: true },
					},
				}),
			);
			await models.refresh({ allowNetwork: true });
			const stored = await modelsStore.read("antigravity");
			const previousChat = models.getModel("antigravity", "gemini-9-pro");
			const previousImage = models.getModelOfType("image", "antigravity", "gemini-9-image");
			vi.stubGlobal("fetch", async () =>
				failure === "empty" ? Response.json({ models: {} }) : new Response("unavailable", { status: 503 }),
			);
			const refreshed = await models.refresh({ allowNetwork: true, force: true });
			expect(refreshed.errors.size).toBe(failure === "empty" ? 0 : 1);
			expect(models.getModel("antigravity", "gemini-9-pro")).toEqual(previousChat);
			expect(models.getModelOfType("image", "antigravity", "gemini-9-image")).toEqual(previousImage);
			expect(await modelsStore.read("antigravity")).toEqual(stored);
			const restored = await setup("project-a", modelsStore);
			await restored.models.refresh({ allowNetwork: false });
			expect(restored.models.getModel("antigravity", "gemini-9-pro")).toEqual(previousChat);
			expect((await sentModel(restored.models, "gemini-9-pro", "low")).request.labels.model_enum).toBe("ENUM_LOW");
		},
	);

	// Upstream pi-antigravity #37: both interval spellings, including NOAGY aliases, allow zero.
	it.each(refreshEnvNames)("honors %s=0 instead of the four-hour default", async (name) => {
		vi.stubEnv(name, "0");
		const { models } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch.mock.calls.length).toBe(initialCalls * 2);
	});

	it("uses the configured positive interval, with the catalog-specific setting taking precedence", async () => {
		vi.stubEnv("ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS", "100");
		vi.stubEnv("ANTIGRAVITY_REFRESH_INTERVAL_MS", "0");
		const { models } = await setup("project-a");
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		clock.mockReturnValue(now + 99);
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls);
		clock.mockReturnValue(now + 100);
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it.each(["invalid", "-1"])("uses the default interval for %s and lets force bypass it", async (interval) => {
		vi.stubEnv("ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS", interval);
		const { models } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls);
		await models.refresh({ allowNetwork: true, force: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it("does not treat a future cache timestamp as fresh after clock rollback", async () => {
		const { models, modelsStore } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const stored = (await modelsStore.read("antigravity"))!;
		await modelsStore.write("antigravity", { ...stored, checkedAt: Date.now() + 60_000 });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it("keeps discovery and routing local to each provider instance", async () => {
		const a = await setup("a");
		const b = await setup("b");
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { project: string };
			return Response.json({
				models:
					body.project === "a"
						? { "gemini-9-pro-high": {} }
						: { "gemini-9-pro-tiered": { supportsThinking: false } },
			});
		});
		await a.models.refresh({ allowNetwork: true });
		await b.models.refresh({ allowNetwork: true });
		expect((await sentModel(a.models, "gemini-9-pro", "high")).model).toBe("gemini-9-pro-high");
		expect((await sentModel(b.models, "gemini-9-pro")).model).toBe("gemini-9-pro-tiered");
		expect(b.models.getModel("antigravity", "gemini-9-pro")!.reasoning).toBe(false);
		expect((antigravityProvider().getModels()[0] as AntigravityModel).antigravityRouting).toBeUndefined();
	});

	it("resolves display-name aliases to runtime keys, never MODEL enums", async () => {
		const found = await fetchAvailableRuntimeModel("fake-token", "fake-project", "gemini-3.7-flash-high", {
			fetch: async () =>
				Response.json({
					models: {
						MODEL_PLACEHOLDER_BAD: { displayName: "Gemini 3.7 Flash (High)" },
						"gemini-alias-agent": { displayName: "Gemini 3.7 Flash (High)", model: "MODEL_REAL_ENUM" },
					},
				}),
		});
		expect(found).toEqual({ id: "gemini-alias-agent", model: "MODEL_REAL_ENUM" });
	});
});
