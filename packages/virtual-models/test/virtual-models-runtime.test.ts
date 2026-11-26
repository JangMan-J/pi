import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { PI_ATTRIBUTION, withClientIdentity } from "@earendil-works/pi-ai/utils/identity";
import { describe, expect, it } from "vitest";
import { createVirtualModel, isVirtualModel } from "../src/core/predicates.ts";
import {
	attachVirtualRequestScope,
	getVirtualRequestScope,
	isVirtualModelsRuntime,
	unroutedVirtualStream,
	withVirtualModelRouting,
	withVirtualModels,
} from "../src/core/runtime.ts";
import type { ModelRouteOutcome, ToolCallStartEvent } from "../src/core/types.ts";

const RUNTIME_SOURCE = fileURLToPath(new URL("../src/core/runtime.ts", import.meta.url));

function makeUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: {
			input: input * 1e-6,
			output: output * 2e-6,
			cacheRead: 0,
			cacheWrite: 0,
			total: (input + output * 2) * 1e-6,
		},
	};
}

function setupModels() {
	const fast = fauxProvider({
		provider: "fast-prov",
		models: [{ id: "fast-1", contextWindow: 16_000, maxTokens: 1000 }],
	});
	const deep = fauxProvider({
		provider: "deep-prov",
		models: [{ id: "deep-1", contextWindow: 128_000, maxTokens: 8000, reasoning: true }],
	});
	const models = createModels();
	models.setProvider(fast.provider);
	models.setProvider(deep.provider);
	return { fast, deep, models };
}

describe("@earendil-works/pi-virtual-models runtime", () => {
	it("exposes virtual models in catalog lookups and delegates physical routing", async () => {
		const { fast, deep, models } = setupModels();
		fast.setResponses([fauxAssistantMessage("fast reply")]);
		deep.setResponses([fauxAssistantMessage("deep reply")]);

		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "auto",
					name: "Auto",
					thinkingLevels: ["low", "high"],
					route(req) {
						const target =
							req.thinkingLevel === "high"
								? models.getModel("deep-prov", "deep-1")!
								: models.getModel("fast-prov", "fast-1")!;
						return { model: target, thinkingLevel: req.thinkingLevel };
					},
				},
			],
		});

		const virtual = routed.getModel("router", "auto");
		expect(virtual).toBeDefined();
		expect(isVirtualModel(virtual!)).toBe(true);
		expect(routed.getProvider("router")).toBeDefined();

		const resLow = await routed.completeSimple(
			virtual!,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ reasoning: "low" },
		);
		expect(resLow.provider).toBe("fast-prov");
		expect(resLow.model).toBe("fast-1");

		const resHigh = await routed.completeSimple(
			virtual!,
			{ messages: [{ role: "user", content: "hard", timestamp: 2 }] },
			{ reasoning: "high" },
		);
		expect(resHigh.provider).toBe("deep-prov");
		expect(resHigh.model).toBe("deep-1");
	});

	it("forwards sessionId, disableContinuation, validates drafts with sidecar usage, and defers onOutcome when requested", async () => {
		const { fast, deep, models } = setupModels();
		const capturedOptions: Array<{ sessionId?: string; disableContinuation?: boolean; reasoning?: string }> = [];

		fast.setResponses([
			(_ctx, opts) => {
				capturedOptions.push({
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
				});
				return {
					...fauxAssistantMessage("weak draft"),
					usage: makeUsage(100, 20),
				};
			},
		]);
		deep.setResponses([
			{
				...fauxAssistantMessage("strong final"),
				usage: makeUsage(120, 40),
			},
		]);

		const outcomes: ModelRouteOutcome[] = [];
		const sidecars: Array<{ kind: string; provider: string; modelId: string }> = [];
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "validated",
					name: "Validated",
					thinkingLevels: ["off", "low", "high"],
					route() {
						return {
							model: models.getModel("fast-prov", "fast-1")!,
							thinkingLevel: "off",
							sessionId: "ring1-session",
							disableContinuation: true,
							validate() {
								return {
									action: "escalate",
									model: models.getModel("deep-prov", "deep-1")!,
									thinkingLevel: "high",
									sessionId: "ring1-session",
									disableContinuation: true,
								};
							},
						};
					},
					onOutcome(outcome) {
						outcomes.push(outcome);
					},
				},
			],
		});

		const vm = createVirtualModel({ provider: "router", id: "validated", name: "Validated" });
		const deferredOpts = attachVirtualRequestScope(
			{},
			{
				purpose: "prompt",
				deferOutcomeToHost: true,
				onSidecarUsage: (kind, provider, modelId) => sidecars.push({ kind, provider, modelId }),
			},
		);
		const msg: Message = { role: "user", content: "solve", timestamp: 1 };
		const result = await routed.completeSimple(vm, { messages: [msg] }, deferredOpts);

		expect(result.provider).toBe("deep-prov");
		expect(result.model).toBe("deep-1");
		expect(capturedOptions[0]).toEqual({
			sessionId: "ring1-session",
			disableContinuation: true,
			reasoning: undefined,
		});
		expect(sidecars).toEqual([{ kind: "draft", provider: "fast-prov", modelId: "fast-1" }]);
		// Deferred to host when deferOutcomeToHost is true.
		expect(outcomes).toHaveLength(0);
	});

	it("attaches ephemeralTail only to outgoing requests without mutating caller transcript and drops it next turn", async () => {
		const { fast, models } = setupModels();
		const seenContexts: TranscriptContext[] = [];
		fast.setResponses([
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("turn 1");
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("turn 2");
			},
		]);

		let turn = 0;
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "ephemeral",
					name: "Ephemeral",
					thinkingLevels: ["off"],
					route() {
						turn++;
						return {
							model: models.getModel("fast-prov", "fast-1")!,
							thinkingLevel: "off",
							...(turn === 1 ? { ephemeralTail: "SLICE:src/foo.ts" } : {}),
						};
					},
				},
			],
		});

		const vm = createVirtualModel({ provider: "router", id: "ephemeral", name: "Ephemeral" });
		const transcript: Message[] = [{ role: "user", content: "inspect foo", timestamp: 1 }];
		await routed.completeSimple(vm, { messages: transcript });
		expect(transcript).toHaveLength(1);
		expect(seenContexts[0]?.messages).toHaveLength(2);
		expect(seenContexts[0]?.messages[1]).toMatchObject({ role: "user", content: "SLICE:src/foo.ts" });

		await routed.completeSimple(vm, { messages: [...transcript, { role: "user", content: "next", timestamp: 2 }] });
		expect(seenContexts[1]?.messages).toHaveLength(2);
		expect(seenContexts[1]?.messages.map((m) => m.role === "user" && m.content)).toEqual(["inspect foo", "next"]);
	});

	it("preserves VirtualModels methods and request scope across withClientIdentity()", async () => {
		const { fast, models } = setupModels();
		fast.setResponses([fauxAssistantMessage("ok")]);
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "wrapped",
					name: "Wrapped",
					route: () => ({ model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "off" }),
				},
			],
		});
		const withId = withClientIdentity(routed, { attribution: PI_ATTRIBUTION });
		expect(isVirtualModelsRuntime(withId)).toBe(true);
		expect(withId.getPhysicalModel("fast-prov", "fast-1")?.id).toBe("fast-1");

		let completed = false;
		const vm = withId.getModel("router", "wrapped")!;
		const opts = attachVirtualRequestScope(
			{},
			{
				purpose: "prompt",
				onComplete: () => {
					completed = true;
				},
			},
		);
		const reply = await withId.completeSimple(
			vm,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			opts,
		);
		expect(reply.model).toBe("fast-1");
		expect(completed).toBe(true);
	});

	it("exposes getDefinition on VirtualModels and fires deduplicated error-safe onToolCallStart hooks", async () => {
		const { fast, deep, models } = setupModels();
		const callEvents: ToolCallStartEvent[] = [];

		let mode: "multi" | "hedge" | "throwSync" | "rejectAsync" = "multi";
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "prewarm",
					name: "Prewarm",
					route: () =>
						mode === "hedge"
							? {
									model: models.getModel("fast-prov", "fast-1")!,
									thinkingLevel: "off",
									hedge: { afterMs: 5, model: models.getModel("deep-prov", "deep-1")!, thinkingLevel: "low" },
								}
							: { model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "off" },
					onToolCallStart(event) {
						callEvents.push(event);
						if (mode === "throwSync") throw new Error("sync prewarm boom");
						if (mode === "rejectAsync")
							return Promise.reject(new Error("async prewarm boom")) as unknown as undefined;
					},
				},
			],
		});

		expect(routed.getDefinition("router", "prewarm")).toBe(routed.getVirtualModelDefinition("router", "prewarm"));
		expect(routed.getDefinition("fast-prov", "fast-1")).toBeUndefined();
		const wrapped = withClientIdentity(routed, { attribution: PI_ATTRIBUTION });
		expect(wrapped.getDefinition("router", "prewarm")).toBe(routed.getDefinition("router", "prewarm"));

		const vm = routed.getModel("router", "prewarm")!;
		fast.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }), fauxToolCall("grep", { query: "b" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("write", { path: "c.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("edit", { path: "d.ts" })], { stopReason: "toolUse" }),
			async () => {
				await new Promise((r) => setTimeout(r, 40));
				return fauxAssistantMessage([fauxToolCall("loser_tool", { x: 1 })], { stopReason: "toolUse" });
			},
		]);
		deep.setResponses([
			fauxAssistantMessage([fauxToolCall("winner_tool", { y: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("custom_tool", { z: 3 })], { stopReason: "toolUse" }),
		]);

		mode = "multi";
		const res1 = await routed.completeSimple(
			vm,
			{ messages: [{ role: "user", content: "go", timestamp: 1 }] },
			attachVirtualRequestScope({}, { turnIndex: 3 }),
		);
		expect(res1.stopReason).toBe("toolUse");
		expect(callEvents.map((e) => [e.toolName, e.turnIndex])).toEqual([
			["read", 3],
			["grep", 3],
		]);

		mode = "throwSync";
		const res2 = await routed.completeSimple(vm, { messages: [{ role: "user", content: "go", timestamp: 2 }] });
		expect(res2.stopReason).toBe("toolUse");

		mode = "rejectAsync";
		const res3 = await routed.completeSimple(vm, { messages: [{ role: "user", content: "go", timestamp: 3 }] });
		expect(res3.stopReason).toBe("toolUse");

		// Hedge: primary takes 40ms before emitting, so deep-1 (afterMs: 5) wins and loser_tool never fires onToolCallStart
		const callCountBeforeHedge = callEvents.length;
		mode = "hedge";
		const res4 = await routed.completeSimple(
			vm,
			{ messages: [{ role: "user", content: "hedge", timestamp: 4 }] },
			attachVirtualRequestScope({}, { turnIndex: 5 }),
		);
		expect(res4.provider).toBe("deep-prov");
		expect(callEvents.slice(callCountBeforeHedge).map((e) => [e.toolName, e.turnIndex])).toEqual([
			["winner_tool", 5],
		]);

		// Custom definition.stream also fires onToolCallStart
		const customRouted = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "custom-stream",
					name: "Custom",
					route: () => ({ model: models.getModel("deep-prov", "deep-1")!, thinkingLevel: "off" }),
					stream: (req) => req.dispatch({ model: models.getModel("deep-prov", "deep-1")!, thinkingLevel: "off" }),
					onToolCallStart(event) {
						callEvents.push(event);
					},
				},
			],
		});
		await customRouted.completeSimple(
			customRouted.getModel("router", "custom-stream")!,
			{ messages: [{ role: "user", content: "custom", timestamp: 5 }] },
			attachVirtualRequestScope({}, { turnIndex: 7 }),
		);
		expect(callEvents.at(-1)?.toolName).toBe("custom_tool");
		expect(callEvents.at(-1)?.turnIndex).toBe(7);
	});

	it("passes request purpose and turnIndex through executeRoutedStream onComplete on standard and hedged paths", async () => {
		const { fast, deep, models } = setupModels();
		fast.setResponses([
			fauxAssistantMessage("fast done"),
			async () => {
				await new Promise((r) => setTimeout(r, 40));
				return fauxAssistantMessage("slow loser");
			},
		]);
		deep.setResponses([fauxAssistantMessage("hedged winner")]);

		let useHedge = false;
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "meta",
					name: "Meta",
					route: () =>
						useHedge
							? {
									model: models.getModel("fast-prov", "fast-1")!,
									thinkingLevel: "off",
									hedge: { afterMs: 5, model: models.getModel("deep-prov", "deep-1")!, thinkingLevel: "low" },
								}
							: { model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "off" },
				},
			],
		});

		const completions: Array<{ purpose?: string; turnIndex?: number; provider: string }> = [];
		const vm = routed.getModel("router", "meta")!;
		await routed.completeSimple(
			vm,
			{ messages: [{ role: "user", content: "turn 0", timestamp: 1 }] },
			attachVirtualRequestScope(
				{},
				{
					purpose: "continuation",
					turnIndex: 4,
					onComplete: (c) => {
						completions.push({ purpose: c.purpose, turnIndex: c.turnIndex, provider: c.message.provider });
					},
				},
			),
		);

		useHedge = true;
		await routed.completeSimple(
			vm,
			{ messages: [{ role: "user", content: "turn 1", timestamp: 2 }] },
			attachVirtualRequestScope(
				{},
				{
					purpose: "retry",
					turnIndex: 9,
					onComplete: (c) => {
						completions.push({ purpose: c.purpose, turnIndex: c.turnIndex, provider: c.message.provider });
					},
				},
			),
		);

		expect(completions).toEqual([
			{ purpose: "continuation", turnIndex: 4, provider: "fast-prov" },
			{ purpose: "retry", turnIndex: 9, provider: "deep-prov" },
		]);
	});

	it("hides the registered virtual id from a physical provider catalog and exposes the virtual entry", () => {
		const { models } = setupModels();
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "fast-prov",
					id: "auto",
					name: "Auto",
					route: () => ({ model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "off" }),
				},
			],
		});
		const ids = routed.getModels("fast-prov").map((m) => m.id);
		expect(ids).toContain("fast-1");
		expect(ids).toContain("auto");
		expect(isVirtualModel(routed.getModel("fast-prov", "auto")!)).toBe(true);
		expect(routed.getPhysicalModel("fast-prov", "auto")).toBeUndefined();
		expect(routed.unregisterVirtualModel("fast-prov", "auto")).toBe(true);
		expect(routed.unregisterVirtualModel("fast-prov", "auto")).toBe(false);
		expect(routed.getModels("fast-prov").map((m) => m.id)).toEqual(["fast-1"]);
	});

	it("rejects empty ids and ids that collide with a physical model", () => {
		const { models } = setupModels();
		const routed = withVirtualModelRouting(models);
		const route = () => ({ model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "off" as const });
		expect(() => routed.registerVirtualModel({ provider: " ", id: "x", name: "x", route })).toThrow(
			/must not be empty/,
		);
		expect(() => routed.registerVirtualModel({ provider: "fast-prov", id: "fast-1", name: "x", route })).toThrow(
			/conflicts with a physical model/,
		);
	});

	it("fails routes whose target is not a physical model or has no credentials", async () => {
		const { models } = setupModels();
		const ghost = createVirtualModel({ provider: "router", id: "ghost", name: "Ghost" });
		const routed = withVirtualModelRouting(models, {
			hasConfiguredAuth: (providerId) => providerId !== "deep-prov",
			models: [
				{
					provider: "router",
					id: "bad-target",
					name: "Bad",
					route: () => ({ model: ghost, thinkingLevel: "off" }),
				},
				{
					provider: "router",
					id: "no-auth",
					name: "NoAuth",
					route: () => ({ model: models.getModel("deep-prov", "deep-1")!, thinkingLevel: "off" }),
				},
			],
		});
		const messages: Message[] = [{ role: "user", content: "hi", timestamp: 1 }];
		await expect(
			routed.prepareVirtualRoute(routed.getModel("router", "bad-target")!, messages, { thinkingLevel: "off" }),
		).rejects.toThrow(/not a physical model/);
		await expect(
			routed.prepareVirtualRoute(routed.getModel("router", "no-auth")!, messages, { thinkingLevel: "off" }),
		).rejects.toThrow(/has no credentials/);
		await expect(
			routed.prepareVirtualRoute(createVirtualModel({ provider: "router", id: "nope", name: "Nope" }), messages, {
				thinkingLevel: "off",
			}),
		).rejects.toThrow(/is not registered/);
	});

	it("derives purpose and reason defaults in prepareVirtualRoute and clamps thinking to the physical model", async () => {
		const { models } = setupModels();
		let seen: { purpose: string; reason: string; turnIndex: number } | undefined;
		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "probe",
					name: "Probe",
					thinkingLevels: ["off", "high"],
					route(req) {
						seen = { purpose: req.purpose, reason: req.reason, turnIndex: req.turnIndex };
						return { model: models.getModel("fast-prov", "fast-1")!, thinkingLevel: "high" };
					},
				},
			],
		});
		const vm = routed.getModel("router", "probe")!;
		const messages: Message[] = [{ role: "user", content: "hi", timestamp: 1 }];
		const subagent = await routed.prepareVirtualRoute(vm, messages, {
			thinkingLevel: "off",
			reason: "user",
			isSubagent: true,
		});
		expect(seen).toEqual({ purpose: "subagent", reason: "user", turnIndex: 0 });
		expect(subagent.request.isSubagent).toBe(true);
		expect(subagent.route.thinkingLevel).toBe("off");

		await routed.prepareVirtualRoute(vm, messages, { thinkingLevel: "off", reason: "retry", turnIndex: 6 });
		expect(seen).toEqual({ purpose: "retry", reason: "retry", turnIndex: 6 });
		await routed.prepareVirtualRoute(vm, messages, { thinkingLevel: "off", purpose: "compaction" });
		expect(seen?.purpose).toBe("compaction");
	});

	it("refuses to stream an unrouted virtual model", async () => {
		const vm = createVirtualModel({ provider: "router", id: "raw", name: "Raw" });
		const result = await unroutedVirtualStream(vm).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("must be routed before streaming");
	});

	it("withVirtualModels adds virtual entries to a provider and keyless providers list only virtual models", async () => {
		const { fast } = setupModels();
		const vm = createVirtualModel({ provider: "fast-prov", id: "fast-1", name: "Shadow" });
		const decorated = withVirtualModels("fast-prov", fast.provider, [vm]);
		const listed = decorated.getModels();
		expect(listed.filter((m) => m.id === "fast-1")).toHaveLength(1);
		expect(isVirtualModel(listed.find((m) => m.id === "fast-1")!)).toBe(true);

		const keyless = withVirtualModels("solo", undefined, [vm]);
		expect(keyless.id).toBe("solo");
		expect(keyless.getModels()).toEqual([vm]);
		const result = await keyless.streamSimple(vm, { messages: [] } as unknown as TranscriptContext).result();
		expect(result.stopReason).toBe("error");
	});

	it("round-trips request scope through object spread and ignores carriers without one", () => {
		const scope = { purpose: "prompt" as const, turnIndex: 2 };
		const carrier = attachVirtualRequestScope({ reasoning: "low" as const }, scope);
		expect(getVirtualRequestScope(carrier)).toBe(scope);
		expect(getVirtualRequestScope({ ...carrier })).toBe(scope);
		expect(carrier.reasoning).toBe("low");
		expect(getVirtualRequestScope({})).toBeUndefined();
		expect(getVirtualRequestScope(undefined)).toBeUndefined();
	});

	it("is not a runtime for a plain Models instance", () => {
		const { models } = setupModels();
		expect(isVirtualModelsRuntime(models)).toBe(false);
		expect(isVirtualModelsRuntime(withVirtualModelRouting(models))).toBe(true);
	});

	it("is self-sufficient: no pi-ai virtual-models bridge or pi-durable virtual-models/sliding-window import", () => {
		const source = readFileSync(RUNTIME_SOURCE, "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
		expect(source).toMatch(/export function withVirtualModelRouting/);
	});
});
