import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import type { Context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import {
	type ExportCheckpointedForkResult,
	type ExportCheckpointedForkStorageOptions,
	exportCheckpointedForkToStorage,
} from "./fork-export.ts";
import { createLayeredArtifactStore, normalizeRefId } from "./memory-store.ts";
import { normalizeSliceKey } from "./staging.ts";
import type {
	ArtifactMeta,
	LiveFileSnapshot,
	PutArtifactOptions,
	RecallOptions,
	RecallResult,
	SlidingWindowArtifactStore,
	StoredArtifactEntry,
} from "./types.ts";

const CHUNK_LINES = 80;
const DEFAULT_MAX_RECALL_LINES = 140;
const DEFAULT_CONTEXT_LINES = 4;
const MAX_SOURCE_HASH_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BLOB_COUNT = 4_096;
const DEFAULT_MIN_AGE_MS = 30 * 60 * 1000;
const DEFAULT_GC_INTERVAL_PUTS = 32;

export interface NodeArtifactStoreOptions {
	readonly readOnly?: boolean;
	readonly maxTotalBytes?: number;
	readonly maxBlobCount?: number;
	readonly minAgeMs?: number;
	readonly gcIntervalPuts?: number;
	readonly pinnedRefs?: () => ReadonlySet<string>;
}

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

export { createLayeredArtifactStore, normalizeRefId };

function canonicalizePath(targetPath: string, cwd?: string): string {
	const lexical = resolve(cwd ?? process.cwd(), targetPath);
	try {
		return realpathSync.native(lexical);
	} catch {
		return lexical;
	}
}

export function hashLiveFile(sourcePath: string, cwd?: string): { resolvedPath: string; sha256: string | null } {
	const resolvedPath = canonicalizePath(sourcePath, cwd);
	try {
		if (!existsSync(resolvedPath)) return { resolvedPath, sha256: null };
		const st = statSync(resolvedPath);
		if (!st.isFile() || st.size > MAX_SOURCE_HASH_BYTES) return { resolvedPath, sha256: null };
		return { resolvedPath, sha256: sha256Hex(readFileSync(resolvedPath)) };
	} catch {
		return { resolvedPath, sha256: null };
	}
}

export function readLiveFileText(
	sourcePath: string,
	cwd?: string,
): (LiveFileSnapshot & { resolvedPath: string }) | undefined {
	const resolvedPath = canonicalizePath(sourcePath, cwd);
	try {
		if (!existsSync(resolvedPath)) return undefined;
		const st = statSync(resolvedPath);
		if (!st.isFile() || st.size > MAX_SOURCE_HASH_BYTES) return undefined;
		const buf = readFileSync(resolvedPath);
		return { resolvedPath, text: buf.toString("utf8"), sha256: sha256Hex(buf) };
	} catch {
		return undefined;
	}
}

function sanitizeFtsTokens(query: string): string[] {
	const matches = query.match(/[A-Za-z0-9_]{2,}/g) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of matches) {
		const lower = token.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(token);
		if (out.length >= 8) break;
	}
	return out;
}

function splitLinesPreserve(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

/**
 * Node.js SQLite + FTS5 + zlib content-addressed artifact store for oversized tool outputs.
 * Deduplicates identical blobs by SHA-256, indexes 80-line chunks in FTS5 for recall queries,
 * and tracks source file SHA-256 to warn when live files drift on disk.
 */
export class NodeSlidingWindowArtifactStore implements SlidingWindowArtifactStore {
	readonly dbPath: string;
	readonly readOnly: boolean;
	private readonly db: DatabaseSync;
	private readonly hasSourcesTable: boolean;
	private readonly maxTotalBytes: number;
	private readonly maxBlobCount: number;
	private readonly minAgeMs: number;
	private readonly gcIntervalPuts: number;
	private readonly pinnedRefs?: () => ReadonlySet<string>;
	private putsSinceGc = 0;
	private closed = false;

	constructor(dbPath = ":memory:", opts: NodeArtifactStoreOptions = {}) {
		this.dbPath = dbPath;
		this.readOnly = opts.readOnly === true;
		this.maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.maxBlobCount = opts.maxBlobCount ?? DEFAULT_MAX_BLOB_COUNT;
		this.minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
		this.gcIntervalPuts = Math.max(1, opts.gcIntervalPuts ?? DEFAULT_GC_INTERVAL_PUTS);
		this.pinnedRefs = opts.pinnedRefs;

		if (this.readOnly) {
			this.db = new DatabaseSync(dbPath, { readOnly: true });
			const row = this.db
				.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'artifact_sources'`)
				.get() as { ok?: number } | undefined;
			this.hasSourcesTable = row?.ok === 1;
			return;
		}

		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      DROP TABLE IF EXISTS artifact_chunks;

      CREATE TABLE IF NOT EXISTS artifact_blobs (
        ref TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        tool_name TEXT NOT NULL,
        byte_len INTEGER NOT NULL,
        line_count INTEGER NOT NULL,
        source_path TEXT,
        source_sha256 TEXT,
        label TEXT,
        created_at_ms INTEGER NOT NULL,
        zlib_bytes BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_blobs_created
        ON artifact_blobs(created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS artifact_sources (
        cwd TEXT NOT NULL,
        source_path TEXT NOT NULL,
        ref TEXT NOT NULL,
        source_sha256 TEXT,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (cwd, source_path)
      );

      CREATE INDEX IF NOT EXISTS idx_artifact_sources_ref
        ON artifact_sources(ref);

      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
        ref UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        text
      );
    `);
		this.hasSourcesTable = true;
	}

	put(rawText: string, options: PutArtifactOptions): ArtifactMeta {
		if (this.readOnly) {
			throw new Error(`Cannot write to read-only artifact store (${this.dbPath})`);
		}
		const sha256 = sha256Hex(rawText);
		const nowMs = options.nowMs ?? Date.now();
		const existing = this.db
			.prepare(
				`SELECT ref, sha256, tool_name, byte_len, line_count, source_path, source_sha256, label, created_at_ms
         FROM artifact_blobs WHERE sha256 = ?`,
			)
			.get(sha256) as Record<string, unknown> | undefined;

		const liveHash = options.sourcePath !== undefined ? hashLiveFile(options.sourcePath, options.cwd) : undefined;
		const cwdKey = options.cwd ? canonicalizePath(options.cwd) : "";
		const normSourcePath =
			options.sourcePath !== undefined ? normalizeSliceKey(options.sourcePath, options.cwd) : undefined;
		const canBindSource =
			options.bindSource !== false &&
			normSourcePath !== undefined &&
			(liveHash?.sha256 == null || liveHash.sha256 === sha256);

		if (existing) {
			const existingRef = String(existing.ref);
			this.db.exec("BEGIN IMMEDIATE");
			try {
				this.db.prepare(`UPDATE artifact_blobs SET created_at_ms = ? WHERE ref = ?`).run(nowMs, existingRef);
				if (canBindSource) {
					this.db
						.prepare(
							`INSERT OR REPLACE INTO artifact_sources (cwd, source_path, ref, source_sha256, updated_at_ms)
               VALUES (?, ?, ?, ?, ?)`,
						)
						.run(cwdKey, normSourcePath, existingRef, liveHash?.sha256 ?? null, nowMs);
				}
				this.db.exec("COMMIT");
			} catch (err) {
				try {
					this.db.exec("ROLLBACK");
				} catch {
					// ignore rollback failure
				}
				throw err;
			}
			const baseMeta = this.rowToMeta({ ...existing, created_at_ms: nowMs });
			if (!canBindSource) {
				const { sourcePath: _sp, sourceSha256: _ss, ...rest } = baseMeta;
				return {
					...rest,
					...((options.label ?? options.sourcePath ?? baseMeta.label)
						? { label: options.label ?? options.sourcePath ?? baseMeta.label }
						: {}),
				};
			}
			return {
				...baseMeta,
				...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
				...(liveHash?.sha256 ? { sourceSha256: liveHash.sha256 } : {}),
			};
		}

		let prefixLen = 12;
		let ref = sha256.slice(0, prefixLen);
		while (
			this.db.prepare(`SELECT 1 FROM artifact_blobs WHERE ref = ?`).get(ref) !== undefined &&
			prefixLen < sha256.length
		) {
			prefixLen += 4;
			ref = sha256.slice(0, prefixLen);
		}

		const lines = splitLinesPreserve(rawText);
		const byteLen = Buffer.byteLength(rawText, "utf8");
		const lineCount = lines.length;
		const compressed = deflateSync(Buffer.from(rawText, "utf8"));
		const createdAtMs = nowMs;

		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					`INSERT INTO artifact_blobs (
            ref, sha256, tool_name, byte_len, line_count, source_path, source_sha256, label, created_at_ms, zlib_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					ref,
					sha256,
					options.toolName,
					byteLen,
					lineCount,
					canBindSource ? (options.sourcePath ?? null) : null,
					canBindSource ? (liveHash?.sha256 ?? null) : null,
					options.label ?? options.sourcePath ?? null,
					createdAtMs,
					compressed,
				);

			if (canBindSource) {
				this.db
					.prepare(
						`INSERT OR REPLACE INTO artifact_sources (cwd, source_path, ref, source_sha256, updated_at_ms)
             VALUES (?, ?, ?, ?, ?)`,
					)
					.run(cwdKey, normSourcePath, ref, liveHash?.sha256 ?? null, createdAtMs);
			}

			const insertFts = this.db.prepare(
				`INSERT INTO artifact_fts (ref, start_line, end_line, text) VALUES (?, ?, ?, ?)`,
			);

			for (let start = 0; start < lines.length; start += CHUNK_LINES) {
				const slice = lines.slice(start, start + CHUNK_LINES);
				const startLine = start + 1;
				const endLine = start + slice.length;
				insertFts.run(ref, startLine, endLine, slice.join("\n"));
			}
			this.db.exec("COMMIT");
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore rollback failure
			}
			throw err;
		}

		this.putsSinceGc += 1;
		if (this.putsSinceGc >= this.gcIntervalPuts) {
			this.putsSinceGc = 0;
			this.runGc(nowMs);
		}

		return {
			ref,
			sha256,
			toolName: options.toolName,
			byteLen,
			lineCount,
			...(canBindSource && options.sourcePath ? { sourcePath: options.sourcePath } : {}),
			...(canBindSource && liveHash?.sha256 ? { sourceSha256: liveHash.sha256 } : {}),
			...((options.label ?? options.sourcePath) ? { label: options.label ?? options.sourcePath } : {}),
			createdAtMs,
		};
	}

	getLatestBySourcePath(sourcePath: string, cwd?: string): StoredArtifactEntry | undefined {
		const normPath = normalizeSliceKey(sourcePath, cwd);
		const cwdKey = cwd ? canonicalizePath(cwd) : "";
		let ref: string | undefined;
		let resolvedSourcePath = sourcePath;
		let sourceSha256: string | undefined;

		if (this.hasSourcesTable) {
			const row = (this.db
				.prepare(`SELECT ref, source_path, source_sha256 FROM artifact_sources WHERE cwd = ? AND source_path = ?`)
				.get(cwdKey, normPath) ??
				this.db
					.prepare(
						`SELECT ref, source_path, source_sha256 FROM artifact_sources WHERE source_path = ? ORDER BY updated_at_ms DESC LIMIT 1`,
					)
					.get(normPath)) as { ref?: string; source_path?: string; source_sha256?: string | null } | undefined;
			if (row?.ref) {
				ref = String(row.ref);
				resolvedSourcePath = row.source_path ? String(row.source_path) : sourcePath;
				if (typeof row.source_sha256 === "string" && row.source_sha256) {
					sourceSha256 = row.source_sha256;
				}
			}
		}

		if (!ref) {
			const legacy = this.db
				.prepare(
					`SELECT ref, source_path, source_sha256 FROM artifact_blobs
           WHERE source_path = ? OR source_path = ?
           ORDER BY created_at_ms DESC LIMIT 1`,
				)
				.get(sourcePath, normPath) as
				| { ref?: string; source_path?: string; source_sha256?: string | null }
				| undefined;
			if (legacy?.ref) {
				ref = String(legacy.ref);
				resolvedSourcePath = legacy.source_path ? String(legacy.source_path) : sourcePath;
				if (typeof legacy.source_sha256 === "string" && legacy.source_sha256) {
					sourceSha256 = legacy.source_sha256;
				}
			}
		}

		if (!ref) return undefined;
		const meta = this.getMeta(ref);
		const text = this.readFullText(ref);
		if (!meta || text === undefined) return undefined;
		return {
			meta: {
				...meta,
				sourcePath: resolvedSourcePath,
				...(sourceSha256 ? { sourceSha256 } : {}),
			},
			text,
		};
	}

	readLiveFile(sourcePath: string, cwd?: string): LiveFileSnapshot | undefined {
		return readLiveFileText(sourcePath, cwd);
	}

	getMeta(rawRef: string): ArtifactMeta | undefined {
		const ref = normalizeRefId(rawRef);
		const row = this.db
			.prepare(
				`SELECT ref, sha256, tool_name, byte_len, line_count, source_path, source_sha256, label, created_at_ms
         FROM artifact_blobs WHERE ref = ? OR sha256 = ?`,
			)
			.get(ref, ref) as Record<string, unknown> | undefined;
		return row ? this.rowToMeta(row) : undefined;
	}

	readFullText(rawRef: string): string | undefined {
		const ref = normalizeRefId(rawRef);
		const row = this.db.prepare(`SELECT zlib_bytes FROM artifact_blobs WHERE ref = ? OR sha256 = ?`).get(ref, ref) as
			| { zlib_bytes?: Uint8Array }
			| undefined;
		if (!row?.zlib_bytes) return undefined;
		return inflateSync(row.zlib_bytes).toString("utf8");
	}

	listRecent(limit = 50): ArtifactMeta[] {
		const rows = this.db
			.prepare(
				`SELECT ref, sha256, tool_name, byte_len, line_count, source_path, source_sha256, label, created_at_ms
         FROM artifact_blobs
         ORDER BY created_at_ms DESC
         LIMIT ?`,
			)
			.all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
		return rows.map((r) => this.rowToMeta(r));
	}

	recall(options: RecallOptions): RecallResult {
		const meta = this.getMeta(options.ref);
		if (!meta) {
			return {
				found: false,
				text: `[sliding-window recall] Unknown artifact ref:${normalizeRefId(options.ref)}. Re-run the tool or check active refs.`,
				returnedLines: 0,
			};
		}

		const rawText = this.readFullText(meta.ref) ?? "";
		const lines = splitLinesPreserve(rawText);
		const maxLines = Math.max(1, Math.min(400, options.maxLines ?? DEFAULT_MAX_RECALL_LINES));
		const contextLines = Math.max(0, Math.min(30, options.contextLines ?? DEFAULT_CONTEXT_LINES));

		let staleSource: RecallResult["staleSource"];
		const notices: string[] = [];
		const checkedSources: Array<{ path: string; cwd?: string; sha256: string }> = [];
		if (this.hasSourcesTable) {
			const cwdKey = options.cwd ? canonicalizePath(options.cwd) : undefined;
			const rows = (
				cwdKey
					? this.db
							.prepare(
								`SELECT cwd, source_path, source_sha256 FROM artifact_sources
                 WHERE ref = ?
                 ORDER BY CASE WHEN cwd = ? THEN 0 ELSE 1 END, updated_at_ms DESC
                 LIMIT 8`,
							)
							.all(meta.ref, cwdKey)
					: this.db
							.prepare(
								`SELECT cwd, source_path, source_sha256 FROM artifact_sources
                 WHERE ref = ?
                 ORDER BY updated_at_ms DESC
                 LIMIT 8`,
							)
							.all(meta.ref)
			) as Array<{ cwd?: string; source_path?: string; source_sha256?: string | null }>;
			for (const row of rows) {
				if (typeof row.source_path === "string" && typeof row.source_sha256 === "string" && row.source_sha256) {
					checkedSources.push({
						path: row.source_path,
						...(typeof row.cwd === "string" && row.cwd ? { cwd: row.cwd } : {}),
						sha256: row.source_sha256,
					});
				}
			}
		}
		if (checkedSources.length === 0 && meta.sourcePath && meta.sourceSha256) {
			checkedSources.push({
				path: meta.sourcePath,
				...(options.cwd ? { cwd: options.cwd } : {}),
				sha256: meta.sourceSha256,
			});
		}
		for (const src of checkedSources) {
			const live = hashLiveFile(src.path, src.cwd ?? options.cwd);
			if (live.sha256 !== src.sha256) {
				staleSource = {
					path: src.path,
					snapshotSha256: src.sha256,
					currentSha256: live.sha256,
				};
				notices.push(
					`[stale snapshot: ${src.path} changed on disk since ref:${meta.ref}; call read("${src.path}") for live bytes]`,
				);
				break;
			}
		}

		if (options.query && options.query.trim().length > 0) {
			const query = options.query.trim();
			const matchedLineNumbers = this.findMatchingLines(meta.ref, lines, query);
			if (matchedLineNumbers.length === 0) {
				const header = [
					...notices,
					`[ref:${meta.ref} • ${meta.toolName}${meta.sourcePath ? ` • ${meta.sourcePath}` : ""} • ${lines.length} lines] No lines matched "${query}".`,
				].join("\n");
				return { found: true, meta, ...(staleSource ? { staleSource } : {}), text: header, returnedLines: 0 };
			}

			const windows: Array<{ start: number; end: number }> = [];
			for (const lineNo of matchedLineNumbers) {
				const start = Math.max(1, lineNo - contextLines);
				const end = Math.min(lines.length, lineNo + contextLines);
				const prev = windows.at(-1);
				if (prev && start <= prev.end + 2) {
					prev.end = Math.max(prev.end, end);
				} else {
					windows.push({ start, end });
				}
			}

			const rendered: string[] = [
				...notices,
				`[ref:${meta.ref} • query="${query}" • ${matchedLineNumbers.length} matching line(s) of ${lines.length}]`,
			];
			let emitted = 0;
			for (const win of windows) {
				if (emitted >= maxLines) {
					rendered.push(`... [capped at ${maxLines} lines; pass startLine/endLine for more]`);
					break;
				}
				if (emitted > 0) rendered.push("  ---");
				const stop = Math.min(win.end, win.start + (maxLines - emitted) - 1);
				for (let ln = win.start; ln <= stop; ln++) {
					rendered.push(`${String(ln).padStart(5, " ")} | ${lines[ln - 1] ?? ""}`);
					emitted += 1;
				}
			}
			return {
				found: true,
				meta,
				...(staleSource ? { staleSource } : {}),
				text: rendered.join("\n"),
				returnedLines: emitted,
			};
		}

		const startLine = Math.max(1, Math.min(Math.max(1, lines.length), options.startLine ?? 1));
		const requestedEnd =
			options.endLine !== undefined ? Math.max(startLine, options.endLine) : startLine + maxLines - 1;
		const endLine = Math.min(lines.length, startLine + maxLines - 1, requestedEnd);

		const rendered: string[] = [
			...notices,
			`[ref:${meta.ref} • lines ${startLine}–${endLine} of ${lines.length}${meta.sourcePath ? ` • ${meta.sourcePath}` : ""}]`,
		];
		let emitted = 0;
		for (let ln = startLine; ln <= endLine; ln++) {
			rendered.push(`${String(ln).padStart(5, " ")} | ${lines[ln - 1] ?? ""}`);
			emitted += 1;
		}
		if (endLine < lines.length && (options.endLine === undefined || options.endLine > endLine)) {
			rendered.push(`[+${lines.length - endLine} more lines in ref:${meta.ref}; pass startLine=${endLine + 1}]`);
		}

		return {
			found: true,
			meta,
			...(staleSource ? { staleSource } : {}),
			text: rendered.join("\n"),
			returnedLines: emitted,
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.db.close();
	}

	private findMatchingLines(ref: string, lines: string[], query: string): number[] {
		const lowerQuery = query.toLowerCase();
		const tokens = sanitizeFtsTokens(query);

		let candidateRanges: Array<{ start_line: number; end_line: number }> | undefined;
		if (tokens.length > 0) {
			const ftsExpr = tokens.map((t) => `"${t}"*`).join(" OR ");
			try {
				const rows = this.db
					.prepare(
						`SELECT start_line, end_line
             FROM artifact_fts
             WHERE ref = ? AND artifact_fts MATCH ?
             ORDER BY bm25(artifact_fts)
             LIMIT 12`,
					)
					.all(ref, ftsExpr) as Array<{ start_line: number; end_line: number }>;
				if (rows.length > 0) candidateRanges = rows;
			} catch {
				candidateRanges = undefined;
			}
		}

		const scored: Array<{ line: number; score: number }> = [];
		const inspectRange = (startLine: number, endLine: number, rankBoost: number) => {
			for (let ln = startLine; ln <= endLine; ln++) {
				const lineText = (lines[ln - 1] ?? "").toLowerCase();
				if (!lineText) continue;
				let score = 0;
				if (lineText.includes(lowerQuery)) score += 10 + rankBoost;
				for (const tok of tokens) {
					if (lineText.includes(tok.toLowerCase())) score += 2;
				}
				if (score > 0) scored.push({ line: ln, score: score + rankBoost });
			}
		};

		if (candidateRanges) {
			for (let idx = 0; idx < candidateRanges.length; idx++) {
				const r = candidateRanges[idx]!;
				inspectRange(r.start_line, r.end_line, Math.max(0, 6 - idx));
			}
		}
		if (scored.length === 0) {
			inspectRange(1, lines.length, 0);
		}

		scored.sort((a, b) => b.score - a.score || a.line - b.line);
		const top = scored.slice(0, 20).map((s) => s.line);
		top.sort((a, b) => a - b);
		return [...new Set(top)];
	}

	private runGc(nowMs: number): void {
		if (this.readOnly) return;
		const cutoffMs = nowMs - this.minAgeMs;
		const pinned = this.pinnedRefs?.();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const totals = this.db
				.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(zlib_bytes)), 0) AS total_bytes FROM artifact_blobs`)
				.get() as { cnt?: number; total_bytes?: number } | undefined;
			let cnt = Number(totals?.cnt ?? 0);
			let totalBytes = Number(totals?.total_bytes ?? 0);
			if (totalBytes <= this.maxTotalBytes && cnt <= this.maxBlobCount) {
				this.db.exec("COMMIT");
				return;
			}

			const candidates = this.db
				.prepare(
					`SELECT ref, LENGTH(zlib_bytes) AS zlen FROM artifact_blobs
           WHERE created_at_ms < ?
           ORDER BY created_at_ms ASC`,
				)
				.all(cutoffMs) as Array<{ ref?: string; zlen?: number }>;

			const delBlob = this.db.prepare(`DELETE FROM artifact_blobs WHERE ref = ?`);
			const delFts = this.db.prepare(`DELETE FROM artifact_fts WHERE ref = ?`);
			const delSources = this.hasSourcesTable
				? this.db.prepare(`DELETE FROM artifact_sources WHERE ref = ?`)
				: undefined;

			for (const row of candidates) {
				if (totalBytes <= this.maxTotalBytes && cnt <= this.maxBlobCount) break;
				const ref = typeof row.ref === "string" ? row.ref : undefined;
				if (!ref || pinned?.has(ref)) continue;
				delBlob.run(ref);
				delFts.run(ref);
				delSources?.run(ref);
				cnt -= 1;
				totalBytes = Math.max(0, totalBytes - Number(row.zlen ?? 0));
			}
			this.db.exec("COMMIT");
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {
				// ignore rollback failure
			}
			throw err;
		}
	}

	private rowToMeta(row: Record<string, unknown>): ArtifactMeta {
		return {
			ref: String(row.ref),
			sha256: String(row.sha256),
			toolName: String(row.tool_name),
			byteLen: Number(row.byte_len),
			lineCount: Number(row.line_count),
			...(typeof row.source_path === "string" && row.source_path ? { sourcePath: row.source_path } : {}),
			...(typeof row.source_sha256 === "string" && row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
			...(typeof row.label === "string" && row.label ? { label: row.label } : {}),
			createdAtMs: Number(row.created_at_ms),
		};
	}
}

export function openNodeSlidingWindowArtifactStore(
	dbPath?: string,
	opts?: NodeArtifactStoreOptions,
): NodeSlidingWindowArtifactStore {
	return new NodeSlidingWindowArtifactStore(dbPath, opts);
}

export type ExportCheckpointedForkOptions =
	| (ExportCheckpointedForkStorageOptions & { readonly targetDbPath?: never; readonly tablePrefix?: never })
	| (Omit<ExportCheckpointedForkStorageOptions, "targetStorage" | "closeTargetStorage"> & {
			readonly targetDbPath: string;
			readonly tablePrefix?: string;
	  });

/**
 * Node SQLite wrapper around `exportCheckpointedForkToStorage` that opens a `SqliteStorage` at `targetDbPath`
 * (optionally scoped by `tablePrefix`), commits the checkpointed fork, forces `PRAGMA locking_mode = NORMAL` +
 * `PRAGMA wal_checkpoint(TRUNCATE)`, and closes the SQLite handle cleanly so sandboxed worker processes can open it.
 */
export async function exportCheckpointedFork(
	options: ExportCheckpointedForkOptions,
	context: Context,
): Promise<ExportCheckpointedForkResult> {
	if ("targetStorage" in options && options.targetStorage !== undefined) {
		return exportCheckpointedForkToStorage(options, context);
	}
	const targetDbPath = options.targetDbPath;
	if (!targetDbPath) {
		throw new Error("exportCheckpointedFork requires either targetStorage or targetDbPath");
	}
	const db = await openNodeSqliteDatabase(targetDbPath);
	const storage = await SqliteStorage.open(
		db,
		options.tablePrefix !== undefined ? { prefix: options.tablePrefix } : {},
	);
	try {
		return await exportCheckpointedForkToStorage(
			{
				...options,
				targetStorage: storage,
				closeTargetStorage: false,
			},
			context,
		);
	} finally {
		await db.run("PRAGMA locking_mode = NORMAL").catch(() => {});
		await db.run("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
		await storage.close(context).catch(() => {});
	}
}
