import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { executeRoutedStream } from "../src/core/route-exec.ts";
import type {
	ModelRoute,
	ModelRouteRequest,
	RoutedStreamCompletion,
	VirtualModelDefinition,
} from "../src/core/types.ts";
import { EMPTY_ROUTE_CACHE_SNAPSHOT } from "../src/core/types.ts";

const ROUTE_EXEC_SOURCE = fileURLToPath(new URL("../src/core/route-exec.ts", import.meta.url));

const fast = fauxProvider({
	provider: "fast-prov",
	models: [{ id: "fast-1", contextWindow: 16_000, maxTokens: 1000 }],
});
const slow = fauxProvider({
	provider: "slow-prov",
	models: [{ id: "slow-1", contextWindow: 16_000, maxTokens: 1000 }],
});
const deep = fauxProvider({
	provider: "deep-prov",
	models: [{ id: "deep-1", contextWindow: 16_000, maxTokens: 1000 }],
});
const FAST = fast.getModel() as Model<Api>;
const SLOW = slow.getModel() as Model<Api>;
const DEEP = deep.getModel() as Model<Api>;
const MODELS = [FAST, SLOW, DEEP];

const CONTEXT = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as unknown as TranscriptContext;

const PAID_USAGE: Usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

function stamp(model: Model<Api>, message: AssistantMessage): AssistantMessage {
	return { ...message, api: model.api, provider: model.provider, model: model.id };
}

function reply(model: Model<Api>, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return { ...stamp(model, fauxAssistantMessage(text)), ...extra };
}

/** Emit start, text, done for `message` after `delayMs`, unless `signal` aborts first. */
function scriptedStream(message: AssistantMessage, delayMs: number, signal?: AbortSignal): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const empty: AssistantMessage = { ...message, content: [] };
	stream.push({ type: "start", partial: empty });
	let settled = false;
	const settle = (event: AssistantMessageEvent, final: AssistantMessage) => {
		if (settled) return;
		settled = true;
		stream.push(event);
		stream.end(final);
	};
	const timer = setTimeout(() => {
		if (message.stopReason === "error") {
			settle({ type: "error", reason: "error", error: message }, message);
			return;
		}
		stream.push({ type: "text_start", contentIndex: 0, partial: message });
		settle({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }, message);
	}, delayMs);
	signal?.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			const aborted = { ...message, content: [], stopReason: "aborted" as const };
			settle({ type: "error", reason: "aborted", error: aborted }, aborted);
		},
		{ once: true },
	);
	return stream;
}

/** Dispatcher that never emits content and only ends when its signal aborts. */
function hangingStream(model: Model<Api>, signal?: AbortSignal): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...reply(model, ""), content: [] } });
	signal?.addEventListener(
		"abort",
		() => {
			const aborted = { ...reply(model, ""), content: [], stopReason: "aborted" as const };
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
		},
		{ once: true },
	);
	return stream;
}

interface DispatchCall {
	model: Model<Api>;
	options?: SimpleStreamOptions;
	signal?: AbortSignal;
}

type Behavior = (model: Model<Api>, signal?: AbortSignal) => AssistantMessageEventStream;

function makeHarness(behaviors: Record<string, Behavior>) {
	const calls: DispatchCall[] = [];
	const sidecar: Array<{ kind: string; provider: string; modelId: string; note?: string }> = [];
	const committed: ModelRoute[] = [];
	const completions: RoutedStreamCompletion[] = [];
	const states: unknown[] = [];
	const resolved: string[] = [];
	return {
		calls,
		sidecar,
		committed,
		completions,
		states,
		resolved,
		params: {
			dispatchPhysical: (model: Model<Api>, _context: TranscriptContext, options?: SimpleStreamOptions) => {
				calls.push({ model, options, signal: options?.signal });
				const behavior = behaviors[model.id];
				if (!behavior) throw new Error(`no behavior for ${model.id}`);
				return behavior(model, options?.signal);
			},
			resolvePhysicalModel: (provider: string, modelId: string) => {
				resolved.push(`${provider}/${modelId}`);
				const found = MODELS.find((m) => m.provider === provider && m.id === modelId);
				if (!found) throw new Error(`unknown model ${provider}/${modelId}`);
				return found;
			},
			recordSidecarUsage: (kind: string, provider: string, modelId: string, _usage: Usage, note?: string) => {
				sidecar.push({ kind, provider, modelId, note });
			},
			onCommitRoute: (route: ModelRoute) => {
				committed.push(route);
			},
			onUpdateState: (state: unknown) => {
				states.push(state);
			},
			onComplete: (completion: RoutedStreamCompletion) => {
				completions.push(completion);
			},
		},
	};
}

const DEFINITION: VirtualModelDefinition = {
	provider: "router",
	id: "auto",
	name: "Auto",
	route: () => ({ model: FAST, thinkingLevel: "off" }),
};

function makeRequest(): ModelRouteRequest {
	return {
		model: FAST,
		thinkingLevel: "off",
		reason: "user",
		purpose: "prompt",
		turnIndex: 3,
		cache: EMPTY_ROUTE_CACHE_SNAPSHOT,
		messages: CONTEXT.messages,
	};
}

async function run(
	harness: ReturnType<typeof makeHarness>,
	route: ModelRoute,
	definition: VirtualModelDefinition = DEFINITION,
) {
	const stream = executeRoutedStream({
		definition,
		request: makeRequest(),
		initialRoute: route,
		context: CONTEXT,
		...harness.params,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	return { events, message };
}

describe("route-exec: single dispatch", () => {
	it("streams a physical reply and reports timing, route, purpose, and turn to onComplete", async () => {
		const harness = makeHarness({ "fast-1": (m, s) => scriptedStream(reply(m, "hello"), 5, s) });
		const route: ModelRoute = { model: FAST, thinkingLevel: "off" };
		const { events, message } = await run(harness, route);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "done"]);
		expect(harness.completions).toHaveLength(1);
		const [completion] = harness.completions;
		expect(completion?.purpose).toBe("prompt");
		expect(completion?.turnIndex).toBe(3);
		expect(completion?.route.model.id).toBe("fast-1");
		expect(completion?.durationMs).toBeGreaterThanOrEqual(completion?.ttfbMs ?? Number.POSITIVE_INFINITY);
		expect(harness.resolved).toContain("fast-prov/fast-1");
	});

	it("applies route maxTokens capped to the model limit when dispatching", async () => {
		const harness = makeHarness({ "fast-1": (m, s) => scriptedStream(reply(m, "ok"), 0, s) });
		await run(harness, { model: FAST, thinkingLevel: "off", maxTokens: 50_000, temperature: 0.25 });
		expect(harness.calls[0]?.options?.maxTokens).toBe(1000);
		expect(harness.calls[0]?.options?.temperature).toBe(0.25);
	});

	it("turns a dispatcher throw into an error message instead of rejecting", async () => {
		const harness = makeHarness({});
		const { message } = await run(harness, { model: FAST, thinkingLevel: "off" });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("no behavior for fast-1");
		expect(harness.completions[0]?.message.stopReason).toBe("error");
	});
});

describe("route-exec: timed first-token timeout", () => {
	it("aborts a silent physical stream after ttfbTimeoutMs and surfaces a timeout error", async () => {
		const harness = makeHarness({ "fast-1": (m, s) => hangingStream(m, s) });
		const { events, message } = await run(harness, { model: FAST, thinkingLevel: "off", ttfbTimeoutMs: 25 });

		expect(harness.calls[0]?.signal?.aborted).toBe(true);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Request timed out waiting for first token after 25ms");
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		expect(events.some((e) => e.type === "error" && e.reason === "aborted")).toBe(false);
	});

	it("does not time out once the first content event arrives", async () => {
		const harness = makeHarness({ "fast-1": (m, s) => scriptedStream(reply(m, "in time"), 5, s) });
		const { message } = await run(harness, { model: FAST, thinkingLevel: "off", ttfbTimeoutMs: 200 });
		expect(message.stopReason).toBe("stop");
		expect(harness.calls[0]?.signal?.aborted).toBe(false);
	});
});

describe("route-exec: hedged routes", () => {
	it("launches the hedge after afterMs, commits the winner, and aborts the slow primary", async () => {
		const harness = makeHarness({
			"slow-1": (m, s) => hangingStream(m, s),
			"fast-1": (m, s) => scriptedStream(reply(m, "hedge wins"), 5, s),
		});
		const { message } = await run(harness, {
			model: SLOW,
			thinkingLevel: "off",
			hedge: { afterMs: 20, model: FAST },
		});

		expect(message.content).toEqual([{ type: "text", text: "hedge wins" }]);
		expect(message.model).toBe("fast-1");
		expect(harness.committed.map((r) => r.model.id)).toEqual(["fast-1"]);
		expect(harness.committed[0]?.disableContinuation).toBe(true);
		expect(harness.committed[0]?.hedge).toBeUndefined();
		const primary = harness.calls.find((c) => c.model.id === "slow-1");
		const hedge = harness.calls.find((c) => c.model.id === "fast-1");
		expect(primary?.signal?.aborted).toBe(true);
		expect(hedge?.options?.disableContinuation).toBe(true);
		expect(harness.completions[0]?.route.model.id).toBe("fast-1");
	});

	it("never launches the hedge when the primary produces content first", async () => {
		const harness = makeHarness({
			"slow-1": (m, s) => scriptedStream(reply(m, "primary"), 5, s),
			"fast-1": (m, s) => scriptedStream(reply(m, "hedge"), 5, s),
		});
		const { message } = await run(harness, {
			model: SLOW,
			thinkingLevel: "off",
			hedge: { afterMs: 150, model: FAST },
		});
		expect(message.model).toBe("slow-1");
		expect(harness.calls.map((c) => c.model.id)).toEqual(["slow-1"]);
		expect(harness.committed.map((r) => r.model.id)).toEqual(["slow-1"]);
	});

	it("launches the hedge immediately when the primary fails before afterMs", async () => {
		const failed = (m: Model<Api>, s?: AbortSignal) =>
			scriptedStream(reply(m, "", { stopReason: "error", errorMessage: "boom" }), 0, s);
		const harness = makeHarness({
			"slow-1": failed,
			"fast-1": (m, s) => scriptedStream(reply(m, "recovered"), 5, s),
		});
		const startedAt = Date.now();
		const { message } = await run(harness, {
			model: SLOW,
			thinkingLevel: "off",
			hedge: { afterMs: 5_000, model: FAST },
		});
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(message.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("reports the primary error and records failed-hedge usage when both contenders fail", async () => {
		const failed = (label: string, usage: Usage) => (m: Model<Api>, s?: AbortSignal) =>
			scriptedStream(reply(m, "", { stopReason: "error", errorMessage: label, usage }), 0, s);
		const harness = makeHarness({
			"slow-1": failed("primary failed", PAID_USAGE),
			"fast-1": failed("hedge failed", PAID_USAGE),
		});
		const { message } = await run(harness, {
			model: SLOW,
			thinkingLevel: "off",
			hedge: { afterMs: 0, model: FAST },
		});
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("primary failed");
		expect(harness.sidecar).toEqual([
			{ kind: "hedge", provider: "fast-prov", modelId: "fast-1", note: "failed hedge" },
		]);
	});
});

describe("route-exec: validated routes", () => {
	it("replays the buffered draft when validation accepts and forwards state", async () => {
		const harness = makeHarness({ "fast-1": (m, s) => scriptedStream(reply(m, "draft ok"), 5, s) });
		const { events, message } = await run(harness, {
			model: FAST,
			thinkingLevel: "off",
			validate: () => ({ action: "accept", state: { checked: true } }),
		});
		expect(message.content).toEqual([{ type: "text", text: "draft ok" }]);
		expect(events.map((e) => e.type)).toEqual(["start", "text_start", "done"]);
		expect(harness.states).toEqual([{ checked: true }]);
		expect(harness.calls.map((c) => c.model.id)).toEqual(["fast-1"]);
		expect(harness.sidecar).toEqual([]);
	});

	it("escalates a rejected draft to the target model, hides the draft, and bills it as sidecar usage", async () => {
		const harness = makeHarness({
			"fast-1": (m, s) => scriptedStream(reply(m, "weak draft", { usage: PAID_USAGE }), 5, s),
			"deep-1": (m, s) => scriptedStream(reply(m, "deep answer"), 5, s),
		});
		const { events, message } = await run(harness, {
			model: FAST,
			thinkingLevel: "off",
			validate: () => ({
				action: "escalate",
				model: DEEP,
				maxTokens: 400,
				ephemeralTail: "be thorough",
				state: "escalated",
			}),
		});

		expect(message.model).toBe("deep-1");
		expect(message.content).toEqual([{ type: "text", text: "deep answer" }]);
		const texts = events.flatMap((e) => (e.type === "text_start" ? [e.partial.content] : []));
		expect(JSON.stringify(texts)).not.toContain("weak draft");
		expect(harness.sidecar).toEqual([
			{ kind: "draft", provider: "fast-prov", modelId: "fast-1", note: "escalated draft" },
		]);
		expect(harness.states).toEqual(["escalated"]);
		expect(harness.resolved).toContain("deep-prov/deep-1");
		const escalated = harness.committed.at(-1);
		expect(escalated?.model.id).toBe("deep-1");
		expect(escalated?.maxTokens).toBe(400);
		expect(escalated?.ephemeralTail).toBe("be thorough");
		expect(escalated?.validate).toBeUndefined();
		expect(harness.calls.map((c) => c.model.id)).toEqual(["fast-1", "deep-1"]);
		expect(harness.calls[1]?.options?.maxTokens).toBe(400);
		expect(harness.completions[0]?.route.model.id).toBe("deep-1");
	});

	it("skips validation for tool-use and error candidates", async () => {
		let validated = 0;
		const validate = () => {
			validated++;
			return { action: "accept" as const };
		};
		const toolUse = makeHarness({
			"fast-1": (m, s) => scriptedStream(reply(m, "calling", { stopReason: "toolUse" }), 0, s),
		});
		const first = await run(toolUse, { model: FAST, thinkingLevel: "off", validate });
		expect(first.message.stopReason).toBe("toolUse");

		const errored = makeHarness({
			"fast-1": (m, s) => scriptedStream(reply(m, "", { stopReason: "error", errorMessage: "nope" }), 0, s),
		});
		const second = await run(errored, { model: FAST, thinkingLevel: "off", validate });
		expect(second.message.stopReason).toBe("error");
		expect(validated).toBe(0);
	});
});

describe("route-exec: custom stream tier", () => {
	it("hands the definition a dispatch that commits routes, forwards state/status, and filters zero-usage records", async () => {
		const statuses: Array<string | undefined> = [];
		const harness = makeHarness({ "fast-1": (m, s) => scriptedStream(reply(m, "via dispatch"), 5, s) });
		const definition: VirtualModelDefinition = {
			...DEFINITION,
			async stream(request) {
				request.recordUsage("probe", "x", "y", PAID_USAGE, "counted");
				request.recordUsage("probe", "x", "y", {
					...PAID_USAGE,
					input: 0,
					output: 0,
					totalTokens: 0,
					cost: { ...PAID_USAGE.cost, total: 0 },
				});
				request.setStatus("racing");
				return request.dispatch({ model: FAST, thinkingLevel: "off", state: "dispatched", statusLabel: "go" });
			},
		};
		const stream = executeRoutedStream({
			definition,
			request: makeRequest(),
			initialRoute: { model: SLOW, thinkingLevel: "off" },
			context: CONTEXT,
			...harness.params,
			onStatus: (label) => statuses.push(label),
		});
		for await (const _event of stream) {
			// drain
		}
		const message = await stream.result();

		expect(message.content).toEqual([{ type: "text", text: "via dispatch" }]);
		expect(harness.sidecar).toEqual([{ kind: "probe", provider: "x", modelId: "y", note: "counted" }]);
		expect(statuses).toEqual(["racing", "go"]);
		expect(harness.states).toEqual(["dispatched"]);
		expect(harness.completions[0]?.route.model.id).toBe("fast-1");
	});
});

describe("route-exec: self-sufficiency", () => {
	it("does not import the pi-ai virtual-models bridge or pi-durable virtual-models/sliding-window", () => {
		const source = readFileSync(ROUTE_EXEC_SOURCE, "utf8");
		expect(source).not.toMatch(/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))/);
		expect(source).toMatch(/export function executeRoutedStream/);
	});
});
