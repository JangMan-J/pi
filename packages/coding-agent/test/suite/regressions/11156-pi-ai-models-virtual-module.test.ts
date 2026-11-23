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

	it("exposes the pi-ai /virtual-models entrypoint under both scopes", () => {
		const vm = VIRTUAL_MODULES["@earendil-works/pi-ai/virtual-models"] as
			| { withVirtualModelRouting?: unknown; createVirtualModel?: unknown; attachVirtualRequestScope?: unknown }
			| undefined;
		expect(vm).toBeDefined();
		expect(typeof vm?.withVirtualModelRouting).toBe("function");
		expect(typeof vm?.createVirtualModel).toBe("function");
		expect(typeof vm?.attachVirtualRequestScope).toBe("function");
		expect(VIRTUAL_MODULES["@mariozechner/pi-ai/virtual-models"]).toBe(vm);
	});
});
