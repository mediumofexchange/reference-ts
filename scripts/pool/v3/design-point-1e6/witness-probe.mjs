// Slice 18, disposable: the wallet's memory step at a large note-tree block. Appends records of four outputs to a kept
// replay file, witnessing every --every-th output (8: the 10⁶ run's 12.5% owned; 0: none), and spending each witnessed
// output again two records later when --spend is set. Around each append that completes a block of 2^h leaves for
// h >= --from, it records the append's time and the process's memory before and after (peak working set included).
// Usage: node --expose-gc witness-probe.mjs --leaves 18 [--every 8] [--spend] [--from 14] --dir <scratch dir> (run on a
// dist built 2026-10-14, whose append and witness rows are bc43e79's).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const { values: o } = parseArgs({ options: { leaves: { type: "string", default: "18" }, every: { type: "string", default: "8" },
  spend: { type: "boolean", default: false }, from: { type: "string", default: "14" }, dir: { type: "string" }, dist: { type: "string" },
  keep: { type: "string", default: "1000" } } });
const dist = o.dist ?? join(import.meta.dirname, "..", "..", "..", "..", "dist");
const { ReplayStore } = await import(pathToFileURL(join(dist, "pool/v3/replay-store.js")).href);
const { fieldToBytes } = await import(pathToFileURL(join(dist, "pool/field.js")).href);

const LEAVES = 2 ** Number(o.leaves), EVERY = Number(o.every), FROM = Number(o.from), KEEP = Number(o.keep);
mkdirSync(o.dir, { recursive: true });
const path = join(o.dir, "replay.sqlite"), digest = join(o.dir, "replay.sha256");
for (const f of [path, `${path}-wal`, `${path}-shm`, digest, `${path}.lock`]) rmSync(f, { force: true });
const store = new ReplayStore(path, { digest, every: KEEP });
store.openWalk(new Uint8Array(32).fill(7));
const ns = store.open(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), undefined, { history: new Uint8Array(32), evidence: new Uint8Array(32) });
let counter = 1n;
const mb = n => Math.round(n / 1048576);
const memory = () => { const m = process.memoryUsage(); return { rss: mb(m.rss), heap: mb(m.heapUsed), arrayBuffers: mb(m.arrayBuffers), external: mb(m.external), peak: Math.round(process.resourceUsage().maxRSS / 1024) }; };
const pending = [];
const out = [];
let leaf = 0, witnessed = 0;
const started = performance.now();
for (let r = 0; leaf < LEAVES; r++) {
  const outputs = [], nullifiers = [];
  for (let i = 0; i < 4; i++, leaf++) {
    const cm = counter++, w = EVERY > 0 && leaf % EVERY === 0;
    outputs.push({ cm, capsule: undefined, settlement: false, witness: w ? { nf: cm + 10n ** 12n, note: fieldToBytes(cm) } : undefined });
    if (w) { witnessed++; if (o.spend) pending.push({ nf: cm + 10n ** 12n, due: r + 2 }); }
  }
  while (pending.length > 0 && pending[0].due <= r) { const { nf } = pending.shift(); nullifiers.push({ nf, tag: nf + 1n }); }
  if (nullifiers.length === 0) nullifiers.push({ nf: counter + 10n ** 13n, tag: counter + 10n ** 13n + 1n });
  const record = { identity: fieldToBytes(counter++), kind: 2, index: 5n, record: new Uint8Array([1]), proofHash: new Uint8Array(32),
    signatureHash: new Uint8Array(32), evidence: new Uint8Array(32), supply: undefined, nullifiers, outputs, demand: undefined, ended: undefined,
    keys: [], history: () => new Uint8Array(32) };
  // The block this record's last leaf completes: the trailing ones of its index, plus one.
  let h = 0; while (((leaf - 1) >> h) & 1) h++;
  const big = h >= FROM;
  if (big) { globalThis.gc?.(); }
  const before = big ? memory() : undefined, t = performance.now();
  store.append(ns, record);
  if (big) {
    const ms = performance.now() - t, after = memory();
    const k = performance.now(); store.keepPoint(); const keepMs = performance.now() - k, kept = memory();
    globalThis.gc?.(); const settled = memory();
    const row = { leaves: leaf, block: h, witnessed, appendMs: Math.round(ms), keepMs: Math.round(keepMs), before, after, kept, settled, elapsedS: Math.round((performance.now() - started) / 1000) };
    out.push(row); console.log(JSON.stringify(row));
  }
}
store.close();
console.log(JSON.stringify({ done: true, leaves: LEAVES, every: EVERY, spend: o.spend, witnessed, elapsedS: Math.round((performance.now() - started) / 1000), final: memory() }));
