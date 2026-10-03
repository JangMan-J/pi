// String built-ins with a literal argument, which compiled code answers by looking at the characters in place: startsWith,
// endsWith, === and switch, on strings of every length and make (short and long, flat, made by concatenation and flattened,
// slices, 16-bit), in a function and in the top-level code of the module (which is compiled more compactly). Strings of 65,535
// characters and more used to be read wrong by endsWith in compact code.
const out = [];
const log = (...a) => out.push(a.map(String).join(" "));

function lines(n) { let s = ""; for (let i = 1; i <= n; i++) s += i + "\n"; return s; }
const made = [];
for (const n of [0, 1, 10, 9361, 9362, 9363, 20000, 300000]) {
	const rope = lines(n);
	made.push(["concatenated " + n, rope]);
	const flat = lines(n);
	flat.split("\n"); // Flattened.
	made.push(["flattened " + n, flat]);
	made.push(["slice " + n, flat.slice(1)]);
}
for (const n of [65534, 65535, 65536, 65537, 200000]) {
	made.push(["repeat " + n, "a".repeat(n - 1) + "\n"]);
	made.push(["repeat " + n + " no newline", "a".repeat(n)]);
}
made.push(["16-bit", "é€".repeat(40000) + "\n"], ["empty", ""], ["one", "\n"]);

function inFunction(s) {
	return [s.endsWith("\n"), s.endsWith("0\n"), s.endsWith("a\n"), s.endsWith("\n\n"), s.startsWith("1\n"), s.startsWith("a"), s === "\n", s === "1\n"].map(Number).join("");
}
function split(s) { const l = s.split("\n"); if (s.endsWith("\n")) l.pop(); return l.length; }
function kind(s) { switch (s) { case "": return "empty"; case "\n": return "newline"; case "1\n": return "one"; default: return "other"; } }
for (const [name, s] of made) {
	const atTop = [s.endsWith("\n"), s.endsWith("0\n"), s.endsWith("a\n"), s.endsWith("\n\n"), s.startsWith("1\n"), s.startsWith("a"), s === "\n", s === "1\n"].map(Number).join("");
	log(name, s.length, inFunction(s), atTop, split(s), kind(s));
}
console.log(out.join("\n"));
