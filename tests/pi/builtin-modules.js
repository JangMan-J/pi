// An extension that loads, when it is loaded, builtin modules that Pi itself has not loaded by then: Pi's executable has code for
// them compiled ahead of time (parts of Pi that load later import them), which then runs for the first time here. Loading
// node:tls (and so node:http2) and node:querystring threw a ReferenceError from that code.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const loaded = [];
for (const name of ["node:tls", "node:http2", "node:https", "node:http", "node:net", "node:querystring", "node:zlib", "node:dgram", "node:readline"]) {
	const module = require(name);
	loaded.push(`${name.slice(5)}=${typeof module === "object" && Object.keys(module).length > 2}`);
}
const { parse } = require("node:querystring");
export default function () {
	console.log(`builtin-modules: ${loaded.join(" ")} parse=${parse("a=1&b=2").b}`);
	// (There is no model to answer the prompt.)
	process.exit(0);
}
