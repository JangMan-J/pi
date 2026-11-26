/**
 * Cache-guarded fork helpers for virtual-model routing, extracted from pi-durable's durable virtual-model harness
 * so `@earendil-works/pi-virtual-models/durable` stands alone: no legacy re-export or `node:` imports beyond the
 * durable substrate itself.
 */
import type { Context } from "@earendil-works/chord/context";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type Conversation,
	type ConversationCreateOptions,
	type ConversationId,
	type EntryId,
	ProviderDoc,
	type Tx,
} from "@earendil-works/pi-durable";
import type { ModelRoute } from "../core/types.ts";
import { type CacheGuardedForkOptions, type ForkCacheGuard, VirtualModelStateDoc } from "./docs.ts";

export type { CacheGuardedForkOptions };

/**
 * Copy Ring 1's `ProviderDoc.sessionId` onto a forked conversation inside its atomic `init` commit,
 * keeping gateway/shard routing (`x-meta-ai-gateway-session-id`, Kimi `prompt_cache_key`) on the warm shard.
 */
export async function copyParentProviderSession(
	tx: Tx,
	parentId: ConversationId,
	forkId: ConversationId,
): Promise<string | undefined> {
	const parentSessionId = (await tx.doc(ProviderDoc, parentId)).sessionId;
	if (parentSessionId !== undefined) {
		(await tx.doc(ProviderDoc, forkId)).sessionId = parentSessionId;
	}
	return parentSessionId;
}

/** Apply `ForkCacheGuard` and inherited `sessionId` constraints onto a resolved `ModelRoute`. */
export function applyForkGuardToRoute(
	route: ModelRoute,
	guard: ForkCacheGuard | undefined,
	sessionId?: string,
): ModelRoute {
	if (!guard && !sessionId) return route;
	const guardedThinking =
		guard?.preservedThinkingLevel !== undefined && route.thinkingLevel === "off"
			? guard.preservedThinkingLevel
			: route.thinkingLevel;
	const effectiveSession = route.sessionId ?? guard?.sessionId ?? sessionId;
	return {
		...route,
		thinkingLevel: guardedThinking,
		...(effectiveSession !== undefined ? { sessionId: effectiveSession } : {}),
		...(route.disableContinuation === true || guard?.disableContinuation !== undefined
			? { disableContinuation: route.disableContinuation === true || guard?.disableContinuation === true }
			: {}),
		...(guard?.preserveToolDeclarations !== undefined
			? { preserveToolDeclarations: guard.preserveToolDeclarations }
			: {}),
		...(guard?.allowedTools !== undefined ? { allowedTools: guard.allowedTools } : {}),
		...(guard?.blockedToolReason !== undefined ? { blockedToolReason: guard.blockedToolReason } : {}),
	};
}

/**
 * Fork a conversation while preserving Ring 1's `ProviderDoc.sessionId`, disabling wire continuation mismatch
 * (`disableContinuation: true`), freezing declared tool schemas (`preserveToolDeclarations: true`), and guarding
 * non-`"off"` thinking epochs (Kimi K3 `keep: "all"` invariant).
 */
export async function createCacheGuardedFork(
	parent: Conversation,
	at: EntryId,
	options: CacheGuardedForkOptions,
	context: Context,
): Promise<Conversation> {
	const {
		parentThinkingLevel,
		preservedThinkingLevel,
		allowThinkingEpochFlip,
		allowedTools,
		blockedToolReason,
		disableContinuation = true,
		preserveToolDeclarations = true,
		init,
		...createOptions
	} = options;

	return parent.fork(
		at,
		{
			...createOptions,
			init: async (tx, forkId) => {
				const sessionId = await copyParentProviderSession(tx, parent.id, forkId);
				const parentAgent = await tx.doc(AgentDoc, parent.id);
				const forkAgent = await tx.doc(AgentDoc, forkId);
				const epochLevel = parentThinkingLevel ?? parentAgent.thinkingLevel;
				const guardedLevel =
					!allowThinkingEpochFlip && epochLevel !== undefined && epochLevel !== "off"
						? (preservedThinkingLevel ?? epochLevel)
						: undefined;
				if (guardedLevel !== undefined && forkAgent.thinkingLevel === "off") {
					forkAgent.thinkingLevel = guardedLevel;
				}
				const state = await tx.doc(VirtualModelStateDoc, forkId);
				state.forkGuard = {
					disableContinuation,
					preserveToolDeclarations,
					...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
					...(blockedToolReason !== undefined ? { blockedToolReason } : {}),
					...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
					...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
				};
				await init?.(tx, forkId);
			},
		},
		context,
	);
}
