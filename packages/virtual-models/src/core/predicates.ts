/**
 * Stateless virtual-model predicates: route-purpose classification, catalog-entry construction,
 * and presentation-only text suppression. Zero I/O and zero runtime dependencies beyond the
 * catalog constants, so every consumer can import this module without pulling a provider graph.
 */
import type { Api, AssistantMessage, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, VIRTUAL_MODEL_API } from "./types.ts";
import type { ModelRoute, ModelRoutePurpose, ModelRouteReason, VirtualModelDefinition } from "./types.ts";

/** Map a specific route purpose to its coarse `ModelRouteReason`. */
export function purposeToReason(purpose: ModelRoutePurpose): ModelRouteReason {
	switch (purpose) {
		case "prompt":
		case "subagent":
			return "user";
		case "continuation":
			return "continuation";
		case "retry":
			return "retry";
		case "compaction":
		case "branch_summary":
		case "direct":
			return "direct";
	}
}

/** Whether a route purpose belongs to a conversational turn that may persist router state. */
export function isStatefulRoutePurpose(purpose: ModelRoutePurpose): boolean {
	return purpose === "prompt" || purpose === "continuation" || purpose === "retry" || purpose === "subagent";
}

export function isVirtualModel(model: { api: string }): boolean {
	return model.api === VIRTUAL_MODEL_API;
}

/** Whether a route suppresses streamed assistant text and thinking on presentation surfaces. */
export function isStreamSuppressedRoute(route: Pick<ModelRoute, "suppressStream" | "suppressTextDisplay">): boolean {
	return route.suppressStream === true || route.suppressTextDisplay === true;
}

/** Latest successful response. Its model is physical: failed or aborted requests are skipped. */
export function findLatestResponse<TMessage extends { role: string }>(
	messages: readonly TMessage[],
): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			message &&
			message.role === "assistant" &&
			"stopReason" in message &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted"
		) {
			return message as unknown as AssistantMessage;
		}
	}
	return undefined;
}

/** Presentation-only metadata attached to an assistant message when stream text display is suppressed. */
type PresentedAssistantMessage = AssistantMessage & { suppressTextDisplay?: boolean };

/** Mark a routed response as stream-suppressed without replacing its canonical identity. */
export function suppressAssistantText(message: AssistantMessage): void {
	(message as PresentedAssistantMessage).suppressTextDisplay = true;
}

/** Project a message for display; canonical history and model context stay untouched. */
export function presentAssistantMessage<TMessage extends { role: string }>(message: TMessage): TMessage {
	if (message.role !== "assistant" || !(message as unknown as PresentedAssistantMessage).suppressTextDisplay) {
		return message;
	}
	const assistant = message as unknown as AssistantMessage;
	return {
		...assistant,
		content: assistant.content.filter((block) => block.type !== "text" && block.type !== "thinking"),
	} as unknown as TMessage;
}

/** True when the message is a routed turn whose prose and thinking never reach presentation surfaces. */
export function isTextSuppressed(message: { role: string }): boolean {
	return (
		message.role === "assistant" && Boolean((message as unknown as PresentedAssistantMessage).suppressTextDisplay)
	);
}

/** Build the catalog entry of a virtual model. */
export function createVirtualModel(
	definition: Omit<VirtualModelDefinition, "route" | "stream" | "onOutcome">,
): Model<Api> {
	const levels = definition.thinkingLevels ?? ["off"];
	const thinkingLevelMap: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) thinkingLevelMap[level] = levels.includes(level) ? level : null;
	return {
		id: definition.id,
		name: definition.name,
		api: VIRTUAL_MODEL_API,
		provider: definition.provider,
		baseUrl: "",
		reasoning: levels.some((level) => level !== "off"),
		thinkingLevelMap,
		input: definition.input ?? ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 0,
		maxTokens: definition.maxTokens ?? 0,
	};
}
