/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// Preferred so the port can be forwarded into containers or over SSH. Anthropic accepts any loopback port,
// so login falls back to a free port when this one cannot be bound (#10571).
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_BROWSER_LOGIN_METHOD = "browser";
const ANTHROPIC_COPY_CODE_LOGIN_METHOD = "copy_code";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

function oauthErrorDescription(responseBody: string): string | undefined {
	try {
		const body = JSON.parse(responseBody) as { error?: unknown; error_description?: unknown };
		const description = body.error_description ?? body.error;
		return typeof description === "string" ? description.slice(0, 300) : undefined;
	} catch {
		return undefined;
	}
}

async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		const description = oauthErrorDescription(responseBody);
		throw new Error(
			`HTTP request failed. status=${response.status}; url=${url}${description ? `; error=${description}` : ""}`,
		);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	return parseOAuthCredential(responseBody, "Token exchange");
}

function parseOAuthCredential(
	responseBody: string,
	operation: "Token exchange" | "Token refresh",
	previousRefreshToken?: string,
): OAuthCredential {
	let data: unknown;
	try {
		data = JSON.parse(responseBody);
	} catch {
		throw new Error(`${operation} returned invalid JSON. url=${TOKEN_URL}`);
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${operation} returned an invalid token response. url=${TOKEN_URL}`);
	}
	const {
		access_token: access,
		refresh_token: rotatedRefresh,
		expires_in: expiresIn,
	} = data as Record<string, unknown>;
	if (
		typeof access !== "string" ||
		access.trim().length === 0 ||
		(rotatedRefresh !== undefined && (typeof rotatedRefresh !== "string" || rotatedRefresh.trim().length === 0)) ||
		(previousRefreshToken === undefined && typeof rotatedRefresh !== "string") ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`${operation} returned an invalid token response. url=${TOKEN_URL}`);
	}
	const refresh = rotatedRefresh ?? previousRefreshToken;
	const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
	if (!refresh || !Number.isFinite(expires)) {
		throw new Error(`${operation} returned an invalid token response. url=${TOKEN_URL}`);
	}
	return { type: "oauth", access, refresh, expires };
}

async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Anthropic",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state,
			complete: async (code) => code,
			signal: interaction.signal,
		});
	// Without a callback server, login continues with the pasted redirect URL.
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => {
			interaction.signal.throwIfAborted();
			return startCallbackServer(0);
		})
		.catch(() => {
			interaction.signal.throwIfAborted();
			return undefined;
		});
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
		});
		let code: string | undefined;
		let responseState: string = state;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
			code = parsed.code;
			responseState = parsed.state ?? state;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, responseState, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

async function loginAnthropicCopyCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.signal.throwIfAborted();
	const { verifier, challenge } = await generatePKCE();
	const state = crypto.randomUUID();
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: COPY_CODE_REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
	});
	interaction.notify({
		type: "auth_url",
		url: `${AUTHORIZE_URL}?${authParams.toString()}`,
		instructions: "Complete login in your browser, then copy the code Anthropic shows and paste it here.",
	});

	const input = await interaction.prompt({
		type: "manual_code",
		message: "Paste the code Anthropic shows after you sign in:",
		placeholder: "code#state",
		signal: interaction.signal,
	});
	const parsed = parseAuthorizationInput(input);
	if (parsed.state && parsed.state !== state) throw new Error("OAuth state mismatch");
	if (!parsed.code) throw new Error("Missing authorization code");
	interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
	return await exchangeAuthorizationCode(
		parsed.code,
		parsed.state ?? state,
		verifier,
		COPY_CODE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * Refresh Anthropic OAuth token
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	// Refresh token rotation is optional; an omitted token means the old one remains valid.
	return parseOAuthCredential(responseBody, "Token refresh", refreshToken);
}

export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	isSubscription: true,

	async login(interaction) {
		const method = await interaction.prompt({
			type: "select",
			message: "Select Anthropic login method:",
			options: [
				{ id: ANTHROPIC_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: ANTHROPIC_COPY_CODE_LOGIN_METHOD, label: "Copy code login (headless)" },
			],
		});

		if (method === ANTHROPIC_COPY_CODE_LOGIN_METHOD) {
			return loginAnthropicCopyCode(interaction);
		}
		if (method !== ANTHROPIC_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown Anthropic login method: ${method}`);
		}

		return loginAnthropic(interaction);
	},

	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
