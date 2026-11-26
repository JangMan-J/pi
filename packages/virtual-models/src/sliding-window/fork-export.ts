import type { Context } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel, Tool } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type EntryId,
	Harness,
	type HarnessSettings,
	type ModelRef,
	ProviderDoc,
	type RegistryReader,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { BatonStateDoc, VirtualModelStateDoc } from "../durable/docs.ts";
import { SlidingWindowTargetDoc } from "./state.ts";
import {
	applyCheckpointedSeed,
	buildCheckpointedSeedPlan,
	type ParentCheckpointDocs,
	readParentCheckpointDocs,
} from "./seed-plan.ts";
import type { MechanicalLedger } from "./types.ts";

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

const NO_PARENT_DOCS: ParentCheckpointDocs = {
	agentState: undefined,
	baton: undefined,
	ledger: undefined,
	vmState: undefined,
	target: undefined,
	providerSessionId: undefined,
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
