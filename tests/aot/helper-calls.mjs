// Calls to helpers in hot loops: function declarations, arrow functions in module constants (inlined behind a check that the
// constant is initialized), methods, and the cases where the check must fail: a call before initialization, a `var` that still
// holds undefined, a reassigned `let`.
// (Before initialization, the source throws a ReferenceError and the bundle a TypeError: `bun build` makes a top-level `const` a `var`.)
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));
const thrown = (e) => (e instanceof TypeError || e instanceof ReferenceError ? "throws" : "throws " + e);

function early() {
	try {
		return String(isSpaceArrow(32));
	} catch (e) {
		return thrown(e);
	}
}
function peek() {
	try {
		return typeof isSpaceArrow === "function" ? "function" : "not yet";
	} catch {
		return "not yet";
	}
}
log("read before initialization:", peek());
log("before initialization:", early());
try {
	lateVar(1);
} catch (e) {
	log("var before assignment:", thrown(e));
}

function isSpaceFn(c) { return c === 32 || (c >= 9 && c <= 13) || c === 160; }
const isSpaceArrow = (c) => c === 32 || (c >= 9 && c <= 13) || c === 160;
const weight = (c, k) => (c & 7) * k + (c >> 4);
var lateVar = (x) => x + 1;
let swapped = (c) => c + 1;
const helpers = { isSpace(c) { return c === 32 || (c >= 9 && c <= 13) || c === 160; } };

const text = "lorem ipsum\tdolor sit amet,\nconsectetur adipiscing elit  ".repeat(2000);
function countWith(f) { let n = 0; for (let i = 0; i < text.length; i++) if (f === 0 ? isSpaceFn(text.charCodeAt(i)) : isSpaceArrow(text.charCodeAt(i))) n++; return n; }
function viaMethod() { let n = 0; for (let i = 0; i < text.length; i++) if (helpers.isSpace(text.charCodeAt(i))) n++; return n; }
function sumWeights() { let s = 0; for (let i = 0; i < text.length; i++) s += weight(text.charCodeAt(i), i & 3); return s; }
function useSwapped() { let s = 0; for (let i = 0; i < 1000; i++) s += swapped(i); return s; }

log("declaration:", countWith(0));
log("arrow:", countWith(1));
log("method:", viaMethod());
log("two arguments:", sumWeights());
log("after initialization:", early(), peek());
log("let before:", useSwapped());
swapped = (c) => c * 2;
log("let after reassignment:", useSwapped());
helpers.isSpace = (c) => c === 97;
log("method after reassignment:", viaMethod());
log("var after assignment:", lateVar(41));
console.log(out.join("\n"));
