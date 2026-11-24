#!/usr/bin/env node
// Hydrate packages/ai/src/providers/data from live sources, falling back to backfilling
// missing (type, id) entries from upstream's nix/model-catalog.json pin when a mid-day
// upstream catalog deletion/deprecation breaks TypeScript checks before upstream updates tests.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MODEL_TYPES = "types=chat,image,classifier";
const REVISION_RE = /^sha256-[0-9a-f]{64}$/;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

const repo =
	process.env.FORK_SYNC_REPO ??
	execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const aiDir = join(repo, "packages", "ai");
const providersDir = join(aiDir, "src", "providers");
const dataDir = join(providersDir, "data");

const hydrate = spawnSync(npmCmd, ["run", "hydrate:model-data"], { cwd: repo, stdio: "inherit" });
if (hydrate.status !== 0) process.exit(hydrate.status ?? 1);

const tscCheck = spawnSync(npxCmd, ["--no-install", "tsc", "--noEmit"], {
	cwd: repo,
	encoding: "utf8",
});
if (tscCheck.status === 0) process.exit(0);

const tscOutput = `${tscCheck.stdout ?? ""}${tscCheck.stderr ?? ""}`;
const missingIds = new Set(
	Array.from(
		tscOutput.matchAll(/(?:expression of type|Argument of type|Property) '"?([^"'\r\n]+)"?'/g),
		(match) => match[1],
	),
);
if (missingIds.size === 0) {
	process.stdout.write(tscCheck.stdout);
	process.stderr.write(tscCheck.stderr);
	process.exit(tscCheck.status ?? 1);
}

const pinPath = join(repo, "nix", "model-catalog.json");
const { revision } = JSON.parse(readFileSync(pinPath, "utf8"));
if (typeof revision !== "string" || !REVISION_RE.test(revision)) {
	process.stderr.write(tscCheck.stdout + tscCheck.stderr);
	throw new Error(`Invalid catalog revision in ${pinPath}: ${String(revision)}`);
}

const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?${MODEL_TYPES}`);
if (!response.ok) {
	process.stderr.write(tscCheck.stdout + tscCheck.stderr);
	throw new Error(`Pinned catalog ${revision} fetch failed: HTTP ${response.status}`);
}
const bytes = Buffer.from(await response.arrayBuffer());
const actualRevision = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
if (actualRevision !== revision) {
	throw new Error(`Pinned catalog ${revision} hash mismatch (${actualRevision})`);
}
const pinnedCatalog = JSON.parse(bytes.toString("utf8"));

const {
	createModelDataManifest,
	groupProviderModelData,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataProviderIds,
	validateModelDataDirectory,
} = await import(pathToFileURL(join(aiDir, "scripts", "model-data.ts")).href);

const files = {};
const structure = {};
const backfilled = [];

for (const provider of readModelDataProviderIds(aiDir)) {
	const liveGroups = JSON.parse(readFileSync(join(dataDir, `${provider}.json`), "utf8"));
	const entries = [];
	const seen = new Set();
	for (const group of Object.values(liveGroups)) {
		for (const model of Object.values(group)) {
			entries.push(model);
			seen.add(`${model.type}:${model.id}`);
		}
	}
	for (const pinned of pinnedCatalog[provider] ?? []) {
		if (!missingIds.has(pinned.id)) continue;
		const key = `${pinned.type}:${pinned.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push(pinned);
		backfilled.push(`${provider}/${pinned.id}`);
	}
	const grouped = groupProviderModelData(provider, entries);
	structure[provider] = grouped.structure;
	files[`${provider}.json`] = `${JSON.stringify(grouped.groups)}\n`;
}

if (backfilled.length === 0) {
	process.stdout.write(tscCheck.stdout);
	process.stderr.write(tscCheck.stderr);
	process.exit(tscCheck.status ?? 1);
}

const manifest = createModelDataManifest(structure, files, new Date().toISOString());
const stagingRoot = mkdtempSync(join(providersDir, ".model-hydration-"));
const stagedData = join(stagingRoot, "data");
try {
	mkdirSync(stagedData);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(stagedData, name), content);
	writeFileSync(join(stagedData, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
	validateModelDataDirectory(structure, stagedData);
	rmSync(dataDir, { recursive: true, force: true });
	renameSync(stagedData, dataDir);
} finally {
	rmSync(stagingRoot, { recursive: true, force: true });
}

console.warn(
	`hydrate-models: live catalog failed tsc; backfilled ${backfilled.length} retired entry/entries from ${revision}: ${backfilled.join(", ")}`,
);

const recheck = spawnSync(npxCmd, ["--no-install", "tsc", "--noEmit"], { cwd: repo, stdio: "inherit" });
process.exit(recheck.status ?? 1);
