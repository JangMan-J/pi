import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));
const durableSrcVirtualModels = fileURLToPath(new URL("./src/harness/virtual-models.ts", import.meta.url));
const durableSrcSlidingWindow = fileURLToPath(new URL("./src/harness/sliding-window.ts", import.meta.url));
const durableSrcSlidingWindowNode = fileURLToPath(new URL("./src/harness/sliding-window/node.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcModels = fileURLToPath(new URL("../ai/src/models.ts", import.meta.url));
const aiSrcSessionResources = fileURLToPath(new URL("../ai/src/session-resources.ts", import.meta.url));
const aiSrcUtils = fileURLToPath(new URL("../ai/src/utils", import.meta.url));
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
			{ find: /^@earendil-works\/pi-durable\/sliding-window$/, replacement: durableSrcSlidingWindow },
			{ find: /^@earendil-works\/pi-durable\/sliding-window\/node$/, replacement: durableSrcSlidingWindowNode },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/models$/, replacement: aiSrcModels },
			{ find: /^@earendil-works\/pi-ai\/session-resources$/, replacement: aiSrcSessionResources },
			{ find: /^@earendil-works\/pi-ai\/utils\/(.+)$/, replacement: `${aiSrcUtils}/$1.ts` },
			{ find: /^@earendil-works\/pi-ai\/virtual-models$/, replacement: aiSrcVirtualModels },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
