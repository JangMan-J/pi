import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	type Api,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type ConversationStreamOptions,
	createRegistry,
	GenerationTask,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat } from "./chat-support.ts";
import { addHooks } from "./harness-support.ts";
import { context } from "./session-support.ts";

describe("harness routed seam", () => {
	it("merges streamOptions returned by GenerationHooks.beforeRequest for that request only", async () => {
		const setup = chatSetup({ models: [{ id: "faux-1", contextWindow: 64_000, maxTokens: 1024 }] });
		setup.settings.stream = {
			timeoutMs: 12_345,
			headers: { "x-settings": "keep-when-unset" },
		};

		const captured: Array<{ messages: readonly Message[]; options: SimpleStreamOptions | undefined }> = [];
		let overrideNext = true;

		addHooks(setup.registry, GenerationTask, {
			beforeRequest: async ({ messages }) => {
				if (!overrideNext) return undefined;
				overrideNext = false;
				const replaced: {
					readonly messages: readonly Message[];
					readonly streamOptions?: ConversationStreamOptions;
				} = {
					messages,
					streamOptions: {
						disableContinuation: true,
						headers: { "x-routed-seam": "active" },
					},
				};
				return replaced;
			},
		});

		setup.faux.setResponses([
			(transcript: TranscriptContext, options?: SimpleStreamOptions) => {
				captured.push({ messages: [...transcript.messages], options });
				return fauxAssistantMessage("first");
			},
			(transcript: TranscriptContext, options?: SimpleStreamOptions) => {
				captured.push({ messages: [...transcript.messages], options });
				return fauxAssistantMessage("second");
			},
		]);

		const { harness, root } = await openChat(new MemoryStorage(), setup);
		try {
			const first = await root.submit({ type: "input", content: "turn 1" }, context);
			expect((await first.wait(context)).status).toBe("done");

			const second = await root.submit({ type: "input", content: "turn 2" }, context);
			expect((await second.wait(context)).status).toBe("done");

			expect(captured).toHaveLength(2);
			expect(captured[0]!.options?.disableContinuation).toBe(true);
			expect(captured[0]!.options?.headers).toEqual({ "x-routed-seam": "active" });
			expect(captured[0]!.options?.timeoutMs).toBe(12_345);

			expect(captured[1]!.options?.disableContinuation).toBeUndefined();
			expect(captured[1]!.options?.headers).toEqual({ "x-settings": "keep-when-unset" });
			expect(captured[1]!.options?.timeoutMs).toBe(12_345);
		} finally {
			await harness.close(context);
		}
	});

	it("resolves virtual contextWindow and compaction maxTokens through structural resolveModel without prepareVirtualRoute", async () => {
		const faux = fauxProvider({
			provider: "phys",
			models: [{ id: "small", contextWindow: 400, maxTokens: 120 }],
		});
		const baseModels = createModels();
		baseModels.setProvider(faux.provider);
		const physical = baseModels.getModel("phys", "small")!;

		const virtualEntry: Model<Api> = {
			id: "routed",
			name: "Routed Virtual",
			api: "pi-virtual",
			provider: "virt",
			baseUrl: "",
			reasoning: false,
			thinkingLevelMap: { off: "off" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 0,
			maxTokens: 0,
		};

		const virtProvider: Provider = {
			id: "virt",
			name: "virt",
			auth: { apiKey: { name: "virt", resolve: async () => ({ auth: {}, source: "virt" }) } },
			getModels: () => [virtualEntry],
			stream: (_model, transcript, options) => faux.provider.stream(physical, transcript, options),
			streamSimple: (_model, transcript, options) => faux.provider.streamSimple(physical, transcript, options),
		};
		baseModels.setProvider(virtProvider);

		const seenPurposes: string[] = [];
		const routedModels = Object.assign(baseModels, {
			registerVirtualModel: () => {},
			resolveModel: async (
				_model: Model<Api>,
				_messages: readonly Message[],
				options: {
					readonly purpose?: string;
					readonly turnIndex?: number;
					readonly thinkingLevel: ModelThinkingLevel;
					readonly signal?: AbortSignal;
				},
			) => {
				seenPurposes.push(options.purpose ?? "unknown");
				return { model: physical, thinkingLevel: options.thinkingLevel };
			},
		});

		const summaryMaxTokens: Array<number | undefined> = [];
		const step = (transcript: TranscriptContext, options?: SimpleStreamOptions) => {
			const first = transcript.messages[0];
			const isSummary =
				first?.role === "system" &&
				typeof first.content === "string" &&
				first.content.startsWith("You are a context summarization assistant");
			if (isSummary) {
				summaryMaxTokens.push(options?.maxTokens);
				return fauxAssistantMessage(
					"## Goal\nTest\n\n## Constraints & Preferences\n- (none)\n\n## Progress\n### Done\n- [x] ok\n\n### In Progress\n- [ ] next\n\n### Blocked\n- (none)\n\n## Key Decisions\n- **k**: v\n\n## Next Steps\n1. finish\n\n## Critical Context\n- (none)",
				);
			}
			return fauxAssistantMessage("reply ".repeat(80));
		};
		faux.setResponses([step, step, step, step, step]);

		const registry = createRegistry();
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routedModels,
				registry,
				settings: {
					stream: { cacheRetention: "none" },
					compaction: {
						enabled: true,
						reserveTokens: 200,
						keepRecentTokens: 80,
						backgroundTokens: 0,
					},
				},
			},
			context,
		);
		try {
			const root = await harness.root(context, {
				agent: { model: { provider: "virt", modelId: "routed" } },
			});
			await (await root.submit({ type: "input", content: "u1 ".repeat(120) }, context)).wait(context);
			await (await root.submit({ type: "input", content: "u2 ".repeat(120) }, context)).wait(context);

			expect(seenPurposes).toContain("prompt");
			expect(seenPurposes).toContain("compaction");
			expect(summaryMaxTokens).toEqual([120]);
		} finally {
			await harness.close(context);
		}
	});

	it("keeps packages/durable/src/harness/util.ts free of virtual-models imports", async () => {
		const utilPath = fileURLToPath(new URL("../src/harness/util.ts", import.meta.url));
		const source = await readFile(utilPath, "utf8");
		expect(source).not.toMatch(/virtual-models/);
	});
});
