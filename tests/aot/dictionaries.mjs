// Objects written with computed keys, `o[k] = v`: plain objects used as dictionaries (many keys, replaced over and over), symbol
// keys, and what must not be cached away: frozen and sealed objects, setters, setters and read-only properties on the prototype
// chain, non-extensible objects, arrays and typed arrays with string keys, and strict-mode errors.
const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === "object" && x !== null ? JSON.stringify(x) : String(x))).join(" "));

const names = Array.from({ length: 500 }, (_, i) => "n" + i);
function count(n) { const d = {}; for (let i = 0; i < n; i++) { const k = names[i % 500]; d[k] = (d[k] || 0) + 1; } return [Object.keys(d).length, d.n0, d.n499]; }
log("dictionary", count(50), count(300000));

const o = { a: 1, b: 2 };
for (let i = 0; i < 1000; i++) o[i & 1 ? "a" : "b"] = i;
log("replace", o.a, o.b, Object.keys(o));
const sym = Symbol("s");
const so = { [sym]: 0 };
for (let i = 0; i < 1000; i++) so[sym] = i;
log("symbol", so[sym], Object.getOwnPropertySymbols(so).length);
const added = {};
for (let i = 0; i < 100; i++) added["k" + i] = i;
log("added", Object.keys(added).length, added.k99);

// What the cache must leave alone.
const frozen = Object.freeze({ x: 1 });
try { frozen["x"] = 2; log("frozen did not throw"); } catch (e) { log("frozen", e.constructor.name, frozen.x); }
const sealed = Object.seal({ x: 1 });
sealed["x"] = 5;
try { sealed["y"] = 1; log("sealed add did not throw"); } catch (e) { log("sealed", e.constructor.name, sealed.x, sealed.y); }
const nonExt = Object.preventExtensions({ x: 1 });
nonExt["x"] = 7;
try { nonExt["z"] = 1; log("non-extensible add did not throw"); } catch (e) { log("non-extensible", e.constructor.name, nonExt.x); }
let setterCalls = 0;
const withSetter = { set s(v) { setterCalls += v; }, get s() { return setterCalls; } };
for (let i = 0; i < 10; i++) withSetter["s"] = i;
log("setter", setterCalls, withSetter.s, Object.keys(withSetter));
const proto = { set ps(v) { this._ps = v * 2; } };
Object.defineProperty(proto, "ro", { value: 1, writable: false });
const child = Object.create(proto);
for (let i = 0; i < 5; i++) child["ps"] = i;
log("prototype setter", child._ps, Object.keys(child));
try { child["ro"] = 2; log("read-only on prototype did not throw"); } catch (e) { log("read-only on prototype", e.constructor.name, child.ro, Object.hasOwn(child, "ro")); }
const arr = [1, 2, 3];
arr["x"] = "y";
arr["1"] = 20;
arr["length"] = 2;
log("array", arr, arr.x, arr.length);
const typed = new Uint8Array(4);
typed["1"] = 300;
typed["foo"] = 1;
log("typed", Array.from(typed), typed.foo, Object.keys(typed));
const key = { toString() { return "dyn"; } };
const viaToString = {};
viaToString[key] = 1;
viaToString[key] = 2;
log("toString key", viaToString.dyn, Object.keys(viaToString));
const numericString = {};
numericString["10"] = "a";
numericString["1e1"] = "b";
numericString[10] = "c";
log("numeric strings", Object.keys(numericString), numericString["10"], numericString["1e1"]);
let d2 = {};
for (let i = 0; i < 2000; i++) { d2["p" + i] = i; if (i % 7 === 0) delete d2["p" + (i >> 1)]; }
log("with deletes", Object.keys(d2).length, d2.p1999, d2.p0);
for (const k of names) d2[k] = 1;
for (const k of names) d2[k] = 2;
log("after transition", Object.keys(d2).length, d2.n5);
console.log(out.join("\n"));
