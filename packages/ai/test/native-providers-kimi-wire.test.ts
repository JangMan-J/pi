import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { ModelThinkingLevel } from "../src/types.ts";

const mockState = vi.hoisted(() => ({ lastParams: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					promise.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

type Params = Record<string, unknown>;

async function capture(modelId: string, reasoning?: ModelThinkingLevel, sessionId = "abc-123"): Promise<Params> {
	const model = getModel("kimi-coding", modelId as never)!;
	let payload: unknown;
	await streamSimple(
		model,
		{ systemPrompt: "Follow instructions.", messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
			sessionId,
			...(reasoning && reasoning !== "off" ? { reasoning } : {}),
			onPayload: (params: unknown) => {
				payload = params;
			},
		},
	).result();
	return (payload ?? mockState.lastParams) as Params;
}

describe("Kimi Coding K3.1 wire shape", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends the Kimi Code client's thinking object instead of reasoning_effort", async () => {
		const params = await capture("k3.1-pro-highspeed", "high");
		expect(params.thinking).toEqual({ type: "enabled", effort: "high", keep: "all" });
		expect(params).not.toHaveProperty("reasoning_effort");
	});

	it("maps every pi thinking level to a supported Kimi effort", async () => {
		const efforts: Record<string, unknown> = {};
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			efforts[level] = (
				(await capture("k3.1-pro-highspeed", level)).thinking as { effort?: string } | undefined
			)?.effort;
		}
		expect(efforts).toEqual({
			minimal: "low",
			low: "low",
			medium: "high",
			high: "high",
			xhigh: "max",
			max: "max",
		});
	});

	it("uses max_completion_tokens bounded by the remaining context, not 131072", async () => {
		const params = await capture("k3.1-pro-highspeed", "high");
		expect(params).not.toHaveProperty("max_tokens");
		const cap = params.max_completion_tokens as number;
		expect(cap).toBeGreaterThan(1_000_000);
		expect(cap).toBeLessThan(1_048_576);
	});

	it("sends the session id as prompt_cache_key", async () => {
		expect((await capture("k3.1-pro-highspeed", "high", "session-xyz")).prompt_cache_key).toBe("session-xyz");
	});

	it("leaves kimi-for-coding-highspeed on its own dialect", async () => {
		const params = await capture("kimi-for-coding-highspeed", "high");
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.max_tokens).toBe(32768);
		expect(params).not.toHaveProperty("max_completion_tokens");
		expect(params.prompt_cache_key).toBeUndefined();
	});
});
