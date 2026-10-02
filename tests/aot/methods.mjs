// Method calls whose callee the compiler takes for the one function the program stores under the name (inlined behind a check
// that it is that function), and every way the guess can be wrong: another function under the same name made at run time, a
// method replaced, a name two classes share, a plain object with a function in that property, the method taken off its object,
// and bases that are not objects.
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));

const helpers = { isSpace(c) { return c === 32 || (c >= 9 && c <= 13) || c === 160; }, twice(n) { return this.plus(n, n); }, plus(a, b) { return a + b; } };
class Vec {
	constructor(x, y) { this.x = x; this.y = y; }
	add(o) { return new Vec(this.x + o.x, this.y + o.y); }
	len2() { return this.x * this.x + this.y * this.y; }
	scale(k = 2) { return new Vec(this.x * k, this.y * k); }
	toString() { return `(${this.x}, ${this.y})`; }
}
class Shape { area() { return 0; } describe() { return `${this.constructor.name} of area ${this.area()}`; } }
class Sq extends Shape { constructor(s) { super(); this.s = s; } area() { return this.s * this.s; } }
class Rect extends Shape { constructor(w, h) { super(); this.w = w; this.h = h; } area() { return this.w * this.h; } }
class Counter { constructor() { this.n = 0; } bump() { this.n++; return this; } get value() { return this.n; } }
class Thrower { fail(what) { throw new RangeError("failed: " + what); } safe(what) { try { return this.fail(what); } catch (e) { return e.message; } } }
class Recursive { fact(n) { return n <= 1 ? 1 : n * this.fact(n - 1); } }
class Variadic { count() { return arguments.length; } rest(...a) { return a.length; } }

const text = "lorem ipsum\tdolor sit amet,\nconsectetur adipiscing elit  ".repeat(2000);
function countSpaces() { let n = 0; for (let i = 0; i < text.length; i++) if (helpers.isSpace(text.charCodeAt(i))) n++; return n; }
function sumVec() { let v = new Vec(0, 0); const d = new Vec(1, 2); for (let i = 0; i < 10000; i++) v = v.add(d); return v.len2(); }

log("object literal method:", countSpaces());
log("method calling a method on this:", helpers.twice(21));
log("class methods:", sumVec(), new Vec(1, 2).scale().toString(), new Vec(1, 2).scale(3).toString());
log("shared name, two classes:", [new Sq(3), new Rect(2, 5), new Shape()].map((s) => s.area()).join(","), new Sq(2).describe());
log("chained, getter:", new Counter().bump().bump().value);
log("throws:", new Thrower().safe("x"));
try {
	new Thrower().fail("y");
} catch (e) {
	log("uncaught in caller:", e.constructor.name, e.message);
}
log("recursion:", new Recursive().fact(10));
log("arguments:", new Variadic().count(1, 2, 3), new Variadic().rest(1, 2));
log("fewer and more arguments:", new Vec(1, 1).add({ x: 1 }).toString(), helpers.plus(1, 2, 3));

// The guess is wrong: the check must fail and the call be made.
const other = { isSpace(c) { return c === 65; } }; // Another function under the same name, so `isSpace` is no longer unique.
log("same name elsewhere:", other.isSpace(65), helpers.isSpace(65));
const runtime = { len2: () => "runtime", add: Function("o", "return 'made at run time'") };
log("made at run time:", runtime.len2(), runtime.add({}));
const v = new Vec(3, 4);
log("before replacement:", v.len2());
Vec.prototype.len2 = function () { return -1; };
log("after replacement on the prototype:", v.len2());
v.len2 = () => "own";
log("after an own property:", v.len2());
const plain = { x: 1, y: 2, len2: 42 };
try {
	plain.len2();
} catch (e) {
	log("not a function:", e.constructor.name);
}
const detached = helpers.twice;
try {
	detached(1);
} catch (e) {
	log("detached, this undefined:", e.constructor.name);
}
log("call/apply:", helpers.plus.call(null, 2, 3), helpers.plus.apply(null, [4, 5]));
for (const base of [null, undefined, 1, "s"]) {
	try {
		base.len2();
		log("base", typeof base, "did not throw");
	} catch (e) {
		log("base", String(base), e.constructor.name);
	}
}
log("string method of the same name as a class method:", "abc".toString(), new Vec(0, 0).toString());

// A method defined in a loop body, and one defined inside a function (its scope is not the module's).
function makeAdder(k) { return { addK(n) { return n + k; } }; }
log("closure method:", makeAdder(5).addK(1), makeAdder(7).addK(1));
console.log(out.join("\n"));
