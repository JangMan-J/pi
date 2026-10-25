import type Anthropic from "@anthropic-ai/sdk";
import type {
	BetaCacheControlEphemeral,
	BetaContentBlockParam,
	BetaMessageParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ProviderEnv, ProviderHeaders } from "../../types.ts";
/*!
 * Adapted from @gotgenes/pi-anthropic-auth 3.4.2.
 * MIT License
 *
 * Copyright (c) 2026 Christopher D. Lasher
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { compatibleAnthropicToolChoice } from "../anthropic-tool-choice.ts";
import { claudeCodeSessionId } from "./session-id.ts";
import { shapeSystemPrompt, shapeSystemUpdateText } from "./system-prompt-shaping.ts";
import { recoverClaudeCodeVersion, resolveClaudeCodeVersion } from "./version.ts";

const BILLING_MARKER = "x-anthropic-billing-header:";

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildBillingHeader(text: string, version: string): Promise<string | undefined> {
	if (!text) return undefined;
	// These are JavaScript UTF-16 positions, not Unicode code-point positions.
	const sampled = [4, 7, 20].map((index) => text[index] || "0").join("");
	const cch = (await sha256(text)).slice(0, 5);
	const suffix = (await sha256(`59cf53e54c78${sampled}${version}`)).slice(0, 3);
	return `${BILLING_MARKER} cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

function restoreDroppedCacheControl(messages: BetaMessageParam[], cacheControl: BetaCacheControlEphemeral): void {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex]!;
		if (message.role !== "user" && message.role !== "system") continue;
		if (typeof message.content === "string") {
			message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
			return;
		}
		for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = message.content[blockIndex]!;
			if (
				block.type !== "text" &&
				block.type !== "image" &&
				block.type !== "tool_result" &&
				block.type !== "tool_addition" &&
				block.type !== "tool_removal"
			) {
				continue;
			}
			if (block.cache_control === undefined) block.cache_control = cacheControl;
			return;
		}
	}
}

/** Called only for OAuth, after caller payload hooks. Safe to call again on recovery. */
export async function shapeOAuthPayload(
	params: MessageCreateParamsStreaming,
	version: string,
): Promise<MessageCreateParamsStreaming> {
	let droppedCacheControl: BetaCacheControlEphemeral | null | undefined;
	const messages = params.messages.flatMap((message): BetaMessageParam[] => {
		if (message.role !== "system" || !Array.isArray(message.content)) return [message];
		const content = message.content.flatMap<BetaContentBlockParam>((block) => {
			if (block.type !== "text") return [block];
			const text = shapeSystemUpdateText(block.text);
			if (text === undefined) {
				droppedCacheControl ??= block.cache_control;
				return [];
			}
			return [{ ...block, text }];
		});
		// Empty system messages can still carry per-message reasoning effort.
		return content.length || message.output_config !== undefined ? [{ ...message, content }] : [];
	});
	if (droppedCacheControl) restoreDroppedCacheControl(messages, droppedCacheControl);
	const firstUser = messages.find((message) => message.role === "user");
	const firstText =
		typeof firstUser?.content === "string"
			? firstUser.content
			: firstUser?.content.find((block) => block.type === "text");
	const text = typeof firstText === "string" ? firstText : firstText?.type === "text" ? firstText.text : "";
	const billing = await buildBillingHeader(text, version);
	const blocks =
		typeof params.system === "string" ? [{ type: "text" as const, text: params.system }] : (params.system ?? []);
	const system = blocks
		.filter((block) => !block.text.startsWith(BILLING_MARKER))
		.map((block) => ({ ...block, text: shapeSystemPrompt(block.text) }));
	if (billing) system.unshift({ type: "text", text: billing });
	const toolChoice = compatibleAnthropicToolChoice(params);
	return {
		...params,
		messages,
		system,
		...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
	};
}

function buildOAuthRequestHeaders(
	oauthVersion: string,
	ccSessionId: string | undefined,
	...headerSources: (ProviderHeaders | undefined)[]
): ProviderHeaders {
	const merged = new Map<string, [string, string | null]>();
	merged.set("user-agent", ["user-agent", `claude-cli/${oauthVersion}`]);
	if (ccSessionId) {
		merged.set("x-claude-code-session-id", ["x-claude-code-session-id", ccSessionId]);
	}
	for (const headers of headerSources) {
		for (const [name, value] of Object.entries(headers ?? {})) {
			merged.set(name.toLowerCase(), [name, value]);
		}
	}
	return Object.fromEntries(merged.values());
}

/**
 * Self-contained OAuth request wrapper for `anthropic-messages.ts` so upstream
 * `anthropic-messages.ts` only needs a 2-line hook.
 */
export async function createAnthropicMessagesRequest(
	client: Anthropic,
	initialParams: MessageCreateParamsStreaming,
	requestOptions: { signal?: AbortSignal; timeout?: number; maxRetries?: number; headers?: ProviderHeaders },
	isOAuth: boolean,
	modelHeaders?: ProviderHeaders,
	options?: {
		env?: ProviderEnv;
		headers?: ProviderHeaders;
		sessionId?: string;
		signal?: AbortSignal;
	},
): Promise<() => Promise<Response>> {
	if (!isOAuth) {
		return () => client.beta.messages.create(initialParams, requestOptions).asResponse();
	}
	let oauthVersion = resolveClaudeCodeVersion(options?.env);
	const ccSessionId = await claudeCodeSessionId(options?.sessionId);
	let params = await shapeOAuthPayload(initialParams, oauthVersion);
	let headers = buildOAuthRequestHeaders(oauthVersion, ccSessionId, modelHeaders, options?.headers);
	let recoveredVersion = false;
	return async () => {
		for (;;) {
			try {
				return await client.beta.messages.create(params, { ...requestOptions, headers }).asResponse();
			} catch (error) {
				if (options?.signal?.aborted) throw error;
				oauthVersion = recoverClaudeCodeVersion(error, oauthVersion, recoveredVersion, options?.env);
				recoveredVersion = true;
				params = await shapeOAuthPayload(params, oauthVersion);
				headers = buildOAuthRequestHeaders(oauthVersion, ccSessionId, modelHeaders, options?.headers);
			}
		}
	};
}
