// Random program generator for differential testing of the AOT compiler (run.sh). `node gen.mjs SEED > prog.mjs` (or bun).
// The program is deterministic: it prints the same thing on every correct engine. It aims at what the AOT compiler
// specializes: loops (fast and generic copies, guards and their exits), module and closure variables, methods shared by
// several classes, arithmetic on ints/doubles/-0/NaN, try/catch/finally, typed arrays, arrays, dictionaries, generators,
// array callbacks; and changes the program makes between calls that must send the compiled code to its generic path.
const seed = Number(process.argv[2] ?? 1);
let s = seed >>> 0 || 1;
const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0), (s >>> 0) / 4294967296);
const int = (n) => Math.floor(rnd() * n);
const pick = (a) => a[int(a.length)];
const chance = (p) => rnd() < p;

const L = [];
const emit = (x) => L.push(x);

const LITS = ["0", "-0", "1", "-1", "2", "3", "7", "255", "256", "0.5", "-2.5", "1e21", "NaN", "Infinity", "-Infinity",
	"2147483647", "2147483648", "-2147483648", "4294967295", "0x7fff", "1/3", "'5'", "'x'", "''", "true", "false", "null", "undefined"];
const INTLITS = ["0", "1", "2", "3", "5", "7", "13", "31", "255", "1000"];
const METHODS = ["area", "step", "get", "run"];

const nG = 3 + int(4), nC = 2 + int(5), nL = int(4), nTA = 1 + int(3), nF = 6 + int(10);
const TA = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array"];

emit(`const out = [];`);
emit(`function show(x) {
	if (typeof x === "number") return Object.is(x, -0) ? "-0" : String(x);
	if (typeof x === "string") { if (x.length <= 80) return JSON.stringify(x); let h = 0; for (let i = 0; i < x.length; i++) h = (Math.imul(h, 31) + x.charCodeAt(i)) | 0; return "str#" + x.length + ":" + h; }
	if (typeof x === "bigint") return x + "n";
	if (Array.isArray(x)) return "[" + x.slice(0, 20).map(show).join(",") + (x.length > 20 ? ",..." + x.length : "") + "]";
	if (ArrayBuffer.isView(x)) { try { return x.constructor.name + "(" + x.length + ")[" + Array.from(x.slice(0, 12)).map(show).join(",") + "]"; } catch (e) { return x.constructor.name + "!" + e.constructor.name; } }
	if (typeof x === "function") return "fn";
	if (x && typeof x === "object") { try { return "{" + Object.keys(x).slice(0, 12).map((k) => k + ":" + show(x[k])).join(",") + "}"; } catch (e) { return "obj!" + e.constructor.name; } }
	return String(x);
}`);
emit(`const P = (tag, x) => out.push(tag + " " + show(x));`);

// Module variables.
const gKinds = [];
for (let k = 0; k < nG; k++) {
	const decl = pick(["var", "let", "let", "var"]);
	const init = pick(["10", "100", "3", "0.5", "'7'", "1000", "-5", "2.25", "undefined"]);
	gKinds.push(decl);
	emit(`${decl} g${k} = ${init};`);
}
// A variable read before it is assigned (hoisted var).
emit(`function readsLate() { let s = 0; for (let i = 0; i < 20; i++) s += late; return s; }`);
emit(`try { P("late0", readsLate()); } catch (e) { P("late0E", e.constructor.name); }`);
emit(`var late = 3;`);
emit(`P("late1", readsLate());`);

// Classes sharing method names, with a common base sometimes.
emit(`class Base { area() { return 1; } step(x) { return x; } get(x) { return 0; } run(x, y) { return x; } }`);
for (let c = 0; c < nC; c++) {
	const ext = chance(0.6) ? " extends Base" : "";
	const ms = METHODS.filter(() => chance(0.7));
	if (!ms.length) ms.push("area");
	const body = ms.map((m) => `${m}(x, y) { ${methodBody(c)} }`).join(" ");
	emit(`class C${c}${ext} { constructor(v) { ${ext ? "super(); " : ""}this.v = v; this.w = ${pick(["v * 2", "v + 0.5", "-v", "'' + v", "v | 0"])}; } ${body} }`);
}
for (let l = 0; l < nL; l++) {
	const ms = METHODS.filter(() => chance(0.5));
	if (!ms.length) ms.push("step");
	emit(`const L${l} = { v: ${pick(INTLITS)}, w: ${pick(LITS)}, ${ms.map((m) => `${m}(x, y) { ${methodBody(l + 100)} }`).join(", ")} };`);
}
function methodBody(c) {
	return pick([
		`return this.v * ${pick(INTLITS)};`,
		`return (this.v + (x | 0)) % ${pick(["7", "3", "-3", "0.5", "1"])};`,
		`return this.w;`,
		`return typeof x === "number" ? x + this.v : ${c};`,
		`if (x > ${pick(INTLITS)}) throw new RangeError("m${c}"); return this.v;`,
		`return this.v ^ (x << 1);`,
		`let t = 0; for (let k = 0; k < 3; k++) t += k * this.v; return t;`,
		`return ${c} + (y === undefined ? 0 : 1);`,
	]);
}
// Mixed collections of receivers.
const recv = () => {
	const items = [];
	const n = 1 + int(6);
	for (let k = 0; k < n; k++) items.push(chance(0.8) || !nL ? `new C${int(nC)}(${pick(INTLITS)})` : `L${int(nL)}`);
	if (chance(0.1)) items.push(`new Base()`);
	return items;
};
const nMix = 2 + int(3);
for (let m = 0; m < nMix; m++) emit(`const mix${m} = [${recv().join(", ")}];`);

// Typed arrays and arrays.
for (let t = 0; t < nTA; t++) {
	const n = pick(["8", "16", "64", "100", "3"]);
	emit(`let ta${t} = new ${pick(TA)}(${n}); for (let i = 0; i < ta${t}.length; i++) ta${t}[i] = (i * ${pick(INTLITS)}) - ${pick(INTLITS)};`);
}
emit(`const arr0 = [1, 2, 3, 4, 5, 6, 7, 8]; const arr1 = [1.5, -0, NaN, 4]; const arr2 = [1, , 3, "s", null, {}]; const arr3 = [];`);
emit(`const dict = {}; const keys = ["a", "b", "c", "constructor", "0", "1e3", "__x", "length"];`);
emit(`function* gen(n) { for (let k = 0; k < n; k++) yield k * 2; return -1; }`);
emit(`function sq(x) { return x * x; } const twice = (f, x) => f(f(x));`);

const ARRS = ["arr0", "arr1", "arr2", "arr3"];
const vars = (ctx) => ["i", "a", "b", "acc", ...ctx.locals, ...Array.from({ length: nG }, (_, k) => `g${k}`)];

function expr(ctx, d = 0) {
	if (d > 2 || chance(0.3)) {
		return pick([
			() => pick(LITS),
			() => pick(vars(ctx)),
			() => pick(vars(ctx)),
			() => `${pick(ARRS)}[i % ${pick(["3", "4", "8", "9"])}]`,
			() => `ta${int(nTA)}[i ${pick(["%", "&"])} ${pick(["7", "15", "63", "127"])}]`,
			() => `ta${int(nTA)}.length`,
			() => `${pick(ARRS)}.length`,
		])();
	}
	const r = int(16);
	const e = () => expr(ctx, d + 1);
	switch (r) {
		case 0: case 1: case 2: return `(${e()} ${pick(["+", "-", "*", "+", "-"])} ${e()})`;
		case 3: return `(${e()} ${pick(["%", "/", "%"])} ${e()})`;
		case 4: return `(${e()} ${pick(["|", "&", "^", "<<", ">>", ">>>"])} ${e()})`;
		case 5: return `(${e()} ${pick(["===", "!==", "==", "<", "<=", ">", ">="])} ${e()} ? ${e()} : ${e()})`;
		case 6: return `(${pick(["-", "~", "!", "+"])}(${e()}))`;
		case 7: return `Math.${pick(["floor", "abs", "sqrt", "round", "trunc", "sign", "fround"])}(${e()})`;
		case 8: return `Math.${pick(["min", "max", "imul"])}(${e()}, ${e()})`;
		case 9: { const m = int(nMix); return `mix${m}[i % mix${m}.length].${pick(METHODS)}(${e()}, ${e()})`; }
		case 10: return ctx.closures.length ? `${pick(ctx.closures)}(${e()})` : `sq(${e()})`;
		case 11: return `(typeof ${e()} === "${pick(["number", "string", "undefined", "object"])}" ? 1 : 2)`;
		case 12: return `String(${e()}).length`;
		case 13: return `(${e()} ?? ${e()})`;
		case 14: return `twice(sq, ${e()} & 15)`;
		default: return `(${e()}, ${e()})`;
	}
}

function stmt(ctx, d = 0) {
	const e = () => expr(ctx);
	const r = d > 1 ? int(9) : int(17);
	switch (r) {
		case 0: case 1: return `acc = (acc + ${e()}) | 0;`;
		case 2: return `acc += ${e()};`;
		case 3: return ctx.locals.length ? `${pick(ctx.locals)} = ${e()};` : `acc ^= ${e()};`;
		case 4: return `if (${e()}) { ${stmts(ctx, d + 1)} } else { ${stmts(ctx, d + 1)} }`;
		case 5: return `if (i % ${pick(["5", "17", "100", "333"])} === ${int(5)}) ${pick(["continue", "acc++", "acc--"])};`;
		case 6: return `ta${int(nTA)}[(i * ${pick(INTLITS)}) % ${pick(["8", "13", "200"])}] = ${e()};`;
		case 7: return `dict[keys[i % keys.length]] = ${e()};`;
		case 8: return ctx.writers.length ? `${pick(ctx.writers)}(${e()});` : `acc -= 1;`;
		case 9: return `try { ${stmts(ctx, d + 1)} if (i % ${pick(["7", "50", "1000"])} === ${int(3)}) throw new ${pick(["Error", "TypeError", "RangeError"])}("t"); } catch (err) { acc = (acc + err.constructor.name.length) | 0; }${chance(0.3) ? ` finally { acc ^= 1; }` : ""}`;
		case 10: return `for (let j = 0; j < ${pick(["3", "4", "b & 3", "2"])}; j++) { acc = (acc + j * ${e()}) | 0; }`;
		case 11: return `arr3.push(${e()}); if (arr3.length > 40) arr3.length = ${int(5)};`;
		case 12: return `for (const v of gen(${pick(["2", "3", "4"])})) acc += v;`;
		case 13: return `acc += ${pick(ARRS)}.${pick(["reduce((s, x) => s + (x | 0), 0)", "map((x) => x * 2).length", "filter((x) => x > 2).length", "indexOf(3)", "some((x) => x === i)"])};`;
		case 14: return `if (i > ${pick(["100", "500", "2000"])} && ${e()}) break;`;
		case 15: { const m = int(nMix); return `acc = (acc + mix${m}[i % mix${m}.length].${pick(METHODS)}(i, ${e()})) | 0;`; }
		default: return `acc = (acc + (${e()} % ${pick(["3", "7", "-4", "0", "2.5", "a", "b"])})) | 0;`;
	}
}
function stmts(ctx, d) {
	const n = 1 + int(d ? 2 : 4);
	return Array.from({ length: n }, () => stmt(ctx, d)).join(" ");
}

const fnames = [];
for (let f = 0; f < nF; f++) {
	const ctx = { locals: [], closures: [], writers: [] };
	const pre = [];
	const nl = int(3);
	for (let k = 0; k < nl; k++) { ctx.locals.push(`x${k}`); pre.push(`let x${k} = ${pick(LITS)};`); }
	if (chance(0.5)) { pre.push(`const k${f} = ${pick(LITS)}; const add${f} = (x) => x + k${f};`); ctx.closures.push(`add${f}`); }
	if (chance(0.3)) { pre.push(`const mul${f} = (x) => x * g${int(nG)};`); ctx.closures.push(`mul${f}`); }
	if (chance(0.4)) { pre.push(`let tot${f} = 0; const bump${f} = (x) => { tot${f} += x; };`); ctx.writers.push(`bump${f}`); }
	const bound = pick(["n", "n", `g${int(nG)}`, "300", "arr0.length * 50", `ta${int(nTA)}.length * 10`]);
	const body = stmts(ctx, 0);
	const post = ctx.writers.length ? ` + "/" + show(tot${f})` : "";
	emit(`function f${f}(n, a, b) { let acc = 0; ${pre.join(" ")} for (let i = 0; i < ${bound} && i < 5000; i++) { ${body} } return show(acc)${post}${ctx.locals.map((l) => ` + "|" + show(${l})`).join("")}; }`);
	fnames.push(`f${f}`);
}

const ARGS = ["300, 3, 4", "1000, 2.5, 'x'", "50, undefined, null", "700, -0, 7", "2000, 1e9, {}", "10, '3', 2"];
const mutation = () => pick([
	() => `g${int(nG)} = ${pick(["'25'", "5.5", "undefined", "12", "null", "{}", "-1", "true"])};`,
	() => `C${int(nC)}.prototype.${pick(METHODS)} = function (x) { return ${pick(INTLITS)}; };`,
	() => `mix${int(nMix)}.push(${pick(recv())});`,
	() => `mix${int(nMix)}[0] = { ${pick(METHODS)}: ${pick(["() => 9", "function () { return this === undefined ? 1 : 2; }", "Function('return 4')", "Math.abs"])} };`,
	() => `mix${int(nMix)}[0].${pick(METHODS)} = () => -3;`,
	() => `Object.defineProperty(mix${int(nMix)}[0], "${pick(METHODS)}", { get() { return () => 77; }, configurable: true });`,
	() => `{ const t = ta${int(nTA)}; try { t.buffer.transfer?.(); } catch (e) {} }`,
	() => `ta${int(nTA)} = new ${pick(TA)}(${pick(["5", "40"])});`,
	() => `arr0.push(${pick(LITS)});`,
	() => `arr1[${pick(["10", "2", "100"])}] = ${pick(LITS)};`,
	() => `Object.freeze(dict);`,
	() => `delete dict.a;`,
	() => `mix${int(nMix)}.length = 1;`,
])();

const order = [];
for (const f of fnames) for (let k = 0; k < 2 + int(3); k++) order.push(f);
for (let k = order.length - 1; k > 0; k--) { const j = int(k + 1); [order[k], order[j]] = [order[j], order[k]]; }
order.forEach((f, idx) => {
	if (chance(0.25)) emit(`try { ${mutation()} } catch (e) { P("mutE", e.constructor.name); }`);
	emit(`try { P("${f}#${idx}", ${f}(${pick(ARGS)})); } catch (e) { out.push("${f}#${idx}E " + (e.constructor.name + ":" + e.message).slice(0, 200)); }`);
});
emit(`P("dict", dict); P("arr3", arr3); for (let t = 0; t < ${nTA}; t++) {}`);
for (let t = 0; t < nTA; t++) emit(`P("ta${t}", ta${t});`);
emit(`console.log(out.join("\\n"));`);
console.log(L.join("\n"));
