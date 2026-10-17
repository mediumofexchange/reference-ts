import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FIELD_MODULUS } from "../src/pool/field.js";
import {
  EMPTY_SUBTREES, entryChain, foldPublicInputs, inclusionPath, inclusionRoot, mapLeaf, mapNode, pathRoot, sectionInclusionPath, SubjectMap,
  subjectKey, succinctRange, testExhaustionSet, type Fold, type IncludedTransaction, type KeptTuple, type MapEntry, type ReaderChain,
  type SuccinctRangeSources,
} from "../src/ergo-exhaustion.js";
import { attributeSection, collBytes, frameTransaction, rangeEntries, transactionsRoot, type ErgoTransactionView } from "../src/ergo-profile.js";
import { scanTransaction } from "../src/ergo-scan.js";
import { Chain, plainOutput, rawOutput, recordOutput, transaction, SYNTHETIC_SCRIPTS, type Block, type Output } from "../src/ergo-synthetic.js";
import { supplyBlock } from "../src/ergo-supplier.js";
import { MAX_RANGE_RECORD_BYTES, type RangeRequest, type RecordKind } from "../src/record-range.js";

// Succinct-read §4 over synthetic chains and recorded mainnet blocks: the scan against the framer, the subject map and
// its paths, inclusion paths, and a succinct range against the complete read. Fold proofs come from a test set
// (hashes anyone computes), which exercises the reader's rules and attests nothing.
const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const vlq = (n: number): Uint8Array => {
  const out: number[] = [];
  do { let byte = n & 0x7f; n = Math.floor(n / 128); if (n > 0) byte |= 0x80; out.push(byte); } while (n > 0);
  return Uint8Array.from(out);
};
const coll = (bytes: Uint8Array): Uint8Array => cat(Uint8Array.of(0x0e), vlq(bytes.length), bytes);
const id = (t: ErgoTransactionView): Uint8Array => blake2b(t.unsigned, { dkLen: 32 });
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
/** A deterministic generator, so a failure names its seed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** What venue-ergo §6 calls the shape, read through the framer: each output whose own R4 is a 32-byte `Coll[Byte]` and
 * R5 a `Coll[Byte]`, in output order. */
function framedShape(unsigned: Uint8Array): { output: number; subject: string }[] | undefined {
  const outputs = frameTransaction(unsigned);
  if (outputs === undefined) return undefined;
  const found: { output: number; subject: string }[] = [];
  outputs.forEach((o, output) => {
    const r4 = o.registers["R4"] && collBytes(o.registers["R4"]), r5 = o.registers["R5"] && collBytes(o.registers["R5"]);
    if (r4 !== undefined && r4.length === 32 && r5 !== undefined) found.push({ output, subject: Buffer.from(r4).toString("hex") });
  });
  return found;
}
const scanned = (unsigned: Uint8Array): { output: number; subject: string }[] =>
  scanTransaction(unsigned).map(e => ({ output: e.output, subject: Buffer.from(e.subject).toString("hex") }));

const mainnetBlocks = ["100000", "1000000", "1500000", "1827841", "1876512"].map(height => {
  const fixture = JSON.parse(readFileSync(new URL(`../experiments/ergo-range/fixtures/mainnet-${height}.json`, import.meta.url), "utf8"));
  const { supplied } = supplyBlock(JSON.stringify(fixture.blockTransactions));
  return { height, root: Buffer.from(fixture.header.transactionsRoot, "hex"), transactions: supplied.map(t => t!) };
});

/** A random output: a tree of one of the framer's kinds, tokens, and registers some of which have the shape. */
function randomOutput(next: () => number, subjects: readonly Uint8Array[]): Output & { tokens: number } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const tree = pick([SYNTHETIC_SCRIPTS[1], SYNTHETIC_SCRIPTS[4], Uint8Array.of(0x18, 3, 1, 2, 3)]);
  const count = Math.floor(next() * 7), registers: Uint8Array[] = [];
  for (let r = 0; r < count; r++) {
    const length = r === 0 ? pick([0, 31, 32, 33, 32]) : pick([0, 1, 32, 200]);
    registers.push(coll(r === 0 && length === 32 ? pick(subjects) : new Uint8Array(length).fill(r + 1)));
  }
  return { ergoTree: tree, registers, tokens: Math.floor(next() * 3) };
}
/** A grammatical transaction with extension entries, data inputs, token ids and token amounts. */
function randomTransaction(next: () => number, subjects: readonly Uint8Array[]): Uint8Array {
  const inputs = 1 + Math.floor(next() * 2), parts: Uint8Array[] = [vlq(inputs)];
  for (let i = 0; i < inputs; i++) {
    const entries = Math.floor(next() * 3);
    parts.push(new Uint8Array(32).fill(i + 9), vlq(0), Uint8Array.of(entries));
    for (let e = 0; e < entries; e++) parts.push(Uint8Array.of(e), coll(new Uint8Array(Math.floor(next() * 40)).fill(5)));
  }
  const data = Math.floor(next() * 2), tokens = 1 + Math.floor(next() * 2);
  parts.push(vlq(data), ...Array.from({ length: data }, () => new Uint8Array(32).fill(6)), vlq(tokens), ...Array.from({ length: tokens }, () => new Uint8Array(32).fill(7)));
  const outputs = Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomOutput(next, subjects));
  parts.push(vlq(outputs.length));
  for (const o of outputs) {
    parts.push(vlq(1 + Math.floor(next() * 2 ** 30)), o.ergoTree, vlq(Math.floor(next() * 2 ** 20)), Uint8Array.of(o.tokens));
    for (let t = 0; t < o.tokens; t++) parts.push(vlq(t % tokens), vlq(Math.floor(next() * 2 ** 40)));
    parts.push(Uint8Array.of(o.registers.length), ...o.registers);
  }
  return cat(...parts);
}

describe("the scan (succinct-read §4.2)", () => {
  const subjects = [sha256(Uint8Array.of(1)), sha256(Uint8Array.of(2))];

  it("reads exactly the framer's shaped outputs over generated grammatical transactions and their mutations", () => {
    let grammatical = 0, mutatedGrammatical = 0, shaped = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const next = random(seed), unsigned = randomTransaction(next, subjects);
      const framed = framedShape(unsigned);
      expect(framed, `seed ${seed}`).toBeDefined();
      grammatical++;
      shaped += framed!.length;
      expect(scanned(unsigned), `seed ${seed}`).toEqual(framed);
      for (let m = 0; m < 20; m++) {
        const mutated = new Uint8Array(unsigned);
        mutated[Math.floor(next() * mutated.length)] = Math.floor(next() * 256);
        const again = framedShape(mutated);
        if (again === undefined) continue;
        mutatedGrammatical++;
        expect(scanned(mutated), `seed ${seed} mutation ${m}`).toEqual(again);
      }
    }
    expect(grammatical).toBe(250);
    expect(shaped).toBeGreaterThan(100);
    expect(mutatedGrammatical).toBeGreaterThan(1000);
  });

  it("reads exactly the framer's shaped outputs in recorded mainnet blocks", () => {
    let transactions = 0;
    for (const block of mainnetBlocks) {
      for (const t of block.transactions) {
        const framed = framedShape(t.unsigned);
        if (framed !== undefined) expect(scanned(t.unsigned)).toEqual(framed);
        transactions++;
      }
    }
    expect(transactions).toBe(39);
  });

  it("reads records at every location and the fee tree's outputs, and passes over a shape it does not have", () => {
    const fee = rawOutput(Buffer.from("1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a7017300730110010204" +
      "02d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304", "hex"), [coll(subjects[0]!), coll(Uint8Array.of(1))]);
    const t = transaction([recordOutput(2, subjects[0]!, new Uint8Array(233)), plainOutput, fee,
      rawOutput(SYNTHETIC_SCRIPTS[1], [coll(new Uint8Array(31)), coll(Uint8Array.of(1))]), rawOutput(SYNTHETIC_SCRIPTS[1], [coll(subjects[1]!)]),
      recordOutput(4, subjects[1]!, new Uint8Array(0))]);
    expect(scanned(t.unsigned)).toEqual(framedShape(t.unsigned));
    expect(scanned(t.unsigned).map(e => e.output)).toEqual([0, 2, 5]);
  });

  it("keeps what it read before bytes outside the grammar, which the framer refuses whole", () => {
    const t = transaction([recordOutput(1, subjects[0]!, new Uint8Array(136)), recordOutput(1, subjects[1]!, new Uint8Array(136))]);
    const trailing = cat(t.unsigned, Uint8Array.of(0));
    expect(frameTransaction(trailing)).toBeUndefined();
    expect(scanned(trailing).map(e => e.output)).toEqual([0, 1]);
    // A non-minimal R4 length is outside the grammar; the scan carries no validity test and reads the shape.
    const nonMinimal = Buffer.from(t.unsigned), at = nonMinimal.indexOf(cat(Uint8Array.of(0x0e, 32), subjects[1]!));
    const patched = cat(nonMinimal.subarray(0, at + 1), Uint8Array.of(0xa0, 0x00), nonMinimal.subarray(at + 2));
    expect(frameTransaction(patched)).toBeUndefined();
    expect(scanned(patched).map(e => e.output)).toEqual([0, 1]);
  });
});

describe("the subject map (succinct-read §4.2)", () => {
  const start = sha256(Uint8Array.of(9));
  it("starts empty at z_32 and gives each key's path to its root", () => {
    const map = new SubjectMap(start, 100n);
    expect(map.root).toBe(EMPTY_SUBTREES[32]);
    expect(pathRoot(7n, map.path(7n))).toBe(map.root);
    const a = sha256(Uint8Array.of(1)), b = new Uint8Array(sha256(Uint8Array.of(2)));
    b.set(a.subarray(28), 28); // the same key as a
    const block = [transaction([recordOutput(1, a, new Uint8Array(136)), recordOutput(3, b, new Uint8Array(96))]).unsigned,
      transaction([recordOutput(4, a, new Uint8Array(5))]).unsigned];
    map.appendBlock(sha256(Uint8Array.of(10)), block);
    expect(map.end.height).toBe(101n);
    const key = subjectKey(a), entries = map.entries(key);
    expect(entries.map(e => [e.position, e.output, same(e.subject, a)])).toEqual([[0n, 0n, true], [0n, 1n, false], [1n, 0n, true]]);
    let chain = 0n;
    for (const e of entries) chain = entryChain(chain, e);
    expect(map.path(key)).toMatchObject({ count: 3n, chain });
    for (const k of [key, key ^ 1n, 0n, (1n << 32n) - 1n]) expect(pathRoot(k, map.path(k))).toBe(map.root);
    // By hand: one nonempty leaf under empty siblings.
    let node = mapLeaf(3n, chain);
    for (let l = 0; l < 32; l++) node = (key >> BigInt(l)) & 1n ? mapNode(EMPTY_SUBTREES[l]!, node) : mapNode(node, EMPTY_SUBTREES[l]!);
    expect(node).toBe(map.root);
  });
  it("refuses a malformed path", () => {
    const map = new SubjectMap(start, 100n), path = map.path(5n);
    expect(pathRoot(5n, { ...path, chain: 1n })).toBeUndefined();
    expect(pathRoot(5n, { ...path, siblings: path.siblings.slice(1) })).toBeUndefined();
    expect(pathRoot(5n, { ...path, count: 1n << 64n })).toBeUndefined();
    expect(pathRoot(1n << 32n, path)).toBeUndefined();
  });
});

describe("inclusion paths (succinct-read §4.5)", () => {
  const section = (n: number): ErgoTransactionView[] => Array.from({ length: n }, () => transaction([plainOutput]));
  it("reproduce a section's root under either rule at every position", () => {
    for (let n = 1; n <= 19; n++) {
      const txs = section(n), ids = txs.map(id), wids = txs.map(t => t.witnessId);
      for (const [version, leaves] of [[1n, ids], [2n, [...ids, ...wids]]] as const) {
        const root = transactionsRoot(version, txs.map(t => ({ id: id(t), witnessId: t.witnessId })));
        for (let j = 0; j < n; j++) {
          const path = inclusionPath(leaves, j);
          expect(inclusionRoot(ids[j]!, j, path)).toEqual(root);
          expect(sectionInclusionPath(txs, root, j)).toEqual(path);
          // Another position's id gives another root.
          if (n > 1) expect(inclusionRoot(ids[(j + 1) % n]!, j, path)).not.toEqual(root);
        }
      }
    }
    for (const block of mainnetBlocks) {
      const txs = block.transactions;
      for (let j = 0; j < txs.length; j++) expect(inclusionRoot(id(txs[j]!), j, sectionInclusionPath(txs, block.root, j)!)).toEqual(Uint8Array.from(block.root));
    }
  });
  it("refuses a lone child where the position's bit is one, a position past the path, and malformed steps", () => {
    const txs = section(3), ids = txs.map(id);
    // Position 2 of three: its first step is a lone child. Read at position 3 (bit 0 set), the same steps are refused.
    const path = inclusionPath(ids, 2);
    expect(path[0]).toBeNull();
    expect(inclusionRoot(ids[2]!, 3, path)).toBeUndefined();
    // Position 6 has a bit at the path's length (2): refused although its low bits are position 2's.
    expect(inclusionRoot(ids[2]!, 6, path)).toBeUndefined();
    // A trailing lone child is one more level: another root.
    expect(inclusionRoot(ids[2]!, 2, [...path, null])).not.toEqual(inclusionRoot(ids[2]!, 2, path));
    expect(inclusionRoot(ids[2]!, 2, [new Uint8Array(31), path[1]!])).toBeUndefined();
    expect(inclusionRoot(ids[2]!, 2, [])).toBeUndefined();
    expect(inclusionRoot(ids[0]!, 0, Array.from({ length: 33 }, () => null))).toBeUndefined();
  });
});

describe("a succinct range (succinct-read §4.4)", () => {
  const chain = new Chain(), anchor = chain.anchor, A = anchor.height, depth = 3n;
  const s = sha256(Uint8Array.of(0x51)), t = new Uint8Array(sha256(Uint8Array.of(0x52)));
  t.set(s.subarray(28), 28); // t shares s's key
  const u = sha256(Uint8Array.of(0x53));
  const rec = (kind: RecordKind, subject: Uint8Array, fill: number, length = MAX_RANGE_RECORD_BYTES[kind]): Output =>
    recordOutput(kind, subject, new Uint8Array(Math.min(length, 400)).fill(fill));
  // Block i (index i, height A + 1 + i) carries records of every kind for s, t and u at varying positions, kind-4 runs,
  // and, at block 5, an ungrammatical transaction holding an output with the shape for s.
  const blocks = chain.extend(anchor, 24, i => {
    const txs = [transaction([plainOutput])];
    if (i % 3 === 0) txs.push(transaction([rec(1, s, i), plainOutput, rec(2, t, i)]));
    if (i % 4 === 1) txs.push(transaction([rec(4, s, i, 30), rec(4, s, i + 1, 30), plainOutput, rec(4, s, i + 2, 30), rec(4, t, i, 9)]));
    if (i % 5 === 2) txs.push(transaction([rec(3, s, 200 - i), rec(3, s, 100 + i), rec(3, u, i)]));
    if (i === 5) {
      const bad = transaction([rec(1, s, 77)]);
      txs.push({ unsigned: cat(bad.unsigned, Uint8Array.of(0)), witnessId: bad.witnessId });
    }
    if (i === 7) txs.push(transaction([rec(2, u, 1), rec(1, s, 1, 135)]));
    return txs;
  });
  const set = testExhaustionSet("ergo-exhaustion.test", { id: anchor.id, height: A });
  const at = new Map<bigint, Block>(blocks.map(b => [b.height, b]));
  const readerChain: ReaderChain = {
    at: height => { const b = at.get(height); return b && { id: b.id, transactionsRoot: transactionsRoot(2n, b.section.map(x => ({ id: id(x), witnessId: x.witnessId }))) }; },
    tipHeight: blocks[blocks.length - 1]!.height,
  };
  const profile = chain.profile(depth);
  const sections = new Map<bigint, ReturnType<typeof attributeSection>>(blocks.map((b, i) => [BigInt(i), attributeSection(profile, b.section, readerChain.at(b.height)!.transactionsRoot)]));
  /** The map at each height from the start, as a prover keeps it. */
  function mapAt(end: bigint): SubjectMap {
    const map = new SubjectMap(anchor.id, A);
    for (const b of blocks) if (b.height <= end) map.appendBlock(b.id, b.section.map(x => x.unsigned));
    return map;
  }
  const folds = new Map<bigint, { map: SubjectMap; fold: Fold }>();
  function foldAt(end: bigint): { map: SubjectMap; fold: Fold } {
    if (!folds.has(end)) folds.set(end, makeFold(end));
    return folds.get(end)!;
  }
  function makeFold(end: bigint): { map: SubjectMap; fold: Fold } {
    const map = mapAt(end), inputs = { startId: anchor.id, startHeight: A, endId: map.end.id, endHeight: map.end.height, mapRoot: map.root, foldKeyHash: set.foldKeyHash };
    return { map, fold: { first: false, inputs, proof: set.prove(false, inputs) } };
  }
  const transactionAt = (height: bigint, position: bigint): IncludedTransaction | undefined => {
    const b = at.get(height), tx = b?.section[Number(position)];
    return b && tx && { unsigned: tx.unsigned, steps: sectionInclusionPath(b.section, readerChain.at(height)!.transactionsRoot, Number(position))! };
  };
  function sources(request: RangeRequest, end: bigint, overrides: Partial<SuccinctRangeSources> = {}): SuccinctRangeSources {
    const { map, fold } = foldAt(end), key = subjectKey(request.subject);
    return { profile, anchorHeight: A, set, chain: readerChain, fold, path: map.path(key), entries: map.entries(key),
      transaction: transactionAt, sectionAt: index => sections.get(index), ...overrides };
  }
  const request = (kind: RecordKind, subject: Uint8Array, fromIndex: bigint, toIndex: bigint): RangeRequest => ({ venue: new Uint8Array(32), kind, subject, fromIndex, toIndex });

  it("equals the complete read for every kind and subject, with the fold's end inside, below and above the range", async () => {
    let nonempty = 0;
    for (const end of [A + 1n, A + 9n, A + 15n, readerChain.tipHeight - depth]) {
      for (const kind of [1, 2, 3, 4] as const) for (const subject of [s, t, u]) {
        for (const [from, to] of [[0n, 20n], [2n, 6n], [8n, 20n], [5n, 5n], [0n, 0n]] as const) {
          const r = request(kind, subject, from, to);
          const complete = rangeEntries(index => sections.get(index), r)!;
          const succinct = await succinctRange(r, sources(r, end));
          expect(succinct, `end ${end - A}, kind ${kind}, ${from}..${to}`).toEqual({ entries: complete, kept: expect.anything() });
          if (complete.length > 0) nonempty++;
        }
      }
    }
    expect(nonempty).toBeGreaterThan(80);
  });

  it("passes over an ungrammatical transaction's entry after fetching it", async () => {
    const r = request(1, s, 5n, 5n), fetched: bigint[] = [];
    const got = await succinctRange(r, sources(r, A + 15n, { transaction: (h, p) => { fetched.push(p); return transactionAt(h, p); } }));
    expect(fetched.length).toBeGreaterThan(0);
    expect(got).toEqual({ entries: rangeEntries(index => sections.get(index), r), kept: expect.anything() });
  });

  it("refuses a fold that is not the pinned set's, starts elsewhere, ends off the reader's chain or above its depth", async () => {
    const r = request(1, s, 0n, 20n), base = foldAt(A + 15n).fold;
    const refused = async (fold: Fold): Promise<unknown> => (await succinctRange(r, sources(r, A + 15n, { fold })));
    expect(await refused({ ...base, proof: new Uint8Array(32) })).toEqual({ refused: "fold-proof" });
    expect(await refused({ ...base, first: true })).toEqual({ refused: "fold-proof" });
    const other = testExhaustionSet("another", { id: anchor.id, height: A });
    expect(await refused({ ...base, proof: other.prove(false, base.inputs) })).toEqual({ refused: "fold-proof" });
    const signed = (inputs: Fold["inputs"]): Fold => ({ first: false, inputs, proof: set.prove(false, inputs) });
    expect(await refused(signed({ ...base.inputs, foldKeyHash: base.inputs.foldKeyHash + 1n }))).toEqual({ refused: "fold-key" });
    expect(await refused(signed({ ...base.inputs, startHeight: A + 1n }))).toEqual({ refused: "fold-start" });
    expect(await refused(signed({ ...base.inputs, startId: blocks[0]!.id }))).toEqual({ refused: "fold-start" });
    expect(await refused(signed({ ...base.inputs, endId: blocks[0]!.id }))).toEqual({ refused: "fold-end" });
    const side = chain.extend(blocks[14]!, 1, () => [], 99)[0]!;
    expect(await refused(signed({ ...base.inputs, endId: side.id }))).toEqual({ refused: "fold-end" });
    const high = foldAt(readerChain.tipHeight - depth + 1n).fold;
    expect(await succinctRange(r, sources(r, A + 15n, { fold: high }))).toEqual({ refused: "fold-depth" });
    const late = testExhaustionSet("late start", { id: blocks[3]!.id, height: A + 4n });
    const lateMap = new SubjectMap(blocks[3]!.id, A + 4n);
    for (const b of blocks.slice(4, 15)) lateMap.appendBlock(b.id, b.section.map(x => x.unsigned));
    const lateInputs = { startId: blocks[3]!.id, startHeight: A + 4n, endId: lateMap.end.id, endHeight: lateMap.end.height, mapRoot: lateMap.root, foldKeyHash: late.foldKeyHash };
    expect(await succinctRange(r, sources(r, A + 15n, { set: late, fold: { first: false, inputs: lateInputs, proof: late.prove(false, lateInputs) },
      path: lateMap.path(subjectKey(s)), entries: lateMap.entries(subjectKey(s)) }))).toEqual({ refused: "start" });
  });

  it("refuses a path or entries that do not reproduce the fold's root", async () => {
    const r = request(1, s, 0n, 20n), { map } = foldAt(A + 15n), key = subjectKey(s), path = map.path(key), entries = map.entries(key);
    const check = async (o: Partial<SuccinctRangeSources>): Promise<unknown> => succinctRange(r, sources(r, A + 15n, o));
    expect(await check({ path: { ...path, count: path.count + 1n } })).toEqual({ refused: "path" });
    expect(await check({ path: { ...path, siblings: [...path.siblings.slice(0, 31), 5n] } })).toEqual({ refused: "path" });
    expect(await check({ path: map.path(key ^ 1n) })).toEqual({ refused: "path" });
    expect(entries.length).toBeGreaterThan(3);
    expect(await check({ entries: entries.slice(1) })).toEqual({ refused: "entries" });
    expect(await check({ entries: [...entries.slice(0, 2), entries[3]!, entries[2]!, ...entries.slice(4)] })).toEqual({ refused: "entries" });
    expect(await check({ entries: entries.map((e, i) => i === 2 ? { ...e, output: e.output + 1n } : e) })).toEqual({ refused: "entries" });
    expect(await check({ entries: [...entries, entries[0]!] })).toEqual({ refused: "entries" });
    expect(await check({ entries: entries.map((e, i) => i === 0 ? { ...e, height: 1n << 32n } : e) })).toEqual({ refused: "entries" });
    // Another key's entries cannot stand in, even where the chain would be recomputed from them.
    const other = map.entries(subjectKey(u));
    expect(await check({ entries: other })).toEqual({ refused: "entries" });
    // A list padded past the path's count is refused before any entry is read or hashed: padding costs the reader
    // nothing, however long.
    let read = 0;
    const padding = { get subject(): Uint8Array { read++; return s; }, height: A + 1n, position: 0n, output: 0n };
    expect(await check({ entries: [...entries, ...Array.from({ length: 10_000 }, () => padding)] })).toEqual({ refused: "entries" });
    expect(await check({ entries: [padding, ...entries] })).toEqual({ refused: "entries" });
    expect(read).toBe(0);
  });

  it("refuses a withheld transaction, one at another position or without its path, and a missing section above the fold", async () => {
    const r = request(4, s, 0n, 20n);
    const check = async (o: Partial<SuccinctRangeSources>): Promise<unknown> => succinctRange(r, sources(r, A + 15n, o));
    expect(await check({ transaction: () => undefined })).toEqual({ refused: "transaction" });
    expect(await check({ transaction: (h, p) => transactionAt(h, p === 0n ? 1n : p - 1n) })).toEqual({ refused: "transaction" });
    expect(await check({ transaction: (h, p) => ({ ...transactionAt(h, p)!, steps: [] }) })).toEqual({ refused: "transaction" });
    expect(await check({ transaction: (h, p) => { const x = transactionAt(h, p)!; return { ...x, unsigned: cat(x.unsigned, Uint8Array.of(0)) }; } }))
      .toEqual({ refused: "transaction" });
    expect(await check({ sectionAt: index => index === 18n ? undefined : sections.get(index) })).toEqual({ refused: "section" });
    // A section below the fold's end is never read.
    expect(await check({ sectionAt: index => index < 15n ? undefined : sections.get(index) })).toEqual({ entries: rangeEntries(i => sections.get(i), r), kept: expect.anything() });
  });

  it("continues from a kept tuple, proves absence by an unchanged count, and drops a tuple the chain no longer holds", async () => {
    const key = subjectKey(u), early = request(3, u, 0n, 9n);
    const first = await succinctRange(early, sources(early, A + 10n));
    expect("kept" in first).toBe(true);
    const kept = (first as { kept: KeptTuple }).kept;
    expect(kept).toMatchObject({ key, endHeight: A + 10n });
    const later = request(3, u, 10n, 20n), { map } = foldAt(A + 18n);
    const continued = await succinctRange(later, sources(later, A + 18n, { kept, entries: map.entries(key, kept.count) }));
    expect(continued).toEqual({ entries: rangeEntries(i => sections.get(i), later), kept: expect.objectContaining({ count: map.path(key).count }) });
    // u's entries end at index 17 (block 17 holds kind 3 for u): from 18 the count is unchanged, an absence.
    const quiet = await succinctRange(request(3, u, 18n, 20n), sources(request(3, u, 18n, 20n), A + 18n,
      { kept: (continued as { kept: KeptTuple }).kept, entries: [] }));
    expect(quiet).toEqual({ entries: [], kept: expect.anything() });
    const moved = { ...kept, endId: blocks[0]!.id };
    expect(await succinctRange(later, sources(later, A + 18n, { kept: moved, entries: map.entries(key, kept.count) }))).toEqual({ refused: "kept" });
    expect(await succinctRange(later, sources(later, A + 18n, { kept: { ...kept, identity: new Uint8Array(32) }, entries: map.entries(key, kept.count) })))
      .toEqual({ refused: "kept" });
    expect(await succinctRange(later, sources(later, A + 18n, { kept: { ...kept, key: kept.key ^ 1n }, entries: map.entries(key, kept.count) })))
      .toEqual({ refused: "kept" });
    // A tuple kept at a fold above this read's fold does not continue it.
    const laterKept = (continued as { kept: KeptTuple }).kept;
    expect(await succinctRange(request(3, u, 19n, 20n), sources(request(3, u, 19n, 20n), A + 15n, { kept: laterKept, entries: [] })))
      .toEqual({ refused: "kept" });
    await expect(succinctRange(early, sources(early, A + 18n, { kept }))).rejects.toThrow(RangeError);
  });

  it("shows the set unsound where an included grammatical transaction's shaped outputs are not the map's entries (§2 rule 7)", async () => {
    const r = request(1, s, 0n, 20n), { map, fold } = foldAt(A + 15n), key = subjectKey(s), honest = map.path(key), entries = map.entries(key);
    const forged = async (changed: readonly MapEntry[]): Promise<unknown> => {
      let chain = 0n;
      for (const e of changed) chain = entryChain(chain, e);
      const path = { count: BigInt(changed.length), chain, siblings: honest.siblings };
      const inputs = { ...fold.inputs, mapRoot: pathRoot(key, path)! };
      return succinctRange(r, sources(r, A + 15n, { fold: { first: false, inputs, proof: set.prove(false, inputs) }, path, entries: changed }));
    };
    // An entry naming an output its transaction does not have with the shape.
    const at = entries.findIndex(e => same(e.subject, s));
    expect(await forged(entries.map((e, i) => i === at ? { ...e, output: e.output + 1n } : e))).toEqual({ refused: "disagreement" });
    // A shaped output for the key left out of the map, in a transaction fetched for s: t's output beside s's.
    const lone = entries.findIndex(e => same(e.subject, t) && entries.some(x => same(x.subject, s) && x.height === e.height && x.position === e.position &&
      x.height > A && x.height <= A + 15n));
    expect(lone).toBeGreaterThanOrEqual(0);
    expect(await forged(entries.filter((_, i) => i !== lone))).toEqual({ refused: "disagreement" });
    // The ungrammatical transaction's entry is the scan's own: no disagreement is read from it.
    expect(await forged(entries)).toEqual({ entries: rangeEntries(i => sections.get(i), r), kept: expect.anything() });
  });

  it("reads a supplier's fold, path, entries and transactions once, whatever they show later or during the verification", async () => {
    const r = request(1, s, 0n, 20n), complete = rangeEntries(i => sections.get(i), r)!, { map, fold } = foldAt(A + 9n), key = subjectKey(s);
    const empty = { count: 0n, chain: 0n, siblings: map.path(key).siblings };
    // A mapRoot that shows the verified root once, then a root where s's key is empty: the empty path is refused.
    let reads = 0;
    const swapping = { ...fold.inputs, get mapRoot() { return reads++ === 0 ? fold.inputs.mapRoot : pathRoot(key, empty)!; } };
    expect(await succinctRange(r, sources(r, A + 9n, { fold: { ...fold, inputs: swapping }, path: empty, entries: [] }))).toEqual({ refused: "path" });
    // An end height that moves up after the checks: the read uses the height it checked.
    let heights = 0;
    const moving = { ...fold.inputs, get endHeight() { return heights++ === 0 ? fold.inputs.endHeight : readerChain.tipHeight - depth; } };
    expect(await succinctRange(r, sources(r, A + 9n, { fold: { ...fold, inputs: moving } }))).toEqual({ entries: complete, kept: expect.anything() });
    // An end id the supplier rewrites to the reader's header while an asynchronous verification runs, under a proof of a
    // made-up end with s's key empty: the id checked is the made-up one.
    const madeUp = { ...fold.inputs, endId: new Uint8Array(sha256(Uint8Array.of(0xff))), mapRoot: pathRoot(key, empty)! };
    const slow = { ...set, verifyFold: async (f: boolean, i: readonly bigint[], p: Uint8Array) => { await new Promise(go => setImmediate(go)); return set.verifyFold(f, i, p); } };
    const proof = set.prove(false, madeUp);
    setImmediate(() => madeUp.endId.set(map.end.id));
    expect(await succinctRange(r, sources(r, A + 9n, { set: slow, fold: { first: false, inputs: madeUp, proof }, path: empty, entries: [] }))).toEqual({ refused: "fold-end" });
    // An entry whose height reads in range once and as a non-canonical value after: read once, so the read neither
    // throws nor changes.
    const entries = map.entries(key);
    let looks = 0;
    const flipping = entries.map((e, i) => i === 0 ? { ...e, get height() { return looks++ === 0 ? e.height : e.height + FIELD_MODULUS; } } : e);
    expect(await succinctRange(r, sources(r, A + 9n, { entries: flipping }))).toEqual({ entries: complete, kept: expect.anything() });
  });

  it("lays a fold's public inputs out in §4.3's order, the ids as big-endian limbs", () => {
    const { fold } = foldAt(A + 4n);
    const hex = Buffer.from(fold.inputs.endId).toString("hex");
    expect(foldPublicInputs(fold.inputs)!.slice(3, 6)).toEqual([BigInt(`0x${hex.slice(0, 32)}`), BigInt(`0x${hex.slice(32)}`), A + 4n]);
    expect(foldPublicInputs({ ...fold.inputs, mapRoot: -1n })).toBeUndefined();
  });
});
