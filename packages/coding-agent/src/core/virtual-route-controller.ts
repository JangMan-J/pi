/**
 * Session-scoped controller for virtual-model routing, ephemeral turn envelopes,
 * boundary continuation tracking, tool allowlists, presentation suppression, and `onOutcome`.
 */
import type {
	AgentRequestUpdate,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareRequestContext,
	StreamFn,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { executeRoutedStream, type RoutedStreamCompletion } from "@earendil-works/pi-virtual-models";
import { suppressAssistantText } from "./message-presentation.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import {
	computeBranchCacheSnapshot,
	getVirtualModelState,
	isStatefulRoutePurpose,
	isStreamSuppressedRoute,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type ModelRouteRequest,
	purposeToReason,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelDefinition,
	type VirtualModelStateData,
} from "./virtual-models.ts";

export interface VirtualRouteControllerHost {
	readonly modelRuntime: ModelRuntime;
	readonly sessionManager: SessionManager;
	readonly isSubagent: boolean;
	getSelectedModel(): Model<any> | undefined;
	getStreamFunction(): StreamFn;
	setWorkingMessage(message: string | undefined): void;
	emitEntryAppended(entry: SessionEntry): void;
}

interface ActiveTurnRoute {
	virtualModel: Model<Api>;
	definition: VirtualModelDefinition;
	request: ModelRouteRequest;
	route: ModelRoute;
	purpose: ModelRoutePurpose;
	turnIndex: number;
	suppressStream: boolean;
	allowedTools: ReadonlySet<string> | undefined;
	completion?: RoutedStreamCompletion;
	dispatchedAt: number;
}

/** Coordinates per-turn virtual-model state for one `AgentSession`. */
export class VirtualRouteController {
	private readonly host: VirtualRouteControllerHost;
	private active: ActiveTurnRoute | undefined;
	private lastResolved: { model: Model<Api>; thinkingLevel: ThinkingLevel } | undefined;
	private boundaryContinuationPending = false;
	private runTurnIndex = 0;
	private statusOwned = false;

	constructor(host: VirtualRouteControllerHost) {
		this.host = host;
	}

	/** Currently active or most recently completed physical route under a virtual selection. */
	get routedModel(): { model: Model<Api>; thinkingLevel?: ThinkingLevel } | undefined {
		const selected = this.host.getSelectedModel();
		if (!selected || !isVirtualModel(selected)) return undefined;
		if (this.active) {
			return { model: this.active.route.model, thinkingLevel: this.active.route.thinkingLevel };
		}
		return this.lastResolved;
	}

	/** Whether `CacheWarmer` should warm the active or latest virtual route. */
	get keepCacheWarm(): boolean {
		return this.active?.route.keepCacheWarm !== false;
	}

	/** Whether the in-flight assistant response suppresses text and thinking presentation. */
	get suppressStream(): boolean {
		return this.active?.suppressStream === true;
	}

	/** Mark that a `turn_end` or `agent_before_settle` boundary requested `continue: true`. */
	markBoundaryContinuation(): void {
		this.boundaryContinuationPending = true;
	}

	/** Clear transient run state when starting a new run or switching branches/models. */
	resetRunState(options?: { clearLastResolved?: boolean }): void {
		this.active = undefined;
		this.boundaryContinuationPending = false;
		this.runTurnIndex = 0;
		this.clearOwnedStatus();
		if (options?.clearLastResolved) {
			this.lastResolved = undefined;
		}
	}

	/** Persist new router state on the session branch unless identical by reference to the current state. */
	setVirtualModelState(provider: string, modelId: string, nextState: unknown): SessionEntry | undefined {
		const currentState = getVirtualModelState(this.host.sessionManager.getBranch(), provider, modelId);
		if (nextState === undefined || nextState === currentState) return undefined;
		const data: VirtualModelStateData = { provider, modelId, state: nextState };
		const entryId = this.host.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data);
		const entry = this.host.sessionManager.getEntry(entryId);
		if (entry) this.host.emitEntryAppended(entry);
		return entry;
	}

	/** Resolve a conversational turn request and build its per-request execution envelope. */
	async prepareTurnRequest(
		selectedModel: Model<Api>,
		prepared: PrepareRequestContext,
		options: {
			failed?: AssistantMessage;
			signal?: AbortSignal;
			compactIfNeeded: (routedModel: Model<Api>) => Promise<PrepareRequestContext | undefined>;
		},
	): Promise<AgentRequestUpdate> {
		this.active = undefined;
		this.clearOwnedStatus();

		const boundaryContinuation = this.boundaryContinuationPending;
		this.boundaryContinuationPending = false;
		const turnIndex = this.runTurnIndex;

		const lastAssistantIndex = prepared.context.messages.findLastIndex((message) => message.role === "assistant");
		const hasUserAfterAssistant = prepared.context.messages
			.slice(lastAssistantIndex + 1)
			.some((message) => message.role === "user");
		const userTurn = !boundaryContinuation && hasUserAfterAssistant;

		const purpose: ModelRoutePurpose = options.failed
			? "retry"
			: userTurn
				? this.host.isSubagent && turnIndex === 0
					? "subagent"
					: "prompt"
				: "continuation";
		const reason = purposeToReason(purpose);

		const branch = this.host.sessionManager.getBranch();
		const state = getVirtualModelState(branch, selectedModel.provider, selectedModel.id);
		const cache = computeBranchCacheSnapshot(branch, (provider, id) =>
			this.host.modelRuntime.getPhysicalModel(provider, id),
		);

		const setStatus = (label: string | undefined) => this.applyStatus(label);
		const preparedRoute = await this.host.modelRuntime.prepareVirtualRoute(
			selectedModel,
			convertToLlm(prepared.context.messages),
			{
				reason,
				purpose,
				isSubagent: this.host.isSubagent,
				boundaryContinuation,
				turnIndex,
				thinkingLevel: prepared.thinkingLevel,
				signal: options.signal,
				failed: options.failed,
				state,
				cache,
				setStatus,
			},
		);

		let { route } = preparedRoute;
		if (isStatefulRoutePurpose(purpose) && route.state !== undefined && route.state !== state) {
			this.setVirtualModelState(selectedModel.provider, selectedModel.id, route.state);
		}

		let nextContext = prepared.context;
		const compacted = await options.compactIfNeeded(route.model);
		if (compacted) {
			nextContext = compacted.context;
		}

		if (route.statusLabel !== undefined) {
			this.applyStatus(route.statusLabel);
		} else {
			this.clearOwnedStatus();
		}

		const activeTurn: ActiveTurnRoute = {
			virtualModel: selectedModel,
			definition: preparedRoute.definition,
			request: preparedRoute.request,
			route,
			purpose,
			turnIndex,
			suppressStream: isStreamSuppressedRoute(route),
			allowedTools: route.allowedTools ? new Set(route.allowedTools) : undefined,
			dispatchedAt: Date.now(),
		};
		this.active = activeTurn;

		const streamFn: StreamFn = (_model, llmContext, streamOptions) =>
			executeRoutedStream({
				definition: activeTurn.definition,
				request: activeTurn.request,
				initialRoute: activeTurn.route,
				context: llmContext,
				baseOptions: streamOptions,
				dispatchPhysical: (physicalModel, physicalContext, physicalOptions) =>
					this.host.getStreamFunction()(physicalModel, physicalContext, physicalOptions),
				resolvePhysicalModel: (provider, id) =>
					this.host.modelRuntime.requirePhysicalTarget(
						`Virtual model ${selectedModel.provider}/${selectedModel.id}`,
						provider,
						id,
					),
				recordSidecarUsage: (kind, provider, modelId, usage, note) =>
					this.recordSidecarUsage(kind, provider, modelId, usage, note),
				onCommitRoute: (committed) => {
					route = committed;
					activeTurn.route = committed;
					activeTurn.suppressStream = isStreamSuppressedRoute(committed);
					activeTurn.allowedTools = committed.allowedTools ? new Set(committed.allowedTools) : undefined;
				},
				onUpdateState: (nextState) => {
					if (isStatefulRoutePurpose(purpose)) {
						this.setVirtualModelState(selectedModel.provider, selectedModel.id, nextState);
					}
				},
				onStatus: (label) => this.applyStatus(label),
				onComplete: (completion) => {
					activeTurn.completion = completion;
				},
			});

		return {
			context: nextContext,
			model: route.model,
			thinkingLevel: route.thinkingLevel,
			streamFn,
		};
	}

	/** Resolve a non-turn summarization call (`compaction`, `branch_summary`, `direct`) with read-only branch state. */
	async resolveOutOfBandCall(
		selectedModel: Model<Api>,
		messages: ReturnType<typeof convertToLlm>,
		thinkingLevel: ThinkingLevel,
		purpose: "compaction" | "branch_summary" | "direct",
		signal?: AbortSignal,
	): Promise<{ model: Model<Api>; thinkingLevel: ThinkingLevel; streamFn: StreamFn }> {
		const branch = this.host.sessionManager.getBranch();
		const state = getVirtualModelState(branch, selectedModel.provider, selectedModel.id);
		const cache = computeBranchCacheSnapshot(branch, (provider, id) =>
			this.host.modelRuntime.getPhysicalModel(provider, id),
		);
		const preparedRoute = await this.host.modelRuntime.prepareVirtualRoute(selectedModel, messages, {
			purpose,
			isSubagent: this.host.isSubagent,
			thinkingLevel,
			signal,
			state,
			cache,
			setStatus: (label) => this.applyStatus(label),
		});
		const { definition, request, route } = preparedRoute;
		const streamFn: StreamFn = (_model, llmContext, streamOptions) =>
			executeRoutedStream({
				definition,
				request,
				initialRoute: route,
				context: llmContext,
				baseOptions: streamOptions,
				dispatchPhysical: (physicalModel, physicalContext, physicalOptions) =>
					this.host.getStreamFunction()(physicalModel, physicalContext, physicalOptions),
				resolvePhysicalModel: (provider, id) =>
					this.host.modelRuntime.requirePhysicalTarget(
						`Virtual model ${selectedModel.provider}/${selectedModel.id}`,
						provider,
						id,
					),
				recordSidecarUsage: (kind, provider, modelId, usage, note) =>
					this.recordSidecarUsage(kind, provider, modelId, usage, note),
				onStatus: (label) => this.applyStatus(label),
				onComplete: async (completion) => {
					this.clearOwnedStatus();
					if (!definition.onOutcome) return;
					const outcome: ModelRouteOutcome = {
						virtualModel: selectedModel,
						route: completion.route,
						purpose,
						turnIndex: 0,
						message: completion.message,
						toolResults: [],
						ttfbMs: completion.ttfbMs,
						durationMs: completion.durationMs,
						aborted: completion.message.stopReason === "aborted",
						state,
					};
					try {
						await definition.onOutcome(outcome);
					} catch {
						// Outcome telemetry on out-of-band summarization must not fail the summary itself.
					}
				},
			});

		return {
			model: route.model,
			thinkingLevel: route.thinkingLevel,
			streamFn,
		};
	}

	/** Enforce per-route `allowedTools` before any extension or tool executes. */
	checkToolCall(context: BeforeToolCallContext): BeforeToolCallResult | undefined {
		const allowed = this.active?.allowedTools;
		if (!allowed || allowed.has(context.toolCall.name)) return undefined;
		return {
			block: true,
			reason:
				this.active?.route.blockedToolReason ?? `Tool "${context.toolCall.name}" is not available on this route.`,
		};
	}

	/** Mark streamed assistant messages when the active route suppresses presentation. */
	applyPresentationFlags(message: AssistantMessage, partial?: AssistantMessage): void {
		if (!this.active?.suppressStream) return;
		suppressAssistantText(message);
		if (partial) suppressAssistantText(partial);
	}

	/** Finalize turn telemetry, invoke `definition.onOutcome`, and update `lastResolved`. */
	async finishTurn(message: AssistantMessage, toolResults: readonly ToolResultMessage[]): Promise<void> {
		const completed = this.active;
		this.active = undefined;
		this.clearOwnedStatus();
		if (!completed) return;

		if (message.stopReason !== "error" && message.stopReason !== "aborted" && !isVirtualModel(message)) {
			this.runTurnIndex++;
			const resolved =
				this.host.modelRuntime.getPhysicalModel(message.provider, message.model) ?? completed.route.model;
			this.lastResolved = {
				model: resolved,
				thinkingLevel: message.thinkingLevel ?? completed.route.thinkingLevel,
			};
		}

		if (!completed.definition.onOutcome) return;

		const now = Date.now();
		const ttfbMs = completed.completion?.ttfbMs ?? Math.max(0, now - completed.dispatchedAt);
		const durationMs = completed.completion?.durationMs ?? Math.max(0, now - completed.dispatchedAt);
		const currentState = getVirtualModelState(
			this.host.sessionManager.getBranch(),
			completed.virtualModel.provider,
			completed.virtualModel.id,
		);

		const outcome: ModelRouteOutcome = {
			virtualModel: completed.virtualModel,
			route: completed.completion?.route ?? completed.route,
			purpose: completed.purpose,
			turnIndex: completed.turnIndex,
			message,
			toolResults,
			ttfbMs,
			durationMs,
			aborted: message.stopReason === "aborted",
			state: currentState,
		};

		const nextState = await completed.definition.onOutcome(outcome);
		if (isStatefulRoutePurpose(completed.purpose) && nextState !== undefined && nextState !== currentState) {
			this.setVirtualModelState(completed.virtualModel.provider, completed.virtualModel.id, nextState);
		}
	}

	private recordSidecarUsage(kind: string, provider: string, modelId: string, usage: Usage, note?: string): void {
		const entry = this.host.sessionManager.appendUsage(kind, provider, modelId, usage, note);
		this.host.emitEntryAppended(entry);
	}

	private applyStatus(label: string | undefined): void {
		if (label !== undefined) {
			this.statusOwned = true;
			this.host.setWorkingMessage(label);
			return;
		}
		this.clearOwnedStatus();
	}

	private clearOwnedStatus(): void {
		if (!this.statusOwned) return;
		this.statusOwned = false;
		this.host.setWorkingMessage(undefined);
	}
}
