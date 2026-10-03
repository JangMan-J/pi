// Numbers that the compiler holds as doubles but that are integers: as arguments, indexes and loop counters they must behave
// exactly as int32s do (charCodeAt and friends, array indexing, keys), including -0, NaN, fractions and values beyond int32.
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));
function skip(s, i) { return s.charCodeAt(i) === 0x1b ? 4 : 1; }
function width(s) {
	let w = 0, i = 0;
	while (i < s.length) {
		const c = s.charCodeAt(i);
		if (c === 0x1b) { i += skip(s, i); continue; }
		w += c >= 0x20 && c <= 0x7e ? 1 : 2;
		i += skip(s, i);
	}
	return w;
}
const lines = [];
for (let k = 0; k < 2000; k++) lines.push(("\x1b[1m" + "line " + k + "\x1b[0m é").slice(k % 3));
let sum = 0;
for (const l of lines) sum += width(l);
log("width", sum);
const values = [0, -0, 1.5, -1, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), 2 ** 53, NaN, Infinity, 3 / 3, 0.1 + 0.2];
for (const v of values) {
	const d = v * 1.0 + 0;
	const arr = ["a", "b", "c"];
	log(Object.is(d, -0) ? "-0" : d, "abc".charCodeAt(d), "abc".charAt(d), arr[d], String(d), d | 0, d >>> 0, ({ [d]: 1 })[d], [d].includes(v), new Map([[v, 1]]).get(d));
}
let x = 0.5;
for (let i = 0; i < 1000; i++) x = (x + i / 2) % 97;
log("loop", x);

// Integers of more than 32 bits that the compiler adds up itself: the sum is a 64-bit constant in the code that looks like an
// address (the compiler used to decline the function for it, and a direct call to it then had nowhere to go).
function wideSum(n) { const a = 3000000000; let s = 0; for (let i = 0; i < n; i++) s += a + 2147483648; return s; }
function wideCompare(n) { let big = 4294967295; for (let i = 0; i < n; i++) { if (i === big + 2147483648) return -1; } return n; }
function wideBoth(n) { let p = 2147483648, q = 2147483648, s = 0; for (let i = 0; i < n; i++) s += (p + q) / 4294967296; return s; }
log("wide constants", wideSum(10), wideCompare(10), wideBoth(10));
console.log(out.join("\n"));
