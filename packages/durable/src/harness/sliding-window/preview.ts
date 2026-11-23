import { formatBytes, isReadToolName, isSearchToolName } from "./bounds.ts";
import type { ArtifactMeta, BuildPreviewOptions, SymbolSpan } from "./types.ts";

const SYMBOL_PATTERNS: ReadonlyArray<{ kind: string; regex: RegExp }> = [
	{ kind: "fn", regex: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "class", regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "iface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "type", regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/ },
	{ kind: "enum", regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
	{ kind: "const", regex: /^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/ },
	{ kind: "fn", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
	{ kind: "struct", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/ },
	{ kind: "enum", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/ },
	{ kind: "trait", regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/ },
	{ kind: "impl", regex: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_:][\w:<>,\s]*?)\s*\{/ },
	{ kind: "py", regex: /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][\w]*)/ },
	{ kind: "go", regex: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/ },
	{ kind: "h", regex: /^(#{1,3})\s+(.+)$/ },
];

/**
 * Deterministic declaration/heading scanner (zero LLM calls).
 * Produces a compact jump table with [startLine–endLine] spans so the model can recall exact blocks.
 */
export function extractSymbolOutline(lines: readonly string[], maxItems = 40): SymbolSpan[] {
	const rawHits: Array<{ kind: string; name: string; line: number }> = [];
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i] ?? "";
		// strip optional read-tool line number prefix like "  120\t" or "120: "
		const line = rawLine.replace(/^\s*\d+\s*[\t:|]\s?/, "");
		for (const { kind, regex } of SYMBOL_PATTERNS) {
			const m = regex.exec(line);
			if (!m) continue;
			if (kind === "h") {
				rawHits.push({ kind: m[1]!, name: m[2]!.trim().slice(0, 72), line: i + 1 });
			} else {
				rawHits.push({ kind, name: m[1]!.trim().slice(0, 64), line: i + 1 });
			}
			break;
		}
	}
	if (rawHits.length === 0) return [];

	const spans: SymbolSpan[] = rawHits.map((hit, idx) => {
		const next = rawHits[idx + 1];
		const endLine = next ? Math.max(hit.line, next.line - 1) : lines.length;
		return {
			kind: hit.kind,
			name: hit.name,
			startLine: hit.line,
			endLine,
		};
	});

	if (spans.length <= maxItems) return spans;
	return spans.slice(0, maxItems);
}

function clipLine(line: string, maxCols = 140): string {
	return line.length <= maxCols ? line : `${line.slice(0, maxCols - 1)}…`;
}

function buildReadPreview(rawText: string, meta: ArtifactMeta, stagedInEphemeralTail: boolean): string {
	const lines = rawText.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const shaTag = meta.sourceSha256 ? ` • sha256:${meta.sourceSha256.slice(0, 8)}` : "";
	const pathLabel = meta.sourcePath ?? meta.label ?? "file";
	const header = `[read ${pathLabel} • ${meta.lineCount} lines (${formatBytes(meta.byteLen)})${shaTag} • ref:${meta.ref}]`;

	const outline = extractSymbolOutline(lines, 35);
	const body: string[] = [header];

	if (outline.length > 0) {
		body.push("Outline:");
		for (const sym of outline) {
			const span = sym.startLine === sym.endLine ? `L${sym.startLine}` : `L${sym.startLine}–L${sym.endLine}`;
			body.push(`  ${span.padEnd(11, " ")} ${sym.kind.padEnd(6, " ")} ${sym.name}`);
		}
	} else {
		const headCount = Math.min(12, lines.length);
		for (let i = 0; i < headCount; i++) {
			body.push(`  ${String(i + 1).padStart(4, " ")} | ${clipLine(lines[i]!)}`);
		}
		if (lines.length > headCount) {
			body.push(`  ... (${lines.length - headCount} more lines)`);
		}
	}

	if (stagedInEphemeralTail) {
		body.push(
			`[Full text attached in active working set for this turn; for later turns call recall(ref="${meta.ref}", startLine, endLine) or query="..."]`,
		);
	} else {
		body.push(
			`[Call recall(ref="${meta.ref}", startLine, endLine) or recall(ref="${meta.ref}", query="...") for exact lines]`,
		);
	}
	return body.join("\n");
}

function buildSearchPreview(toolName: string, rawText: string, meta: ArtifactMeta): string {
	const lines = rawText.split("\n").filter((l) => l.trim().length > 0);
	const byFile = new Map<string, number[]>();
	let plainFiles = 0;

	for (const line of lines) {
		const grepMatch = /^([^:\n\0]+?):(\d+)[:-]/.exec(line);
		if (grepMatch) {
			const file = grepMatch[1]!.trim();
			const lineNo = Number.parseInt(grepMatch[2]!, 10);
			const arr = byFile.get(file) ?? [];
			if (arr.length < 8 && !arr.includes(lineNo)) arr.push(lineNo);
			byFile.set(file, arr);
			continue;
		}
		if (!line.startsWith("[") && !line.startsWith(" ") && (line.includes("/") || line.includes("."))) {
			plainFiles += 1;
		}
	}

	const header = `[${toolName} • ${meta.lineCount} lines (${formatBytes(meta.byteLen)}) • ref:${meta.ref}]`;
	const out: string[] = [header];

	if (byFile.size > 0) {
		out.push(`Grouped hits (${byFile.size} file${byFile.size === 1 ? "" : "s"}):`);
		let shown = 0;
		for (const [file, lineNos] of byFile) {
			if (shown >= 24) {
				out.push(`  ... (+${byFile.size - shown} more files)`);
				break;
			}
			const locs = lineNos.map((n) => `L${n}`).join(", ");
			out.push(`  ${file} (${locs})`);
			shown += 1;
		}
	} else {
		const sample = lines.slice(0, 18);
		for (const s of sample) out.push(`  ${clipLine(s)}`);
		if (lines.length > sample.length) {
			out.push(
				`  ... (+${lines.length - sample.length} more entries${plainFiles ? ` across ~${plainFiles} paths` : ""})`,
			);
		}
	}

	out.push(`[Call recall(ref="${meta.ref}", query="...") or recall(ref="${meta.ref}", startLine, endLine)]`);
	return out.join("\n");
}

const ERROR_SIGNAL_RE =
	/\b(?:error|err!|failed|failure|fatal|panic|exception|traceback|undefined is not|syntaxerror|typeerror)\b/i;

function buildShellPreview(toolName: string, rawText: string, meta: ArtifactMeta, isError: boolean): string {
	const lines = rawText.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") lines.pop();

	const statusTag = isError ? "error" : "ok";
	const out: string[] = [
		`[${toolName} (${statusTag}) • ${meta.lineCount} lines (${formatBytes(meta.byteLen)}) • ref:${meta.ref}]`,
	];

	const headEnd = Math.min(8, lines.length);
	const tailStart = Math.max(headEnd, lines.length - 10);

	if (headEnd > 0) {
		out.push("Head:");
		for (let i = 0; i < headEnd; i++) {
			out.push(`  ${String(i + 1).padStart(5, " ")} | ${clipLine(lines[i]!)}`);
		}
	}

	const errorLines: Array<{ ln: number; text: string }> = [];
	for (let i = headEnd; i < tailStart; i++) {
		const line = lines[i]!;
		if (ERROR_SIGNAL_RE.test(line)) {
			errorLines.push({ ln: i + 1, text: line });
			if (errorLines.length >= 12) break;
		}
	}

	if (errorLines.length > 0) {
		out.push(`Diagnostic lines (${errorLines.length}):`);
		for (const hit of errorLines) {
			out.push(`  ${String(hit.ln).padStart(5, " ")} | ${clipLine(hit.text)}`);
		}
	} else if (tailStart > headEnd) {
		out.push(`  ... (${tailStart - headEnd} middle lines omitted) ...`);
	}

	if (tailStart < lines.length) {
		out.push("Tail:");
		for (let i = tailStart; i < lines.length; i++) {
			out.push(`  ${String(i + 1).padStart(5, " ")} | ${clipLine(lines[i]!)}`);
		}
	}

	out.push(`[Call recall(ref="${meta.ref}", query="...") or recall(ref="${meta.ref}", startLine, endLine)]`);
	return out.join("\n");
}

function buildGenericPreview(toolName: string, rawText: string, meta: ArtifactMeta): string {
	const trimmed = rawText.trim();
	const out: string[] = [`[${toolName} • ${meta.lineCount} lines (${formatBytes(meta.byteLen)}) • ref:${meta.ref}]`];

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				out.push(`JSON array: ${parsed.length} item(s)`);
			} else if (parsed && typeof parsed === "object") {
				const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 14);
				const summary = entries
					.map(([k, v]) => {
						if (Array.isArray(v)) return `${k}: [${v.length}]`;
						if (v && typeof v === "object") return `${k}: {...}`;
						return `${k}: ${JSON.stringify(v)?.slice(0, 36)}`;
					})
					.join(", ");
				out.push(`JSON keys: { ${summary} }`);
			}
		} catch {
			// fall through to line preview
		}
	}

	const lines = rawText.split("\n");
	const take = Math.min(14, lines.length);
	for (let i = 0; i < take; i++) {
		out.push(`  ${String(i + 1).padStart(4, " ")} | ${clipLine(lines[i]!)}`);
	}
	if (lines.length > take) {
		out.push(`  ... (+${lines.length - take} more lines)`);
	}
	out.push(`[Call recall(ref="${meta.ref}", query="...") or recall(ref="${meta.ref}", startLine, endLine)]`);
	return out.join("\n");
}

export function buildMechanicalPreview(options: BuildPreviewOptions): string {
	const lower = options.toolName.toLowerCase();
	if (isReadToolName(options.toolName)) {
		return buildReadPreview(options.rawText, options.meta, Boolean(options.stagedInEphemeralTail));
	}
	if (isSearchToolName(options.toolName)) {
		return buildSearchPreview(options.toolName, options.rawText, options.meta);
	}
	if (lower === "bash" || lower === "powershell" || lower.includes("exec")) {
		return buildShellPreview(options.toolName, options.rawText, options.meta, Boolean(options.isError));
	}
	return buildGenericPreview(options.toolName, options.rawText, options.meta);
}
