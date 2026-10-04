/** Immutable, credential-blind models.json snapshot. */

import { readFile } from "node:fs/promises";
import type { Static } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { modelsConfigSchema } from "./model-config-schema.generated.ts";
import type { buildModelsConfigSchemas } from "./model-config-schema.ts";

type ModelsConfigSchemas = ReturnType<typeof buildModelsConfigSchemas>;

export type ModelsJsonModel = Static<ModelsConfigSchemas["ModelDefinitionSchema"]>;
export type ModelsJsonModelOverride = Static<ModelsConfigSchemas["ModelOverrideSchema"]>;
export type ModelsJsonProvider = Static<ModelsConfigSchemas["ProviderConfigSchema"]>;
type ModelsJson = Static<ModelsConfigSchemas["ModelsConfigSchema"]>;

function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/** One immutable load of models.json. */
export class ModelConfig {
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	private readonly error: string | undefined;

	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
	}

	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		// (Value checks against the schema as it is: Compile() would generate a checker as source code first, on every start.)
		const ModelsConfigSchema = modelsConfigSchema();
		if (!Value.Check(ModelsConfigSchema, parsed)) {
			const errors =
				Value.Errors(ModelsConfigSchema, parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const config = parsed as ModelsJson;
		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return new ModelConfig(providers);
	}

	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	getError(): string | undefined {
		return this.error;
	}
}
