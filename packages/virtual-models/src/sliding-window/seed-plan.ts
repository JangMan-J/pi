import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { AssistantMessage, Models, SystemMessage, Tool, Usage, UserMessage } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import {
	type Agent,
	AgentDoc,
	type AgentState,
	AssistantEntry,
	type ContextView,
	type Conversation,
	type ConversationId,
	type EntryId,
	type EntryRecord,
	type Harness,
	type HarnessSettings,
	type ModelRef,
	ProviderDoc,
	type RegistryReader,
	readConversationDocAsOf,
	resolveAgent,
	resolveSettings,
	type Seq,
	type Storage,
	SystemEntry,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import {
	BatonStateDoc,
	type BatonStateValue,
	type ForkCacheGuard,
	VirtualModelStateDoc,
	type VirtualModelStateValue,
} from "../durable/docs.ts";
import { harvestPostReadStudyNotes } from "../study-notes.ts";
import { reconstructLedgerFromView } from "./ledger.ts";
import {
	CheckpointLineageDoc,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
} from "./state.ts";
import type {
	CheckpointLineageValue,
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

const NO_PARENT_DOCS: ParentCheckpointDocs = {
	agentState: undefined,
	baton: undefined,
	ledger: undefined,
	vmState: undefined,
	target: undefined,
	providerSessionId: undefined,
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
	/** The frozen `pi.system` message: the instructions section and the child's tool declarations. */
	readonly system: SystemMessage;
	readonly user: UserMessage;
	readonly assistant: AssistantMessage;
	/** `pi.agent`, written whole: the owner's copied fields are wiped first, so nothing of them survives. */
	readonly agentState: AgentState;
	/** `pi.provider.sessionId` when the parent session is copied; undefined keeps the fresh one. */
	readonly providerSessionId?: string;
	readonly forkGuard: ForkCacheGuard;
	readonly persistedTarget?: ModelRef;
	readonly slidingWindowEnabled: boolean;
	readonly hydrate?: SlidingWindowHydratePolicy;
	readonly baton: { readonly anchorUser0: JsonRepresentation<UserMessage>; readonly studyNotes?: string };
	readonly lineage?: CheckpointLineageValue;
};

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Read the parent documents a checkpointed seed starts from: the `asOf(entryRec.commitSeq)` documents of the entry's
 * conversation, and the parent's current `pi.provider`. `entryRec` absent reads nothing, so a caller falls back to its
 * Harness's snapshots.
 */
export async function readParentCheckpointDocs(
	storage: Storage,
	parentId: ConversationId,
	entryRec: { readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined,
	context: Context,
): Promise<ParentCheckpointDocs> {
	if (entryRec === undefined) return NO_PARENT_DOCS;
	const at = entryRec.commitSeq;
	const sourceConvId = entryRec.entry.conversationId;
	const agentState = await readConversationDocAsOf(storage, sourceConvId, AgentDoc, at, context);
	const baton = await readConversationDocAsOf(storage, sourceConvId, BatonStateDoc, at, context);
	const ledger = await readConversationDocAsOf(storage, sourceConvId, SlidingWindowLedgerDoc, at, context);
	const vmState = await readConversationDocAsOf(storage, sourceConvId, VirtualModelStateDoc, at, context);
	let target = await readConversationDocAsOf(storage, sourceConvId, SlidingWindowTargetDoc, at, context);
	if (!target?.target && sourceConvId !== parentId) {
		const ownTarget = await readConversationDocAsOf(storage, parentId, SlidingWindowTargetDoc, "current", context);
		if (ownTarget?.target) target = ownTarget;
	}
	const providerDoc = await readConversationDocAsOf(storage, parentId, ProviderDoc, "current", context);
	let providerSessionId = providerDoc?.sessionId;
	if (providerSessionId === undefined && sourceConvId !== parentId) {
		const sourceProviderDoc = await readConversationDocAsOf(storage, sourceConvId, ProviderDoc, "current", context);
		providerSessionId = sourceProviderDoc?.sessionId;
	}
	return { agentState, baton, ledger, vmState, target, providerSessionId };
}

function formatCompactLedgerOutlines(ledger: MechanicalLedger): string {
	if (ledger.filesRead.length === 0 && ledger.filesEdited.length === 0) return "";
	const lines: string[] = ["<checkpoint_files>"];
	if (ledger.filesEdited.length > 0) {
		lines.push(`Edited: ${ledger.filesEdited.map((e) => `${e.path} (${e.op})`).join(", ")}`);
	}
	if (ledger.filesRead.length > 0) {
		for (const r of ledger.filesRead.slice(-24)) {
			const refPart = r.ref ? `ref:${r.ref}` : r.sourceSha256 ? `sha:${r.sourceSha256.slice(0, 12)}` : "read";
			lines.push(`- ${r.path} [${refPart}${r.lines ? `, ${r.lines}L` : ""}]`);
		}
	}
	lines.push("</checkpoint_files>");
	return lines.join("\n");
}

function isVirtualRef(ref: ModelRef, models: Models): boolean {
	const m = models.getModel(ref.provider, ref.modelId);
	return Boolean(m && m.api === "pi-virtual");
}

/**
 * Decide the frozen entries and documents a checkpointed seed writes: deterministic `pi.system`/`pi.user`/
 * `pi.assistant` timestamps, the child's `pi.agent` built from the options and the parent's `asOf` state (never the
 * owner's copied fields), the cache guard, the sliding-window documents, and the baton anchor.
 */
export function buildCheckpointedSeedPlan(params: CheckpointedSeedParams): CheckpointedSeedPlan {
	const { view, parentAgent, parentAgentState, parentBaton, parentLedger, parentVmState, parentTarget } = params;
	const viewLedger = reconstructLedgerFromView(view);
	const effectiveLedger: MechanicalLedger =
		parentLedger &&
		(parentLedger.epoch > 0 ||
			parentLedger.turnCount > 0 ||
			parentLedger.filesRead.length > 0 ||
			parentLedger.filesEdited.length > 0 ||
			parentLedger.recentRefs.length > 0)
			? parentLedger
			: viewLedger;

	const firstUserMsg = view.messages.find((m): m is UserMessage => m.role === "user");
	const lastAssistantMsg = view.messages.findLast((m): m is AssistantMessage => m.role === "assistant");
	const lastMsg = view.messages.at(-1);

	const isFiniteTimestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const findFirstFiniteTimestamp = (): number | undefined => {
		if (isFiniteTimestamp(parentBaton?.anchorUser0?.timestamp)) return parentBaton.anchorUser0.timestamp;
		if (isFiniteTimestamp(firstUserMsg?.timestamp)) return firstUserMsg.timestamp;
		for (const msg of view.messages) {
			if (isFiniteTimestamp(msg.timestamp)) return msg.timestamp;
		}
		for (const entry of view.entries) {
			for (const msg of entry.model ?? []) {
				if (isFiniteTimestamp(msg.timestamp)) return msg.timestamp;
			}
		}
		return undefined;
	};
	const anchorTimestamp = findFirstFiniteTimestamp() ?? 0;

	const findLastFiniteTimestamp = (): number | undefined => {
		if (isFiniteTimestamp(lastAssistantMsg?.timestamp)) return lastAssistantMsg.timestamp;
		if (isFiniteTimestamp(lastMsg?.timestamp)) return lastMsg.timestamp;
		for (let i = view.messages.length - 1; i >= 0; i--) {
			const ts = view.messages[i]?.timestamp;
			if (isFiniteTimestamp(ts)) return ts;
		}
		for (let i = view.entries.length - 1; i >= 0; i--) {
			const modelMsgs = view.entries[i]?.model;
			if (!modelMsgs) continue;
			for (let j = modelMsgs.length - 1; j >= 0; j--) {
				const ts = modelMsgs[j]?.timestamp;
				if (isFiniteTimestamp(ts)) return ts;
			}
		}
		return undefined;
	};
	const atTimestamp = findLastFiniteTimestamp() ?? anchorTimestamp;

	const harvested =
		params.studyNotes !== undefined
			? params.studyNotes
			: harvestPostReadStudyNotes(view.messages, {
					...(params.allowedPaths ? { relevantPaths: params.allowedPaths } : {}),
				});
	const mergedNotes = [parentBaton?.harvestedStudyNotes?.trim(), harvested?.trim()]
		.filter((s): s is string => Boolean(s && s.length > 0))
		.join("\n\n");
	const finalStudyNotes = mergedNotes.length > 0 ? mergedNotes : undefined;

	const resolvedParentAsOfAgent = parentAgentState
		? resolveAgent(parentAgentState, params.registry.snapshot(), resolveSettings(params.settings), () => {})
		: undefined;
	const toolDecls: Tool[] = params.tools
		? params.tools.map(toToolDeclaration)
		: (resolvedParentAsOfAgent ?? parentAgent).tools.map(toToolDeclaration);
	const childToolNames: AgentState["tools"] = params.tools
		? params.tools.map((t) => t.name)
		: (parentAgentState?.tools ?? (resolvedParentAsOfAgent ?? parentAgent).tools.map((t) => t.name));

	const compactOutlines = formatCompactLedgerOutlines(effectiveLedger);
	const userContent = compactOutlines ? `${params.taskPrompt}\n\n${compactOutlines}` : params.taskPrompt;
	const dispatchSummary =
		params.dispatchSummary?.trim() || "Checkpoint exported. Executing scoped task directly on hydrated context.";
	const assistantText = finalStudyNotes ? `${finalStudyNotes}\n\n${dispatchSummary}` : dispatchSummary;

	const defaultSwSelection = params.slidingWindowModel ?? { provider: "sliding-window", modelId: "active" };
	const isSlidingWindowSelectionRef = (ref: ModelRef | undefined): boolean =>
		Boolean(
			ref &&
				((ref.provider === "sliding-window" && ref.modelId === "active") ||
					(ref.provider === defaultSwSelection.provider && ref.modelId === defaultSwSelection.modelId)),
		);
	const candidateParentModel = parentAgentState?.model ?? parentAgent.model;
	const fallbackParentModel =
		candidateParentModel && !isSlidingWindowSelectionRef(candidateParentModel) ? candidateParentModel : undefined;
	const inheritedTargetRef =
		parentTarget?.target && !isSlidingWindowSelectionRef(parentTarget.target)
			? parentTarget.target
			: fallbackParentModel;
	const targetRef = params.targetModel ?? inheritedTargetRef;
	const physicalTarget =
		targetRef && !isVirtualRef(targetRef, params.models)
			? params.models.getModel(targetRef.provider, targetRef.modelId)
			: undefined;
	const assistantMeta = {
		api: physicalTarget?.api ?? lastAssistantMsg?.api ?? "anthropic-messages",
		provider: physicalTarget?.provider ?? targetRef?.provider ?? lastAssistantMsg?.provider ?? "pi",
		model: physicalTarget?.id ?? targetRef?.modelId ?? lastAssistantMsg?.model ?? "checkpoint",
	};

	const copySession = params.copyProviderSession ?? true;
	const disableContinuation = params.disableContinuation ?? true;
	const preserveToolDeclarations = params.preserveToolDeclarations ?? true;
	const preserveThinkingLevel = params.preserveThinkingLevel ?? true;
	const slidingWindowEnabled = params.slidingWindow ?? true;
	const epochLevel = params.parentThinkingLevel ?? parentAgentState?.thinkingLevel ?? parentAgent.thinkingLevel;
	const effectiveAllowFlip = params.allowThinkingEpochFlip === true || preserveThinkingLevel === false;
	const guardedLevel =
		!effectiveAllowFlip && epochLevel !== undefined && epochLevel !== "off"
			? (params.preservedThinkingLevel ?? epochLevel)
			: undefined;
	const requestedThinking =
		params.thinkingLevel ?? parentAgentState?.thinkingLevel ?? parentAgent.thinkingLevel ?? "off";
	const finalThinkingLevel =
		guardedLevel !== undefined && requestedThinking === "off" ? guardedLevel : requestedThinking;
	const effectiveCwd = params.cwd ?? parentAgentState?.cwd ?? parentAgent.cwd;
	const instructions = params.systemPrompt ?? parentAgentState?.instructions;

	const hasSwModel = Boolean(params.models.getModel(defaultSwSelection.provider, defaultSwSelection.modelId));
	const agentModel = slidingWindowEnabled && hasSwModel ? defaultSwSelection : targetRef;
	const persistedTarget = targetRef && !isSlidingWindowSelectionRef(targetRef) ? targetRef : undefined;

	const userMessage: UserMessage = {
		role: "user",
		content: userContent,
		timestamp: anchorTimestamp,
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: assistantMeta.api,
		provider: assistantMeta.provider,
		model: assistantMeta.model,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: atTimestamp,
	};
	const agentState: AgentState = {
		...(instructions === undefined ? {} : { instructions }),
		tools: Array.isArray(childToolNames) ? [...childToolNames] : childToolNames,
		...(params.modelTools === undefined ? {} : { modelTools: params.modelTools }),
		...(params.extensions === undefined ? {} : { extensions: params.extensions }),
		...(agentModel === undefined ? {} : { model: agentModel }),
		thinkingLevel: finalThinkingLevel,
		...(effectiveCwd === undefined ? {} : { cwd: effectiveCwd }),
		...(params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
		compaction: params.compaction ?? { enabled: !slidingWindowEnabled },
	};

	return {
		anchorTimestamp,
		atTimestamp,
		ledger: effectiveLedger,
		...(finalStudyNotes !== undefined ? { studyNotes: finalStudyNotes } : {}),
		system: {
			role: "system",
			content: "",
			...(instructions === undefined
				? {}
				: { sections: { instructions: `<instructions>\n${instructions}\n</instructions>` } }),
			...(toolDecls.length > 0 ? { toolsAdded: toolDecls } : {}),
			timestamp: anchorTimestamp,
		},
		user: userMessage,
		assistant: assistantMessage,
		agentState,
		...(copySession && params.parentSessionId !== undefined ? { providerSessionId: params.parentSessionId } : {}),
		forkGuard: {
			disableContinuation,
			preserveToolDeclarations,
			...(params.allowedTools !== undefined ? { allowedTools: [...params.allowedTools] } : {}),
			...(params.blockedToolReason !== undefined ? { blockedToolReason: params.blockedToolReason } : {}),
			...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
			...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
			...(copySession && params.parentSessionId !== undefined ? { sessionId: params.parentSessionId } : {}),
			...(parentVmState?.forkGuard?.sessionId && !params.parentSessionId
				? { sessionId: parentVmState.forkGuard.sessionId }
				: {}),
		},
		...(persistedTarget !== undefined ? { persistedTarget } : {}),
		slidingWindowEnabled,
		...(params.allowedPaths === undefined
			? {}
			: {
					hydrate: {
						allowedPaths: [...params.allowedPaths],
						hydratedPaths: [],
						...(params.maxHydrateBytes !== undefined ? { maxHydrateBytes: params.maxHydrateBytes } : {}),
					},
				}),
		baton: {
			anchorUser0: copyJson(userMessage, { omitUndefinedProperties: true }) as JsonRepresentation<UserMessage>,
			...(finalStudyNotes !== undefined ? { studyNotes: finalStudyNotes } : {}),
		},
		...(params.lineage !== undefined ? { lineage: params.lineage } : {}),
	};
}

/**
 * Write a checkpointed seed into `conversationId`'s creating commit: only entry appends and document writes, no table
 * reads, so it is safe inside a commit that already wrote. The owner-copied `pi.agent` and baton fields are wiped
 * first, so nothing of the owner task's state survives.
 */
export async function applyCheckpointedSeed(
	tx: Tx,
	conversationId: ConversationId,
	plan: CheckpointedSeedPlan,
): Promise<void> {
	await tx.appendEntry(SystemEntry, conversationId, { model: [plan.system] });
	await tx.appendEntry(UserEntry, conversationId, { model: [plan.user] });
	await tx.appendEntry(AssistantEntry, conversationId, { model: [plan.assistant] });

	const agentDoc = await tx.doc(AgentDoc, conversationId);
	delete agentDoc.instructions;
	delete agentDoc.tools;
	delete agentDoc.modelTools;
	delete agentDoc.model;
	delete agentDoc.thinkingLevel;
	delete agentDoc.cwd;
	delete agentDoc.compaction;
	delete agentDoc.extensions;
	delete agentDoc.maxTurns;
	Object.assign(agentDoc, plan.agentState);

	if (plan.providerSessionId !== undefined) {
		(await tx.doc(ProviderDoc, conversationId)).sessionId = plan.providerSessionId;
	}

	(await tx.doc(VirtualModelStateDoc, conversationId)).forkGuard = plan.forkGuard;

	if (plan.persistedTarget !== undefined) {
		(await tx.doc(SlidingWindowTargetDoc, conversationId)).target = plan.persistedTarget;
	}

	const swDoc = await tx.doc(SlidingWindowStateDoc, conversationId);
	swDoc.enabled = plan.slidingWindowEnabled;
	if (plan.hydrate !== undefined) swDoc.hydrate = plan.hydrate;

	const ledgerDoc = await tx.doc(SlidingWindowLedgerDoc, conversationId);
	Object.assign(ledgerDoc, copyJson(plan.ledger, { omitUndefinedProperties: true }));

	const batonDoc = await tx.doc(BatonStateDoc, conversationId);
	batonDoc.epoch = 0;
	delete batonDoc.handoffSummary;
	delete batonDoc.swappedAtTokens;
	delete batonDoc.data;
	delete batonDoc.preparingTaskId;
	delete batonDoc.staged;
	delete batonDoc.harvestedStudyNotes;
	batonDoc.anchorUser0 = plan.baton.anchorUser0;
	if (plan.baton.studyNotes !== undefined) batonDoc.harvestedStudyNotes = plan.baton.studyNotes;

	if (plan.lineage !== undefined) {
		Object.assign(await tx.doc(CheckpointLineageDoc, conversationId), plan.lineage);
	}
}

/**
 * Seed a fresh conversation from `parentId`'s checkpoint at `at`, over the generic `Harness.readCheckpoint()` read
 * and `Harness.createConversation()` creating commit: parent reads happen before the commit opens, and the seed's
 * entry appends and document writes run inside `init`.
 */
export async function seedCheckpointedConversation(
	harness: Harness,
	parentId: ConversationId,
	at: EntryId,
	options: SeedCheckpointedConversationOptions,
	context: Context,
): Promise<Conversation> {
	const checkpoint = await harness.readCheckpoint(parentId, at, context);
	const sourceConvId = checkpoint.entry.conversationId;
	const baton = await checkpoint.doc(BatonStateDoc);
	const ledger = await checkpoint.doc(SlidingWindowLedgerDoc);
	const vmState = await checkpoint.doc(VirtualModelStateDoc);
	let target = await checkpoint.doc(SlidingWindowTargetDoc);
	if (!target?.target && sourceConvId !== parentId) {
		const ownTarget = await checkpoint.doc(SlidingWindowTargetDoc, { conversationId: parentId, at: "current" });
		if (ownTarget?.target) target = ownTarget;
	}

	const plan = buildCheckpointedSeedPlan({
		view: checkpoint.view,
		parentAgent: checkpoint.agent,
		parentAgentState: checkpoint.agentState,
		parentBaton: baton,
		parentLedger: ledger,
		parentVmState: vmState,
		parentTarget: target,
		parentSessionId: checkpoint.providerSessionId,
		models: options.models ?? checkpoint.models,
		registry: options.registry ?? checkpoint.registry,
		settings: options.settings ?? checkpoint.settings,
		systemPrompt: options.systemPrompt,
		tools: options.tools,
		taskPrompt: options.taskPrompt,
		dispatchSummary: options.dispatchSummary,
		studyNotes: options.studyNotes,
		targetModel: options.targetModel,
		thinkingLevel: options.thinkingLevel,
		cwd: options.cwd,
		maxTurns: options.maxTurns,
		compaction: options.compaction,
		modelTools: options.modelTools,
		extensions: options.extensions,
		allowedTools: options.allowedTools,
		blockedToolReason: options.blockedToolReason,
		allowedPaths: options.allowedPaths,
		maxHydrateBytes: options.maxHydrateBytes,
		slidingWindow: options.slidingWindow,
		slidingWindowModel: options.slidingWindowModel,
		copyProviderSession: options.copyProviderSession,
		preserveToolDeclarations: options.preserveToolDeclarations,
		disableContinuation: options.disableContinuation,
		preserveThinkingLevel: options.preserveThinkingLevel,
		parentThinkingLevel: options.parentThinkingLevel,
		preservedThinkingLevel: options.preservedThinkingLevel,
		allowThinkingEpochFlip: options.allowThinkingEpochFlip,
		lineage: {
			parentConversationId: parentId,
			atEntryId: at,
			atSeq: checkpoint.commitSeq,
			...(options.sliceId === undefined ? {} : { sliceId: options.sliceId }),
			...(options.allowedPaths === undefined ? {} : { allowedPaths: [...options.allowedPaths] }),
		},
	});
	return harness.createConversation(
		{
			ownership: options.ownership,
			init: async (tx, childId) => {
				await applyCheckpointedSeed(tx, childId, plan);
				await options.init?.(tx, childId);
			},
		},
		context,
	);
}
