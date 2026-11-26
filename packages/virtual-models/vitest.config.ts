import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const vmSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const vmSrcStudyNotes = fileURLToPath(new URL("./src/study-notes.ts", import.meta.url));
const vmSrcDurable = fileURLToPath(new URL("./src/durable/index.ts", import.meta.url));
const vmSrcSlidingWindow = fileURLToPath(new URL("./src/sliding-window/index.ts", import.meta.url));
const vmSrcSlidingWindowNode = fileURLToPath(new URL("./src/sliding-window/node.ts", import.meta.url));
const durableSrcIndex = fileURLToPath(new URL("../durable/src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("../durable/src/testing/index.ts", import.meta.url));
const durableSrcVirtualModels = fileURLToPath(new URL("../durable/src/harness/virtual-models.ts", import.meta.url));
const durableSrcSlidingWindow = fileURLToPath(new URL("../durable/src/harness/sliding-window.ts", import.meta.url));
const durableSrcSlidingWindowNode = fileURLToPath(
	new URL("../durable/src/harness/sliding-window/node.ts", import.meta.url),
);
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcModels = fileURLToPath(new URL("../ai/src/models.ts", import.meta.url));
const aiSrcSessionResources = fileURLToPath(new URL("../ai/src/session-resources.ts", import.meta.url));
const aiSrcApi = fileURLToPath(new URL("../ai/src/api", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../ai/src/providers", import.meta.url));
const aiSrcUtils = fileURLToPath(new URL("../ai/src/utils", import.meta.url));
const aiSrcVirtualModels = fileURLToPath(new URL("../ai/src/virtual-models-entry.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-virtual-models$/, replacement: vmSrcIndex },
			{ find: /^@earendil-works\/pi-virtual-models\/study-notes$/, replacement: vmSrcStudyNotes },
			{ find: /^@earendil-works\/pi-virtual-models\/durable$/, replacement: vmSrcDurable },
			{ find: /^@earendil-works\/pi-virtual-models\/sliding-window$/, replacement: vmSrcSlidingWindow },
			{ find: /^@earendil-works\/pi-virtual-models\/sliding-window\/node$/, replacement: vmSrcSlidingWindowNode },
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
			{ find: /^@earendil-works\/pi-durable\/virtual-models$/, replacement: durableSrcVirtualModels },
			{ find: /^@earendil-works\/pi-durable\/sliding-window$/, replacement: durableSrcSlidingWindow },
			{ find: /^@earendil-works\/pi-durable\/sliding-window\/node$/, replacement: durableSrcSlidingWindowNode },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/models$/, replacement: aiSrcModels },
			{ find: /^@earendil-works\/pi-ai\/session-resources$/, replacement: aiSrcSessionResources },
			{ find: /^@earendil-works\/pi-ai\/api\/(.+)$/, replacement: `${aiSrcApi}/$1.ts` },
			{ find: /^@earendil-works\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@earendil-works\/pi-ai\/utils\/(.+)$/, replacement: `${aiSrcUtils}/$1.ts` },
			{ find: /^@earendil-works\/pi-ai\/virtual-models$/, replacement: aiSrcVirtualModels },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
