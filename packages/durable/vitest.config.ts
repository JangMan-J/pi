import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));
const durableSrcVirtualModels = fileURLToPath(new URL("./src/harness/virtual-models.ts", import.meta.url));
const aiSrcVirtualModels = fileURLToPath(new URL("../ai/src/virtual-models-entry.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		// Run in workerd by their own config: `npm run test:workers`.
		exclude: [...configDefaults.exclude, "test-workers/**"],
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
			{ find: /^@earendil-works\/pi-durable\/virtual-models$/, replacement: durableSrcVirtualModels },
			{ find: /^@earendil-works\/pi-ai\/virtual-models$/, replacement: aiSrcVirtualModels },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
