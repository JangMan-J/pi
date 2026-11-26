import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { exportCheckpointedFork } from "@earendil-works/pi-virtual-models/sliding-window/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-vm-node-fork-export-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("node exportCheckpointedFork (SqliteStorage)", () => {
	it("exports a checkpointed fork into SqliteStorage with tablePrefix and wal_checkpoint(TRUNCATE)", async () => {
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m1", contextWindow: 64_000, maxTokens: 1024 }],
		});
		faux.setResponses([() => fauxAssistantMessage("parent reply")]);

		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const parentStorage = new MemoryStorage();
		const harness = await Harness.open(parentStorage, { models, registry }, context);

		try {
			const parent = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "m1" }, cwd: tempDir },
			});
			const sub = await parent.submit({ type: "input", content: "hello parent" }, context);
			expect((await sub.wait(context)).status).toBe("done");

			const entries = (await parent.entries({ order: "ascending" }, 20, undefined, context)).items;
			const at = entries.at(-1)!.id;
			const targetDbPath = join(tempDir, "exported-fork.sqlite");

			// Spread extra property so `tsc --noEmit` compiles on base before `tablePrefix` is added to the type.
			const extra = { tablePrefix: "cellar_" };
			const exported = await exportCheckpointedFork(
				{
					parent,
					parentHarness: harness,
					parentStorage,
					at,
					targetDbPath,
					models,
					registry,
					systemPrompt: "Child system instructions",
					taskPrompt: "Execute scoped child task",
					dispatchSummary: "Seeded from checkpoint",
					...extra,
				},
				context,
			);

			expect(exported.conversationId).toBeDefined();

			// Verify wal_checkpoint(TRUNCATE) left no uncheckpointed WAL bytes.
			const walPath = `${targetDbPath}-wal`;
			if (existsSync(walPath)) {
				expect(statSync(walPath).size).toBe(0);
			}

			// Verify SqliteStorage created prefixed tables (`cellar_*`) instead of StoreStorage tables.
			const rawDb = new DatabaseSync(targetDbPath, { readOnly: true });
			try {
				const tables = rawDb
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
					.all() as Array<{ name: string }>;
				const names = tables.map((t) => t.name);
				expect(names).toContain("cellar_conversations");
				expect(names).toContain("cellar_entries");
				expect(names).toContain("cellar_documents");
			} finally {
				rawDb.close();
			}

			// Reopen with SqliteStorage + Harness to confirm exported fork is immediately readable.
			const reopenDb = await openNodeSqliteDatabase(targetDbPath);
			const reopenStorage = await SqliteStorage.open(reopenDb, { prefix: "cellar_" });
			const childHarness = await Harness.open(reopenStorage, { models, registry }, context);
			try {
				const root = await childHarness.root(context);
				const childView = await root.context(context);
				expect(
					childView.messages.some(
						(m) => m.role === "user" && String(m.content).includes("Execute scoped child task"),
					),
				).toBe(true);
				expect((await root.agent(context)).instructions).toBe("Child system instructions");
			} finally {
				await childHarness.close(context);
			}
		} finally {
			await harness.close(context);
		}
	});

	it("exports into an explicit caller-supplied SqliteStorage without closing it", async () => {
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m1", contextWindow: 64_000, maxTokens: 1024 }],
		});
		faux.setResponses([() => fauxAssistantMessage("parent ok")]);

		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const parentStorage = new MemoryStorage();
		const harness = await Harness.open(parentStorage, { models, registry }, context);

		const targetDb = await openNodeSqliteDatabase(":memory:");
		const targetStorage = await SqliteStorage.open(targetDb);

		try {
			const parent = await harness.root(context, {
				agent: { model: { provider: "faux", modelId: "m1" } },
			});
			const sub = await parent.submit({ type: "input", content: "hi" }, context);
			await sub.wait(context);
			const entries = (await parent.entries({ order: "ascending" }, 20, undefined, context)).items;

			const exported = await exportCheckpointedFork(
				{
					parent,
					parentHarness: harness,
					parentStorage,
					at: entries.at(-1)!.id,
					targetStorage,
					closeTargetStorage: false,
					models,
					registry,
					systemPrompt: "Direct storage",
					taskPrompt: "Run direct",
				},
				context,
			);

			// Storage must still be open for reading.
			const scan = await targetStorage.scanEntries(
				{ conversationId: exported.conversationId, order: "ascending" },
				10,
				undefined,
				context,
			);
			expect(scan.items.length).toBeGreaterThanOrEqual(3);
		} finally {
			await targetStorage.close(context);
			await harness.close(context);
		}
	});
});
