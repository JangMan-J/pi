import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	ResetEntry,
	ToolResultEntry,
	UsageDoc,
} from "@earendil-works/pi-durable";
import {
	buildBatonPrompts,
	buildMechanicalPreview,
	buildProseTranscript,
	calibrationRatio,
	chooseKeepFrom,
	createEmptyLedger,
	createSlidingWindow,
	createSlidingWindowFork,
	EphemeralSliceStage,
	effectiveWindowBounds,
	fallbackProse,
	MemorySlidingWindowArtifactStore,
	normalizeSliceKey,
	normalizeSlidingWindowConfig,
	portableSha256Hex,
	projectSwapTokens,
	recordToolResult,
	renderBatonSummary,
	renderLedgerBlock,
	selectCut,
	spillThresholdForTool,
	swapErrorPct,
	turnFromMessages,
	viewTurns,
} from "@earendil-works/pi-durable/sliding-window";
import {
	NodeSlidingWindowArtifactStore,
	openNodeSlidingWindowArtifactStore,
} from "@earendil-works/pi-durable/sliding-window/node";
import {
	BatonStateDoc,
	createSlidingWindowFork as createSlidingWindowForkFromVm,
	createSlidingWindow as createSlidingWindowFromVm,
	VirtualModelStateDoc,
} from "@earendil-works/pi-durable/virtual-models";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { allEntries, textOf, waitFor } from "./chat-support.ts";
import { addSection, assistant, toolResult, user } from "./harness-support.ts";
import { context } from "./session-support.ts";

describe("sliding-window pure engine", () => {
	it("re-exports createSlidingWindow and createSlidingWindowFork from virtual-models", () => {
		expect(createSlidingWindowFromVm).toBe(createSlidingWindow);
		expect(createSlidingWindowForkFromVm).toBe(createSlidingWindowFork);
	});

	it("scales bounds across 128k, sawtooth ratios, and small test windows without hardcoded floors", () => {
		const defaults = normalizeSlidingWindowConfig();
		const at128k = effectiveWindowBounds(defaults, 128_000);
		expect(at128k.hardCeilingTokens).toBeLessThanOrEqual(Math.floor(128_000 * 0.82));
		expect(at128k.softCeilingTokens).toBeLessThan(at128k.hardCeilingTokens);
		expect(at128k.keepRecentTokens).toBeLessThan(at128k.softCeilingTokens);

		const sawtooth = normalizeSlidingWindowConfig({
			softCeilingTokens: 80_000,
			hardCeilingTokens: 112_000,
			keepRecentTokens: 24_000,
			softCeilingRatio: 0.38,
			hardCeilingRatio: 0.48,
			keepRecentRatio: 0.15,
		});
		expect(effectiveWindowBounds(sawtooth, 200_000)).toEqual({
			softCeilingTokens: 76_000,
			hardCeilingTokens: 96_000,
			keepRecentTokens: 24_000,
		});
		expect(effectiveWindowBounds(sawtooth, 100_000)).toEqual({
			softCeilingTokens: 38_000,
			hardCeilingTokens: 48_000,
			keepRecentTokens: 15_000,
		});

		const small = effectiveWindowBounds(defaults, 4_000);
		expect(small.hardCeilingTokens).toBe(Math.floor(4_000 * 0.82));
		expect(small.softCeilingTokens).toBe(Math.floor(4_000 * 0.7));
		expect(small.keepRecentTokens).toBeLessThan(small.softCeilingTokens);
	});

	it("resolves per-tool spill thresholds including toolThresholds overrides without Jing coupling", () => {
		const cfg = normalizeSlidingWindowConfig({
			spillThresholdBytes: 6_144,
			readSpillThresholdBytes: 8_192,
			searchSpillThresholdBytes: 4_096,
			toolThresholds: { bash: 2_048, custom_tool: 1_024 },
		});
		expect(spillThresholdForTool("read", cfg)).toBe(8_192);
		expect(spillThresholdForTool("grep", cfg)).toBe(4_096);
		expect(spillThresholdForTool("bash", cfg)).toBe(2_048);
		expect(spillThresholdForTool("custom_tool", cfg)).toBe(1_024);
		expect(spillThresholdForTool("other_tool", cfg)).toBe(6_144);
		// Domain-specific read tool names without standard suffixes fall back to the default spill threshold.
		expect(spillThresholdForTool("mcp__custom_reader", cfg)).toBe(6_144);
	});

	it("selects cuts safely and enforces pending-toolResult guard in viewTurns", () => {
		const turns = [
			turnFromMessages("e1", [user("first task")]),
			turnFromMessages("e2", [assistant("a1", { calls: ["c1"] })]),
			turnFromMessages("e3", [toolResult("c1", "r1")]),
			turnFromMessages("e4", [user(`second task ${"x".repeat(400)}`)]),
			turnFromMessages("e5", [assistant(`done ${"y".repeat(400)}`)]),
		];
		const cut = selectCut(turns, true, 150);
		expect(cut.firstKeptId).toBe("e4");
		expect(cut.aged.map((t) => t.id)).toEqual(["e1", "e2", "e3"]);

		const noTail = selectCut(turns, false, 150);
		expect(noTail.firstKeptId).toBeNull();
		expect(noTail.aged).toHaveLength(5);

		// Pending-toolResult guard: a user steer interleaved between an assistant toolCall and its toolResult cannot be a cut point.
		const aMsg = assistant("calling", { calls: ["c9"] });
		const uSteer = user("steer before result");
		const trMsg = toolResult("c9", "late result");
		const uLater = user("next turn");
		const fakeView = {
			head: undefined,
			entries: [
				{ id: 1, kind: "pi.user" },
				{ id: 2, kind: "pi.assistant" },
				{ id: 3, kind: "pi.user" },
				{ id: 4, kind: "pi.tool-result" },
				{ id: 5, kind: "pi.user" },
			],
			contributions: [[user("root")], [aMsg], [uSteer], [trMsg], [uLater]],
			messages: [],
		} as unknown as Parameters<typeof viewTurns>[0];

		const built = viewTurns(fakeView, () => 50);
		expect(built.find((t) => t.id === "3")?.safeCutPoint).toBe(false);
		expect(built.find((t) => t.id === "5")?.safeCutPoint).toBe(true);

		expect(
			chooseKeepFrom({
				stagedFirstKeptId: null,
				preparedThroughId: "e2",
				turns,
				midRun: false,
			}),
		).toBe("e2");
	});

	it("projects swap tokens accurately and computes swapErrorPct", () => {
		expect(calibrationRatio(0, 100)).toBe(1);
		expect(calibrationRatio(500, 100)).toBe(2);
		const estimated = projectSwapTokens({
			reportedTokens: 10_000,
			estimatedPrompt: 9_000,
			estimatedDropped: 6_000,
			estimatedTrailing: 500,
			summaryTokens: 400,
			estimatedAdded: 100,
		});
		expect(estimated).toBeGreaterThan(3_000);
		expect(estimated).toBeLessThan(6_000);
		expect(swapErrorPct({ epoch: 1, estimated: 110, actual: 100 })).toBe(10);
	});

	it("stages, evicts, expires, and renders working slices portably", () => {
		const stage = new EphemeralSliceStage({ maxTotalBytes: 200, ttlTurns: 2 });
		expect(normalizeSliceKey("src/../src/app.ts", "/repo")).toBe("/repo/src/app.ts");
		expect(stage.stage({ path: "a.ts", cwd: "/repo", ref: "111", text: "const a = 1;" })).toBe(true);
		expect(stage.render()).toContain('<working_slice path="a.ts" ref="111" ephemeral="true">');
		expect(stage.render()).not.toContain("narrow_working_slice");

		stage.advanceTurn();
		expect(stage.list()).toHaveLength(1);
		stage.advanceTurn();
		expect(stage.list()).toHaveLength(0);

		expect(stage.stage({ path: "b.ts", cwd: "/repo", ref: "222", text: "b".repeat(120) })).toBe(true);
		expect(stage.stage({ path: "c.ts", cwd: "/repo", ref: "333", text: "c".repeat(120) })).toBe(true);
		// LRU eviction kept c.ts and dropped b.ts to stay under maxTotalBytes=200
		expect(stage.list().map((s) => s.path)).toEqual(["c.ts"]);
		expect(stage.evict("./c.ts", "/repo")).toBe(true);
		expect(stage.list()).toHaveLength(0);
	});

	it("renders mechanical previews and zero-Jing ledger summaries with extraSections", () => {
		const meta = {
			ref: "abcdef123456",
			sha256: "abcdef1234567890",
			toolName: "read",
			byteLen: 1200,
			lineCount: 25,
			sourcePath: "src/foo.ts",
			createdAtMs: 1,
		};
		const readPreview = buildMechanicalPreview({
			toolName: "read",
			rawText: "export function alpha() {\n  return 1;\n}\nexport class Beta {}\n",
			meta,
			stagedInEphemeralTail: true,
		});
		expect(readPreview).toContain("Outline:");
		expect(readPreview).toContain("alpha");
		expect(readPreview).toContain("active working set");

		const searchPreview = buildMechanicalPreview({
			toolName: "grep",
			rawText: "src/a.ts:10:match one\nsrc/a.ts:22:match two\nsrc/b.ts:4:match three\n",
			meta: { ...meta, toolName: "grep" },
		});
		expect(searchPreview).toContain("Grouped hits (2 files):");
		expect(searchPreview).toContain("src/a.ts (L10, L22)");

		const shellPreview = buildMechanicalPreview({
			toolName: "bash",
			rawText: Array.from({ length: 25 }, (_, i) => (i === 12 ? "TypeError: boom" : `line ${i + 1}`)).join("\n"),
			meta: { ...meta, toolName: "bash" },
			isError: true,
		});
		expect(shellPreview).toContain("Diagnostic lines");
		expect(shellPreview).toContain("TypeError: boom");

		let ledger = createEmptyLedger();
		expect(Object.keys(ledger).sort()).toEqual([
			"epoch",
			"filesEdited",
			"filesRead",
			"recentErrors",
			"recentRefs",
			"turnCount",
		]);
		ledger = recordToolResult(ledger, "read", { path: "src/foo.ts" }, { isError: false, spilled: meta });
		ledger = recordToolResult(ledger, "edit", { path: "src/foo.ts" }, { isError: false });
		ledger = recordToolResult(ledger, "bash", {}, { isError: true, errorText: "exit 1" });

		const block = renderLedgerBlock(ledger, ["- **Custom section:** active"]);
		expect(block).toContain("Custom section:");
		expect(block).toContain("`src/foo.ts`");

		const prompts = buildBatonPrompts(undefined, buildProseTranscript([turnFromMessages("1", [user("fix bug")])]));
		expect(prompts.systemPrompt.toLowerCase()).not.toContain("dealer");

		const summary = renderBatonSummary({
			ledger,
			proseDigest: "- Fixed bug",
			epoch: 1,
			tokensBefore: 100_000,
			keptTokens: 20_000,
			extraSections: ["- **Goal:** Keep tests green"],
		});
		expect(summary).toContain("<!-- sliding-window epoch 1 • before 100k • kept ~20k tail -->");
		expect(summary).not.toContain("pi-narrow");
		expect(fallbackProse(ledger, ["retry build"])).toContain("retry build");
	});

	it("computes portable SHA-256 matching node:crypto and recalls via MemorySlidingWindowArtifactStore", () => {
		const sample = "hello sliding-window world\nline 2\nline 3";
		expect(portableSha256Hex(sample)).toBe(createHash("sha256").update(sample, "utf8").digest("hex"));

		const mem = new MemorySlidingWindowArtifactStore();
		const meta = mem.put(Array.from({ length: 30 }, (_, i) => `row ${i + 1}: item_${i + 1}`).join("\n"), {
			toolName: "bash",
			label: "logs",
		});
		const byRange = mem.recall({ ref: `ref:${meta.ref}`, startLine: 5, endLine: 7 });
		expect(byRange.found).toBe(true);
		expect(byRange.returnedLines).toBe(3);
		expect(byRange.text).toContain("item_6");

		const byQuery = mem.recall({ ref: meta.ref, query: "item_18", contextLines: 1 });
		expect(byQuery.found).toBe(true);
		expect(byQuery.text).toContain("item_18");

		const missing = mem.recall({ ref: "nonexistent" });
		expect(missing.found).toBe(false);
		expect(missing.text).toContain("[sliding-window recall]");
		mem.close();
	});

	it("stores, deduplicates, FTS5-recalls, and detects stale sources in NodeSlidingWindowArtifactStore", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "pi-sw-node-"));
		try {
			const filePath = join(tmpDir, "sample.ts");
			const initialContent = Array.from({ length: 120 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join(
				"\n",
			);
			writeFileSync(filePath, initialContent, "utf8");

			const store = openNodeSlidingWindowArtifactStore(join(tmpDir, "artifacts.sqlite"));
			expect(store).toBeInstanceOf(NodeSlidingWindowArtifactStore);
			const m1 = store.put(initialContent, { toolName: "read", sourcePath: filePath, cwd: tmpDir });
			const m2 = store.put(initialContent, { toolName: "read", sourcePath: filePath, cwd: tmpDir });
			expect(m2.ref).toBe(m1.ref);
			expect(store.listRecent(5)).toHaveLength(1);

			const ftsHit = store.recall({ ref: m1.ref, query: "line_95", contextLines: 1, cwd: tmpDir });
			expect(ftsHit.found).toBe(true);
			expect(ftsHit.staleSource).toBeUndefined();
			expect(ftsHit.text).toContain("export const line_95 = 95;");

			writeFileSync(filePath, `${initialContent}\nexport const line_121 = 121;\n`, "utf8");
			const staleHit = store.recall({ ref: m1.ref, startLine: 1, endLine: 3, cwd: tmpDir });
			expect(staleHit.staleSource?.path).toBe(filePath);
			expect(staleHit.text).toContain("stale snapshot");
			store.close();
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("sliding-window Harness integration", () => {
	it("spills oversized reads onto Node store + ephemeralTail, recalls lines, and respects dynamic setEnabled with cache-stable tool declarations", async () => {
		const mainProv = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);

		const bigFile = Array.from({ length: 60 }, (_, i) => `export function fn_${i + 1}() { return ${i + 1}; }`).join(
			"\n",
		);
		const readTool = defineTool({
			name: "read",
			description: "Read a file",
			parameters: obj({ path: str() }),
			execute: async (args) => ({
				output: [{ type: "text", text: args.path === "src/big.ts" ? bigFile : "small" }],
			}),
		});

		const store = openNodeSlidingWindowArtifactStore(":memory:");
		const sw = createSlidingWindow({
			target: models.getModel("anthropic", "claude-sonnet")!,
			readSpillThresholdBytes: 256,
			spillThresholdBytes: 128,
			artifactStore: store,
			previewToolOutput: ({ toolName, meta }) =>
				toolName === "custom_dump" ? `[custom preview ref:${meta.ref}]` : undefined,
		});
		const routed = sw.wrapModels(models);

		const dumpTool = defineTool({
			name: "custom_dump",
			description: "Dump",
			parameters: obj({}),
			execute: async () => ({ output: [{ type: "text", text: "dump\n".repeat(40) }] }),
		});

		const registry = createRegistry();
		registry.install(sw.extension);
		registry.install(defineExtension({ name: "app-tools", tools: [readTool, dumpTool] }));

		const seenContexts: TranscriptContext[] = [];
		let capturedRef = "";
		mainProv.setResponses([
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/big.ts" })], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenContexts.push(ctx);
				const trText = textOf(ctx.messages.findLast((m) => m.role === "toolResult")) ?? "";
				const match = /ref:([a-f0-9]+)/.exec(trText);
				capturedRef = match?.[1] ?? "";
				return fauxAssistantMessage([fauxToolCall("recall", { ref: capturedRef, startLine: 45, endLine: 47 })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("custom_dump", {})], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("Recalled successfully.");
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/big.ts" })], { stopReason: "toolUse" });
			},
			(ctx) => {
				seenContexts.push(ctx);
				return fauxAssistantMessage("Disabled mode kept raw read.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		const root = await harness.root(context, { agent: { model: sw.selection } });

		await (await root.submit({ type: "input", content: "Inspect src/big.ts" }, context)).wait(context);
		await root.waitForIdle(context);

		const toolEntries = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		expect(textOf(toolEntries[0]?.model?.[0])).toContain("Outline:");
		expect(textOf(toolEntries[0]?.model?.[0])).toContain(`ref:${capturedRef}`);
		expect(textOf(toolEntries[1]?.model?.[0])).toContain("export function fn_46()");
		expect(textOf(toolEntries[2]?.model?.[0])).toMatch(/^\[custom preview ref:[a-f0-9]+\]$/);
		// Ephemeral slice was attached on turn 2 wire context.
		expect(textOf(seenContexts[1]?.messages.at(-1))).toContain('<working_slice path="src/big.ts"');

		// Disable dynamically: recall tool declaration stays registered, but spilling is bypassed.
		sw.setEnabled(false);
		expect(sw.inspect(root.id).enabled).toBe(false);
		await (await root.submit({ type: "input", content: "Read again while disabled" }, context)).wait(context);
		await root.waitForIdle(context);

		expect(getCurrentTools(seenContexts[4]!.messages).map((t) => t.name)).toContain("recall");
		const entriesAfter = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		expect(textOf(entriesAfter.at(-1)?.model?.[0])).toContain("export function fn_1()");
		expect(textOf(seenContexts[5]?.messages.at(-1))).not.toContain("<working_slice");

		await sw.close();
		await harness.close(context);
	});

	it("runs soft-ceiling baton swap with BatonStateDoc, sidecarUsage, renderExtraSections, and onBeforeSwap hooks, plus hard-ceiling fallback and anchorFirstUser=false", async () => {
		const mainProv = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-sonnet", contextWindow: 40_000, maxTokens: 4096 },
				{ id: "claude-haiku", contextWindow: 40_000, maxTokens: 2048 },
			],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);

		let cancelNext = false;
		const sw = createSlidingWindow({
			target: models.getModel("anthropic", "claude-sonnet")!,
			softCeilingTokens: 600,
			hardCeilingTokens: 1_500,
			keepRecentTokens: 150,
			batonModel: "anthropic/claude-haiku",
			anchorFirstUser: true,
			renderExtraSections: ({ epoch }) => [`- **Hook Section:** epoch=${epoch}`],
			onBeforeSwap: ({ summary }) => {
				if (cancelNext) return { cancel: true };
				return {
					summary: `${summary}\n\n- **BeforeSwap Hook:** injected`,
					data: { customFlag: true },
				};
			},
		});
		const routed = sw.wrapModels(models);
		const registry = createRegistry();
		registry.install(sw.extension);

		const seenRequests: TranscriptContext[] = [];
		const isHelperReq = (ctx: TranscriptContext) =>
			ctx.messages.some((m) => typeof m.content === "string" && m.content.includes("Aged-Out Prose"));
		const mainOrHelper = (mainLabel: string) => (ctx: TranscriptContext) => {
			if (isHelperReq(ctx)) {
				return fauxAssistantMessage("- Digest from haiku helper");
			}
			seenRequests.push(ctx);
			return fauxAssistantMessage(mainLabel);
		};

		mainProv.setResponses([
			mainOrHelper(`Answer 1 ${"r".repeat(1_200)}`),
			mainOrHelper("Answer 2 (prep started)"),
			mainOrHelper("Answer 2b (helper slot)"),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		const root = await harness.root(context, { agent: { model: sw.selection } });

		await (await root.submit({ type: "input", content: `ANCHOR PROMPT ONE ${"p".repeat(2_600)}` }, context)).wait(
			context,
		);
		// Turn 2: soft ceiling triggers background baton prep (startBaton)
		await (await root.submit({ type: "input", content: "Second prompt triggers baton prep" }, context)).wait(context);
		// Wait for async baton helper to finish staging
		await waitFor(() => sw.inspect(root.id).note.startsWith("ready"));

		// First test onBeforeSwap({ cancel: true }): swap is cancelled, epoch stays 0
		cancelNext = true;
		mainProv.setResponses([mainOrHelper("Answer while cancelled")]);
		await (await root.submit({ type: "input", content: "Prompt while swap cancelled" }, context)).wait(context);
		expect(sw.inspect(root.id).epoch).toBe(0);

		// Re-prepare baton cleanly and let swap proceed
		cancelNext = false;
		mainProv.setResponses([mainOrHelper("Answer 4 (re-arm)"), mainOrHelper("Answer 4b (helper slot)")]);
		await (await root.submit({ type: "input", content: "Re-arm baton prep" }, context)).wait(context);
		await waitFor(() => sw.inspect(root.id).note.startsWith("ready"));

		mainProv.setResponses([
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("Post-swap response");
			},
		]);
		await (await root.submit({ type: "input", content: "Final post-swap prompt" }, context)).wait(context);
		await root.waitForIdle(context);

		const baton = await harness.snapshot(BatonStateDoc, root.id, context);
		expect(baton?.epoch).toBe(1);
		expect(baton?.handoffSummary).toContain("Hook Section:** epoch=1");
		expect(baton?.handoffSummary).toContain("BeforeSwap Hook:** injected");
		expect(baton?.swappedAtTokens).toBeGreaterThanOrEqual(600);

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.sidecars?.["baton:anthropic/claude-haiku"]?.totalTokens).toBeGreaterThan(0);

		const lastMainReq = seenRequests.at(-1)!;
		const userMsgs = lastMainReq.messages.filter((m) => m.role === "user");
		expect(textOf(userMsgs[0])).toContain("ANCHOR PROMPT ONE");
		expect(textOf(userMsgs[1])).toContain("<!-- sliding-window epoch 1");

		const resets = (await allEntries(root)).filter((e) => ResetEntry.is(e));
		expect(resets).toHaveLength(1);
		expect(sw.inspect(root.id).probe?.actual).toBeGreaterThan(0);

		await sw.close();
		await harness.close(context);
	});

	it("executes hard-ceiling burst fallback with 0 helper calls and supports anchorFirstUser=false and dynamic model switching", async () => {
		const provA = fauxProvider({
			provider: "openai",
			models: [
				{ id: "gpt-small", contextWindow: 4_000, maxTokens: 2048 },
				{ id: "gpt-large", contextWindow: 100_000, maxTokens: 4096 },
			],
		});
		const models = createModels();
		models.setProvider(provA.provider);

		const sw = createSlidingWindow({
			// Omitted target -> resolves dynamically from AgentDoc.model!
			softCeilingTokens: 50_000,
			hardCeilingTokens: 60_000,
			keepRecentTokens: 10_000,
			softCeilingRatio: 0.38,
			hardCeilingRatio: 0.48,
			keepRecentRatio: 0.15,
			keepTail: false,
			anchorFirstUser: (m) => m?.provider === "anthropic", // false for openai
		});
		const registry = createRegistry();
		registry.install(sw.extension);

		const seenRequests: TranscriptContext[] = [];
		provA.setResponses([
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage(`Hit burst ${"b".repeat(4_200)}`);
			},
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("Recovered via burst fallback");
			},
			(ctx) => {
				seenRequests.push(ctx);
				return fauxAssistantMessage("On larger model now");
			},
		]);

		const harness = await Harness.open(
			new MemoryStorage(),
			{ models, registry, settings: { compaction: { enabled: false } } },
			context,
		);
		harness.resume();
		const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-small" } } });

		await (await root.submit({ type: "input", content: `First user turn ${"u".repeat(8_200)}` }, context)).wait(
			context,
		);
		// Bounds reflect gpt-small (4k): soft=1520, hard=1920, keepRecent=600
		expect(sw.inspect(root.id).bounds).toEqual({
			softCeilingTokens: 1_520,
			hardCeilingTokens: 1_920,
			keepRecentTokens: 600,
		});

		await (await root.submit({ type: "input", content: "Second turn hits burst fallback" }, context)).wait(context);
		await root.waitForIdle(context);

		// anchorFirstUser=false => ResetEntry.model has only [handoff] (no anchorUser0)
		const baton = await harness.snapshot(BatonStateDoc, root.id, context);
		expect(baton?.epoch).toBe(1);
		expect(baton?.anchorUser0).toBeUndefined();
		expect(baton?.handoffSummary).toContain("burst-fallback");
		const usersOnSecondReq = seenRequests[1]!.messages.filter((m) => m.role === "user");
		expect(usersOnSecondReq).toHaveLength(2); // [handoff, "Second turn hits burst fallback"]
		expect(textOf(usersOnSecondReq[0])).toContain("burst-fallback");

		// Switch physical model dynamically via root.configure({ model })
		await root.configure({ model: { provider: "openai", modelId: "gpt-large" } }, context);
		await (await root.submit({ type: "input", content: "Third turn on gpt-large" }, context)).wait(context);
		await root.waitForIdle(context);

		expect(sw.inspect(root.id).bounds).toEqual({
			softCeilingTokens: 38_000,
			hardCeilingTokens: 48_000,
			keepRecentTokens: 10_000,
		});

		await sw.close();
		await harness.close(context);
	});

	it("supports dynamic target callback and createSlidingWindowFork cache/baton/window controls", async () => {
		const prov = fauxProvider({
			provider: "meta",
			models: [
				{ id: "model-one", contextWindow: 20_000, maxTokens: 2048, reasoning: true },
				{ id: "model-two", contextWindow: 80_000, maxTokens: 4096, reasoning: true },
			],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		let activeTarget: Model<"faux"> = models.getModel("meta", "model-one")! as Model<"faux">;
		const sw = createSlidingWindow({
			target: () => activeTarget,
			readSpillThresholdBytes: 128,
		});
		const routed = sw.wrapModels(models);

		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async () => ({ output: [{ type: "text", text: "line\n".repeat(40) }] }),
		});
		const webTool = defineTool({
			name: "web_search",
			description: "Search",
			parameters: obj({ query: str() }),
			execute: async () => ({ output: [{ type: "text", text: "search result" }] }),
		});

		const registry = createRegistry();
		registry.install(sw.extension);
		registry.install(defineExtension({ name: "app-tools", tools: [readTool, webTool] }));
		addSection(registry, "sys", () => "System", { tag: false });

		const captured: Array<{
			model: string;
			sessionId?: string;
			disableContinuation?: boolean;
			reasoning?: string;
			tools: string[];
		}> = [];

		prov.setResponses([
			(ctx, opts, _state, model) => {
				captured.push({
					model: model.id,
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Parent ready.");
			},
			(ctx, opts, _state, model) => {
				captured.push({
					model: model.id,
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage([fauxToolCall("web_search", { query: "blocked" })], { stopReason: "toolUse" });
			},
			(ctx, opts, _state, model) => {
				captured.push({
					model: model.id,
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], { stopReason: "toolUse" });
			},
			(ctx, opts, _state, model) => {
				captured.push({
					model: model.id,
					sessionId: opts?.sessionId,
					disableContinuation: opts?.disableContinuation,
					reasoning: opts?.reasoning,
					tools: getCurrentTools(ctx.messages).map((t) => t.name),
				});
				return fauxAssistantMessage("Fork done.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: sw.selection, thinkingLevel: "medium" },
		});
		await root.commit(async (tx) => {
			const baton = await tx.doc(BatonStateDoc, root.id);
			baton.epoch = 3;
			baton.handoffSummary = "Parent epoch 3";
		}, context);

		await (await root.submit({ type: "input", content: "Warm parent" }, context)).wait(context);
		await root.waitForIdle(context);
		expect(captured[0]!.model).toBe("model-one");

		// Switch dynamic target callback before running fork
		activeTarget = models.getModel("meta", "model-two")! as Model<"faux">;

		const parentAnswerId = (await allEntries(root)).findLast((e) => AssistantEntry.is(e))!.id;
		const fork = await createSlidingWindowFork(
			root,
			parentAnswerId,
			{
				ownership: { kind: "ownerless" },
				agent: { thinkingLevel: "off" },
				allowedTools: ["read", "recall"],
				blockedToolReason: "web_search disallowed in fork",
				disableContinuation: true,
				preserveToolDeclarations: true,
				copyProviderSession: true,
				preserveThinkingLevel: true,
				inheritBatonState: false,
				slidingWindow: false,
			},
			context,
		);

		await (await fork.submit({ type: "input", content: "Run on fork" }, context)).wait(context);
		await fork.waitForIdle(context);

		// Dynamic target switched to model-two; sessionId copied; continuation disabled; thinking preserved; wire tools frozen
		expect(captured[1]!.model).toBe("model-two");
		expect(captured[1]!.sessionId).toBe(captured[0]!.sessionId);
		expect(captured[1]!.disableContinuation).toBe(true);
		expect(captured[1]!.reasoning).toBe("medium");
		expect(captured[1]!.tools).toEqual(["recall", "read", "web_search"]);

		// web_search blocked by beforeTool; read NOT spilled because slidingWindow: false
		const forkToolResults = (await allEntries(fork)).filter((e) => ToolResultEntry.is(e));
		expect(textOf(forkToolResults[0]?.model?.[0])).toContain("web_search disallowed in fork");
		expect(textOf(forkToolResults[1]?.model?.[0])).toContain("line\nline");

		// inheritBatonState: false reset fork's BatonStateDoc to epoch 0 while parent stayed at epoch 3
		expect((await harness.snapshot(BatonStateDoc, fork.id, context))?.epoch).toBe(0);
		expect((await harness.snapshot(BatonStateDoc, root.id, context))?.epoch).toBe(3);
		expect((await harness.snapshot(VirtualModelStateDoc, fork.id, context))?.forkGuard?.allowedTools).toEqual([
			"read",
			"recall",
		]);
		expect(sw.inspect(fork.id).enabled).toBe(false);

		await sw.close();
		await harness.close(context);
	});
});
