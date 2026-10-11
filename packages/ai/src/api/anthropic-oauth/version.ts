// Version comparison and recovery adapted from @gotgenes/pi-anthropic-auth
// 3.4.2 (MIT, Christopher D. Lasher). See LICENSE in this directory.
import type { ProviderEnv } from "../../types.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";

const BUNDLED_VERSION = "2.1.280";
export const CLAUDE_CODE_VERSION_ENV = "PI_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION";
const VERSION = /^\d+\.\d+\.\d+$/;
let learnedFloor = BUNDLED_VERSION;

function higherVersion(baseline: string, candidate: string): string {
	const a = baseline.split(".").map(Number);
	const b = candidate.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return b[i]! > a[i]! ? candidate : baseline;
	}
	return baseline;
}

export function resolveClaudeCodeVersion(env?: ProviderEnv): string {
	const override = getProviderEnvValue(CLAUDE_CODE_VERSION_ENV, env)?.trim();
	if (!override) return learnedFloor;
	if (!VERSION.test(override)) throw new Error(`${CLAUDE_CODE_VERSION_ENV} must be a bare X.Y.Z version`);
	return override;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return one higher named floor, or throw the original error with a recovery hint. */
export function recoverClaudeCodeVersion(
	error: unknown,
	sentVersion: string,
	recovered: boolean,
	env?: ProviderEnv,
): string {
	if (
		!(error instanceof Error) ||
		!("status" in error) ||
		error.status !== 400 ||
		!("error" in error) ||
		!isRecord(error.error)
	)
		throw error;
	const detail = error.error.error;
	if (!isRecord(detail) || !isRecord(detail.details) || detail.details.error_code !== "claude_code_version_too_old")
		throw error;
	const required =
		typeof detail.message === "string"
			? /version (\d+\.\d+\.\d+) or newer is required/.exec(detail.message)?.[1]
			: undefined;
	const override = getProviderEnvValue(CLAUDE_CODE_VERSION_ENV, env)?.trim();
	if (!override && required) {
		learnedFloor = higherVersion(learnedFloor, required);
		if (!recovered && higherVersion(sentVersion, required) !== sentVersion) return learnedFloor;
	}
	const target = required ?? "the current Claude Code release";
	error.message += override
		? ` ${CLAUDE_CODE_VERSION_ENV}=${override} is pinned; raise it to ${target}, or unset it for automatic recovery.`
		: ` Automatic version recovery did not succeed; update pi-ai or set ${CLAUDE_CODE_VERSION_ENV} to ${target}.`;
	throw error;
}
