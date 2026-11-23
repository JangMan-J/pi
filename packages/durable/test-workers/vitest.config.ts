import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Runs in workerd: the Durable Object storage, alarms, and eviction are Cloudflare's own.
export default defineConfig({
	root: source("."),
	plugins: [cloudflareTest({ wrangler: { configPath: source("./wrangler.jsonc") } })],
	test: { include: ["*.test.ts"] },
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: source("../src/index.ts") },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: source("../src/testing/index.ts") },
			{ find: /^@earendil-works\/pi-durable\/virtual-models$/, replacement: source("../src/harness/virtual-models.ts") },
			{ find: /^@earendil-works\/pi-durable\/sliding-window$/, replacement: source("../src/harness/sliding-window.ts") },
			{ find: /^@earendil-works\/pi-ai\/virtual-models$/, replacement: source("../../ai/src/virtual-models-entry.ts") },
			{
				find: /^@earendil-works\/pi-durable\/storage\/sqlite\/cloudflare$/,
				replacement: source("../src/storage/sqlite/cloudflare.ts"),
			},
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
