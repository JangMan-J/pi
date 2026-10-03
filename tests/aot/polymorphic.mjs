// Method calls in loops whose name several functions have: checked for each in turn and made part of the loop, with the ordinary
// call when the callee is none of them. And the arithmetic around them: `%` of numbers that are not proven integers, `===` with
// an int32 on one side.
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));

class Shape { area() { return 0; } name() { return "shape"; } }
class Sq extends Shape { constructor(s) { super(); this.s = s; } area() { return this.s * this.s; } name() { return "sq"; } }
class Rect extends Shape { constructor(w, h) { super(); this.w = w; this.h = h; } area() { return this.w * this.h; } }
class Circ extends Shape { constructor(r) { super(); this.r = r; } area() { return 3 * this.r * this.r; } }
const lit = { area() { return 1000; } };
function sumAreas(list) { let s = 0; for (let i = 0; i < list.length; i++) s += list[i].area(); return s; }
function names(list) { let s = ""; for (let i = 0; i < list.length; i++) s += list[i].name()[0]; return s; }

const mixed = Array.from({ length: 3000 }, (_, i) => [new Sq(i % 10), new Rect(i % 7, 3), new Circ(i % 5), new Shape()][i % 4]);
log("mixed:", sumAreas(mixed), names(mixed.slice(0, 12)));
log("one kind:", sumAreas(mixed.filter((x) => x instanceof Sq)));
log("with a literal:", sumAreas([...mixed.slice(0, 8), lit, lit]));
// Not one of the functions: made at run time, an arrow, a bound function, a getter, a method replaced on an instance and on a class.
const odd = [new Sq(2), { area: Function("return 7") }, { area: () => 8 }, { area: Sq.prototype.area.bind(new Sq(3)) }];
log("not one of them:", sumAreas(odd));
const withGetter = { get area() { return () => 11; } };
log("getter:", sumAreas([withGetter, new Rect(2, 2)]));
const special = new Rect(1, 1);
special.area = () => -5;
log("own property:", sumAreas([special, new Rect(2, 3)]));
Circ.prototype.area = function () { return 100 * this.r; };
log("class method replaced:", sumAreas([new Circ(2), new Sq(2)]));
try {
	sumAreas([new Sq(1), { area: 42 }]);
} catch (e) {
	log("not a function:", e.constructor.name);
}
try {
	sumAreas([new Sq(1), null]);
} catch (e) {
	log("null:", e.constructor.name);
}
class Thrower extends Shape { area() { throw new RangeError("no area"); } }
try {
	sumAreas([new Sq(1), new Thrower()]);
} catch (e) {
	log("throws:", e.constructor.name, e.message);
}

// `%` of numbers.
function remainders(xs, m) { let s = []; for (let i = 0; i < xs.length; i++) s.push(xs[i] % m); return s.map((v) => (Object.is(v, -0) ? "-0" : String(v))).join(","); }
const numbers = [7, -7, 0, -0, 2.5, 1e10, -1e10, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), NaN, Infinity, -Infinity, 1 / 3];
log("% 3:", remainders(numbers, 3));
log("% -3:", remainders(numbers, -3));
log("% 0:", remainders(numbers, 0));
log("% 0.5:", remainders(numbers, 0.5));
log("% Infinity:", remainders(numbers, Infinity));
let acc = 0;
for (let i = 0; i < 100000; i += 0.5) acc += i % 7;
log("loop:", acc);

// `===` with an int32 on one side.
function equalsTwo(xs) { let s = ""; for (const x of xs) s += x === 2 ? "1" : "0"; return s; }
log("=== 2:", equalsTwo([2, 2.0, 4 / 2, "2", 2n, -2, 2.5, null, undefined, { valueOf: () => 2 }, [2], true, NaN]));
function equalsZero(xs) { let s = ""; for (const x of xs) s += 0 === x ? "1" : "0"; return s; }
log("0 ===:", equalsZero([0, -0, 0.0, "0", false, null, 0n, NaN, 1 - 1, -1 * 0]));
function state(n) { let s = 0; for (let i = 0; i < n; i++) { const k = (i * 1.5) | 0; s += k === 3 ? 10 : k === 4.0 ? 100 : 1; } return s; }
log("states:", state(1000));
console.log(out.join("\n"));
