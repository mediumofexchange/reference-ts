// Replay-state storage probe (slice 8 M5b design). What does one segment's
// replay state cost in memory today, and what do per-event time, memory, disk,
// rollback, keep points and the kept-state checks cost when the state lives in
// node:sqlite as the storage decision lays it out? Serves that decision and
// retires with it. Not a check, not runtime.
//   node --expose-gc scripts/pool/v3/replay-store-probe.mjs baseline <events> [--proof <bytes>]
//   node --expose-gc scripts/pool/v3/replay-store-probe.mjs stored <events> [options]
// baseline: the runtime state machine (dist state.ts) over synthetic records, stub verifier.
// stored options:
//   --proof <bytes>        stand-in record size is proof + 900 bytes (default 32)
//   --checkpoint <events>  events per savepoint (default 64)
//   --keep <events>        events per keep point: commit, then SHA-256 of the state file (default: once, at the end)
//   --journal truncate|wal --sync normal|full (defaults truncate, full)
//   --cache-mib <n>        SQLite page cache per connection (default 64)
//   --refuse-every <n>     apply every n-th checkpoint, roll it back, then apply it again
//   --row-digest           also time a digest over every state row in key order
//   --no-keep-digest       commit at keep points without hashing (the journal's pattern)
//   --poseidon             the runtime's Poseidon2 note hash instead of a SHA-256 stand-in
//   --check                compare with the runtime NoteTree/RadixSpentSet and read the stored spent set back
//   --node-cache <n>       spent nodes held in memory (default 65536)
//   --dir <directory>      default scratch/replay-store-probe/run
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { limbsOf, fieldToBytes } from "../../../dist/pool/field.js";
import { EMPTY_NOTE_ROOT, EMPTY_NOTE_SUBTREE, NoteTree, noteNode } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { RadixSpentSet } from "../../../dist/pool/v3/spent-set.js";
import { deliveryHash, encodeRecord, statementBytes } from "../../../dist/pool/v3/records.js";
import { decodeRootTerms, encodeRootTerms, rootTermsName } from "../../../dist/pool/v3/terms.js";
import { segmentBytes } from "../../../dist/pool/v3/headers.js";
import { applyRecord, openSegmentState } from "../../../dist/pool/v3/state.js";
import { V3_SPENT_LEAF_CONTEXT as LEAF, V3_SPENT_NODE_CONTEXT as NODE } from "../../../dist/contexts.js";

const [mode, countText, ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const i = rest.indexOf(name); return i < 0 ? fallback : rest[i + 1]; };
assert(["baseline", "stored"].includes(mode) && /^[1-9][0-9]*$/.test(countText ?? ""), "usage: replay-store-probe.mjs baseline|stored <events> [...]");
const N = Number(countText), PROOF = Number(option("--proof", "32")), SAMPLE = Math.max(1, Math.floor(N / 20));
const sha = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
const mib = bytes => +(bytes / 1048576).toFixed(1);
const MODULUS = 21888242871839275222246405745257275088548364400416903490308238158651n;
const fieldOf = () => { for (;;) { const v = BigInt("0x" + randomBytes(32).toString("hex")) % MODULUS; if (v !== 0n) return v; } };
const samples = [];
const sample = (events, extra = {}) => {
  gc(); const m = process.memoryUsage();
  const row = { events, heapMiB: mib(m.heapUsed), rssMiB: mib(m.rss), externalMiB: mib(m.external + m.arrayBuffers), ...extra };
  samples.push(row); console.error(JSON.stringify(row));
};

if (mode === "baseline") {
  // One synthetic segment through the runtime state machine: an issue, then
  // spends of two fresh nullifiers into four outputs, anchored at the empty root.
  const b = n => new Uint8Array(32).fill(n), domain = b(1), venue = b(2), issuerSecret = b(15);
  const obligor = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(b(16));
  const termsBytes = encodeRootTerms({ obligor, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n }, operator,
    configuration: domain, venue, interval: 10n });
  const terms = decodeRootTerms(termsBytes), backing = rootTermsName(termsBytes), entries = [{ backing, link: backing }];
  const segment = sha(segmentBytes({ domain, venue, operator, sequence: 1n, entries })), scope = new ScopeTree(entries).root();
  const prefix = [...limbsOf(domain), ...limbsOf(segment), scope], capsule = () => { const c = new Uint8Array(randomBytes(89)); c[0] = 1; return c; };
  const digest = (outputs, capsules) => limbsOf(deliveryHash(domain, outputs, capsules));
  const verifier = { verify: () => true };
  const replay = { domain, backing, segment, scope, terms, verifier, index: 100n, block: [] };
  const state = openSegmentState(segment, undefined, undefined, undefined, () => {});
  sample(0);
  const start = performance.now();
  for (let i = 0; i < N; i++) {
    let record;
    if (i === 0) {
      const cm = fieldOf(), caps = [capsule()];
      record = { domain, kind: 1, publicInputs: [...prefix, ...limbsOf(backing), 1000n, cm, ...digest([cm], caps)],
        proof: new Uint8Array(randomBytes(PROOF)), authorization: new Uint8Array(64), capsules: caps };
      record.authorization = ed25519.sign(statementBytes(record), issuerSecret);
    } else {
      const nfs = [fieldOf(), fieldOf()], outs = [fieldOf(), fieldOf(), fieldOf(), fieldOf()], caps = outs.map(capsule);
      record = { domain, kind: 2, publicInputs: [...prefix, EMPTY_NOTE_ROOT, EMPTY_NOTE_ROOT, ...nfs, ...outs, ...digest(outs, caps)],
        proof: new Uint8Array(randomBytes(PROOF)), authorization: new Uint8Array(), capsules: caps };
    }
    await applyRecord(state, encodeRecord(record), replay);
    if ((i + 1) % SAMPLE === 0) sample(i + 1, { msPerEvent: +((performance.now() - start) / (i + 1)).toFixed(2) });
  }
  const first = samples[1], last = samples.at(-1);
  const slope = key => Math.round((last[key] - first[key]) * 1048576 / (last.events - first.events));
  console.log(JSON.stringify({ mode, events: N, proofBytes: PROOF, heapBytesPerEvent: slope("heapMiB"), externalBytesPerEvent: slope("externalMiB"),
    rssBytesPerEvent: slope("rssMiB"), samples }, null, 1));
} else {
  // The decision's layout for one segment:
  // - fact rows (nullifiers, outputs, anchors, events) are append-only and carry
  //   the position that added them, so a read at an earlier position bounds by it;
  // - the tip structures update in place: the spent set's nodes (behind a bounded
  //   write-back cache flushed at savepoint boundaries) and the note tree's frontier
  //   (in memory, stored with the segment row); no note-tree interior nodes;
  // - a checkpoint is a savepoint, a keep point a commit followed by SHA-256 of
  //   the state file; record bytes live in a separate evidence file.
  const CHECK = rest.includes("--check"), POSEIDON = rest.includes("--poseidon"), ROW_DIGEST = rest.includes("--row-digest"), KEEP_DIGEST = !rest.includes("--no-keep-digest");
  const C = Number(option("--checkpoint", "64")), KEEP = Number(option("--keep", String(N))), REFUSE = Number(option("--refuse-every", "0"));
  const JOURNAL = option("--journal", "truncate"), SYNC = option("--sync", "full"), CACHE_MIB = Number(option("--cache-mib", "64"));
  assert(["wal", "truncate"].includes(JOURNAL) && ["normal", "full"].includes(SYNC), "invalid journal or sync");
  assert([C, KEEP, CACHE_MIB].every(v => Number.isInteger(v) && v > 0) && Number.isInteger(REFUSE) && REFUSE >= 0, "invalid counts");
  assert(KEEP % C === 0 || KEEP >= N, "a keep point falls on a checkpoint boundary");
  const dir = resolve(option("--dir", "scratch/replay-store-probe/run")), stateFile = join(dir, "state.sqlite"), evidenceFile = join(dir, "evidence.sqlite");
  mkdirSync(dir, { recursive: true });
  for (const f of [stateFile, evidenceFile]) for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(f + s)) rmSync(f + s);
  const open = file => {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=${JOURNAL}; PRAGMA synchronous=${SYNC}; PRAGMA cache_size=-${CACHE_MIB * 1024}; PRAGMA temp_store=FILE;`);
    return db;
  };
  const db = open(stateFile), evidence = open(evidenceFile);
  db.exec(`
    CREATE TABLE spent (seg INTEGER, id INTEGER, key BLOB NOT NULL, bit INTEGER, l INTEGER, r INTEGER, hash BLOB NOT NULL, PRIMARY KEY(seg, id)) WITHOUT ROWID;
    CREATE TABLE nullifier (nf BLOB, seg INTEGER, position INTEGER NOT NULL, PRIMARY KEY(nf, seg)) WITHOUT ROWID;
    CREATE TABLE output (cm BLOB, seg INTEGER, position INTEGER NOT NULL, leaf INTEGER NOT NULL, capsule BLOB, PRIMARY KEY(cm, seg)) WITHOUT ROWID;
    CREATE TABLE anchor (root BLOB, seg INTEGER, position INTEGER NOT NULL, PRIMARY KEY(root, seg)) WITHOUT ROWID;
    CREATE TABLE event (seg INTEGER, position INTEGER, identity BLOB NOT NULL, idx INTEGER NOT NULL, value INTEGER NOT NULL,
      history BLOB NOT NULL, evidence BLOB NOT NULL, PRIMARY KEY(seg, position)) WITHOUT ROWID;
    CREATE INDEX event_identity ON event(identity);
    CREATE TABLE segment (seg INTEGER PRIMARY KEY, leaves INTEGER NOT NULL, spent_root INTEGER, spent_next INTEGER NOT NULL,
      position INTEGER NOT NULL, history BLOB NOT NULL, frontier BLOB NOT NULL) STRICT;`);
  evidence.exec("CREATE TABLE record (seg INTEGER, position INTEGER, bytes BLOB NOT NULL, PRIMARY KEY(seg, position)) WITHOUT ROWID;");
  const q = Object.fromEntries(Object.entries({
    spentGet: "SELECT key, bit, l, r, hash FROM spent WHERE seg=1 AND id=?", spentPut: "INSERT OR REPLACE INTO spent VALUES(1,?,?,?,?,?,?)",
    // As-of membership: a row counts only if its position is within the read's bound.
    nfHas: "SELECT 1 FROM nullifier WHERE nf=? AND seg=1 AND position<=?", nfPut: "INSERT INTO nullifier VALUES(?,1,?)",
    cmHas: "SELECT 1 FROM output WHERE cm=? AND seg=1 AND position<=?", cmPut: "INSERT INTO output VALUES(?,1,?,?,?)",
    anchorHas: "SELECT 1 FROM anchor WHERE root=? AND seg=1 AND position<=?", anchorPut: "INSERT OR IGNORE INTO anchor VALUES(?,1,?)",
    eventHas: "SELECT 1 FROM event WHERE identity=? AND seg=1 AND position<=?", eventPut: "INSERT INTO event VALUES(1,?,?,?,?,?,?)",
    eventAt: "SELECT identity, history, evidence FROM event WHERE seg=1 AND position=?",
    segGet: "SELECT leaves, spent_root, spent_next, position, history, frontier FROM segment WHERE seg=1",
    segPut: "INSERT OR REPLACE INTO segment VALUES(1,?,?,?,?,?,?)",
  }).map(([k, sql]) => [k, db.prepare(sql)]));
  const recordPut = evidence.prepare("INSERT INTO record VALUES(1,?,?)");

  // The note tree's frontier: frontier[l] is the completed left subtree of 2^l
  // leaves waiting for its right sibling, present where bit l of the leaf count is 1.
  const toBytes = v => (typeof v === "bigint" ? fieldToBytes(v) : v);
  const zero = POSEIDON ? EMPTY_NOTE_SUBTREE : (() => { const z = [Buffer.alloc(32)]; for (let l = 0; l < 32; l++) z.push(sha(Buffer.of(l), z[l], z[l])); return z; })();
  const hashNode = POSEIDON ? (l, a, b) => noteNode(l, a, b) : (l, a, b) => sha(Buffer.of(l), a, b);
  let frontier = Array(32).fill(null);
  const appendLeaf = (leaf, index) => {
    let node = leaf, l = 0;
    while ((index >> l) & 1) { node = hashNode(l, frontier[l], node); l++; }
    frontier[l] = node;
  };
  const noteRoot = count => {
    let node = zero[0];
    for (let l = 0; l < 32; l++) node = (count >> l) & 1 ? hashNode(l, frontier[l], node) : hashNode(l, node, zero[l]);
    return node;
  };
  const frontierBytes = () => Buffer.concat(frontier.map(v => (v === null ? Buffer.alloc(33) : Buffer.concat([Buffer.of(1), toBytes(v)]))));
  const frontierFrom = bytes => Array.from({ length: 32 }, (_, l) => {
    const slot = bytes.subarray(33 * l, 33 * l + 33);
    return slot[0] === 0 ? null : POSEIDON ? BigInt("0x" + Buffer.from(slot.subarray(1)).toString("hex")) : Buffer.from(slot.subarray(1));
  });

  // The compressed spent set (pool-spent C1.2.8–9) as stored nodes updated in
  // place along the insert path, behind a bounded write-back cache.
  const rightAt = (key, bit) => ((key[bit >> 3] >> (7 - (bit & 7))) & 1) === 1;
  const splitAt = (a, b) => { for (let i = 0; i < 32; i++) { const x = a[i] ^ b[i]; if (x !== 0) return i * 8 + Math.clz32(x) - 24; } return 256; };
  const branchHash = (bit, left, right) => sha(NODE, Buffer.of(bit >> 8, bit & 255), left, right);
  let seg = { leaves: 0, spentRoot: null, spentNext: 1, position: 0, history: Buffer.alloc(32), evidence: Buffer.alloc(32) };
  const CACHE = Number(option("--node-cache", "65536")), cache = new Map(), dirty = new Set();
  const write = (id, row) => q.spentPut.run(id, row.key, row.bit, row.l, row.r, row.hash);
  const remember = (id, row) => {
    cache.delete(id); cache.set(id, row);
    if (cache.size > CACHE) {
      const [old, oldRow] = cache.entries().next().value;
      if (dirty.delete(old)) write(old, oldRow);
      cache.delete(old);
    }
  };
  const spentGet = id => { const row = cache.get(id) ?? q.spentGet.get(id); remember(id, row); return row; };
  const spentPut = (id, key, bit, l, r, hash) => { dirty.add(id); remember(id, { key, bit, l, r, hash }); };
  const flush = () => { for (const id of dirty) write(id, cache.get(id)); dirty.clear(); };
  const spentInsert = key => {
    const leafId = seg.spentNext++, leafHash = sha(LEAF, key);
    spentPut(leafId, key, null, null, null, leafHash);
    if (seg.spentRoot === null) { seg.spentRoot = leafId; return leafHash; }
    const path = []; let id = seg.spentRoot, n = spentGet(id);
    for (;;) {
      const bit = splitAt(n.key, key);
      if (n.bit === null || bit < n.bit) {
        assert(bit < 256, "nullifier already spent");
        const branchId = seg.spentNext++, [l, r] = rightAt(key, bit) ? [id, leafId] : [leafId, id];
        let hash = branchHash(bit, l === leafId ? leafHash : n.hash, r === leafId ? leafHash : n.hash);
        spentPut(branchId, n.key, bit, l, r, hash);
        if (path.length === 0) seg.spentRoot = branchId;
        let child = branchId;
        for (let p = path.length - 1; p >= 0; p--) {
          const { id: pid, row, right } = path[p];
          const other = spentGet(right ? row.l : row.r).hash;
          hash = right ? branchHash(row.bit, other, hash) : branchHash(row.bit, hash, other);
          spentPut(pid, row.key, row.bit, right ? row.l : child, right ? child : row.r, hash); child = pid;
        }
        return hash;
      }
      const right = rightAt(key, n.bit);
      path.push({ id, row: n, right }); id = right ? n.r : n.l; n = spentGet(id);
    }
  };
  const spentRoot = () => (seg.spentRoot === null ? null : spentGet(seg.spentRoot).hash);

  // Scalars and frontier are stored before a savepoint opens, so a rollback reloads them.
  const saveSegment = () => q.segPut.run(seg.leaves, seg.spentRoot, seg.spentNext, seg.position, seg.history, frontierBytes());
  const loadSegment = () => {
    const row = q.segGet.get();
    seg = { leaves: row.leaves, spentRoot: row.spent_root, spentNext: row.spent_next, position: row.position, history: Buffer.from(row.history),
      evidence: row.position === 0 ? Buffer.alloc(32) : Buffer.from(q.eventAt.get(row.position).evidence) };
    frontier = frontierFrom(row.frontier);
  };
  const oracle = CHECK ? { spent: new RadixSpentSet(), tree: POSEIDON ? new NoteTree() : undefined } : undefined;

  // One spend-shaped event: guards read the pre-state at the tip, then effects apply.
  const makeEvent = i => ({
    nfs: i === 0 ? [] : [fieldToBytes(fieldOf()), fieldToBytes(fieldOf())],
    outs: i === 0 ? [fieldOf()] : [fieldOf(), fieldOf(), fieldOf(), fieldOf()],
    record: randomBytes(PROOF + 900),
  });
  const applyEvent = e => {
    const position = seg.position + 1, tip = seg.position, identity = sha(e.record);
    // Every synthetic spend is anchored at the empty root, an anchor from position 0.
    assert(e.nfs.length === 0 || q.anchorHas.get(noteRootEmpty, tip) !== undefined);
    assert.equal(q.eventHas.get(identity, tip), undefined);
    for (const nf of e.nfs) assert.equal(q.nfHas.get(nf, tip), undefined);
    const outs = e.outs.map(fieldToBytes);
    for (const cm of outs) assert.equal(q.cmHas.get(cm, tip), undefined);
    e.outs.forEach((cm, j) => { appendLeaf(POSEIDON ? cm : outs[j], seg.leaves + j); q.cmPut.run(outs[j], position, seg.leaves + j, randomBytes(89)); });
    seg.leaves += outs.length;
    for (const nf of e.nfs) { q.nfPut.run(nf, position); spentInsert(nf); }
    const root = toBytes(noteRoot(seg.leaves));
    q.anchorPut.run(root, position);
    // Each position keeps its chain values, so an earlier checkpoint's hashes and a receipt's event stay readable.
    seg.history = sha(seg.history, identity, root, spentRoot() ?? Buffer.alloc(32)); seg.evidence = sha(seg.evidence, identity);
    q.eventPut.run(position, identity, 100, e.nfs.length === 0 ? 1000 : 0, seg.history, seg.evidence);
    recordPut.run(position, e.record);
    seg.position = position;
  };
  const noteRootEmpty = toBytes(zero[32]);
  q.anchorPut.run(noteRootEmpty, 0);
  saveSegment();
  const keeps = [];
  const keepPoint = async () => {
    flush(); saveSegment();
    evidence.exec("COMMIT"); db.exec("COMMIT");
    if (!KEEP_DIGEST) { db.exec("BEGIN"); evidence.exec("BEGIN"); return undefined; }
    if (JOURNAL === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const t0 = performance.now(), h = createHash("sha256");
    for await (const chunk of createReadStream(stateFile, { highWaterMark: 1 << 20 })) h.update(chunk);
    keeps.push({ events: seg.position, ms: Math.round(performance.now() - t0), mib: mib(statSync(stateFile).size) });
    db.exec("BEGIN"); evidence.exec("BEGIN");
    return h.digest("hex");
  };
  sample(0);
  const start = performance.now(); let lastSample = start, rollbacks = 0, digest;
  db.exec("BEGIN"); evidence.exec("BEGIN");
  for (let i = 0, cp = 0; i < N; cp++) {
    const events = Array.from({ length: Math.min(C, N - i) }, (_, j) => makeEvent(i + j));
    // A checkpoint: flush, store the scalars, open the savepoint, apply.
    flush(); saveSegment(); db.exec("SAVEPOINT cp"); evidence.exec("SAVEPOINT cp");
    for (const e of events) applyEvent(e);
    if (REFUSE > 0 && cp % REFUSE === REFUSE - 1) {
      // Excluded: nothing it wrote survives; the caches and scalars reload.
      db.exec("ROLLBACK TO cp"); evidence.exec("ROLLBACK TO cp"); cache.clear(); dirty.clear(); loadSegment(); rollbacks++;
      for (const e of events) applyEvent(e);
    }
    flush(); db.exec("RELEASE cp"); evidence.exec("RELEASE cp");
    if (oracle) {
      for (const e of events) { e.nfs.forEach(nf => oracle.spent.insert(nf)); oracle.tree?.appendAll(e.outs); }
      if (oracle.spent.size > 0n) assert.deepEqual(new Uint8Array(spentRoot()), oracle.spent.root());
      if (oracle.tree) assert.equal(noteRoot(seg.leaves), oracle.tree.root());
    }
    const before = i; i += events.length;
    if (i % KEEP === 0 || i === N) digest = await keepPoint();
    if (Math.floor(i / SAMPLE) > Math.floor(before / SAMPLE)) {
      const now = performance.now();
      sample(i, { msPerEvent: +((now - start) / i).toFixed(3), intervalMsPerEvent: +((now - lastSample) / (i - (samples.at(-1)?.events ?? 0))).toFixed(3) });
      lastSample = now;
    }
  }
  const replayMs = performance.now() - start;
  evidence.exec("COMMIT"); db.exec("COMMIT");
  if (oracle) {
    // Every stored spent node rehashes from its stored children to the oracle's root.
    let nodes = 0;
    const verify = id => {
      const row = q.spentGet.get(id); nodes++;
      if (row.bit === null) { assert.deepEqual(new Uint8Array(row.hash), new Uint8Array(sha(LEAF, row.key))); return row.hash; }
      const hash = branchHash(row.bit, verify(row.l), verify(row.r));
      assert.deepEqual(new Uint8Array(row.hash), new Uint8Array(hash)); return hash;
    };
    assert.deepEqual(new Uint8Array(verify(seg.spentRoot)), oracle.spent.root());
    assert.equal(BigInt(nodes), 2n * oracle.spent.size - 1n);
  }
  const rowDigest = ROW_DIGEST ? (() => {
    const t0 = performance.now(), h = createHash("sha256"), tag = Buffer.alloc(9); let bytes = 0;
    for (const [table, order] of [["spent", "seg, id"], ["nullifier", "nf, seg"], ["output", "cm, seg"], ["anchor", "root, seg"], ["event", "seg, position"], ["segment", "seg"]]) {
      const statement = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`); statement.setReturnArrays(true);
      for (const row of statement.iterate()) for (const value of row) {
        if (value === null) { h.update(tag.subarray(0, 1).fill(0)); bytes += 1; }
        else if (typeof value === "number") { tag[0] = 1; tag.writeDoubleBE(value, 1); h.update(tag); bytes += 9; }
        else { tag[0] = 2; tag.writeDoubleBE(value.length, 1); h.update(tag); h.update(value); bytes += 9 + value.length; }
      }
    }
    return { ms: Math.round(performance.now() - t0), mib: mib(bytes) };
  })() : undefined;
  const rows = Object.fromEntries(["spent", "nullifier", "output", "anchor", "event"].map(t => [t, db.prepare(`SELECT count(*) c FROM ${t}`).get().c]));
  const tip = { root: toBytes(noteRoot(seg.leaves)), spent: spentRoot(), history: seg.history };
  db.close(); evidence.close();
  sample(N, { after: "close" });

  // Resume: reopen (a hot journal would roll back here), digest the closed file,
  // then recompute from the kept state what §14 compares with the snapshot:
  // the note root from the stored frontier, the spent root from the root's
  // stored children, the totals from the event rows.
  const t0 = performance.now();
  open(stateFile).close();
  const h = createHash("sha256");
  for await (const chunk of createReadStream(stateFile, { highWaterMark: 1 << 20 })) h.update(chunk);
  if (KEEP_DIGEST) assert.equal(h.digest("hex"), digest, "the kept state is the state last digested");
  const digestMs = performance.now() - t0, t1 = performance.now();
  const kept = open(stateFile), row = kept.prepare("SELECT * FROM segment WHERE seg=1").get();
  frontier = frontierFrom(row.frontier);
  assert.deepEqual(toBytes(noteRoot(row.leaves)), tip.root);
  if (row.spent_root !== null) {
    const top = kept.prepare("SELECT key, bit, l, r, hash FROM spent WHERE seg=1 AND id=?"), node = top.get(row.spent_root);
    const spent = node.bit === null ? sha(LEAF, node.key) : branchHash(node.bit, top.get(node.l).hash, top.get(node.r).hash);
    assert.deepEqual(Buffer.from(spent), Buffer.from(tip.spent));
  }
  assert.equal(kept.prepare("SELECT sum(value) s FROM event WHERE seg=1").get().s, 1000);
  // The chain at n from the stored value at n−1, record n's identity and the recomputed roots.
  const at = kept.prepare("SELECT identity, history FROM event WHERE seg=1 AND position=?"), final = at.get(row.position);
  const previous = row.position === 1 ? Buffer.alloc(32) : Buffer.from(at.get(row.position - 1).history);
  assert.deepEqual(sha(previous, final.identity, tip.root, tip.spent ?? Buffer.alloc(32)), tip.history);
  assert.deepEqual(Buffer.from(row.history), tip.history);
  kept.close();
  const recomputeMs = performance.now() - t1;

  const stateBytes = statSync(stateFile).size, evidenceBytes = statSync(evidenceFile).size;
  const first = samples[1], last = samples.at(-2);
  console.log(JSON.stringify({ mode, events: N, proofBytes: PROOF, recordBytes: PROOF + 900, checkpointEvery: C, keepEvery: KEEP,
    journal: JOURNAL, sync: SYNC, cacheMiB: CACHE_MIB, poseidon: POSEIDON, check: CHECK, rollbacks,
    msPerEvent: +(replayMs / N).toFixed(3), stateBytesPerEvent: Math.round(stateBytes / N), stateMiB: mib(stateBytes),
    evidenceBytesPerEvent: Math.round(evidenceBytes / N), rows,
    rssGrowthMiB: +(last.rssMiB - first.rssMiB).toFixed(1), heapGrowthMiB: +(last.heapMiB - first.heapMiB).toFixed(1),
    keeps: keeps.length > 8 ? [...keeps.slice(0, 3), ...keeps.slice(-3)] : keeps, rowDigest,
    resume: { reopenAndDigestMs: Math.round(digestMs), recomputeMs: Math.round(recomputeMs) },
    maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), node: process.version, samples }, null, 1));
}
