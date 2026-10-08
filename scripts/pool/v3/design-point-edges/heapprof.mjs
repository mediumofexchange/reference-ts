// Disposable: a .heapprofile's sampled allocation by function (self) and inclusive under each frame.
import { readFileSync } from "node:fs";
const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
const self = new Map(), inclusive = new Map();
const label = f => `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
let total = 0;
function walk(node, stack) {
  const l = label(node.callFrame), size = (node.selfSize ?? 0);
  total += size;
  self.set(l, (self.get(l) ?? 0) + size);
  const here = stack.includes(l) ? stack : [...stack, l];
  for (const s of here) inclusive.set(s, (inclusive.get(s) ?? 0) + size);
  for (const c of node.children ?? []) walk(c, here);
}
walk(profile.head, []);
const mb = v => (v / 1048576).toFixed(1);
const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, v]) => `${mb(v)}\t${l}`).join("\n");
console.log(`total sampled live-at-stop ${mb(total)} MB\n--- self\n${top(self, 25)}\n--- inclusive\n${top(inclusive, 40)}`);
