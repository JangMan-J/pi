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
import type {
	BetaContentBlockParam,
	BetaMessageParam,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { shapeSystemPrompt, shapeSystemUpdateText } from "./system-prompt-shaping.ts";

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

/** Called only for OAuth, after caller payload hooks. Safe to call again on recovery. */
export async function shapeOAuthPayload(
	params: MessageCreateParamsStreaming,
	version: string,
): Promise<MessageCreateParamsStreaming> {
	const messages = params.messages.flatMap((message): BetaMessageParam[] => {
		if (message.role !== "system" || !Array.isArray(message.content)) return [message];
		const content = message.content.flatMap<BetaContentBlockParam>((block) => {
			if (block.type !== "text") return [block];
			const text = shapeSystemUpdateText(block.text);
			return text === undefined ? [] : [{ ...block, text }];
		});
		// Empty system messages can still carry per-message reasoning effort.
		return content.length || message.output_config !== undefined ? [{ ...message, content }] : [];
	});
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
	return { ...params, messages, system };
}
