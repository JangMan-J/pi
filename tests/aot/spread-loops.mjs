// Spread arguments in a loop that is split into a fast and a generic copy: a spread's result that reaches the call through a phi
// (where the copies rejoin) has to be expanded, not passed as one value. The objects are globals, read through the global scope
// (each read is a guard, as in JSTests/stress/spread-calling.js), and one iterator is written in JavaScript.
const out = [];
globalThis.collect = function () { return arguments.length + ":" + Array.prototype.join.call(arguments, ","); };
globalThis.arrayLike = { [Symbol.iterator]: Array.prototype.values, length: 3, 0: 1, 1: 2, 2: 3 };
globalThis.custom = { [Symbol.iterator]() { return { n: 6, next() { return this.n < 10 ? { value: this.n++, done: false } : { done: true }; } }; } };
let total = 0;
for (let i = 0; i < 3000; i++) {
	const a = collect("A", 0, ...arrayLike, 4, 5, ...custom);
	const b = collect.call(null, "B", 0, ...[1, 2, 3], 4, 5);
	if (i % 1000 === 0)
		out.push(a + " | " + b);
	total += a.length + b.length;
}
out.push("total " + total);
console.log(out.join("\n"));
