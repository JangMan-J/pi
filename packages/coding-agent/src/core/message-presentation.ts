import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "./agent-session.ts";

/** Session-owned presentation metadata, persisted without changing assistant content. */
type PresentedAssistantMessage = AssistantMessage & { suppressTextDisplay?: boolean };

/** Mark a routed response without replacing its canonical identity. */
export function suppressAssistantText(message: AssistantMessage): void {
	(message as PresentedAssistantMessage).suppressTextDisplay = true;
}

/** Project a message for display; canonical history and model context stay untouched. */
export function presentMessage<T extends AgentMessage>(message: T): T {
	// Every stop reason is filtered: a failed or aborted hidden turn shows only its diagnostic
	// (`errorMessage`), never its partial prose or thinking.
	if (message.role !== "assistant" || !(message as PresentedAssistantMessage).suppressTextDisplay) return message;
	return {
		...message,
		content: message.content.filter((block) => block.type !== "text" && block.type !== "thinking"),
	};
}

/** True when the message is a routed turn whose prose and thinking never reach the surface. */
export function isTextSuppressed(message: AgentMessage): boolean {
	return message.role === "assistant" && Boolean((message as PresentedAssistantMessage).suppressTextDisplay);
}

/** Remove hidden prose from every assistant snapshot and delta on the session event surface. */
export function presentSessionEvent(event: AgentSessionEvent): AgentSessionEvent | undefined {
	if (event.type === "agent_end") return { ...event, messages: event.messages.map(presentMessage) };
	if (event.type === "message_update") {
		const message = presentMessage(event.message);
		if (message === event.message) return event;
		const update = event.assistantMessageEvent;
		if (
			update.type === "text_start" ||
			update.type === "text_delta" ||
			update.type === "text_end" ||
			update.type === "thinking_start" ||
			update.type === "thinking_delta" ||
			update.type === "thinking_end"
		)
			return undefined;
		if ("partial" in update) {
			const contentIndex =
				"contentIndex" in update
					? update.partial.content
							.slice(0, update.contentIndex)
							.filter((block) => block.type !== "text" && block.type !== "thinking").length
					: undefined;
			return {
				...event,
				message,
				assistantMessageEvent: {
					...update,
					partial: presentMessage(update.partial),
					...(contentIndex === undefined ? {} : { contentIndex }),
				},
			};
		}
		if (update.type === "done")
			return { ...event, message, assistantMessageEvent: { ...update, message: presentMessage(update.message) } };
		if (update.type === "error")
			return { ...event, message, assistantMessageEvent: { ...update, error: presentMessage(update.error) } };
		return { ...event, message };
	}
	if (event.type === "message_start" || event.type === "message_end" || event.type === "turn_end") {
		return { ...event, message: presentMessage(event.message) };
	}
	return event;
}
