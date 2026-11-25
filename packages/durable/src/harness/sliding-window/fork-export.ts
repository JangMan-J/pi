import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type {
	AssistantMessage,
	Models,
	ModelThinkingLevel,
	SystemMessage,
	Tool,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { harvestPostReadStudyNotes } from "@earendil-works/pi-ai/utils/study-notes";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { type AnyDocToken, materializeDocument } from "../../documents.ts";
import { AssistantEntry, SystemEntry, UserEntry } from "../../entries.ts";
import type { ConversationId, Cursor, EntryId, EntryRecord, Seq, Storage, Tx } from "../../types.ts";
import { AgentDoc, resolveAgent, resolveSettings } from "../agent.ts";
import { Harness } from "../harness.ts";
import { ProviderDoc } from "../provider.ts";
import type {
	Agent,
	AgentState,
	ContextView,
	Conversation,
	HarnessSettings,
	ModelRef,
	RegistryReader,
	SeedCheckpointedConversationOptions,
	ToolRegistration,
} from "../types.ts";
import {
	CheckpointLineageDoc,
	type CheckpointLineageValue,
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
} from "./docs.ts";
import { reconstructLedgerFromView } from "./ledger.ts";
import type { MechanicalLedger, SlidingWindowHydratePolicy, SlidingWindowTargetValue } from "./types.ts";
import {
	BatonStateDoc,
	type BatonStateValue,
	type ForkCacheGuard,
	VirtualModelStateDoc,
	type VirtualModelStateValue,
} from "./virtual-models-docs.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One entry and the sequence of the commit that persisted it, as `Storage.entry()` returns it. */
type VisibleEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

/** Parent documents a checkpointed seed starts from, as committed at the checkpoint entry. */
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

export interface ExportCheckpointedForkStorageOptions {
	readonly parent: Conversation;
	readonly parentHarness?: Harness;
	readonly parentStorage?: Storage;
	readonly at: EntryId;
	readonly targetStorage: Storage;
	/** Close `targetStorage` when `childHarness.close()` finishes (default: false so caller/test storage stays open). */
	readonly closeTargetStorage?: boolean;
	readonly models: Models;
	readonly registry: RegistryReader;
	readonly settings?: HarnessSettings;
	readonly systemPrompt: string;
	/** Explicit child tools (declaration or registration); falls back to parent declared tools. */
	readonly tools?: readonly (Tool | ToolRegistration)[];
	readonly taskPrompt: string;
	readonly dispatchSummary?: string;
	readonly studyNotes?: string;
	readonly targetModel?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	readonly cwd?: string;
	readonly allowedTools?: readonly string[];
	readonly blockedToolReason?: string;
	readonly allowedPaths?: readonly string[];
	readonly maxHydrateBytes?: number;
	readonly slidingWindow?: boolean;
	/** Optional virtual sliding-window catalog ref (`AgentDoc.model`); defaults to `sliding-window/active` when registered and `slidingWindow !== false`. */
	readonly slidingWindowModel?: ModelRef;
	readonly copyProviderSession?: boolean;
	readonly preserveToolDeclarations?: boolean;
	readonly disableContinuation?: boolean;
	readonly preserveThinkingLevel?: boolean;
	readonly parentThinkingLevel?: ModelThinkingLevel;
	readonly preservedThinkingLevel?: Exclude<ModelThinkingLevel, "off">;
	readonly allowThinkingEpochFlip?: boolean;
}

export interface ExportCheckpointedForkResult {
	readonly conversationId: Conversation["id"];
	readonly anchorTimestamp: number;
	readonly atTimestamp: number;
	readonly ledger: MechanicalLedger;
	readonly studyNotes?: string;
}

/**
 * What a checkpointed seed reads from its parent plus what it writes: `Harness.seedCheckpointedConversation()` and
 * `exportCheckpointedForkToStorage()` differ only in where the parent documents come from and where the seed goes.
 */
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

/** Everything a checkpointed seed writes, decided before its creating commit starts. */
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

function wrapNonClosingStorage(storage: Storage, closeUnderlying: boolean): Storage {
	if (closeUnderlying) return storage;
	return new Proxy(storage, {
		get(target, prop) {
			if (prop === "close") return async () => {};
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function readConversationDocAsOf<T>(
	storage: Storage,
	conversationId: Conversation["id"],
	token: AnyDocToken,
	at: Seq | "current",
	context: Context,
): Promise<T | undefined> {
	const def = token.definition;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanDocuments(
			{ scope: { kind: "conversation", conversationId }, at },
			256,
			cursor,
			context,
		);
		const match = page.items.find((doc) => doc.kind === def.kind && doc.key === undefined);
		if (match) {
			const stored = await storage.document(match.id, at, context);
			if (!stored) return undefined;
			return materializeDocument(def, stored) as unknown as T;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return undefined;
}

/**
 * Read the parent documents a checkpointed seed starts from: the `asOf(entryRec.commitSeq)` documents of the entry's
 * conversation, and the parent's current `pi.provider`. `entryRec` absent reads nothing, so a caller falls back to its
 * Harness's snapshots.
 */
export async function readParentCheckpointDocs(
	storage: Storage,
	parentId: ConversationId,
	entryRec: VisibleEntry | undefined,
	context: Context,
): Promise<ParentCheckpointDocs> {
	if (entryRec === undefined) return NO_PARENT_DOCS;
	const at = entryRec.commitSeq;
	const sourceConvId = entryRec.entry.conversationId;
	const agentState = await readConversationDocAsOf<AgentState>(storage, sourceConvId, AgentDoc, at, context);
	const baton = await readConversationDocAsOf<BatonStateValue>(storage, sourceConvId, BatonStateDoc, at, context);
	const ledger = await readConversationDocAsOf<MechanicalLedger>(
		storage,
		sourceConvId,
		SlidingWindowLedgerDoc,
		at,
		context,
	);
	const vmState = await readConversationDocAsOf<VirtualModelStateValue>(
		storage,
		sourceConvId,
		VirtualModelStateDoc,
		at,
		context,
	);
	let target = await readConversationDocAsOf<SlidingWindowTargetValue>(
		storage,
		sourceConvId,
		SlidingWindowTargetDoc,
		at,
		context,
	);
	if (!target?.target && sourceConvId !== parentId) {
		const ownTarget = await readConversationDocAsOf<SlidingWindowTargetValue>(
			storage,
			parentId,
			SlidingWindowTargetDoc,
			"current",
			context,
		);
		if (ownTarget?.target) target = ownTarget;
	}
	const providerDoc = await readConversationDocAsOf<{ sessionId?: string }>(
		storage,
		parentId,
		ProviderDoc,
		"current",
		context,
	);
	let providerSessionId = providerDoc?.sessionId;
	if (providerSessionId === undefined && sourceConvId !== parentId) {
		const sourceProviderDoc = await readConversationDocAsOf<{ sessionId?: string }>(
			storage,
			sourceConvId,
			ProviderDoc,
			"current",
			context,
		);
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
 * Export a checkpointed fork from `parent` at `at` into an isolated `targetStorage` (Chord `StoreStorage` or
 * `MemoryStorage`), writing frozen `SystemEntry` declarations, deterministic `UserEntry`/`AssistantEntry`
 * timestamps, `ProviderDoc.sessionId`, `VirtualModelStateDoc.forkGuard`, `SlidingWindowTargetDoc`,
 * `SlidingWindowStateDoc.hydrate`, and `SlidingWindowLedgerDoc`.
 */
export async function exportCheckpointedForkToStorage(
	options: ExportCheckpointedForkStorageOptions,
	context: Context,
): Promise<ExportCheckpointedForkResult> {
	const view = await options.parent.context(context, { at: options.at });
	const parentAgent = await options.parent.agent(context);

	const entryRec = options.parentStorage
		? await options.parentStorage.entry(options.parent.id, options.at, context)
		: undefined;
	const docs = options.parentStorage
		? await readParentCheckpointDocs(options.parentStorage, options.parent.id, entryRec, context)
		: NO_PARENT_DOCS;
	let parentBaton = docs.baton;
	let parentVmState = docs.vmState;
	let parentTarget = docs.target;
	let parentSessionId = docs.providerSessionId;

	if (options.parentHarness) {
		parentBaton ??= await options.parentHarness.snapshot(BatonStateDoc, options.parent.id, context);
		parentVmState ??= await options.parentHarness.snapshot(VirtualModelStateDoc, options.parent.id, context);
		if (entryRec === undefined) {
			parentTarget ??= await options.parentHarness.snapshot(SlidingWindowTargetDoc, options.parent.id, context);
		}
		if (parentSessionId === undefined) {
			parentSessionId = (await options.parentHarness.snapshot(ProviderDoc, options.parent.id, context))?.sessionId;
		}
	}

	const plan = buildCheckpointedSeedPlan({
		view,
		parentAgent,
		parentAgentState: docs.agentState,
		parentBaton,
		parentLedger: docs.ledger,
		parentVmState,
		parentTarget,
		parentSessionId,
		models: options.models,
		registry: options.registry,
		settings: options.settings,
		systemPrompt: options.systemPrompt,
		tools: options.tools,
		taskPrompt: options.taskPrompt,
		dispatchSummary: options.dispatchSummary,
		studyNotes: options.studyNotes,
		targetModel: options.targetModel,
		thinkingLevel: options.thinkingLevel,
		cwd: options.cwd,
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
		lineage: undefined,
	});

	const storage = wrapNonClosingStorage(options.targetStorage, options.closeTargetStorage ?? false);
	const childHarness = await Harness.open(
		storage,
		{
			models: options.models,
			registry: options.registry,
			...(options.settings ? { settings: options.settings } : {}),
		},
		context,
	);

	try {
		const root = await childHarness.root(context);
		await root.commit((tx) => applyCheckpointedSeed(tx, root.id, plan), context);
		return {
			conversationId: root.id,
			anchorTimestamp: plan.anchorTimestamp,
			atTimestamp: plan.atTimestamp,
			ledger: plan.ledger,
			...(plan.studyNotes !== undefined ? { studyNotes: plan.studyNotes } : {}),
		};
	} finally {
		await childHarness.close(context).catch(() => {});
	}
}

function isVirtualRef(ref: ModelRef, models: Models): boolean {
	const m = models.getModel(ref.provider, ref.modelId);
	return Boolean(m && m.api === "pi-virtual");
}
