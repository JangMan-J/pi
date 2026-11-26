/**
 * Cache-guarded fork with sliding-window & baton state controls, extracted from pi-durable's sliding-window harness
 * so `@earendil-works/pi-virtual-models/sliding-window` stands alone.
 */
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, type Conversation, type EntryId } from "@earendil-works/pi-durable";
import { BatonStateDoc, VirtualModelStateDoc } from "../durable/docs.ts";
import { copyParentProviderSession } from "../durable/fork-guard.ts";
import { SlidingWindowStateDoc, SlidingWindowTargetDoc, recordForkEnabledHint } from "./state.ts";
import type { SlidingWindowForkOptions } from "./types.ts";

/**
 * Create a cache-guarded fork with sliding-window & baton state controls.
 * Preserves provider session shard affinity (`copyProviderSession`), thinking epoch (`preserveThinkingLevel`),
 * frozen tool declarations + execution-time `allowedTools`, `disableContinuation`, and optional baton/window overrides.
 */
export async function createSlidingWindowFork(
	parent: Conversation,
	at: EntryId,
	options: SlidingWindowForkOptions,
	context: Context,
): Promise<Conversation> {
	const {
		copyProviderSession = true,
		preserveThinkingLevel = true,
		inheritBatonState = true,
		slidingWindow,
		target,
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

	const fork = await parent.fork(
		at,
		{
			...createOptions,
			init: async (tx, forkId) => {
				const sessionId = copyProviderSession ? await copyParentProviderSession(tx, parent.id, forkId) : undefined;
				const parentAgent = await tx.doc(AgentDoc, parent.id);
				const forkAgent = await tx.doc(AgentDoc, forkId);
				const epochLevel = parentThinkingLevel ?? parentAgent.thinkingLevel;
				const effectiveAllowFlip = allowThinkingEpochFlip === true || preserveThinkingLevel === false;
				const guardedLevel =
					!effectiveAllowFlip && epochLevel !== undefined && epochLevel !== "off"
						? (preservedThinkingLevel ?? epochLevel)
						: undefined;
				if (guardedLevel !== undefined && forkAgent.thinkingLevel === "off") {
					forkAgent.thinkingLevel = guardedLevel;
				}
				const vmState = await tx.doc(VirtualModelStateDoc, forkId);
				vmState.forkGuard = {
					disableContinuation,
					preserveToolDeclarations,
					...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
					...(blockedToolReason !== undefined ? { blockedToolReason } : {}),
					...(epochLevel !== undefined ? { parentThinkingLevel: epochLevel } : {}),
					...(guardedLevel !== undefined ? { preservedThinkingLevel: guardedLevel } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
				};
				if (inheritBatonState === false) {
					const baton = await tx.doc(BatonStateDoc, forkId);
					baton.epoch = 0;
					delete baton.anchorUser0;
					delete baton.handoffSummary;
					delete baton.swappedAtTokens;
					delete baton.data;
					delete baton.preparingTaskId;
					delete baton.staged;
					delete baton.harvestedStudyNotes;
				}
				if (slidingWindow !== undefined) {
					(await tx.doc(SlidingWindowStateDoc, forkId)).enabled = slidingWindow;
				}
				if (target !== undefined) {
					(await tx.doc(SlidingWindowTargetDoc, forkId)).target = target;
				}
				await init?.(tx, forkId);
			},
		},
		context,
	);
	if (slidingWindow !== undefined) {
		recordForkEnabledHint(fork.id, slidingWindow);
	}
	return fork;
}
