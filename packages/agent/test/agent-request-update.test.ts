import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig } from "../src/types.ts";

describe("prepareRequest per-request overrides", () => {
	it("applies requestOptions and streamFn only to the prepared request without leaking to later turns", async () => {
		const faux = fauxProvider({ models: [{ id: "m1", maxTokens: 4096 }] });
		const model = faux.getModel("m1")!;
		const seenOptions: Array<{ maxTokens?: number; temperature?: number }> = [];
		const usedOverrideStream: boolean[] = [];

		let turn = 0;
		const context: AgentContext = {
			messages: [],
			tools: [
				{
					name: "ping",
					label: "Ping",
					description: "Ping",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "pong" }], details: {} }),
				},
			],
		};

		const defaultStream: Parameters<typeof runAgentLoop>[5] = (_m, _ctx, opts) => {
			usedOverrideStream.push(false);
			seenOptions.push({ maxTokens: opts?.maxTokens, temperature: opts?.temperature });
			const stream = createAssistantMessageEventStream();
			const msg = fauxAssistantMessage("done");
			stream.push({ type: "done", reason: "stop", message: msg });
			stream.end(msg);
			return stream;
		};

		const config: AgentLoopConfig = {
			model,
			convertToLlm: (msgs) =>
				msgs.filter(
					(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
				),
			prepareRequest: () => {
				if (turn++ === 0) {
					return {
						requestOptions: { maxTokens: 128, temperature: 0.2 },
						streamFn: (_m, _ctx, opts) => {
							usedOverrideStream.push(true);
							seenOptions.push({ maxTokens: opts?.maxTokens, temperature: opts?.temperature });
							const stream = createAssistantMessageEventStream();
							const msg = fauxAssistantMessage(fauxToolCall("ping", {}), { stopReason: "toolUse" });
							stream.push({ type: "done", reason: "toolUse", message: msg });
							stream.end(msg);
							return stream;
						},
					};
				}
				return undefined;
			},
		};

		await runAgentLoop(
			[{ role: "user", content: "go", timestamp: 1 }],
			context,
			config,
			() => {},
			undefined,
			defaultStream,
		);

		expect(usedOverrideStream).toEqual([true, false]);
		expect(seenOptions).toEqual([
			{ maxTokens: 128, temperature: 0.2 },
			{ maxTokens: undefined, temperature: undefined },
		]);
	});
});
