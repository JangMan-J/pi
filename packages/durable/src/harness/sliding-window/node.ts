import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import { normalizeRefId } from "./memory-store.ts";
import type {
	ArtifactMeta,
	PutArtifactOptions,
	RecallOptions,
	RecallResult,
	SlidingWindowArtifactStore,
} from "./types.ts";

const CHUNK_LINES = 80;
const DEFAULT_MAX_RECALL_LINES = 140;
const DEFAULT_CONTEXT_LINES = 4;
const MAX_SOURCE_HASH_BYTES = 16 * 1024 * 1024;

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

export { normalizeRefId };

export function hashLiveFile(sourcePath: string, cwd?: string): { resolvedPath: string; sha256: string | null } {
	const resolvedPath = isAbsolute(sourcePath) ? sourcePath : resolve(cwd ?? process.cwd(), sourcePath);
	try {
		if (!existsSync(resolvedPath)) return { resolvedPath, sha256: null };
		const st = statSync(resolvedPath);
		if (!st.isFile() || st.size > MAX_SOURCE_HASH_BYTES) return { resolvedPath, sha256: null };
		return { resolvedPath, sha256: sha256Hex(readFileSync(resolvedPath)) };
	} catch {
		return { resolvedPath, sha256: null };
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
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(dbPath = ":memory:") {
		this.dbPath = dbPath;
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		this.db = new DatabaseSync(dbPath);
		this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

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

      CREATE TABLE IF NOT EXISTS artifact_chunks (
        ref TEXT NOT NULL,
        chunk_idx INTEGER NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (ref, chunk_idx)
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
        ref UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        text
      );
    `);
	}

	put(rawText: string, options: PutArtifactOptions): ArtifactMeta {
		const sha256 = sha256Hex(rawText);
		const existing = this.db
			.prepare(
				`SELECT ref, sha256, tool_name, byte_len, line_count, source_path, source_sha256, label, created_at_ms
         FROM artifact_blobs WHERE sha256 = ?`,
			)
			.get(sha256) as Record<string, unknown> | undefined;

		const liveHash = options.sourcePath !== undefined ? hashLiveFile(options.sourcePath, options.cwd) : undefined;

		if (existing) {
			if (liveHash?.sha256 && existing.source_sha256 !== liveHash.sha256) {
				this.db
					.prepare(`UPDATE artifact_blobs SET source_path = ?, source_sha256 = ? WHERE ref = ?`)
					.run(options.sourcePath ?? null, liveHash.sha256, String(existing.ref));
			}
			return this.rowToMeta({
				...existing,
				...(liveHash?.sha256 ? { source_path: options.sourcePath, source_sha256: liveHash.sha256 } : {}),
			});
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
		const createdAtMs = options.nowMs ?? Date.now();

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
					options.sourcePath ?? null,
					liveHash?.sha256 ?? null,
					options.label ?? options.sourcePath ?? null,
					createdAtMs,
					compressed,
				);

			const insertChunk = this.db.prepare(
				`INSERT INTO artifact_chunks (ref, chunk_idx, start_line, end_line, text) VALUES (?, ?, ?, ?, ?)`,
			);
			const insertFts = this.db.prepare(
				`INSERT INTO artifact_fts (ref, start_line, end_line, text) VALUES (?, ?, ?, ?)`,
			);

			for (let idx = 0, start = 0; start < lines.length; idx += 1, start += CHUNK_LINES) {
				const slice = lines.slice(start, start + CHUNK_LINES);
				const startLine = start + 1;
				const endLine = start + slice.length;
				const chunkText = slice.join("\n");
				insertChunk.run(ref, idx, startLine, endLine, chunkText);
				insertFts.run(ref, startLine, endLine, chunkText);
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

		return {
			ref,
			sha256,
			toolName: options.toolName,
			byteLen,
			lineCount,
			...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
			...(liveHash?.sha256 ? { sourceSha256: liveHash.sha256 } : {}),
			...((options.label ?? options.sourcePath) ? { label: options.label ?? options.sourcePath } : {}),
			createdAtMs,
		};
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
		if (meta.sourcePath && meta.sourceSha256) {
			const live = hashLiveFile(meta.sourcePath, options.cwd);
			if (live.sha256 !== meta.sourceSha256) {
				staleSource = {
					path: meta.sourcePath,
					snapshotSha256: meta.sourceSha256,
					currentSha256: live.sha256,
				};
				notices.push(
					`[stale snapshot: ${meta.sourcePath} changed on disk since ref:${meta.ref}; call read("${meta.sourcePath}") for live bytes]`,
				);
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

export function openNodeSlidingWindowArtifactStore(dbPath?: string): NodeSlidingWindowArtifactStore {
	return new NodeSlidingWindowArtifactStore(dbPath);
}
