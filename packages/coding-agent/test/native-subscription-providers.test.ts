import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Api, createModels, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { antigravityProvider } from "@earendil-works/pi-ai/providers/antigravity";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../../ai/src/auth/credential-store.ts";
import { createRegistry, Harness, MemoryStorage } from "../../durable/src/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

// Real native transports; only the HTTP boundary is mocked. No extension loader.
function mockNetwork(provider: string) {
	return vi.fn(async (_url: unknown, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { system?: { text: string }[]; project?: string; model: string };
		if (provider === "antigravity") {
			expect(body.project).toBe("fake-project");
			return new Response(
				`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "native-ok" }] }, finishReason: "STOP" }] } })}\n\n`,
			);
		}
		expect(body.system?.[0]?.text).toContain("x-anthropic-billing-header:");
		return new Response(
			[
				{
					type: "message_start",
					message: { id: "msg_mock", model: body.model, usage: { input_tokens: 1, output_tokens: 0 } },
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "native-ok" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]
				.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
				.join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
}
async function credentials() {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic", async () => ({
		type: "oauth",
		access: "sk-ant-oat-synthetic",
		refresh: "fake-refresh",
		expires: Date.now() + 3600000,
	}));
	await store.modify("antigravity", async () => ({
		type: "oauth",
		access: "fake-access",
		refresh: "fake-refresh",
		projectId: "fake-project",
		expires: Date.now() + 3600000,
	}));
	return store;
}

afterEach(() => vi.unstubAllGlobals());

it.each(["anthropic", "antigravity"])(
	"retains native %s through coding-agent provider rebuilds without extensions",
	async (provider) => {
		const runtime = await ModelRuntime.create({
			credentials: await credentials(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		for (let i = 0; i < 2; i++) {
			await runtime.refresh({ allowNetwork: false });
			const model =
				provider === "antigravity"
					? runtime.getModel(provider, "gemini-3.7-flash")
					: runtime.getModels(provider)[0];
			expect(model).toBeDefined();
			const wire = mockNetwork(provider);
			const result = await runtime.completeSimple(
				model as Model<Api>,
				{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
				{ fetch: wire },
			);
			expect(result.stopReason).toBe("stop");
			expect(wire).toHaveBeenCalledTimes(1);
		}
	},
);

it("keeps Antigravity's own discovery instead of replacing it with the pi.dev overlay", async () => {
	const runtime = await ModelRuntime.create({
		credentials: await credentials(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const fetch = vi.fn(async (url: unknown) => {
		expect(String(url)).toContain("/v1internal:fetchAvailableModels");
		return Response.json({ models: { "gemini-9-pro-high": { model: "ENUM_HIGH" } } });
	});
	vi.stubGlobal("fetch", fetch);
	const refreshed = await runtime.refresh({ providers: ["antigravity"], allowNetwork: true });
	expect(refreshed.errors.size).toBe(0);
	expect(runtime.getModel("antigravity", "gemini-9-pro")).toBeDefined();
	await runtime.refresh({ allowNetwork: false });
	expect(runtime.getModel("antigravity", "gemini-9-pro")).toBeDefined();
	expect(fetch).toHaveBeenCalledTimes(3);
});

it("generates Antigravity images through the native runtime after provider rebuilds", async () => {
	const runtime = await ModelRuntime.create({
		credentials: await credentials(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (let index = 0; index < 2; index++) {
		await runtime.refresh({ allowNetwork: false });
		const model = runtime.getModelOfType("image", "antigravity", "gemini-3-pro-image")!;
		expect(model).toBeDefined();
		expect(runtime.getModels("antigravity").some((entry) => entry.id === model.id)).toBe(false);
		const generated = await runtime.generateImages(
			model,
			{ input: [{ type: "text", text: "A red circle" }] },
			{
				metadata: { aspectRatio: "16:9" },
				fetch: async (_url, init) => {
					expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-access");
					expect(JSON.parse(String(init?.body))).toMatchObject({
						project: "fake-project",
						model: model.id,
						request: { generationConfig: { imageConfig: { aspectRatio: "16:9" } } },
					});
					return new Response(
						'data: {"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"iVBORw0KGgo="}}]},"finishReason":"STOP"}]}}\n\n',
					);
				},
			},
		);
		expect(generated.stopReason).toBe("stop");
		expect(generated.output).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
	}
});

it.each([anthropicProvider, antigravityProvider])(
	"runs a native subscription through pi-durable without coding-agent initialization",
	async (factory) => {
		const models = createModels({ credentials: await credentials() });
		const provider = factory();
		models.setProvider(provider);
		const model =
			provider.id === "antigravity"
				? models.getModel(provider.id, "gemini-3.7-flash")!
				: models.getModels(provider.id)[0]!;
		const wire = mockNetwork(provider.id);
		vi.stubGlobal("fetch", wire);
		const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: model.provider, modelId: model.id } },
			});
			const outcome = await (await root.submit({ type: "input", content: "Hi" }, context)).wait(context);
			expect(outcome.status).toBe("done");
			expect(wire).toHaveBeenCalledTimes(1);
		} finally {
			await harness.close(context);
		}
	},
);
