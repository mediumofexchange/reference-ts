import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldToBytes } from "../src/pool/field.js";
import { EMPTY_NOTE_ROOT, NoteTree, notePathProves } from "../src/pool/note-tree.js";
import { EvidenceRefusal } from "../src/pool/v3/refusals.js";
import { keptFileDigest, ReplayStore, type Append } from "../src/pool/v3/replay-store.js";
import { RadixSpentSet } from "../src/pool/v3/spent-set.js";
import { stoppedKeepPoint } from "./support.js";

// The storage module against the runtime's own structures: stored spent-set
// nodes give RadixSpentSet's root, the frontier gives NoteTree's root, and an
// incremental witness gives NoteTree's path, across rolled-back savepoints.

const genesis = { history: new Uint8Array(32), evidence: new Uint8Array(32) };
let counter = 1000n;
/** A witnessed output's mark in these cases: its nullifier is the commitment plus 10⁶. */
const mark = (cm: bigint) => ({ nf: cm + 1_000_000n, note: fieldToBytes(cm) });
const next = (): bigint => counter++;
function append(outputs: bigint[], nfs: bigint[], witness: (cm: bigint) => boolean = () => false, extra: Partial<Append> = {}): Append {
  return { identity: fieldToBytes(next()), kind: 2, index: 5n, record: new Uint8Array([1]), proofHash: new Uint8Array(32), signatureHash: new Uint8Array(32),
    evidence: new Uint8Array(32), supply: undefined,
    nullifiers: nfs.map(nf => ({ nf, tag: nf + 1n })), outputs: outputs.map(cm => ({ cm, capsule: undefined, settlement: false, witness: witness(cm) ? mark(cm) : undefined })),
    demand: undefined, ended: undefined, keys: [], history: () => new Uint8Array(32), ...extra };
}

describe("replay storage", () => {
  it("keeps the spent and note roots, and witnessed paths, equal to the runtime structures", () => {
    const store = new ReplayStore(), ns = store.open(new Uint8Array(32), new Uint8Array(32), undefined, genesis);
    const tree = new NoteTree(), spent = new RadixSpentSet(), watched = new Set<bigint>();
    expect(store.tip(ns).noteRoot).toBe(EMPTY_NOTE_ROOT);
    expect(store.tip(ns).spentRoot).toEqual(spent.root());
    for (let i = 0; i < 40; i++) {
      const outputs = Array.from({ length: 1 + (i % 4) }, next), nfs = i % 3 === 0 ? [] : [next(), next()];
      const tip = store.append(ns, append(outputs, nfs, cm => cm % 7n === 0n));
      outputs.forEach(cm => { if (cm % 7n === 0n) watched.add(cm); });
      tree.appendAll(outputs); nfs.forEach(nf => spent.insert(fieldToBytes(nf)));
      expect(tip.noteRoot).toBe(tree.root());
      expect(tip.spentRoot).toEqual(spent.root());
      for (const cm of watched) {
        const out = store.output(ns, tip.position, cm)!, w = store.witness(ns, tip.position, out.leaf)!;
        expect(w.path).toEqual(tree.path(out.leaf));
        expect(notePathProves(tip.noteRoot, cm, w.path)).toBe(true);
      }
    }
    expect(watched.size).toBeGreaterThan(5);
  });

  it("gives NoteTree's path for a witness born at any leaf as blocks beside it fill and complete across records", () => {
    const store = new ReplayStore(), ns = store.open(new Uint8Array(32), new Uint8Array(32), undefined, genesis);
    const tree = new NoteTree(), born: bigint[] = [], edges = new Set([0, 1, 2, 3, 7, 8, 15, 16, 63, 64, 255, 256, 511]);
    let leaves = 0;
    for (let i = 0; leaves < 700; i++) {
      // Records of 0 to 12 outputs, so a block completes inside one record, across two, or at its last output.
      const outputs = Array.from({ length: (i * 7) % 13 }, next), first = leaves;
      const tip = store.append(ns, append(outputs, [], cm => edges.has(first + outputs.indexOf(cm)) || cm % 11n === 0n));
      outputs.forEach((cm, j) => { if (edges.has(first + j) || cm % 11n === 0n) born.push(BigInt(first + j)); });
      tree.appendAll(outputs); leaves += outputs.length;
      expect(tip.noteRoot).toBe(tree.root());
      if (i % 5 !== 0 && leaves < 690) continue;
      for (const leaf of born) {
        const w = store.witness(ns, tip.position, leaf)!;
        expect(w.path).toEqual(tree.path(leaf));
        expect(w.anchor).toBe(tree.root());
      }
    }
    expect(born.length).toBeGreaterThan(70);
  });

  it("reads an earlier position, and rolls a refused checkpoint back to its pre-state", async () => {
    const store = new ReplayStore(), ns = store.open(new Uint8Array(32), new Uint8Array(32), undefined, genesis);
    store.append(ns, append([1n], [11n]));
    const at1 = store.tip(ns);
    await expect(store.replay(async () => {
      store.append(ns, append([2n, 3n], [12n], () => true));
      expect(store.hasNullifier(ns, 2n, 12n)).toBe(true);
      throw new Error("refused");
    })).rejects.toThrow("refused");
    expect(store.tip(ns)).toEqual(at1);
    expect(store.hasNullifier(ns, 5n, 12n)).toBe(false);
    expect(store.hasOutput(ns, 5n, 2n)).toBe(false);
    store.append(ns, append([4n], [13n]));
    // As-of reads bound every fact by position.
    expect(store.hasNullifier(ns, 1n, 13n)).toBe(false);
    expect(store.hasNullifier(ns, 2n, 13n)).toBe(true);
    expect(store.hasAnchor(ns, 1n, at1.noteRoot)).toBe(true);
    expect(store.hasAnchor(ns, 0n, at1.noteRoot)).toBe(false);
    expect(store.hasAnchor(ns, 0n, EMPTY_NOTE_ROOT)).toBe(true);
  });

  it("imports by reference: a successor sees its predecessor's rows up to the imported position only", () => {
    const store = new ReplayStore(), a = store.open(new Uint8Array(32).fill(1), new Uint8Array(32), undefined, genesis);
    store.append(a, append([1n], [11n])); store.append(a, append([2n], [12n]));
    const b = store.open(new Uint8Array(32).fill(2), new Uint8Array(32).fill(2),
      { segments: new Map([[Buffer.from(new Uint8Array(32).fill(1)).toString("hex"), { ns: a, upto: 1n }]]), totals: new Map() }, genesis);
    expect(store.hasNullifier(b, 0n, 11n)).toBe(true);
    expect(store.hasNullifier(b, 0n, 12n)).toBe(false);
    const spent = new RadixSpentSet(); spent.insert(fieldToBytes(11n));
    expect(store.tip(b).spentRoot).toEqual(spent.root());
    expect(store.tip(b).noteRoot).toBe(EMPTY_NOTE_ROOT);
    store.collect([b]);
    expect(store.hasOutput(b, 0n, 1n)).toBe(true);
  });

  it("leaves out a witnessed output once its kept nullifier is visible, imports included, and keeps its mark's bytes", () => {
    const store = new ReplayStore(), a = store.open(new Uint8Array(32).fill(1), new Uint8Array(32), undefined, genesis);
    const unspent = (ns: number, p: bigint) => [...store.unspentWitnessed(ns, p)].map(output => [output.cm, output.mark.nf, output.mark.note]);
    store.append(a, append([1n, 2n, 3n], [], cm => cm !== 2n));
    store.append(a, append([4n], [mark(1n).nf], () => true));
    expect(unspent(a, 1n)).toEqual([[1n, mark(1n).nf, fieldToBytes(1n)], [3n, mark(3n).nf, fieldToBytes(3n)]]);
    expect(unspent(a, 2n).map(([cm]) => cm)).toEqual([3n, 4n]);
    // A successor spending a predecessor's witnessed output leaves it out there, and not in the predecessor.
    const b = store.open(new Uint8Array(32).fill(2), new Uint8Array(32).fill(2),
      { segments: new Map([[Buffer.from(new Uint8Array(32).fill(1)).toString("hex"), { ns: a, upto: 2n }]]), totals: new Map() }, genesis);
    expect(unspent(b, 0n).map(([cm]) => cm)).toEqual([3n, 4n]);
    store.append(b, append([5n], [mark(3n).nf], () => true));
    expect(unspent(b, 1n).map(([cm]) => cm)).toEqual([4n, 5n]);
    expect(unspent(a, 2n).map(([cm]) => cm)).toEqual([3n, 4n]);
  });

  it("lives in a host's database: writes join the host's transaction, and an imported frontier is copied in once", () => {
    const db = new DatabaseSync(":memory:", { readBigInts: true }), store = new ReplayStore(db);
    expect(() => new ReplayStore(db, { digest: "x" })).toThrow(TypeError);
    expect(() => store.openWalk(new Uint8Array(32))).toThrow(/no walk/);
    // A host's rolled-back transaction takes the namespace and its record with it.
    db.exec("BEGIN IMMEDIATE");
    const lost = store.open(new Uint8Array(32).fill(1), new Uint8Array(32), undefined, genesis);
    store.append(lost, append([1n], [11n]));
    db.exec("ROLLBACK");
    expect(store.hasNamespace(lost)).toBe(false);
    db.exec("BEGIN IMMEDIATE");
    const a = store.open(new Uint8Array(32).fill(1), new Uint8Array(32), undefined, genesis);
    store.append(a, append([1n], [11n]));
    store.append(a, append([2n], [12n], () => false, { kind: 1, supply: { backing: "aa".repeat(32), issued: 5n, burned: 0n } }));
    db.exec("COMMIT");
    expect(store.tip(a).position).toBe(2n);
    expect(store.hasIssuance(a, 2n, 0n, "aa".repeat(32))).toBe(true);
    expect(store.hasIssuance(a, 2n, 2n, "aa".repeat(32))).toBe(false);
    expect(store.hasIssuance(a, 1n, 0n, "aa".repeat(32))).toBe(false);
    expect(store.hasIssuance(a, 2n, 0n, "bb".repeat(32))).toBe(false);

    // A read in a store of its own: a segment of three records over one it imports at its first.
    const reads = new ReplayStore(), one = new Uint8Array(32).fill(1), two = new Uint8Array(32).fill(2), name = (n: number) => `0${n}`.repeat(32);
    const history = (n: number) => () => new Uint8Array(32).fill(n);
    const base = reads.open(one, new Uint8Array(32).fill(7), undefined, genesis);
    reads.append(base, append([1n], [11n], () => false, { history: history(1) })); reads.append(base, append([2n], [12n], () => false, { history: history(2) }));
    const read = reads.open(two, new Uint8Array(32).fill(8), { segments: new Map([[name(1), { ns: base, upto: 1n }]]), totals: new Map() }, genesis);
    reads.append(read, append([3n], [13n], () => false, { history: history(3), demand: { id: "d1", value: { backing: two, quantity: 1n, tags: [5n, 6n], presenter: one, instant: 4n, deadline: 9n } } }));
    reads.append(read, append([4n], [14n], () => false, { history: history(4), ended: "d1" }));
    reads.append(read, append([5n], [15n], () => false, { history: history(5) }));
    const frontier = { segments: new Map([[name(1), { ns: base, upto: 1n }], [name(2), { ns: read, upto: 2n }]]), totals: new Map([["aa".repeat(32), { issued: 7n, burned: 1n }]]) };
    const identity = (segment: Uint8Array) => new Uint8Array(32).fill(segment[0]! + 100);
    const copied = store.copyFrontier(reads, frontier, identity);
    expect(copied.totals).toEqual(frontier.totals);
    expect([...copied.segments.values()].map(entry => entry.upto)).toEqual([1n, 2n]);
    const successor = store.open(new Uint8Array(32).fill(3), new Uint8Array(32).fill(9), copied, genesis);
    // The successor reads the imported prefixes, to their positions and no further, from the host's own rows.
    expect([11n, 12n, 13n, 14n, 15n].map(nf => store.hasNullifier(successor, 0n, nf))).toEqual([true, false, true, true, false]);
    expect([1n, 2n, 3n, 4n, 5n].map(cm => store.hasOutput(successor, 0n, cm))).toEqual([true, false, true, true, false]);
    expect(store.demand(successor, 0n, "d1")).toBeUndefined();
    expect(store.eventCount(successor, 0n)).toBe(3n);
    expect(store.total(successor, 0n, "aa".repeat(32))).toEqual({ issued: 7n, burned: 1n });
    const spent = new RadixSpentSet(); [11n, 13n, 14n].forEach(nf => spent.insert(fieldToBytes(nf)));
    expect(store.tip(successor).spentRoot).toEqual(spent.root());
    // The successor over the copies holds exactly the facts a successor over the read's own namespaces holds.
    const direct = reads.open(new Uint8Array(32).fill(3), new Uint8Array(32).fill(9), frontier, genesis);
    expect(store.factDigest(successor, 0n)).toEqual(reads.factDigest(direct, 0n));
    expect(store.factDigest(successor, 0n)).not.toEqual(reads.factDigest(read, 3n));
    // The same prefix again is the copy already here; a longer one of the same segment is copied anew.
    const again = new ReplayStore(), twin = again.open(one, new Uint8Array(32).fill(7), undefined, genesis);
    again.append(twin, append([1n], [11n], () => false, { history: history(1) })); again.append(twin, append([2n], [12n], () => false, { history: history(2) }));
    const once = store.copyFrontier(again, { segments: new Map([[name(1), { ns: twin, upto: 1n }]]), totals: new Map() }, identity);
    expect(once.segments.get(name(1))!.ns).toBe(copied.segments.get(name(1))!.ns);
    const longer = store.copyFrontier(again, { segments: new Map([[name(1), { ns: twin, upto: 2n }]]), totals: new Map() }, identity);
    expect(longer.segments.get(name(1))!.ns).not.toBe(copied.segments.get(name(1))!.ns);
    expect(() => store.copyFrontier(again, { segments: new Map([[name(1), { ns: twin, upto: 3n }]]), totals: new Map() }, identity)).toThrow(/no replayed position/);
    again.close(); reads.close();
    // What another namespace imports cannot be dropped; the host's retired state can.
    expect(() => store.drop(copied.segments.get(name(2))!.ns)).toThrow(/still read/);
    store.drop(a);
    expect(store.hasNamespace(a)).toBe(false);
    // Closing is the host's.
    store.close();
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it("holds a kept file's write lock across a keep point, so another store's walk is refused while the walk awaits", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-keep-point-")), path = join(dir, "replay.sqlite"), digest = join(dir, "replay.sha256");
    const first = new ReplayStore(path, { digest, every: 1 }), context = new Uint8Array(32).fill(7);
    try {
      const { walk } = first.openWalk(context), ns = first.open(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), undefined, genesis);
      first.append(ns, append([next()], []));
      first.keepPoint();
      expect(existsSync(digest)).toBe(true);
      // A second store would take the first's rows: it is refused, at its opening (its check cannot move the log in
      // while the first holds the write lock) or at its walk.
      expect(() => {
        const second = new ReplayStore(path, { digest });
        try { second.openWalk(context); } finally { second.close(); }
      }).toThrow("the kept replay file is in use");
      expect(first.walkRows()).toBeGreaterThan(0);
      first.closeWalk(walk);
    } finally { first.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("records at each keep point the digest the whole file gives, through growth, freed pages and reopening (M11b12)", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-page-digest-")), path = join(dir, "replay.sqlite"), digest = join(dir, "replay.sha256");
    const context = new Uint8Array(32).fill(7), vouched = () => readFileSync(digest, "utf8") === keptFileDigest(path);
    let store = new ReplayStore(path, { digest });
    try {
      const kept: number[] = [];
      for (let round = 0; round < 5; round++) {
        const { walk } = store.openWalk(context), ns = store.open(fieldToBytes(BigInt(round)), new Uint8Array(32).fill(2), undefined, genesis);
        for (let i = 0; i < 60; i++) store.append(ns, append([next(), next()], [next()], cm => cm % 2n === 0n));
        kept.push(ns);
        store.closeWalk(walk);
        expect(vouched()).toBe(true);
        // Dropping namespaces frees pages inside the file; the next keep point's digest still covers every page.
        if (round % 2 === 1) {
          kept.shift(); store.collect(kept);
          store.closeWalk(store.openWalk(context).walk);
          expect(vouched()).toBe(true);
        }
      }
      // Past one group of 256 pages, so a keep point rehashes some groups and not others.
      expect(statSync(path).size).toBeGreaterThan(256 * 4096);
      const tip = store.tip(kept[0]!);
      store.close();
      // The digest holds, so the file is reused as it was left.
      store = new ReplayStore(path, { digest });
      expect(store.tip(kept[0]!)).toEqual(tip);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("reopens a keep point stopped between its commit and its digest as the digest names it, never whole replay (Next 4 (bb))", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-keep-stopped-")), path = join(dir, "replay.sqlite"), digest = join(dir, "replay.sha256");
    const context = new Uint8Array(32).fill(7), vouched = () => readFileSync(digest, "utf8") === keptFileDigest(path);
    let store = new ReplayStore(path, { digest });
    try {
      const kept: number[] = [];
      for (let round = 0; round < 3; round++) {
        const { walk } = store.openWalk(context), ns = store.open(fieldToBytes(BigInt(round)), new Uint8Array(32).fill(2), undefined, genesis);
        for (let i = 0; i < 60; i++) store.append(ns, append([next(), next()], [next()]));
        kept.push(ns);
        store.closeWalk(walk);
      }
      const tips = kept.map(ns => store.tip(ns)), drop = (ns: number) => `DELETE FROM namespace WHERE ns = ${ns}`;
      // Stopped before its digest: the file is as the old digest names it, beside a log whose commit no digest vouches
      // for. The log is dropped and the file reused; only that keep point's work is lost.
      store.close();
      stoppedKeepPoint(path, digest, drop(kept[0]!), false);
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      expect(vouched()).toBe(true);
      store = new ReplayStore(path, { digest });
      expect(kept.map(ns => store.tip(ns))).toEqual(tips);
      // Stopped after its digest, before the log moved in: recovery moves the log in, and the file gives the digest.
      store.close();
      stoppedKeepPoint(path, digest, drop(kept[0]!), true);
      expect(vouched()).toBe(false);
      store = new ReplayStore(path, { digest });
      expect(store.hasNamespace(kept[0]!)).toBe(false);
      expect(store.tip(kept[1]!)).toEqual(tips[1]);
      // A log whose commit was torn (its last frame cut short) commits nothing: the file is reused as it lies.
      store.close();
      stoppedKeepPoint(path, digest, drop(kept[1]!), false);
      truncateSync(`${path}-wal`, statSync(`${path}-wal`).size - 1);
      store = new ReplayStore(path, { digest });
      expect(store.tip(kept[1]!)).toEqual(tips[1]);
      // An unvouched log beside a file the digest does not name either: the file is damaged, and discarded with the log.
      store.close();
      stoppedKeepPoint(path, digest, drop(kept[1]!), false);
      const bytes = readFileSync(path); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; writeFileSync(path, bytes);
      store = new ReplayStore(path, { digest });
      expect(store.hasNamespace(kept[1]!)).toBe(false);
      expect(store.hasNamespace(kept[2]!)).toBe(false);
      // So is a copy of a stopped file: its identity is not the one the digest names, so its log is not dropped.
      store.close();
      const ns = (store = new ReplayStore(path, { digest }), store.open(fieldToBytes(9n), new Uint8Array(32).fill(2), undefined, genesis));
      store.closeWalk(store.openWalk(context).walk);
      store.close();
      stoppedKeepPoint(path, digest, drop(ns), false);
      const crash = join(dir, "crash"), copy = join(crash, "replay.sqlite");
      mkdirSync(crash);
      for (const name of ["replay.sqlite", "replay.sqlite-wal", "replay.sha256"]) copyFileSync(join(dir, name), join(crash, name));
      store = new ReplayStore(copy, { digest: join(crash, "replay.sha256") });
      expect(store.hasNamespace(ns)).toBe(false);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("stops a walk whose keep point another connection keeps from moving the log in: what it writes after commits nothing (M11b12 review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-keep-busy-")), path = join(dir, "replay.sqlite"), digest = join(dir, "replay.sha256");
    const store = new ReplayStore(path, { digest, every: 1 }), context = new Uint8Array(32).fill(7);
    try {
      const { walk } = store.openWalk(context), ns = store.open(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), undefined, genesis);
      store.append(ns, append([next()], []));
      store.keepPoint();
      const reader = new DatabaseSync(path);
      try {
        reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM namespace").get();
        store.append(ns, append([next()], []));
        expect(() => store.keepPoint()).toThrow("the kept replay file is in use");
        reader.exec("COMMIT");
      } finally { reader.close(); }
      // The keep point committed its own record; one written after it goes with the lost walk.
      store.append(ns, append([next()], []));
      store.closeWalk(walk);
      expect(store.tip(ns).position).toBe(2n);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps the digest through a keep point another connection kept from moving the log in, though the log restarted between (M11b12 review)", () => {
    const dir = mkdtempSync(join(tmpdir(), "moe-keep-pending-")), path = join(dir, "replay.sqlite"), digest = join(dir, "replay.sha256");
    const context = new Uint8Array(32).fill(7), vouched = () => readFileSync(digest, "utf8") === keptFileDigest(path);
    let store = new ReplayStore(path, { digest });
    try {
      let { walk } = store.openWalk(context);
      const ns = store.open(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), undefined, genesis);
      for (let i = 0; i < 30; i++) store.append(ns, append([next()], [next()]));
      store.closeWalk(walk);
      ({ walk } = store.openWalk(context));
      for (let i = 0; i < 30; i++) store.append(ns, append([next()], [next()]));
      const other = new DatabaseSync(path);
      try {
        other.exec("BEGIN"); other.prepare("SELECT count(*) FROM namespace").get();
        expect(() => store.closeWalk(walk)).toThrow("the kept replay file is in use");
        other.exec("COMMIT");
        // Another connection moves the log into the file, so this store's next write restarts it under new salts.
        other.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      } finally { other.close(); }
      ({ walk } = store.openWalk(context));
      store.append(ns, append([next()], []));
      store.closeWalk(walk);
      expect(vouched()).toBe(true);
      store.close();
      store = new ReplayStore(path, { digest });
      expect(store.hasNamespace(ns)).toBe(true);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps one object per venue position: a position answered for a second backing leaves the read unresolved (§13.1)", () => {
    const store = new ReplayStore(), backingA = new Uint8Array(32).fill(1), backingB = new Uint8Array(32).fill(2);
    try {
      store.putPublications(backingA, [{ index: 5n, ordinal: 1n, record: Uint8Array.of(1) }, { index: 5n, ordinal: 2n, record: Uint8Array.of(2) }]);
      store.putPublications(backingB, [{ index: 5n, ordinal: 3n, record: Uint8Array.of(3) }]);
      let refusal: unknown;
      try { store.putPublications(backingB, [{ index: 5n, ordinal: 2n, record: Uint8Array.of(4) }]); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(EvidenceRefusal);
      expect((refusal as EvidenceRefusal).status).toBe("unresolved-evidence");
      expect(() => store.putPublications(backingA, [{ index: 5n, ordinal: 1n, record: Uint8Array.of(1) }])).toThrow(EvidenceRefusal);
      expect(store.publicationCount(backingA, 5n)).toBe(2);
      expect(store.publicationCount(backingB, 5n)).toBe(1);
      expect(store.nextPublication(backingB, undefined, 5n)?.ordinal).toBe(3n);
    } finally { store.close(); }
  });
});
