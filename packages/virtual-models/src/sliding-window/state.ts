import type { Context } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import type { Api, Message, Model, Models } from "@earendil-works/pi-ai";
import {
	type ContextView,
	type ConversationId,
	type Cursor,
	defineDoc,
	type EntryRecord,
	type HookApi,
	type ModelRef,
	ResetEntry,
	type Tx,
} from "@earendil-works/pi-durable";
import { isVirtualModel } from "../core/predicates.ts";
import { isVirtualModelsRuntime } from "../core/runtime.ts";
import type { ModelRoutePurpose, RoutedStreamCompletion, VirtualModelDefinition } from "../core/types.ts";
import { BatonStateDoc, VirtualModelStateDoc } from "../durable/docs.ts";
import { effectiveWindowBounds, normalizeSlidingWindowConfig } from "./bounds.ts";
import { createEmptyLedger, reconstructLedgerFromView } from "./ledger.ts";
import { MemorySlidingWindowArtifactStore } from "./memory-store.ts";
import { EphemeralSliceStage } from "./staging.ts";
import type {
	BatonThinkingLevel,
	CheckpointLineageValue,
	MechanicalLedger,
	SlidingWindowArtifactStore,
	SlidingWindowBounds,
	SlidingWindowConfig,
	SlidingWindowInspection,
	SlidingWindowOptions,
	SlidingWindowStateValue,
	SlidingWindowTargetContext,
	SlidingWindowTargetValue,
	SwapProbe,
} from "./types.ts";

export type { CheckpointLineageValue, SlidingWindowStateValue };

export const DEFAULT_SLIDING_WINDOW_PROVIDER = "sliding-window";
export const DEFAULT_SLIDING_WINDOW_MODEL_ID = "active";

const DEFAULT_MAX_TRACKED_CONVERSATIONS = 256;
const MAX_FORK_ENABLED_HINTS = 1024;

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

export interface PendingVirtualCompletion {
	readonly innerDef: VirtualModelDefinition;
	readonly innerModel: Model<Api>;
	readonly innerState: unknown;
	readonly purpose: ModelRoutePurpose;
	readonly turnIndex: number;
	readonly completion: RoutedStreamCompletion;
}

export type BatonPrepInput = {
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

export interface ConvState {
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

export type ResolvedTarget =
	| { readonly kind: "physical"; readonly model: Model<Api> }
	| { readonly kind: "virtual"; readonly definition: VirtualModelDefinition; readonly model: Model<Api> };

export interface SlidingWindowState {
	readonly options: SlidingWindowOptions;
	readonly config: SlidingWindowConfig;
	readonly vProvider: string;
	readonly vId: string;
	readonly vName: string;
	readonly staticTarget: Model<Api> | undefined;
	readonly states: Map<string, ConvState>;
	readonly routedRequestMeta: WeakMap<object, { readonly purpose: ModelRoutePurpose; readonly turnIndex: number }>;
	readonly boundModels: Models | undefined;
	setBoundModels(models: Models | undefined): void;
	getStore(): SlidingWindowArtifactStore;
	conv(id: string): ConvState;
	isEnabled(conversationId: ConversationId | string, c?: ConvState): boolean;
	isSlidingWindowRef(ref: ModelRef | undefined): boolean;
	resolveTarget(ctx: SlidingWindowTargetContext & { readonly targetRef?: ModelRef }): ResolvedTarget | undefined;
	resolveTargetModel(ctx: SlidingWindowTargetContext & { readonly targetRef?: ModelRef }): Model<Api> | undefined;
	hydrate(c: ConvState, api: HookApi, ctx: Context, viewHint?: ContextView): Promise<void>;
	commitPendingConvDocs(tx: Tx, conversationId: ConversationId, c: ConvState): Promise<void>;
	inspect(conversationId: ConversationId | string): SlidingWindowInspection;
	setEnabled(enabled: boolean, conversationId?: ConversationId | string): void;
	release(conversationId: ConversationId | string): void;
	close(): Promise<void>;
}

const forkEnabledHints = new Map<string, boolean>();

export function recordForkEnabledHint(conversationId: ConversationId | string, enabled: boolean): void {
	const id = String(conversationId);
	if (forkEnabledHints.has(id)) {
		forkEnabledHints.delete(id);
	} else if (forkEnabledHints.size >= MAX_FORK_ENABLED_HINTS) {
		const oldest = forkEnabledHints.keys().next().value;
		if (oldest !== undefined) forkEnabledHints.delete(oldest);
	}
	forkEnabledHints.set(id, enabled);
}

export const toJson = <T>(value: T): JsonValue => copyJson(value, { omitUndefinedProperties: true }) as JsonValue;

export function promptTokensOf(usage: { input: number; cacheRead: number; cacheWrite: number }): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function lastReportedTokens(messages: readonly Message[]): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === "assistant" && m.usage) {
			const t = promptTokensOf(m.usage);
			if (t > 0) return t;
		}
	}
	return undefined;
}

export function resolveDeterministicTimestamp(
	messages: readonly Message[],
	fallbackMessages?: readonly Message[],
): number {
	for (const list of [messages, fallbackMessages]) {
		if (!list) continue;
		for (let i = list.length - 1; i >= 0; i--) {
			const ts = list[i]?.timestamp;
			if (typeof ts === "number" && Number.isFinite(ts)) return ts;
		}
	}
	return 0;
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

export function isModelObject(value: unknown): value is Model<Api> {
	return typeof value === "object" && value !== null && "api" in value && "id" in value && "provider" in value;
}

export function resolveRefToPhysical(ref: ModelRef | undefined, models: Models | undefined): Model<Api> | undefined {
	if (!ref || !models) return undefined;
	const physical = isVirtualModelsRuntime(models)
		? models.getPhysicalModel(ref.provider, ref.modelId)
		: models.getModel(ref.provider, ref.modelId);
	return physical && !isVirtualModel(physical) ? physical : undefined;
}

export function resolvePortablePath(filePath: string, cwd?: string): string {
	if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)) return filePath;
	if (!cwd) return filePath;
	const cleanCwd = cwd.endsWith("/") || cwd.endsWith("\\") ? cwd.slice(0, -1) : cwd;
	return `${cleanCwd}/${filePath}`;
}

export async function reconstructLedgerFromApi(api: HookApi, ctx: Context): Promise<MechanicalLedger> {
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

export function createSlidingWindowState(options: SlidingWindowOptions = {}): SlidingWindowState {
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

	const hydrate = async (c: ConvState, api: HookApi, ctx: Context, viewHint?: ContextView): Promise<void> => {
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

	return {
		options,
		config,
		vProvider,
		vId,
		vName,
		staticTarget,
		states,
		routedRequestMeta,
		get boundModels() {
			return boundModels;
		},
		setBoundModels(models) {
			boundModels = models;
		},
		getStore,
		conv,
		isEnabled,
		isSlidingWindowRef,
		resolveTarget,
		resolveTargetModel,
		hydrate,
		commitPendingConvDocs,
		inspect(conversationId) {
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
		setEnabled(enabled, conversationId) {
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
		release(conversationId) {
			const id = String(conversationId);
			states.delete(id);
			enabledOverrides.delete(id);
			forkEnabledHints.delete(id);
		},
		async close() {
			if (ownStore) {
				await ownStore.close?.();
				ownStore = undefined;
			} else if (options.artifactStore?.close) {
				await options.artifactStore.close();
			}
		},
	};
}
