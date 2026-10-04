import { fromB } from "./deferred-builtins-cycle-b.mjs";
import { join } from "node:path";
export function helper() {
  return join("x", "y");
}
export const value = fromB;
