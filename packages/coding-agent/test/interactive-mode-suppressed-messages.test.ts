import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { presentMessage, suppressAssistantText } from "../src/core/message-presentation.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");

function createView() {
	const view = Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		chatContainer: new Container(),
		hideThinkingBlock: false,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking...",
		pendingTools: new Map(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
		maybeShowThinkingDropNotice: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		maybeSuggestBugReport: vi.fn(),
		runtimeHost: {
			session: {
				retryAttempt: 0,
				settingsManager: {
					getShowImages: () => false,
					getImageWidthCells: () => 80,
				},
				sessionManager: { getCwd: () => process.cwd() },
			},
		},
	}) as {
		chatContainer: Container;
		streamingComponent: unknown;
		streamingMessage: unknown;
		handleEvent(event: AgentSessionEvent): Promise<void>;
		addMessageToChat(message: ReturnType<typeof fauxAssistantMessage>): void;
	};
	return view;
}

describe("suppressed interactive assistant messages", () => {
	it("adds no component or spacer during streaming or history with thinking visible", async () => {
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: "<scout_brief>secret</scout_brief>", thinkingSignature: "signature" },
			{ type: "text", text: "<no_recon/>" },
		]);
		suppressAssistantText(message);
		const view = createView();
		await view.handleEvent({ type: "message_start", message: presentMessage(message) });
		expect(view.streamingComponent).toBeUndefined();
		expect(view.chatContainer.children).toEqual([]);
		await view.handleEvent({
			type: "message_update",
			message: presentMessage(message),
			assistantMessageEvent: { type: "start", partial: presentMessage(message) },
		});
		expect(view.chatContainer.children).toEqual([]);
		await view.handleEvent({ type: "message_end", message: presentMessage(message) });
		expect(view.streamingMessage).toBeUndefined();
		view.addMessageToChat(JSON.parse(JSON.stringify(message)));
		expect(view.chatContainer.children).toEqual([]);
		expect(view.chatContainer.render(80)).toEqual([]);
		const architect = fauxAssistantMessage("architect answer");
		await view.handleEvent({ type: "message_start", message: architect });
		await view.handleEvent({ type: "message_end", message: architect });
		expect(view.chatContainer.children).toHaveLength(1);
		expect(view.chatContainer.render(80).join("\n")).toContain("architect answer");
	});

	it.each(["error", "aborted"] as const)(
		"creates a diagnostic component for hidden streams ending in %s",
		async (stopReason) => {
			const message = fauxAssistantMessage("internal");
			suppressAssistantText(message);
			const view = createView();
			await view.handleEvent({ type: "message_start", message: presentMessage(message) });
			await view.handleEvent({
				type: "message_end",
				message: { ...message, stopReason, errorMessage: "diagnostic" },
			});
			expect(view.chatContainer.children).toHaveLength(1);
			expect(view.chatContainer.render(80).join("\n")).toContain("internal");
		},
	);

	it("renders streaming tools without an empty assistant component", async () => {
		const message = fauxAssistantMessage([fauxToolCall("read", { path: "file" })]);
		suppressAssistantText(message);
		const view = createView();
		await view.handleEvent({ type: "message_start", message });
		await view.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
		});
		expect(view.streamingComponent).toBeUndefined();
		expect(view.chatContainer.children).toHaveLength(1);
		expect(view.chatContainer.render(80).join("\n")).toContain("file");
		await view.handleEvent({ type: "message_end", message });
		expect(view.chatContainer.children).toHaveLength(1);
	});

	it("does not add an empty assistant component before hidden tool messages in history", () => {
		const message = fauxAssistantMessage([fauxToolCall("read", { path: "file" })]);
		suppressAssistantText(message);
		const view = createView();
		view.addMessageToChat(message);
		expect(view.chatContainer.children).toEqual([]);
	});
});
