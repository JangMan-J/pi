import type { Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { anchorAnthropicCacheBeforeEphemeralTail } from "./cache-anchor.ts";
import type { ModelRoute, ModelRouteToolChoice } from "./types.ts";

function hasNonEmptyEphemeralTail(tail: ModelRoute["ephemeralTail"]): tail is string | readonly Message[] {
	return tail !== undefined && (typeof tail === "string" ? tail.length > 0 : tail.length > 0);
}

function withGeminiAnyToolConfig(target: Record<string, unknown>): Record<string, unknown> {
	const existingConfig =
		target.toolConfig && typeof target.toolConfig === "object" && !Array.isArray(target.toolConfig)
			? (target.toolConfig as Record<string, unknown>)
			: {};
	const existingFnConfig =
		existingConfig.functionCallingConfig &&
		typeof existingConfig.functionCallingConfig === "object" &&
		!Array.isArray(existingConfig.functionCallingConfig)
			? (existingConfig.functionCallingConfig as Record<string, unknown>)
			: {};
	return {
		...target,
		toolConfig: {
			...existingConfig,
			functionCallingConfig: { ...existingFnConfig, mode: "ANY" },
		},
	};
}

/** Rewrite wire payload when `toolChoice: "required"` targets APIs with vendor-specific syntax. */
export function applyRequiredToolChoicePayload(
	payload: unknown,
	api: string,
	modelMeta?: { provider?: string; baseUrl?: string },
): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	if (api === "anthropic-messages") {
		const { thinking: _thinking, output_config: _outputConfig, ...rest } = record;
		return { ...rest, tool_choice: { type: "any" } };
	}
	if (api === "antigravity-api" || api === "antigravity") {
		if (record.request && typeof record.request === "object" && !Array.isArray(record.request)) {
			return { ...record, request: withGeminiAnyToolConfig(record.request as Record<string, unknown>) };
		}
		return withGeminiAnyToolConfig(record);
	}
	if (api === "google-generative-ai" || api === "google-vertex") {
		return withGeminiAnyToolConfig(record);
	}
	if (api === "bedrock-converse-stream") {
		const existingConfig =
			record.toolConfig && typeof record.toolConfig === "object" && !Array.isArray(record.toolConfig)
				? (record.toolConfig as Record<string, unknown>)
				: undefined;
		if (!existingConfig) return payload;
		return {
			...record,
			toolConfig: { ...existingConfig, toolChoice: { any: {} } },
		};
	}
	if (modelMeta?.provider === "meta" || modelMeta?.baseUrl?.includes("api.meta.ai")) {
		return payload;
	}
	return { ...record, tool_choice: "required" };
}

/** Build `SimpleStreamOptions` for one physical route, applying caps, temperature, session overrides, and `toolChoice`. */
export function buildRoutedStreamOptions(
	baseOptions: SimpleStreamOptions | undefined,
	route: ModelRoute,
): SimpleStreamOptions {
	const modelLimit = route.model.maxTokens;
	const requestedMax = route.maxTokens ?? baseOptions?.maxTokens;
	const maxTokens = requestedMax !== undefined && modelLimit > 0 ? Math.min(requestedMax, modelLimit) : requestedMax;
	const clampedLevel = clampThinkingLevel(route.model, route.thinkingLevel);
	const reasoning = clampedLevel === "off" ? undefined : clampedLevel;
	const toolChoice: ModelRouteToolChoice | undefined = route.toolChoice;
	const simpleToolChoice = toolChoice === "auto" || toolChoice === "none" ? toolChoice : baseOptions?.toolChoice;
	const hasTail = hasNonEmptyEphemeralTail(route.ephemeralTail);
	const previousOnPayload = baseOptions?.onPayload;
	const onPayload: SimpleStreamOptions["onPayload"] =
		toolChoice === "required" || hasTail
			? async (payload, model) => {
					let shaped = payload;
					if (hasTail && route.ephemeralTail !== undefined && model.api === "anthropic-messages") {
						shaped = anchorAnthropicCacheBeforeEphemeralTail(shaped, route.ephemeralTail);
					}
					if (toolChoice === "required") {
						shaped = applyRequiredToolChoicePayload(shaped, model.api, model);
					}
					return previousOnPayload ? await previousOnPayload(shaped, model) : shaped;
				}
			: previousOnPayload;

	return {
		...baseOptions,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
		...(route.sessionId !== undefined ? { sessionId: route.sessionId } : {}),
		...(route.disableContinuation !== undefined ? { disableContinuation: route.disableContinuation } : {}),
		reasoning,
		...(simpleToolChoice !== undefined ? { toolChoice: simpleToolChoice } : {}),
		...(onPayload ? { onPayload } : {}),
	};
}
