import type { AnyTask, GenerationHooks } from "@earendil-works/pi-durable";
import type { SlidingWindowState } from "./state.ts";

export interface BatonLifecycle {
	readonly tasks: readonly AnyTask[];
	readonly hooks: Partial<GenerationHooks>;
}

export function createBatonLifecycle(_state: SlidingWindowState): BatonLifecycle {
	throw new Error("createBatonLifecycle is not implemented yet (S17)");
}
