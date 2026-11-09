import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { addModelsJsonProvider } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

describe("addModelsJsonProvider", () => {
	let dir: string;
	let modelsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-add-endpoint-"));
		modelsPath = join(dir, "models.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("creates the file and keeps existing providers and indentation", () => {
		addModelsJsonProvider(modelsPath, "local-vllm", {
			name: "Local vLLM",
			baseUrl: "http://localhost:8000/v1",
			api: "openai-completions",
		});
		expect(JSON.parse(readFileSync(modelsPath, "utf-8"))).toEqual({
			providers: {
				"local-vllm": { name: "Local vLLM", baseUrl: "http://localhost:8000/v1", api: "openai-completions" },
			},
		});

		writeFileSync(modelsPath, '{\n\t"providers": {\n\t\t"keep": { "baseUrl": "https://x/v1" }\n\t}\n}\n');
		addModelsJsonProvider(modelsPath, "second", { baseUrl: "https://y/v1", api: "openai-responses" });
		const text = readFileSync(modelsPath, "utf-8");
		expect(text.startsWith('{\n\t"providers"')).toBe(true);
		expect(JSON.parse(text).providers).toEqual({
			keep: { baseUrl: "https://x/v1" },
			second: { baseUrl: "https://y/v1", api: "openai-responses" },
		});
	});

	test("rejects a duplicate id", () => {
		addModelsJsonProvider(modelsPath, "dup", { baseUrl: "https://x/v1", api: "openai-completions" });
		expect(() => addModelsJsonProvider(modelsPath, "dup", { baseUrl: "https://y/v1" })).toThrow(/already exists/);
	});

	test("a refreshed runtime exposes the endpoint with an API key login and keeps a slot for more", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});
		expect(runtime.getModelsPath()).toBe(modelsPath);
		expect(runtime.getProvider("first")).toBeUndefined();

		addModelsJsonProvider(modelsPath, "first", { name: "First", baseUrl: "https://a/v1", api: "openai-completions" });
		await runtime.refresh({ providers: ["first"], allowNetwork: false });
		const first = runtime.getProvider("first");
		expect(first?.name).toBe("First");
		expect(first?.auth.apiKey?.login).toBeTypeOf("function");

		addModelsJsonProvider(modelsPath, "second", { name: "Second", baseUrl: "https://b/v1", api: "openai-responses" });
		await runtime.refresh({ providers: ["second"], allowNetwork: false });
		expect(runtime.getProvider("first")?.name).toBe("First");
		expect(runtime.getProvider("second")?.name).toBe("Second");
	});
});
