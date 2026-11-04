import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "meta"]);
// OpenAI Responses rejects max_output_tokens below 16: https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const CHATGPT_WORKSPACE_LIMIT_HINT =
	"You've reached your ChatGPT workspace's usage limit. Ask your workspace admin to increase it at admin.openai.com → Workspace → Usage limits.";
// Fixed reasoning.effort while configuration_update items carry the thinking level.
const CONFIGURATION_UPDATE_REQUEST_EFFORT = "medium";

/**
 * OpenAI API keys start with `sk-`; a different credential sent directly to OpenAI
 * is a Sign in with ChatGPT access token.
 */
function isChatGPTSignIn(model: Model<"openai-responses">, apiKey: string | undefined): boolean {
	return (
		model.provider === "openai" &&
		model.baseUrl === "https://api.openai.com/v1" &&
		apiKey !== undefined &&
		!apiKey.startsWith("sk-")
	);
}

function isMetaModel(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">): boolean {
	return model.provider === "meta" || model.baseUrl.includes("api.meta.ai");
}

function getHeaderValue(headers: ProviderHeaders | undefined, name: string): string | null | undefined {
	if (!headers) return undefined;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected) return value;
	}
	return undefined;
}

function setHeaderCaseInsensitive(headers: ProviderHeaders, name: string, value: string | null): void {
	const expected = name.toLowerCase();
	for (const existing of Object.keys(headers)) {
		if (existing.toLowerCase() === expected && existing !== name) {
			delete headers[existing];
		}
	}
	headers[name] = value;
}

function deleteHeaderCaseInsensitive(headers: ProviderHeaders, name: string): void {
	const expected = name.toLowerCase();
	for (const existing of Object.keys(headers)) {
		if (existing.toLowerCase() === expected) {
			delete headers[existing];
		}
	}
}

function isMetaOAuthHeaders(headers: ProviderHeaders | undefined): boolean {
	const ua = getHeaderValue(headers, "user-agent");
	if (typeof ua === "string" && ua.startsWith("muse-build/")) return true;
	const role = getHeaderValue(headers, "x-tbh-agent-role");
	return typeof role === "string" && role.trim().length > 0;
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	const isMeta = isMetaModel(model);
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? isMeta,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		promptCacheKeyMode: model.compat?.promptCacheKeyMode ?? "auto",
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? !isMeta,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? isMeta,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
		supportsMaxOutputTokens: model.compat?.supportsMaxOutputTokens ?? true,
		supportsMidConvoEffort: model.compat?.supportsMidConvoEffort ?? false,
	};
}

/** Effort to send in configuration_update items, or undefined to send it as reasoning.effort. */
function getConfigurationUpdateEffort(
	model: Model<"openai-responses">,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
): string | undefined {
	if (
		!compat.supportsMidConvoEffort ||
		!options?.reasoningEffort ||
		// Sign in with ChatGPT rejects configuration_update items.
		isChatGPTSignIn(model, options.apiKey)
	) {
		return undefined;
	}
	return model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention && !compat.supportsExplicitPromptCacheMode
		? "24h"
		: undefined;
}

function getPromptCacheOptions(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): ResponseCreateParamsStreaming["prompt_cache_options"] {
	if (!compat.supportsExplicitPromptCacheMode) return undefined;
	if (cacheRetention === "none") return { mode: "explicit" };
	if (cacheRetention === "long" && compat.supportsLongCacheRetention) return { ttl: "30m" };
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const compat = getCompat(model);
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// Create OpenAI client
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.identity,
				options?.fetch,
				cacheSessionId,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const metaToolNames = isMetaModel(model) ? shapeMetaWireTools(params) : undefined;
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
				if (metaToolNames) {
					for (const [wire, original] of shapeMetaWireTools(params)) {
						metaToolNames.set(wire, original);
					}
				}
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			const responseStream =
				metaToolNames && metaToolNames.size > 0
					? restoreMetaStreamToolNames(openaiStream, metaToolNames)
					: openaiStream;
			await processResponsesStream(responseStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			// Sign in with ChatGPT shares the subscription's usage limit with other apps.
			// On ChatGPT Business plans, the workspace admin also sets a per-user limit.
			if (errorMessage.includes("subscription_sharing_usage_limit_exceeded")) {
				output.errorMessage = `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`;
			} else if (errorMessage.includes("subscription_sharing_workplace_individual_usage_limit_exceeded")) {
				output.errorMessage = `${errorMessage}\n${CHATGPT_WORKSPACE_LIMIT_HINT}`;
			} else {
				output.errorMessage = errorMessage;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const isMeta = isMetaModel(model);
	const isMetaOAuth = isMeta && (isMetaOAuthHeaders(optionsHeaders) || isMetaOAuthHeaders(model.headers));
	const headers: ProviderHeaders = { ...getIdentityHeaders(model, identity) };
	if (model.headers) {
		for (const [key, value] of Object.entries(model.headers)) {
			setHeaderCaseInsensitive(headers, key, value);
		}
	}
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	} else if (isMetaOAuth) {
		deleteHeaderCaseInsensitive(headers, "x-api-version");
		setHeaderCaseInsensitive(headers, "x-client-id", "tbh:exec");
		setHeaderCaseInsensitive(headers, "x-tbh-agent-role", "main");
	} else if (isMeta) {
		if (!hasHeader(headers, "x-api-version")) headers["x-api-version"] = "1.0.0";
		if (!hasHeader(headers, "x-client-id")) headers["x-client-id"] = "tbh:tui";
	}

	if (sessionId) {
		if (isMetaOAuth) {
			setHeaderCaseInsensitive(headers, "x-meta-ai-gateway-session-id", sessionId);
			setHeaderCaseInsensitive(headers, "x-tbh-session-id", sessionId);
			setHeaderCaseInsensitive(headers, "x-tbh-root-session-id", sessionId);
			setHeaderCaseInsensitive(headers, "x-tbh-thread-id", sessionId);
		} else if (isMeta) {
			headers["x-meta-ai-gateway-session-id"] = sessionId;
		} else if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers["session-id"] = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		for (const [key, value] of Object.entries(optionsHeaders)) {
			setHeaderCaseInsensitive(headers, key, value);
		}
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

type InputItem = ResponseInput[number];
const isAssistantMessage = (
	item: InputItem | undefined,
): item is Extract<InputItem, { type?: "message" }> & {
	role: "assistant";
	phase?: string | null;
} => item?.type === "message" && (item as { role?: string }).role === "assistant";
const isCallItem = (item: InputItem | undefined): boolean =>
	item?.type === "function_call" || item?.type === "custom_tool_call";

/** Text a reasoning-only turn is closed with, as Meta prescribes. */
export const META_REASONING_ONLY_PLACEHOLDER = "(no reply)";

/**
 * Tool names that trigger HTTP 403 `client_attestation_denied` on Meta's `/v1/responses`
 * endpoint when their schema differs from Muse Code's built-in tool definitions (such as `bash`
 * or `web_search`) or when they match non-Muse coding-agent signature tools (`TodoWrite`,
 * `shell`, `apply_patch`, `update_plan`, `request_user_input`).
 *
 * Live probe 2026-11-04 against muse-spark-1.3 and muse-wonder-1.0: declaring any of these
 * names with a non-Muse schema returns 403 `client_attestation_denied`, while case-shifted wire
 * names (e.g. `Bash`, `Web_search`, `todo_write`) return 200 and round-trip tool calls.
 */
export const META_ATTESTATION_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
	"add_memory",
	"apply_patch",
	"bash",
	"bash_input",
	"code_exec",
	"code_wait",
	"edit_file",
	"edit_memory",
	"image_generation",
	"monitor",
	"read_file",
	"read_memory",
	"read_skill",
	"request_user_input",
	"search",
	"shell",
	"snooze_reminder",
	"submit_reminder_decision",
	"TodoWrite",
	"update_plan",
	"web_fetch",
	"web_search",
	"work_list",
	"work_status",
	"work_stop",
	"workflow",
	"write_file",
	"write_todos",
]);

/**
 * Rewrites attestation-blocked tool names in `params.tools` and `params.input` to collision-free
 * wire names and returns a `wireName -> originalName` map for stream restoration.
 */
export function shapeMetaWireTools(params: ResponseCreateParamsStreaming): Map<string, string> {
	const declaredNames = new Set<string>();
	for (const tool of params.tools ?? []) {
		if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") {
			declaredNames.add(tool.name);
		}
	}
	if (Array.isArray(params.input)) {
		for (const item of params.input) {
			if ((item?.type === "function_call" || item?.type === "custom_tool_call") && typeof item.name === "string") {
				declaredNames.add(item.name);
			} else if (item?.type === "additional_tools" || item?.type === "tool_search_output") {
				for (const tool of item.tools) {
					if ((tool.type === "function" || tool.type === "custom") && typeof tool.name === "string") {
						declaredNames.add(tool.name);
					}
				}
			}
		}
	}

	const reserved = new Set<string>(declaredNames);
	const originalToWire = new Map<string, string>();
	const wireToOriginal = new Map<string, string>();
	for (const name of declaredNames) {
		if (!META_ATTESTATION_BLOCKED_TOOL_NAMES.has(name)) continue;
		const baseCandidate = name === "TodoWrite" ? "todo_write" : `${name[0]!.toUpperCase()}${name.slice(1)}`;
		let candidate = baseCandidate;
		let suffix = 2;
		while (reserved.has(candidate) || META_ATTESTATION_BLOCKED_TOOL_NAMES.has(candidate)) {
			candidate = `${baseCandidate}_${suffix++}`;
		}
		reserved.add(candidate);
		originalToWire.set(name, candidate);
		wireToOriginal.set(candidate, name);
	}

	if (originalToWire.size === 0) return wireToOriginal;

	for (const tool of params.tools ?? []) {
		if (tool.type === "function" || tool.type === "custom") {
			const mapped = originalToWire.get(tool.name);
			if (mapped !== undefined) tool.name = mapped;
		}
	}
	if (Array.isArray(params.input)) {
		for (const item of params.input) {
			if (item?.type === "function_call" || item?.type === "custom_tool_call") {
				const mapped = originalToWire.get(item.name);
				if (mapped !== undefined) item.name = mapped;
			} else if (item?.type === "additional_tools" || item?.type === "tool_search_output") {
				for (const tool of item.tools) {
					if (tool.type === "function" || tool.type === "custom") {
						const mapped = originalToWire.get(tool.name);
						if (mapped !== undefined) tool.name = mapped;
					}
				}
			} else if (
				item?.type === "tool_search_call" &&
				item.arguments &&
				typeof item.arguments === "object" &&
				"query" in item.arguments &&
				typeof item.arguments.query === "string"
			) {
				item.arguments.query = item.arguments.query
					.split(" ")
					.map((token) => originalToWire.get(token) ?? token)
					.join(" ");
			}
		}
	}

	return wireToOriginal;
}

async function* restoreMetaStreamToolNames(
	source: AsyncIterable<ResponseStreamEvent>,
	wireToOriginal: ReadonlyMap<string, string>,
): AsyncIterable<ResponseStreamEvent> {
	const restoreName = (name: string): string => {
		const direct = wireToOriginal.get(name);
		if (direct !== undefined) return direct;
		const lower = name.toLowerCase();
		for (const [wire, original] of wireToOriginal) {
			if (wire.toLowerCase() === lower) return original;
		}
		return name;
	};
	const restoreItem = (item: ResponseOutputItem): void => {
		if (item.type === "function_call" || item.type === "custom_tool_call") {
			item.name = restoreName(item.name);
		}
	};
	for await (const event of source) {
		if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
			restoreItem(event.item);
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			for (const item of event.response?.output ?? []) {
				restoreItem(item);
			}
		}
		yield event;
	}
}

/**
 * Keeps replayed history in the shape Meta's Responses protocol documents
 * (dev.meta.ai/docs/protocols/responses#message-phase and #conversation-structure):
 * - Intermediate assistant text before a function call carries phase "commentary". The model tags
 *   its own pre-call text that way and Meta says dropping the phase can degrade quality; text from
 *   another model's turn (a mid-session switch) arrives with no phase, which Meta reads as a final
 *   answer.
 * - A reasoning item is followed by an assistant message or call before the next user, system or
 *   developer message. After a turn that hit the output limit during reasoning, Meta prescribes a
 *   minimal assistant message, which keeps the encrypted reasoning in the replay.
 * Meta documents both violations as HTTP 400. Live probe 2026-10-25 on muse-spark-1.3 and
 * muse-wonder-1.0: neither is enforced today (both shapes, and an explicit final_answer before a
 * call, returned 200), so this is protocol alignment rather than an error fix.
 * Mutates `input` in place. Exported for unit tests.
 */
export function repairMetaConversationStructure(input: ResponseInput): void {
	for (let i = 0; i < input.length; i++) {
		const item = input[i];
		if (isAssistantMessage(item) && item.phase == null) {
			let j = i + 1;
			while (input[j]?.type === "reasoning" || isAssistantMessage(input[j])) j++;
			if (isCallItem(input[j])) item.phase = "commentary";
		} else if (item?.type === "reasoning") {
			let j = i + 1;
			while (input[j]?.type === "reasoning") j++;
			const next = input[j];
			if (j < input.length && !isAssistantMessage(next) && !isCallItem(next)) {
				input.splice(j, 0, {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: META_REASONING_ONLY_PLACEHOLDER, annotations: [] }],
					status: "completed",
					id: `msg_pi_meta_${j}`,
					phase: "final_answer",
				} as InputItem);
			}
			i = j - 1;
		}
	}
}

function buildParams(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat>,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	configurationUpdateEffort: string | undefined,
) {
	const isMeta = isMetaModel(model);
	const suppressMetaTools = isMeta && options?.toolChoice === "none";
	const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport(compat));
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: compat.supportsMidConvoSystemMessages,
		supportsAdditionalTools: suppressMetaTools ? false : compat.supportsAdditionalTools,
		supportsToolSearch: suppressMetaTools ? false : compat.supportsToolSearch,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
		configurationUpdateEffort,
	});
	if (isMeta) repairMetaConversationStructure(messages);

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const sendPromptCacheKey = cacheRetention !== "none" && compat.promptCacheKeyMode !== "disabled";
	// Sign in with ChatGPT rejects these request fields.
	const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: sendPromptCacheKey ? clampOpenAIPromptCacheKey(options?.sessionId) : undefined,
		prompt_cache_retention: omitUnsupportedFields ? undefined : getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: omitUnsupportedFields ? undefined : getPromptCacheOptions(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined && !omitUnsupportedFields) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		if (isMeta && options.toolChoice === "none") {
			// Meta only accepts auto. With no tools, it cannot select one.
			delete params.tools;
		} else if (isMeta && options.toolChoice !== "auto") {
			throw new Error("Meta does not support required or forced tool choice; use auto or none.");
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	const defaultReasoningEffort = options?.reasoningSummary
		? "medium"
		: isMeta && model.thinkingLevelMap?.off === null
			? "high"
			: undefined;
	const reasoningEffort = options?.reasoningEffort ?? defaultReasoningEffort;
	if (model.reasoning) {
		if (reasoningEffort) {
			const requestedEffort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			const effort = configurationUpdateEffort === undefined ? requestedEffort : CONFIGURATION_UPDATE_REQUEST_EFFORT;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		if (model.provider === "xai" || isMeta) params.include = ["reasoning.encrypted_content"];
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
		case "fast":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
