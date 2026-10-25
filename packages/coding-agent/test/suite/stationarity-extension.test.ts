import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import stationarity, { STATIONARITY_REMINDER } from "../../examples/extensions/stationarity.ts";
import { createHarness, type Harness } from "./harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it("persists one stationarity user message before continuation and keeps it in later input", async () => {
	const tool: AgentTool = {
		name: "read",
		label: "Read",
		description: "Read",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "same data" }], details: {} }),
	};
	harness = await createHarness({ tools: [tool], extensionFactories: [stationarity] });
	const observed: unknown[][] = [];
	harness.setResponses([
		...Array.from({ length: 4 }, () =>
			fauxAssistantMessage(fauxToolCall("read", { path: "a" }), { stopReason: "toolUse" }),
		),
		(context) => {
			observed.push(context.messages);
			return fauxAssistantMessage(fauxToolCall("read", { path: "a" }), { stopReason: "toolUse" });
		},
		(context) => {
			observed.push(context.messages);
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("Read");
	const reminder = { role: "user", content: expect.arrayContaining([{ type: "text", text: STATIONARITY_REMINDER }]) };
	for (const messages of observed) expect(messages).toContainEqual(expect.objectContaining(reminder));
	const entries = harness.sessionManager
		.getEntries()
		.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes(STATIONARITY_REMINDER),
		);
	expect(entries).toHaveLength(1);
	expect(harness.faux.state.callCount).toBe(6);
});
