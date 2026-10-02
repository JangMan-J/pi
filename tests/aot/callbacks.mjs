// Array methods that take a callback, which the compiler inlines together with the callback (useImmutableIntrinsics): the
// results, the order of calls, `this`, the index and array arguments, holes, early exits, exceptions, arrays that change while
// they are iterated, and arrays that are not arrays.
const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" "));

const nums = Array.from({ length: 2000 }, (_, i) => (i * 7919) % 1000);
const double = (n) => n * 2;
function isEven(n) { return n % 2 === 0; }

log("map", nums.map(double).reduce((a, b) => a + b, 0));
log("filter", nums.filter(isEven).length, nums.filter((n, i) => i % 3 === 0).length);
log("reduce", nums.reduce((a, b) => a + b), nums.reduce((a, b) => a + b, 10), [].reduce((a, b) => a + b, "empty"));
log("reduceRight", [1, 2, 3].reduceRight((a, b) => a + "-" + b));
let sum = 0;
nums.forEach((n, i, arr) => { sum += n + i + arr.length; });
log("forEach", sum);
log("some/every", nums.some((n) => n > 998), nums.every((n) => n < 1000), [].some(() => true), [].every(() => false));
log("find", nums.find((n) => n > 500), nums.findIndex((n) => n > 500), nums.findLast((n) => n < 5), nums.findLastIndex((n) => n < 5), nums.find(() => false));
log("flatMap", [1, 2, 3].flatMap((n) => [n, n * 10]));

// The callback's arguments and `this`.
const seen = [];
["a", "b"].forEach(function (value, index, array) { seen.push([this.tag, value, index, array.length]); }, { tag: "t" });
log("arguments", seen);
log("index in map", ["x", "y", "z"].map((v, i) => v + i));

// Holes are skipped by forEach/map/filter/reduce, visited as undefined by find.
const holes = [1, , 3];
const visited = [];
holes.forEach((v, i) => visited.push(i));
log("holes", visited, holes.map((v) => v * 2), holes.filter(() => true).length, holes.find((v) => v === undefined), holes.findIndex((v) => v === undefined));

// Early exit: some/every/find stop at the first answer.
let calls = 0;
log("early", [1, 2, 3, 4].some((n) => { calls++; return n === 2; }), calls);
calls = 0;
log("early2", [1, 2, 3, 4].find((n) => { calls++; return n === 3; }), calls);

// An exception in the callback comes out of the method.
try {
	[1, 2, 3].map((n) => { if (n === 2) throw new RangeError("two"); return n; });
} catch (e) {
	log("throws", e.constructor.name, e.message);
}

// The array changes under the callback: the length is read once, elements are read as they come.
const grows = [1, 2, 3];
const got = [];
grows.forEach((v) => { got.push(v); if (grows.length < 6) grows.push(v * 10); });
log("grows", got, grows.length);
const shrinks = [1, 2, 3, 4];
const got2 = [];
shrinks.forEach((v) => { got2.push(v); shrinks.pop(); });
log("shrinks", got2);
const filled = [1, 2, 3];
log("map sees writes", filled.map((v, i, a) => { if (i === 0) a[2] = 30; return v; }));

// Array-likes and subclasses: the generic protocol.
log("array-like", Array.prototype.map.call({ length: 3, 0: "a", 1: "b", 2: "c" }, (v) => v.toUpperCase()));
class MyArray extends Array {}
const mine = MyArray.from([1, 2, 3]);
log("subclass", mine.map((n) => n + 1) instanceof MyArray, mine.filter(() => true).constructor.name);
log("typed", Array.from(new Uint8Array([3, 1, 2]).map((v) => v * 2)));

// Not callable.
try {
	[1].map(42);
} catch (e) {
	log("not callable", e.constructor.name);
}

// Adding a method to a prototype works; the module-level helpers are still used.
Array.prototype.pibolt_sum = function () { return this.reduce((a, b) => a + b, 0); };
log("added method", [1, 2, 3].pibolt_sum());
delete Array.prototype.pibolt_sum;

// Nested callbacks, and a callback that is a module-level function declared below.
log("nested", [[1, 2], [3]].map((row) => row.map(late)).flat());
function late(n) { return n * 100; }

console.log(out.join("\n"));
