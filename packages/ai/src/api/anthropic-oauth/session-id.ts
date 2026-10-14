// Claude Code sends `x-claude-code-session-id`: a random UUIDv4 that stays the same for one
// session, including across resume. Derive a v4-shaped UUID from the caller's session ID so it
// is stable the same way. Callers without a session ID share one ID per process, like a one-shot
// `claude -p` run.
let processSessionId: string | undefined;

export async function claudeCodeSessionId(sessionId?: string): Promise<string> {
	if (!sessionId) {
		processSessionId ??= crypto.randomUUID();
		return processSessionId;
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
	const bytes = new Uint8Array(digest, 0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
