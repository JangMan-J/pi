import { defineDoc } from "../../documents.ts";
import type { ConversationId, EntryId, Seq } from "../../types.ts";
import { createEmptyLedger } from "./ledger.ts";
import type { MechanicalLedger, SlidingWindowHydratePolicy, SlidingWindowTargetValue } from "./types.ts";

export type SlidingWindowStateValue = {
	enabled?: boolean;
	hydrate?: SlidingWindowHydratePolicy;
};

export type CheckpointLineageValue = {
	parentConversationId?: ConversationId;
	atEntryId?: EntryId;
	atSeq?: Seq;
	sliceId?: string;
	allowedPaths?: string[];
};

/** Per-conversation checkpoint ancestry and access scope, initialized independently on forks. */
export const CheckpointLineageDoc = defineDoc<CheckpointLineageValue>({
	kind: "pi.checkpoint-lineage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Per-conversation sliding-window enable and hydration state; forkable via `fork: "initial"`. */
export const SlidingWindowStateDoc = defineDoc<SlidingWindowStateValue>({
	kind: "sliding-window.state",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	checkpointWhen: () => true,
});

/** Per-conversation rewindable mechanical tool/read/edit ledger (`asOf` across forks). */
export const SlidingWindowLedgerDoc = defineDoc<MechanicalLedger>({
	kind: "sliding-window.ledger",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => createEmptyLedger(),
	checkpointWhen: (_value, deltas) => deltas.length >= 16,
});

/** Per-conversation rewindable physical or virtual target model (`asOf` across forks). */
export const SlidingWindowTargetDoc = defineDoc<SlidingWindowTargetValue>({
	kind: "sliding-window.target",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({}),
	checkpointWhen: () => true,
});
