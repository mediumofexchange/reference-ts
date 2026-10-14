import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { sectionInclusionPath, SubjectMap, subjectKey, succinctRange, testExhaustionSet, type ReaderChain } from "../src/ergo-exhaustion.js";
import { transactionsRoot } from "../src/ergo-profile.js";
import { Chain, plainOutput, recordOutput, transaction, type Block } from "../src/ergo-synthetic.js";
import { MAX_RANGE_RECORD_BYTES } from "../src/record-range.js";

// Succinct-read §2 rule 7 against a flawed scan: the circuits evaluate the scan's tables, so a reader judges a fetched
// grammatical transaction's entries by the framer's reading, the native check, never by the scan itself. Here the scan
// misses every output with the shape for one subject, as a flawed table would; the map a prover and a supplier build
// with it agrees with the scan, and only the framer shows the disagreement.
const flawed = vi.hoisted(() => ({ subject: undefined as Uint8Array | undefined }));
vi.mock("../src/ergo-scan.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/ergo-scan.js")>();
  return {
    ...real,
    scanTransaction: (unsigned: Uint8Array) => real.scanTransaction(unsigned)
      .filter(e => flawed.subject === undefined || compareBytes(e.subject, flawed.subject) !== 0),
  };
});

describe("a succinct range under a flawed scan (succinct-read §2 rule 7)", () => {
  it("shows the set unsound where the framer reads a shaped output for the key that the scan, and so the map, misses", async () => {
    const chain = new Chain(), anchor = chain.anchor, A = anchor.height;
    const s = sha256(Uint8Array.of(0x61)), t = new Uint8Array(sha256(Uint8Array.of(0x62)));
    t.set(s.subarray(28), 28); // t shares s's key
    flawed.subject = t;
    const rec = (subject: Uint8Array, fill: number) => recordOutput(1, subject, new Uint8Array(MAX_RANGE_RECORD_BYTES[1]).fill(fill));
    const blocks = chain.extend(anchor, 6, i => i === 1 ? [transaction([plainOutput]), transaction([rec(s, 1), rec(t, 2)])] : [transaction([plainOutput])]);
    const at = new Map<bigint, Block>(blocks.map(b => [b.height, b]));
    const rootOf = (b: Block) => transactionsRoot(2n, b.section.map(x => ({ id: blake2b(x.unsigned, { dkLen: 32 }), witnessId: x.witnessId })));
    const readerChain: ReaderChain = {
      at: height => { const b = at.get(height); return b && { id: b.id, transactionsRoot: rootOf(b) }; },
      tipHeight: blocks[blocks.length - 1]!.height,
    };
    const set = testExhaustionSet("ergo-exhaustion-scan-flaw.test", { id: anchor.id, height: A });
    const map = new SubjectMap(anchor.id, A);
    for (const b of blocks.slice(0, 3)) map.appendBlock(b.id, b.section.map(x => x.unsigned));
    const inputs = { startId: anchor.id, startHeight: A, endId: map.end.id, endHeight: map.end.height, mapRoot: map.root, foldKeyHash: set.foldKeyHash };
    const key = subjectKey(s);
    // The flawed map holds s's entry only.
    expect(map.entries(key).map(e => compareBytes(e.subject, s))).toEqual([0]);
    const result = await succinctRange({ venue: new Uint8Array(32), kind: 1, subject: s, fromIndex: 0n, toIndex: 2n }, {
      profile: chain.profile(3n), anchorHeight: A, set, chain: readerChain, fold: { first: false, inputs, proof: set.prove(false, inputs) },
      path: map.path(key), entries: map.entries(key),
      transaction: (height, position) => {
        const b = at.get(height)!;
        return { unsigned: b.section[Number(position)]!.unsigned, steps: sectionInclusionPath(b.section, rootOf(b), Number(position))! };
      },
      sectionAt: () => undefined,
    });
    expect(result).toEqual({ refused: "disagreement" });
  });
});
