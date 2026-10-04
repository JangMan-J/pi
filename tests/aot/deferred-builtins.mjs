// Modules loaded later (`import()`) that import builtin modules: an executable compiled ahead of time requires those when the
// module is evaluated, not at its start. Default, named and namespace imports, in functions that are hoisted out of the module's
// wrapper and in a class that extends one, must read as they do when they are imported; so must what the modules export again,
// what a module in a cycle uses of them before the importer's own code has run, and names kept from before a builtin was patched.
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
console.log("network modules", mod.network());
console.log("patched", mod.patchAndCall());
console.log("bun's own", mod.buns());
console.log("process", mod.processes());
const user = await import("./deferred-builtins-user.mjs");
console.log("exported again", user.viaReexport(), user.join("own", "join"));
const barrel = await import("./deferred-builtins-barrel.mjs");
console.log("barrel", typeof barrel.join, typeof barrel.EE, typeof barrel.star.sep);
const cycle = await import("./deferred-builtins-cycle-a.mjs");
console.log("cycle", cycle.value);
