import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Message,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { PI_ATTRIBUTION, withClientIdentity } from "../src/utils/identity.ts";
import {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyRequiredToolChoicePayload,
	attachVirtualRequestScope,
	createVirtualModel,
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRouteOutcome,
	presentAssistantMessage,
	projectRoutedTranscript,
	suppressAssistantText,
	withVirtualModelRouting,
} from "../src/virtual-models-entry.ts";

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

describe("@earendil-works/pi-ai/virtual-models", () => {
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

	it("preserves declared tool lists when preserveToolDeclarations is set and filters otherwise", () => {
		const { models } = setupModels();
		const target = models.getModel("fast-prov", "fast-1")!;
		const ctx: Context = {
			systemPrompt: "sys",
			tools: [
				{ name: "read", description: "read", parameters: {} },
				{ name: "web_search", description: "search", parameters: {} },
				{ name: "edit", description: "edit", parameters: {} },
			],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};
		const normalized = projectRoutedTranscript(
			{
				messages: [{ role: "system", content: "sys", toolsAdded: ctx.tools, timestamp: 1 }, ...ctx.messages],
			} as TranscriptContext,
			{ model: target, thinkingLevel: "off", allowedTools: ["read"] },
			1,
		);
		expect(getCurrentTools(normalized.messages).map((t) => t.name)).toEqual(["read"]);

		const frozen = projectRoutedTranscript(
			{
				messages: [{ role: "system", content: "sys", toolsAdded: ctx.tools, timestamp: 1 }, ...ctx.messages],
			} as TranscriptContext,
			{ model: target, thinkingLevel: "off", allowedTools: ["read"], preserveToolDeclarations: true },
			1,
		);
		expect(getCurrentTools(frozen.messages).map((t) => t.name)).toEqual(["read", "web_search", "edit"]);
	});

	it("anchors Anthropic cache_control before ephemeralTail and adapts required toolChoice wire shapes", () => {
		const tail = "Temporary tail snippet";
		const shaped = anchorAnthropicCacheBeforeEphemeralTail(
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: "question" }] },
					{ role: "user", content: [{ type: "text", text: tail, cache_control: { type: "ephemeral" } }] },
				],
			},
			tail,
		) as { messages: Array<{ content: Array<{ cache_control?: unknown }> }> };

		expect(shaped.messages[0]?.content[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(shaped.messages[1]?.content[0]?.cache_control).toBeUndefined();

		expect(
			applyRequiredToolChoicePayload({ thinking: { type: "enabled" }, output_config: {} }, "anthropic-messages"),
		).toEqual({
			tool_choice: { type: "any" },
		});
		expect(applyRequiredToolChoicePayload({ request: { contents: [] } }, "antigravity-api")).toEqual({
			request: { contents: [], toolConfig: { functionCallingConfig: { mode: "ANY" } } },
		});
		expect(
			applyRequiredToolChoicePayload({ input: [] }, "openai-responses", {
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
			}),
		).toEqual({ input: [] });
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

		const suppressed = {
			...fauxAssistantMessage("secret"),
			content: [
				{ type: "thinking" as const, thinking: "hmm" },
				{ type: "text" as const, text: "hidden" },
				fauxToolCall("read", {}),
			],
		};
		suppressAssistantText(suppressed);
		expect(presentAssistantMessage(suppressed).content.map((b) => b.type)).toEqual(["toolCall"]);
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
});
