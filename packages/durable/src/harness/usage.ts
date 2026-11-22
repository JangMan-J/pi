import type { Draft } from "@earendil-works/chord/delta";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { Usage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { ConversationId, Tx } from "../types.ts";

/** Ledger of one conversation's own spend: its entries, compaction summarization attempts, and sidecar calls. */
export type UsageState = {
	/** Assistant entries and summarization attempts, keyed `provider/modelId`. */
	models: Record<string, JsonRepresentation<Usage>>;
	/** Tool results, keyed by tool name; their usage has no model identity. */
	tools: Record<string, JsonRepresentation<Usage>>;
	/** Sidecar / virtual-model helper or draft spend, keyed `<kind>:<provider>/<modelId>`. Lazily initialized. */
	sidecars?: Record<string, JsonRepresentation<Usage>>;
};

export const UsageDoc = defineDoc<UsageState>({
	kind: "pi.usage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ models: {}, tools: {} }),
	checkpointWhen: () => true,
});

/** Add `usage` to one bucket of the conversation's `pi.usage`, in the commit that records the response. */
export async function recordUsage(
	tx: Tx,
	conversationId: ConversationId,
	bucket: keyof UsageState,
	key: string,
	usage: Usage,
): Promise<void> {
	const state = await tx.doc(UsageDoc, conversationId);
	if (state[bucket] === undefined) state[bucket] = {};
	const totals = state[bucket]!;
	// Own keys only: a tool may be called `toString`.
	const total = Object.hasOwn(totals, key) ? totals[key] : undefined;
	// Providers may leave optional counters `undefined`; drafts take strict JSON.
	if (total === undefined)
		totals[key] = copyJson(usage, { omitUndefinedProperties: true }) as JsonRepresentation<Usage>;
	else addUsage(total, usage);
}

/** Record sidecar / virtual-model helper or draft spend in `pi.usage.sidecars`. */
export function recordSidecarUsage(
	tx: Tx,
	conversationId: ConversationId,
	kind: string,
	provider: string,
	modelId: string,
	usage: Usage,
): Promise<void> {
	return recordUsage(tx, conversationId, "sidecars", `${kind}:${provider}/${modelId}`, usage);
}

/** Add every counter of `usage` to `total`; optional counters are added once either side reports them. */
export function addUsage(total: Draft<Usage> | Usage, usage: Usage): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost.input;
	total.cost.output += usage.cost.output;
	total.cost.cacheRead += usage.cost.cacheRead;
	total.cost.cacheWrite += usage.cost.cacheWrite;
	total.cost.total += usage.cost.total;
}

/** Add every bucket of `state` into `sum`. */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools", "sidecars"] as const) {
		const source = state[bucket];
		if (source === undefined) continue;
		if (bucket === "sidecars" && sum.sidecars === undefined) sum.sidecars = {};
		const target = bucket === "sidecars" ? sum.sidecars! : sum[bucket];
		for (const [key, usage] of Object.entries(source)) {
			const total = Object.hasOwn(target, key) ? target[key] : undefined;
			// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
			if (total !== undefined) addUsage(total, usage);
			else
				Object.defineProperty(target, key, {
					value: structuredClone(usage),
					enumerable: true,
					writable: true,
				});
		}
	}
}
