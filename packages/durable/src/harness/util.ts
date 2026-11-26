import type { Context } from "@earendil-works/chord/context";
import type { Draft } from "@earendil-works/chord/delta";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	Api,
	Message,
	Model,
	Models,
	ModelThinkingLevel,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import { ResetEntry } from "../entries.ts";
import type { ExecutionEnv } from "../env/index.ts";
import { SessionFailed } from "../errors.ts";
import type {
	ContextEdit,
	ConversationId,
	Cursor,
	EntryDraft,
	EntryId,
	EntryQuery,
	NextTaskState,
	Page,
	Task,
	TaskId,
	TaskRuntime,
	Tx,
} from "../types.ts";
import { agentHooks, configure } from "./agent.ts";
import { LiveDoc, type LiveState } from "./live.ts";
import type { Agent, AgentChange, BeforeAgentStartResult, ContextView, GenerationHooks, HookTask } from "./types.ts";
import { recordSidecarUsage } from "./usage.ts";

/** Pending waits by key. Each settles once: through `resolve`, `rejectAll`, or cancellation of its context. */
export class Waiters<K, T> {
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		const waiter = Promise.withResolvers<T>();
		// Callers may hand the promise out only after later awaits (a job's result on the line): handled now, so a
		// rejection before then is not reported unhandled. The caller still gets it.
		waiter.promise.catch(() => {});
		if (signal?.aborted) {
			waiter.reject(signal.reason);
			return waiter.promise;
		}
		const set = this.#sets.get(key) ?? new Set();
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			const onAbort = (): void => {
				set.delete(waiter);
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}

	keys(): K[] {
		return [...this.#sets.keys()];
	}

	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		this.#sets.delete(key);
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	rejectAll(error: unknown): void {
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** Every item of a paginated scan, in page order. */
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** What a closed Harness rejects with: `SessionFailed` with the cause when it closed because the Session failed. */
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}

/** `{ extension }` when the extension is known. */
export function optionalExtension(extension: string | undefined): { readonly extension?: string } {
	return extension === undefined ? {} : { extension };
}

/** The scan of conversation `conversationId`'s history that `query` asks for, without fields an untyped caller added. */
export function conversationEntries(
	conversationId: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
): EntryQuery {
	return {
		conversationId,
		...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
		...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		...(query.order === undefined ? {} : { order: query.order }),
	};
}

// --- Routed-models & beforeAgentStart fork seams (EOF-isolated) ---
const VIRTUAL_REQUEST_SCOPE_SYMBOL = Symbol.for("pi-ai.virtualRequestScope");

export type SidecarSpend = {
	readonly kind: string;
	readonly provider: string;
	readonly modelId: string;
	readonly usage: Usage;
};

export type RoutedRequestPurpose =
	| "prompt"
	| "continuation"
	| "retry"
	| "compaction"
	| "branch_summary"
	| "subagent"
	| "direct";

export interface RoutedRequestScope {
	readonly purpose?: RoutedRequestPurpose;
	readonly turnIndex?: number;
	readonly disableContinuation?: boolean;
	readonly onRouteCommitted?: (route: {
		readonly model: Model<Api>;
		readonly thinkingLevel: ModelThinkingLevel;
	}) => void;
	readonly onSidecarUsage?: (kind: string, provider: string, modelId: string, usage: Usage, note?: string) => void;
}

/** Structural capability for `Models` wrappers that resolve routed catalog entries before dispatch. */
export interface RoutedModelsCapability extends Models {
	resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			readonly purpose?: RoutedRequestPurpose;
			readonly turnIndex?: number;
			readonly thinkingLevel: ModelThinkingLevel;
			readonly signal?: AbortSignal;
		},
	): Promise<{ readonly model: Model<Api>; readonly thinkingLevel: ModelThinkingLevel }>;
}

type PreparedHookTask = {
	readonly task: Task<JsonValue, { phase: string }, JsonValue, object>;
	readonly input: JsonValue;
};

/** Lightweight check avoiding transitive graph bloat on built-in entry points. */
export function isVirtualModel(model: { readonly api: string }): boolean {
	return model.api === "pi-virtual";
}

/** Structural type guard matching any `Models` wrapper implementing `RoutedModelsCapability`. */
export function hasRoutedModelsCapability(models: Models): models is RoutedModelsCapability {
	return "resolveModel" in models && typeof (models as RoutedModelsCapability).resolveModel === "function";
}

/** Attach routed request metadata without adding runtime edges to core entries. */
export function attachVirtualRequestScope<TOptions extends object>(
	options: TOptions,
	scope: RoutedRequestScope,
): TOptions {
	return { ...options, [VIRTUAL_REQUEST_SCOPE_SYMBOL]: scope };
}

/** Read attached routed request metadata placed by `attachVirtualRequestScope`. */
export function getVirtualRequestScope(carrier: object | undefined): RoutedRequestScope | undefined {
	if (!carrier || typeof carrier !== "object") return undefined;
	return (carrier as { [VIRTUAL_REQUEST_SCOPE_SYMBOL]?: RoutedRequestScope })[VIRTUAL_REQUEST_SCOPE_SYMBOL];
}

function asksBeforeAgentStart(agent: Agent, taskName: string): boolean {
	const hooks = agentHooks(agent, taskName);
	return hooks.some(({ handlers }) => typeof (handlers as Partial<GenerationHooks>).beforeAgentStart === "function");
}

async function firstPlacedInputEntry(tx: Tx, live: Draft<LiveState>): Promise<EntryId | undefined> {
	for (const id of live.run?.inputs ?? []) {
		const record = await tx.submission(id);
		if (record?.type === "input" && record.status === "placed" && record.entry !== undefined) {
			return record.entry;
		}
	}
	return undefined;
}

function requestPurpose(
	input: { readonly continuation?: true },
	attempt: number,
	turnIndex: number,
): RoutedRequestPurpose {
	if (attempt > 1) return "retry";
	if (input.continuation === true || turnIndex > 0) return "continuation";
	return "prompt";
}

/** Run `GenerationHooks.beforeAgentStart` once on attempt 1 of a fresh run; returns true if it committed state. */
export async function runBeforeAgentStart<
	TInput extends { readonly start?: true },
	TCheckpoint extends { phase: string },
	TResult,
>(
	taskName: string,
	input: TInput,
	checkpoint: { readonly attempt: number; readonly compacted?: unknown; readonly started?: true },
	runtime: TaskRuntime<TInput, TCheckpoint, TResult, GenerationHooks>,
	view: ContextView,
	agent: Agent,
	context: Context,
	prepareTasks: (
		runtime: TaskRuntime<TInput, TCheckpoint, TResult, GenerationHooks>,
		requests: readonly HookTask[],
		prepared: PreparedHookTask[],
	) => void,
	createTasks: (
		tx: Tx,
		runtime: TaskRuntime<TInput, TCheckpoint, TResult, GenerationHooks>,
		prepared: readonly PreparedHookTask[],
	) => Promise<TaskId[]>,
): Promise<boolean> {
	const { attempt, compacted, started } = checkpoint;
	if (input.start !== true || attempt !== 1 || started === true || compacted !== undefined) return false;
	if (!asksBeforeAgentStart(agent, taskName)) return false;

	let env: ExecutionEnv | undefined;
	try {
		env = await runtime.env(context);
	} catch (error) {
		if (context.abortSignal?.aborted) throw error;
		runtime.report(error, { kind: "host", callback: "env" });
	}

	const edits: ContextEdit[] = [];
	let reset: BeforeAgentStartResult["reset"];
	const hookEntries: EntryDraft[] = [];
	const agentChanges: AgentChange[] = [];
	const prepared: PreparedHookTask[] = [];
	const sidecarUsage: SidecarSpend[] = [];

	await runtime.hooks.each("beforeAgentStart", async (hook) => {
		const result = await hook({ view, agent, ...(env === undefined ? {} : { env }) }, runtime, context);
		if (result === undefined) return;
		if (result.edits !== undefined) edits.push(...result.edits);
		if (result.reset !== undefined) reset = result.reset;
		if (result.entries !== undefined) hookEntries.push(...result.entries);
		if (result.agent !== undefined) agentChanges.push(result.agent);
		if (result.tasks !== undefined) prepareTasks(runtime, result.tasks, prepared);
		if (result.sidecarUsage !== undefined) sidecarUsage.push(...result.sidecarUsage);
	});

	if (
		edits.length === 0 &&
		reset === undefined &&
		hookEntries.length === 0 &&
		agentChanges.length === 0 &&
		prepared.length === 0 &&
		sidecarUsage.length === 0
	) {
		return false;
	}

	const { conversationId } = runtime;
	await runtime.commit(async (tx): Promise<NextTaskState<TCheckpoint, TResult>> => {
		const live = await tx.doc(LiveDoc, conversationId);
		if (reset !== undefined) {
			const resolvedHead = reset.head ?? (await firstPlacedInputEntry(tx, live)) ?? "self";
			await tx.appendEntry(conversationId, {
				kind: ResetEntry.kind,
				head: resolvedHead,
				...(reset.model === undefined ? {} : { model: reset.model }),
				...(reset.data === undefined ? {} : { data: reset.data }),
				...(edits.length === 0 ? {} : { edits }),
			});
		} else if (edits.length > 0) {
			await tx.appendEntry(conversationId, { kind: "pi.context-edits", edits });
		}
		for (const entry of hookEntries) await tx.appendEntry(conversationId, entry);
		for (const change of agentChanges) await configure(tx, conversationId, change);
		await appendRequestSidecars(tx, conversationId, sidecarUsage);
		const checkpoint = { phase: "prepare", attempt, started: true } as unknown as TCheckpoint;
		if (prepared.length > 0) {
			const tasks = await createTasks(tx, runtime, prepared);
			return { status: "waiting", checkpoint, on: tasks, policy: "allSettled" };
		}
		return { status: "running", checkpoint };
	}, context);
	return true;
}

/** Resolve physical `contextWindow` when `resolved` is a virtual model with `contextWindow <= 0`. */
export async function resolveContextWindow<I extends { readonly continuation?: true }, S, R, H extends object>(
	resolved: Model<Api>,
	runtime: TaskRuntime<I, S, R, H>,
	view: ContextView,
	planned: readonly { readonly model?: readonly Message[] }[],
	input: I,
	attempt: number,
	thinkingLevel: ModelThinkingLevel | undefined,
	context: Context,
): Promise<number> {
	if (!isVirtualModel(resolved) || !hasRoutedModelsCapability(runtime.models) || resolved.contextWindow > 0) {
		return resolved.contextWindow;
	}
	const turnIndex = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.run?.turns ?? 0;
	const preview = [...view.messages, ...planned.flatMap((entry) => entry.model ?? [])];
	try {
		const routed = await runtime.models.resolveModel(resolved, preview, {
			purpose: requestPurpose(input, attempt, turnIndex),
			turnIndex,
			thinkingLevel: thinkingLevel ?? "off",
			signal: runtime.signal,
		});
		return routed.model.contextWindow;
	} catch {
		return 0;
	}
}

/** Resolve physical `maxTokens` ceiling for `CompactionTask.select` when `model` is virtual. */
export async function resolveCompactionMaxTokens<I, S, R, H extends object>(
	model: Model<Api>,
	runtime: TaskRuntime<I, S, R, H>,
	messages: readonly Message[],
	thinkingLevel: ModelThinkingLevel | undefined,
): Promise<number> {
	let limit = model.maxTokens;
	if (isVirtualModel(model) && hasRoutedModelsCapability(runtime.models) && limit <= 0) {
		try {
			const routed = await runtime.models.resolveModel(model, messages, {
				purpose: "compaction",
				thinkingLevel: thinkingLevel ?? "off",
				signal: runtime.signal,
			});
			limit = routed.model.maxTokens;
		} catch {
			limit = 0;
		}
	}
	return limit > 0 ? limit : Number.POSITIVE_INFINITY;
}

/** Bind virtual request scope, `disableContinuation`, routed `thinkingLevel`, and sidecar spend collection. */
export async function bindGenerationRequest<I extends { readonly continuation?: true }, S, R, H extends object>(
	input: I,
	runtime: TaskRuntime<I, S, R, H>,
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel | undefined,
	attempt: number,
	carrier: object | undefined,
	context: Context,
	base: SimpleStreamOptions,
): Promise<{
	readonly options: SimpleStreamOptions;
	thinkingLevel: () => ModelThinkingLevel | undefined;
	sidecars: () => { readonly sidecars?: readonly SidecarSpend[] };
}> {
	const hookScope = getVirtualRequestScope(carrier) ?? getVirtualRequestScope(base);
	const baseOptions: SimpleStreamOptions =
		hookScope?.disableContinuation !== undefined
			? { ...base, disableContinuation: hookScope.disableContinuation }
			: base;
	if (!isVirtualModel(model)) {
		return { options: baseOptions, thinkingLevel: () => thinkingLevel, sidecars: () => ({}) };
	}
	const turnIndex = (await runtime.snapshot(LiveDoc, runtime.conversationId, context))?.run?.turns ?? 0;
	const sidecars: SidecarSpend[] = [];
	let routedThinkingLevel: ModelThinkingLevel | undefined;
	const options = attachVirtualRequestScope(baseOptions, {
		...hookScope,
		purpose: hookScope?.purpose ?? requestPurpose(input, attempt, turnIndex),
		turnIndex: hookScope?.turnIndex ?? turnIndex,
		onRouteCommitted: (route) => {
			routedThinkingLevel = route.thinkingLevel;
			hookScope?.onRouteCommitted?.(route);
		},
		onSidecarUsage: (kind, provider, modelId, usage, note) => {
			sidecars.push({ kind, provider, modelId, usage });
			hookScope?.onSidecarUsage?.(kind, provider, modelId, usage, note);
		},
	});
	return {
		options,
		thinkingLevel: () => routedThinkingLevel ?? thinkingLevel,
		sidecars: () => (sidecars.length === 0 ? {} : { sidecars }),
	};
}

/** Bind virtual compaction scope and sidecar spend collection. */
export function bindCompactionRequest(
	model: Model<Api>,
	base: SimpleStreamOptions,
): { readonly options: SimpleStreamOptions; readonly sidecars: SidecarSpend[] } {
	const sidecars: SidecarSpend[] = [];
	const options = isVirtualModel(model)
		? attachVirtualRequestScope(base, {
				purpose: "compaction",
				onSidecarUsage: (kind, provider, modelId, usage) => {
					sidecars.push({ kind, provider, modelId, usage });
				},
			})
		: base;
	return { options, sidecars };
}

/** Persist collected sidecar spend entries into `UsageDoc.sidecars`. */
export async function appendRequestSidecars(
	tx: Tx,
	conversationId: ConversationId,
	sidecars?: readonly SidecarSpend[],
): Promise<void> {
	if (!sidecars) return;
	for (const sidecar of sidecars) {
		await recordSidecarUsage(tx, conversationId, sidecar.kind, sidecar.provider, sidecar.modelId, sidecar.usage);
	}
}
