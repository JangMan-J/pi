import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { buildBatonPrompts } from "./ledger.ts";
import type { BatonResult, BatonThinkingLevel } from "./types.ts";

export interface BatonModelResolution {
	readonly model: Model<Api>;
	readonly thinkingLevel: BatonThinkingLevel;
	readonly source: "configured" | "same-provider-fast" | "active-fallback";
}

export interface ModelLookup {
	find(provider: string, id: string): Model<Api> | undefined;
	getAvailable(): readonly Model<Api>[];
}

const FAST_FRAGMENTS = ["ember", "flash-lite", "flash", "haiku", "luna", "mini", "nano", "highspeed", "fast"] as const;

/**
 * spec: "<provider>/<id>", "same" (active physical model), or "auto"
 * (fastest authed model on the active provider). An unavailable explicit target falls back to auto.
 */
export function resolveBatonModel(
	spec: string,
	thinkingLevel: BatonThinkingLevel,
	active: Model<Api> | undefined,
	lookup: ModelLookup,
): BatonModelResolution | undefined {
	const available = lookup.getAvailable().filter((m) => m.api !== "pi-virtual");
	const s = spec.trim();
	const slash = s.indexOf("/");
	if (s && s !== "same" && s !== "auto") {
		const hit =
			slash > 0
				? (available.find((m) => m.provider === s.slice(0, slash) && m.id === s.slice(slash + 1)) ??
					lookup.find(s.slice(0, slash), s.slice(slash + 1)))
				: available.find((m) => m.id === s);
		if (hit && hit.api !== "pi-virtual") return { model: hit, thinkingLevel, source: "configured" };
	}
	if (s === "same" && active && active.api !== "pi-virtual") {
		return { model: active, thinkingLevel, source: "active-fallback" };
	}
	if (active && active.api !== "pi-virtual") {
		const sameProvider = available.filter((m) => m.provider === active.provider);
		for (const frag of FAST_FRAGMENTS) {
			const hit = sameProvider.find((m) => m.id.toLowerCase().includes(frag));
			if (hit) return { model: hit, thinkingLevel, source: "same-provider-fast" };
		}
		return { model: active, thinkingLevel, source: "active-fallback" };
	}
	return available[0] ? { model: available[0], thinkingLevel, source: "active-fallback" } : undefined;
}

export function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

export type CompleteFn = (
	model: Model<Api>,
	context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
	options: { reasoning?: Exclude<BatonThinkingLevel, "off">; maxTokens: number; signal?: AbortSignal },
) => Promise<AssistantMessage>;

export async function runBatonSynthesis(req: {
	model: Model<Api>;
	thinkingLevel: BatonThinkingLevel;
	maxTokens: number;
	previousDigest?: string;
	prose: string;
	signal?: AbortSignal;
	complete: CompleteFn;
}): Promise<BatonResult> {
	const started = Date.now();
	const { systemPrompt, userPrompt } = buildBatonPrompts(req.previousDigest, req.prose);
	const reasoning = req.thinkingLevel === "off" || !req.model.reasoning ? undefined : req.thinkingLevel;
	const response = await req.complete(
		req.model,
		{ systemPrompt, messages: [{ role: "user", content: userPrompt, timestamp: started }] },
		{ ...(reasoning ? { reasoning } : {}), maxTokens: req.maxTokens, ...(req.signal ? { signal: req.signal } : {}) },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `baton helper ${response.stopReason}`);
	}
	const proseDigest = assistantText(response);
	if (!proseDigest) throw new Error("baton helper returned an empty digest");
	return { proseDigest, model: req.model, usage: response.usage, durationMs: Date.now() - started };
}
