import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRoutePurpose } from "@earendil-works/pi-virtual-models";
import {
	createVirtualModel,
	findLatestResponse,
	isStatefulRoutePurpose,
	isStreamSuppressedRoute,
	isTextSuppressed,
	isVirtualModel,
	presentAssistantMessage,
	purposeToReason,
	suppressAssistantText,
} from "@earendil-works/pi-virtual-models";
import { describe, expect, test } from "vitest";

const PREDICATES_SOURCE = fileURLToPath(new URL("../src/core/predicates.ts", import.meta.url));

function messageUsage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	content: AssistantMessage["content"],
	options?: { stopReason?: "stop" | "error" | "aborted" | "toolUse" },
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: messageUsage(),
		stopReason: options?.stopReason ?? "stop",
		timestamp: 1,
	};
}

function thinking(value: string): ThinkingContent {
	return { type: "thinking", thinking: value };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

describe("predicates module self-sufficiency", () => {
	// Red line on the pre-extraction bridge, which re-exported everything from
	// `@earendil-works/pi-ai/virtual-models` instead of owning the predicates.
	test("imports nothing at runtime from legacy pi-ai/pi-durable subpaths", () => {
		const source = readFileSync(PREDICATES_SOURCE, "utf8");
		expect(source).not.toMatch(
			/@earendil-works\/pi-(ai\/virtual-models|durable\/(virtual-models|sliding-window))|@earendil-works\/pi-ai\/study-notes/,
		);
	});

	test("keeps every workspace import type-only and stays free of node: builtins", () => {
		const source = readFileSync(PREDICATES_SOURCE, "utf8");
		const withoutTypeImports = source.replace(/^\s*import\s+type\s+[\s\S]*?;\s*$/gm, "");
		expect(withoutTypeImports).not.toContain('from "@earendil-works/');
		expect(source).not.toMatch(/from\s+"node:/);
	});
});

describe("purposeToReason", () => {
	test("maps each purpose to its coarse reason", () => {
		const expected: Record<ModelRoutePurpose, string> = {
			prompt: "user",
			subagent: "user",
			continuation: "continuation",
			retry: "retry",
			compaction: "direct",
			branch_summary: "direct",
			direct: "direct",
		};
		for (const [purpose, reason] of Object.entries(expected)) {
			expect(purposeToReason(purpose as ModelRoutePurpose)).toBe(reason);
		}
	});
});

describe("isStatefulRoutePurpose", () => {
	test("treats conversational purposes as stateful and one-shot purposes as not", () => {
		for (const purpose of ["prompt", "continuation", "retry", "subagent"] as const) {
			expect(isStatefulRoutePurpose(purpose)).toBe(true);
		}
		for (const purpose of ["compaction", "branch_summary", "direct"] as const) {
			expect(isStatefulRoutePurpose(purpose)).toBe(false);
		}
	});
});

describe("isVirtualModel", () => {
	test("matches only the pi-virtual api", () => {
		expect(isVirtualModel({ api: "pi-virtual" })).toBe(true);
		expect(isVirtualModel({ api: "anthropic-messages" })).toBe(false);
		expect(isVirtualModel({ api: "" })).toBe(false);
	});
});

describe("isStreamSuppressedRoute", () => {
	test("is true when either suppression flag is set", () => {
		expect(isStreamSuppressedRoute({ suppressStream: true })).toBe(true);
		expect(isStreamSuppressedRoute({ suppressTextDisplay: true })).toBe(true);
		expect(isStreamSuppressedRoute({ suppressStream: false, suppressTextDisplay: false })).toBe(false);
		expect(isStreamSuppressedRoute({})).toBe(false);
	});
});

describe("findLatestResponse", () => {
	test("returns the last successful assistant message, skipping failed and aborted ones", () => {
		const ok = assistant([text("first")]);
		const failed = assistant([text("boom")], { stopReason: "error" });
		const aborted = assistant([text("stopped")], { stopReason: "aborted" });
		expect(findLatestResponse([ok, failed, aborted])).toBe(ok);
	});

	test("returns undefined when no assistant message succeeded", () => {
		expect(findLatestResponse([])).toBeUndefined();
		expect(findLatestResponse([{ role: "user" }])).toBeUndefined();
		expect(findLatestResponse([assistant([text("x")], { stopReason: "error" })])).toBeUndefined();
		expect(findLatestResponse([assistant([text("x")], { stopReason: "aborted" })])).toBeUndefined();
	});

	test("accepts any message-shaped objects, not just full messages", () => {
		const messages = [{ role: "user" }, { role: "assistant", stopReason: "stop" }];
		expect(findLatestResponse(messages)).toBe(messages[1]);
	});
});

describe("text suppression round-trip", () => {
	test("suppressAssistantText marks the message and isTextSuppressed sees it", () => {
		const message = assistant([text("visible")]);
		expect(isTextSuppressed(message)).toBe(false);
		suppressAssistantText(message);
		expect(isTextSuppressed(message)).toBe(true);
	});

	test("isTextSuppressed is false for non-assistant roles", () => {
		const userMessage = { role: "user" as const } as unknown as Message;
		expect(isTextSuppressed(userMessage)).toBe(false);
	});

	test("presentAssistantMessage strips prose and thinking from a suppressed message", () => {
		const message = assistant([
			thinking("internal"),
			text("internal"),
			{ type: "toolCall", id: "c1", name: "read", arguments: {} },
		]);
		suppressAssistantText(message);
		const presented = presentAssistantMessage(message);

		expect(presented).not.toBe(message);
		expect(presented.content.map((block) => block.type)).toEqual(["toolCall"]);
		// The canonical message keeps its content: presentation is a projection.
		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
	});

	test("presentAssistantMessage returns the same object when nothing is suppressed", () => {
		const message = assistant([text("visible")]);
		expect(presentAssistantMessage(message)).toBe(message);
	});

	test("presentAssistantMessage leaves non-assistant roles alone", () => {
		const userMessage = { role: "user" } as unknown as Message;
		expect(presentAssistantMessage(userMessage)).toBe(userMessage);
	});
});

describe("createVirtualModel", () => {
	test("builds a zero-cost catalog entry on the pi-virtual api", () => {
		const model = createVirtualModel({ provider: "acme", id: "v1", name: "Virtual One" });
		expect(model.api).toBe("pi-virtual");
		expect(model.provider).toBe("acme");
		expect(model.id).toBe("v1");
		expect(model.name).toBe("Virtual One");
		expect(model.baseUrl).toBe("");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(model.contextWindow).toBe(0);
		expect(model.maxTokens).toBe(0);
		expect(model.input).toEqual(["text", "image"]);
	});

	test("defaults to a single `off` thinking level and is not a reasoning model", () => {
		const model = createVirtualModel({ provider: "acme", id: "v1", name: "Virtual One" });
		expect(model.reasoning).toBe(false);
		expect(model.thinkingLevelMap?.off).toBe("off");
		expect(model.thinkingLevelMap?.high).toBeNull();
	});

	test("maps every known thinking level, nulling the ones the model does not declare", () => {
		const model = createVirtualModel({
			provider: "acme",
			id: "v2",
			name: "Virtual Two",
			thinkingLevels: ["off", "high"],
		});
		expect(model.thinkingLevelMap).toEqual({
			off: "off",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(model.reasoning).toBe(true);
	});

	test("honours explicit input, context window, and max tokens", () => {
		const model = createVirtualModel({
			provider: "acme",
			id: "v3",
			name: "Virtual Three",
			input: ["text"],
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		expect(model.input).toEqual(["text"]);
		expect(model.contextWindow).toBe(200_000);
		expect(model.maxTokens).toBe(8_192);
	});
});

describe("module surface", () => {
	test("createVirtualModel output is routable by the type predicate", () => {
		const model = createVirtualModel({ provider: "acme", id: "v4", name: "Virtual Four" });
		expect(isVirtualModel(model)).toBe(true);
	});

	test("a route object satisfies the suppression predicate shape", () => {
		const route = { suppressTextDisplay: true } as Pick<ModelRoute, "suppressStream" | "suppressTextDisplay">;
		expect(isStreamSuppressedRoute(route)).toBe(true);
	});
});
