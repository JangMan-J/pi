import { utf8ByteLength } from "@earendil-works/chord/output";
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

const DEFAULT_MAX_RECALL_LINES = 140;
const DEFAULT_CONTEXT_LINES = 4;

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

const textEncoder = new TextEncoder();

/** Pure-TS synchronous SHA-256 hex digest (zero Node built-ins; safe in browsers and Workers). */
export function portableSha256Hex(input: string): string {
	const bytes = textEncoder.encode(input);
	const bitLen = bytes.length * 8;
	const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
	view.setUint32(paddedLen - 4, bitLen >>> 0, false);

	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;

	const w = new Uint32Array(64);
	for (let offset = 0; offset < paddedLen; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
		for (let i = 16; i < 64; i++) {
			const x0 = w[i - 15]!;
			const x1 = w[i - 2]!;
			const s0 = ((x0 >>> 7) | (x0 << 25)) ^ ((x0 >>> 18) | (x0 << 14)) ^ (x0 >>> 3);
			const s1 = ((x1 >>> 17) | (x1 << 15)) ^ ((x1 >>> 19) | (x1 << 13)) ^ (x1 >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}

export function normalizeRefId(raw: string): string {
	const trimmed = raw.trim();
	return trimmed.startsWith("ref:") ? trimmed.slice(4).trim() : trimmed;
}

function splitLinesPreserve(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	return lines;
}

function queryTokens(query: string): string[] {
	const matches = query.match(/[A-Za-z0-9_]{2,}/g) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of matches) {
		const lower = token.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(lower);
		if (out.length >= 8) break;
	}
	return out;
}

/**
 * Pure TypeScript in-memory implementation of `SlidingWindowArtifactStore` for browsers, Cloudflare Workers,
 * tests, and default fallback when no Node SQLite store is supplied.
 */
export class MemorySlidingWindowArtifactStore implements SlidingWindowArtifactStore {
	private readonly byRef = new Map<string, { meta: ArtifactMeta; rawText: string; lines: string[] }>();
	private readonly refBySha = new Map<string, string>();
	private readonly bySourceKey = new Map<
		string,
		{ ref: string; sourcePath: string; sourceSha256: string; updatedAtMs: number }
	>();

	put(rawText: string, options: PutArtifactOptions): ArtifactMeta {
		const sha256 = portableSha256Hex(rawText);
		const nowMs = options.nowMs ?? Date.now();
		const canBindSource = options.bindSource !== false && Boolean(options.sourcePath);
		const existingRef = this.refBySha.get(sha256);
		if (existingRef !== undefined) {
			const existing = this.byRef.get(existingRef)!;
			if (canBindSource && options.sourcePath) {
				const key = `${options.cwd ?? ""}\0${normalizeSliceKey(options.sourcePath, options.cwd)}`;
				this.bySourceKey.set(key, {
					ref: existing.meta.ref,
					sourcePath: options.sourcePath,
					sourceSha256: sha256,
					updatedAtMs: nowMs,
				});
			}
			if (!canBindSource) {
				const { sourcePath: _sp, sourceSha256: _ss, ...rest } = existing.meta;
				return {
					...rest,
					...((options.label ?? existing.meta.label) ? { label: options.label ?? existing.meta.label } : {}),
				};
			}
			return {
				...existing.meta,
				...(options.sourcePath ? { sourcePath: options.sourcePath, sourceSha256: sha256 } : {}),
			};
		}
		let prefixLen = 12;
		let ref = sha256.slice(0, prefixLen);
		while (this.byRef.has(ref) && prefixLen < sha256.length) {
			prefixLen += 4;
			ref = sha256.slice(0, prefixLen);
		}
		const lines = splitLinesPreserve(rawText);
		const meta: ArtifactMeta = {
			ref,
			sha256,
			toolName: options.toolName,
			byteLen: utf8ByteLength(rawText),
			lineCount: lines.length,
			...(canBindSource && options.sourcePath ? { sourcePath: options.sourcePath, sourceSha256: sha256 } : {}),
			...((options.label ?? (canBindSource ? options.sourcePath : undefined))
				? { label: options.label ?? options.sourcePath }
				: {}),
			createdAtMs: nowMs,
		};
		this.byRef.set(ref, { meta, rawText, lines });
		this.refBySha.set(sha256, ref);
		if (canBindSource && options.sourcePath) {
			const key = `${options.cwd ?? ""}\0${normalizeSliceKey(options.sourcePath, options.cwd)}`;
			this.bySourceKey.set(key, {
				ref,
				sourcePath: options.sourcePath,
				sourceSha256: sha256,
				updatedAtMs: nowMs,
			});
		}
		return meta;
	}

	getMeta(rawRef: string): ArtifactMeta | undefined {
		const ref = normalizeRefId(rawRef);
		const direct = this.byRef.get(ref);
		if (direct) return direct.meta;
		const mapped = this.refBySha.get(ref);
		return mapped ? this.byRef.get(mapped)?.meta : undefined;
	}

	readFullText(rawRef: string): string | undefined {
		const ref = normalizeRefId(rawRef);
		const direct = this.byRef.get(ref);
		if (direct) return direct.rawText;
		const mapped = this.refBySha.get(ref);
		return mapped ? this.byRef.get(mapped)?.rawText : undefined;
	}

	getLatestBySourcePath(sourcePath: string, cwd?: string): StoredArtifactEntry | undefined {
		const norm = normalizeSliceKey(sourcePath, cwd);
		const exactKey = `${cwd ?? ""}\0${norm}`;
		let source = this.bySourceKey.get(exactKey);
		if (!source) {
			for (const entry of this.bySourceKey.values()) {
				if (normalizeSliceKey(entry.sourcePath, cwd) === norm) {
					if (!source || entry.updatedAtMs >= source.updatedAtMs) source = entry;
				}
			}
		}
		if (!source) return undefined;
		const stored = this.byRef.get(source.ref);
		if (!stored) return undefined;
		return {
			meta: {
				...stored.meta,
				sourcePath: source.sourcePath,
				sourceSha256: source.sourceSha256,
			},
			text: stored.rawText,
		};
	}

	listRecent(limit = 50): ArtifactMeta[] {
		const all = [...this.byRef.values()].map((entry) => entry.meta);
		all.sort((a, b) => b.createdAtMs - a.createdAtMs);
		return all.slice(0, Math.max(1, Math.min(500, limit)));
	}

	recall(options: RecallOptions): RecallResult {
		const ref = normalizeRefId(options.ref);
		const entry =
			this.byRef.get(ref) ?? (this.refBySha.has(ref) ? this.byRef.get(this.refBySha.get(ref)!) : undefined);
		if (!entry) {
			return {
				found: false,
				text: `[sliding-window recall] Unknown artifact ref:${ref}. Re-run the tool or check active refs.`,
				returnedLines: 0,
			};
		}

		const { meta, lines } = entry;
		const maxLines = Math.max(1, Math.min(400, options.maxLines ?? DEFAULT_MAX_RECALL_LINES));
		const contextLines = Math.max(0, Math.min(30, options.contextLines ?? DEFAULT_CONTEXT_LINES));

		if (options.query && options.query.trim().length > 0) {
			const query = options.query.trim();
			const lowerQuery = query.toLowerCase();
			const tokens = queryTokens(query);
			const scored: Array<{ line: number; score: number }> = [];
			for (let i = 0; i < lines.length; i++) {
				const lower = lines[i]!.toLowerCase();
				if (!lower) continue;
				let score = 0;
				if (lower.includes(lowerQuery)) score += 10;
				for (const tok of tokens) {
					if (lower.includes(tok)) score += 2;
				}
				if (score > 0) scored.push({ line: i + 1, score });
			}
			scored.sort((a, b) => b.score - a.score || a.line - b.line);
			const matchedLineNumbers = [...new Set(scored.slice(0, 20).map((s) => s.line))].sort((a, b) => a - b);

			if (matchedLineNumbers.length === 0) {
				return {
					found: true,
					meta,
					text: `[ref:${meta.ref} • ${meta.toolName}${meta.sourcePath ? ` • ${meta.sourcePath}` : ""} • ${lines.length} lines] No lines matched "${query}".`,
					returnedLines: 0,
				};
			}

			const windows: Array<{ start: number; end: number }> = [];
			for (const lineNo of matchedLineNumbers) {
				const start = Math.max(1, lineNo - contextLines);
				const end = Math.min(lines.length, lineNo + contextLines);
				const prev = windows.at(-1);
				if (prev && start <= prev.end + 2) prev.end = Math.max(prev.end, end);
				else windows.push({ start, end });
			}

			const rendered: string[] = [
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
			return { found: true, meta, text: rendered.join("\n"), returnedLines: emitted };
		}

		const startLine = Math.max(1, Math.min(Math.max(1, lines.length), options.startLine ?? 1));
		const requestedEnd =
			options.endLine !== undefined ? Math.max(startLine, options.endLine) : startLine + maxLines - 1;
		const endLine = Math.min(lines.length, startLine + maxLines - 1, requestedEnd);

		const rendered: string[] = [
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
		return { found: true, meta, text: rendered.join("\n"), returnedLines: emitted };
	}

	close(): void {
		this.byRef.clear();
		this.refBySha.clear();
		this.bySourceKey.clear();
	}
}

/**
 * Layer a writable scratch artifact store in front of zero or more read-only fallback stores
 * (e.g. parent session `.artifacts.sqlite` opened with `{ readOnly: true }`).
 * All writes (`put`) go strictly to `writable`; reads search `writable` first, then fallbacks in order.
 */
export function createLayeredArtifactStore(
	writable: SlidingWindowArtifactStore,
	readOnlyFallbacks: readonly SlidingWindowArtifactStore[],
): SlidingWindowArtifactStore {
	const allStores = [writable, ...readOnlyFallbacks];
	return {
		put(rawText: string, options: PutArtifactOptions): ArtifactMeta | Promise<ArtifactMeta> {
			return writable.put(rawText, options);
		},
		async recall(options: RecallOptions): Promise<RecallResult> {
			let lastResult: RecallResult | undefined;
			for (const store of allStores) {
				const res = await store.recall(options);
				if (res.found) return res;
				lastResult = res;
			}
			return (
				lastResult ?? {
					found: false,
					text: `[sliding-window recall] Unknown artifact ref:${normalizeRefId(options.ref)}.`,
					returnedLines: 0,
				}
			);
		},
		async getMeta(rawRef: string): Promise<ArtifactMeta | undefined> {
			for (const store of allStores) {
				if (!store.getMeta) continue;
				const meta = await store.getMeta(rawRef);
				if (meta) return meta;
			}
			return undefined;
		},
		async readFullText(rawRef: string): Promise<string | undefined> {
			for (const store of allStores) {
				if (store.readFullText) {
					const text = await store.readFullText(rawRef);
					if (text !== undefined) return text;
				}
			}
			return undefined;
		},
		async getLatestBySourcePath(sourcePath: string, cwd?: string): Promise<StoredArtifactEntry | undefined> {
			for (const store of allStores) {
				if (!store.getLatestBySourcePath) continue;
				const hit = await store.getLatestBySourcePath(sourcePath, cwd);
				if (hit) return hit;
			}
			return undefined;
		},
		async readLiveFile(sourcePath: string, cwd?: string): Promise<LiveFileSnapshot | undefined> {
			for (const store of allStores) {
				if (!store.readLiveFile) continue;
				const hit = await store.readLiveFile(sourcePath, cwd);
				if (hit) return hit;
			}
			return undefined;
		},
		async listRecent(limit = 50): Promise<ArtifactMeta[]> {
			const byRef = new Map<string, ArtifactMeta>();
			for (const store of allStores) {
				if (!store.listRecent) continue;
				const items = await store.listRecent(limit);
				for (const item of items) {
					const prev = byRef.get(item.ref);
					if (!prev || item.createdAtMs > prev.createdAtMs) byRef.set(item.ref, item);
				}
			}
			return [...byRef.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, Math.max(1, limit));
		},
		async close(): Promise<void> {
			for (const store of allStores) {
				await store.close?.();
			}
		},
	};
}
