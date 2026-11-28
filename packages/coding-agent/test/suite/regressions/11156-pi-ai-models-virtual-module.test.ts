import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VIRTUAL_MODULES } from "../../../src/core/extensions/virtual-modules.ts";

// Regression test for #11156: extensions importing @earendil-works/pi-ai/models
// (e.g. for clampThinkingLevel) failed with "Cannot find module" in embedded
// runtimes because the subpath was missing from the virtual module map.
describe("pi-ai/models virtual module", () => {
	it("exposes the pi-ai /models entrypoint to extensions", () => {
		const models = VIRTUAL_MODULES["@earendil-works/pi-ai/models"] as { clampThinkingLevel?: unknown } | undefined;
		expect(models).toBeDefined();
		expect(typeof models?.clampThinkingLevel).toBe("function");
	});

	it("exposes the same module under the legacy @mariozechner scope", () => {
		expect(VIRTUAL_MODULES["@mariozechner/pi-ai/models"]).toBe(VIRTUAL_MODULES["@earendil-works/pi-ai/models"]);
	});

	it("exposes @earendil-works/pi-virtual-models under both scopes and drops the legacy pi-ai/virtual-models shim", () => {
		const vm = VIRTUAL_MODULES["@earendil-works/pi-virtual-models"] as
			| {
					withVirtualModelRouting?: unknown;
					createVirtualModel?: unknown;
					attachVirtualRequestScope?: unknown;
					executeRoutedStream?: unknown;
			  }
			| undefined;
		expect(vm).toBeDefined();
		expect(typeof vm?.withVirtualModelRouting).toBe("function");
		expect(typeof vm?.createVirtualModel).toBe("function");
		expect(typeof vm?.attachVirtualRequestScope).toBe("function");
		expect(typeof vm?.executeRoutedStream).toBe("function");
		expect(VIRTUAL_MODULES["@mariozechner/pi-virtual-models"]).toBe(vm);
		expect(VIRTUAL_MODULES["@earendil-works/pi-ai/virtual-models"]).toBeUndefined();
		expect(VIRTUAL_MODULES["@mariozechner/pi-ai/virtual-models"]).toBeUndefined();
	});

	it("includes @earendil-works/pi-virtual-models in coding-agent install-lock without durable, chord, or photon wasm", () => {
		const lockPath = fileURLToPath(new URL("../../../install-lock/package-lock.json", import.meta.url));
		const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, unknown> };
		const keys = Object.keys(lock.packages ?? {});
		expect(keys).toContain("node_modules/@earendil-works/pi-virtual-models");
		expect(keys.some((key) => key.includes("pi-durable"))).toBe(false);
		expect(keys.some((key) => key.includes("@earendil-works/chord"))).toBe(false);
		expect(keys.some((key) => /(?:^|\/)@silvia-odwyer\/photon$/.test(key))).toBe(false);
	});
});
