// A crash of the browser host's worker (slice 40, check.mjs --files): the page runs this worker three times on one
// file pool (files.ts).
//   write   mounts the pool, keeps a replay file through one walk's keep point, then opens a second walk and appends
//           records no keep point vouches for; the page then ends the worker as a crash would, without closing.
//   reopen  mounts the pool again: the kept file must pass §14's digest check and give the keep point's state (the
//           open walk's records gone), not be discarded; it then holds the pool.
//   second  mounts the pool while `reopen` holds it: refused by name (EBUSY), holding nothing.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { mountFiles } from "../../src/browser/files.js";
import { fieldToBytes } from "../../src/pool/field.js";
import { keptFileDigest, ReplayStore } from "../../src/pool/v3/replay-store.js";
import { finish } from "./worker-report.mjs";

const query = new URL(self.location.href).searchParams, phase = query.get("phase");
const POOL = "moe-check-crash", path = "/crash/replay.sqlite", digest = "/crash/replay.sha256";
const genesis = { history: new Uint8Array(32), evidence: new Uint8Array(32) }, context = new Uint8Array(32).fill(7);
let counter = 1000n;
const next = () => counter++;
const append = (outputs, nfs) => ({ identity: fieldToBytes(next()), kind: 2, index: 5n, record: new Uint8Array([1]), proofHash: new Uint8Array(32),
  signatureHash: new Uint8Array(32), evidence: new Uint8Array(32), supply: undefined, nullifiers: nfs.map(nf => ({ nf, tag: nf + 1n })),
  outputs: outputs.map(cm => ({ cm, capsule: undefined, settlement: false, witness: undefined })), demand: undefined, ended: undefined,
  keys: [], history: () => new Uint8Array(32) });
/** A tip as JSON: bigints as decimal text, bytes as hex. */
const plain = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString()
  : v instanceof Uint8Array ? Array.from(v, b => b.toString(16).padStart(2, "0")).join("") : v));
const sizeOf = file => existsSync(file) ? statSync(file).size : undefined;

try {
  if (phase === "write") {
    const mount = await mountFiles(POOL);
    mkdirSync("/crash", { recursive: true });
    const store = new ReplayStore(path, { digest });
    let { walk } = store.openWalk(context);
    const ns = store.open(fieldToBytes(1n), new Uint8Array(32).fill(2), undefined, genesis);
    for (let i = 0; i < 300; i++) store.append(ns, append([next(), next()], [next()]));
    store.closeWalk(walk);
    const tip = plain(store.tip(ns)), vouchedAtKeep = readFileSync(digest, "utf8") === keptFileDigest(path);
    // A second walk, left open: what it appends is no keep point's, until its transaction spills pages into the log.
    ({ walk } = store.openWalk(context));
    for (let i = 0; i < 100_000 && !(sizeOf(`${path}-wal`) > 0); i++) store.append(ns, append([next(), next()], [next()]));
    await finish({ kind: "crash-write", mount, ns, tip, vouchedAtKeep, open: plain(store.tip(ns)), files: { db: sizeOf(path), wal: sizeOf(`${path}-wal`), digest: sizeOf(digest) } });
    self.postMessage({ held: ns });
    await new Promise(() => {});
  } else if (phase === "reopen") {
    const mount = await mountFiles(POOL), files = { db: sizeOf(path), wal: sizeOf(`${path}-wal`), digest: sizeOf(digest) };
    const ns = Number(query.get("ns")), store = new ReplayStore(path, { digest });
    const kept = store.hasNamespace(ns);
    await finish({ kind: "crash-reopen", mount, files, kept, tip: kept ? plain(store.tip(ns)) : undefined });
    self.postMessage({ holding: true });
    await new Promise(() => {});
  } else if (phase === "second") {
    let outcome;
    try { outcome = { mounted: true, mount: await mountFiles(POOL) }; } catch (error) { outcome = { mounted: false, code: error.code, message: error.message }; }
    await finish({ kind: "crash-second", ...outcome });
    self.postMessage({ done: true });
  }
} catch (error) {
  await finish({ kind: `crash-${phase}`, error: String(error?.stack ?? error) });
  self.postMessage({ failed: true });
}
