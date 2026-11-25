import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemorySlidingWindowArtifactStore, normalizeSliceKey } from "@earendil-works/pi-durable/sliding-window";
import {
	hashLiveFile,
	NodeSlidingWindowArtifactStore,
	readLiveFileText,
} from "@earendil-works/pi-durable/sliding-window/node";
import { describe, expect, it } from "vitest";

function symlinkedFixture(): {
	root: string;
	realDir: string;
	aliasDir: string;
	realFile: string;
	aliasFile: string;
	fileLink: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-sw-realpath-"));
	const realDir = join(root, "real");
	const aliasDir = join(root, "alias");
	mkdirSync(realDir);
	const realFile = join(realDir, "sample.ts");
	const fileLink = join(root, "file-link.ts");
	writeFileSync(realFile, "export const value = 1;\n", "utf8");
	symlinkSync(realDir, aliasDir, "dir");
	symlinkSync(realFile, fileLink, "file");
	return { root, realDir, aliasDir, realFile, aliasFile: join(aliasDir, "sample.ts"), fileLink };
}

describe("sliding-window realpath canonicalization", () => {
	it("canonicalizes normalizeSliceKey through symlinks and preserves lexical missing-path keys", () => {
		const fixture = symlinkedFixture();
		try {
			const canonical = realpathSync.native(fixture.realFile);
			expect(normalizeSliceKey(fixture.realFile)).toBe(canonical);
			expect(normalizeSliceKey(fixture.aliasFile)).toBe(canonical);
			expect(normalizeSliceKey(fixture.fileLink)).toBe(canonical);
			expect(normalizeSliceKey("sample.ts", fixture.aliasDir)).toBe(canonical);
			expect(normalizeSliceKey("src/../src/app.ts", "/repo")).toBe("/repo/src/app.ts");
			expect(normalizeSliceKey("missing.ts", fixture.aliasDir)).toBe(resolve(fixture.aliasDir, "missing.ts"));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("returns canonical live-file paths and matching contents through real and symlinked paths", () => {
		const fixture = symlinkedFixture();
		try {
			const canonical = realpathSync.native(fixture.realFile);
			const realHash = hashLiveFile(fixture.realFile);
			const aliasHash = hashLiveFile(fixture.aliasFile);
			expect(realHash).toEqual({ resolvedPath: canonical, sha256: realHash.sha256 });
			expect(aliasHash).toEqual(realHash);
			expect(hashLiveFile(fixture.fileLink)).toEqual(realHash);
			expect(realHash.sha256).not.toBeNull();

			const realText = readLiveFileText("sample.ts", fixture.realDir);
			const aliasText = readLiveFileText("sample.ts", fixture.aliasDir);
			expect(realText).toEqual({
				resolvedPath: canonical,
				text: "export const value = 1;\n",
				sha256: realHash.sha256,
			});
			expect(aliasText).toEqual(realText);
			expect(readLiveFileText(fixture.fileLink)).toEqual(realText);

			const missing = join(fixture.aliasDir, "missing.ts");
			expect(hashLiveFile(missing)).toEqual({ resolvedPath: resolve(missing), sha256: null });
			expect(readLiveFileText(missing)).toBeUndefined();
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("shares Node and memory artifact source entries across symlinked cwd paths", () => {
		const fixture = symlinkedFixture();
		const node = new NodeSlidingWindowArtifactStore(":memory:");
		const memory = new MemorySlidingWindowArtifactStore();
		try {
			const rawText = "export const value = 1;\n";
			const nodeMeta = node.put(rawText, { toolName: "read", sourcePath: "sample.ts", cwd: fixture.realDir });
			expect(node.getLatestBySourcePath("sample.ts", fixture.aliasDir)?.meta.ref).toBe(nodeMeta.ref);
			expect(node.recall({ ref: nodeMeta.ref, cwd: fixture.aliasDir }).staleSource).toBeUndefined();

			const memoryMeta = memory.put(rawText, {
				toolName: "read",
				sourcePath: "sample.ts",
				cwd: fixture.realDir,
			});
			expect(memory.getLatestBySourcePath("sample.ts", fixture.aliasDir)?.meta.ref).toBe(memoryMeta.ref);
			memory.put(rawText, { toolName: "read", sourcePath: fixture.realFile });
			expect(memory.getLatestBySourcePath(fixture.aliasFile)?.text).toBe(rawText);

			writeFileSync(fixture.realFile, "export const value = 2;\n", "utf8");
			const stale = node.recall({ ref: nodeMeta.ref, cwd: fixture.aliasDir });
			expect(stale.staleSource?.path).toBe(realpathSync.native(fixture.realFile));
			expect(stale.staleSource?.currentSha256).toBe(hashLiveFile(fixture.aliasFile).sha256);
		} finally {
			node.close();
			memory.close();
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
