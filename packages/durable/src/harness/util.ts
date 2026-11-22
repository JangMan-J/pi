import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { VirtualModels, VirtualStreamRequestScope } from "@earendil-works/pi-ai/virtual-models";
import { SessionFailed } from "../errors.ts";
import type { ConversationId, Cursor, EntryQuery, Page } from "../types.ts";

/** Pending waits by key. Each settles once: through `resolve`, `rejectAll`, or cancellation of its context. */
export class Waiters<K, T> {
	readonly #sets = new Map<K, Set<PromiseWithResolvers<T>>>();

	add(key: K, context: Context): Promise<T> {
		const signal = context.abortSignal;
		const waiter = Promise.withResolvers<T>();
		// Callers may hand the promise out only after later awaits (a job's result on the line): handled now, so a
		// rejection before then is not reported unhandled. The caller still gets it.
		waiter.promise.catch(() => {});
		if (signal?.aborted) {
			waiter.reject(signal.reason);
			return waiter.promise;
		}
		const set = this.#sets.get(key) ?? new Set();
		this.#sets.set(key, set.add(waiter));
		if (signal !== undefined) {
			const onAbort = (): void => {
				set.delete(waiter);
				if (set.size === 0 && this.#sets.get(key) === set) this.#sets.delete(key);
				waiter.reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			const detach = (): void => signal.removeEventListener("abort", onAbort);
			waiter.promise.then(detach, detach);
		}
		return waiter.promise;
	}

	keys(): K[] {
		return [...this.#sets.keys()];
	}

	resolve(key: K, value: T): void {
		const set = this.#sets.get(key);
		this.#sets.delete(key);
		for (const waiter of set ?? []) waiter.resolve(value);
	}

	rejectAll(error: unknown): void {
		const sets = [...this.#sets.values()];
		this.#sets.clear();
		for (const set of sets) for (const waiter of set) waiter.reject(error);
	}
}

/** Every item of a paginated scan, in page order. */
export async function scanAll<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await scan(cursor);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items;
}

/** What a closed Harness rejects with: `SessionFailed` with the cause when it closed because the Session failed. */
export function closedError(session: { readonly failure: { readonly error: unknown } | undefined }): Error {
	const failure = session.failure;
	return failure === undefined ? new Error("Harness is closed") : new SessionFailed(failure.error);
}

/** `{ extension }` when the extension is known. */
export function optionalExtension(extension: string | undefined): { readonly extension?: string } {
	return extension === undefined ? {} : { extension };
}

/** The scan of conversation `conversationId`'s history that `query` asks for, without fields an untyped caller added. */
export function conversationEntries(
	conversationId: ConversationId,
	query: Omit<EntryQuery, "conversationId">,
): EntryQuery {
	return {
		conversationId,
		...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
		...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
		...(query.order === undefined ? {} : { order: query.order }),
	};
}

const VIRTUAL_REQUEST_SCOPE_SYMBOL = Symbol.for("pi-ai.virtualRequestScope");

/** Lightweight check (type-only import) avoiding transitive graph bloat on built-in entry points. */
export function isVirtualModel(model: { readonly api: string }): boolean {
	return model.api === "pi-virtual";
}

/** Structural type guard matching `@earendil-works/pi-ai/virtual-models`'s `VirtualModels` wrapper. */
export function isVirtualModelsRuntime(models: Models): models is VirtualModels {
	return (
		"prepareVirtualRoute" in models &&
		typeof (models as VirtualModels).prepareVirtualRoute === "function" &&
		"registerVirtualModel" in models &&
		typeof (models as VirtualModels).registerVirtualModel === "function"
	);
}

/** Attach virtual request metadata without adding runtime edges from `pi-ai/virtual-models` to core entries. */
export function attachVirtualRequestScope<TOptions extends object>(
	options: TOptions,
	scope: VirtualStreamRequestScope,
): TOptions {
	return { ...options, [VIRTUAL_REQUEST_SCOPE_SYMBOL]: scope };
}

/** Read attached virtual request metadata placed by `attachVirtualRequestScope`. */
export function getVirtualRequestScope(carrier: object | undefined): VirtualStreamRequestScope | undefined {
	if (!carrier || typeof carrier !== "object") return undefined;
	return (carrier as { [VIRTUAL_REQUEST_SCOPE_SYMBOL]?: VirtualStreamRequestScope })[VIRTUAL_REQUEST_SCOPE_SYMBOL];
}
