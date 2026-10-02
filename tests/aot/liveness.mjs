// Values live across stub calls (property reads/writes, compares, arithmetic stubs, scope/global access), with slow paths that
// run JavaScript (getters, setters, valueOf, toString, proxies) in the middle of loops that keep several locals in registers.
const out = [];
const log = (...a) => out.push(a.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" "));
let globalCounter = 0;
var globalVar = 1;
class Point { constructor(x, y) { this.x = x; this.y = y; } get len() { globalCounter++; return Math.hypot(this.x, this.y); } }
class Point3 extends Point { constructor(x, y, z) { super(x, y); this.z = z; } }
function shapes(n) {
  const objs = [];
  for (let i = 0; i < n; i++) {
    switch (i % 7) {
      case 0: objs.push(new Point(i, i + 1)); break;
      case 1: objs.push(new Point3(i, 2, 3)); break;
      case 2: objs.push({ x: i, y: -i, extra: 1 }); break;
      case 3: objs.push({ y: i * 2, x: 3 }); break;
      case 4: objs.push(Object.create({ x: 7, y: 8 })); break;
      case 5: objs.push({ get x() { globalCounter += 2; return 5; }, y: 1 }); break;
      case 6: objs.push(new Proxy({ x: 1, y: 2 }, { get: (t, k) => (globalCounter += 3, t[k] ?? 0) })); break;
    }
  }
  return objs;
}
function liveAcrossReads(objs) {
  let a = 0, b = 1, c = 2, d = 3.5, e = "s", f = 0n, g = [], h = { k: 0 };
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    a += o.x; b ^= o.y | 0; c = (c * 31 + (o.x | 0)) % 1000003; d += o.y / 2;
    e = e.length < 50 ? e + (o.x % 10) : e.slice(1);
    f += BigInt(i & 7); if (i % 13 === 0) g.push(o.y); h.k += o.len ?? 1;
    if (o.x === o.y) a -= 1;
    if (o.x < o.y) b += 1; else if (o.x > o.y) c += 1;
  }
  return [a, b, c, d, e, String(f), g.length, Math.round(h.k)];
}
function withTry(objs) {
  let ok = 0, bad = 0, sum = 0;
  for (let i = 0; i < objs.length; i++) {
    const keep = i * 3, also = sum;
    try {
      if (i % 50 === 49) null.boom;
      sum += objs[i].x + keep - also;
      ok++;
    } catch (err) { bad += keep + (also === sum ? 1 : 0); }
  }
  return [ok, bad, sum];
}
function forOf(arrays) {
  let total = 0, count = 0, longest = "";
  for (const arr of arrays) for (const v of arr) { total += typeof v === "number" ? v : v.length; count++; if (String(v).length > longest.length) longest = String(v); }
  const m = new Map([[1, "a"], [2, "bb"]]); for (const [k, v] of m) total += k * v.length;
  const s = new Set("hello"); for (const ch of s) longest += ch;
  return [total, count, longest];
}
function closures(n) {
  const fns = [];
  for (let i = 0; i < n; i++) { let captured = i; fns.push(() => captured += globalVar); }
  let r = 0; for (const fn of fns) r += fn() + fn();
  globalVar++; for (const fn of fns) r += fn();
  return r;
}
function arrays(n) {
  const a = [], b = new Float64Array(n), c = new Int32Array(n), d = [];
  for (let i = 0; i < n; i++) { a[i] = i * 2; b[i] = i / 3; c[i] = -i; d.push(a[i] + c[i]); }
  let s1 = 0, s2 = 0, s3 = 0;
  for (let i = 0; i < n; i++) { s1 += a[i] * b[i]; s2 += c[i] ^ a[i]; s3 += d[i] === 0 ? 1 : 0; }
  a.length = 5; delete a[2];
  return [Math.round(s1), s2, s3, a.length, 2 in a, a[3], b.length, a.indexOf(6)];
}
function strings(words) {
  let acc = "", eq = 0, lt = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[(i + 7) % words.length];
    if (w === prev) eq++; if (w < prev) lt++;
    acc += w.charAt(0) + w.charCodeAt(w.length - 1) % 10;
    if (acc.length > 200) acc = acc.slice(100).toLowerCase();
  }
  return [acc, eq, lt, words.map((w) => w.toUpperCase()).join("").length];
}
function coercion(n) {
  const weird = { valueOf() { globalCounter += 5; return 3; }, toString() { return "W"; } };
  let s = 0, t = "";
  for (let i = 0; i < n; i++) { s += weird * i; t = t.length > 30 ? "" : t + weird; if (weird == 3) s++; if (weird < i) s--; }
  return [s, t, globalCounter];
}
function setters(n) {
  const log2 = [];
  const o = { _v: 0, set v(x) { log2.push(x); this._v = x * 2; }, get v() { return this._v; } };
  let keep1 = 7, keep2 = 11;
  for (let i = 0; i < n; i++) { o.v = i + keep1; keep2 += o.v; keep1 = (keep1 * 3) % 17; }
  return [keep1, keep2, log2.length, o._v];
}
const objs = shapes(700);
log("live", liveAcrossReads(objs));
log("try", withTry(objs));
log("forOf", forOf([[1, 2, 3], ["ab", "cde"], new Array(10).fill(4), "xyz".split("")]));
log("closures", closures(100));
log("arrays", arrays(1000));
log("strings", strings("the quick brown fox jumps over the lazy dog and keeps running far away from home".split(" ").concat(Array.from({ length: 60 }, (_, i) => "w" + (i % 9)))));
log("coercion", coercion(50));
log("setters", setters(200));
log("counter", globalCounter);
const megamorphic = []; for (let i = 0; i < 80; i++) { const o = {}; o["p" + i] = i; o.q = i * 2; megamorphic.push(o); }
let mq = 0; for (let r = 0; r < 20; r++) for (const o of megamorphic) mq += o.q + (o.p5 ?? 0);
log("mega", mq);
class Account {
  #balance = 0; static #count = 0;
  constructor(b) { this.#balance = b; Account.#count++; }
  deposit(x) { const keep = x * 2; this.#balance += x; return keep + this.#balance; }
  static has(o) { return #balance in o; }
  static get count() { return Account.#count; }
}
function privates(n) {
  let s = 0, live = 1;
  const accounts = Array.from({ length: 10 }, (_, i) => new Account(i));
  for (let i = 0; i < n; i++) { s += accounts[i % 10].deposit(i) + live; live = (live * 7) % 13; }
  return [s, live, Account.count, Account.has(accounts[0]), Account.has({})];
}
function typedDoubles(n) {
  const f = new Float64Array(n), g = new Float32Array(n), u = new Uint8ClampedArray(n), big = new BigInt64Array(4);
  let keepA = 0.25, keepB = 3;
  for (let i = 0; i < n; i++) { f[i] = i * 0.5 + keepA; g[i] = f[i] / 3; u[i] = i * 3; keepA += 0.125; keepB ^= i; }
  let s = 0; for (let i = 0; i < n; i++) s += f[i] - g[i] + u[i];
  f[n + 5] = 1; g[-1] = 2; big[1] = 5n;
  return [s.toFixed(3), keepA, keepB, f[n + 5], u[n - 1], String(big[1]), f.length];
}
function ropes(n) {
  let hits = 0, keep = 5;
  const parts = ["al", "pha", "be", "ta"];
  for (let i = 0; i < n; i++) {
    const w = parts[i % 2 ? 2 : 0] + parts[i % 2 ? 3 : 1];
    const sub = ("xx" + w + "yy").slice(2, -2);
    if (w === "alpha") hits++; if (sub === "beta") hits += 10; if (w == "beta" && sub !== w) hits += 1000;
    keep = (keep + w.length) % 97;
  }
  return [hits, keep];
}
function polyPuts(n) {
  const objs = [{ a: 1 }, { b: 1, a: 2 }, { c: 1, b: 2, a: 3 }, Object.create(null), [], new Point(1, 2)];
  let live = 3;
  for (let i = 0; i < n; i++) { const o = objs[i % objs.length]; o.a = i + live; o["k" + (i % 40)] = live; live = (live * 5 + 1) % 31; }
  return [objs.map((o) => o.a).join(","), Object.keys(objs[3]).length, live];
}
log("privates", privates(500));
log("typed", typedDoubles(300));
log("ropes", ropes(400));
log("polyPuts", polyPuts(600));
function bitops() {
  const vals = [0, -0, 1, -1, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), -(2 ** 31) - 1, 2 ** 32, 2 ** 32 + 5, 2 ** 53, 2 ** 63, -(2 ** 63), 2 ** 64, 1e20, -1e20,
    0.5, -0.5, 3.99, -3.99, NaN, Infinity, -Infinity, 4294967295.7, -4294967296.2, 1.5e300, 7, true, false];
  const r = [];
  for (const a of vals) for (const b of [0, 1, 5, 31, 32, -1, 2 ** 32 + 3, 1.9]) r.push(a | b, a & b, a ^ b, a << b, a >> b, a >>> b);
  let h = 7; for (let i = 0; i < 3000; i++) h = (h * 31 + i) | 0;
  let u = 0; for (let i = 0; i < 300; i++) u = (u * 1000003 + i) >>> 0;
  return [r.reduce((x, y) => (x * 33 + y) % 1000000007, 0), r.length, h, u];
}
log("bitops", bitops());
function polymorphicLoops() {
  class Base { constructor() { this.id = 1; } get computed() { return this.id * 10; } }
  class A extends Base { constructor() { super(); this.a = 1; } }
  class B extends Base { constructor() { super(); this.b = 2; this.c = 3; } }
  const proto = { inherited: 42, get viaGetter() { return this.z ?? -1; } };
  const shapes = [];
  for (let i = 0; i < 12; i++) {
    let o;
    switch (i % 6) {
      case 0: o = { z: i, y: 1 }; break;
      case 1: o = { y: 2, z: i }; break;
      case 2: o = Object.create(proto); o.z = i; break;
      case 3: o = new A(); o.z = i; break;
      case 4: o = new B(); o.z = i; break;
      case 5: o = {}; for (let k = 0; k < 40; k++) o["p" + k] = k; o.z = i; delete o.p3; break; // out of line, dictionary
    }
    shapes.push(o);
  }
  let sum = 0, missing = 0, inh = 0, comp = 0, viaG = 0, live = 5;
  for (let r = 0; r < 300; r++) {
    for (const o of shapes) {
      sum += o.z; if (o.nothere === undefined) missing++; inh += o.inherited ?? 0; comp += o.computed ?? 0; viaG += o.viaGetter ?? 0;
      live = (live * 3 + (o.y | 0)) % 1009;
    }
    if (r === 150) Object.defineProperty(proto, "viaGetter", { get() { return 1000; }, configurable: true }); // invalidates entries
    if (r % 50 === 0) { const junk = []; for (let k = 0; k < 2000; k++) junk.push({ k, s: "x" + k }); globalThis.gc?.(); }
  }
  // Puts on several shapes, transitions, frozen and sealed objects, strict mode.
  const targets = [{ v: 0 }, { w: 1, v: 0 }, Object.freeze({ v: 7 }), Object.seal({ v: 1 }), [], new A()];
  let thrown = 0;
  for (let r = 0; r < 200; r++) for (const t of targets) { try { (function () { "use strict"; t.v = r; t["n" + (r % 5)] = r; })(); } catch { thrown++; } }
  return [sum, missing, inh, comp, viaG, live, targets.map((t) => t.v).join(","), thrown, Object.keys(targets[0]).length];
}
log("poly", polymorphicLoops());
console.log(out.join("\n"));
