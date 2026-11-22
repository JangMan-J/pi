/**
 * `Models` wrapper adding framework-agnostic virtual-model registration, physical routing,
 * request-scoped telemetry/state carriers, and routed stream execution inside `@earendil-works/pi-ai`.
 */
import { lazyStream } from "./api/lazy.ts";
import { ModelsError } from "./auth/resolve.ts";
import type { AuthCheck } from "./auth/types.ts";
import { clampThinkingLevel, type Models, type ModelsSimpleStreamOptions, type Provider } from "./models.ts";
import type {
	AnyModel,
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	ModelThinkingLevel,
	ModelType,
	ModelTypeMap,
} from "./types.ts";
import { normalizeContext } from "./utils/transcript.ts";
import {
	createVirtualModel,
	EMPTY_ROUTE_CACHE_SNAPSHOT,
	findLatestResponse,
	isStatefulRoutePurpose,
	isVirtualModel,
	type ModelRoute,
	type ModelRouteCacheSnapshot,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type ModelRouteReason,
	type ModelRouteRequest,
	purposeToReason,
	type VirtualModelDefinition,
	withVirtualModels,
} from "./virtual-models.ts";
import { executeRoutedStream, type RoutedStreamCompletion, type SidecarUsageRecorder } from "./virtual-stream.ts";

/** Options for resolving a virtual model route ahead of or during a request. */
export interface ResolveVirtualModelOptions {
	reason?: ModelRouteReason;
	purpose?: ModelRoutePurpose;
	isSubagent?: boolean;
	boundaryContinuation?: boolean;
	turnIndex?: number;
	thinkingLevel: ModelThinkingLevel;
	signal?: AbortSignal;
	failed?: AssistantMessage;
	state?: unknown;
	cache?: ModelRouteCacheSnapshot;
	setStatus?: (label: string | undefined) => void;
}

/** Prepared virtual route bundle passed into `executeRoutedStream`. */
export interface PreparedVirtualRoute {
	definition: VirtualModelDefinition;
	request: ModelRouteRequest;
	route: ModelRoute;
}

/**
 * Per-request metadata carried across `Models.streamSimple` / `Models.completeSimple` calls
 * without leaking onto HTTP wire payloads. Preserved across object spread `{ ...options }`.
 */
export interface VirtualStreamRequestScope {
	readonly purpose?: ModelRoutePurpose;
	readonly isSubagent?: boolean;
	readonly boundaryContinuation?: boolean;
	readonly turnIndex?: number;
	/** Forward `disableContinuation` onto `SimpleStreamOptions` even for physical models (e.g. guarded forks). */
	readonly disableContinuation?: boolean;
	readonly failed?: AssistantMessage;
	/** Delivered as `request.state` to `VirtualModelDefinition.route(request)` (e.g. `BatonStateDoc` + active slices). */
	readonly state?: unknown;
	/** Delivered as `request.cache` to `VirtualModelDefinition.route(request)` (from `computeContextCacheSnapshot`). */
	readonly cache?: ModelRouteCacheSnapshot;
	/** Pre-resolved route bundle when the host hook (`beforeRequest`) already invoked `prepareVirtualRoute()`. */
	readonly prepared?: PreparedVirtualRoute;
	/** When true, skip firing `onOutcome` on stream end so the host can include `toolResults` after `afterTools`. */
	readonly deferOutcomeToHost?: boolean;
	readonly onStateChange?: (state: unknown) => Promise<void> | void;
	readonly onRouteCommitted?: (route: ModelRoute) => void;
	readonly onComplete?: (completion: RoutedStreamCompletion) => Promise<void> | void;
	readonly onSidecarUsage?: SidecarUsageRecorder;
	readonly setStatus?: (label: string | undefined) => void;
}

/** Extended options accepted by `VirtualModels.streamSimple` and `completeSimple`. */
export interface VirtualStreamOptions extends ModelsSimpleStreamOptions {
	purpose?: ModelRoutePurpose;
	isSubagent?: boolean;
	boundaryContinuation?: boolean;
	turnIndex?: number;
	failed?: AssistantMessage;
	state?: unknown;
	cache?: ModelRouteCacheSnapshot;
	onSidecarUsage?: SidecarUsageRecorder;
	setStatus?: (label: string | undefined) => void;
}

const VIRTUAL_REQUEST_SCOPE = Symbol.for("pi-ai.virtualRequestScope");

/** Attach browser- and worker-safe virtual route metadata to `SimpleStreamOptions` or hook carriers. */
export function attachVirtualRequestScope<TOptions extends object>(
	options: TOptions,
	scope: VirtualStreamRequestScope,
): TOptions {
	return {
		...options,
		[VIRTUAL_REQUEST_SCOPE]: scope,
	};
}

/** Read attached virtual route metadata from `SimpleStreamOptions` or hook carriers, if any. */
export function getVirtualRequestScope(options: object | undefined): VirtualStreamRequestScope | undefined {
	if (!options || typeof options !== "object") return undefined;
	return (options as { [VIRTUAL_REQUEST_SCOPE]?: VirtualStreamRequestScope })[VIRTUAL_REQUEST_SCOPE];
}

/** Options accepted by `withVirtualModelRouting()`. */
export interface WithVirtualModelRoutingOptions {
	/** Optional initial virtual models to register immediately. */
	readonly models?: readonly VirtualModelDefinition[];
	/** Optional host auth-availability check override per provider ID. */
	readonly hasConfiguredAuth?: (providerId: string) => Promise<boolean> | boolean;
}

/** `Models` wrapper with virtual-model registration, lookup, pre-resolution, and routed dispatch. */
export interface VirtualModels extends Models {
	registerVirtualModel(definition: VirtualModelDefinition): void;
	unregisterVirtualModel(providerId: string, modelId: string): boolean;
	getVirtualModelDefinition(providerId: string, modelId: string): VirtualModelDefinition | undefined;
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined;
	resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: ResolveVirtualModelOptions,
	): Promise<ModelRoute>;
	prepareVirtualRoute(
		model: Model<Api>,
		messages: readonly Message[],
		options: ResolveVirtualModelOptions,
	): Promise<PreparedVirtualRoute>;
	requirePhysicalTarget(virtualName: string, providerId: string, modelId: string): Promise<Model<Api>>;
}

interface RegisteredEntry {
	readonly model: Model<Api>;
	readonly definition: VirtualModelDefinition;
}

/** Type guard for a `Models` instance created by `withVirtualModelRouting()`. */
export function isVirtualModelsRuntime(models: Models): models is VirtualModels {
	return (
		"prepareVirtualRoute" in models &&
		typeof (models as VirtualModels).prepareVirtualRoute === "function" &&
		"registerVirtualModel" in models &&
		typeof (models as VirtualModels).registerVirtualModel === "function"
	);
}

/**
 * Wrap any `Models` implementation with virtual-model catalog injection and routed execution.
 * Physical models delegate untouched to `base`.
 */
export function withVirtualModelRouting(base: Models, options: WithVirtualModelRoutingOptions = {}): VirtualModels {
	const registry = new Map<string, Map<string, RegisteredEntry>>();

	const virtualEntriesFor = (providerId?: string): readonly RegisteredEntry[] => {
		if (providerId !== undefined) {
			return [...(registry.get(providerId)?.values() ?? [])];
		}
		const all: RegisteredEntry[] = [];
		for (const byId of registry.values()) all.push(...byId.values());
		return all;
	};

	const wrapProvider = (provider: Provider): Provider => {
		const entries = virtualEntriesFor(provider.id);
		if (entries.length === 0) return provider;
		return withVirtualModels(
			provider.id,
			provider,
			entries.map((entry) => entry.model),
		);
	};

	const synthProvider = (providerId: string): Provider | undefined => {
		const entries = virtualEntriesFor(providerId);
		if (entries.length === 0) return undefined;
		return withVirtualModels(
			providerId,
			undefined,
			entries.map((entry) => entry.model),
		);
	};

	const filterHiddenPhysical = <TModel extends AnyModel>(providerId: string, models: readonly TModel[]): TModel[] => {
		const ids = registry.get(providerId);
		if (!ids || ids.size === 0) return [...models];
		return models.filter(
			(model) =>
				!(
					model.api !== "pi-virtual" &&
					"contextWindow" in model &&
					ids.has(model.id) &&
					model.provider === providerId
				),
		);
	};

	const mergeProviderModels = (
		providerId: string | undefined,
		baseModels: readonly Model<Api>[],
	): readonly Model<Api>[] => {
		if (providerId !== undefined) {
			const vModels = virtualEntriesFor(providerId).map((entry) => entry.model);
			if (vModels.length === 0) return baseModels;
			return [...filterHiddenPhysical(providerId, baseModels), ...vModels];
		}
		if (registry.size === 0) return baseModels;
		const filtered = baseModels.filter((model) => !registry.get(model.provider)?.has(model.id));
		return [...filtered, ...virtualEntriesFor().map((entry) => entry.model)];
	};

	const mergeProviderAllModels = (
		providerId: string | undefined,
		baseModels: readonly AnyModel[],
	): readonly AnyModel[] => {
		if (providerId !== undefined) {
			const vModels = virtualEntriesFor(providerId).map((entry) => entry.model);
			if (vModels.length === 0) return baseModels;
			return [
				...baseModels.filter(
					(model) => !(model.provider === providerId && registry.get(providerId)?.has(model.id)),
				),
				...vModels,
			];
		}
		if (registry.size === 0) return baseModels;
		const filtered = baseModels.filter(
			(model) => !(registry.get(model.provider)?.has(model.id) && !("generateImages" in model)),
		);
		return [...filtered, ...virtualEntriesFor().map((entry) => entry.model)];
	};

	const getPhysicalModel = (providerId: string, modelId: string): Model<Api> | undefined => {
		const model = base.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	};

	const hasConfiguredAuth = async (providerId: string): Promise<boolean> => {
		if (options.hasConfiguredAuth) return await options.hasConfiguredAuth(providerId);
		return (await base.checkAuth(providerId)) !== undefined;
	};

	const requirePhysicalTarget = async (
		virtualName: string,
		providerId: string,
		modelId: string,
	): Promise<Model<Api>> => {
		const target = getPhysicalModel(providerId, modelId);
		const routed = `${virtualName} routed to ${providerId}/${modelId}`;
		if (!target) throw new ModelsError("provider", `${routed}, which is not a physical model.`);
		if (!(await hasConfiguredAuth(target.provider))) {
			throw new ModelsError("auth", `${routed}, which has no credentials.`);
		}
		return target;
	};

	const prepareVirtualRoute = async (
		model: Model<Api>,
		messages: readonly Message[],
		routeOpts: ResolveVirtualModelOptions,
	): Promise<PreparedVirtualRoute> => {
		const name = `Virtual model ${model.provider}/${model.id}`;
		const entry = registry.get(model.provider)?.get(model.id);
		if (!entry) throw new ModelsError("provider", `${name} is not registered.`);

		const purpose: ModelRoutePurpose =
			routeOpts.purpose ??
			(routeOpts.reason === "user"
				? routeOpts.isSubagent
					? "subagent"
					: "prompt"
				: routeOpts.reason === "continuation"
					? "continuation"
					: routeOpts.reason === "retry"
						? "retry"
						: "direct");
		const reason: ModelRouteReason = routeOpts.reason ?? purposeToReason(purpose);

		const latest = findLatestResponse(messages);
		const previousModel = latest && getPhysicalModel(latest.provider, latest.model);
		const failedModel = routeOpts.failed && getPhysicalModel(routeOpts.failed.provider, routeOpts.failed.model);

		const request: ModelRouteRequest = {
			model,
			thinkingLevel: routeOpts.thinkingLevel,
			reason,
			purpose,
			...(routeOpts.isSubagent ? { isSubagent: true } : {}),
			...(routeOpts.boundaryContinuation ? { boundaryContinuation: true } : {}),
			turnIndex: routeOpts.turnIndex ?? 0,
			previous: previousModel &&
				latest && {
					model: previousModel,
					thinkingLevel: latest.thinkingLevel,
					message: latest,
				},
			failed: failedModel &&
				routeOpts.failed && {
					model: failedModel,
					thinkingLevel: routeOpts.failed.thinkingLevel,
					message: routeOpts.failed,
				},
			state: routeOpts.state,
			cache: routeOpts.cache ?? EMPTY_ROUTE_CACHE_SNAPSHOT,
			messages,
			signal: routeOpts.signal,
			...(routeOpts.setStatus ? { setStatus: routeOpts.setStatus } : {}),
		};

		const rawRoute = await entry.definition.route(request);
		const target = await requirePhysicalTarget(name, rawRoute.model.provider, rawRoute.model.id);
		const validatedHedge = rawRoute.hedge
			? {
					...rawRoute.hedge,
					model: await requirePhysicalTarget(name, rawRoute.hedge.model.provider, rawRoute.hedge.model.id),
				}
			: undefined;
		const route: ModelRoute = {
			...rawRoute,
			model: target,
			thinkingLevel: clampThinkingLevel(target, rawRoute.thinkingLevel),
			...(validatedHedge ? { hedge: validatedHedge } : {}),
		};
		return { definition: entry.definition, request, route };
	};

	const registerVirtualModel = (definition: VirtualModelDefinition): void => {
		const { provider: providerId, id } = definition;
		if (!providerId.trim() || !id.trim()) {
			throw new Error("Virtual model provider and id must not be empty.");
		}
		const physical = base.getModel(providerId, id);
		if (physical && !isVirtualModel(physical)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const byId = registry.get(providerId) ?? new Map<string, RegisteredEntry>();
		byId.set(id, { model: createVirtualModel(definition), definition });
		registry.set(providerId, byId);
	};

	const unregisterVirtualModel = (providerId: string, id: string): boolean => {
		const byId = registry.get(providerId);
		if (!byId?.delete(id)) return false;
		if (byId.size === 0) registry.delete(providerId);
		return true;
	};

	for (const initial of options.models ?? []) {
		registerVirtualModel(initial);
	}

	const wrapped: VirtualModels = {
		registerVirtualModel,
		unregisterVirtualModel,
		getVirtualModelDefinition: (providerId, modelId) => registry.get(providerId)?.get(modelId)?.definition,
		getPhysicalModel,
		resolveModel: async (model, messages, routeOpts) => (await prepareVirtualRoute(model, messages, routeOpts)).route,
		prepareVirtualRoute,
		requirePhysicalTarget,

		getProviders: () => {
			const seen = new Set<string>();
			const result: Provider[] = [];
			for (const provider of base.getProviders()) {
				seen.add(provider.id);
				result.push(wrapProvider(provider));
			}
			for (const providerId of registry.keys()) {
				if (seen.has(providerId)) continue;
				const synthetic = synthProvider(providerId);
				if (synthetic) result.push(synthetic);
			}
			return result;
		},

		getProvider: (id) => {
			const provider = base.getProvider(id);
			if (provider) return wrapProvider(provider);
			return synthProvider(id);
		},

		getModels: (provider) => mergeProviderModels(provider, base.getModels(provider)),

		getModel: (provider, id) => {
			const v = registry.get(provider)?.get(id);
			if (v) return v.model;
			return base.getModel(provider, id);
		},

		getModelsOfType: <TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] => {
			if (type !== "chat") return base.getModelsOfType(type, provider);
			return mergeProviderModels(provider, base.getModels(provider)) as readonly ModelTypeMap[TType][];
		},

		getModelOfType: <TType extends ModelType>(
			type: TType,
			provider: string,
			id: string,
		): ModelTypeMap[TType] | undefined => {
			if (type === "chat") {
				const v = registry.get(provider)?.get(id);
				if (v) return v.model as ModelTypeMap[TType];
			}
			return base.getModelOfType(type, provider, id);
		},

		getAllModels: (provider) => mergeProviderAllModels(provider, base.getAllModels(provider)),
		refresh: (opts) => base.refresh(opts),

		checkAuth: async (providerId, opts): Promise<AuthCheck | undefined> => {
			const existing = await base.checkAuth(providerId, opts);
			if (existing) return existing;
			return registry.has(providerId) ? { source: "Virtual model", type: "api_key" } : undefined;
		},

		getAvailable: async (providerId, opts) =>
			mergeProviderModels(providerId, await base.getAvailable(providerId, opts)),

		getAvailableOfType: async <TType extends ModelType>(
			type: TType,
			providerId?: string,
			opts?: Parameters<Models["getAvailableOfType"]>[2],
		): Promise<readonly ModelTypeMap[TType][]> => {
			if (type !== "chat") return base.getAvailableOfType(type, providerId, opts);
			return mergeProviderModels(
				providerId,
				await base.getAvailable(providerId, opts),
			) as readonly ModelTypeMap[TType][];
		},

		getAllAvailable: async (providerId, opts) =>
			mergeProviderAllModels(providerId, await base.getAllAvailable(providerId, opts)),

		getAuth: ((providerOrModel: string | AnyModel, overrides?: Parameters<Models["getAuth"]>[1]) =>
			base.getAuth(providerOrModel as string, overrides)) as Models["getAuth"],
		login: (providerId, type, interaction, opts) => base.login(providerId, type, interaction, opts),
		logout: (providerId, opts) => base.logout(providerId, opts),
		stream: (model, context, opts) => base.stream(model, context, opts),
		complete: (model, context, opts) => base.complete(model, context, opts),

		streamSimple: (model, context, callOpts?: VirtualStreamOptions): AssistantMessageEventStream => {
			if (!isVirtualModel(model)) {
				return base.streamSimple(model, context, callOpts);
			}
			const transcript = normalizeContext(context);
			const attachedScope = getVirtualRequestScope(callOpts);
			return lazyStream(
				model,
				async () => {
					const {
						apiKey,
						headers,
						env,
						purpose,
						isSubagent,
						boundaryContinuation,
						turnIndex,
						failed,
						state,
						cache,
						onSidecarUsage,
						setStatus,
						...rest
					} = callOpts ?? {};
					delete (rest as { [VIRTUAL_REQUEST_SCOPE]?: unknown })[VIRTUAL_REQUEST_SCOPE];
					const resolvedPurpose = attachedScope?.purpose ?? purpose ?? "direct";
					const resolvedState = attachedScope?.state ?? state;
					const resolvedStatus = attachedScope?.setStatus ?? setStatus;
					const prepared =
						attachedScope?.prepared ??
						(await prepareVirtualRoute(model, transcript.messages, {
							purpose: resolvedPurpose,
							isSubagent: attachedScope?.isSubagent ?? isSubagent,
							boundaryContinuation: attachedScope?.boundaryContinuation ?? boundaryContinuation,
							turnIndex: attachedScope?.turnIndex ?? turnIndex ?? 0,
							thinkingLevel: callOpts?.reasoning ?? "off",
							signal: callOpts?.signal,
							failed: attachedScope?.failed ?? failed,
							state: resolvedState,
							cache: attachedScope?.cache ?? cache,
							setStatus: resolvedStatus,
						}));
					const persistState = async (nextState: unknown) => {
						if (
							isStatefulRoutePurpose(resolvedPurpose) &&
							nextState !== undefined &&
							nextState !== resolvedState
						) {
							await attachedScope?.onStateChange?.(nextState);
						}
					};
					if (prepared.route.state !== undefined) {
						await persistState(prepared.route.state);
					}
					attachedScope?.onRouteCommitted?.(prepared.route);

					const physicalTargets = new Map<string, Model<Api>>();
					const virtualName = `Virtual model ${model.provider}/${model.id}`;
					// Pre-resolve physical target up-front so resolvePhysicalModel inside executeRoutedStream is sync.
					const syncResolvePhysical = (providerId: string, modelId: string): Model<Api> => {
						const cached = physicalTargets.get(`${providerId}\0${modelId}`);
						if (cached) return cached;
						const resolved = getPhysicalModel(providerId, modelId);
						if (!resolved) {
							throw new ModelsError(
								"provider",
								`${virtualName} routed to ${providerId}/${modelId}, which is not physical.`,
							);
						}
						return resolved;
					};
					physicalTargets.set(
						`${prepared.route.model.provider}\0${prepared.route.model.id}`,
						prepared.route.model,
					);
					if (prepared.route.hedge) {
						physicalTargets.set(
							`${prepared.route.hedge.model.provider}\0${prepared.route.hedge.model.id}`,
							prepared.route.hedge.model,
						);
					}

					const resolvedSidecar = attachedScope?.onSidecarUsage ?? onSidecarUsage;
					return executeRoutedStream({
						definition: prepared.definition,
						request: prepared.request,
						initialRoute: prepared.route,
						context: transcript,
						baseOptions: rest,
						dispatchPhysical: (physicalModel, physicalContext, physicalOptions) => {
							const auth = physicalModel.provider === model.provider ? { apiKey, headers, env } : {};
							return base.streamSimple(physicalModel, physicalContext, { ...physicalOptions, ...auth });
						},
						resolvePhysicalModel: syncResolvePhysical,
						recordSidecarUsage: resolvedSidecar,
						onCommitRoute: (committed) => {
							attachedScope?.onRouteCommitted?.(committed);
						},
						onUpdateState: (nextState) => {
							void persistState(nextState);
						},
						onStatus: resolvedStatus,
						onComplete: async (completion) => {
							resolvedStatus?.(undefined);
							await attachedScope?.onComplete?.(completion);
							if (prepared.definition.onOutcome && !attachedScope?.deferOutcomeToHost) {
								const outcome: ModelRouteOutcome = {
									virtualModel: model,
									route: completion.route,
									purpose: resolvedPurpose,
									turnIndex: prepared.request.turnIndex,
									message: completion.message,
									toolResults: [],
									ttfbMs: completion.ttfbMs,
									durationMs: completion.durationMs,
									aborted: completion.message.stopReason === "aborted",
									state: resolvedState,
								};
								const outcomeState = await prepared.definition.onOutcome(outcome);
								if (outcomeState !== undefined) await persistState(outcomeState);
							}
						},
					});
				},
				undefined,
				callOpts?.signal,
			);
		},

		completeSimple: (model, context, callOpts?: VirtualStreamOptions) =>
			wrapped.streamSimple(model, context, callOpts).result(),

		streamDeferred: (model, handle, opts) => base.streamDeferred(model, handle, opts),
		fetchDeferred: (model, handle, opts) => base.fetchDeferred(model, handle, opts),
		cancelDeferred: (model, handle, opts) => base.cancelDeferred(model, handle, opts),
		generateImages: (model, context, opts) => base.generateImages(model, context, opts),
		classify: (model, context, opts) => base.classify(model, context, opts),
	};

	return wrapped;
}
