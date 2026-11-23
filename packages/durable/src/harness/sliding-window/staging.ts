import { utf8ByteLength } from "@earendil-works/chord/output";
import type { StagedSlice } from "./types.ts";

function normalizePosix(raw: string): string {
	const slash = raw.replaceAll("\\", "/");
	const absolute = slash.startsWith("/");
	const driveMatch = /^[A-Za-z]:\//.exec(slash);
	const prefix = driveMatch ? driveMatch[0] : absolute ? "/" : "";
	const body = prefix ? slash.slice(prefix.length) : slash;
	const parts: string[] = [];
	for (const part of body.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
			else if (!prefix) parts.push("..");
			continue;
		}
		parts.push(part);
	}
	return `${prefix}${parts.join("/")}` || ".";
}

function isAbsolutePortable(p: string): boolean {
	return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export function normalizeSliceKey(p: string, cwd?: string): string {
	if (isAbsolutePortable(p)) return normalizePosix(p);
	if (cwd) return normalizePosix(`${cwd.replaceAll("\\", "/")}/${p}`);
	return normalizePosix(p);
}

/**
 * Verbatim read text the model sees for a turn or two via ModelRoute.ephemeralTail, never written to history.
 * Evicted on a successful edit/write of that path, or after ttlTurns.
 */
export class EphemeralSliceStage {
	private readonly slices = new Map<string, StagedSlice>();
	private opts: { maxTotalBytes: number; ttlTurns: number };
	constructor(opts: { maxTotalBytes: number; ttlTurns: number }) {
		this.opts = opts;
	}

	configure(opts: { maxTotalBytes: number; ttlTurns: number }): void {
		this.opts = opts;
		this.enforce();
	}

	stage(o: { path: string; cwd?: string; ref: string; text: string }): boolean {
		const bytes = utf8ByteLength(o.text);
		if (bytes > this.opts.maxTotalBytes) return false;
		const key = normalizeSliceKey(o.path, o.cwd);
		this.slices.delete(key);
		this.slices.set(key, { key, path: o.path, ref: o.ref, text: o.text, bytes, ttlTurns: this.opts.ttlTurns });
		this.enforce();
		return true;
	}

	evict(path: string, cwd?: string): boolean {
		return this.slices.delete(normalizeSliceKey(path, cwd));
	}

	/** Call once per completed turn. */
	advanceTurn(): void {
		for (const [k, s] of this.slices) {
			if (s.ttlTurns <= 1) this.slices.delete(k);
			else s.ttlTurns -= 1;
		}
	}

	clear(): void {
		this.slices.clear();
	}

	list(): readonly StagedSlice[] {
		return [...this.slices.values()];
	}

	totalBytes(): number {
		let n = 0;
		for (const s of this.slices.values()) n += s.bytes;
		return n;
	}

	render(): string | undefined {
		if (this.slices.size === 0) return undefined;
		return [...this.slices.values()]
			.map((s) => {
				const safeText = s.text.replace(/<\/working_slice/gi, "<\\/working_slice");
				return `<working_slice path=${JSON.stringify(s.path)} ref=${JSON.stringify(s.ref)} ephemeral="true">\n${safeText}\n</working_slice>`;
			})
			.join("\n\n");
	}

	private enforce(): void {
		let total = this.totalBytes();
		for (const [k, s] of this.slices) {
			if (total <= this.opts.maxTotalBytes) break;
			this.slices.delete(k);
			total -= s.bytes;
		}
	}
}
