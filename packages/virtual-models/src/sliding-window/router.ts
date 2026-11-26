import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type {
	ModelRoute,
	ModelRouteRequest,
	VirtualModelDefinition,
	VirtualStreamRequest,
} from "../core/types.ts";
import type { ForkCacheGuard } from "../durable/docs.ts";
import { applyForkGuardToRoute } from "../durable/fork-guard.ts";
import { resolveDeterministicTimestamp, type SlidingWindowState } from "./state.ts";

interface ActiveInnerCall {
	readonly definition: VirtualModelDefinition;
	readonly innerRequest: ModelRouteRequest;
}

interface ActiveVirtualRoute {
	readonly composedRoute: ModelRoute;
	readonly innerDef?: VirtualModelDefinition;
	readonly innerRequest?: ModelRouteRequest;
	readonly innerModel?: Model<Api>;
	latestInnerState: unknown;
	readonly mergeRoute: (route: ModelRoute) => ModelRoute;
}

export function createSlidingWindowVirtualModel(state: SlidingWindowState): VirtualModelDefinition {
	const { vProvider, vId, vName, staticTarget, routedRequestMeta } = state;
	const activeInnerCalls = new WeakMap<ModelRouteRequest, ActiveInnerCall>();
	const activeRoutesByState = new WeakMap<object, ActiveVirtualRoute>();
	const activeRoutesByMessages = new WeakMap<readonly Message[], ActiveVirtualRoute>();
	const activeInnerByRoute = new WeakMap<ModelRoute, ActiveVirtualRoute>();
	const activeInnerByReqState = new WeakMap<object, ActiveVirtualRoute>();

	const dispatchToInnerStream = async (active: ActiveVirtualRoute, streamReq: VirtualStreamRequest) => {
		const innerStreamReq: VirtualStreamRequest = {
			...active.innerRequest!,
			dispatch: (candidateRoute) => {
				const merged = active.mergeRoute(candidateRoute);
				if (candidateRoute.state !== undefined) {
					active.latestInnerState = candidateRoute.state;
				}
				activeInnerByRoute.set(merged, active);
				return streamReq.dispatch(merged);
			},
			recordUsage: streamReq.recordUsage,
			setState: (nextState) => {
				active.latestInnerState = nextState;
				streamReq.setState(nextState);
			},
			setStatus: streamReq.setStatus,
		};
		return await active.innerDef!.stream!(innerStreamReq);
	};

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
				const resolved = state.resolveTarget({ models: state.boundModels, routeRequest: req });
				if (resolved?.kind === "virtual") {
					innerDef = resolved.definition;
					innerModel = resolved.model;
				} else if (resolved?.kind === "physical") {
					physicalTarget = resolved.model;
				}
			}

			const mergeRoute = (candidateRoute: ModelRoute): ModelRoute => {
				const mergedTail = attachTail
					? candidateRoute.ephemeralTail
						? typeof candidateRoute.ephemeralTail === "string"
							? `${candidateRoute.ephemeralTail}\n\n${tail}`
							: [
									...candidateRoute.ephemeralTail,
									{
										role: "user" as const,
										content: tail!,
										timestamp: resolveDeterministicTimestamp(
											Array.isArray(candidateRoute.messages) ? candidateRoute.messages : req.messages,
											candidateRoute.ephemeralTail,
										),
									},
								]
						: tail
					: candidateRoute.ephemeralTail;
				const baseRoute: ModelRoute = {
					...candidateRoute,
					...(mergedTail !== undefined ? { ephemeralTail: mergedTail } : {}),
					...(attachTail ? { disableContinuation: true } : {}),
				};
				return reqState?.guard ? applyForkGuardToRoute(baseRoute, reqState.guard) : baseRoute;
			};

			const rememberActiveRoute = (active: ActiveVirtualRoute) => {
				if (reqState && typeof reqState === "object") {
					activeRoutesByState.set(reqState, active);
					activeInnerByReqState.set(reqState, active);
				}
				activeRoutesByMessages.set(req.messages, active);
				activeInnerByRoute.set(active.composedRoute, active);
			};

			if (innerDef && innerModel) {
				const innerReq: ModelRouteRequest = {
					...req,
					model: innerModel,
					state: reqState?.innerState,
				};
				activeInnerCalls.set(req, { definition: innerDef, innerRequest: innerReq });
				const innerRoute = await innerDef.route(innerReq);
				const composedRoute = mergeRoute(innerRoute);
				rememberActiveRoute({
					composedRoute,
					innerDef,
					innerRequest: innerReq,
					innerModel,
					latestInnerState: innerRoute.state !== undefined ? innerRoute.state : reqState?.innerState,
					mergeRoute,
				});
				return composedRoute;
			}

			if (!physicalTarget) {
				throw new Error(
					`Sliding window virtual model ${vProvider}/${vId} requires a physical target model (pass options.target, SlidingWindowTargetDoc, or configure AgentDoc.model)`,
				);
			}
			const composedRoute = mergeRoute({
				model: physicalTarget,
				thinkingLevel: req.thinkingLevel,
			});
			rememberActiveRoute({
				composedRoute,
				latestInnerState: undefined,
				mergeRoute,
			});
			return composedRoute;
		},
		async stream(streamReq: VirtualStreamRequest) {
			const reqState = streamReq.state;
			const active =
				(reqState && typeof reqState === "object" ? activeRoutesByState.get(reqState) : undefined) ??
				activeRoutesByMessages.get(streamReq.messages);
			if (reqState && typeof reqState === "object") activeRoutesByState.delete(reqState);
			activeRoutesByMessages.delete(streamReq.messages);

			if (active?.innerDef?.stream && active.innerRequest) {
				return await dispatchToInnerStream(active, streamReq);
			}
			if (active) {
				return streamReq.dispatch(active.composedRoute);
			}
			const fallbackRoute = await virtualModel.route(streamReq);
			const fallbackActive =
				(reqState && typeof reqState === "object" ? activeRoutesByState.get(reqState) : undefined) ??
				activeRoutesByMessages.get(streamReq.messages);
			if (reqState && typeof reqState === "object") activeRoutesByState.delete(reqState);
			activeRoutesByMessages.delete(streamReq.messages);
			if (fallbackActive?.innerDef?.stream && fallbackActive.innerRequest) {
				return await dispatchToInnerStream(fallbackActive, streamReq);
			}
			return streamReq.dispatch(fallbackRoute);
		},
		onToolCallStart(event) {
			const active = activeInnerCalls.get(event.request);
			active?.definition.onToolCallStart?.({
				toolName: event.toolName,
				turnIndex: event.turnIndex,
				request: active.innerRequest,
			});
		},
		async onOutcome(outcome) {
			const active =
				activeInnerByRoute.get(outcome.route) ??
				(outcome.state && typeof outcome.state === "object"
					? activeInnerByReqState.get(outcome.state)
					: undefined);
			if (!active?.innerDef?.onOutcome || !active.innerModel) return undefined;
			return await active.innerDef.onOutcome({
				...outcome,
				virtualModel: active.innerModel,
				state: active.latestInnerState,
			});
		},
	};

	return virtualModel;
}
