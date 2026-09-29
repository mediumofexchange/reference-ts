import { describe, expect, it } from "vitest";
import { fieldToBytes } from "../src/pool/field.js";
import { EMPTY_NOTE_ROOT, NoteTree, notePathProves } from "../src/pool/note-tree.js";
import { ReplayStore, type Append } from "../src/pool/v3/replay-store.js";
import { RadixSpentSet } from "../src/pool/v3/spent-set.js";

// The storage module against the runtime's own structures: stored spent-set
// nodes give RadixSpentSet's root, the frontier gives NoteTree's root, and an
// incremental witness gives NoteTree's path, across rolled-back savepoints.

const genesis = { history: new Uint8Array(32), evidence: new Uint8Array(32) };
let counter = 1000n;
const next = (): bigint => counter++;
function append(outputs: bigint[], nfs: bigint[], witness: (cm: bigint) => boolean = () => false, extra: Partial<Append> = {}): Append {
  return { identity: fieldToBytes(next()), kind: 2, index: 5n, record: new Uint8Array([1]), proofHash: new Uint8Array(32), signatureHash: new Uint8Array(32),
    evidence: new Uint8Array(32), supply: undefined,
    nullifiers: nfs.map(nf => ({ nf, tag: nf + 1n })), outputs: outputs.map(cm => ({ cm, capsule: undefined, settlement: false, witness: witness(cm) })),
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
});
