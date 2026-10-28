import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelsDevReasoningOption, ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import type { Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function generateClaudeModels(
	options: Record<string, ModelsDevReasoningOption[] | undefined>,
	provider = "opencode",
): Record<string, Model<"anthropic-messages">> {
	const root = mkdtempSync(join(tmpdir(), "pi-claude-generation-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	const models = Object.entries(options).map(([id, reasoningOptions]): ModelsDevV2Model => {
		const effort = reasoningOptions?.find((option) => option.type === "effort");
		return {
			id,
			type: "chat",
			name: id,
			modalities: { input: ["text"], output: ["text"] },
			capabilities: {
				tools: { supported: true },
				reasoning: { supported: true, ...(effort ? { effort: effort.values } : {}) },
			},
			api: { messages: { base_url: "https://example.test/anthropic/v1" } },
		};
	});
	writeUpstreamMock(
		preloadPath,
		provider === "openrouter"
			? {}
			: { [provider]: { models: Object.fromEntries(models.map((model) => [model.id, model])) } },
		provider === "openrouter"
			? Object.keys(options).map((id) => ({
					id,
					name: id,
					supported_parameters: ["tools", "reasoning"],
					pricing: {},
				}))
			: [],
	);
	const result = spawnSync(
		process.execPath,
		["--import", pathToFileURL(preloadPath).href, "catalog/generate.ts", "--json-only", "--json-output", outputPath],
		{ cwd: packageRoot, encoding: "utf8", timeout: 10_000 },
	);
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
	expect(result.stderr).toBe("");
	return JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8")) as Record<
		string,
		Model<"anthropic-messages">
	>;
}

describe("Claude generator metadata", () => {
	it("keeps dated OpenRouter Opus 5 excluded from mid-conversation effort", () => {
		const ids = [
			"anthropic/claude-opus-5",
			"anthropic/claude-opus-5-20260723",
			"anthropic/claude-opus-5.5",
			"anthropic/claude-fable-5.1",
		];
		const models = generateClaudeModels(Object.fromEntries(ids.map((id) => [id, undefined])), "openrouter");
		for (const id of ids.slice(0, 2)) expect(models[id].compat?.supportsMidConvoEffort).not.toBe(true);
		for (const id of ids.slice(2)) {
			expect(models[id].compat?.supportsMidConvoEffort).toBe(true);
			expect(models[id].thinkingLevelMap?.off).toBeNull();
		}
	});
	it("preserves explicit none for models that can disable thinking", () => {
		const id = "claude-opus-4.6";
		const model = generateClaudeModels({ [id]: [{ type: "effort", values: ["none", "low"] }] })[id];
		expect(model.thinkingLevelMap?.off).toBe("none");
		expect(model.thinkingLevelMap?.high).toBeNull();
	});
	it("normalizes prefixed snapshots and enables OpenCode Go system messages", () => {
		const id = "~anthropic/claude-mythos-5.1-20260723";
		const model = generateClaudeModels({ [id]: undefined }, "opencode-go")[id];
		expect(model.compat).toMatchObject({ supportsMidConvoSystemMessages: true, supportsTemperature: false });
		expect(model.thinkingLevelMap?.off).toBeNull();
	});
	it("imports effort options before applying always-thinking corrections", () => {
		const ids = ["claude-opus-5.5", "claude-sonnet-5.5", "claude-fable-5.1", "claude-mythos-5.1", "claude-opus-4.6"];
		const models = generateClaudeModels(
			Object.fromEntries(ids.map((id) => [id, [{ type: "effort", values: ["low", "high"] }]])),
		);
		for (const id of ids) {
			expect(models[id].thinkingLevelMap?.medium).toBeNull();
			expect(models[id].compat).toMatchObject({ forceAdaptiveThinking: true });
		}
		for (const id of ids.slice(0, 4)) expect(models[id].thinkingLevelMap?.off).toBeNull();
		expect(models["claude-opus-4.6"].thinkingLevelMap?.off).not.toBeNull();
		for (const id of ids.slice(0, 4)) {
			expect(models[id].compat).toMatchObject({ supportsTemperature: false, supportsMidConvoSystemMessages: true });
		}
	});
	it("preserves supported off when models.dev supplies only effort levels", () => {
		const ids = [
			"claude-opus-5",
			"claude-haiku-5-5",
			"claude-opus-4-6",
			"claude-opus-4-8",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
		];
		const models = generateClaudeModels(
			Object.fromEntries(ids.map((id) => [id, [{ type: "effort", values: ["low", "high"] }]])),
		);
		for (const id of ids) {
			expect(models[id].thinkingLevelMap?.off).not.toBeNull();
			expect(models[id].thinkingLevelMap?.low).toBe("low");
			expect(models[id].thinkingLevelMap?.high).toBe("high");
		}
	});

	it("disallows off even without upstream efforts", () => {
		const ids = ["claude-opus-5-5-20260723", "claude-sonnet-5.5", "claude-fable-5.1", "claude-mythos-5.1"];
		const models = generateClaudeModels(Object.fromEntries(ids.map((id) => [id, undefined])));
		for (const id of ids) expect(models[id].thinkingLevelMap?.off).toBeNull();
	});
});
