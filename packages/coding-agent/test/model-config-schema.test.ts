import { describe, expect, test } from "vitest";
import { modelsConfigSchema } from "../src/core/model-config-schema.generated.ts";
import { buildModelsConfigSchemas } from "../src/core/model-config-schema.ts";

describe("model-config-schema.generated.ts", () => {
	test("is the schema model-config-schema.ts builds (else run scripts/generate-model-config-schema.ts)", () => {
		const built = JSON.parse(JSON.stringify(buildModelsConfigSchemas().ModelsConfigSchema));
		expect(modelsConfigSchema()).toEqual(built);
	});
});
