import { join as joinPaths, EE } from "./deferred-builtins-barrel.mjs";
import { sep } from "node:path";
// (A function of its own with the name another module imports a builtin's by.)
export function join(a, b) {
  return `${a}+${b}`;
}
export function viaReexport() {
  return [joinPaths("a", "b"), typeof EE, sep.length].join(" ");
}
