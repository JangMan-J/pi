import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonRepresentation, type JsonValue } from "@earendil-works/chord/json";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { Api, Message, Model, Models, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
	harvestPostReadStudyNotes,
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRoute,
	type ModelRoutePurpose,
	type ModelRouteRequest,
	type RoutedStreamCompletion,
	type VirtualModelDefinition,
	type VirtualModels,
	withVirtualModelRouting,
} from "@earendil-works/pi-ai/virtual-models";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { ResetEntry, ToolResultEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type { ConversationId, Cursor, EntryId, EntryRecord, NextTaskState, Tx } from "../types.ts";
import { AgentDoc } from "./agent.ts";
import { defineExtension, defineTool, hook, hookTask } from "./define.ts";
import { GenerationTask } from "./generation.ts";
import { resolveBatonModel, runBatonSynthesis } from "./sliding-window/baton.ts";
import { effectiveWindowBounds, normalizeSlidingWindowConfig } from "./sliding-window/bounds.ts";
import { SlidingWindowLedgerDoc, SlidingWindowStateDoc, SlidingWindowTargetDoc } from "./sliding-window/docs.ts";
import { projectSwapTokens } from "./sliding-window/fit.ts";
import {
	buildProseTranscript,
	createEmptyLedger,
	fallbackProse,
	reconstructLedgerFromView,
	recordToolResult,
	renderBatonSummary,
} from "./sliding-window/ledger.ts";
import { MemorySlidingWindowArtifactStore, portableSha256Hex } from "./sliding-window/memory-store.ts";
import { spillToolOutput } from "./sliding-window/spill.ts";
import { EphemeralSliceStage, normalizeSliceKey } from "./sliding-window/staging.ts";
import { blockText, chooseKeepFrom, estimateTextTokens, selectCut, viewTurns } from "./sliding-window/turns.ts";
import type {
	BatonResult,
	BatonThinkingLevel,
	MechanicalLedger,
	RawTurn,
	SlidingWindowArtifactStore,
	SlidingWindowBounds,
	SlidingWindowConfig,
	SlidingWindowForkOptions,
	SlidingWindowHandle,
	SlidingWindowInspection,
	SlidingWindowOptions,
	SlidingWindowTargetContext,
	SwapProbe,
} from "./sliding-window/types.ts";
import { ToolTask } from "./tool.ts";
import type {
	Agent,
	BeforeAgentStartReset,
	BeforeAgentStartSidecarUsage,
	ContextView,
	Conversation,
	HookApi,
	HookTask,
	ModelRef,
	RunSummary,
	ToolRegistration,
} from "./types.ts";
import { recordSidecarUsage } from "./usage.ts";
import {
	applyForkGuardToRoute,
	attachVirtualRequestScope,
	BatonStateDoc,
	computeMessageCacheSnapshot,
	copyParentProviderSession,
	type ForkCacheGuard,
	VirtualModelStateDoc,
} from "./virtual-models.ts";

export { assistantText, resolveBatonModel, runBatonSynthesis } from "./sliding-window/baton.ts";
export {
	DEFAULT_SLIDING_WINDOW_CONFIG,
	effectiveWindowBounds,
	formatBytes,
	formatTokens,
	isReadToolName,
	isSearchToolName,
	normalizeSlidingWindowConfig,
	parseTokenCount,
	spillThresholdForTool,
} from "./sliding-window/bounds.ts";
export {
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	type SlidingWindowStateValue,
	SlidingWindowTargetDoc,
} from "./sliding-window/docs.ts";
export { calibrationRatio, projectSwapTokens, swapErrorPct } from "./sliding-window/fit.ts";
export {
	type ExportCheckpointedForkResult,
	type ExportCheckpointedForkStorageOptions,
	exportCheckpointedForkToStorage,
} from "./sliding-window/fork-export.ts";
export {
	buildBatonPrompts,
	buildProseTranscript,
	createEmptyLedger,
	fallbackProse,
	reconstructLedgerFromView,
	recordToolResult,
	renderBatonSummary,
	renderLedgerBlock,
} from "./sliding-window/ledger.ts";
export {
	createLayeredArtifactStore,
	MemorySlidingWindowArtifactStore,
	normalizeRefId,
	portableSha256Hex,
} from "./sliding-window/memory-store.ts";
export { buildMechanicalPreview, extractSymbolOutline } from "./sliding-window/preview.ts";
export { SPILL_EXEMPT_TOOLS, spillToolOutput } from "./sliding-window/spill.ts";
export { EphemeralSliceStage, normalizeSliceKey } from "./sliding-window/staging.ts";
export {
	blockText,
	chooseKeepFrom,
	estimateTextTokens,
	selectCut,
	turnFromMessages,
	viewTurns,
} from "./sliding-window/turns.ts";
export * from "./sliding-window/types.ts";

export const DEFAULT_SLIDING_WINDOW_PROVIDER = "sliding-window";
export const DEFAULT_SLIDING_WINDOW_MODEL_ID = "active";

const DEFAULT_MAX_TRACKED_CONVERSATIONS = 256;

interface PendingVirtualCompletion {
	readonly innerDef: VirtualModelDefinition;
	readonly innerModel: Model<Api>;
	readonly innerState: unknown;
	readonly purpose: ModelRoutePurpose;
	readonly turnIndex: number;
	readonly completion: RoutedStreamCompletion;
}

type BatonPrepInput = {
	readonly epoch: number;
	readonly prose: string;
	readonly previousDigest?: string;
	readonly batonModel: string;
	readonly batonThinkingLevel: BatonThinkingLevel;
	readonly batonMaxTokens: number;
	readonly activeProvider?: string;
	readonly activeModelId?: string;
	readonly firstKeptId: string | null;
	readonly keptTokens: number;
	readonly preparedThroughId?: string;
	readonly tokens: number;
};

interface ConvState {
	hydrated: boolean;
	persistedEnabled?: boolean;
	targetRef?: ModelRef;
	ledger: MechanicalLedger;
	ledgerDirty: boolean;
	stage: EphemeralSliceStage;
	pendingHydratedPaths: string[];
	pendingInnerState?: unknown;
	pendingRouteStateToSave?: JsonValue;
	pendingCompletion?: PendingVirtualCompletion;
	lastUsageTokens?: number;
	lastPhysicalModel?: Model<Api>;
	awaitingFirstResponse: boolean;
	probe?: SwapProbe;
	note: string;
}

const toJson = <T>(value: T): JsonValue => copyJson(value, { omitUndefinedProperties: true }) as JsonValue;

function promptTokensOf(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

function lastReportedTokens(messages: readonly Message[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.usage) {
			const t = promptTokensOf(m.usage);
			if (t > 0) return t;
		}
	}
	return undefined;
}

function resolveDeterministicTimestamp(messages: readonly Message[], fallbackMessages?: readonly Message[]): number {
	for (const list of [messages, fallbackMessages]) {
		if (!list) continue;
		for (let i = list.length - 1; i >= 0; i--) {
			const ts = list[i]?.timestamp;
			if (typeof ts === "number" && Number.isFinite(ts)) return ts;
		}
	}
	return 0;
}

const MAX_FORK_ENABLED_HINTS = 1024;
const forkEnabledHints = new Map<string, boolean>();

function recordForkEnabledHint(conversationId: ConversationId | string, enabled: boolean): void {
	const id = String(conversationId);
	if (forkEnabledHints.has(id)) {
		forkEnabledHints.delete(id);
	} else if (forkEnabledHints.size >= MAX_FORK_ENABLED_HINTS) {
		const oldest = forkEnabledHints.keys().next().value;
		if (oldest !== undefined) forkEnabledHints.delete(oldest);
	}
	forkEnabledHints.set(id, enabled);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isMechanicalLedger(value: unknown): value is MechanicalLedger {
	if (!isPlainObject(value)) return false;
	if (!Array.isArray(value.filesRead)) return false;
	if (!Array.isArray(value.filesEdited)) return false;
	if (!Array.isArray(value.recentRefs)) return false;
	if (!Array.isArray(value.recentErrors)) return false;
	if (typeof value.turnCount !== "number" || !Number.isFinite(value.turnCount)) return false;
	if (value.epoch !== undefined && (typeof value.epoch !== "number" || !Number.isFinite(value.epoch))) return false;
	if (value.lastProseDigest !== undefined && typeof value.lastProseDigest !== "string") return false;
	return true;
}

function isLedgerNonEmpty(ledger: MechanicalLedger | undefined): boolean {
	if (!ledger) return false;
	return (
		ledger.epoch > 0 ||
		ledger.turnCount > 0 ||
		ledger.filesRead.length > 0 ||
		ledger.filesEdited.length > 0 ||
		ledger.recentRefs.length > 0 ||
		ledger.recentErrors.length > 0 ||
		ledger.lastProseDigest !== undefined
	);
}

function cloneLedger(ledger: MechanicalLedger): MechanicalLedger {
	return {
		epoch: ledger.epoch,
		turnCount: ledger.turnCount,
		filesRead: [...ledger.filesRead],
		filesEdited: [...ledger.filesEdited],
		recentRefs: [...ledger.recentRefs],
		recentErrors: [...ledger.recentErrors],
		...(ledger.lastProseDigest !== undefined ? { lastProseDigest: ledger.lastProseDigest } : {}),
	};
}

function isModelObject(value: unknown): value is Model<Api> {
	return typeof value === "object" && value !== null && "api" in value && "id" in value && "provider" in value;
}

function resolveRefToPhysical(ref: ModelRef | undefined, models: Models | undefined): Model<Api> | undefined {
	if (!ref || !models) return undefined;
	const physical = isVirtualModelsRuntime(models)
		? models.getPhysicalModel(ref.provider, ref.modelId)
		: models.getModel(ref.provider, ref.modelId);
	return physical && !isVirtualModel(physical) ? physical : undefined;
}

function resolvePortablePath(filePath: string, cwd?: string): string {
	if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
	if (!cwd) return filePath;
	const cleanCwd = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
	return `${cleanCwd}/${filePath}`;
}

async function reconstructLedgerFromApi(api: HookApi, ctx: Context): Promise<MechanicalLedger> {
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await api.entries({}, 256, cursor, ctx);
		collected.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	if (collected.length === 0) return createEmptyLedger();

	let start = 0;
	for (let i = collected.length - 1; i >= 0; i--) {
		if (ResetEntry.is(collected[i])) {
			start = i;
			break;
		}
	}
	const active = collected.slice(start);
	const head = active[0];
	const view: ContextView = {
		head: head && ResetEntry.is(head) ? head : undefined,
		entries: active,
		contributions: active.map((entry) => entry.model ?? []),
		messages: active.flatMap((entry) => entry.model ?? []),
	};
	return reconstructLedgerFromView(view);
}

export function createSlidingWindow(options: SlidingWindowOptions = {}): SlidingWindowHandle {
	const vProvider = options.virtualModel?.provider?.trim() || DEFAULT_SLIDING_WINDOW_PROVIDER;
	const vId = options.virtualModel?.id?.trim() || DEFAULT_SLIDING_WINDOW_MODEL_ID;
	const vName = options.virtualModel?.name?.trim() || "Sliding Window";
	const maxTrackedConversations = Math.max(1, options.maxTrackedConversations ?? DEFAULT_MAX_TRACKED_CONVERSATIONS);

	const config: SlidingWindowConfig = normalizeSlidingWindowConfig({
		...(options.softCeilingTokens !== undefined ? { softCeilingTokens: options.softCeilingTokens } : {}),
		...(options.hardCeilingTokens !== undefined ? { hardCeilingTokens: options.hardCeilingTokens } : {}),
		...(options.keepRecentTokens !== undefined ? { keepRecentTokens: options.keepRecentTokens } : {}),
		...(options.softCeilingRatio !== undefined ? { softCeilingRatio: options.softCeilingRatio } : {}),
		...(options.hardCeilingRatio !== undefined ? { hardCeilingRatio: options.hardCeilingRatio } : {}),
		...(options.keepRecentRatio !== undefined ? { keepRecentRatio: options.keepRecentRatio } : {}),
		...(options.keepTail !== undefined ? { keepTail: options.keepTail } : {}),
		...(options.batonModel !== undefined ? { batonModel: options.batonModel } : {}),
		...(options.batonThinkingLevel !== undefined ? { batonThinkingLevel: options.batonThinkingLevel } : {}),
		...(options.batonMaxTokens !== undefined ? { batonMaxTokens: options.batonMaxTokens } : {}),
		...(options.spillEnabled !== undefined ? { spillEnabled: options.spillEnabled } : {}),
		...(options.spillThresholdBytes !== undefined ? { spillThresholdBytes: options.spillThresholdBytes } : {}),
		...(options.readSpillThresholdBytes !== undefined
			? { readSpillThresholdBytes: options.readSpillThresholdBytes }
			: {}),
		...(options.searchSpillThresholdBytes !== undefined
			? { searchSpillThresholdBytes: options.searchSpillThresholdBytes }
			: {}),
		...(options.toolThresholds !== undefined ? { toolThresholds: options.toolThresholds } : {}),
		...(options.stageReadSlices !== undefined ? { stageReadSlices: options.stageReadSlices } : {}),
		...(options.maxStageBytes !== undefined ? { maxStageBytes: options.maxStageBytes } : {}),
		...(options.sliceTtlTurns !== undefined ? { sliceTtlTurns: options.sliceTtlTurns } : {}),
	});

	const states = new Map<string, ConvState>();
	const enabledOverrides = new Map<string, boolean>();
	const activeInnerCalls = new WeakMap<
		ModelRouteRequest,
		{ readonly definition: VirtualModelDefinition; readonly innerRequest: ModelRouteRequest }
	>();
	const routedRequestMeta = new WeakMap<object, { readonly purpose: ModelRoutePurpose; readonly turnIndex: number }>();
	let globalEnabledOverride: boolean | undefined;
	let boundModels: Models | undefined;
	let ownStore: SlidingWindowArtifactStore | undefined;

	const getStore = (): SlidingWindowArtifactStore => {
		if (options.artifactStore) return options.artifactStore;
		if (!ownStore) ownStore = new MemorySlidingWindowArtifactStore();
		return ownStore;
	};

	const conv = (id: string): ConvState => {
		let s = states.get(id);
		if (s) {
			states.delete(id);
			states.set(id, s);
			return s;
		}
		s = {
			hydrated: false,
			ledger: createEmptyLedger(),
			ledgerDirty: false,
			stage: new EphemeralSliceStage({ maxTotalBytes: config.maxStageBytes, ttlTurns: config.sliceTtlTurns }),
			pendingHydratedPaths: [],
			awaitingFirstResponse: false,
			note: "idle",
		};
		states.set(id, s);
		while (states.size > maxTrackedConversations) {
			const oldest = states.keys().next().value;
			if (oldest === undefined) break;
			states.delete(oldest);
		}
		return s;
	};

	const setEnabledOverride = (id: string, enabled: boolean): void => {
		enabledOverrides.delete(id);
		enabledOverrides.set(id, enabled);
		while (enabledOverrides.size > maxTrackedConversations) {
			const oldest = enabledOverrides.keys().next().value;
			if (oldest === undefined) break;
			enabledOverrides.delete(oldest);
		}
	};

	const resolveEnabledOption = (
		enabled: SlidingWindowOptions["enabled"],
		conversationId: ConversationId | string,
	): boolean => {
		if (typeof enabled === "function") return enabled(conversationId as ConversationId);
		return enabled ?? true;
	};

	const isEnabled = (conversationId: ConversationId | string, c?: ConvState): boolean => {
		const id = String(conversationId);
		const perConv = enabledOverrides.get(id);
		if (perConv !== undefined) return perConv;
		if (c?.persistedEnabled !== undefined) return c.persistedEnabled;
		const forkHint = forkEnabledHints.get(id);
		if (forkHint !== undefined) return forkHint;
		if (globalEnabledOverride !== undefined) return globalEnabledOverride;
		return resolveEnabledOption(options.enabled, conversationId);
	};

	const isSlidingWindowRef = (ref: ModelRef | undefined): boolean =>
		Boolean(ref && ref.provider === vProvider && ref.modelId === vId);

	type ResolvedTarget =
		| { readonly kind: "physical"; readonly model: Model<Api> }
		| { readonly kind: "virtual"; readonly definition: VirtualModelDefinition; readonly model: Model<Api> };

	const resolveRefToTarget = (ref: ModelRef | undefined, models: Models | undefined): ResolvedTarget | undefined => {
		if (!ref || !models || isSlidingWindowRef(ref)) return undefined;
		if (isVirtualModelsRuntime(models)) {
			const def =
				models.getDefinition?.(ref.provider, ref.modelId) ??
				models.getVirtualModelDefinition(ref.provider, ref.modelId);
			if (def) {
				const vModel = models.getModel(ref.provider, ref.modelId);
				if (vModel) return { kind: "virtual", definition: def, model: vModel };
			}
		}
		const physical = resolveRefToPhysical(ref, models);
		return physical ? { kind: "physical", model: physical } : undefined;
	};

	const resolveTarget = (
		ctx: SlidingWindowTargetContext & { readonly targetRef?: ModelRef },
	): ResolvedTarget | undefined => {
		const models = ctx.models ?? boundModels;
		const stateTargetRef =
			ctx.targetRef ??
			(ctx.conversationId !== undefined ? states.get(String(ctx.conversationId))?.targetRef : undefined);
		if (stateTargetRef) {
			const fromDoc = resolveRefToTarget(stateTargetRef, models);
			if (fromDoc) return fromDoc;
		}
		const resolvedSpec = typeof options.target === "function" ? options.target(ctx) : options.target;
		if (resolvedSpec) {
			if (isModelObject(resolvedSpec)) {
				if (!isVirtualModel(resolvedSpec)) return { kind: "physical", model: resolvedSpec };
				const fromVirtualSpec = resolveRefToTarget(
					{ provider: resolvedSpec.provider, modelId: resolvedSpec.id },
					models,
				);
				if (fromVirtualSpec) return fromVirtualSpec;
			} else {
				const fromRef = resolveRefToTarget(resolvedSpec, models);
				if (fromRef) return fromRef;
			}
		}
		const reqTarget = (ctx.routeRequest?.state as { target?: Model<Api> } | undefined)?.target;
		if (reqTarget && !isVirtualModel(reqTarget)) return { kind: "physical", model: reqTarget };
		const agentTarget = resolveRefToTarget(ctx.agent?.model, models);
		if (agentTarget) return agentTarget;
		if (ctx.conversationId !== undefined) {
			const c = states.get(String(ctx.conversationId));
			if (c?.lastPhysicalModel && !isVirtualModel(c.lastPhysicalModel)) {
				return { kind: "physical", model: c.lastPhysicalModel };
			}
		}
		return undefined;
	};

	const resolveTargetModel = (
		ctx: SlidingWindowTargetContext & { readonly targetRef?: ModelRef },
	): Model<Api> | undefined => {
		const resolved = resolveTarget(ctx);
		if (!resolved) return undefined;
		if (resolved.kind === "physical") return resolved.model;
		if (resolved.model.contextWindow > 0) return resolved.model;
		const c = ctx.conversationId !== undefined ? states.get(String(ctx.conversationId)) : undefined;
		return c?.lastPhysicalModel ?? resolved.model;
	};

	const staticTarget =
		options.target && typeof options.target !== "function" && isModelObject(options.target)
			? options.target
			: undefined;

	const virtualModel: VirtualModelDefinition = {
		provider: vProvider,
		id: vId,
		name: staticTarget ? `${vName} • ${staticTarget.id}` : vName,
		thinkingLevels: staticTarget
			? [...getSupportedThinkingLevels(staticTarget)]
			: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		contextWindow: staticTarget ? staticTarget.contextWindow : 0,
		maxTokens: staticTarget ? staticTarget.maxTokens : 0,
		...(staticTarget ? { input: staticTarget.input } : {}),
		async route(req) {
			const reqState = req.state as
				| {
						narrowTail?: string;
						guard?: ForkCacheGuard;
						target?: Model<Api>;
						innerDef?: VirtualModelDefinition;
						innerModel?: Model<Api>;
						innerState?: unknown;
				  }
				| undefined;
			if (reqState && typeof reqState === "object") {
				routedRequestMeta.set(reqState, { purpose: req.purpose, turnIndex: req.turnIndex });
			}
			const tail = reqState?.narrowTail;
			const turn =
				req.purpose === "prompt" ||
				req.purpose === "continuation" ||
				req.purpose === "retry" ||
				req.purpose === "subagent";
			const attachTail = Boolean(tail && turn);

			let innerDef = reqState?.innerDef;
			let innerModel = reqState?.innerModel;
			let physicalTarget = reqState?.target;
			if (!innerDef && !physicalTarget) {
				const resolved = resolveTarget({ models: boundModels, routeRequest: req });
				if (resolved?.kind === "virtual") {
					innerDef = resolved.definition;
					innerModel = resolved.model;
				} else if (resolved?.kind === "physical") {
					physicalTarget = resolved.model;
				}
			}

			if (innerDef && innerModel) {
				const innerReq: ModelRouteRequest = {
					...req,
					model: innerModel,
					state: reqState?.innerState,
				};
				activeInnerCalls.set(req, { definition: innerDef, innerRequest: innerReq });
				const innerRoute = await innerDef.route(innerReq);
				const mergedTail = attachTail
					? innerRoute.ephemeralTail
						? typeof innerRoute.ephemeralTail === "string"
							? `${innerRoute.ephemeralTail}\n\n${tail}`
							: [
									...innerRoute.ephemeralTail,
									{
										role: "user" as const,
										content: tail!,
										timestamp: resolveDeterministicTimestamp(
											Array.isArray(innerRoute.messages) ? innerRoute.messages : req.messages,
											innerRoute.ephemeralTail,
										),
									},
								]
						: tail
					: innerRoute.ephemeralTail;
				const baseRoute: ModelRoute = {
					...innerRoute,
					...(mergedTail !== undefined ? { ephemeralTail: mergedTail } : {}),
					...(attachTail ? { disableContinuation: true } : {}),
				};
				return reqState?.guard ? applyForkGuardToRoute(baseRoute, reqState.guard) : baseRoute;
			}

			if (!physicalTarget) {
				throw new Error(
					`Sliding window virtual model ${vProvider}/${vId} requires a physical target model (pass options.target, SlidingWindowTargetDoc, or configure AgentDoc.model)`,
				);
			}
			const baseRoute: ModelRoute = {
				model: physicalTarget,
				thinkingLevel: req.thinkingLevel,
				...(attachTail ? { ephemeralTail: tail, disableContinuation: true } : {}),
			};
			return reqState?.guard ? applyForkGuardToRoute(baseRoute, reqState.guard) : baseRoute;
		},
		onToolCallStart(event) {
			const active = activeInnerCalls.get(event.request);
			active?.definition.onToolCallStart?.({
				toolName: event.toolName,
				turnIndex: event.turnIndex,
				request: active.innerRequest,
			});
		},
	};

	const BatonWriteTask = defineTask<
		{
			epoch: number;
			anchor?: JsonValue;
			summary: string;
			swappedAtTokens: number;
			ledger: JsonValue;
			harvestedStudyNotes?: string;
		},
		{ phase: "commit" },
		null
	>({
		name: "sliding-window.baton-write",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				await runtime.commit(async (tx): Promise<NextTaskState<{ phase: "commit" }, null>> => {
					const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
					doc.epoch = task.input.epoch;
					if (task.input.anchor !== undefined) {
						doc.anchorUser0 = task.input.anchor as JsonRepresentation<UserMessage>;
					} else {
						delete doc.anchorUser0;
					}
					doc.handoffSummary = task.input.summary;
					doc.swappedAtTokens = task.input.swappedAtTokens;
					doc.data = task.input.ledger;
					delete doc.staged;
					delete doc.preparingTaskId;
					if (task.input.harvestedStudyNotes !== undefined) {
						doc.harvestedStudyNotes = task.input.harvestedStudyNotes;
					}
					const ledgerDoc = await tx.doc(SlidingWindowLedgerDoc, runtime.conversationId);
					Object.assign(ledgerDoc, copyJson(task.input.ledger, { omitUndefinedProperties: true }));
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const BatonClearTask = defineTask<Record<string, never>, { phase: "commit" }, null>({
		name: "sliding-window.baton-clear",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (_task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(BatonStateDoc, runtime.conversationId);
					delete doc.staged;
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const BatonPrepTask = defineTask<BatonPrepInput, { phase: "synthesize" }, null>({
		name: "sliding-window.baton-prep",
		version: 1,
		initial: () => ({ phase: "synthesize" }),
		phases: {
			synthesize: async (task, runtime, ctx) => {
				const models = runtime.models;
				let available: readonly Model<Api>[] = [];
				try {
					available = await models.getAvailable();
				} catch {
					// resolveBatonModel falls back cleanly
				}
				const activeModel =
					task.input.activeProvider && task.input.activeModelId
						? resolveRefToPhysical(
								{ provider: task.input.activeProvider, modelId: task.input.activeModelId },
								models,
							)
						: undefined;
				const resolution = resolveBatonModel(task.input.batonModel, task.input.batonThinkingLevel, activeModel, {
					find: (p, id) => models.getModel(p, id),
					getAvailable: () => available,
				});
				if (!resolution) {
					await runtime.commit(async (tx) => {
						const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
						return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
					}, ctx);
					const c = states.get(String(runtime.conversationId));
					if (c) c.note = "helper failed: no helper model available";
					return;
				}
				const cInRam = states.get(String(runtime.conversationId));
				if (cInRam) cInRam.note = `preparing via ${resolution.model.id}`;

				let res: BatonResult;
				try {
					res = await runBatonSynthesis({
						model: resolution.model,
						thinkingLevel: resolution.thinkingLevel,
						maxTokens: task.input.batonMaxTokens,
						previousDigest: task.input.previousDigest,
						prose: task.input.prose,
						signal: runtime.signal,
						complete: (model, context, opts) => {
							const now = runtime.now();
							return models.completeSimple(
								model,
								{
									messages: [
										{ role: "system", content: context.systemPrompt, timestamp: now },
										...context.messages.map((m) => ({
											role: "user" as const,
											content: m.content,
											timestamp: m.timestamp,
										})),
									],
								},
								{ ...opts, cacheRetention: "none" },
							);
						},
					});
				} catch (err) {
					await runtime.commit(async (tx) => {
						const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
						return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
					}, ctx);
					if (cInRam && !runtime.signal.aborted) {
						cInRam.note = `helper failed: ${err instanceof Error ? err.message : String(err)}`;
					}
					return;
				}

				await runtime.commit(async (tx) => {
					await recordSidecarUsage(
						tx,
						runtime.conversationId,
						"baton",
						res.model.provider,
						res.model.id,
						res.usage,
					);
					const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
					if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
					if (baton.epoch === task.input.epoch) {
						baton.staged = {
							firstKeptId: task.input.firstKeptId,
							proseDigest: res.proseDigest,
							keptTokens: task.input.keptTokens,
							...(task.input.preparedThroughId ? { preparedThroughId: task.input.preparedThroughId } : {}),
							provider: res.model.provider,
							modelId: res.model.id,
							durationMs: res.durationMs,
						};
					}
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);

				if (cInRam) {
					cInRam.note = `ready (${res.durationMs}ms, ${res.model.id}, prepared at ${task.input.tokens})`;
				}
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
				if (baton.preparingTaskId === runtime.taskId) delete baton.preparingTaskId;
				return { status: "terminal" as const, outcome: { status: "aborted" as const } };
			}, ctx);
		},
	});

	const BatonLaunchTask = defineTask<BatonPrepInput, { phase: "commit" }, null>({
		name: "sliding-window.baton-launch",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const baton = await tx.doc(BatonStateDoc, runtime.conversationId);
					if (!baton.preparingTaskId && !baton.staged && baton.epoch === task.input.epoch) {
						const prepId = await tx.createTask(BatonPrepTask, task.input, {
							ownership: { kind: "conversation" },
							conversationId: runtime.conversationId,
							background: true,
						});
						baton.preparingTaskId = prepId;
						const c = states.get(String(runtime.conversationId));
						if (c) c.note = "preparing";
					}
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const buildPrepInput = (
		c: ConvState,
		turns: readonly RawTurn[],
		tokens: number,
		keepRecentTokens: number,
		activeModel: Model<Api> | undefined,
	): BatonPrepInput | undefined => {
		const cut = selectCut(turns, config.keepTail, keepRecentTokens);
		if (cut.aged.length === 0) return undefined;
		const preparedThroughId = turns.at(-1)?.id;
		const prose = buildProseTranscript(cut.aged);
		return {
			epoch: c.ledger.epoch,
			prose,
			...(c.ledger.lastProseDigest !== undefined ? { previousDigest: c.ledger.lastProseDigest } : {}),
			batonModel: config.batonModel,
			batonThinkingLevel: config.batonThinkingLevel,
			batonMaxTokens: config.batonMaxTokens,
			...(activeModel && !isVirtualModel(activeModel)
				? { activeProvider: activeModel.provider, activeModelId: activeModel.id }
				: {}),
			firstKeptId: cut.firstKeptId,
			keptTokens: cut.keptTokens,
			...(preparedThroughId ? { preparedThroughId } : {}),
			tokens,
		};
	};

	const projectPostSwap = (
		view: ContextView,
		tokens: number,
		keepFrom: string | null,
		summary: string,
		anchor: Message | undefined,
	): number => {
		const lastUserIdx = view.entries.findLastIndex(
			(_e, i) =>
				!(view.head !== undefined && i === 0) && (view.contributions[i] ?? []).some((m) => m.role === "user"),
		);
		const keptAt = keepFrom === null ? lastUserIdx : view.entries.findIndex((e) => String(e.id) === keepFrom);
		const boundary = keptAt < 0 ? view.entries.length : keptAt;
		const lastAssistantIdx = view.entries.findLastIndex((_e, i) =>
			(view.contributions[i] ?? []).some((m) => m.role === "assistant"),
		);
		const split = lastAssistantIdx < 0 ? view.entries.length : lastAssistantIdx;
		let estimatedPrompt = 0;
		let estimatedDropped = 0;
		let estimatedTrailing = 0;
		view.contributions.forEach((msgs, i) => {
			for (const m of msgs) {
				const t = estimateMessageTokens(m);
				const dropped = i < boundary && m.role !== "system";
				if (i < split) {
					estimatedPrompt += t;
					if (dropped) estimatedDropped += t;
				} else if (!dropped) {
					estimatedTrailing += t;
				}
			}
		});
		return projectSwapTokens({
			reportedTokens: tokens,
			estimatedPrompt,
			estimatedDropped,
			estimatedTrailing,
			summaryTokens: estimateTextTokens(summary),
			estimatedAdded: anchor ? estimateMessageTokens(anchor) : 0,
		});
	};

	const hydrate = async (c: ConvState, api: HookApi, ctx: Context, viewHint?: ContextView) => {
		const id = String(api.conversationId);
		const swState = await api.snapshot(SlidingWindowStateDoc, api.conversationId, ctx);
		if (swState?.enabled !== undefined) c.persistedEnabled = swState.enabled;
		const targetDoc = await api.snapshot(SlidingWindowTargetDoc, api.conversationId, ctx);
		c.targetRef = targetDoc?.target;
		forkEnabledHints.delete(id);
		if (c.hydrated) return;
		c.hydrated = true;

		const ledgerDoc = await api.snapshot(SlidingWindowLedgerDoc, api.conversationId, ctx);
		const baton = await api.snapshot(BatonStateDoc, api.conversationId, ctx);
		if (isLedgerNonEmpty(ledgerDoc)) {
			c.ledger = cloneLedger(ledgerDoc!);
		} else {
			const batonData: unknown = baton?.data;
			if (isMechanicalLedger(batonData)) {
				c.ledger = cloneLedger(batonData);
			} else if (viewHint) {
				c.ledger = reconstructLedgerFromView(viewHint);
			} else {
				c.ledger = await reconstructLedgerFromApi(api, ctx);
			}
		}
		if (baton && baton.epoch > c.ledger.epoch) {
			c.ledger = { ...c.ledger, epoch: baton.epoch };
		}
	};

	const commitPendingConvDocs = async (tx: Tx, conversationId: ConversationId, c: ConvState): Promise<void> => {
		if (c.ledgerDirty) {
			const ledgerDoc = await tx.doc(SlidingWindowLedgerDoc, conversationId);
			Object.assign(ledgerDoc, toJson(c.ledger));
			c.ledgerDirty = false;
		}
		if (c.pendingHydratedPaths.length > 0) {
			const swDoc = await tx.doc(SlidingWindowStateDoc, conversationId);
			if (swDoc.hydrate) {
				const existing = new Set(swDoc.hydrate.hydratedPaths);
				for (const p of c.pendingHydratedPaths) {
					if (!existing.has(p)) {
						swDoc.hydrate.hydratedPaths.push(p);
						existing.add(p);
					}
				}
			}
			c.pendingHydratedPaths = [];
		}
		if (c.pendingRouteStateToSave !== undefined) {
			const vmDoc = await tx.doc(VirtualModelStateDoc, conversationId);
			vmDoc.routeState = c.pendingRouteStateToSave;
			c.pendingRouteStateToSave = undefined;
		}
	};

	const WindowRoundTask = defineTask<
		{ readonly assistant: EntryId; readonly results: EntryId[] },
		{ phase: "commit" },
		null
	>({
		name: "sliding-window.round",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (task, runtime, ctx) => {
				const c = conv(String(runtime.conversationId));
				await hydrate(c, runtime, ctx);

				if (c.pendingCompletion) {
					const pending = c.pendingCompletion;
					c.pendingCompletion = undefined;
					if (pending.innerDef.onOutcome) {
						const toolResults: ToolResultMessage[] = [];
						for (const resultId of task.input.results) {
							const entry = await runtime.entry(ToolResultEntry, resultId, ctx);
							const msg = entry?.model?.[0];
							if (msg && msg.role === "toolResult") {
								toolResults.push(msg as ToolResultMessage);
							}
						}
						const nextState = await pending.innerDef.onOutcome({
							virtualModel: pending.innerModel,
							route: pending.completion.route,
							purpose: pending.purpose,
							turnIndex: pending.turnIndex,
							message: pending.completion.message,
							toolResults,
							ttfbMs: pending.completion.ttfbMs,
							durationMs: pending.completion.durationMs,
							aborted: pending.completion.message.stopReason === "aborted",
							state: pending.innerState,
						});
						if (nextState !== undefined) {
							c.pendingInnerState = nextState;
							c.pendingRouteStateToSave = toJson(nextState);
						}
					}
				}

				const enabled = isEnabled(runtime.conversationId, c);
				const view = await runtime.context(runtime.conversationId, ctx);
				const tokens = c.lastUsageTokens ?? lastReportedTokens(view.messages);

				type PreparedMidRunSwap = {
					readonly expectedEpoch: number;
					readonly nextEpoch: number;
					readonly keepEntryId: EntryId | "self";
					readonly resetModel: UserMessage[];
					readonly summary: string;
					readonly proseDigest: string;
					readonly anchor?: UserMessage;
					readonly data: JsonValue;
					readonly probeEstimated: number;
					readonly fallback: boolean;
					readonly harvestedStudyNotes?: string;
				};
				let preparedSwap: PreparedMidRunSwap | undefined;
				let cancelStaged = false;
				let prepInput: BatonPrepInput | undefined;

				if (enabled && !c.awaitingFirstResponse && tokens) {
					const agent = await runtime.agent(ctx);
					const baton = await runtime.snapshot(BatonStateDoc, runtime.conversationId, ctx);
					const activeModel = resolveTargetModel({
						conversationId: runtime.conversationId,
						targetRef: c.targetRef,
						agent,
						models: runtime.models,
					});
					if (activeModel && !isVirtualModel(activeModel)) c.lastPhysicalModel = activeModel;
					const { softCeilingTokens, hardCeilingTokens, keepRecentTokens } = effectiveWindowBounds(
						config,
						activeModel?.contextWindow,
					);
					const turns = viewTurns(view, (m) => estimateMessageTokens(m));
					const keptTokensFrom = (keepFrom: string | null) => {
						if (keepFrom === null) return 0;
						const at = turns.findIndex((t) => t.id === keepFrom);
						return at < 0 ? 0 : turns.slice(at).reduce((n, t) => n + t.estimatedTokens, 0);
					};

					const prepareSwap = async (opts: {
						keepFrom: string | null;
						proseDigest: string;
						fallback: boolean;
					}): Promise<PreparedMidRunSwap | undefined> => {
						const expectedEpoch = baton?.epoch ?? c.ledger.epoch;
						const nextEpoch = Math.max(c.ledger.epoch, expectedEpoch) + 1;
						const anchorTarget = activeModel ?? agent.model;
						const shouldAnchor =
							typeof options.anchorFirstUser === "function"
								? options.anchorFirstUser(anchorTarget)
								: (options.anchorFirstUser ?? true);
						const anchor = shouldAnchor
							? ((baton?.anchorUser0 as unknown as UserMessage | undefined) ??
								(view.messages.find((m) => m.role === "user") as UserMessage | undefined))
							: undefined;
						if (shouldAnchor && !anchor) return undefined;

						const keptTokens = keptTokensFrom(opts.keepFrom);
						const extraSections = await options.renderExtraSections?.({
							conversationId: runtime.conversationId,
							epoch: nextEpoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api: runtime,
							context: ctx,
						});
						let summary = renderBatonSummary({
							ledger: c.ledger,
							proseDigest: opts.proseDigest,
							epoch: nextEpoch,
							tokensBefore: tokens,
							keptTokens,
							fallback: opts.fallback,
							...(extraSections ? { extraSections } : {}),
						});
						const beforeRes = await options.onBeforeSwap?.({
							conversationId: runtime.conversationId,
							epoch: nextEpoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api: runtime,
							context: ctx,
							view,
							keepFrom: (opts.keepFrom as EntryId | null) ?? null,
							proseDigest: opts.proseDigest,
							summary,
							tokensBefore: tokens,
							keptTokens,
						});
						if (beforeRes?.cancel) {
							cancelStaged = true;
							return undefined;
						}
						if (beforeRes?.summary !== undefined) {
							summary = beforeRes.summary;
						} else if (beforeRes?.extraSections !== undefined) {
							summary = renderBatonSummary({
								ledger: c.ledger,
								proseDigest: opts.proseDigest,
								epoch: nextEpoch,
								tokensBefore: tokens,
								keptTokens,
								fallback: opts.fallback,
								extraSections: beforeRes.extraSections,
							});
						}

						const keepIdx =
							opts.keepFrom === null
								? view.entries.length
								: view.entries.findIndex((e) => String(e.id) === opts.keepFrom);
						const agedMessages = view.contributions.slice(0, keepIdx < 0 ? view.entries.length : keepIdx).flat();
						const newlyHarvested = harvestPostReadStudyNotes(agedMessages);
						const combinedNotes = [baton?.harvestedStudyNotes?.trim(), newlyHarvested?.trim()]
							.filter((s): s is string => Boolean(s && s.length > 0))
							.join("\n\n");

						const keepEntry =
							opts.keepFrom === null ? undefined : view.entries.find((e) => String(e.id) === opts.keepFrom);
						const handoff: UserMessage = { role: "user", content: summary, timestamp: runtime.now() };
						const resetModel: UserMessage[] = anchor ? [anchor, handoff] : [handoff];
						const probeEstimated = projectPostSwap(view, tokens, opts.keepFrom, summary, anchor);
						return {
							expectedEpoch,
							nextEpoch,
							keepEntryId: keepEntry ? keepEntry.id : "self",
							resetModel,
							summary,
							proseDigest: opts.proseDigest,
							...(anchor ? { anchor } : {}),
							data: {
								slidingWindow: true,
								epoch: nextEpoch,
								...(beforeRes?.data !== undefined ? { custom: beforeRes.data } : {}),
							},
							probeEstimated,
							fallback: opts.fallback,
							...(combinedNotes ? { harvestedStudyNotes: combinedNotes } : {}),
						};
					};

					const staged = baton?.staged;
					if (
						staged &&
						tokens >= softCeilingTokens &&
						(staged.firstKeptId === null || turns.some((t) => t.id === staged.firstKeptId))
					) {
						const keepFrom = chooseKeepFrom({
							stagedFirstKeptId: staged.firstKeptId,
							...(staged.preparedThroughId ? { preparedThroughId: staged.preparedThroughId } : {}),
							turns,
							midRun: true,
						});
						preparedSwap = await prepareSwap({
							keepFrom,
							proseDigest: staged.proseDigest,
							fallback: false,
						});
					} else if (tokens >= hardCeilingTokens) {
						const cut = selectCut(turns, config.keepTail, keepRecentTokens);
						const keepFrom = chooseKeepFrom({ stagedFirstKeptId: cut.firstKeptId, turns, midRun: true });
						const users = turns.filter((t) => t.role === "user").map((t) => t.text);
						preparedSwap = await prepareSwap({
							keepFrom,
							proseDigest: fallbackProse(c.ledger, users),
							fallback: true,
						});
					} else if (tokens >= softCeilingTokens && !baton?.preparingTaskId && !baton?.staged) {
						prepInput = buildPrepInput(c, turns, tokens, keepRecentTokens, activeModel);
					}
				}

				await runtime.commit(async (tx) => {
					if (preparedSwap) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (batonDoc.epoch === preparedSwap.expectedEpoch) {
							await tx.appendEntry(runtime.conversationId, {
								kind: ResetEntry.kind,
								head: preparedSwap.keepEntryId,
								model: preparedSwap.resetModel,
								data: preparedSwap.data,
							});
							c.ledger = {
								...c.ledger,
								epoch: preparedSwap.nextEpoch,
								lastProseDigest: preparedSwap.proseDigest,
							};
							c.ledgerDirty = true;
							c.probe = { epoch: preparedSwap.nextEpoch, estimated: preparedSwap.probeEstimated };
							c.awaitingFirstResponse = true;
							c.lastUsageTokens = undefined;
							c.note = preparedSwap.fallback
								? `burst fallback epoch ${preparedSwap.nextEpoch}`
								: `swapped epoch ${preparedSwap.nextEpoch}`;

							batonDoc.epoch = preparedSwap.nextEpoch;
							if (preparedSwap.anchor !== undefined) {
								batonDoc.anchorUser0 = toJson(preparedSwap.anchor) as JsonRepresentation<UserMessage>;
							} else {
								delete batonDoc.anchorUser0;
							}
							batonDoc.handoffSummary = preparedSwap.summary;
							batonDoc.swappedAtTokens = tokens;
							batonDoc.data = toJson(c.ledger);
							delete batonDoc.staged;
							delete batonDoc.preparingTaskId;
							if (preparedSwap.harvestedStudyNotes !== undefined) {
								batonDoc.harvestedStudyNotes = preparedSwap.harvestedStudyNotes;
							}
						}
					} else if (cancelStaged) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						delete batonDoc.staged;
						c.note = "swap cancelled";
					} else if (prepInput) {
						const batonDoc = await tx.doc(BatonStateDoc, runtime.conversationId);
						if (!batonDoc.preparingTaskId && !batonDoc.staged && batonDoc.epoch === prepInput.epoch) {
							const prepId = await tx.createTask(BatonPrepTask, prepInput, {
								ownership: { kind: "conversation" },
								conversationId: runtime.conversationId,
								background: true,
							});
							batonDoc.preparingTaskId = prepId;
							c.note = "preparing";
						}
					}

					await commitPendingConvDocs(tx, runtime.conversationId, c);
					// Always return null (AfterToolsDecision) so GenerationTask does not report a missing decision.
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const WindowFinishTask = defineTask<{ readonly run?: RunSummary }, { phase: "commit" }, null>({
		name: "sliding-window.finish",
		version: 1,
		initial: () => ({ phase: "commit" }),
		phases: {
			commit: async (_task, runtime, ctx) => {
				const c = conv(String(runtime.conversationId));
				await runtime.commit(async (tx) => {
					await commitPendingConvDocs(tx, runtime.conversationId, c);
					return { status: "terminal" as const, outcome: { status: "completed" as const, result: null } };
				}, ctx);
			},
		},
		abort: async (_t, runtime, ctx) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
		},
	});

	const recallTool = defineTool({
		name: "recall",
		description:
			"Read lines or search inside a spilled tool output by its ref (shown as ref:<hash>). Use startLine/endLine for a range, or query for matching lines with context.",
		parameters: obj({
			ref: str(),
			startLine: opt(int({ minimum: 1 })),
			endLine: opt(int({ minimum: 1 })),
			query: opt(str()),
			contextLines: opt(int({ minimum: 0, maximum: 30 })),
		}),
		replay: "safe",
		callers: ["model", "tools"],
		async execute(args) {
			const r = await getStore().recall({ ...args, ...(options.cwd ? { cwd: options.cwd } : {}) });
			return { output: [{ type: "text", text: r.text }] };
		},
	});

	const extension = defineExtension({
		name: options.extensionName ?? "pi.sliding-window",
		tools: [recallTool as ToolRegistration],
		tasks: [BatonWriteTask, BatonClearTask, BatonPrepTask, BatonLaunchTask, WindowRoundTask, WindowFinishTask],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, ctx) => {
					const guard = (await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx))?.forkGuard;
					if (guard?.allowedTools && !guard.allowedTools.includes(call.name)) {
						return { block: guard.blockedToolReason ?? `Tool ${call.name} is blocked on this fork` };
					}
					return undefined;
				},
				afterTool: async (call, result, api, ctx) => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					if (!isEnabled(api.conversationId, c)) return undefined;
					if (call.name === "recall" || call.parent !== undefined) return undefined;

					const args = (call.arguments ?? {}) as Record<string, unknown>;
					const raw = blockText(result.output);
					const path =
						typeof args.path === "string"
							? args.path
							: typeof args.file_path === "string"
								? args.file_path
								: typeof args.filePath === "string"
									? args.filePath
									: undefined;
					const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
					const effectiveCwd = agentState?.cwd ?? options.cwd;
					const canStageSlices = isSlidingWindowRef(agentState?.model);

					const isError = result.isError === true;
					if ((call.name === "edit" || call.name === "write") && !isError && path) {
						c.stage.evict(path, effectiveCwd);
					}

					const spill = await spillToolOutput({
						toolName: call.name,
						input: args,
						rawText: raw,
						isError,
						...(effectiveCwd ? { cwd: effectiveCwd } : {}),
						...(result.details !== undefined ? { details: result.details } : {}),
						config,
						store: getStore,
						stage: c.stage,
						canStageSlices,
						...(options.previewToolOutput ? { previewToolOutput: options.previewToolOutput } : {}),
					});
					c.ledger = recordToolResult(c.ledger, call.name, args, {
						isError,
						...(spill ? { spilled: spill.meta } : {}),
						...(isError ? { errorText: raw } : {}),
					});
					c.ledgerDirty = true;
					if (!spill) return undefined;
					const prior =
						result.details && typeof result.details === "object" && !Array.isArray(result.details)
							? result.details
							: {};
					return {
						...result,
						output: [{ type: "text", text: spill.previewText }],
						details: {
							...prior,
							slidingWindow: {
								ref: spill.meta.ref,
								bytes: spill.meta.byteLen,
								lines: spill.meta.lineCount,
								...(spill.meta.sourceSha256 ? { sourceSha256: spill.meta.sourceSha256 } : {}),
							},
						},
					};
				},
			}),
			hook(GenerationTask, {
				beforeRequest: async ({ messages }, api, ctx) => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					const swState = await api.snapshot(SlidingWindowStateDoc, api.conversationId, ctx);
					const vmState = await api.snapshot(VirtualModelStateDoc, api.conversationId, ctx);
					const agentState = await api.snapshot(AgentDoc, api.conversationId, ctx);
					const guard = vmState?.forkGuard;
					const enabled = isEnabled(api.conversationId, c);
					const effectiveCwd = agentState?.cwd ?? options.cwd;

					// B3: Scoped HydratePolicy (read via api.env or store.readLiveFile / store.getLatestBySourcePath, zero node:*).
					if (enabled && swState?.hydrate?.allowedPaths?.length) {
						const store = getStore();
						const hydratedSet = new Set(
							[...swState.hydrate.hydratedPaths, ...c.pendingHydratedPaths].map((p) =>
								normalizeSliceKey(p, effectiveCwd),
							),
						);
						const maxHydrateBytes = swState.hydrate.maxHydrateBytes ?? config.maxStageBytes;
						let usedHydrateBytes = 0;
						const env = await api.env?.(ctx).catch(() => undefined);

						for (const relPath of swState.hydrate.allowedPaths) {
							const normKey = normalizeSliceKey(relPath, effectiveCwd);
							if (hydratedSet.has(normKey)) continue;

							const ledgerRec = c.ledger.filesRead.find(
								(r) => normalizeSliceKey(r.path, effectiveCwd) === normKey,
							);
							const stored = await store.getLatestBySourcePath?.(relPath, effectiveCwd);
							const storedRef = ledgerRec?.ref ?? stored?.meta.ref;
							const storedSourceSha = ledgerRec?.sourceSha256 ?? ledgerRec?.sha256 ?? stored?.meta.sourceSha256;

							let live: { text: string; sha256: string } | undefined;
							if (env) {
								try {
									const readRes = await env.readTextFile(resolvePortablePath(relPath, effectiveCwd), ctx);
									if (readRes.ok) {
										live = { text: readRes.value, sha256: portableSha256Hex(readRes.value) };
									}
								} catch {
									live = undefined;
								}
							}
							if (!live && store.readLiveFile) {
								live = await store.readLiveFile(relPath, effectiveCwd);
							}

							let ref: string | undefined;
							let text: string | undefined;
							if (live) {
								if (storedRef && storedSourceSha && live.sha256 === storedSourceSha) {
									const candidateText =
										stored?.meta.ref === storedRef ? stored.text : await store.readFullText?.(storedRef);
									if (candidateText !== undefined && portableSha256Hex(candidateText) === live.sha256) {
										ref = storedRef;
										text = candidateText;
									} else {
										text = live.text;
										ref = portableSha256Hex(live.text).slice(0, 12);
									}
								} else {
									text = live.text;
									const storedMeta = storedRef
										? stored?.meta.ref === storedRef
											? stored.meta
											: await store.getMeta?.(storedRef)
										: undefined;
									ref =
										storedRef && storedMeta?.sha256 === live.sha256
											? storedRef
											: portableSha256Hex(live.text).slice(0, 12);
								}
							} else if (storedRef) {
								ref = storedRef;
								text = stored?.text ?? (await store.readFullText?.(storedRef));
							}

							if (text === undefined || ref === undefined) continue;
							const bytes = utf8ByteLength(text);
							if (usedHydrateBytes + bytes > maxHydrateBytes) continue;
							if (c.stage.stage({ path: relPath, ...(effectiveCwd ? { cwd: effectiveCwd } : {}), ref, text })) {
								usedHydrateBytes += bytes;
								c.pendingHydratedPaths.push(relPath);
								hydratedSet.add(normKey);
							}
						}
					}

					const tail = enabled && config.stageReadSlices ? c.stage.render() : undefined;
					const resolved = resolveTarget({
						conversationId: api.conversationId,
						targetRef: c.targetRef,
						models: api.models,
						...(agentState?.model ? { agent: { model: agentState.model } as Agent } : {}),
					});
					if (resolved?.kind === "physical") c.lastPhysicalModel = resolved.model;

					if (!tail && !guard && !resolved) return undefined;

					const disableContinuation =
						Boolean(tail) || guard?.disableContinuation === true ? true : guard?.disableContinuation;

					if (resolved?.kind === "virtual") {
						const cache = computeMessageCacheSnapshot(
							messages,
							(provider, modelId) => resolveRefToPhysical({ provider, modelId }, api.models),
							{ now: api.now() },
						);
						const innerState = c.pendingInnerState !== undefined ? c.pendingInnerState : vmState?.routeState;
						const scopeState = {
							...(tail ? { narrowTail: tail } : {}),
							...(guard ? { guard } : {}),
							innerDef: resolved.definition,
							innerModel: resolved.model,
							innerState,
						};
						return attachVirtualRequestScope(
							{ messages },
							{
								cache,
								deferOutcomeToHost: true,
								state: scopeState,
								...(disableContinuation !== undefined ? { disableContinuation } : {}),
								onStateChange: (nextState) => {
									c.pendingInnerState = nextState;
									c.pendingRouteStateToSave = toJson(nextState);
								},
								onRouteCommitted: (route) => {
									if (!isVirtualModel(route.model)) c.lastPhysicalModel = route.model;
								},
								onComplete: (completion) => {
									const meta = routedRequestMeta.get(scopeState);
									c.pendingCompletion = {
										innerDef: resolved.definition,
										innerModel: resolved.model,
										innerState: c.pendingInnerState !== undefined ? c.pendingInnerState : innerState,
										purpose: completion.purpose ?? meta?.purpose ?? "prompt",
										turnIndex: completion.turnIndex ?? meta?.turnIndex ?? c.ledger.turnCount,
										completion,
									};
								},
							},
						);
					}

					return attachVirtualRequestScope(
						{ messages },
						{
							state: {
								...(tail ? { narrowTail: tail } : {}),
								...(guard ? { guard } : {}),
								...(resolved ? { target: resolved.model } : {}),
							},
							...(disableContinuation !== undefined ? { disableContinuation } : {}),
						},
					);
				},
				afterResponse: async (message, api) => {
					const c = conv(String(api.conversationId));
					const hasToolCalls =
						message.stopReason === "toolUse" && message.content.some((b) => b.type === "toolCall");
					if (!hasToolCalls && c.pendingCompletion) {
						const pending = c.pendingCompletion;
						c.pendingCompletion = undefined;
						if (pending.innerDef.onOutcome) {
							const nextState = await pending.innerDef.onOutcome({
								virtualModel: pending.innerModel,
								route: pending.completion.route,
								purpose: pending.purpose,
								turnIndex: pending.turnIndex,
								message: pending.completion.message,
								toolResults: [],
								ttfbMs: pending.completion.ttfbMs,
								durationMs: pending.completion.durationMs,
								aborted: pending.completion.message.stopReason === "aborted",
								state: pending.innerState,
							});
							if (nextState !== undefined) {
								c.pendingInnerState = nextState;
								c.pendingRouteStateToSave = toJson(nextState);
							}
						}
					}

					if (
						message.provider === vProvider ||
						message.stopReason === "error" ||
						message.stopReason === "aborted"
					) {
						return;
					}
					const physical = api.models.getModel(message.provider, message.model);
					if (physical && !isVirtualModel(physical)) c.lastPhysicalModel = physical;
					const tokens = promptTokensOf(message.usage);
					if (tokens <= 0) return;
					c.lastUsageTokens = tokens;
					c.stage.advanceTurn();
					c.ledger = { ...c.ledger, turnCount: c.ledger.turnCount + 1 };
					c.ledgerDirty = true;
					if (c.awaitingFirstResponse) {
						c.awaitingFirstResponse = false;
						if (c.probe && c.probe.actual === undefined) c.probe = { ...c.probe, actual: tokens };
					}
				},
				afterTools: async (assistant, results, api, ctx) => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx);
					const enabled = isEnabled(api.conversationId, c);
					if (!enabled && !c.pendingCompletion && c.pendingHydratedPaths.length === 0 && !c.ledgerDirty) {
						return undefined;
					}
					return { tasks: [hookTask(WindowRoundTask, { assistant, results: [...results] })] };
				},
				afterRun: async (run, api, ctx) => {
					const c = conv(String(api.conversationId));
					if (
						!c.ledgerDirty &&
						c.pendingHydratedPaths.length === 0 &&
						c.pendingRouteStateToSave === undefined &&
						!isEnabled(api.conversationId, c)
					) {
						return undefined;
					}
					// If anything was mutated during the run, persist durably before run settles.
					await hydrate(c, api, ctx);
					if (!c.ledgerDirty && c.pendingHydratedPaths.length === 0 && c.pendingRouteStateToSave === undefined) {
						return undefined;
					}
					return { tasks: [hookTask(WindowFinishTask, { run })] };
				},
				beforeAgentStart: async (
					event,
					api,
					ctx,
				): Promise<
					| {
							reset?: BeforeAgentStartReset;
							tasks: HookTask[];
							sidecarUsage?: BeforeAgentStartSidecarUsage[];
					  }
					| undefined
				> => {
					const c = conv(String(api.conversationId));
					await hydrate(c, api, ctx, event.view);
					if (!isEnabled(api.conversationId, c)) return undefined;
					if (c.awaitingFirstResponse) return undefined;

					const view = event.view;
					const tokens = c.lastUsageTokens ?? lastReportedTokens(view.messages);
					if (!tokens) return undefined;

					const activeModel = resolveTargetModel({
						conversationId: api.conversationId,
						targetRef: c.targetRef,
						agent: event.agent,
						models: api.models,
					});
					if (activeModel && !isVirtualModel(activeModel)) c.lastPhysicalModel = activeModel;
					const { softCeilingTokens, hardCeilingTokens, keepRecentTokens } = effectiveWindowBounds(
						config,
						activeModel?.contextWindow,
					);
					const turns = viewTurns(view, (m) => estimateMessageTokens(m));
					const baton = await api.snapshot(BatonStateDoc, api.conversationId, ctx);

					const keptTokensFrom = (keepFrom: string | null) => {
						if (keepFrom === null) return 0;
						const at = turns.findIndex((t) => t.id === keepFrom);
						return at < 0 ? 0 : turns.slice(at).reduce((n, t) => n + t.estimatedTokens, 0);
					};

					const swap = async (opts: { keepFrom: string | null; proseDigest: string; fallback: boolean }) => {
						const epoch = Math.max(c.ledger.epoch, baton?.epoch ?? 0) + 1;
						const anchorTarget = activeModel ?? event.agent.model;
						const shouldAnchor =
							typeof options.anchorFirstUser === "function"
								? options.anchorFirstUser(anchorTarget)
								: (options.anchorFirstUser ?? true);
						const anchor = shouldAnchor
							? ((baton?.anchorUser0 as unknown as UserMessage | undefined) ??
								(view.messages.find((m) => m.role === "user") as UserMessage | undefined))
							: undefined;
						if (shouldAnchor && !anchor) return undefined;

						const keptTokens = keptTokensFrom(opts.keepFrom);
						const extraSections = await options.renderExtraSections?.({
							conversationId: api.conversationId,
							epoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api,
							context: ctx,
						});
						let summary = renderBatonSummary({
							ledger: c.ledger,
							proseDigest: opts.proseDigest,
							epoch,
							tokensBefore: tokens,
							keptTokens,
							fallback: opts.fallback,
							...(extraSections ? { extraSections } : {}),
						});
						const beforeRes = await options.onBeforeSwap?.({
							conversationId: api.conversationId,
							epoch,
							ledger: c.ledger,
							fallback: opts.fallback,
							api,
							context: ctx,
							view,
							keepFrom: (opts.keepFrom as EntryId | null) ?? null,
							proseDigest: opts.proseDigest,
							summary,
							tokensBefore: tokens,
							keptTokens,
						});
						if (beforeRes?.cancel) {
							c.note = "swap cancelled";
							return { tasks: [hookTask(BatonClearTask, {})] };
						}
						if (beforeRes?.summary !== undefined) {
							summary = beforeRes.summary;
						} else if (beforeRes?.extraSections !== undefined) {
							summary = renderBatonSummary({
								ledger: c.ledger,
								proseDigest: opts.proseDigest,
								epoch,
								tokensBefore: tokens,
								keptTokens,
								fallback: opts.fallback,
								extraSections: beforeRes.extraSections,
							});
						}

						const keepIdx =
							opts.keepFrom === null
								? view.entries.length
								: view.entries.findIndex((e) => String(e.id) === opts.keepFrom);
						const agedMessages = view.contributions.slice(0, keepIdx < 0 ? view.entries.length : keepIdx).flat();
						const newlyHarvested = harvestPostReadStudyNotes(agedMessages);
						const combinedNotes = [baton?.harvestedStudyNotes?.trim(), newlyHarvested?.trim()]
							.filter((s): s is string => Boolean(s && s.length > 0))
							.join("\n\n");

						const keepEntry =
							opts.keepFrom === null ? undefined : view.entries.find((e) => String(e.id) === opts.keepFrom);
						const handoff: UserMessage = { role: "user", content: summary, timestamp: api.now() };
						const resetModel: UserMessage[] = anchor ? [anchor, handoff] : [handoff];

						c.ledger = { ...c.ledger, epoch, lastProseDigest: opts.proseDigest };
						c.ledgerDirty = false;
						c.probe = { epoch, estimated: projectPostSwap(view, tokens, opts.keepFrom, summary, anchor) };
						c.awaitingFirstResponse = true;
						c.lastUsageTokens = undefined;
						c.note = opts.fallback ? `burst fallback epoch ${epoch}` : `swapped epoch ${epoch}`;
						return {
							reset: {
								...(keepEntry ? { head: keepEntry.id } : {}),
								model: resetModel,
								data: {
									slidingWindow: true,
									epoch,
									...(beforeRes?.data !== undefined ? { custom: beforeRes.data } : {}),
								},
							},
							tasks: [
								hookTask(BatonWriteTask, {
									epoch,
									...(anchor ? { anchor: toJson(anchor) } : {}),
									summary,
									swappedAtTokens: tokens,
									ledger: toJson(c.ledger),
									...(combinedNotes ? { harvestedStudyNotes: combinedNotes } : {}),
								}),
							],
						};
					};

					const staged = baton?.staged;
					if (
						staged &&
						tokens >= softCeilingTokens &&
						(staged.firstKeptId === null || turns.some((t) => t.id === staged.firstKeptId))
					) {
						const keepFrom = chooseKeepFrom({
							stagedFirstKeptId: staged.firstKeptId,
							...(staged.preparedThroughId ? { preparedThroughId: staged.preparedThroughId } : {}),
							turns,
							midRun: false,
						});
						return swap({
							keepFrom,
							proseDigest: staged.proseDigest,
							fallback: false,
						});
					}

					if (tokens >= hardCeilingTokens) {
						const cut = selectCut(turns, config.keepTail, keepRecentTokens);
						const keepFrom = chooseKeepFrom({ stagedFirstKeptId: cut.firstKeptId, turns, midRun: false });
						const users = turns.filter((t) => t.role === "user").map((t) => t.text);
						return swap({ keepFrom, proseDigest: fallbackProse(c.ledger, users), fallback: true });
					}

					if (tokens >= softCeilingTokens && !baton?.preparingTaskId && !baton?.staged) {
						const prepInput = buildPrepInput(c, turns, tokens, keepRecentTokens, activeModel);
						if (prepInput) {
							return { tasks: [hookTask(BatonLaunchTask, prepInput)] };
						}
					}
					return undefined;
				},
			}),
		],
	});

	return {
		extension,
		recallTool: recallTool as ToolRegistration,
		virtualModel,
		selection: { provider: vProvider, modelId: vId },
		wrapModels<TModels extends Models>(models: TModels): VirtualModels {
			if (isVirtualModelsRuntime(models)) {
				models.registerVirtualModel(virtualModel);
				boundModels = models;
				return models;
			}
			const wrapped = withVirtualModelRouting(models, { models: [virtualModel] });
			boundModels = wrapped;
			return wrapped;
		},
		inspect(conversationId: ConversationId | string): SlidingWindowInspection {
			const c = conv(String(conversationId));
			const liveTarget = resolveTargetModel({
				conversationId: conversationId as ConversationId,
				targetRef: c.targetRef,
				...(boundModels ? { models: boundModels } : {}),
			});
			const contextWindow =
				liveTarget?.contextWindow ?? c.lastPhysicalModel?.contextWindow ?? staticTarget?.contextWindow;
			const bounds: SlidingWindowBounds = effectiveWindowBounds(config, contextWindow);
			return {
				enabled: isEnabled(conversationId, c),
				epoch: c.ledger.epoch,
				note: c.note,
				lastUsageTokens: c.lastUsageTokens,
				probe: c.probe,
				ledger: c.ledger,
				stagedSlices: c.stage.list().length,
				bounds,
			};
		},
		setEnabled(enabled: boolean, conversationId?: ConversationId | string): void {
			if (conversationId !== undefined) {
				const id = String(conversationId);
				setEnabledOverride(id, enabled);
				forkEnabledHints.delete(id);
				const existing = states.get(id);
				if (existing) existing.persistedEnabled = enabled;
			} else {
				enabledOverrides.clear();
				globalEnabledOverride = enabled;
			}
		},
		release(conversationId: ConversationId | string): void {
			const id = String(conversationId);
			states.delete(id);
			enabledOverrides.delete(id);
			forkEnabledHints.delete(id);
		},
		async close(): Promise<void> {
			if (ownStore) {
				await ownStore.close?.();
				ownStore = undefined;
			} else if (options.artifactStore?.close) {
				await options.artifactStore.close();
			}
		},
	};
}

/**
 * Create a cache-guarded fork with sliding-window & baton state controls.
 * Preserves provider session shard affinity (`copyProviderSession`), thinking epoch (`preserveThinkingLevel`),
 * frozen tool declarations + execution-time `allowedTools`, `disableContinuation`, and optional baton/window overrides.
 */
export async function createSlidingWindowFork(
	parent: Conversation,
	at: EntryId,
	options: SlidingWindowForkOptions,
	context: Context,
): Promise<Conversation> {
	const {
		copyProviderSession = true,
		preserveThinkingLevel = true,
		inheritBatonState = true,
		slidingWindow,
		target,
		parentThinkingLevel,
		preservedThinkingLevel,
		allowThinkingEpochFlip,
		allowedTools,
		blockedToolReason,
		disableContinuation = true,
		preserveToolDeclarations = true,
		init,
		...createOptions
	} = options;

	const fork = await parent.fork(
		at,
		{
			...createOptions,
			init: async (tx, forkId) => {
				const sessionId = copyProviderSession ? await copyParentProviderSession(tx, parent.id, forkId) : undefined;
				const parentAgent = await tx.doc(AgentDoc, parent.id);
				const forkAgent = await tx.doc(AgentDoc, forkId);
				const epochLevel = parentThinkingLevel ?? parentAgent.thinkingLevel;
				const effectiveAllowFlip = allowThinkingEpochFlip === true || preserveThinkingLevel === false;
				const guardedLevel =
					!effectiveAllowFlip && epochLevel !== undefined && epochLevel !== "off"
						? (preservedThinkingLevel ?? epochLevel)
						: undefined;
				if (guardedLevel !== undefined && forkAgent.thinkingLevel === "off") {
					forkAgent.thinkingLevel = guardedLevel;
				}
				const vmState = await tx.doc(VirtualModelStateDoc, forkId);
				vmState.forkGuard = {
					disableContinuation,
					preserveToolDeclarations,
					...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
					...(blockedToolReason !== undefined ? { blockedToolReason } : {}),
					...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
					...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
				};
				if (inheritBatonState === false) {
					const baton = await tx.doc(BatonStateDoc, forkId);
					baton.epoch = 0;
					delete baton.anchorUser0;
					delete baton.handoffSummary;
					delete baton.swappedAtTokens;
					delete baton.data;
					delete baton.preparingTaskId;
					delete baton.staged;
					delete baton.harvestedStudyNotes;
				}
				if (slidingWindow !== undefined) {
					(await tx.doc(SlidingWindowStateDoc, forkId)).enabled = slidingWindow;
				}
				if (target !== undefined) {
					(await tx.doc(SlidingWindowTargetDoc, forkId)).target = target;
				}
				await init?.(tx, forkId);
			},
		},
		context,
	);
	if (slidingWindow !== undefined) {
		recordForkEnabledHint(fork.id, slidingWindow);
	}
	return fork;
}
