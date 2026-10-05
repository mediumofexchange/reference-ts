// Slice 11 M11b12 (probe; retires once its measurement is recorded, WORK.md Next 4(v)): what recording a kept replay
// file's digest costs as the file grows, through the runtime's own ReplayStore. A kept file holds one namespace of
// 2,000 records, then is padded with a filler table to each size, so the walk's rows lie as a small history's would
// while the file is as long as a deep one's. Each round is a block's read: a walk that appends 14 records and closes,
// committing and recording the digest. Measured: that close, a whole-file SHA256 of the same file (the digest's cost
// before M11b12), and reopening the file (§14's digest check, which still hashes every page).
//
// Usage: node scripts/pool/v3/page-digest-probe.mjs [--sizes 64,256,1024] [--rounds 5] (after npm run build; prints JSON)
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fieldToBytes } from "../../../dist/pool/field.js";
import { keptFileDigest, ReplayStore } from "../../../dist/pool/v3/replay-store.js";

const { values: options } = parseArgs({ options: { sizes: { type: "string", default: "64,256,1024" }, rounds: { type: "string", default: "5" } } });
const SIZES = options.sizes.split(",").map(Number), ROUNDS = Number(options.rounds), HISTORY = 2000, PER_BLOCK = 14;
const root = resolve(import.meta.dirname, "../../.."), genesis = { history: new Uint8Array(32), evidence: new Uint8Array(32) };
let counter = 1n;
const next = () => BigInt("0x" + randomBytes(30).toString("hex")) + counter++;
/** A spend-shaped record: two nullifiers and four outputs at random field values, one output witnessed. */
const record = () => {
  const outputs = [next(), next(), next(), next()];
  return { identity: fieldToBytes(next()), kind: 2, index: 5n, record: new Uint8Array([1]), proofHash: randomBytes(32), signatureHash: randomBytes(32),
    evidence: randomBytes(32), supply: undefined, nullifiers: [next(), next()].map(nf => ({ nf, tag: nf + 1n })),
    outputs: outputs.map((cm, i) => ({ cm, capsule: undefined, settlement: false, witness: i === 0 ? { nf: cm + 1n, note: fieldToBytes(cm) } : undefined })),
    demand: undefined, ended: undefined, keys: [], history: () => randomBytes(32) };
};
const wholeFile = path => {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1 << 20), fd = openSync(path, "r");
  try { for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest("hex");
};
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (f) => { const t = performance.now(); const value = f(); return [performance.now() - t, value]; };
const context = new Uint8Array(32).fill(7), report = { history: HISTORY, perBlock: PER_BLOCK, rounds: ROUNDS, sizes: [] };

for (const mb of SIZES) {
  const dir = mkdtempSync(join(root, "scratch", "page-digest-")), path = join(dir, "replay.db"), digest = join(dir, "replay.db.sha256");
  try {
    let store = new ReplayStore(path, { digest });
    const { walk } = store.openWalk(context), ns = store.open(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), undefined, genesis);
    for (let i = 0; i < HISTORY; i++) store.append(ns, record());
    store.closeWalk(walk); store.close();
    // Padding: a filler table to the size, written as another tool would, then vouched for as a keep point would.
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE filler (k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID; BEGIN");
    const insert = db.prepare("INSERT INTO filler VALUES (?, ?)");
    while (statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0) < mb * 2 ** 20) for (let i = 0; i < 4096; i++) insert.run(randomBytes(32), randomBytes(400));
    db.exec("COMMIT"); db.close();
    writeFileSync(digest, keptFileDigest(path));
    const [reopenMs, reopened] = ms(() => new ReplayStore(path, { digest }));
    store = reopened;
    assert(store.hasNamespace(ns), "the padded file is reused as kept");
    const closes = [], whole = [];
    for (let r = 0; r < ROUNDS; r++) {
      const { walk: w } = store.openWalk(context);
      for (let i = 0; i < PER_BLOCK; i++) store.append(ns, record());
      closes.push(ms(() => store.closeWalk(w))[0]);
      assert.equal(readFileSync(digest, "utf8"), keptFileDigest(path), "the recorded digest is the file's");
      whole.push(ms(() => wholeFile(path))[0]);
    }
    store.close();
    const entry = { fileMb: +(statSync(path).size / 2 ** 20).toFixed(1), reopenMs: Math.round(reopenMs), closeMs: +median(closes).toFixed(1),
      closeMaxMs: +Math.max(...closes).toFixed(1), wholeFileHashMs: Math.round(median(whole)) };
    report.sizes.push(entry);
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log(JSON.stringify(report, null, 1));
