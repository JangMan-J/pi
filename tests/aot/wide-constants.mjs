// Number constants beyond int32 that the ARM64 code generator materializes with movz/movk: some of their values fall inside
// the dyld shared cache or the static heap's reservation, and must not be taken for pointers into this process.
function a(i) { const x = 3000000000; return ((i | 0) * 0 + x) + 2147483648; }
function b(i) { const x = 4000000000; return ((i | 0) * 0 + x) + 3000000000; }
function c(i) { let x = 100000; let y = 100000; return x * y + (i | 0); }
function d(i) { const u = (-1) >>> 0; return u + u + (i | 0); }
function e(i) { let x = 4000000000; x += 3000000000; return x - (i | 0); }
let s = 0; for (let i = 0; i < 1000; i++) s += a(i) + b(i) + c(i) + d(i) + e(i);
console.log(s);
