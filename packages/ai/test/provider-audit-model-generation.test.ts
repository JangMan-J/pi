import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateModels } from "../scripts/generate-models.ts";
import type { Api, Model } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([true, false])("generates upstream OpenAI limits and Meta catalog limits (listed=%s)", async (listed) => {
	const ids = [
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-6.1-sol",
	];
	const root = mkdtempSync(join(tmpdir(), "pi-audit-models-"));
	roots.push(root);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url === "https://models.dev/api.json")
			return Response.json({
				openai: {
					models: listed
						? Object.fromEntries(
								ids.map((id) => [
									id,
									{ id, name: id, tool_call: true, limit: { context: 1000000, output: 128000 } },
								]),
							)
						: {},
				},
				meta: {
					models: {
						"muse-custom": {
							id: "muse-custom",
							name: "Custom",
							tool_call: true,
							limit: { context: 90000, output: 12000 },
						},
					},
				},
			});
		if (url === "https://models.dev/models.json?type=decision")
			return Response.json({ "typesafe/jev-latest": { name: "Jev", type: "decision", limit: { context: 64000 } } });
		if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models")
			return Response.json({ data: [] });
		if (url === "https://radius.pi.dev/v1/config")
			return Response.json({
				baseUrl: "https://radius.pi.dev",
				models: [
					{
						id: "test",
						name: "Test",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 4096,
						maxTokens: 4096,
					},
				],
			});
		throw new Error(`Unexpected fetch: ${url}`);
	});
	await generateModels({
		strict: false,
		dataOnly: false,
		jsonOnly: true,
		jsonOutputDir: join(root, "catalog"),
		pretty: false,
	});
	const read = (provider: string) =>
		JSON.parse(readFileSync(join(root, "catalog/providers", `${provider}.json`), "utf8")) as Record<
			string,
			Model<Api>
		>;
	for (const id of ids) {
		expect(read("openai")[id].contextWindow, id).toBe(272000);
		expect(read("openai-codex")[id].contextWindow, id).toBe(id === "gpt-6.1-sol" ? 500000 : 272000);
	}
	expect(read("meta")["muse-custom"]).toMatchObject({ contextWindow: 90000, maxTokens: 12000 });
});
