// Functions that the compiler declines: run.sh has every function named `declined` declined for this test, as the compiler
// declines one it cannot compile. By default the build stops and names them. Told to go on
// (BUN_JSC_allowAOTDeclinedFunctions), it builds a program in which they run from bytecode, which these can (they use no
// variables from outside themselves), and are called every way that compiled code would otherwise go straight to a function's
// code or make the function part of itself: a call of a declaration, in a loop, a method with a name of its own, a method
// several classes have, from an arrow function, from a callback, with `new`, recursively.
const out = [];
function declined(a, b) { return a * 2 + (b ?? 1); }
function plain(n) { let s = 0; for (let i = 0; i < n; i++) s += declined(i, 1); return s; }
const helpers = { declined(x) { return x + 100; }, other(x) { return x - 1; } };
function viaMethod(n) { let s = 0; for (let i = 0; i < n; i++) s += helpers.declined(i) + helpers.other(i); return s; }
class A { declined() { return 1; } }
class B { declined() { return 2; } }
function viaClasses(list) { let s = 0; for (let i = 0; i < list.length; i++) s += list[i].declined(); return s; }
const arrow = (x) => declined(x, x);
function viaCallback(xs) { return xs.map((x) => declined(x)).reduce((a, b) => a + b, 0); }
function viaNew() { function declined() { this.v = 7; } return new declined().v; }
function recursive(n) { return n <= 0 ? 0 : declined(n, 0) + recursive(n - 1); }
out.push(declined(1, 2), plain(1000), viaMethod(1000), viaClasses([new A(), new B(), new A()]), arrow(3), viaCallback([1, 2, 3]), viaNew(), recursive(50));
try { null.declined(); } catch (e) { out.push(e.constructor.name); }
try { declined.call(undefined, 1n, 2); } catch (e) { out.push(e.constructor.name); }
console.log(out.join(" "));
