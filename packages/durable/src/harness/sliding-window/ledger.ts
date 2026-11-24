import type { ContextView } from "../types.ts";
import { formatBytes, formatTokens, isReadToolName } from "./bounds.ts";
import type { ArtifactMeta, MechanicalLedger, RawTurn } from "./types.ts";

export function createEmptyLedger(): MechanicalLedger {
	return { epoch: 0, turnCount: 0, filesRead: [], filesEdited: [], recentRefs: [], recentErrors: [] };
}

/** Deterministically reconstruct a MechanicalLedger by folding entries/contributions in a ContextView. */
export function reconstructLedgerFromView(view: ContextView): MechanicalLedger {
	let ledger = createEmptyLedger();
	if (view.head && typeof view.head.data === "object" && view.head.data !== null && !Array.isArray(view.head.data)) {
		const epoch = (view.head.data as Record<string, unknown>).epoch;
		if (typeof epoch === "number" && Number.isFinite(epoch)) {
			ledger = { ...ledger, epoch };
		}
	}
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	for (let i = 0; i < view.entries.length; i++) {
		if (view.head !== undefined && i === 0) continue;
		const msgs = view.contributions[i] ?? [];
		for (const msg of msgs) {
			if (msg.role === "assistant") {
				ledger = { ...ledger, turnCount: ledger.turnCount + 1 };
				for (const block of msg.content) {
					if (block.type === "toolCall") {
						calls.set(block.id, {
							name: block.name,
							args: (block.arguments ?? {}) as Record<string, unknown>,
						});
					}
				}
			} else if (msg.role === "toolResult") {
				const paired = calls.get(msg.toolCallId);
				const toolName = paired?.name ?? msg.toolName;
				const args = paired?.args;
				const details =
					msg.details && typeof msg.details === "object" && !Array.isArray(msg.details)
						? (msg.details as Record<string, unknown>)
						: undefined;
				const sw =
					details?.slidingWindow && typeof swRecord(details.slidingWindow) === "object"
						? swRecord(details.slidingWindow)
						: undefined;
				const sourcePath =
					typeof args?.path === "string"
						? args.path
						: typeof args?.file_path === "string"
							? args.file_path
							: typeof args?.filePath === "string"
								? args.filePath
								: undefined;
				const spilled: ArtifactMeta | undefined =
					sw && typeof sw.ref === "string"
						? {
								ref: sw.ref,
								sha256: typeof sw.sha256 === "string" ? sw.sha256 : "",
								toolName,
								byteLen: typeof sw.bytes === "number" ? sw.bytes : 0,
								lineCount: typeof sw.lines === "number" ? sw.lines : 0,
								...(sourcePath ? { sourcePath } : {}),
								...(typeof sw.sourceSha256 === "string" ? { sourceSha256: sw.sourceSha256 } : {}),
								createdAtMs: msg.timestamp,
							}
						: undefined;
				const errorText = msg.isError
					? msg.content
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("\n")
					: undefined;
				ledger = recordToolResult(ledger, toolName, args, {
					isError: msg.isError,
					...(spilled ? { spilled } : {}),
					...(errorText ? { errorText } : {}),
				});
			}
		}
	}
	return ledger;
}

function swRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function recordToolResult(
	ledger: MechanicalLedger,
	toolName: string,
	args: Record<string, unknown> | undefined,
	opts: { isError: boolean; spilled?: ArtifactMeta; sourceSha256?: string; errorText?: string },
): MechanicalLedger {
	let filesRead = [...ledger.filesRead];
	let filesEdited = [...ledger.filesEdited];
	let recentRefs = [...ledger.recentRefs];
	const recentErrors = [...ledger.recentErrors];
	const lower = toolName.toLowerCase();
	const path =
		typeof args?.path === "string"
			? args.path
			: typeof args?.file_path === "string"
				? args.file_path
				: typeof args?.filePath === "string"
					? args.filePath
					: undefined;

	if (!opts.isError && isReadToolName(toolName) && path) {
		const effectiveSourceSha = opts.spilled?.sourceSha256 ?? opts.sourceSha256;
		filesRead = filesRead.filter((r) => r.path !== path);
		filesRead.push({
			path,
			turn: ledger.turnCount,
			lastTurn: ledger.turnCount,
			...(opts.spilled ? { ref: opts.spilled.ref, lines: opts.spilled.lineCount } : {}),
			...(effectiveSourceSha ? { sha256: effectiveSourceSha, sourceSha256: effectiveSourceSha } : {}),
		});
		if (filesRead.length > 24) filesRead.shift();
	}
	if (!opts.isError && (lower === "edit" || lower === "write") && path) {
		filesEdited = filesEdited.filter((e) => e.path !== path);
		filesEdited.push({ path, op: lower === "write" ? "write" : "edit", lastTurn: ledger.turnCount });
		if (filesEdited.length > 24) filesEdited.shift();
	}
	if (opts.spilled) {
		recentRefs = recentRefs.filter((r) => r.ref !== opts.spilled!.ref);
		recentRefs.push(opts.spilled);
		if (recentRefs.length > 16) recentRefs.shift();
	}
	if (opts.isError && opts.errorText) {
		const line = `${toolName}: ${clip(opts.errorText, 160)}`;
		if (!recentErrors.includes(line)) recentErrors.push(line);
		if (recentErrors.length > 6) recentErrors.shift();
	}
	return { ...ledger, filesRead, filesEdited, recentRefs, recentErrors };
}

/** Prose only: user and assistant text plus tiny call markers. Tool output and thinking never reach the helper. */
export function buildProseTranscript(aged: readonly RawTurn[], maxChars = 48_000): string {
	const lines: string[] = [];
	for (const t of aged) {
		if (t.role === "user" && t.text.trim()) lines.push(`USER: ${clip(t.text, 2400)}`);
		else if (t.role === "assistant") {
			const marks = t.toolCalls?.length
				? ` [${t.toolCalls.map((c) => (c.label ? `${c.name}(${c.label})` : c.name)).join(", ")}]`
				: "";
			if (t.text.trim() || marks) lines.push(`ASSISTANT: ${clip(t.text, 2400)}${marks}`);
		}
	}
	const joined = lines.join("\n\n");
	return joined.length <= maxChars ? joined : `... [earlier prose truncated] ...\n\n${joined.slice(-maxChars)}`;
}

export function buildBatonPrompts(
	previousDigest: string | undefined,
	prose: string,
): { systemPrompt: string; userPrompt: string } {
	const systemPrompt = [
		"You maintain a tight conversational baton digest for a sliding-window session.",
		"Summarize STRICTLY the human<->assistant prose: user intent, corrections, preferences, rejected alternatives, agreed trade-offs, open questions.",
		"Do NOT list file paths, commit SHAs, ref:<hash> IDs, or line numbers; deterministic code renders those separately.",
		"Dense markdown bullets, 150-380 words, no preamble.",
	].join(" ");
	const parts: string[] = [];
	if (previousDigest?.trim()) parts.push(`## Prior Digest\n${previousDigest.trim()}`);
	parts.push(`## Aged-Out Prose To Fold In\n${prose || "(none)"}`);
	parts.push("Return the updated digest only.");
	return { systemPrompt, userPrompt: parts.join("\n\n") };
}

export function renderLedgerBlock(ledger: MechanicalLedger, extraSections?: readonly string[]): string {
	const out: string[] = ["### Mechanical Ledger (exact)"];
	if (extraSections) {
		for (const section of extraSections) {
			const trimmed = section.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	if (ledger.filesEdited.length) {
		out.push(`- **Modified files:** ${ledger.filesEdited.map((f) => `\`${f.path}\``).join(", ")}`);
	}
	if (ledger.filesRead.length) {
		out.push(
			`- **Inspected files:** ${ledger.filesRead
				.slice(-12)
				.map((r) => `\`${r.path}\`${r.ref ? ` (ref:${r.ref})` : ""}`)
				.join(", ")}`,
		);
	}
	if (ledger.recentRefs.length) {
		out.push("- **Spilled artifacts (`recall`):**");
		for (const r of ledger.recentRefs.slice(-10)) {
			out.push(
				`  - \`ref:${r.ref}\` (${r.toolName}: ${r.sourcePath ?? r.label ?? "output"}, ${r.lineCount}L, ${formatBytes(r.byteLen)})`,
			);
		}
	}
	if (ledger.recentErrors.length) {
		out.push("- **Recent errors:**");
		for (const e of ledger.recentErrors.slice(-4)) out.push(`  - ${e}`);
	}
	return out.join("\n");
}

export function renderBatonSummary(opts: {
	ledger: MechanicalLedger;
	proseDigest: string;
	epoch: number;
	tokensBefore: number;
	keptTokens: number;
	fallback?: boolean;
	extraSections?: readonly string[];
}): string {
	const mode = opts.fallback ? "burst-fallback" : `epoch ${opts.epoch}`;
	const tail = opts.keptTokens > 0 ? `kept ~${formatTokens(opts.keptTokens)} tail` : "clean baton";
	return [
		`<!-- sliding-window ${mode} • before ${formatTokens(opts.tokensBefore)} • ${tail} -->`,
		renderLedgerBlock(opts.ledger, opts.extraSections),
		"### Conversational Prose Digest",
		opts.proseDigest.trim() || "- (no prior prose constraints)",
	].join("\n\n");
}

export function fallbackProse(ledger: MechanicalLedger, recentUserPrompts: readonly string[]): string {
	const parts: string[] = [];
	if (ledger.lastProseDigest?.trim()) parts.push(ledger.lastProseDigest.trim());
	if (recentUserPrompts.length) {
		parts.push("- **Recent user requests (verbatim, helper had not finished):**");
		for (const p of recentUserPrompts.slice(-3)) parts.push(`  - ${clip(p, 260)}`);
	}
	return parts.length
		? parts.join("\n")
		: "- Burst fallback swapped before the prose helper finished; files/refs preserved above.";
}
