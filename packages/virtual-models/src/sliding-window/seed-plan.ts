import type { Context } from "@earendil-works/chord/context";
import type { JsonRepresentation } from "@earendil-works/chord/json";
import type { AssistantMessage, Models, SystemMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	Agent,
	AgentState,
	ContextView,
	Conversation,
	ConversationId,
	EntryId,
	EntryRecord,
	Harness,
	HarnessSettings,
	ModelRef,
	RegistryReader,
	Seq,
	Storage,
	Tx,
} from "@earendil-works/pi-durable";
import { CheckpointLineageDoc, type CheckpointLineageValue } from "@earendil-works/pi-durable/sliding-window";
import type { BatonStateValue, ForkCacheGuard, VirtualModelStateValue } from "../durable/docs.ts";
import type {
	MechanicalLedger,
	SeedCheckpointedConversationOptions,
	SlidingWindowHydratePolicy,
	SlidingWindowTargetValue,
} from "./types.ts";

export { CheckpointLineageDoc, type CheckpointLineageValue };

export type ParentCheckpointDocs = {
	readonly agentState: AgentState | undefined;
	readonly baton: BatonStateValue | undefined;
	readonly ledger: MechanicalLedger | undefined;
	readonly vmState: VirtualModelStateValue | undefined;
	readonly target: SlidingWindowTargetValue | undefined;
	readonly providerSessionId: string | undefined;
};

export type CheckpointedSeedParams = Omit<
	SeedCheckpointedConversationOptions,
	"ownership" | "init" | "models" | "registry" | "settings"
> & {
	readonly view: ContextView;
	readonly parentAgent: Agent;
	readonly parentAgentState: AgentState | undefined;
	readonly parentBaton: BatonStateValue | undefined;
	readonly parentLedger: MechanicalLedger | undefined;
	readonly parentVmState: VirtualModelStateValue | undefined;
	readonly parentTarget: SlidingWindowTargetValue | undefined;
	readonly parentSessionId: string | undefined;
	readonly lineage: CheckpointLineageValue | undefined;
	readonly models: Models;
	readonly registry: RegistryReader;
	readonly settings: HarnessSettings | undefined;
};

export type CheckpointedSeedPlan = {
	readonly anchorTimestamp: number;
	readonly atTimestamp: number;
	readonly ledger: MechanicalLedger;
	readonly studyNotes?: string;
	readonly system: SystemMessage;
	readonly user: UserMessage;
	readonly assistant: AssistantMessage;
	readonly agentState: AgentState;
	readonly providerSessionId?: string;
	readonly forkGuard: ForkCacheGuard;
	readonly persistedTarget?: ModelRef;
	readonly slidingWindowEnabled: boolean;
	readonly hydrate?: SlidingWindowHydratePolicy;
	readonly baton: { readonly anchorUser0: JsonRepresentation<UserMessage>; readonly studyNotes?: string };
	readonly lineage?: CheckpointLineageValue;
};

export async function readParentCheckpointDocs(
	_storage: Storage,
	_parentId: ConversationId,
	_entryRec: { readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined,
	_context: Context,
): Promise<ParentCheckpointDocs> {
	throw new Error("readParentCheckpointDocs is not implemented yet (S12)");
}

export function buildCheckpointedSeedPlan(_params: CheckpointedSeedParams): CheckpointedSeedPlan {
	throw new Error("buildCheckpointedSeedPlan is not implemented yet (S12)");
}

export async function applyCheckpointedSeed(
	_tx: Tx,
	_conversationId: ConversationId,
	_plan: CheckpointedSeedPlan,
): Promise<void> {
	throw new Error("applyCheckpointedSeed is not implemented yet (S12)");
}

export function seedCheckpointedConversation(
	harness: Harness,
	parentId: ConversationId,
	at: EntryId,
	options: SeedCheckpointedConversationOptions,
	context: Context,
): Promise<Conversation> {
	return harness.seedCheckpointedConversation(parentId, at, options, context);
}
