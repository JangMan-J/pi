import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import type { OAuthCredential } from "../src/auth/types.ts";

const signal = new AbortController().signal;
const storedCredential: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "old-refresh",
	expires: 0,
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected OAuth operation to reject");
}

function refreshStoredCredential(): Promise<OAuthCredential> {
	return anthropicOAuth.refresh(storedCredential, signal);
}

function loginWithCopyCode(): Promise<OAuthCredential> {
	return anthropicOAuth.login({
		signal,
		notify: () => {},
		prompt: async (prompt) => (prompt.type === "select" ? "copy_code" : "authorization-code"),
	});
}

describe.sequential("Anthropic OAuth security and response validation", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses state independent of the PKCE verifier in copy-code login", async () => {
		let authUrl = "";
		let tokenBody: Record<string, string> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				tokenBody = JSON.parse(String(init?.body)) as Record<string, string>;
				return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
			}),
		);

		await anthropicOAuth.login({
			signal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type === "select") return "copy_code";
				return `authorization-code#${new URL(authUrl).searchParams.get("state")}`;
			},
		});

		const state = new URL(authUrl).searchParams.get("state");
		expect(state).toBeTruthy();
		expect(tokenBody.state).toBe(state);
		expect(tokenBody.code_verifier).toBeTruthy();
		expect(tokenBody.code_verifier).not.toBe(state);
	});

	it.each(["browser", "copy_code"])("rejects mismatched pasted state before token exchange (%s)", async (method) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const promise = anthropicOAuth.login({
			signal,
			notify: () => {},
			prompt: async (prompt) => (prompt.type === "select" ? method : "authorization-code#wrong-state"),
		});

		expect(await rejectionMessage(promise)).toContain("OAuth state mismatch");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not turn pre-aborted browser login into manual fallback", async () => {
		const controller = new AbortController();
		controller.abort();
		const notify = vi.fn();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const prompt = vi.fn(async () => "browser");

		const promise = anthropicOAuth.login({ signal: controller.signal, notify, prompt });

		expect(await rejectionMessage(promise)).toMatch(/abort|cancel/i);
		expect(notify).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it.each(["exchange", "refresh"])("does not expose non-2xx token response bodies (%s)", async (operation) => {
		const sentinel = `SECRET-${operation}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`{"access_token":"${sentinel}"}`, { status: 400 })),
		);

		const message = await rejectionMessage(operation === "refresh" ? refreshStoredCredential() : loginWithCopyCode());

		expect(message).toContain("400");
		expect(message).not.toContain(sentinel);
	});

	it.each(["exchange", "refresh"])("does not expose malformed JSON token bodies (%s)", async (operation) => {
		const sentinel = `SECRET-${operation}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(`{"access_token":"${sentinel}",`, { status: 200 })),
		);

		const message = await rejectionMessage(operation === "refresh" ? refreshStoredCredential() : loginWithCopyCode());

		expect(message).toContain("invalid JSON");
		expect(message).not.toContain(sentinel);
	});

	it.each([
		["a non-object", null],
		["a missing access token", { refresh_token: "rotated", expires_in: 3600 }],
		["an empty access token", { access_token: " ", expires_in: 3600 }],
		["a missing expiry", { access_token: "access" }],
		["a zero expiry", { access_token: "access", expires_in: 0 }],
		["a negative expiry", { access_token: "access", expires_in: -1 }],
		["a string expiry", { access_token: "access", expires_in: "3600" }],
		["an empty rotated refresh token", { access_token: "access", refresh_token: "", expires_in: 3600 }],
	])("rejects %s in a refresh response", async (_name, body) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse(body)),
		);

		expect(await rejectionMessage(refreshStoredCredential())).toContain("invalid token response");
	});

	it("rejects a non-finite refresh expiry", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"access_token":"access","expires_in":1e400}', { status: 200 })),
		);

		expect(await rejectionMessage(refreshStoredCredential())).toContain("invalid token response");
	});

	it("rejects an authorization exchange without a refresh token", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ access_token: "access", expires_in: 3600 })),
		);

		expect(await rejectionMessage(loginWithCopyCode())).toContain("invalid token response");
	});

	it("preserves an allowlisted OAuth error description without the raw body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ error: "invalid_grant", error_description: "Refresh token expired" }, 400)),
		);

		const message = await rejectionMessage(refreshStoredCredential());

		expect(message).toContain("400");
		expect(message).toContain("Refresh token expired");
	});
});
