export function compute(n) { const m = new Map(); for (let i = 0; i < n; i++) m.set("k" + i, i * 2); let s = 0; for (const v of m.values()) s += v; return s; }
