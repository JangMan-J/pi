import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryModelsStore,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import {
	computeBranchCacheSnapshot,
	type ModelRouteOutcome,
	type ModelRoutePurpose,
	type ModelRouteRequest,
	VIRTUAL_MODEL_STATE_ENTRY,
} from "../../src/core/virtual-models.ts";
import {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyRequiredToolChoicePayload,
	buildRoutedStreamOptions,
} from "../../src/core/virtual-stream.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	const totalCost = (input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: (input * 3) / 1_000_000,
			output: (output * 15) / 1_000_000,
			cacheRead: (cacheRead * 0.3) / 1_000_000,
			cacheWrite: (cacheWrite * 3.75) / 1_000_000,
			total: totalCost,
		},
	};
}

const readTool: AgentTool = {
	name: "read_item",
	label: "Read Item",
	description: "Read-only lookup",
	parameters: Type.Object({ key: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: `value:${(params as { key: string }).key}` }],
		details: {},
	}),
};

const writeTool: AgentTool = {
	name: "write_item",
	label: "Write Item",
	description: "Mutating write",
	parameters: Type.Object({ key: Type.String(), value: Type.String() }),
	execute: async () => ({
		content: [{ type: "text", text: "written" }],
		details: {},
	}),
};

describe("Virtual model substrate", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	describe("1. Closed-loop onOutcome, live routedModel, and setVirtualModelState", () => {
		it("delivers turn telemetry, tool results, and persists post-turn state updates via onOutcome", async () => {
			const outcomes: ModelRouteOutcome<{ escalations: number }>[] = [];
			const seenRoutedInHook: string[] = [];

			const harness = await createHarness({
				models: [
					{ id: "fast", contextWindow: 16_000, maxTokens: 1000 },
					{ id: "deep", contextWindow: 128_000, maxTokens: 8000, reasoning: true },
				],
				tools: [
					{
						...readTool,
						execute: async () => {
							throw new Error("disk failure");
						},
					},
				],
				extensionFactories: [
					(pi) => {
						pi.on("context_with_system", (_event, ctx) => {
							if (ctx.routedModel) seenRoutedInHook.push(ctx.routedModel.model.id);
							return undefined;
						});
						pi.registerVirtualModel<{ escalations: number }>({
							provider: "router",
							id: "bandit",
							name: "Bandit",
							thinkingLevels: ["low", "high"],
							route(request, ctx) {
								const escalations = request.state?.escalations ?? 0;
								const targetId = escalations > 0 ? "deep" : "fast";
								return {
									model: ctx.modelRegistry.find("faux", targetId)!,
									thinkingLevel: escalations > 0 ? "high" : "off",
								};
							},
							onOutcome(outcome) {
								outcomes.push(outcome);
								if (outcome.toolResults.some((result) => result.isError)) {
									return { escalations: (outcome.state?.escalations ?? 0) + 1 };
								}
								return undefined;
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "bandit")!);

			harness.setResponses([
				{
					...fauxAssistantMessage(fauxToolCall("read_item", { key: "a" }), { stopReason: "toolUse" }),
					usage: makeUsage(200, 30),
				},
				{ ...fauxAssistantMessage("recovered on deep"), usage: makeUsage(260, 40) },
			]);

			await harness.session.prompt("fetch item");

			expect(outcomes).toHaveLength(2);
			expect(outcomes[0].route.model.id).toBe("fast");
			expect(outcomes[0].purpose).toBe("prompt");
			expect(outcomes[0].turnIndex).toBe(0);
			expect(outcomes[0].toolResults).toHaveLength(1);
			expect(outcomes[0].toolResults[0].isError).toBe(true);
			expect(outcomes[0].ttfbMs).toBeGreaterThanOrEqual(0);
			expect(outcomes[0].durationMs).toBeGreaterThanOrEqual(0);
			expect(outcomes[0].aborted).toBe(false);

			// Outcome escalated state after turn 0's tool error, so turn 1 routed to "deep".
			expect(outcomes[1].route.model.id).toBe("deep");
			expect(outcomes[1].purpose).toBe("continuation");
			expect(outcomes[1].turnIndex).toBe(1);
			expect(seenRoutedInHook).toEqual(["fast", "deep"]);
			expect(harness.session.routedModel?.model.id).toBe("deep");

			// Explicit state update via setVirtualModelState persists on branch.
			harness.session.setVirtualModelState("router", "bandit", { escalations: 5 });
			const storedStates = harness.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === VIRTUAL_MODEL_STATE_ENTRY ? [entry.data] : [],
				);
			expect(storedStates.at(-1)).toEqual({
				provider: "router",
				modelId: "bandit",
				state: { escalations: 5 },
			});
		});

		it("fires onOutcome with aborted=true when the user aborts mid-stream", async () => {
			const outcomes: ModelRouteOutcome[] = [];
			const harness = await createHarness({
				models: [{ id: "slow", contextWindow: 32_000 }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "abortable",
							name: "Abortable",
							route(_req, ctx) {
								return { model: ctx.modelRegistry.find("faux", "slow")!, thinkingLevel: "off" };
							},
							onOutcome(outcome) {
								outcomes.push(outcome);
							},
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.agent.streamFunction = (_model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				const onAbort = () => {
					const abortedMsg: AssistantMessage = {
						...fauxAssistantMessage(""),
						provider: "faux",
						model: "slow",
						stopReason: "aborted",
						errorMessage: "Operation aborted",
					};
					stream.push({ type: "error", reason: "aborted", error: abortedMsg });
					stream.end(abortedMsg);
				};
				options?.signal?.addEventListener("abort", onAbort, { once: true });
				setTimeout(() => void harness.session.abort(), 10);
				return stream;
			};
			await harness.session.setModel(harness.session.modelRuntime.getModel("router", "abortable")!);

			await harness.session.prompt("hang");

			expect(outcomes).toHaveLength(1);
			expect(outcomes[0].aborted).toBe(true);
			expect(outcomes[0].message.stopReason).toBe("aborted");
		});
	});

	describe("2. Live KV-cache snapshot (request.cache) and CacheWarmer parity", () => {
		it("tracks warm prefix tokens, TTL expiry, context_edit truncation, cache_warm refreshes, and compaction resets", async () => {
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const faux = fauxProvider({
				models: [
					{
						id: "sonnet",
						contextWindow: 200_000,
						cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
					},
					{
						id: "haiku",
						contextWindow: 200_000,
						cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
					},
				],
			});
			runtime.registerNativeProvider({
				...faux.provider,
				getModels: () =>
					faux.provider.getModels().map((model) => ({
						...model,
						promptCache: { short: 300, long: 3600 },
					})),
			});
			await runtime.refresh({ allowNetwork: false });
			const sonnet = runtime.getModel("faux", "sonnet")!;
			const getPhysical = (provider: string, id: string) => runtime.getPhysicalModel(provider, id);

			const sm = SessionManager.inMemory();
			expect(computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 1_000 })).toMatchObject({
				cacheFreeBoundary: true,
				boundaryReason: "initial",
				entries: [],
			});

			sm.appendMessage({ role: "user", content: "turn 1", timestamp: 1_000 });
			const firstAssistantId = sm.appendMessage({
				...fauxAssistantMessage("reply 1", { timestamp: 2_000 }),
				usage: makeUsage(1000, 100, 0, 1000),
				api: sonnet.api,
				provider: "faux",
				model: "sonnet",
			});

			const warm = computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 100_000 });
			expect(warm.cacheFreeBoundary).toBe(false);
			expect(warm.get("faux", "sonnet")).toEqual({
				provider: "faux",
				modelId: "sonnet",
				warmTokens: 2000,
				lastRefreshedAtMs: 2_000,
				expiresAtMs: 302_000,
			});

			// Past 5-minute TTL -> cacheFreeBoundary becomes true ("expired").
			const expired = computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 305_000 });
			expect(expired.cacheFreeBoundary).toBe(true);
			expect(expired.boundaryReason).toBe("expired");

			// A cache_warm usage entry extends the TTL window.
			vi.useFakeTimers();
			vi.setSystemTime(290_000);
			sm.appendUsage("cache_warm", "faux", "sonnet", makeUsage(0, 1, 2000, 0));
			vi.useRealTimers();

			const refreshed = computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 400_000 });
			expect(refreshed.cacheFreeBoundary).toBe(false);
			expect(refreshed.get("faux", "sonnet")?.expiresAtMs).toBe(590_000);

			// Second turn grows prompt tokens, then context_edit on turn 2 clamps warmTokens back to turn 1's prefix.
			sm.appendMessage({ role: "user", content: "turn 2", timestamp: 410_000 });
			const secondAssistantId = sm.appendMessage({
				...fauxAssistantMessage("reply 2", { timestamp: 415_000 }),
				usage: makeUsage(500, 80, 2000, 500),
				api: sonnet.api,
				provider: "faux",
				model: "sonnet",
			});
			expect(
				computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 420_000 }).get("faux", "sonnet")
					?.warmTokens,
			).toBe(3000);

			sm.appendContextEdit(secondAssistantId, null);
			expect(
				computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 420_000 }).get("faux", "sonnet")
					?.warmTokens,
			).toBe(2000);

			// Compaction resets to a cache-free boundary.
			sm.appendCompaction("summary", firstAssistantId, 3000);
			const postCompact = computeBranchCacheSnapshot(sm.getBranch(), getPhysical, { nowMs: 420_000 });
			expect(postCompact.cacheFreeBoundary).toBe(true);
			expect(postCompact.boundaryReason).toBe("compaction");
		});

		it("arms CacheWarmer under a virtual selection and cancels when keepCacheWarm is false", async () => {
			let allowWarm = true;
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			const faux = fauxProvider({
				models: [
					{
						id: "cached-pro",
						contextWindow: 200_000,
						cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
					},
				],
			});
			runtime.registerNativeProvider({
				...faux.provider,
				getModels: () =>
					faux.provider.getModels().map((model) => ({
						...model,
						promptCache: { short: 300, long: 3600 },
					})),
			});
			runtime.registerVirtualModel({
				provider: "router",
				id: "warm-auto",
				name: "Warm Auto",
				route() {
					return {
						model: runtime.getModel("faux", "cached-pro")!,
						thinkingLevel: "off",
						keepCacheWarm: allowWarm,
					};
				},
			});
			await runtime.refresh({ allowNetwork: false });

			faux.setResponses([fauxAssistantMessage("cached reply"), fauxAssistantMessage("unwarmed reply")]);

			const settingsManager = SettingsManager.inMemory({ cacheWarming: "idle" });
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				modelRuntime: runtime,
				model: runtime.getModel("router", "warm-auto")!,
				noTools: "all",
				sessionManager: SessionManager.inMemory(),
				settingsManager,
				resourceLoader: createTestResourceLoader(),
			});

			try {
				await session.prompt("x".repeat(40_000));
				expect(session.cacheWarmingStatus?.state).toBe("scheduled");

				allowWarm = false;
				session.setCacheWarmingMode("off");
				session.setCacheWarmingMode("idle");
				await session.prompt("second");
				expect(session.cacheWarmingStatus?.state).toBe("inactive");
			} finally {
				session.dispose();
			}
		});
	});

	describe("3. Ephemeral ModelRoute envelope (context, tools, bounds, TTFB timeout, status)", () => {
		it("projects ephemeral messages, systemPromptPrefix/systemAppend, ephemeralTail, allowedTools, and request bounds per turn without persisting them", async () => {
			const seenCalls: Array<{
				system: string;
				tools: string[];
				userTexts: string[];
				maxTokens?: number;
				temperature?: number;
				toolChoice?: string;
			}> = [];
			const workingLabels: Array<string | undefined> = [];
			let turn = 0;

			const harness = await createHarness({
				models: [{ id: "worker", contextWindow: 64_000, maxTokens: 4096 }],
				tools: [readTool, writeTool],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "envelope",
							name: "Envelope",
							async route(req, ctx) {
								req.setStatus?.("Routing...");
								const currentTurn = turn++;
								if (currentTurn === 0) {
									return {
										model: ctx.modelRegistry.find("faux", "worker")!,
										thinkingLevel: "off",
										systemPromptPrefix: "[PREFIX] ",
										systemAppend: "[APPEND]",
										ephemeralTail: "ONE_SHOT_HINT",
										allowedTools: ["read_item"],
										blockedToolReason: "Read-only phase: write_item is forbidden.",
										maxTokens: 256,
										temperature: 0.1,
										toolChoice: "none",
										statusLabel: "Phase 1",
									};
								}
								return {
									model: ctx.modelRegistry.find("faux", "worker")!,
									thinkingLevel: "off",
								};
							},
						});
					},
				],
			});
			harnesses.push(harness);

			vi.spyOn(harness.session.extensionRunner.getUIContext(), "setWorkingMessage").mockImplementation((msg) => {
				workingLabels.push(msg);
			});

			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context: TranscriptContext, options) => {
				seenCalls.push({
					system: getCurrentSystemPrompt(context.messages),
					tools: getCurrentTools(context.messages).map((t) => t.name),
					userTexts: context.messages.flatMap((m) =>
						m.role === "user" && typeof m.content === "string" ? [m.content] : [],
					),
					maxTokens: options?.maxTokens,
					temperature: options?.temperature,
					toolChoice: options?.toolChoice,
				});
				return runtime.streamSimple(model, context, options);
			};
			await harness.session.setModel(runtime.getModel("router", "envelope")!);

			// Turn 0 tries calling blocked `write_item`, which `_beforeToolCall` blocks without mutating active tools;
			// Turn 1 then runs with clean canonical context and full tool declarations restored!
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("write_item", { key: "k", value: "v" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("run task");

			expect(seenCalls).toHaveLength(2);
			expect(seenCalls[0].system.startsWith("[PREFIX] ")).toBe(true);
			expect(seenCalls[0].system).toContain("[APPEND]");
			expect(seenCalls[0].tools).toEqual(["read_item"]);
			expect(seenCalls[0].userTexts).toContain("ONE_SHOT_HINT");
			expect(seenCalls[0].maxTokens).toBe(256);
			expect(seenCalls[0].temperature).toBe(0.1);
			expect(seenCalls[0].toolChoice).toBe("none");

			// Turn 1 sees zero leakage from Turn 0's ephemeral envelope!
			expect(seenCalls[1].system.startsWith("[PREFIX] ")).toBe(false);
			expect(seenCalls[1].system).not.toContain("[APPEND]");
			expect(seenCalls[1].tools).toEqual(["read_item", "write_item"]);
			expect(seenCalls[1].userTexts).not.toContain("ONE_SHOT_HINT");
			expect(seenCalls[1].maxTokens).toBeUndefined();
			expect(seenCalls[1].temperature).toBeUndefined();
			expect(seenCalls[1].toolChoice).toBeUndefined();

			// Canonical session branch has zero ephemeral tail or system rewrites, and write_item was blocked cleanly.
			const branchJson = JSON.stringify(harness.sessionManager.getBranch());
			expect(branchJson).not.toContain("ONE_SHOT_HINT");
			expect(branchJson).toContain("Read-only phase: write_item is forbidden.");
			expect(harness.session.getActiveToolNames()).toEqual(["read_item", "write_item"]);
			expect(workingLabels).toContain("Routing...");
			expect(workingLabels).toContain("Phase 1");
			expect(workingLabels.at(-1)).toBeUndefined();
		});

		it("maps toolChoice='required' cleanly across OpenAI, Anthropic, and Google wire payloads", () => {
			expect(applyRequiredToolChoicePayload({ model: "gpt-5" }, "openai-responses")).toEqual({
				model: "gpt-5",
				tool_choice: "required",
			});
			expect(
				applyRequiredToolChoicePayload(
					{ model: "claude", thinking: { type: "enabled", budget_tokens: 2048 } },
					"anthropic-messages",
				),
			).toEqual({
				model: "claude",
				tool_choice: { type: "any" },
			});
			expect(applyRequiredToolChoicePayload({ contents: [] }, "google-generative-ai")).toEqual({
				contents: [],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			});
		});

		it("aborts a stalled provider on ttfbTimeoutMs and fails over via retry", async () => {
			const requests: ModelRouteRequest[] = [];
			const harness = await createHarness({
				settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
				models: [{ id: "stalled" }, { id: "healthy" }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "ttfb-guard",
							name: "TTFB Guard",
							route(req, ctx) {
								requests.push(req);
								if (req.purpose === "retry" && req.failed?.model.id === "stalled") {
									return { model: ctx.modelRegistry.find("faux", "healthy")!, thinkingLevel: "off" };
								}
								return {
									model: ctx.modelRegistry.find("faux", "stalled")!,
									thinkingLevel: "off",
									ttfbTimeoutMs: 25,
								};
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) => {
				if (model.id === "stalled") {
					const stream = createAssistantMessageEventStream();
					options?.signal?.addEventListener(
						"abort",
						() => {
							const err = fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" });
							stream.push({ type: "error", reason: "aborted", error: err });
							stream.end(err);
						},
						{ once: true },
					);
					return stream;
				}
				return runtime.streamSimple(model, context, options);
			};
			harness.setResponses([fauxAssistantMessage("healthy answer")]);
			await harness.session.setModel(runtime.getModel("router", "ttfb-guard")!);

			await harness.session.prompt("ping");

			expect(requests.map((r) => r.purpose)).toEqual(["prompt", "retry"]);
			expect(requests[1].failed?.model.id).toBe("stalled");
			expect(requests[1].failed?.message.errorMessage).toContain("timed out waiting for first token");
			expect(harness.session.getLastAssistantText()).toBe("healthy answer");
		});
	});

	describe("4. Stream-level tier: TTFB hedging, pre-commit validation, and custom stream()", () => {
		it("races a hedge model when primary exceeds afterMs, commits winner, and logs cancelled sidecar usage", async () => {
			const outcomes: ModelRouteOutcome[] = [];
			const harness = await createHarness({
				models: [{ id: "primary-slow" }, { id: "backup-fast" }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "hedged",
							name: "Hedged",
							route(_req, ctx) {
								return {
									model: ctx.modelRegistry.find("faux", "primary-slow")!,
									thinkingLevel: "off",
									hedge: {
										afterMs: 20,
										model: ctx.modelRegistry.find("faux", "backup-fast")!,
									},
								};
							},
							onOutcome(outcome) {
								outcomes.push(outcome);
							},
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.agent.streamFunction = (model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				if (model.id === "primary-slow") {
					options?.signal?.addEventListener(
						"abort",
						() => {
							const abortedMsg: AssistantMessage = {
								...fauxAssistantMessage(""),
								usage: makeUsage(120, 0),
								provider: "faux",
								model: "primary-slow",
								stopReason: "aborted",
							};
							stream.push({ type: "error", reason: "aborted", error: abortedMsg });
							stream.end(abortedMsg);
						},
						{ once: true },
					);
					return stream;
				}
				setTimeout(() => {
					const winMsg: AssistantMessage = {
						...fauxAssistantMessage("hedged winner"),
						usage: makeUsage(120, 25),
						provider: "faux",
						model: "backup-fast",
					};
					stream.push({ type: "start", partial: { ...winMsg, content: [] } });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "hedged winner", partial: winMsg });
					stream.push({ type: "done", reason: "stop", message: winMsg });
					stream.end(winMsg);
				}, 5);
				return stream;
			};
			await harness.session.setModel(harness.session.modelRuntime.getModel("router", "hedged")!);

			await harness.session.prompt("race");

			expect(harness.session.getLastAssistantText()).toBe("hedged winner");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0].route.model.id).toBe("backup-fast");
			expect(harness.session.routedModel?.model.id).toBe("backup-fast");

			// Wait briefly for async loser cleanup to append sidecar usage.
			await new Promise((resolve) => setTimeout(resolve, 15));
			const usageEntries = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "usage" && entry.kind === "hedge");
			expect(usageEntries).toHaveLength(1);
			expect(usageEntries[0]).toMatchObject({
				type: "usage",
				kind: "hedge",
				provider: "faux",
				model: "primary-slow",
			});
		});

		it("buffers pre-commit drafts in validate() and escalates cleanly without leaking the rejected draft", async () => {
			const harness = await createHarness({
				models: [{ id: "draft-fast" }, { id: "judge-strong" }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel<{ escalated: boolean }>({
							provider: "router",
							id: "validated",
							name: "Validated",
							route(_req, ctx) {
								return {
									model: ctx.modelRegistry.find("faux", "draft-fast")!,
									thinkingLevel: "off",
									validate(candidate) {
										const text = candidate.content
											.flatMap((b) => (b.type === "text" ? [b.text] : []))
											.join("");
										if (text.includes("UNSURE")) {
											return {
												action: "escalate",
												model: ctx.modelRegistry.find("faux", "judge-strong")!,
												ephemeralTail: "Provide a definitive answer.",
												state: { escalated: true },
											};
										}
										return { action: "accept" };
									},
								};
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "validated")!);

			harness.setResponses([
				fauxAssistantMessage("I am UNSURE"),
				fauxAssistantMessage("Definitive verified answer"),
			]);

			await harness.session.prompt("explain invariant");

			// Rejected draft never appeared on public events or canonical session messages!
			expect(JSON.stringify(harness.events)).not.toContain("UNSURE");
			expect(JSON.stringify(harness.session.messages)).not.toContain("UNSURE");
			expect(harness.session.getLastAssistantText()).toBe("Definitive verified answer");

			// Draft tokens are recorded honestly as a "draft" UsageEntry.
			const draftUsage = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "usage" && entry.kind === "draft");
			expect(draftUsage).toHaveLength(1);
		});

		it("supports custom VirtualModelDefinition.stream() orchestration with dispatch and recordUsage", async () => {
			const harness = await createHarness({
				models: [{ id: "candidate-a" }, { id: "candidate-b" }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel<{ winner: string }>({
							provider: "router",
							id: "custom-stream",
							name: "Custom Stream",
							route(_req, ctx) {
								return { model: ctx.modelRegistry.find("faux", "candidate-a")!, thinkingLevel: "off" };
							},
							async stream(req, ctx) {
								const first = await req
									.dispatch({
										model: ctx.modelRegistry.find("faux", "candidate-a")!,
										thinkingLevel: "off",
									})
									.result();
								req.recordUsage("speculation", first.provider, first.model, first.usage, "discarded a");
								req.setState({ winner: "candidate-b" });
								return req.dispatch({
									model: ctx.modelRegistry.find("faux", "candidate-b")!,
									thinkingLevel: "off",
								});
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "custom-stream")!);

			harness.setResponses([fauxAssistantMessage("draft a"), fauxAssistantMessage("winner b")]);

			await harness.session.prompt("solve");

			expect(harness.session.getLastAssistantText()).toBe("winner b");
			const specUsage = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "usage" && entry.kind === "speculation");
			expect(specUsage).toHaveLength(1);
		});
	});

	describe("5. First-class purpose across harness and boundary continuation fix", () => {
		it("keeps purpose='continuation' and reason='continuation' when turn_end drops lastResponse via context_edit: null", async () => {
			const recorded: Array<{ reason: string; purpose: ModelRoutePurpose; boundary?: boolean; turnIndex: number }> =
				[];
			let dropped = false;

			const harness = await createHarness({
				models: [{ id: "scout" }, { id: "main" }],
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (event) => {
							if (dropped) return undefined;
							dropped = true;
							return {
								entries: [{ type: "context_edit", targetId: event.messageEntryId, replacement: null }],
								continue: true,
							};
						});
						pi.registerVirtualModel({
							provider: "router",
							id: "relay",
							name: "Relay",
							route(req, ctx) {
								recorded.push({
									reason: req.reason,
									purpose: req.purpose,
									boundary: req.boundaryContinuation,
									turnIndex: req.turnIndex,
								});
								const target = req.purpose === "prompt" ? "scout" : "main";
								return {
									model: ctx.modelRegistry.find("faux", target)!,
									thinkingLevel: "off",
									suppressStream: target === "scout",
								};
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "relay")!);

			harness.setResponses([fauxAssistantMessage("dropped recon"), fauxAssistantMessage("main answer")]);
			await harness.session.prompt("investigate");

			expect(recorded).toEqual([
				{ reason: "user", purpose: "prompt", boundary: undefined, turnIndex: 0 },
				{ reason: "continuation", purpose: "continuation", boundary: true, turnIndex: 1 },
			]);
			expect(harness.session.getLastAssistantText()).toBe("main answer");
		});

		it("passes distinct compaction, branch_summary, subagent, and direct purposes with read-only branch state", async () => {
			const seen: Array<{ purpose: ModelRoutePurpose; isSubagent?: boolean; state: unknown }> = [];
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				models: [{ id: "main" }, { id: "summarizer" }],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel<{ tag: string }>({
							provider: "router",
							id: "policy",
							name: "Unified Policy",
							route(req, ctx) {
								seen.push({ purpose: req.purpose, isSubagent: req.isSubagent, state: req.state });
								const target =
									req.purpose === "compaction" || req.purpose === "branch_summary" ? "summarizer" : "main";
								return {
									model: ctx.modelRegistry.find("faux", target)!,
									thinkingLevel: "off",
									state: req.state ?? { tag: "active-policy" },
								};
							},
						});
					},
				],
			});
			harnesses.push(harness);
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "policy")!);

			harness.setResponses([
				fauxAssistantMessage("reply 1"),
				fauxAssistantMessage("reply 2"),
				fauxAssistantMessage("branch summary text"),
				fauxAssistantMessage("compaction summary text"),
				fauxAssistantMessage("compaction summary text"),
				fauxAssistantMessage("subagent reply"),
			]);

			await harness.session.prompt("first");
			const firstLeafId = harness.sessionManager.getLeafId()!;
			await harness.session.prompt("second");

			// Navigate back to firstLeafId with summarize: true -> triggers purpose: "branch_summary" with branch state!
			await harness.session.navigateTree(firstLeafId, { summarize: true });

			// Compact -> triggers purpose: "compaction" with branch state!
			await harness.session.compact();

			// Subagent session inheriting the same runtime + virtual model -> triggers purpose: "subagent", isSubagent: true!
			const { session: subSession } = await createAgentSession({
				cwd: process.cwd(),
				modelRuntime: runtime,
				model: runtime.getModel("router", "policy")!,
				noTools: "all",
				sessionRole: "subagent",
				sessionManager: SessionManager.inMemory(),
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
			});
			try {
				await subSession.prompt("subagent brief");
			} finally {
				subSession.dispose();
			}

			expect(seen.map((item) => item.purpose)).toEqual([
				"prompt",
				"prompt",
				"branch_summary",
				"compaction",
				"subagent",
			]);
			expect(seen[2].state).toEqual({ tag: "active-policy" });
			expect(seen[3].state).toEqual({ tag: "active-policy" });
			expect(seen[4].isSubagent).toBe(true);
		});
	});

	describe("7. Extension appendUsage, cache snapshot, and cache-guarded route controls", () => {
		it("exposes pi.appendUsage and ctx.getRouteCacheSnapshot to extension hooks", async () => {
			let hookWarmTokens: number | undefined;
			const harness = await createHarness({
				models: [{ id: "primary", contextWindow: 120_000, maxTokens: 4_000 }],
				extensionFactories: [
					(pi) => {
						pi.on("message_end", (event) => {
							if (event.message.role !== "assistant") return;
							return {
								message: {
									...event.message,
									usage: makeUsage(1_200, 80, 0, 5_000),
								},
							};
						});
						pi.on("turn_end", (_event, ctx) => {
							hookWarmTokens = ctx.getRouteCacheSnapshot?.().get("faux", "primary")?.warmTokens;
							pi.appendUsage("baton", "faux", "primary", makeUsage(800, 120, 4_000, 0), "background baton");
						});
					},
				],
			});
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("answered")]);
			await harness.session.prompt("run task");

			expect(hookWarmTokens).toBe(6_200);
			const usageEntries = harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "usage" && entry.kind === "baton");
			expect(usageEntries).toHaveLength(1);
			expect(usageEntries[0]).toMatchObject({
				type: "usage",
				kind: "baton",
				provider: "faux",
				model: "primary",
				note: "background baton",
			});
			const stats = harness.session.getSessionStats();
			expect(stats.tokens.input).toBe(2_000);
			expect(stats.tokens.output).toBe(200);
			expect(stats.tokens.cacheRead).toBe(4_000);
			expect(stats.tokens.cacheWrite).toBe(5_000);
		});

		it("forwards sessionId and disableContinuation, and isolates hedged contenders with stable timestamps", async () => {
			const dispatchedCalls: Array<{
				modelId: string;
				sessionId?: string;
				disableContinuation?: boolean;
				tailTimestamp?: number;
			}> = [];
			const harness = await createHarness({
				models: [
					{ id: "slow", contextWindow: 100_000, maxTokens: 4_000 },
					{ id: "backup", contextWindow: 100_000, maxTokens: 4_000 },
				],
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "hedged",
							name: "Hedged",
							thinkingLevels: ["off"],
							route: (_req, ctx) => ({
								model: ctx.modelRegistry.find("faux", "slow")!,
								thinkingLevel: "off",
								sessionId: "custom-cache-shard",
								ephemeralTail: "working-set slice",
								hedge: {
									afterMs: 15,
									model: ctx.modelRegistry.find("faux", "backup")!,
								},
							}),
						});
					},
				],
			});
			harnesses.push(harness);

			const runtime = harness.session.modelRuntime;
			const origStreamSimple = runtime.streamSimple.bind(runtime);
			vi.spyOn(runtime, "streamSimple").mockImplementation((model, context, options) => {
				if (model.provider === "faux") {
					const lastMsg = context.messages[context.messages.length - 1];
					dispatchedCalls.push({
						modelId: model.id,
						sessionId: options?.sessionId,
						disableContinuation: options?.disableContinuation,
						tailTimestamp: lastMsg?.timestamp,
					});
					if (model.id === "slow") {
						const stalled = createAssistantMessageEventStream();
						options?.signal?.addEventListener(
							"abort",
							() => {
								const aborted = fauxAssistantMessage("", { stopReason: "aborted" });
								aborted.provider = "faux";
								aborted.model = "slow";
								stalled.push({ type: "error", reason: "aborted", error: aborted });
								stalled.end(aborted);
							},
							{ once: true },
						);
						return stalled;
					}
				}
				return origStreamSimple(model, context, options);
			});

			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "hedged")!);
			harness.setResponses([fauxAssistantMessage("fast backup win")]);

			await harness.session.prompt("check");

			expect(dispatchedCalls).toHaveLength(2);
			expect(dispatchedCalls[0]).toMatchObject({
				modelId: "slow",
				sessionId: "custom-cache-shard",
				disableContinuation: undefined,
			});
			expect(dispatchedCalls[1]).toMatchObject({
				modelId: "backup",
				sessionId: "custom-cache-shard",
				disableContinuation: true,
			});
			expect(dispatchedCalls[0].tailTimestamp).toBe(dispatchedCalls[1].tailTimestamp);
		});

		it("anchors Anthropic cache_control before ephemeralTail instead of caching the throwaway tail", async () => {
			const cacheControl = { type: "ephemeral" };
			const rawAnthropicPayload = {
				model: "claude-sonnet-4-5",
				messages: [
					{ role: "user", content: "edit foo.ts" },
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "foo.ts" } }],
					},
					{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ref:abc123" }] },
					{
						role: "user",
						content: [
							{ type: "text", text: "<working_set>full 15KB</working_set>", cache_control: cacheControl },
						],
					},
					{ role: "system", content: [], output_config: { effort: "high" } },
				],
			};

			const shaped = anchorAnthropicCacheBeforeEphemeralTail(
				rawAnthropicPayload,
				"<working_set>full 15KB</working_set>",
			) as typeof rawAnthropicPayload;

			expect(shaped.messages[2].content).toEqual([
				{ type: "tool_result", tool_use_id: "t1", content: "ref:abc123", cache_control: cacheControl },
			]);
			expect(shaped.messages[3].content).toEqual([{ type: "text", text: "<working_set>full 15KB</working_set>" }]);
			// Original payload was not mutated in place.
			expect((rawAnthropicPayload.messages[3].content as Array<Record<string, unknown>>)[0].cache_control).toEqual(
				cacheControl,
			);

			// Also verify buildRoutedStreamOptions wires onPayload for Anthropic models when ephemeralTail is set.
			const anthropicModel = {
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet",
				api: "anthropic-messages" as const,
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text" as const],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			};
			const opts = buildRoutedStreamOptions(undefined, {
				model: anthropicModel,
				thinkingLevel: "high",
				ephemeralTail: "<working_set>full 15KB</working_set>",
				disableContinuation: true,
			});
			expect(opts.disableContinuation).toBe(true);
			const viaHook = (await opts.onPayload?.(rawAnthropicPayload, anthropicModel)) as typeof rawAnthropicPayload;
			expect((viaHook.messages[2].content as Array<Record<string, unknown>>)[0].cache_control).toEqual(cacheControl);
			expect((viaHook.messages[3].content as Array<Record<string, unknown>>)[0].cache_control).toBeUndefined();
		});
	});
});
