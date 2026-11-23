import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, sqliteBackend } from "@earendil-works/chord";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	type Model,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { withVirtualModelRouting } from "@earendil-works/pi-ai/virtual-models";
import {
	AgentDoc,
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	ProviderDoc,
	ResetEntry,
	SystemEntry,
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
	createLayeredArtifactStore,
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
	SlidingWindowLedgerDoc,
	SlidingWindowStateDoc,
	SlidingWindowTargetDoc,
	selectCut,
	spillThresholdForTool,
	swapErrorPct,
	turnFromMessages,
	viewTurns,
} from "@earendil-works/pi-durable/sliding-window";
import {
	exportCheckpointedFork,
	NodeSlidingWindowArtifactStore,
	openNodeSlidingWindowArtifactStore,
} from "@earendil-works/pi-durable/sliding-window/node";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import {
	BatonStateDoc,
	createSlidingWindowFork as createSlidingWindowForkFromVm,
	createSlidingWindow as createSlidingWindowFromVm,
	VirtualModelStateDoc,
} from "@earendil-works/pi-durable/virtual-models";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { describe, expect, it, vi } from "vitest";
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

		// Guardrail 1: multi-turn autonomous loops must NOT clamp back to an earlier aged-out user turn.
		const multiTurnLoop = [
			turnFromMessages("u0", [user("root prompt")]),
			turnFromMessages("a1", [assistant("step 1", { calls: ["c1"] })]),
			turnFromMessages("r1", [toolResult("c1", "ok")]),
			turnFromMessages("u1", [user("follow-up prompt")]),
			turnFromMessages("a2", [assistant("step 2", { calls: ["c2"] })]),
			turnFromMessages("r2", [toolResult("c2", "ok")]),
			turnFromMessages("a3", [assistant("step 3", { calls: ["c3"] })]),
			turnFromMessages("r3", [toolResult("c3", "ok")]),
			turnFromMessages("a4", [assistant("step 4", { calls: ["c4"] })]),
			turnFromMessages("r4", [toolResult("c4", "ok")]),
		];
		expect(
			chooseKeepFrom({
				stagedFirstKeptId: "a4",
				turns: multiTurnLoop,
				midRun: true,
			}),
		).toBe("a4");

		const steerMidRun = [
			turnFromMessages("u0", [user("root")]),
			turnFromMessages("a1", [assistant("s1", { calls: ["c1"] })]),
			turnFromMessages("r1", [toolResult("c1", "ok")]),
			turnFromMessages("a2", [assistant("s2", { calls: ["c2"] })]),
			turnFromMessages("r2", [toolResult("c2", "ok")]),
			turnFromMessages("u_steer", [user("steer instruction")]),
			turnFromMessages("a3", [assistant("s3", { calls: ["c3"] })]),
			turnFromMessages("r3", [toolResult("c3", "ok")]),
		];
		expect(
			chooseKeepFrom({
				stagedFirstKeptId: null,
				preparedThroughId: "r2",
				turns: steerMidRun,
				midRun: true,
			}),
		).toBe("u_steer");

		const noPreparedFallback = [
			turnFromMessages("u0", [user("root")]),
			turnFromMessages("a1", [assistant("s1", { calls: ["c1"] })]),
			turnFromMessages("r1", [toolResult("c1", "ok")]),
			turnFromMessages("u1", [user("later user")]),
			turnFromMessages("a2", [assistant("s2", { calls: ["c2"] })]),
			turnFromMessages("r2", [toolResult("c2", "ok")]),
		];
		expect(
			chooseKeepFrom({
				stagedFirstKeptId: null,
				turns: noPreparedFallback,
				midRun: true,
			}),
		).toBeNull();
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

	it("falls back to createEmptyLedger when BatonStateDoc.data holds non-MechanicalLedger JSON", async () => {
		const mainProv = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);

		const bigFile = Array.from({ length: 60 }, (_, i) => `export const item_${i + 1} = ${i + 1};`).join("\n");
		const readTool = defineTool({
			name: "read",
			description: "Read a file",
			parameters: obj({ path: str() }),
			execute: async () => ({ output: [{ type: "text", text: bigFile }] }),
		});

		const store = new MemorySlidingWindowArtifactStore();
		const sw = createSlidingWindow({
			target: models.getModel("anthropic", "claude-sonnet")!,
			readSpillThresholdBytes: 128,
			artifactStore: store,
		});
		const routed = sw.wrapModels(models);
		const registry = createRegistry();
		registry.install(sw.extension);
		registry.install(defineExtension({ name: "app-tools", tools: [readTool] }));

		mainProv.setResponses([
			() => fauxAssistantMessage([fauxToolCall("read", { path: "src/non-ledger.ts" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage("Completed after non-ledger baton hydration."),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		const root = await harness.root(context, { agent: { model: sw.selection } });

		await root.commit(async (tx) => {
			const baton = await tx.doc(BatonStateDoc, root.id);
			baton.epoch = 2;
			baton.data = { customKey: "not-a-ledger", nested: { turnCount: "bad" } };
		}, context);

		await (await root.submit({ type: "input", content: "Read src/non-ledger.ts" }, context)).wait(context);
		await root.waitForIdle(context);

		const toolResults = (await allEntries(root)).filter((e) => ToolResultEntry.is(e));
		expect(toolResults).toHaveLength(1);
		expect(textOf(toolResults[0]?.model?.[0])).toContain("Outline:");
		expect(textOf(toolResults[0]?.model?.[0])).toContain("ref:");

		const inspected = sw.inspect(root.id);
		expect(Number.isFinite(inspected.ledger.turnCount)).toBe(true);
		expect(inspected.ledger.turnCount).toBe(2);
		expect(inspected.ledger.epoch).toBe(2);
		expect(inspected.ledger.filesRead.map((r) => r.path)).toContain("src/non-ledger.ts");

		await sw.close();
		await harness.close(context);
	});

	it("reflects fork slidingWindow=false in inspect() before any turn and prevents global setEnabled(true) from overriding it", async () => {
		const prov = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet", contextWindow: 100_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const sw = createSlidingWindow({
			target: models.getModel("anthropic", "claude-sonnet")!,
			readSpillThresholdBytes: 128,
		});
		const routed = sw.wrapModels(models);

		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async () => ({ output: [{ type: "text", text: "raw line\n".repeat(40) }] }),
		});

		const registry = createRegistry();
		registry.install(sw.extension);
		registry.install(defineExtension({ name: "app-tools", tools: [readTool] }));

		prov.setResponses([
			() => fauxAssistantMessage("Root turn done."),
			() => fauxAssistantMessage([fauxToolCall("read", { path: "src/fork.ts" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage("Fork turn done."),
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		const root = await harness.root(context, { agent: { model: sw.selection } });

		await (await root.submit({ type: "input", content: "Root prompt" }, context)).wait(context);
		await root.waitForIdle(context);

		const ansId = (await allEntries(root)).findLast((e) => AssistantEntry.is(e))!.id;
		const fork = await createSlidingWindowFork(
			root,
			ansId,
			{
				ownership: { kind: "ownerless" },
				slidingWindow: false,
			},
			context,
		);

		// Immediately before any turn runs on the fork, inspect() must reflect slidingWindow: false.
		expect(sw.inspect(fork.id).enabled).toBe(false);

		// Calling global setEnabled(true) must NOT override the fork's explicit slidingWindow: false.
		sw.setEnabled(true);
		expect(sw.inspect(fork.id).enabled).toBe(false);

		await (await fork.submit({ type: "input", content: "Read on disabled fork" }, context)).wait(context);
		await fork.waitForIdle(context);

		const forkToolResults = (await allEntries(fork)).filter((e) => ToolResultEntry.is(e));
		expect(forkToolResults).toHaveLength(1);
		expect(textOf(forkToolResults[0]?.model?.[0])).toContain("raw line\nraw line");
		expect(sw.inspect(fork.id).enabled).toBe(false);

		// Explicit per-conversation setEnabled(true, fork.id) can still re-enable the fork.
		sw.setEnabled(true, fork.id);
		expect(sw.inspect(fork.id).enabled).toBe(true);

		await sw.close();
		await harness.close(context);
	});

	it("rescales inspect().bounds synchronously when options.target switches to an unregistered custom Model and caches it in beforeRequest even at 0 usage tokens", async () => {
		const prov = fauxProvider({
			provider: "meta",
			models: [{ id: "model-200k", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const models = createModels();
		models.setProvider(prov.provider);

		const registered200k = models.getModel("meta", "model-200k")!;
		const unregisteredCustom32k: Model<typeof registered200k.api> = {
			...registered200k,
			id: "custom-unregistered-32k",
			name: "Custom Unregistered 32k",
			contextWindow: 32_000,
			maxTokens: 4096,
		};

		let currentTarget: Model<typeof registered200k.api> | undefined = registered200k;
		const sw = createSlidingWindow({
			target: () => currentTarget,
			softCeilingTokens: 200_000,
			hardCeilingTokens: 200_000,
			keepRecentTokens: 50_000,
			softCeilingRatio: 0.5,
			hardCeilingRatio: 0.75,
			keepRecentRatio: 0.15,
		});
		const routed = sw.wrapModels(models);
		const registry = createRegistry();
		registry.install(sw.extension);

		let seenOutboundModelId: string | undefined;
		prov.setResponses([
			(_ctx, _opts, _state, model) => {
				seenOutboundModelId = model.id;
				// Error stopReason keeps prompt usage at 0 / lastUsageTokens unset so beforeAgentStart & afterResponse skip.
				return fauxAssistantMessage("zero-usage error", { stopReason: "error", errorMessage: "simulated error" });
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry }, context);
		harness.resume();
		// Use registered physical model on AgentDoc so faux provider executes while options.target returns unregisteredCustom32k.
		const root = await harness.root(context, { agent: { model: { provider: "meta", modelId: "model-200k" } } });

		// Initial 200k bounds before any turn
		expect(sw.inspect(root.id).bounds).toEqual({
			softCeilingTokens: 100_000,
			hardCeilingTokens: 150_000,
			keepRecentTokens: 30_000,
		});

		// Switch target callback to unregistered custom 32k model before any turn runs
		currentTarget = unregisteredCustom32k;
		expect(sw.inspect(root.id).bounds).toEqual({
			softCeilingTokens: 16_000,
			hardCeilingTokens: 24_000,
			keepRecentTokens: 4_800,
		});

		// Run a turn with 0 reported usage tokens; beforeRequest still caches lastPhysicalModel = unregisteredCustom32k
		await (await root.submit({ type: "input", content: "Trigger beforeRequest on 32k custom model" }, context)).wait(
			context,
		);
		await root.waitForIdle(context);

		expect(seenOutboundModelId).toBe("model-200k");
		expect(sw.inspect(root.id).lastUsageTokens).toBeUndefined();

		// Even if options.target subsequently returns undefined, cached lastPhysicalModel preserves 32k bounds
		currentTarget = undefined;
		expect(sw.inspect(root.id).bounds).toEqual({
			softCeilingTokens: 16_000,
			hardCeilingTokens: 24_000,
			keepRecentTokens: 4_800,
		});

		await sw.close();
		await harness.close(context);
	});

	it("Fix 1: swaps autonomously mid-run during a 45-round single-prompt tool loop without ending unanswered or emitting AfterToolsDecision errors", async () => {
		const mainProv = fauxProvider({
			provider: "anthropic",
			models: [{ id: "main-8k", contextWindow: 8_000, maxTokens: 1024 }],
		});
		const helperProv = fauxProvider({
			provider: "anthropic-helper",
			models: [{ id: "helper-fast", contextWindow: 16_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);
		models.setProvider(helperProv.provider);

		// Unit check for Guardrail 1: assistant turns are safeCutPoint and midRun: true does not clamp back to lastUser === 0
		const singlePromptTurns = [
			turnFromMessages("u0", [{ role: "user", content: "Do 45 tool rounds" }]),
			turnFromMessages("a1", [
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } }] },
			]),
			turnFromMessages("r1", [
				{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "ok" }] },
			]),
			turnFromMessages("a2", [
				{ role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: { path: "b.ts" } }] },
			]),
			turnFromMessages("r2", [
				{ role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: "ok" }] },
			]),
		];
		expect(singlePromptTurns[1]!.safeCutPoint).toBe(true);
		expect(chooseKeepFrom({ stagedFirstKeptId: "a2", turns: singlePromptTurns, midRun: true })).toBe("a2");
		expect(
			chooseKeepFrom({ stagedFirstKeptId: null, preparedThroughId: "r1", turns: singlePromptTurns, midRun: true }),
		).toBe("a2");

		let round = 0;
		const seenMsgCounts: number[] = [];
		mainProv.setResponses(
			Array.from({ length: 46 }, () => (ctx: TranscriptContext) => {
				round += 1;
				seenMsgCounts.push(ctx.messages.length);
				const approxTokens = Math.max(400, ctx.messages.length * 140);
				if (round <= 45) {
					return {
						...fauxAssistantMessage(
							[
								{ type: "thinking", thinking: `Round ${round} study invariant ${"x".repeat(120)}` },
								fauxToolCall("read", { path: `src/file_${round}.ts` }),
							],
							{ stopReason: "toolUse" },
						),
						usage: {
							input: approxTokens,
							output: 60,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: approxTokens + 60,
							cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
						},
					};
				}
				return fauxAssistantMessage("All 45 rounds complete.");
			}),
		);
		helperProv.setResponses(
			Array.from({ length: 12 }, (_, idx) => ({
				...fauxAssistantMessage(`- Mid-run baton digest #${idx + 1}`),
				usage: {
					input: 220,
					output: 40,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 260,
					cost: { input: 0.0002, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0004 },
				},
			})),
		);

		const readTool = defineTool({
			name: "read",
			description: "Read file",
			parameters: obj({ path: str() }),
			execute: async (args) => ({ output: [{ type: "text", text: `contents of ${args.path}` }] }),
		});

		const sw = createSlidingWindow({
			batonModel: "anthropic-helper/helper-fast",
			softCeilingTokens: 450,
			hardCeilingTokens: 900,
			keepRecentTokens: 180,
			keepTail: true,
		});
		const routed = sw.wrapModels(models);
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.tools", tools: [readTool] }));
		registry.install(sw.extension);

		const reports: unknown[] = [];
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: routed,
				registry,
				settings: { compaction: { enabled: false } },
				onReport: (err) => reports.push(err),
			},
			context,
		);
		harness.resume();
		const root = await harness.root(context, {
			agent: { model: sw.selection },
		});
		await root.configure({ model: models.getModel("anthropic", "main-8k") ? sw.selection : sw.selection }, context);
		await root.commit(async (tx) => {
			(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "anthropic", modelId: "main-8k" };
		}, context);

		const submission = await root.submit({ type: "input", content: "Run 45 autonomous read rounds" }, context);
		const result = await submission.wait(context);
		await root.waitForIdle(context);

		expect(result.status, `result=${JSON.stringify(result)} reports=${JSON.stringify(reports)} round=${round}`).toBe(
			"done",
		);
		expect(round).toBe(46);
		expect(reports).toEqual([]);

		const entries = await allEntries(root);
		const resets = entries.filter((e) => ResetEntry.is(e));
		expect(resets.length).toBeGreaterThanOrEqual(2);
		for (const r of resets) {
			// Kept tail starts on an assistant entry (safeCutPoint: true) rather than user[0]
			expect(r.head).toBeDefined();
			expect(r.head).not.toBe(r.id);
		}
		// Verify context message count dropped mid-run due to ResetEntry swaps
		expect(Math.max(...seenMsgCounts)).toBeLessThan(35);

		const baton = await harness.snapshot(BatonStateDoc, root.id, context);
		expect(baton?.epoch).toBeGreaterThanOrEqual(2);
		expect(baton?.harvestedStudyNotes).toContain("<study_notes>");

		const usage = await harness.snapshot(UsageDoc, root.id, context);
		expect(usage?.sidecars?.["baton:anthropic-helper/helper-fast"]).toBeDefined();

		await sw.close();
		await harness.close(context);
	});

	it("Fix 2 & Fix 3: persists SlidingWindowLedgerDoc across restart and asOf forks, records BatonPrepTask sidecar spend on cancel/restart, and guards stale epoch", async () => {
		const mainProv = fauxProvider({
			provider: "openai",
			models: [{ id: "main-4k", contextWindow: 4_000, maxTokens: 512 }],
		});
		const helperProv = fauxProvider({
			provider: "openai-helper",
			models: [{ id: "mini-helper", contextWindow: 8_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);
		models.setProvider(helperProv.provider);

		const dir = mkdtempSync(join(tmpdir(), "sw-fix23-"));
		const dbPath = join(dir, "session.sqlite");
		try {
			const readTool = defineTool({
				name: "read",
				description: "Read file",
				parameters: obj({ path: str() }),
				execute: async (args) => ({ output: [{ type: "text", text: `big ${args.path} ${"x".repeat(400)}` }] }),
			});
			const editTool = defineTool({
				name: "edit",
				description: "Edit file",
				parameters: obj({ path: str() }),
				execute: async (args) => ({ output: [{ type: "text", text: `edited ${args.path}` }] }),
			});

			// Epoch 0 mid-epoch persistence & fork(at)
			let cancelSwap = true;
			const sw1 = createSlidingWindow({
				batonModel: "openai-helper/mini-helper",
				softCeilingTokens: 150,
				hardCeilingTokens: 900,
				keepRecentTokens: 60,
				spillThresholdBytes: 50,
				onBeforeSwap: () => (cancelSwap ? { cancel: true } : undefined),
			});
			let routed = sw1.wrapModels(models);
			let reg = createRegistry();
			reg.install(defineExtension({ name: "test.tools", tools: [readTool, editTool] }));
			reg.install(sw1.extension);

			mainProv.setResponses([
				{
					...fauxAssistantMessage([fauxToolCall("read", { path: "alpha.ts" })], { stopReason: "toolUse" }),
					usage: {
						input: 1_100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_120,
						cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
				},
				fauxAssistantMessage("Read alpha done."),
			]);
			helperProv.setResponses([
				{
					...fauxAssistantMessage("- Prepared digest 1"),
					usage: {
						input: 150,
						output: 30,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 180,
						cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
					},
				},
			]);

			const store1 = await StoreStorage.open(
				await openStore(sqliteBackend(await openNodeSqliteDatabase(dbPath)), context),
				"pi",
				context,
			);
			const harness1 = await Harness.open(
				store1,
				{ models: routed, registry: reg, settings: { compaction: { enabled: false } } },
				context,
			);
			harness1.resume();
			const root1 = await harness1.root(context, { agent: { model: sw1.selection } });
			await root1.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, root1.id)).target = { provider: "openai", modelId: "main-4k" };
			}, context);

			await (await root1.submit({ type: "input", content: "Read alpha" }, context)).wait(context);
			await root1.waitForIdle(context);
			const atAlpha = (await allEntries(root1)).findLast((e) => AssistantEntry.is(e))!.id;

			// Now do a second read + edit after atAlpha
			mainProv.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("read", { path: "beta.ts" }), fauxToolCall("edit", { path: "beta.ts" })],
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage("Read+edit beta done."),
			]);
			await (await root1.submit({ type: "input", content: "Read and edit beta" }, context)).wait(context);
			await root1.waitForIdle(context);

			// Cancel swap via onBeforeSwap({ cancel: true }) on next turn while BatonPrepTask already recorded sidecar spend
			const prepTaskId = (await harness1.snapshot(BatonStateDoc, root1.id, context))?.preparingTaskId;
			if (prepTaskId !== undefined) await harness1.waitForTask(prepTaskId, context);

			mainProv.setResponses([fauxAssistantMessage("Cancelled swap still answered.")]);
			await (await root1.submit({ type: "input", content: "Trigger cancelled swap" }, context)).wait(context);
			await root1.waitForIdle(context);

			const usageAfterCancel = await harness1.snapshot(UsageDoc, root1.id, context);
			expect(usageAfterCancel?.sidecars?.["baton:openai-helper/mini-helper"]?.totalTokens).toBeGreaterThan(0);

			// Fork at atAlpha: must inherit alpha.ts only, NOT beta.ts
			const fork = await createSlidingWindowFork(root1, atAlpha, { ownership: { kind: "ownerless" } }, context);
			const forkLedger = await harness1.snapshot(SlidingWindowLedgerDoc, fork.id, context);
			expect(forkLedger?.filesRead.map((r) => r.path)).toEqual(["alpha.ts"]);
			expect(forkLedger?.filesEdited).toEqual([]);

			await sw1.close();
			await harness1.close(context);

			// Restart Harness + fresh createSlidingWindow on same SQLite DB (before any swap, epoch === 0)
			cancelSwap = false;
			let helperCallsAfterRestart = 0;
			helperProv.setResponses([
				() => {
					helperCallsAfterRestart += 1;
					return fauxAssistantMessage("- Should not run if staged survived");
				},
			]);
			mainProv.setResponses([
				{
					...fauxAssistantMessage("Post-restart response"),
					usage: {
						input: 1_200,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1_220,
						cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
					},
				},
				fauxAssistantMessage("Second turn after staged restart"),
			]);

			const sw2 = createSlidingWindow({
				batonModel: "openai-helper/mini-helper",
				softCeilingTokens: 150,
				hardCeilingTokens: 900,
				keepRecentTokens: 60,
				spillThresholdBytes: 50,
			});
			routed = sw2.wrapModels(models);
			reg = createRegistry();
			reg.install(defineExtension({ name: "test.tools", tools: [readTool, editTool] }));
			reg.install(sw2.extension);

			const store2 = await StoreStorage.open(
				await openStore(sqliteBackend(await openNodeSqliteDatabase(dbPath)), context),
				"pi",
				context,
			);
			const harness2 = await Harness.open(
				store2,
				{ models: routed, registry: reg, settings: { compaction: { enabled: false } } },
				context,
			);
			harness2.resume();
			const root2 = await harness2.root(context);

			// Trigger BatonPrepTask again on a fresh high-token turn, wait for idle, restart BEFORE swap, verify staged survives restart!
			helperCallsAfterRestart = 0;
			helperProv.setResponses([
				() => {
					helperCallsAfterRestart += 1;
					return {
						...fauxAssistantMessage("- Survives restart digest"),
						usage: {
							input: 180,
							output: 25,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 205,
							cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
						},
					};
				},
			]);
			await (await root2.submit({ type: "input", content: "Prepare new staged baton" }, context)).wait(context);
			await root2.waitForIdle(context);
			const prep2 = (await harness2.snapshot(BatonStateDoc, root2.id, context))?.preparingTaskId;
			if (prep2 !== undefined) await harness2.waitForTask(prep2, context);
			expect(helperCallsAfterRestart).toBe(1);
			expect(sw2.inspect(root2.id).ledger.filesRead.map((r) => r.path)).toEqual(["alpha.ts", "beta.ts"]);
			const stagedBeforeRestart = (await harness2.snapshot(BatonStateDoc, root2.id, context))?.staged;
			expect(stagedBeforeRestart?.proseDigest).toBe("- Survives restart digest");

			await sw2.close();
			await harness2.close(context);

			// Reopen a 3rd time and submit — swap must consume persisted BatonStateDoc.staged without re-calling helper!
			const sw3 = createSlidingWindow({
				batonModel: "openai-helper/mini-helper",
				softCeilingTokens: 150,
				hardCeilingTokens: 900,
				keepRecentTokens: 60,
				spillThresholdBytes: 50,
			});
			const routed3 = sw3.wrapModels(models);
			const reg3 = createRegistry();
			reg3.install(defineExtension({ name: "test.tools", tools: [readTool, editTool] }));
			reg3.install(sw3.extension);
			const store3 = await StoreStorage.open(
				await openStore(sqliteBackend(await openNodeSqliteDatabase(dbPath)), context),
				"pi",
				context,
			);
			const harness3 = await Harness.open(
				store3,
				{ models: routed3, registry: reg3, settings: { compaction: { enabled: false } } },
				context,
			);
			harness3.resume();
			const root3 = await harness3.root(context);
			await (await root3.submit({ type: "input", content: "Consume staged baton after restart" }, context)).wait(
				context,
			);
			await root3.waitForIdle(context);

			expect(helperCallsAfterRestart).toBe(1);
			const batonAfter = await harness3.snapshot(BatonStateDoc, root3.id, context);
			expect(batonAfter?.epoch).toBe(1);
			expect(batonAfter?.staged).toBeUndefined();
			expect(batonAfter?.handoffSummary).toContain("- Survives restart digest");

			await sw3.close();
			await harness3.close(context);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Fix 4 & B2: drops artifact_chunks, separates artifact_sources, enforces GC with pinnedRefs, and layers readOnly fallback stores", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sw-fix4-"));
		const parentDbPath = join(dir, "parent.artifacts.sqlite");
		const childDbPath = join(dir, "child.artifacts.sqlite");
		try {
			// Seed legacy artifact_chunks table and verify writable open drops it
			const rawSeed = new DatabaseSync(parentDbPath);
			rawSeed.exec(
				`CREATE TABLE artifact_chunks (ref TEXT NOT NULL, chunk_idx INTEGER NOT NULL, start_line INTEGER, end_line INTEGER, text TEXT, PRIMARY KEY (ref, chunk_idx))`,
			);
			rawSeed.close();

			const fileA = join(dir, "a", "index.ts");
			const fileB = join(dir, "b", "index.ts");
			mkdirSync(join(dir, "a"), { recursive: true });
			mkdirSync(join(dir, "b"), { recursive: true });
			const sharedBody = Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i};`).join("\n");
			writeFileSync(fileA, sharedBody);
			writeFileSync(fileB, sharedBody);

			let pinned = new Set<string>();
			const store = openNodeSlidingWindowArtifactStore(parentDbPath, {
				maxTotalBytes: 80,
				minAgeMs: 1_000,
				gcIntervalPuts: 1,
				pinnedRefs: () => pinned,
			});

			const metaA = store.put(sharedBody, { toolName: "read", sourcePath: "a/index.ts", cwd: dir, nowMs: 10_000 });
			const metaB = store.put(sharedBody, { toolName: "read", sourcePath: "b/index.ts", cwd: dir, nowMs: 10_000 });
			expect(metaA.ref).toBe(metaB.ref);
			expect(store.getLatestBySourcePath("a/index.ts", dir)?.meta.sourcePath).toContain("a/index.ts");
			expect(store.getLatestBySourcePath("b/index.ts", dir)?.meta.sourcePath).toContain("b/index.ts");

			// Mutate a/index.ts on disk -> recall detects staleSource
			writeFileSync(fileA, `${sharedBody}\nexport const mutated = true;`);
			expect(store.recall({ ref: metaA.ref, cwd: dir }).staleSource).toBeDefined();

			// GC evicts unpinned aged blobs while sparing pinnedRefs
			pinned = new Set([metaA.ref]);
			const evictable = store.put("evictable old blob ".repeat(12), { toolName: "bash", nowMs: 1_000 });
			const triggerGc = store.put("newest fresh blob ".repeat(12), { toolName: "bash", nowMs: 100_000 });
			expect(store.getMeta(metaA.ref)).toBeDefined();
			expect(store.getMeta(evictable.ref)).toBeUndefined();
			expect(store.getMeta(triggerGc.ref)).toBeDefined();
			store.close();

			// Verify artifact_chunks is absent
			const inspectDb = new DatabaseSync(parentDbPath, { readOnly: true });
			const chunksRow = inspectDb
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_chunks'`)
				.get();
			expect(chunksRow).toBeUndefined();
			const sourcesCount = inspectDb.prepare(`SELECT COUNT(*) AS cnt FROM artifact_sources`).get() as {
				cnt: number;
			};
			expect(sourcesCount.cnt).toBe(2);
			inspectDb.close();

			// chmod 0444 parent DB -> open readOnly + createLayeredArtifactStore
			chmodSync(parentDbPath, 0o444);
			const roParent = openNodeSlidingWindowArtifactStore(parentDbPath, { readOnly: true });
			expect(() => roParent.put("nope", { toolName: "read" })).toThrow(/read-only/);
			expect(roParent.recall({ ref: metaA.ref, cwd: dir }).found).toBe(true);

			const writableChild = openNodeSlidingWindowArtifactStore(childDbPath);
			const layered = createLayeredArtifactStore(writableChild, [roParent]);
			const childMeta = await layered.put("child only artifact line", { toolName: "bash" });
			expect(roParent.getMeta(childMeta.ref)).toBeUndefined();
			expect(writableChild.getMeta(childMeta.ref)).toBeDefined();
			expect(await layered.getMeta?.(metaA.ref)).toBeDefined();
			await expect(layered.getLatestBySourcePath?.("b/index.ts", dir)).resolves.toMatchObject({ text: sharedBody });
			await layered.close?.();
		} finally {
			try {
				chmodSync(parentDbPath, 0o644);
			} catch {
				// ignore
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Fix 5 & Fix 6: stops physical-model split-brain staging, sets disableContinuation on root <working_slice> turns, uses per-conversation SlidingWindowTargetDoc, escapes </working_slice>, and supports release() + LRU", async () => {
		const provA = fauxProvider({
			provider: "prov-a",
			models: [{ id: "model-a", contextWindow: 16_000, maxTokens: 512 }],
		});
		const provB = fauxProvider({
			provider: "prov-b",
			models: [{ id: "model-b", contextWindow: 32_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(provA.provider);
		models.setProvider(provB.provider);

		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async (args) => ({
				output: [{ type: "text", text: `line1\n</working_slice>\n${"pad ".repeat(30)}\npath=${args.path}` }],
			}),
		});

		const sw = createSlidingWindow({
			spillThresholdBytes: 40,
			readSpillThresholdBytes: 40,
			maxTrackedConversations: 2,
		});
		const routed = sw.wrapModels(models);
		const reg = createRegistry();
		reg.install(defineExtension({ name: "test.tools", tools: [readTool] }));
		reg.install(sw.extension);

		const seen: Array<{ model: string; disableContinuation?: boolean; tail?: unknown }> = [];
		provA.setResponses([
			(ctx, opts) => {
				seen.push({
					model: "model-a",
					disableContinuation: opts?.disableContinuation,
					tail: ctx.messages.at(-1)?.content,
				});
				return fauxAssistantMessage([fauxToolCall("read", { path: "phys.ts" })], { stopReason: "toolUse" });
			},
			(ctx, opts) => {
				seen.push({
					model: "model-a",
					disableContinuation: opts?.disableContinuation,
					tail: ctx.messages.at(-1)?.content,
				});
				return fauxAssistantMessage("Physical mode done.");
			},
			(ctx, opts) => {
				seen.push({
					model: "model-a",
					disableContinuation: opts?.disableContinuation,
					tail: ctx.messages.at(-1)?.content,
				});
				return fauxAssistantMessage([fauxToolCall("read", { path: "root.ts" })], { stopReason: "toolUse" });
			},
			(ctx, opts) => {
				seen.push({
					model: "model-a",
					disableContinuation: opts?.disableContinuation,
					tail: ctx.messages.at(-1)?.content,
				});
				return fauxAssistantMessage("Root virtual mode done.");
			},
		]);
		provB.setResponses([
			(ctx, opts) => {
				seen.push({
					model: "model-b",
					disableContinuation: opts?.disableContinuation,
					tail: ctx.messages.at(-1)?.content,
				});
				return fauxAssistantMessage("Fork routed to model-b.");
			},
		]);

		const harness = await Harness.open(new MemoryStorage(), { models: routed, registry: reg }, context);
		harness.resume();

		// 1. Direct physical AgentDoc.model -> spills with [Call recall...] WITHOUT staging or claiming active working set
		const physConv = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "prov-a", modelId: "model-a" } } },
			context,
		);
		await (await physConv.submit({ type: "input", content: "Read physical" }, context)).wait(context);
		await physConv.waitForIdle(context);
		const physToolResult = textOf((await allEntries(physConv)).find((e) => ToolResultEntry.is(e))?.model?.[0]);
		expect(physToolResult).toContain("recall(");
		expect(physToolResult).not.toContain("active working set");
		expect(sw.inspect(physConv.id).stagedSlices).toBe(0);

		// 2. Root sliding-window with SlidingWindowTargetDoc -> prov-a/model-a; escapes </working_slice> and sets disableContinuation: true
		const root = await harness.root(context, { agent: { model: sw.selection } });
		await root.commit(async (tx) => {
			(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "prov-a", modelId: "model-a" };
		}, context);
		await (await root.submit({ type: "input", content: "Read virtual root" }, context)).wait(context);
		await root.waitForIdle(context);
		const rootTurnWithSlice = seen.find((s) => typeof s.tail === "string" && s.tail.includes("<working_slice"));
		expect(rootTurnWithSlice).toBeDefined();
		expect(rootTurnWithSlice?.disableContinuation).toBe(true);
		expect(String(rootTurnWithSlice?.tail)).toContain("<\\/working_slice>");

		// 3. Child fork switches SlidingWindowTargetDoc to prov-b/model-b independently from root
		const atRoot = (await allEntries(root)).findLast((e) => AssistantEntry.is(e))!.id;
		const fork = await createSlidingWindowFork(
			root,
			atRoot,
			{ ownership: { kind: "ownerless" }, target: { provider: "prov-b", modelId: "model-b" } },
			context,
		);
		await (await fork.submit({ type: "input", content: "Run on fork target" }, context)).wait(context);
		await fork.waitForIdle(context);
		expect(seen.at(-1)?.model).toBe("model-b");

		// 4. release() & LRU eviction cap (maxTrackedConversations = 2)
		sw.release(fork.id);
		sw.inspect("conv-extra-1");
		sw.inspect("conv-extra-2");
		expect(sw.inspect(fork.id).epoch).toBe(0);

		await sw.close();
		await harness.close(context);
	});

	it("Part II B1–B4: composes inner virtual model (onToolCallStart + onOutcome(toolResults)), hydrates scoped paths with widen delta, and exports checkpointed fork across SQLite DBs", async () => {
		const fastProv = fauxProvider({
			provider: "fast",
			models: [{ id: "fast-1", contextWindow: 16_000, maxTokens: 512 }],
		});
		const strongProv = fauxProvider({
			provider: "strong",
			models: [{ id: "strong-1", contextWindow: 32_000, maxTokens: 1024 }],
		});
		const models = createModels();
		models.setProvider(fastProv.provider);
		models.setProvider(strongProv.provider);

		const toolCallStarts: string[] = [];
		const escalatedDef = {
			provider: "router",
			id: "escalate",
			name: "Escalate",
			route(req: { state?: unknown }) {
				const errCount = (req.state as { errors?: number } | undefined)?.errors ?? 0;
				return errCount >= 1
					? { model: models.getModel("strong", "strong-1")!, thinkingLevel: "off" as const }
					: { model: models.getModel("fast", "fast-1")!, thinkingLevel: "off" as const };
			},
			onToolCallStart(ev: { toolName: string }) {
				toolCallStarts.push(ev.toolName);
			},
			onOutcome(outcome: { toolResults: readonly { isError: boolean }[]; state?: unknown }) {
				const prev = (outcome.state as { errors?: number } | undefined)?.errors ?? 0;
				const added = outcome.toolResults.filter((r) => r.isError).length;
				return { errors: prev + added };
			},
		};

		const dir = mkdtempSync(join(tmpdir(), "sw-b14-"));
		const exportDbPath = join(dir, "fork.sqlite");
		try {
			writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
			writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");

			const failTool = defineTool({
				name: "check",
				description: "Check",
				parameters: obj({ ok: opt(str()) }),
				execute: async (args) =>
					args.ok === "yes"
						? { output: [{ type: "text", text: "ok" }] }
						: { output: [{ type: "text", text: "failed" }], isError: true },
			});
			const readTool = defineTool({
				name: "read",
				description: "Read",
				parameters: obj({ path: str() }),
				execute: async (args) => ({ output: [{ type: "text", text: `read:${args.path}` }] }),
			});

			const sw = createSlidingWindow({ cwd: dir });
			const routed = withVirtualModelRouting(models, { models: [escalatedDef] });
			sw.wrapModels(routed);
			const reg = createRegistry();
			reg.install(defineExtension({ name: "test.tools", tools: [failTool, readTool] }));
			reg.install(sw.extension);

			const parentTailMessages: string[] = [];
			fastProv.setResponses([
				(ctx) => {
					parentTailMessages.push(String(ctx.messages.at(-1)?.content));
					return fauxAssistantMessage(
						[
							{ type: "thinking", thinking: "Parent study invariant about a.ts and b.ts ".repeat(5) },
							fauxToolCall("read", { path: "a.ts" }),
						],
						{ stopReason: "toolUse" },
					);
				},
				() =>
					fauxAssistantMessage(
						[
							{ type: "thinking", thinking: "Parent study invariant about a.ts and b.ts ".repeat(5) },
							{ type: "text", text: "Parent ready for fork." },
						],
						{ timestamp: 88_000 },
					),
			]);

			const parentHarness = await Harness.open(
				new MemoryStorage(),
				{
					models: routed,
					registry: reg,
					env: async () =>
						({
							readTextFile: async (p: string) => {
								const { readFileSync } = await import("node:fs");
								return { ok: true as const, value: readFileSync(p, "utf8") };
							},
						}) as never,
				},
				context,
			);
			parentHarness.resume();
			const parent = await parentHarness.root(context, { agent: { model: sw.selection, cwd: dir } });
			await parent.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, parent.id)).target = { provider: "fast", modelId: "fast-1" };
			}, context);
			await (await parent.submit({ type: "input", content: "Study codebase" }, context)).wait(context);
			await parent.waitForIdle(context);
			const atEntry = (await allEntries(parent)).findLast((e) => AssistantEntry.is(e))!.id;

			// Export checkpointed fork with owner: "cellar" -> SQLite DB -> reopen in isolated Harness
			const exported = await exportCheckpointedFork(
				{
					parent,
					parentHarness,
					at: atEntry,
					targetDbPath: exportDbPath,
					owner: "cellar",
					models: routed,
					registry: reg,
					systemPrompt: "Child system prompt",
					tools: [failTool, readTool, sw.recallTool],
					taskPrompt: "Execute scoped work",
					dispatchSummary: "Focus on a.ts",
					targetModel: { provider: "router", modelId: "escalate" },
					allowedTools: ["check", "read"],
					allowedPaths: ["a.ts"],
					cwd: dir,
				},
				context,
			);
			expect(exported.studyNotes).toContain("<study_notes>");

			// Open exported DB in a separate Harness (simulating sandboxed worker process) with B3 HydratePolicy + B1 escalation!
			const childSeen: Array<{ model: string; tail: unknown; tools: string[]; disableContinuation?: boolean }> = [];
			fastProv.setResponses([
				(ctx, opts) => {
					childSeen.push({
						model: "fast-1",
						tail: ctx.messages.at(-1)?.content,
						tools: getCurrentTools(ctx.messages).map((t) => t.name),
						disableContinuation: opts?.disableContinuation,
					});
					return fauxAssistantMessage([fauxToolCall("check", { ok: "no" })], { stopReason: "toolUse" });
				},
			]);
			strongProv.setResponses([
				(ctx, opts) => {
					childSeen.push({
						model: "strong-1",
						tail: ctx.messages.at(-1)?.content,
						tools: getCurrentTools(ctx.messages).map((t) => t.name),
						disableContinuation: opts?.disableContinuation,
					});
					return fauxAssistantMessage("Escalated to strong-1 after tool error.");
				},
				(ctx, opts) => {
					childSeen.push({
						model: "strong-1",
						tail: ctx.messages.at(-1)?.content,
						tools: getCurrentTools(ctx.messages).map((t) => t.name),
						disableContinuation: opts?.disableContinuation,
					});
					return fauxAssistantMessage("Widened b.ts only.");
				},
			]);

			const childSw = createSlidingWindow({ cwd: dir });
			const childRouted = withVirtualModelRouting(models, { models: [escalatedDef] });
			childSw.wrapModels(childRouted);
			const childReg = createRegistry();
			childReg.install(defineExtension({ name: "test.tools", tools: [failTool, readTool] }));
			childReg.install(childSw.extension);

			const childDb = await openNodeSqliteDatabase(exportDbPath);
			const childStore = await StoreStorage.open(
				await openStore(sqliteBackend(childDb), context),
				"cellar",
				context,
			);
			const childHarness = await Harness.open(
				childStore,
				{
					models: childRouted,
					registry: childReg,
					env: async () =>
						({
							readTextFile: async (p: string) => {
								const { readFileSync } = await import("node:fs");
								return { ok: true as const, value: readFileSync(p, "utf8") };
							},
						}) as never,
				},
				context,
			);
			childHarness.resume();
			const childRoot = await childHarness.root(context);

			// Verify planSystemEntries emits zero duplicate SystemEntry on turn 1
			const systemEntriesBefore = (await allEntries(childRoot)).filter((e) => SystemEntry.is(e)).length;
			await (await childRoot.submit({ type: "input", content: "Run check" }, context)).wait(context);
			await childRoot.waitForIdle(context);
			const systemEntriesAfter = (await allEntries(childRoot)).filter((e) => SystemEntry.is(e)).length;
			expect(systemEntriesAfter).toBe(systemEntriesBefore);

			// Turn 1 used fast-1 with a.ts hydrated and frozen tools + disableContinuation: true; tool error escalated Turn 2 to strong-1!
			expect(childSeen[0]?.model).toBe("fast-1");
			expect(String(childSeen[0]?.tail)).toContain("export const a = 1;");
			expect(childSeen[0]?.disableContinuation).toBe(true);
			expect(childSeen[0]?.tools).toEqual(["check", "read", "recall"]);
			expect(childSeen[1]?.model).toBe("strong-1");
			expect(toolCallStarts).toContain("check");

			// Widen allowedPaths to ["a.ts", "b.ts"]: only b.ts is staged on the next turn (a.ts stays in hydratedPaths)
			await childRoot.commit(async (tx) => {
				const stateDoc = await tx.doc(SlidingWindowStateDoc, childRoot.id);
				stateDoc.hydrate = {
					allowedPaths: ["a.ts", "b.ts"],
					hydratedPaths: stateDoc.hydrate?.hydratedPaths ?? [],
				};
			}, context);
			await (await childRoot.submit({ type: "input", content: "Now use widened b.ts" }, context)).wait(context);
			await childRoot.waitForIdle(context);
			expect(String(childSeen[2]?.tail)).toContain("export const b = 2;");
			expect(String(childSeen[2]?.tail)).not.toContain("export const a = 1;");

			await childSw.close();
			await childHarness.close(context);
			await sw.close();
			await parentHarness.close(context);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("handles legacy ledger reconstruction from entries, mid-run hard-ceiling burst fallback, BatonPrepTask epoch-mismatch fence, and MemoryStorage exportCheckpointedFork with owner='pi'", async () => {
		const mainProv = fauxProvider({
			provider: "main-e",
			models: [{ id: "m-1", contextWindow: 4_000, maxTokens: 512 }],
		});
		const slowHelper = fauxProvider({
			provider: "helper-e",
			models: [{ id: "h-1", contextWindow: 8_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(mainProv.provider);
		models.setProvider(slowHelper.provider);

		// 1. Legacy ledger reconstruction from entries (when SlidingWindowLedgerDoc & BatonStateDoc.data are empty)
		const reg0 = createRegistry();
		const swLegacy = createSlidingWindow();
		const routedLegacy = swLegacy.wrapModels(models);
		const regLegacy = createRegistry();
		regLegacy.install(swLegacy.extension);
		const dir = mkdtempSync(join(tmpdir(), "sw-legacy-"));
		const legacyDbPath = join(dir, "legacy.sqlite");
		try {
			const s1 = await StoreStorage.open(
				await openStore(sqliteBackend(await openNodeSqliteDatabase(legacyDbPath)), context),
				"pi",
				context,
			);
			const h1 = await Harness.open(s1, { models, registry: reg0 }, context);
			const r1 = await h1.root(context, { agent: { model: swLegacy.selection } });
			const tc = fauxToolCall("read", { path: "legacy.ts" });
			await r1.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, r1.id)).target = { provider: "main-e", modelId: "m-1" };
				await tx.appendEntry(AssistantEntry, r1.id, {
					model: [fauxAssistantMessage([tc], { stopReason: "toolUse" })],
				});
				await tx.appendEntry(ToolResultEntry, r1.id, {
					data: { diagnostics: [] },
					model: [
						{
							role: "toolResult",
							toolCallId: tc.id,
							toolName: "read",
							content: [{ type: "text", text: "preview" }],
							details: { slidingWindow: { ref: "abc123def456", bytes: 999, lines: 42 } },
							isError: false,
							timestamp: 100,
						},
					],
				});
			}, context);
			await h1.close(context);

			mainProv.setResponses([fauxAssistantMessage("After legacy hydrate")]);
			const s2 = await StoreStorage.open(
				await openStore(sqliteBackend(await openNodeSqliteDatabase(legacyDbPath)), context),
				"pi",
				context,
			);
			const h2 = await Harness.open(s2, { models: routedLegacy, registry: regLegacy }, context);
			h2.resume();
			const r2 = await h2.root(context);
			await (await r2.submit({ type: "input", content: "Continue legacy" }, context)).wait(context);
			await r2.waitForIdle(context);
			expect(
				swLegacy.inspect(r2.id).ledger.filesRead.some((f) => f.path === "legacy.ts" && f.ref === "abc123def456"),
			).toBe(true);
			await swLegacy.close();
			await h2.close(context);

			// 2. Mid-run hard-ceiling burst swap (keepTail: false -> head: "self") while BatonPrepTask is in flight (epoch fence)
			let releaseHelper!: () => void;
			const helperBlocked = new Promise<void>((r) => {
				releaseHelper = r;
			});
			let helperStartedResolve!: () => void;
			const helperStarted = new Promise<void>((r) => {
				helperStartedResolve = r;
			});
			slowHelper.setResponses([
				async () => {
					helperStartedResolve();
					await helperBlocked;
					return fauxAssistantMessage("- Stale slow digest");
				},
			]);

			const pingTool = defineTool({
				name: "ping",
				description: "Ping",
				parameters: obj({ msg: str() }),
				execute: async (args) => ({ output: [{ type: "text", text: `pong:${args.msg}` }] }),
			});
			const swBurst = createSlidingWindow({
				batonModel: "helper-e/h-1",
				softCeilingTokens: 120,
				hardCeilingTokens: 260,
				keepTail: false,
			});
			const routedBurst = swBurst.wrapModels(models);
			const regBurst = createRegistry();
			regBurst.install(defineExtension({ name: "test.tools", tools: [pingTool] }));
			regBurst.install(swBurst.extension);

			mainProv.setResponses([
				() => fauxAssistantMessage([fauxToolCall("ping", { msg: "a".repeat(200) })], { stopReason: "toolUse" }),
				async () => {
					await helperStarted;
					return fauxAssistantMessage([fauxToolCall("ping", { msg: "b".repeat(800) })], { stopReason: "toolUse" });
				},
				() => fauxAssistantMessage("Burst swap mid-run finished."),
			]);

			const hBurst = await Harness.open(
				new MemoryStorage(),
				{ models: routedBurst, registry: regBurst, settings: { compaction: { enabled: false } } },
				context,
			);
			hBurst.resume();
			const rBurst = await hBurst.root(context, { agent: { model: swBurst.selection } });
			await rBurst.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, rBurst.id)).target = { provider: "main-e", modelId: "m-1" };
			}, context);
			const burstResult = await (await rBurst.submit({ type: "input", content: "Start burst test" }, context)).wait(
				context,
			);
			await rBurst.waitForIdle(context);
			expect(burstResult.status).toBe("done");

			// Release slow helper AFTER burst swap already incremented epoch to 1: UsageDoc.sidecars must record, BatonStateDoc.staged must stay undefined!
			const prepTask = (await hBurst.snapshot(BatonStateDoc, rBurst.id, context))?.preparingTaskId;
			releaseHelper();
			if (prepTask !== undefined) await hBurst.waitForTask(prepTask, context);
			// Poll briefly via waitFor until BatonPrepTask terminal commit settles
			await waitFor(async () => {
				const u = await hBurst.snapshot(UsageDoc, rBurst.id, context);
				return Boolean(u?.sidecars?.["baton:helper-e/h-1"]);
			});
			const batonAfterFence = await hBurst.snapshot(BatonStateDoc, rBurst.id, context);
			expect(batonAfterFence?.epoch).toBe(1);
			expect(batonAfterFence?.staged).toBeUndefined();

			// 3. Export to MemoryStorage with default owner="pi" (non-closing) + verify MemoryStorage stays usable
			const memExport = new MemoryStorage();
			const atBurst = (await allEntries(rBurst)).findLast((e) => AssistantEntry.is(e))!.id;
			const exportedMem = await exportCheckpointedFork(
				{
					parent: rBurst,
					parentHarness: hBurst,
					at: atBurst,
					targetStorage: memExport,
					models: routedBurst,
					registry: regBurst,
					systemPrompt: "PI owner child",
					taskPrompt: "Run child task",
				},
				context,
			);
			expect(exportedMem.conversationId).toBeDefined();
			const reopenMem = await Harness.open(memExport, { models: routedBurst, registry: regBurst }, context);
			expect((await allEntries(await reopenMem.root(context))).some((e) => SystemEntry.is(e))).toBe(true);
			await reopenMem.close(context);

			await swBurst.close();
			await hBurst.close(context);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("Caveats 1 & 2: deterministic timestamp for Message[] ephemeralTail, propagated purpose/turnIndex/state in onOutcome, and zero-call toolUse flush", async () => {
		const fastProv = fauxProvider({
			provider: "fast-c12",
			models: [{ id: "f-1", contextWindow: 32_000, maxTokens: 512 }],
		});
		const models = createModels();
		models.setProvider(fastProv.provider);

		let currentFakeNow = 50_000;
		const seenTailTimestamps: number[] = [];
		const recordedOutcomes: Array<{ purpose: string; turnIndex: number; routedCount?: number }> = [];
		const nowSpy = vi.spyOn(Date, "now");
		const innerDef = {
			provider: "router-c12",
			id: "inner",
			name: "Inner",
			route(req: { state?: unknown; purpose: string }) {
				if (req.purpose === "continuation") {
					nowSpy.mockReturnValue(currentFakeNow);
				}
				const prev = (req.state as { routedCount?: number } | undefined)?.routedCount ?? 0;
				return {
					model: models.getModel("fast-c12", "f-1")!,
					thinkingLevel: "off" as const,
					state: { routedCount: prev + 1 },
					ephemeralTail: [{ role: "user" as const, content: "inner-tail", timestamp: 42_000 }],
				};
			},
			onOutcome(outcome: { purpose: string; turnIndex: number; state?: unknown }) {
				const routedCount = (outcome.state as { routedCount?: number } | undefined)?.routedCount;
				recordedOutcomes.push({ purpose: outcome.purpose, turnIndex: outcome.turnIndex, routedCount });
				return { routedCount, recorded: recordedOutcomes.length };
			},
		};

		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async (args) => ({
				output: [
					{
						type: "text",
						text: Array.from({ length: 120 }, (_, i) => `${args.path}:line_${i + 1}`).join("\n"),
					},
				],
			}),
		});

		const runOnce = async (fakeNow: number) => {
			currentFakeNow = fakeNow;
			nowSpy.mockReturnValue(50_000);
			try {
				const sw = createSlidingWindow({ readSpillThresholdBytes: 128, stageReadSlices: true });
				const routed = withVirtualModelRouting(models, { models: [innerDef] });
				sw.wrapModels(routed);
				const reg = createRegistry();
				reg.install(defineExtension({ name: "test.read", tools: [readTool] }));
				reg.install(sw.extension);

				fastProv.setResponses([
					() =>
						fauxAssistantMessage([fauxToolCall("read", { path: "big.ts" })], {
							stopReason: "toolUse",
							timestamp: 88_000,
						}),
					(ctx) => {
						const tailMsg = ctx.messages.at(-1);
						if (tailMsg) seenTailTimestamps.push(tailMsg.timestamp);
						// Zero-call toolUse must still flush c.pendingCompletion in afterResponse.
						return fauxAssistantMessage([{ type: "text", text: "zero-call done" }], {
							stopReason: "toolUse",
							timestamp: 89_000,
						});
					},
				]);

				const harness = await Harness.open(new MemoryStorage(), { models: routed, registry: reg }, context);
				harness.resume();
				const root = await harness.root(context, { agent: { model: sw.selection } });
				await root.commit(async (tx) => {
					(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "router-c12", modelId: "inner" };
				}, context);
				await (await root.submit({ type: "input", content: "Inspect big.ts" }, context)).wait(context);
				await root.waitForIdle(context);
				await sw.close();
				await harness.close(context);
			} finally {
				nowSpy.mockReset();
			}
		};

		try {
			await runOnce(1_111_000);
			await runOnce(9_999_000);
		} finally {
			nowSpy.mockRestore();
		}

		expect(seenTailTimestamps).toEqual([50_000, 50_000]);
		expect(recordedOutcomes).toEqual([
			{ purpose: "prompt", turnIndex: 0, routedCount: 1 },
			{ purpose: "continuation", turnIndex: 1, routedCount: 2 },
			{ purpose: "prompt", turnIndex: 0, routedCount: 1 },
			{ purpose: "continuation", turnIndex: 1, routedCount: 2 },
		]);
	});

	it("Caveat 3: reads parentStorage docs asOf atSeq while reading ProviderDoc at current with sourceConvId fallback, and avoids Date.now() on empty views", async () => {
		const fastProv = fauxProvider({
			provider: "fast-c3",
			models: [{ id: "f-1", contextWindow: 16_000, maxTokens: 512 }],
		});
		const strongProv = fauxProvider({
			provider: "strong-c3",
			models: [{ id: "s-1", contextWindow: 32_000, maxTokens: 1024 }],
		});
		const models = createModels();
		models.setProvider(fastProv.provider);
		models.setProvider(strongProv.provider);

		const readTool = defineTool({
			name: "read",
			description: "Read",
			parameters: obj({ path: str() }),
			execute: async (args) => ({ output: [{ type: "text", text: `content:${args.path}` }] }),
		});
		const checkTool = defineTool({
			name: "check",
			description: "Check",
			parameters: obj({}),
			execute: async () => ({ output: [{ type: "text", text: "ok" }] }),
		});

		const dir = mkdtempSync(join(tmpdir(), "sw-c3-"));
		try {
			const parentDb = await openNodeSqliteDatabase(join(dir, "parent.sqlite"));
			const parentStorage = await StoreStorage.open(
				await openStore(sqliteBackend(parentDb), context),
				"pi",
				context,
			);
			const sw = createSlidingWindow({ cwd: dir });
			const routed = sw.wrapModels(models);
			const reg = createRegistry();
			reg.install(defineExtension({ name: "test.c3", tools: [readTool, checkTool] }));
			reg.install(sw.extension);

			fastProv.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" })], {
					stopReason: "toolUse",
					timestamp: 50_000,
				}),
				fauxAssistantMessage("read a.ts", { timestamp: 51_000 }),
				fauxAssistantMessage([fauxToolCall("read", { path: "b.ts" })], {
					stopReason: "toolUse",
					timestamp: 60_000,
				}),
				fauxAssistantMessage("read b.ts", { timestamp: 61_000 }),
			]);

			const parentHarness = await Harness.open(parentStorage, { models: routed, registry: reg }, context);
			parentHarness.resume();
			const root = await parentHarness.root(context, {
				agent: {
					model: sw.selection,
					tools: [readTool, checkTool],
					thinkingLevel: "medium",
					cwd: dir,
				},
			});
			await root.commit(async (tx) => {
				(await tx.doc(SlidingWindowTargetDoc, root.id)).target = { provider: "fast-c3", modelId: "f-1" };
				(await tx.doc(ProviderDoc, root.id)).sessionId = "sess-root-123";
			}, context);

			await (await root.submit({ type: "input", content: "Read a" }, context)).wait(context);
			await root.waitForIdle(context);
			const atEntry = (await allEntries(root)).findLast((e) => AssistantEntry.is(e))!.id;

			// Mutate root AFTER atEntry (more reads + narrowed tools + downgraded thinkingLevel)
			await root.commit(async (tx) => {
				const agentDoc = await tx.doc(AgentDoc, root.id);
				agentDoc.tools = ["read"];
				agentDoc.thinkingLevel = "off";
			}, context);
			await (await root.submit({ type: "input", content: "Read b" }, context)).wait(context);
			await root.waitForIdle(context);

			// Create a multi-level fork from atEntry whose own ProviderDoc.sessionId is unset (sourceConvId is root.id)
			const midFork = await root.fork(atEntry, { ownership: { kind: "ownerless" } }, context);
			await midFork.commit(async (tx) => {
				delete ((await tx.doc(ProviderDoc, midFork.id)) as { sessionId?: string }).sessionId;
			}, context);

			const targetStorage1 = new MemoryStorage();
			const exportedFromRoot = await exportCheckpointedFork(
				{
					parent: root,
					parentHarness,
					parentStorage,
					at: atEntry,
					targetStorage: targetStorage1,
					models: routed,
					registry: reg,
					systemPrompt: "Child sys",
					taskPrompt: "Child task",
				},
				context,
			);
			expect(exportedFromRoot.ledger.filesRead.map((f) => f.path)).toEqual(["a.ts"]);

			const reopened1 = await Harness.open(targetStorage1, { models: routed, registry: reg }, context);
			const childRoot1 = await reopened1.root(context);
			expect((await reopened1.snapshot(ProviderDoc, childRoot1.id, context))?.sessionId).toBe("sess-root-123");
			expect((await reopened1.snapshot(AgentDoc, childRoot1.id, context))?.tools).toEqual(["read", "check"]);
			expect((await reopened1.snapshot(AgentDoc, childRoot1.id, context))?.thinkingLevel).toBe("medium");
			await reopened1.close(context);

			// Multi-level fork export: midFork has no ProviderDoc.sessionId, so it falls back to sourceConvId (root.id)
			const targetStorage2 = new MemoryStorage();
			await exportCheckpointedFork(
				{
					parent: midFork,
					parentHarness,
					parentStorage,
					at: atEntry,
					targetStorage: targetStorage2,
					models: routed,
					registry: reg,
					systemPrompt: "Child sys 2",
					taskPrompt: "Child task 2",
				},
				context,
			);
			const reopened2 = await Harness.open(targetStorage2, { models: routed, registry: reg }, context);
			const childRoot2 = await reopened2.root(context);
			expect((await reopened2.snapshot(ProviderDoc, childRoot2.id, context))?.sessionId).toBe("sess-root-123");
			await reopened2.close(context);

			// Empty / timestamp-less view falls back to deterministic 0 (never Date.now())
			const emptyStorage = new MemoryStorage();
			const emptyHarness = await Harness.open(emptyStorage, { models: routed, registry: reg }, context);
			const emptyRoot = await emptyHarness.root(context);
			let emptyEntryId!: Awaited<ReturnType<typeof allEntries>>[number]["id"];
			await emptyRoot.commit(async (tx) => {
				emptyEntryId = (await tx.appendEntry(ResetEntry, emptyRoot.id, { head: "self", model: [] })).id;
			}, context);

			const spy1 = vi.spyOn(Date, "now").mockReturnValue(1_234_567);
			const emptyRes1 = await exportCheckpointedFork(
				{
					parent: emptyRoot,
					parentStorage: emptyStorage,
					at: emptyEntryId,
					targetStorage: new MemoryStorage(),
					models: routed,
					registry: reg,
					systemPrompt: "Empty",
					taskPrompt: "Empty task",
				},
				context,
			);
			spy1.mockRestore();

			const spy2 = vi.spyOn(Date, "now").mockReturnValue(7_654_321);
			const emptyRes2 = await exportCheckpointedFork(
				{
					parent: emptyRoot,
					parentStorage: emptyStorage,
					at: emptyEntryId,
					targetStorage: new MemoryStorage(),
					models: routed,
					registry: reg,
					systemPrompt: "Empty",
					taskPrompt: "Empty task",
				},
				context,
			);
			spy2.mockRestore();
			await emptyHarness.close(context);

			expect(emptyRes1.anchorTimestamp).toBe(0);
			expect(emptyRes1.atTimestamp).toBe(0);
			expect(emptyRes2.anchorTimestamp).toBe(0);
			expect(emptyRes2.atTimestamp).toBe(0);

			await sw.close();
			await parentHarness.close(context);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
