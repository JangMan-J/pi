import type { CacheRetention, ProviderEnv } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";

export const DEFAULT_SSE_URL = "https://api.x.ai/v1/responses";
export const DEFAULT_LIVENESS_TIMEOUT_MS = 60_000;
export const DEFAULT_LOOP_NOVELTY_THRESHOLD = 0.85;
export const DEFAULT_LOOP_RECOVERY_LIMIT = 2;
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_DOOM_LOOP_CHECK_WINDOW = "1024";
export const DEFAULT_EXACT_REPETITION_CHECK_WINDOW = "64";

function positiveInteger(value: string | undefined): number | undefined {
	if (!value || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: string | undefined): number | undefined {
	if (!value || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function ratio(value: string | undefined): number | undefined {
	if (!value || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

export function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) return cacheRetention;
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
	return "short";
}

export function cacheAffinityEnabled(cacheRetention?: CacheRetention, env?: ProviderEnv): boolean {
	return resolveCacheRetention(cacheRetention, env) !== "none";
}

export function storeResponsesEnabled(env?: ProviderEnv): boolean {
	const raw = getProviderEnvValue("PI_XAI_WS_STORE", env) ?? getProviderEnvValue("PI_XAI_STORE", env);
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
}

export function doomLoopCheckEnabled(env?: ProviderEnv): boolean {
	const raw = getProviderEnvValue("PI_XAI_DOOM_LOOP_CHECK", env);
	if (!raw) return true;
	const normalized = raw.trim().toLowerCase();
	return normalized !== "0" && normalized !== "false";
}

export function resolveLoopNoveltyThreshold(env?: ProviderEnv): number {
	return (
		ratio(getProviderEnvValue("PI_XAI_WS_LOOP_NOVELTY_THRESHOLD", env)) ??
		ratio(getProviderEnvValue("PI_XAI_LOOP_NOVELTY_THRESHOLD", env)) ??
		DEFAULT_LOOP_NOVELTY_THRESHOLD
	);
}

export function resolveLoopRecoveryLimit(env?: ProviderEnv): number {
	return (
		nonNegativeInteger(getProviderEnvValue("PI_XAI_WS_LOOP_RECOVERY_LIMIT", env)) ??
		nonNegativeInteger(getProviderEnvValue("PI_XAI_LOOP_RECOVERY_LIMIT", env)) ??
		DEFAULT_LOOP_RECOVERY_LIMIT
	);
}

export function resolveMaxStoredContextTokens(env?: ProviderEnv): number | undefined {
	return (
		positiveInteger(getProviderEnvValue("PI_XAI_WS_MAX_STORED_CONTEXT_TOKENS", env)) ??
		positiveInteger(getProviderEnvValue("PI_XAI_MAX_STORED_CONTEXT_TOKENS", env))
	);
}

export function resolveMaxRequestImageBytes(env?: ProviderEnv): number {
	return (
		positiveInteger(getProviderEnvValue("PI_XAI_WS_MAX_REQUEST_IMAGE_BYTES", env)) ??
		positiveInteger(getProviderEnvValue("PI_XAI_MAX_REQUEST_IMAGE_BYTES", env)) ??
		DEFAULT_MAX_REQUEST_IMAGE_BYTES
	);
}

export function resolveSseUrl(baseUrl?: string, env?: ProviderEnv): string {
	const explicit =
		getProviderEnvValue("PI_XAI_SSE_URL", env)?.trim() || getProviderEnvValue("PI_XAI_WS_URL", env)?.trim();
	if (explicit) {
		return explicit.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
	}
	if (!baseUrl) {
		return DEFAULT_SSE_URL;
	}
	const http = new URL(baseUrl);
	http.protocol = http.protocol === "http:" || http.protocol === "ws:" ? "http:" : "https:";
	const path = http.pathname.replace(/\/$/, "") || "/v1";
	http.pathname = path.endsWith("/responses") ? path : `${path}/responses`;
	http.search = "";
	http.hash = "";
	return http.toString();
}

export function resolveLivenessTimeoutMs(streamTimeoutMs?: number, env?: ProviderEnv): number {
	const explicit =
		positiveInteger(getProviderEnvValue("PI_XAI_SSE_LIVENESS_TIMEOUT_MS", env)) ??
		positiveInteger(getProviderEnvValue("PI_XAI_WS_LIVENESS_TIMEOUT_MS", env));
	if (explicit !== undefined) {
		return explicit;
	}
	if (typeof streamTimeoutMs === "number" && Number.isFinite(streamTimeoutMs) && streamTimeoutMs > 0) {
		return Math.floor(streamTimeoutMs);
	}
	return DEFAULT_LIVENESS_TIMEOUT_MS;
}

export function debugEnabled(env?: ProviderEnv): boolean {
	return getProviderEnvValue("PI_XAI_WS_DEBUG", env) === "1" || getProviderEnvValue("PI_XAI_DEBUG", env) === "1";
}
