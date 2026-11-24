import {
	type AssistantMessage,
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type JsonObject,
	type Message,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import { PI_ATTRIBUTION, withClientIdentity } from "../src/utils/identity.ts";
import {
	anchorAnthropicCacheBeforeEphemeralTail,
	applyRequiredToolChoicePayload,
	attachVirtualRequestScope,
	createVirtualModel,
	ENCRYPTED_REASONING_COMMENTARY_PROMPT,
	harvestPostReadStudyNotes,
	isVirtualModel,
	isVirtualModelsRuntime,
	type ModelRouteOutcome,
	presentAssistantMessage,
	projectRoutedTranscript,
	type StudyNoteHarvestOptions,
	suppressAssistantText,
	type ToolCallStartEvent,
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

	afterEach(() => {
		vi.useRealTimers();
	});

	it("harvests post-read study notes across all 8 model families with bold-heading stripping, tail caps, commentary fallback, path matching, and fence escaping", () => {
		expect(ENCRYPTED_REASONING_COMMENTARY_PROMPT).toContain("2-3 concise sentences");

		const commentarySig = (id: string) => JSON.stringify({ v: 1, id, phase: "commentary" });
		const finalSig = (id: string) => JSON.stringify({ v: 1, id, phase: "final_answer" });
		const longDeepSeekSuffix = "DEEPSEEK_TAIL_MARKER_999";
		const deepSeekThinking = `${"A".repeat(1200)}\n${"B".repeat(700)} ${longDeepSeekSuffix}`;

		const makeReadExchange = (
			callId: string,
			toolName: string,
			args: JsonObject,
			assistantBlock: AssistantMessage["content"],
			options?: { isError?: boolean; includeSystemBetween?: boolean; stopReason?: "toolUse" | "stop" | "error" },
		): Message[] => [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
				api: "anthropic-messages",
				provider: "p",
				model: "m",
				usage: makeUsage(1, 1),
				stopReason: "toolUse",
				timestamp: 10,
			},
			{
				role: "toolResult",
				toolCallId: callId,
				toolName,
				content: [{ type: "text", text: "file body" }],
				isError: options?.isError ?? false,
				timestamp: 11,
			},
			...(options?.includeSystemBetween
				? ([{ role: "system", content: "status ping", timestamp: 12 }] satisfies Message[])
				: []),
			{
				role: "assistant",
				content: assistantBlock,
				api: "anthropic-messages",
				provider: "p",
				model: "m",
				usage: makeUsage(1, 1),
				stopReason: options?.stopReason ?? "toolUse",
				timestamp: 13,
			} as Message,
		];

		// 1-6: Native thinking families + bold heading stripping + DeepSeek tail cap
		const messages: Message[] = [
			...makeReadExchange("c1", "read", { path: "packages/ai/src/a.ts" }, [
				{
					type: "thinking",
					thinking:
						"**Checking types**\nAntigravity Gemini verified that virtual-stream preserves timestamps across sibling forks.",
				},
				fauxToolCall("edit", { path: "packages/ai/src/a.ts" }),
			]),
			...makeReadExchange("c2", "tool_read", { file_path: "packages/ai/src/b.ts" }, [
				{
					type: "thinking",
					thinking:
						"**Invariant**: Anthropic Opus verified cache_control stays ahead of ephemeralTail across turns and preserves stable KV prefix.",
				},
				fauxToolCall("edit", { path: "packages/ai/src/b.ts" }),
			]),
			...makeReadExchange(
				"c3",
				"read",
				{ path: "packages/ai/src/c.ts" },
				[
					{
						type: "thinking",
						thinking: `GLM 5.3 + Kimi K3.1 + Grok 4.7 shared note: ${"X".repeat(80)} preserved cleanly.`,
					},
					fauxToolCall("edit", { path: "packages/ai/src/c.ts" }),
				],
				{ includeSystemBetween: true },
			),
			...makeReadExchange("c4", "read", { path: "packages/ai/src/deepseek.ts" }, [
				{ type: "thinking", thinking: deepSeekThinking },
				fauxToolCall("edit", { path: "packages/ai/src/deepseek.ts" }),
			]),
			// 7: OpenAI GPT-6.2-sol (bold-only summary < minThinkingChars -> falls back to commentary)
			...makeReadExchange("c5", "read", { path: "packages/ai/src/openai.ts" }, [
				{ type: "thinking", thinking: "**Inspecting schema**" },
				{
					type: "text",
					text: "GPT-6.2-sol commentary: schema requires strict non-empty tool names.",
					textSignature: commentarySig("msg_1"),
				},
				fauxToolCall("edit", { path: "packages/ai/src/openai.ts" }),
			]),
			// 8: Meta Muse-Wonder (redacted thinking -> falls back to commentary, skips final_answer)
			...makeReadExchange("c6", "read", { filePath: "packages/ai/src/meta.ts" }, [
				{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true },
				{
					type: "text",
					text: "Muse-Wonder commentary: tool declarations stay frozen for shapeMetaWireTools.",
					textSignature: commentarySig("msg_2"),
				},
				{
					type: "text",
					text: "Should be ignored final_answer",
					textSignature: finalSig("msg_3"),
				},
				fauxToolCall("edit", { path: "packages/ai/src/meta.ts" }),
			]),
			// Non-tool stop turn must NOT fall back to text
			...makeReadExchange(
				"c7",
				"read",
				{ path: "packages/ai/src/ignored-stop.ts" },
				[
					{ type: "thinking", thinking: "**Short**" },
					{ type: "text", text: "Final reply to user should never be harvested." },
				],
				{ stopReason: "stop" },
			),
			// Non-read tool (grep) and errored read must be ignored
			...makeReadExchange("c8", "grep", { path: "packages/ai/src/grep.ts" }, [
				{ type: "thinking", thinking: "Grep thinking ".repeat(15) },
				fauxToolCall("edit", { path: "packages/ai/src/grep.ts" }),
			]),
			...makeReadExchange(
				"c9",
				"read",
				{ path: "packages/ai/src/err.ts" },
				[
					{ type: "thinking", thinking: "Error recovery thinking ".repeat(15) },
					fauxToolCall("edit", { path: "packages/ai/src/err.ts" }),
				],
				{ isError: true },
			),
		];

		const harvested = harvestPostReadStudyNotes(messages);
		expect(harvested).toBeDefined();
		expect(harvested).toContain("<study_notes>");
		expect(harvested).toContain("</study_notes>");
		expect(harvested).not.toContain("**Checking types**");
		expect(harvested).toContain("**Invariant**: Anthropic Opus");
		expect(harvested).toContain(longDeepSeekSuffix);
		expect(harvested).not.toContain("A".repeat(800));
		expect(harvested).toContain("GPT-6.2-sol commentary");
		expect(harvested).toContain("Muse-Wonder commentary");
		expect(harvested).not.toContain("Should be ignored final_answer");
		expect(harvested).not.toContain("Final reply to user");
		expect(harvested).not.toContain("Grep thinking");
		expect(harvested).not.toContain("Error recovery thinking");

		// Path/glob filtering + directory boundary (src/a must NOT match src/ab/x.ts) + fence escaping
		const pathMessages: Message[] = [
			...makeReadExchange("p1", "read", { path: "/workspace/src/ab/x.ts" }, [
				{ type: "thinking", thinking: "Wrong directory ab ".repeat(10) },
				fauxToolCall("edit", { path: "/workspace/src/ab/x.ts" }),
			]),
			...makeReadExchange("p2", "read", { path: "/workspace/src/a/ok.ts" }, [
				{
					type: "thinking",
					thinking: `${"Right directory note ".repeat(8)} contains </study_notes> breakout attempt.`,
				},
				fauxToolCall("edit", { path: "/workspace/src/a/ok.ts" }),
			]),
		];
		const filtered = harvestPostReadStudyNotes(pathMessages, {
			relevantPaths: ["src/a"],
		} satisfies StudyNoteHarvestOptions);
		expect(filtered).toBeDefined();
		expect(filtered).not.toContain("Wrong directory ab");
		expect(filtered).toContain("Right directory note");
		expect(filtered).toContain("<\\/study_notes>");
		expect(filtered!.match(/<\/study_notes>/g)).toHaveLength(1);
		expect(harvestPostReadStudyNotes(pathMessages, { relevantPaths: ["**/*.py"] })).toBeUndefined();
		expect(harvestPostReadStudyNotes(pathMessages, { relevantPaths: [] })).toBeUndefined();
	});

	it("preserves deterministic timestamps in projectRoutedTranscript, completeSimple, and transformMessages", async () => {
		vi.useFakeTimers();
		const { fast, models } = setupModels();
		const seenContexts: TranscriptContext[] = [];
		fast.setResponses([
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("fork 1");
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("fork 2");
			},
		]);

		const routed = withVirtualModelRouting(models, {
			models: [
				{
					provider: "router",
					id: "frozen-ts",
					name: "Frozen TS",
					route: () => ({
						model: models.getModel("fast-prov", "fast-1")!,
						thinkingLevel: "off",
						systemAppend: "Append directive",
						ephemeralTail: "<working_slice>frozen</working_slice>",
					}),
				},
			],
		});

		const vm = routed.getModel("router", "frozen-ts")!;
		const baseMessages: Message[] = [{ role: "user", content: "Shared checkpoint prompt", timestamp: 42_000 }];

		vi.setSystemTime(100_000);
		await routed.completeSimple(vm, { messages: baseMessages });
		const direct1 = projectRoutedTranscript(
			{ messages: baseMessages } as TranscriptContext,
			{
				model: models.getModel("fast-prov", "fast-1")!,
				thinkingLevel: "off",
				systemAppend: "Dir",
				ephemeralTail: "Tail",
			},
			Date.now(),
		);

		vi.setSystemTime(999_000);
		await routed.completeSimple(vm, { messages: baseMessages });
		const direct2 = projectRoutedTranscript(
			{ messages: baseMessages } as TranscriptContext,
			{
				model: models.getModel("fast-prov", "fast-1")!,
				thinkingLevel: "off",
				systemAppend: "Dir",
				ephemeralTail: "Tail",
			},
			Date.now(),
		);

		expect(seenContexts[0]).toStrictEqual(seenContexts[1]);
		expect(seenContexts[0]?.messages[0]?.timestamp).toBe(42_000);
		expect(seenContexts[0]?.messages.at(-1)?.timestamp).toBe(42_000);
		expect(direct1).toStrictEqual(direct2);
		expect(direct1.messages[0]?.timestamp).toBe(42_000);

		const targetModel = models.getModel("fast-prov", "fast-1")!;
		const orphanTranscript: Message[] = [
			{
				role: "assistant",
				content: [fauxToolCall("read", { path: "a.ts" })],
				api: targetModel.api,
				provider: targetModel.provider,
				model: targetModel.id,
				usage: makeUsage(1, 1),
				stopReason: "toolUse",
				timestamp: 77_777,
			},
		];
		vi.setSystemTime(111_000);
		const t1 = transformMessages(orphanTranscript, targetModel);
		vi.setSystemTime(888_000);
		const t2 = transformMessages(orphanTranscript, targetModel);
		expect(t1).toStrictEqual(t2);
		expect(t1[1]?.timestamp).toBe(77_777);
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
});
