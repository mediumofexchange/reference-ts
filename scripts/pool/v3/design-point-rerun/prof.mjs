// Disposable: a .cpuprofile's self time by function, and the inclusive time under frames named by argv[3..].
import { readFileSync } from "node:fs";
const profile = JSON.parse(readFileSync(process.argv[2], "utf8")), roots = process.argv.slice(3);
const byId = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map(), inclusive = new Map();
const dt = profile.timeDeltas, samples = profile.samples;
const label = n => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
let total = 0;
for (let i = 0; i < samples.length; i++) {
  const ms = (dt[i + 1] ?? 0) / 1000, n = byId.get(samples[i]); total += ms;
  self.set(label(n), (self.get(label(n)) ?? 0) + ms);
  const seen = new Set();
  for (let id = samples[i]; id !== undefined; id = parent.get(id)) {
    const m = byId.get(id), l = label(m);
    if (seen.has(l)) continue; seen.add(l);
    if (roots.length === 0 || roots.some(r => m.callFrame.functionName === r)) inclusive.set(l, (inclusive.get(l) ?? 0) + ms);
  }
}
const top = (map, k = 25) => [...map].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, ms]) => `${Math.round(ms)}\t${l}`).join("\n");
console.log(`total ${Math.round(total)} ms\n--- self\n${top(self)}\n--- inclusive${roots.length ? ` (${roots})` : ""}\n${top(inclusive, 40)}`);
