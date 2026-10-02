import fs from "node:fs";
const vmsize = () => Math.round(parseInt(fs.readFileSync("/proc/self/status", "utf8").match(/VmSize:\s+(\d+)/)[1]) / 1024);
const committed = () => fs.readFileSync("/proc/self/smaps", "utf8").split("\n").reduce((a, l) => { const m = l.match(/^(\S+)-(\S+) (\S+)/); if (m) a.cur = m[3]; else if (l.startsWith("Size:") && a.cur && a.cur[1] === "w") a.w += parseInt(l.split(/\s+/)[1]); return a; }, { w: 0, cur: null }).w;
const here = new URL(import.meta.url.endsWith(".mjs") ? "./realms-mod.mjs" : "./realms-mod.js", import.meta.url).href;
const before = vmsize(), w0 = committed();
const results = [];
for (let i = 0; i < 6; i++) {
  const realm = new ShadowRealm();
  const compute = await realm.importValue(here, "compute");
  results.push(compute(1000 + i));
}
console.log(results.join(","), `VmSize +${vmsize() - before} MB, writable mappings +${Math.round((committed() - w0) / 1024)} MB`);
