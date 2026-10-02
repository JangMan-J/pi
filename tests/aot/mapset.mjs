// Map/Set fast paths in code compiled ahead of time: every key kind, deleted entries, collisions, strings equal by content but not
// identical, rope keys, values needing a write barrier, Map vs Set receivers, and functions that are not the built-ins.
const out = [];
const keys = [0, 1, -1, 2 ** 31 - 1, 1.5, -0, NaN, Infinity, "a", "", "longer key " + "x".repeat(40), true, false, null, undefined, 10n, Symbol.for("s")];
const obj = {}; keys.push(obj);
function run(m, s) {
  for (const [i, k] of keys.entries()) { m.set(k, i); s.add(k); }
  for (const k of keys) out.push(m.get(k), m.has(k), s.has(k));
  const built = ["lon", "ger key ", "x".repeat(40)].join(""); // not an atom
  out.push(m.get(built), m.has(built), s.has(built), m.get("longer key " + "x".repeat(40)));
  const rope = "lon" + "ger key " + "x".repeat(40); out.push(m.get(rope), s.has(rope));
  for (let i = 0; i < 2000; i++) { m.set("k" + i, { i }); s.add(i); } // growth, rehash
  for (let i = 0; i < 2000; i += 3) { m.delete("k" + i); s.delete(i); }
  let sum = 0; for (let i = 0; i < 2000; i++) { const v = m.get("k" + i); sum += v ? v.i : -1; if (s.has(i)) sum += 1; }
  out.push(sum, m.size, s.size);
  for (let i = 0; i < 2000; i++) m.set("k" + i, { j: i }); // overwrite, values are cells (write barrier)
  globalThis.gc?.();
  let sum2 = 0; for (let i = 0; i < 2000; i++) sum2 += m.get("k" + i).j; out.push(sum2);
  out.push(m.set("z", 1) === m, s.add("z") === s, s.add("z") === s);
  out.push(m.get(-0) === m.get(0), m.has(NaN), m.get(1.5), m.get(10n), m.get(obj));
}
run(new Map(), new Set());
class MyMap extends Map { get(k) { return "own:" + super.get(k); } }
const mm = new MyMap([["a", 1]]); out.push(mm.get("a"), mm.has("a"));
const fake = { get: (k) => "fake " + k, has: () => "fake has", set() { return "fake set"; }, add() { return "fake add"; } };
out.push(fake.get(1), fake.has(1), fake.set(1, 2), fake.add(1));
try { Map.prototype.get.call(new Set(), 1); out.push("no throw"); } catch (e) { out.push(e.constructor.name); }
const ws = new WeakMap(); ws.set(obj, 5); out.push(ws.get(obj), ws.has(obj));
console.log(JSON.stringify(out, (k, v) => typeof v === "bigint" ? v + "n" : v === undefined ? "undef" : Number.isNaN(v) ? "NaN" : v));
