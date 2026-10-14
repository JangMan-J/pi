import { clampThinkingLevel } from "../../models.ts";
import type { AssistantMessage, Model, ProviderHeaders, SimpleStreamOptions, TranscriptContext } from "../../types.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { resolveTranscriptTools } from "../../utils/transcript.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import type { OpenAIResponsesOptions } from "../openai-responses.ts";
import { convertResponsesMessages, convertResponsesTools } from "../openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "../simple-options.ts";
import {
	cacheAffinityEnabled,
	DEFAULT_DOOM_LOOP_CHECK_WINDOW,
	DEFAULT_EXACT_REPETITION_CHECK_WINDOW,
	doomLoopCheckEnabled,
	storeResponsesEnabled,
} from "./config.ts";
import { sanitizeContextMessages } from "./history.ts";
import { isModernGrokModel, resolveXaiCompat } from "./models.ts";

const ASSISTANT_RESPONSE_ITEM_TYPES = new Set(["custom_tool_call", "function_call", "message", "reasoning"]);
export const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "xai"]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const LONG_REASONING_CHAR_THRESHOLD = 4_000;
const READ_LIKE_STATIONARITY_THRESHOLD = 4;
const DEFAULT_STATIONARITY_THRESHOLD = 8;
const READ_LIKE_TOOLS = new Set(["read", "read_file", "view_file", "todo", "todo_write", "todowrite"]);

export const LONG_REASONING_REMINDER =
	"<system_reminder>Keep reasoning brief and focused on the next concrete action.</system_reminder>";
export const STATIONARITY_REMINDER =
	"<system_reminder>You have called the same tool with identical arguments repeatedly. Do not repeat the same call; take the next concrete action or try a different approach.</system_reminder>";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveApiKey(options?: { apiKey?: string; headers?: ProviderHeaders }): string {
	if (options?.apiKey) {
		return options.apiKey;
	}
	const headers = options?.headers;
	if (headers) {
		for (const [name, value] of Object.entries(headers)) {
			if (name.toLowerCase() === "authorization" && value && value.trim().length > 0) {
				return value.replace(/^Bearer\s+/i, "").trim();
			}
		}
	}
	throw new Error("No API key for provider: xai");
}

export function prepareResponseOptions(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	apiKey: string,
): OpenAIResponsesOptions {
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return {
		...base,
		reasoningEffort: clampedReasoning === "off" ? undefined : clampedReasoning,
	};
}

/**
 * Strip output-only `status` from replayed `reasoning` items, ensure `content[]` parts
 * carry `type: "reasoning_text"`, and drop malformed content-free reasoning placeholders.
 */
export function sanitizeResponsesInputItems(items: readonly unknown[]): unknown[] {
	const out: unknown[] = [];
	for (const rawItem of items) {
		if (!isRecord(rawItem) || rawItem.type !== "reasoning") {
			out.push(rawItem);
			continue;
		}
		const item: Record<string, unknown> = { ...rawItem };
		delete item.status;

		let hasContent = false;
		if (Array.isArray(item.content)) {
			const patchedContent = item.content
				.filter(isRecord)
				.map(
					(part): Record<string, unknown> => ({
						...part,
						type: typeof part.type === "string" && part.type.length > 0 ? part.type : "reasoning_text",
					}),
				)
				.filter((part) => typeof part.text !== "string" || part.text.length > 0);
			item.content = patchedContent;
			hasContent = patchedContent.length > 0;
		}

		const hasSummary =
			Array.isArray(item.summary) &&
			item.summary.some((part) => isRecord(part) && typeof part.text === "string" && part.text.length > 0);
		const hasEncrypted = typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0;

		if (!hasEncrypted && !hasSummary && !hasContent) {
			continue;
		}
		out.push(item);
	}
	return out;
}

function canonicalizeJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalizeJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
}

/**
 * Check `context.messages` for Grok 4.7 delayed long-reasoning bloat (1 step back)
 * and consecutive identical tool-call stationarity (4 read/todo calls or 8 other calls).
 */
export function buildTurnReminders(model: Model<"openai-responses">, context: TranscriptContext): string[] {
	const reminders: string[] = [];
	const lastMessage = context.messages[context.messages.length - 1];
	// Inject step-level reminders only on tool-result continuation turns so initial user prompts keep exact prefixes.
	if (!lastMessage || lastMessage.role !== "toolResult") {
		return reminders;
	}

	const assistants = context.messages.filter((msg): msg is AssistantMessage => msg.role === "assistant");

	// 1. Delayed long-reasoning reminder (delay = 1 step after a long reasoning turn on Grok 4.6/4.7)
	if (isModernGrokModel(model.id) && assistants.length >= 2) {
		const oneStepAgo = assistants[assistants.length - 2]!;
		const thinkingChars = Array.isArray(oneStepAgo.content)
			? oneStepAgo.content.reduce((sum, block) => {
					if (block.type === "thinking" && typeof block.thinking === "string") {
						return sum + block.thinking.length;
					}
					return sum;
				}, 0)
			: 0;
		if (thinkingChars >= LONG_REASONING_CHAR_THRESHOLD) {
			reminders.push(LONG_REASONING_REMINDER);
		}
	}

	// 2. Identical tool-call stationarity check across consecutive trailing assistant steps
	const toolSignatures: Array<{ name: string; sig: string }> = [];
	for (let i = assistants.length - 1; i >= 0; i -= 1) {
		const msg = assistants[i]!;
		if (!Array.isArray(msg.content)) break;
		const calls = msg.content.filter((b) => b.type === "toolCall");
		if (calls.length !== 1) break;
		const call = calls[0]!;
		const name = typeof call.name === "string" ? call.name : "";
		if (!name) break;
		const sig = `${name}:${canonicalizeJson(call.arguments ?? {})}`;
		if (toolSignatures.length > 0 && toolSignatures[0]!.sig !== sig) {
			break;
		}
		toolSignatures.push({ name, sig });
	}

	if (toolSignatures.length > 0) {
		const toolName = toolSignatures[0]!.name.toLowerCase();
		const threshold = READ_LIKE_TOOLS.has(toolName)
			? READ_LIKE_STATIONARITY_THRESHOLD
			: DEFAULT_STATIONARITY_THRESHOLD;
		if (toolSignatures.length >= threshold) {
			reminders.push(STATIONARITY_REMINDER);
		}
	}

	return reminders;
}

export function projectAssistantResponse(
	model: Model<"openai-responses">,
	message: AssistantMessage,
): readonly unknown[] {
	const compat = resolveXaiCompat(model);
	const sanitized = sanitizeContextMessages({ messages: [message] } as unknown as TranscriptContext, model);
	const projected = convertResponsesMessages(model, sanitized, OPENAI_TOOL_CALL_PROVIDERS, {
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: compat.supportsAdditionalTools,
		supportsToolSearch: compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	}).filter(
		(item) => isRecord(item) && ASSISTANT_RESPONSE_ITEM_TYPES.has(typeof item.type === "string" ? item.type : ""),
	);
	return JSON.parse(JSON.stringify(sanitizeResponsesInputItems(projected))) as readonly unknown[];
}

export function buildResponseCreate(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): Record<string, unknown> {
	const compat = resolveXaiCompat(model);
	const modelWithCompat: Model<"openai-responses"> = {
		...model,
		compat,
	};
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		compat.supportsAdditionalTools || compat.supportsToolSearch,
	);
	const rawInput = convertResponsesMessages(
		modelWithCompat,
		sanitizeContextMessages(context, modelWithCompat),
		OPENAI_TOOL_CALL_PROVIDERS,
		{
			supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
			supportsAdditionalTools: compat.supportsAdditionalTools,
			supportsToolSearch: compat.supportsToolSearch,
			toolOptions: {
				supportsStrictMode: compat.supportsStrictMode,
				supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
			},
		},
	);
	const input = sanitizeResponsesInputItems(rawInput);
	for (const reminder of buildTurnReminders(modelWithCompat, context)) {
		input.push({
			role: "user",
			content: [{ type: "input_text", text: reminder }],
		});
	}

	const payload: Record<string, unknown> = {
		model: model.id,
		store: storeResponsesEnabled(options?.env),
		stream: true,
		input,
	};

	if (cacheAffinityEnabled(options?.cacheRetention, options?.env)) {
		const cacheKey = clampOpenAIPromptCacheKey(options?.sessionId);
		if (cacheKey) {
			payload.prompt_cache_key = cacheKey;
		}
	}

	if (options?.maxTokens && compat.supportsMaxOutputTokens) {
		payload.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}
	if (options?.temperature !== undefined) {
		payload.temperature = options.temperature;
	}
	if (options?.serviceTier !== undefined) {
		payload.service_tier = options.serviceTier;
	}
	if (transcriptTools.requestTools.length > 0) {
		payload.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
		if (isModernGrokModel(model.id)) {
			payload.stream_tool_calls = true;
		}
	}
	if (options?.toolChoice !== undefined) {
		payload.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		payload.include = ["reasoning.encrypted_content"];
		if (reasoningEffort) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const defaultSummary = isModernGrokModel(model.id) ? "concise" : "auto";
			payload.reasoning = {
				effort,
				summary: options?.reasoningSummary || defaultSummary,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			payload.reasoning = {
				effort: model.thinkingLevelMap?.off ?? "none",
			};
		}
	}

	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(payload, samplingParams);
	}

	return payload;
}

export function requestHeaders(
	apiKey: string,
	options?: OpenAIResponsesOptions,
	modelHeaders?: ProviderHeaders,
	modelId?: string,
): Record<string, string> {
	const merged = new Map<string, [string, string]>();
	const setHeader = (name: string, value: string) => {
		merged.set(name.toLowerCase(), [name, value]);
	};

	setHeader("User-Agent", getPiUserAgent());
	setHeader("Authorization", `Bearer ${apiKey}`);

	if (cacheAffinityEnabled(options?.cacheRetention, options?.env) && options?.sessionId) {
		setHeader("session_id", options.sessionId);
		setHeader("x-client-request-id", options.sessionId);
		setHeader("x-grok-conv-id", options.sessionId);
	}

	if (modelId && isModernGrokModel(modelId) && doomLoopCheckEnabled(options?.env)) {
		setHeader("x-grok-doom-loop-check", DEFAULT_DOOM_LOOP_CHECK_WINDOW);
		setHeader("x-grok-exact-repetition-check", DEFAULT_EXACT_REPETITION_CHECK_WINDOW);
	}

	for (const source of [modelHeaders, options?.headers]) {
		if (!source) continue;
		for (const [name, value] of Object.entries(source)) {
			if (value === null || value === undefined || value.trim() === "") continue;
			if (name.toLowerCase() === "authorization") continue;
			setHeader(name, value);
		}
	}

	return Object.fromEntries(merged.values());
}
