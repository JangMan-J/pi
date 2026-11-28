import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import {
	CheckpointLineageDoc,
	createEmptyLedger,
	createSlidingWindow,
	recordToolResult,
} from "@earendil-works/pi-virtual-models/sliding-window";
import { openNodeSlidingWindowArtifactStore } from "@earendil-works/pi-virtual-models/sliding-window/node";
import { describe, expect, it } from "vitest";

describe("sliding-window recall cwd", () => {
	it("routes sliding-window through ./assembler.ts without pi-durable sliding-window bridge", () => {
		const indexSource = readFileSync(
			fileURLToPath(new URL("../src/sliding-window/index.ts", import.meta.url)),
			"utf8",
		);
		expect(indexSource).not.toMatch(/@earendil-works\/pi-durable\/sliding-window/);
		expect(indexSource).toMatch(/\.\/assembler\.ts/);
	});

	it("uses AgentDoc.cwd over options.cwd and without options.cwd for live stale-source detection", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "sw-recall-agent-"));
		const launchDir = mkdtempSync(join(tmpdir(), "sw-recall-launch-"));
		try {
			for (const optionCwd of [launchDir, undefined]) {
				const sourcePath = join(agentDir, "source.txt");
				writeFileSync(sourcePath, "original snapshot\n", "utf8");
				writeFileSync(join(launchDir, "source.txt"), "original snapshot\n", "utf8");
				const store = openNodeSlidingWindowArtifactStore(":memory:");
				const meta = store.put("original snapshot\n", {
					toolName: "read",
					sourcePath: "source.txt",
					cwd: agentDir,
				});
				writeFileSync(sourcePath, "changed live source\n", "utf8");

				const sw = createSlidingWindow({
					...(optionCwd !== undefined ? { cwd: optionCwd } : {}),
					artifactStore: store,
				});
				try {
					const api = {
						conversationId: 1 as ConversationId,
						snapshot: async () => ({ cwd: agentDir }),
					} as unknown as ToolExecutionApi;
					const result = await sw.recallTool.execute({ ref: meta.ref }, api, context);
					expect(result).toEqual({
						output: [{ type: "text", text: expect.stringContaining("stale snapshot") }],
					});
					expect(result).toEqual({
						output: [{ type: "text", text: expect.stringContaining(sourcePath) }],
					});
				} finally {
					await sw.close();
				}
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(launchDir, { recursive: true, force: true });
		}
	});
});

describe("MechanicalLedger retention", () => {
	it("retains 256 reads, 256 edits, and 128 refs before evicting the oldest", () => {
		let ledger = createEmptyLedger();
		for (let i = 0; i < 257; i++) {
			ledger = recordToolResult(ledger, "read", { path: `read-${i}.ts` }, { isError: false });
		}
		expect(ledger.filesRead).toHaveLength(256);
		expect(ledger.filesRead[0]?.path).toBe("read-1.ts");
		expect(ledger.filesRead.at(-1)?.path).toBe("read-256.ts");

		for (let i = 0; i < 257; i++) {
			ledger = recordToolResult(ledger, "edit", { path: `edit-${i}.ts` }, { isError: false });
		}
		expect(ledger.filesEdited).toHaveLength(256);
		expect(ledger.filesEdited[0]?.path).toBe("edit-1.ts");
		expect(ledger.filesEdited.at(-1)?.path).toBe("edit-256.ts");

		for (let i = 0; i < 129; i++) {
			ledger = recordToolResult(ledger, "bash", undefined, {
				isError: false,
				spilled: {
					ref: `ref-${i}`,
					sha256: `sha-${i}`,
					toolName: "bash",
					byteLen: 1,
					lineCount: 1,
					createdAtMs: i,
				},
			});
		}
		expect(ledger.recentRefs).toHaveLength(128);
		expect(ledger.recentRefs[0]?.ref).toBe("ref-1");
		expect(ledger.recentRefs.at(-1)?.ref).toBe("ref-128");
	});
});

describe("CheckpointLineageDoc", () => {
	it("is conversation-scoped and starts empty", () => {
		expect(CheckpointLineageDoc.definition.scope).toBe("conversation");
		expect(CheckpointLineageDoc.definition.initial()).toEqual({});
	});
});
