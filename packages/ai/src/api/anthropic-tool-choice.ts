import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

// https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forced-tool-use
const ADAPTIVE_FORCED_TOOL_CHOICE_UNSUPPORTED_MODEL =
	/^claude-(?:(?:opus|sonnet)[.-]5[.-]5|(?:fable|mythos)[.-]5[.-]1)(?:-\d{8})?$/;

/** Apply Anthropic's forced-tool rules without changing auto/none or omitting parallel-use control. */
export function compatibleAnthropicToolChoice(
	params: MessageCreateParamsStreaming,
): MessageCreateParamsStreaming["tool_choice"] {
	const choice = params.tool_choice;
	if (!choice || (choice.type !== "any" && choice.type !== "tool")) return choice;
	const modelId = params.model.toLowerCase().replace(/^~?anthropic\//, "");
	if (!modelId.startsWith("claude-")) return choice;
	const unsupported =
		params.thinking?.type === "enabled" || ADAPTIVE_FORCED_TOOL_CHOICE_UNSUPPORTED_MODEL.test(modelId);
	if (!unsupported) return choice;
	return {
		type: "auto",
		...(choice.disable_parallel_tool_use !== undefined
			? { disable_parallel_tool_use: choice.disable_parallel_tool_use }
			: {}),
	};
}
