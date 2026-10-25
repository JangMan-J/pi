import { describe, expect, it } from "vitest";
import { kimiCodingModelName, withXaiUnlistedModels } from "../scripts/native-providers.ts";

describe("Kimi Coding model names", () => {
	it("names kimi-for-coding when models.dev only repeats the ID", () => {
		expect(kimiCodingModelName("kimi-for-coding", "kimi-for-coding")).toBe("Kimi For Coding");
		expect(kimiCodingModelName("kimi-for-coding", undefined)).toBe("Kimi For Coding");
	});

	it("keeps a real models.dev name and falls back to the ID otherwise", () => {
		expect(kimiCodingModelName("kimi-for-coding", "Kimi K2.9")).toBe("Kimi K2.9");
		expect(kimiCodingModelName("k3", "Kimi K3")).toBe("Kimi K3");
		expect(kimiCodingModelName("k9", "k9")).toBe("k9");
	});
});

describe("xAI unlisted models", () => {
	const grok47 = {
		id: "grok-4.7",
		name: "Grok 4.7",
		tool_call: true,
		reasoning: true,
		limit: { context: 500000, output: 500000 },
	};

	it("adds grok-4.7-build-fast as a copy of grok-4.7", () => {
		const models = withXaiUnlistedModels({ "grok-4.7": grok47 });
		expect(models["grok-4.7-build-fast"]).toEqual({ ...grok47, id: "grok-4.7-build-fast", name: "Grok 4.7 Fast" });
		expect(models["grok-4.7"]).toBe(grok47);
	});

	it("leaves a listed entry alone and skips the alias without its base model", () => {
		const listed = { ...grok47, id: "grok-4.7-build-fast", name: "Listed" };
		expect(withXaiUnlistedModels({ "grok-4.7": grok47, "grok-4.7-build-fast": listed })["grok-4.7-build-fast"]).toBe(
			listed,
		);
		expect(withXaiUnlistedModels({ "grok-4.6": { ...grok47, id: "grok-4.6" } })).not.toHaveProperty(
			"grok-4.7-build-fast",
		);
	});
});
