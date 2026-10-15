import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { entryChain, pathRoot, subjectKey, SubjectMap } from "../src/ergo-exhaustion.js";
import { bytesOf, compress, iv0, isPeriodEnd, periodLeaves, periodStreams, stateEnd, stateHash, wordsOf } from "../src/ergo-exhaustion-prover.js";
import { Chain, plainOutput, recordOutput, transaction } from "../src/ergo-synthetic.js";

// The exhaustion's prover side (succinct-read §4.3) without circuits: what scripts/venue/exhaustion-check.mjs executes
// the circuits over. Its leaves end a period where a fold requires, with SubjectMap's root.
const s = sha256(Uint8Array.of(1)), t = new Uint8Array(sha256(Uint8Array.of(2)));
t.set(s.subarray(28), 28);
function period(count: number) {
  const chain = new Chain();
  let tip = chain.anchor;
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const txs = [transaction([plainOutput])];
    if (i % 2 === 0) txs.push(transaction([recordOutput(1, s, new Uint8Array(200).fill(i)), plainOutput, recordOutput(2, t, new Uint8Array(3))]));
    tip = chain.mine(tip, txs, 0, i % 3 === 2 ? 1n : 2n);
    blocks.push(tip);
  }
  return { start: chain.anchor, blocks };
}

describe("the exhaustion's prover side (succinct-read §4.3)", () => {
  it("compresses as Blake2b-256 does", () => {
    for (const length of [0, 1, 127, 128]) {
      const message = Uint8Array.from({ length }, (_, i) => i * 7);
      const block = new Uint8Array(128);
      block.set(message);
      expect(bytesOf(compress(iv0(), block, BigInt(length), true).slice(0, 4))).toEqual(blake2b(message, { dkLen: 32 }));
    }
    const id = blake2b(Uint8Array.of(9), { dkLen: 32 });
    expect(bytesOf(wordsOf(id))).toEqual(id);
  });

  it("returns each appended entry with its key's path just before it", () => {
    const { start, blocks } = period(3);
    const map = new SubjectMap(start.id, start.height);
    let root: bigint | undefined = map.root, appended = 0;
    for (const b of blocks) {
      for (const { entry, before } of map.appendBlock(b.id, b.section.map(x => x.unsigned))) {
        const key = subjectKey(entry.subject);
        expect(pathRoot(key, before)).toBe(root);
        root = pathRoot(key, { count: before.count + 1n, chain: entryChain(before.chain, entry), siblings: before.siblings });
        appended++;
      }
      expect(root).toBe(map.root);
    }
    expect(appended).toBe(4);
  });

  it("ends a period at its last header, with every entry applied and the map's root", () => {
    const { start, blocks } = period(5);
    for (const sizes of [{ t: 2, m: 4, u: 1 }, { t: 6, m: 12, u: 6 }]) {
      const map = new SubjectMap(start.id, start.height);
      const run = periodLeaves(map, blocks.map(b => ({ header: b.bytes, transactions: b.section })), sizes);
      expect(isPeriodEnd(run.end)).toBe(true);
      expect(run.end.u.root).toBe(map.root);
      expect(stateEnd(run.end)).toEqual({ id: blocks.at(-1)!.id, height: blocks.at(-1)!.height });
      expect(run.leaves.filter(l => l.kind === "u").reduce((n, l) => n + (l.inputs.uu as boolean[]).filter(Boolean).length, 0)).toBe(6);
      run.leaves.forEach((leaf, i) => { if (i > 0) expect(leaf.sin).toBe(run.leaves[i - 1]!.sout); });
      expect(run.leaves[0]!.sin).toBe(stateHash(run.start));
    }
  });

  it("refuses a section that does not reproduce its header's root", () => {
    const { blocks } = period(1);
    expect(() => periodStreams([{ header: blocks[0]!.bytes, transactions: [...blocks[0]!.section, blocks[0]!.section[0]!] }])).toThrow(/root/);
  });
});
