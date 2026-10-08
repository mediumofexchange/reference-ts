// Disposable: a .heapsnapshot's self size and count by node type and name (constructor), largest first.
import { readFileSync } from "node:fs";
const snap = JSON.parse(readFileSync(process.argv[2], "utf8")), meta = snap.snapshot.meta, f = meta.node_fields, n = f.length;
const types = meta.node_types[0], iType = f.indexOf("type"), iName = f.indexOf("name"), iSize = f.indexOf("self_size");
const agg = new Map(); let total = 0;
for (let i = 0; i < snap.nodes.length; i += n) {
  const type = types[snap.nodes[i + iType]], name = type === "string" || type === "concatenated string" || type === "sliced string" ? "(string)" : snap.strings[snap.nodes[i + iName]];
  const key = `${type}:${String(name).slice(0, 60)}`, size = snap.nodes[i + iSize]; total += size;
  const a = agg.get(key) ?? [0, 0]; a[0] += size; a[1]++; agg.set(key, a);
}
console.log(`total ${(total / 1048576).toFixed(1)} MB`);
for (const [k, [s, c]] of [...agg].sort((a, b) => b[1][0] - a[1][0]).slice(0, 30)) console.log(`${(s / 1048576).toFixed(1)} MB\t${c}\t${k}`);
