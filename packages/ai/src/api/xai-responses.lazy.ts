import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const xaiResponsesApi = (): ProviderStreams => lazyApi(() => import("./xai-responses/index.ts"));
