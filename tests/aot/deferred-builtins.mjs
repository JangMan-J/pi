// A module loaded later (`import()`) that imports builtin modules: an executable compiled ahead of time requires them when that
// module is evaluated, not at its start. Default, named and namespace imports, in functions that are hoisted out of the module's
// wrapper and in a class that extends one, must read as they do when they are imported.
import { readFileSync } from "node:fs";
console.log("start", typeof readFileSync);
const mod = await import("./deferred-builtins-mod.mjs");
console.log(mod.describe());
console.log(mod.gz, mod.default, mod.namespace());
const emitter = new mod.Emitter();
let got = 0;
emitter.on("ping", (value) => (got = value));
emitter.ping();
console.log("ping", got, emitter instanceof (await import("node:events")).EventEmitter);
const again = await import("./deferred-builtins-mod.mjs");
console.log("same module", again === mod, again.describe() === mod.describe());
