import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { attachVirtualRequestScope, withVirtualModelRouting } from "../src/core/runtime.ts";
import {
	EMPTY_ROUTE_CACHE_SNAPSHOT,
	type ModelRouteOutcome,
	type ModelRouteRequest,
	type VirtualModelDefinition,
} from "../src/core/types.ts";
import type { ForkCacheGuard } from "../src/durable/docs.ts";
import { createSlidingWindowVirtualModel } from "../src/sliding-window/router.ts";
import { createSlidingWindowState } from "../src/sliding-window/state.ts";

const makeRequest = (model: Model<string>, overrides: Partial<ModelRouteRequest> = {}): ModelRouteRequest => ({
	model,
	thinkingLevel: "off",
	reason: "user",
	purpose: "prompt",
	turnIndex: 0,
	cache: EMPTY_ROUTE_CACHE_SNAPSHOT,
	messages: [{ role: "user", content: "hello", timestamp: 12_345 }],
	...overrides,
});

describe("sliding-window router (S16)", () => {
	it("is self-sufficient without legacy pi-ai/virtual-models or pi-durable/{virtual-models,sliding-window} imports", () => {
		const routerPath = fileURLToPath(new URL("../src/sliding-window/router.ts", import.meta.url));
		const source = readFileSync(routerPath, "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
	});

	it("exposes static target metadata and routes directly to static or dynamic targets", async () => {
		const fastProv = fauxProvider({
			provider: "sw-r-fast",
			models: [{ id: "fast-1", contextWindow: 16_000, maxTokens: 512, reasoning: true }],
		});
		const altProv = fauxProvider({
			provider: "sw-r-alt",
			models: [{ id: "alt-1", contextWindow: 64_000, maxTokens: 2048 }],
		});
		const models = createModels();
		models.setProvider(fastProv.provider);
		models.setProvider(altProv.provider);

		const fastModel = models.getModel("sw-r-fast", "fast-1")!;
		const altModel = models.getModel("sw-r-alt", "alt-1")!;

		const staticState = createSlidingWindowState({
			target: fastModel,
			virtualModel: { provider: "sw-custom", id: "main", name: "Custom SW" },
		});
		const staticVm = createSlidingWindowVirtualModel(staticState);
		expect(staticVm.provider).toBe("sw-custom");
		expect(staticVm.id).toBe("main");
		expect(staticVm.name).toBe("Custom SW • fast-1");
		expect(staticVm.contextWindow).toBe(16_000);
		expect(staticVm.maxTokens).toBe(512);
		expect(staticVm.thinkingLevels).toContain("high");

		const staticRoute = await staticVm.route(makeRequest(fastModel, { thinkingLevel: "medium" }));
		expect(staticRoute.model).toBe(fastModel);
		expect(staticRoute.thinkingLevel).toBe("medium");

		const dynamicState = createSlidingWindowState({
			softCeilingRatio: 0.5,
			hardCeilingRatio: 0.75,
			keepRecentRatio: 0.2,
		});
		const dynamicVm = createSlidingWindowVirtualModel(dynamicState);
		expect(dynamicVm.contextWindow).toBe(0);
		expect(dynamicVm.maxTokens).toBe(0);
		expect(dynamicVm.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

		await expect(dynamicVm.route(makeRequest(fastModel))).rejects.toThrow(
			/Sliding window virtual model sliding-window\/active requires a physical target model/,
		);

		dynamicState.setBoundModels(models);
		const reqState = { target: altModel };
		const dynRoute = await dynamicVm.route(
			makeRequest(fastModel, { state: reqState, purpose: "retry", turnIndex: 3 }),
		);
		expect(dynRoute.model).toBe(altModel);
		expect(dynamicState.routedRequestMeta.get(reqState)).toEqual({ purpose: "retry", turnIndex: 3 });

		// Dynamic bounds reflect resolved targetRef when inspect() runs
		dynamicState.conv("conv-dyn").targetRef = { provider: "sw-r-alt", modelId: "alt-1" };
		const inspected = dynamicState.inspect("conv-dyn");
		expect(inspected.bounds).toEqual({
			softCeilingTokens: 32_000,
			hardCeilingTokens: 48_000,
			keepRecentTokens: 12_800,
		});
	});

	it("injects ephemeralTail and disableContinuation on conversational purposes only and applies ForkCacheGuard", async () => {
		const prov = fauxProvider({
			provider: "sw-r-tail",
			models: [{ id: "m-1", contextWindow: 32_000, maxTokens: 1024, reasoning: true }],
		});
		const models = createModels();
		models.setProvider(prov.provider);
		const target = models.getModel("sw-r-tail", "m-1")!;

		const state = createSlidingWindowState({ target });
		const vm = createSlidingWindowVirtualModel(state);

		const guard: ForkCacheGuard = {
			disableContinuation: true,
			preserveToolDeclarations: true,
			allowedTools: ["read", "recall"],
			blockedToolReason: "blocked-in-fork",
			preservedThinkingLevel: "high",
			sessionId: "shard-99",
		};

		for (const purpose of ["prompt", "continuation", "retry", "subagent"] as const) {
			const route = await vm.route(
				makeRequest(target, {
					purpose,
					thinkingLevel: "off",
					state: { narrowTail: "SLICE_A", guard },
				}),
			);
			expect(route.ephemeralTail).toBe("SLICE_A");
			expect(route.disableContinuation).toBe(true);
			expect(route.thinkingLevel).toBe("high");
			expect(route.sessionId).toBe("shard-99");
			expect(route.allowedTools).toEqual(["read", "recall"]);
			expect(route.blockedToolReason).toBe("blocked-in-fork");
			expect(route.preserveToolDeclarations).toBe(true);
		}

		for (const purpose of ["compaction", "branch_summary", "direct"] as const) {
			const route = await vm.route(
				makeRequest(target, {
					purpose,
					thinkingLevel: "low",
					state: { narrowTail: "SLICE_A" },
				}),
			);
			expect(route.ephemeralTail).toBeUndefined();
			expect(route.disableContinuation).toBeUndefined();
		}
	});

	it("composes inner virtual model route, deterministic Message[] ephemeralTail, stream(), onToolCallStart, and onOutcome", async () => {
		const candA = fauxProvider({
			provider: "sw-r-a",
			models: [{ id: "cand-a", contextWindow: 32_000, maxTokens: 1024 }],
		});
		const candB = fauxProvider({
			provider: "sw-r-b",
			models: [{ id: "cand-b", contextWindow: 32_000, maxTokens: 1024 }],
		});
		const models = createModels();
		models.setProvider(candA.provider);
		models.setProvider(candB.provider);

		const modelA = models.getModel("sw-r-a", "cand-a")!;
		const modelB = models.getModel("sw-r-b", "cand-b")!;

		const seenInnerStates: unknown[] = [];
		const seenToolStarts: Array<{ toolName: string; turnIndex: number; innerState: unknown }> = [];
		const seenOutcomes: Array<{ virtualId: string; routeModel: string; state: unknown }> = [];

		const innerDef: VirtualModelDefinition = {
			provider: "inner-router",
			id: "composed",
			name: "Inner Composed",
			route(req) {
				seenInnerStates.push(req.state);
				const prevStep = (req.state as { step?: number } | undefined)?.step ?? 0;
				return {
					model: modelA,
					thinkingLevel: "off",
					state: { step: prevStep + 1 },
					ephemeralTail: [{ role: "user", content: "inner-tail", timestamp: 42_000 }],
				};
			},
			async stream(req) {
				const draft = await req.dispatch({ model: modelA, thinkingLevel: "off" }).result();
				req.recordUsage("speculation", draft.provider, draft.model, draft.usage, "draft");
				const prevStep = (req.state as { step?: number } | undefined)?.step ?? 0;
				req.setState({ step: prevStep + 10, winner: "cand-b" });
				return req.dispatch({
					model: modelB,
					thinkingLevel: "off",
					ephemeralTail: "inner-winner-str",
				});
			},
			onToolCallStart(ev) {
				seenToolStarts.push({
					toolName: ev.toolName,
					turnIndex: ev.turnIndex,
					innerState: ev.request.state,
				});
			},
			onOutcome(outcome) {
				seenOutcomes.push({
					virtualId: outcome.virtualModel.id,
					routeModel: `${outcome.route.model.provider}/${outcome.route.model.id}`,
					state: outcome.state,
				});
				return { step: 99, winner: "done" };
			},
		};

		// Also verify deterministic timestamp on Message[] ephemeralTail even if Date.now changes.
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(9_999_999);
		try {
			const state = createSlidingWindowState();
			const swVm = createSlidingWindowVirtualModel(state);
			const routed = withVirtualModelRouting(models, { models: [innerDef, swVm] });
			state.setBoundModels(routed);

			const innerModel = routed.getModel("inner-router", "composed")!;
			const swModel = routed.getModel("sliding-window", "active")!;

			// 1. Direct route() checks deterministic timestamp for Message[] tail
			const msgRoute = await swVm.route(
				makeRequest(swModel, {
					messages: [{ role: "user", content: "hi", timestamp: 77_000 }],
					state: {
						narrowTail: "outer-msg-tail",
						innerDef,
						innerModel,
						innerState: { step: 1 },
					},
				}),
			);
			expect(Array.isArray(msgRoute.ephemeralTail)).toBe(true);
			const tailArr = msgRoute.ephemeralTail as readonly Message[];
			expect(tailArr).toHaveLength(2);
			expect(tailArr[1]).toEqual({
				role: "user",
				content: "outer-msg-tail",
				timestamp: 77_000,
			});

			// 2. Full streamSimple through withVirtualModelRouting tests stream delegation,
			// mergeRoute on inner dispatch(), recordUsage, onToolCallStart, and onOutcome.
			const draftUsage: Usage = {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
			};
			let seenWinnerTail = "";
			candA.setResponses([{ ...fauxAssistantMessage("draft"), usage: draftUsage }]);
			candB.setResponses([
				(ctx) => {
					seenWinnerTail = String(ctx.messages.at(-1)?.content ?? "");
					return fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" });
				},
			]);

			const sidecarRecords: Array<{ kind: string; provider: string; modelId: string; note?: string }> = [];
			const finalMsg = await routed.completeSimple(
				swModel,
				{ messages: [{ role: "user", content: "go", timestamp: 55_000 }] },
				attachVirtualRequestScope(
					{},
					{
						purpose: "prompt",
						turnIndex: 2,
						state: {
							narrowTail: "outer-str-tail",
							innerDef,
							innerModel,
							innerState: { step: 5 },
						},
						onSidecarUsage: (kind, provider, modelId, _usage, note) => {
							sidecarRecords.push({ kind, provider, modelId, note });
						},
					},
				),
			);

			expect(finalMsg.provider).toBe("sw-r-b");
			expect(seenWinnerTail).toBe("inner-winner-str\n\nouter-str-tail");
			expect(seenInnerStates).toEqual([{ step: 1 }, { step: 5 }]);
			expect(sidecarRecords).toEqual([
				{ kind: "speculation", provider: "sw-r-a", modelId: "cand-a", note: "draft" },
			]);
			expect(seenToolStarts).toEqual([{ toolName: "read", turnIndex: 2, innerState: { step: 5 } }]);
			expect(seenOutcomes).toEqual([
				{
					virtualId: "composed",
					routeModel: "sw-r-b/cand-b",
					state: { step: 15, winner: "cand-b" },
				},
			]);

			// 3. Direct onOutcome invocation with manual outcome also delegates cleanly
			const directRoute = await swVm.route(
				makeRequest(swModel, {
					state: { innerDef, innerModel, innerState: { step: 7 } },
				}),
			);
			const directOutcome: ModelRouteOutcome = {
				virtualModel: swModel,
				route: directRoute,
				purpose: "prompt",
				turnIndex: 4,
				message: fauxAssistantMessage("ok"),
				toolResults: [],
				ttfbMs: 10,
				durationMs: 20,
				aborted: false,
			};
			const nextState = await swVm.onOutcome?.(directOutcome);
			expect(nextState).toEqual({ step: 99, winner: "done" });

			// 4. Direct stream() without prior route() falls back cleanly across boundModels virtual target
			const simpleInner: VirtualModelDefinition = {
				provider: "inner-simple",
				id: "direct",
				name: "Simple Inner",
				route() {
					return { model: modelA, thinkingLevel: "off", ephemeralTail: "simple-tail" };
				},
			};
			const routedSimple = withVirtualModelRouting(models, { models: [simpleInner] });
			const innerSimpleModel = routedSimple.getModel("inner-simple", "direct")!;
			const boundState = createSlidingWindowState({
				target: innerSimpleModel,
			});
			boundState.setBoundModels(routedSimple);
			const boundVm = createSlidingWindowVirtualModel(boundState);
			const dispatched: string[] = [];
			await boundVm.stream?.({
				...makeRequest(innerSimpleModel, { state: { narrowTail: "bound-tail" } }),
				dispatch(route) {
					dispatched.push(`${route.model.provider}/${route.model.id}:${String(route.ephemeralTail)}`);
					return models.streamSimple(route.model, { messages: [] });
				},
				recordUsage: () => {},
				setState: () => {},
				setStatus: () => {},
			});
			expect(dispatched).toEqual(["sw-r-a/cand-a:simple-tail\n\nbound-tail"]);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
