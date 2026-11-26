import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

const WORKSPACE_ROOTS: Readonly<Record<string, string>> = {
	"@earendil-works/pi-virtual-models": sourceRoot,
	"@earendil-works/pi-durable": resolve(packagesRoot, "durable/src"),
	"@earendil-works/pi-ai": resolve(packagesRoot, "ai/src"),
	"@earendil-works/chord": resolve(packagesRoot, "chord/src"),
};

function resolveImportTarget(spec: string, fromFile: string): string | undefined {
	if (spec.startsWith("node:")) return undefined;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return undefined;
	}
	for (const [pkg, root] of Object.entries(WORKSPACE_ROOTS)) {
		if (spec === pkg) {
			const idx = resolve(root, "index.ts");
			return existsSync(idx) ? idx : undefined;
		}
		if (!spec.startsWith(`${pkg}/`)) continue;
		const tail = spec.slice(pkg.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(root, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return undefined;
}

async function valueImportGraph(entry: string): Promise<{ files: Set<string>; nodeBuiltins: Set<string> }> {
	const files = new Set<string>();
	const nodeBuiltins = new Set<string>();
	const pending = [resolve(sourceRoot, entry)];

	while (pending.length > 0) {
		const current = pending.pop()!;
		if (files.has(current)) continue;
		files.add(current);
		const source = await readFile(current, "utf8");
		for (const match of source.matchAll(
			/(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g,
		)) {
			const spec = match[2]!;
			if (spec.startsWith("node:")) {
				nodeBuiltins.add(spec);
				continue;
			}
			const target = resolveImportTarget(spec, current);
			if (target) pending.push(target);
		}
	}

	return { files, nodeBuiltins };
}

describe("virtual-models storage runtime boundary", () => {
	it("keeps src/sliding-window/node.ts self-sufficient without legacy virtual-models/sliding-window or StoreStorage imports", async () => {
		const nodeSource = await readFile(resolve(sourceRoot, "sliding-window/node.ts"), "utf8");
		expect(nodeSource).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
		expect(nodeSource).not.toMatch(/\bStoreStorage\b/);
		expect(nodeSource).not.toMatch(/from\s+["']@earendil-works\/chord["']/);
		expect(nodeSource).toMatch(/@earendil-works\/pi-durable\/storage\/sqlite/);
		expect(nodeSource).toMatch(/@earendil-works\/chord\/sqlite\/node/);
	});

	it("keeps portable entry points free of Node built-ins and sliding-window/node.ts", async () => {
		for (const entry of ["index.ts", "study-notes.ts", "durable/index.ts", "sliding-window/index.ts"]) {
			const { files, nodeBuiltins } = await valueImportGraph(entry);
			expect([...nodeBuiltins], `${entry} reached node: built-in`).toEqual([]);
			expect(
				[...files].some((f) => f.endsWith("/sliding-window/node.ts")),
				`${entry} reached sliding-window/node.ts`,
			).toBe(false);
		}
	});

	it("isolates Node sqlite/fs built-ins to sliding-window/node.ts", async () => {
		const { files, nodeBuiltins } = await valueImportGraph("sliding-window/node.ts");
		expect(files.has(resolve(sourceRoot, "sliding-window/node.ts"))).toBe(true);
		expect(nodeBuiltins.has("node:sqlite")).toBe(true);
		expect(nodeBuiltins.has("node:fs")).toBe(true);
	});
});
