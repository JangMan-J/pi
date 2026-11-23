import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord/json";
import type { AssistantMessage, Models, ModelThinkingLevel, Tool, Usage, UserMessage } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { harvestPostReadStudyNotes } from "@earendil-works/pi-ai/virtual-models";
import { type AnyDocToken, materializeDocument } from "../../documents.ts";
import { AssistantEntry, SystemEntry, UserEntry } from "../../entries.ts";
import type { Cursor, EntryId, Seq, Storage } from "../../types.ts";
import { AgentDoc, resolveAgent, resolveSettings } from "../agent.ts";
import { Harness } from "../harness.ts";
import { ProviderDoc } from "../provider.ts";
import type {
	AgentState,
	Conversation,
	HarnessSettings,
	ModelRef,
	RegistryReader,
	ToolRegistration,
} from "../types.ts";
import {
	BatonStateDoc,
	type BatonStateValue,
	VirtualModelStateDoc,
	type VirtualModelStateValue,
} from "../virtual-models.ts";
import { SlidingWindowLedgerDoc, SlidingWindowStateDoc, SlidingWindowTargetDoc } from "./docs.ts";
import { reconstructLedgerFromView } from "./ledger.ts";
import type { MechanicalLedger } from "./types.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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

	let parentAgentState: AgentState | undefined;
	let parentBaton: BatonStateValue | undefined;
	let parentLedger: MechanicalLedger | undefined;
	let parentSessionId: string | undefined;
	let parentVmState: VirtualModelStateValue | undefined;

	if (options.parentStorage) {
		const entryRec = await options.parentStorage.entry(options.parent.id, options.at, context);
		if (entryRec) {
			const atSeq = entryRec.commitSeq;
			const sourceConvId = entryRec.entry.conversationId;
			parentAgentState = await readConversationDocAsOf<AgentState>(
				options.parentStorage,
				sourceConvId,
				AgentDoc,
				atSeq,
				context,
			);
			parentBaton = await readConversationDocAsOf<BatonStateValue>(
				options.parentStorage,
				sourceConvId,
				BatonStateDoc,
				atSeq,
				context,
			);
			parentLedger = await readConversationDocAsOf<MechanicalLedger>(
				options.parentStorage,
				sourceConvId,
				SlidingWindowLedgerDoc,
				atSeq,
				context,
			);
			parentVmState = await readConversationDocAsOf<VirtualModelStateValue>(
				options.parentStorage,
				sourceConvId,
				VirtualModelStateDoc,
				atSeq,
				context,
			);
			const providerDoc = await readConversationDocAsOf<{ sessionId?: string }>(
				options.parentStorage,
				options.parent.id,
				ProviderDoc,
				"current",
				context,
			);
			parentSessionId = providerDoc?.sessionId;
			if (parentSessionId === undefined && sourceConvId !== options.parent.id) {
				const sourceProviderDoc = await readConversationDocAsOf<{ sessionId?: string }>(
					options.parentStorage,
					sourceConvId,
					ProviderDoc,
					"current",
					context,
				);
				parentSessionId = sourceProviderDoc?.sessionId;
			}
		}
	}

	if (options.parentHarness) {
		parentBaton ??= await options.parentHarness.snapshot(BatonStateDoc, options.parent.id, context);
		parentVmState ??= await options.parentHarness.snapshot(VirtualModelStateDoc, options.parent.id, context);
		if (parentSessionId === undefined) {
			parentSessionId = (await options.parentHarness.snapshot(ProviderDoc, options.parent.id, context))?.sessionId;
		}
	}

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
		options.studyNotes !== undefined
			? options.studyNotes
			: harvestPostReadStudyNotes(view.messages, {
					...(options.allowedPaths ? { relevantPaths: options.allowedPaths } : {}),
				});
	const mergedNotes = [parentBaton?.harvestedStudyNotes?.trim(), harvested?.trim()]
		.filter((s): s is string => Boolean(s && s.length > 0))
		.join("\n\n");
	const finalStudyNotes = mergedNotes.length > 0 ? mergedNotes : undefined;

	const resolvedParentAsOfAgent = parentAgentState
		? resolveAgent(parentAgentState, options.registry.snapshot(), resolveSettings(options.settings), () => {})
		: undefined;
	const toolDecls: Tool[] = options.tools
		? options.tools.map(toToolDeclaration)
		: (resolvedParentAsOfAgent ?? parentAgent).tools.map(toToolDeclaration);
	const childToolNames = options.tools
		? options.tools.map((t) => t.name)
		: (parentAgentState?.tools ?? (resolvedParentAsOfAgent ?? parentAgent).tools.map((t) => t.name));

	const compactOutlines = formatCompactLedgerOutlines(effectiveLedger);
	const userContent = compactOutlines ? `${options.taskPrompt}\n\n${compactOutlines}` : options.taskPrompt;
	const dispatchSummary =
		options.dispatchSummary?.trim() || "Checkpoint exported. Executing scoped task directly on hydrated context.";
	const assistantText = finalStudyNotes ? `${finalStudyNotes}\n\n${dispatchSummary}` : dispatchSummary;

	const targetRef = options.targetModel ?? parentAgentState?.model ?? parentAgent.model;
	const physicalTarget =
		targetRef && !isVirtualRef(targetRef, options.models)
			? options.models.getModel(targetRef.provider, targetRef.modelId)
			: undefined;
	const assistantMeta = {
		api: physicalTarget?.api ?? lastAssistantMsg?.api ?? "anthropic-messages",
		provider: physicalTarget?.provider ?? targetRef?.provider ?? lastAssistantMsg?.provider ?? "pi",
		model: physicalTarget?.id ?? targetRef?.modelId ?? lastAssistantMsg?.model ?? "checkpoint",
	};

	const copySession = options.copyProviderSession ?? true;
	const disableContinuation = options.disableContinuation ?? true;
	const preserveToolDeclarations = options.preserveToolDeclarations ?? true;
	const preserveThinkingLevel = options.preserveThinkingLevel ?? true;
	const slidingWindowEnabled = options.slidingWindow ?? true;
	const epochLevel = options.parentThinkingLevel ?? parentAgentState?.thinkingLevel ?? parentAgent.thinkingLevel;
	const effectiveAllowFlip = options.allowThinkingEpochFlip === true || preserveThinkingLevel === false;
	const guardedLevel =
		!effectiveAllowFlip && epochLevel !== undefined && epochLevel !== "off"
			? (options.preservedThinkingLevel ?? epochLevel)
			: undefined;
	const requestedThinking =
		options.thinkingLevel ?? parentAgentState?.thinkingLevel ?? parentAgent.thinkingLevel ?? "off";
	const finalThinkingLevel =
		guardedLevel !== undefined && requestedThinking === "off" ? guardedLevel : requestedThinking;
	const effectiveCwd = options.cwd ?? parentAgentState?.cwd ?? parentAgent.cwd;

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

		await root.commit(async (tx) => {
			await tx.appendEntry(SystemEntry, root.id, {
				model: [
					{
						role: "system",
						content: "",
						sections: { instructions: `<instructions>\n${options.systemPrompt}\n</instructions>` },
						...(toolDecls.length > 0 ? { toolsAdded: toolDecls } : {}),
						timestamp: anchorTimestamp,
					},
				],
			});
			await tx.appendEntry(UserEntry, root.id, { model: [userMessage] });
			await tx.appendEntry(AssistantEntry, root.id, { model: [assistantMessage] });

			const agentDoc = await tx.doc(AgentDoc, root.id);
			agentDoc.instructions = options.systemPrompt;
			if (childToolNames !== undefined) {
				agentDoc.tools = Array.isArray(childToolNames) ? [...childToolNames] : childToolNames;
			}
			const defaultSwSelection = options.slidingWindowModel ?? { provider: "sliding-window", modelId: "active" };
			const hasSwModel = Boolean(options.models.getModel(defaultSwSelection.provider, defaultSwSelection.modelId));
			const agentModel = slidingWindowEnabled && hasSwModel ? defaultSwSelection : targetRef;
			if (agentModel !== undefined) agentDoc.model = agentModel;
			agentDoc.thinkingLevel = finalThinkingLevel;
			if (effectiveCwd !== undefined) agentDoc.cwd = effectiveCwd;
			agentDoc.compaction = { enabled: !slidingWindowEnabled };

			if (copySession && parentSessionId !== undefined) {
				(await tx.doc(ProviderDoc, root.id)).sessionId = parentSessionId;
			}

			const vmDoc = await tx.doc(VirtualModelStateDoc, root.id);
			vmDoc.forkGuard = {
				disableContinuation,
				preserveToolDeclarations,
				...(options.allowedTools !== undefined ? { allowedTools: [...options.allowedTools] } : {}),
				...(options.blockedToolReason !== undefined ? { blockedToolReason: options.blockedToolReason } : {}),
				...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
				...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
				...(copySession && parentSessionId !== undefined ? { sessionId: parentSessionId } : {}),
				...(parentVmState?.forkGuard?.sessionId && !parentSessionId
					? { sessionId: parentVmState.forkGuard.sessionId }
					: {}),
			};

			if (options.targetModel !== undefined) {
				(await tx.doc(SlidingWindowTargetDoc, root.id)).target = options.targetModel;
			}

			const swDoc = await tx.doc(SlidingWindowStateDoc, root.id);
			swDoc.enabled = slidingWindowEnabled;
			if (options.allowedPaths !== undefined) {
				swDoc.hydrate = {
					allowedPaths: [...options.allowedPaths],
					hydratedPaths: [],
					...(options.maxHydrateBytes !== undefined ? { maxHydrateBytes: options.maxHydrateBytes } : {}),
				};
			}

			const ledgerDoc = await tx.doc(SlidingWindowLedgerDoc, root.id);
			Object.assign(ledgerDoc, copyJson(effectiveLedger, { omitUndefinedProperties: true }));

			const batonDoc = await tx.doc(BatonStateDoc, root.id);
			batonDoc.epoch = 0;
			batonDoc.anchorUser0 = copyJson(userMessage, {
				omitUndefinedProperties: true,
			}) as JsonRepresentation<UserMessage>;
			if (finalStudyNotes !== undefined) {
				batonDoc.harvestedStudyNotes = finalStudyNotes;
			}
		}, context);

		return {
			conversationId: root.id,
			anchorTimestamp,
			atTimestamp,
			ledger: effectiveLedger,
			...(finalStudyNotes !== undefined ? { studyNotes: finalStudyNotes } : {}),
		};
	} finally {
		await childHarness.close(context).catch(() => {});
	}
}

function isVirtualRef(ref: ModelRef, models: Models): boolean {
	const m = models.getModel(ref.provider, ref.modelId);
	return Boolean(m && m.api === "pi-virtual");
}
