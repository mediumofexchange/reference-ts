import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { foldPublicInputs, pathRoot, subjectKey, testExhaustionSet, type Fold } from "../src/ergo-exhaustion.js";
import { ExhaustionServer, ExhaustionServerError, type ServedBlock } from "../src/ergo-exhaustion-server.js";
import {
  circuitExhaustionSet, circuitIdentities, EXHAUSTION_CIRCUITS, EXHAUSTION_KEY_BYTES, EXHAUSTION_SET_MANIFEST, exhaustionKeys, exhaustionSetIdentity,
  shippedExhaustionSet, type ExhaustionCircuits,
} from "../src/ergo-exhaustion-set.js";
import { fieldToHex } from "../src/pool/field.js";
import { Chain, plainOutput, recordOutput, transaction } from "../src/ergo-synthetic.js";

// A replica taking a fold it did not prove (slice 43): its own kept fold after a restart, or one proved elsewhere. The
// fold must be of the server's start and key hash, verify, and end where the map over the blocks ends with its root;
// a verified fold the map disagrees with stops the server. Folds here are a test set's; the shipped circuit set's are
// proved by the succinct drill.
const s = sha256(Uint8Array.of(1)), u = sha256(Uint8Array.of(2));
function chain(count: number) {
  const c = new Chain();
  let tip = c.anchor;
  const blocks: ServedBlock[] = [];
  for (let i = 0; i < count; i++) {
    const txs = [transaction([plainOutput])];
    if (i % 2 === 0) txs.push(transaction([recordOutput(1, s, new Uint8Array(150).fill(i)), plainOutput, recordOutput(2, u, new Uint8Array(3))]));
    tip = c.mine(tip, txs, 0, 2n);
    blocks.push({ id: tip.id, transactionsRoot: tip.bytes.subarray(65, 97), section: tip.section, header: tip.bytes });
  }
  return { start: { id: c.anchor.id, height: c.anchor.height }, blocks };
}
const { start, blocks } = chain(8);
const set = testExhaustionSet("ergo-exhaustion-adopt.test", start);
const server = () => new ExhaustionServer({ start, foldKeyHash: set.foldKeyHash, prove: (first, inputs) => set.prove(first, inputs) });
const verify = (fold: Fold) => set.verifyFold(fold.first, foldPublicInputs(fold.inputs)!, fold.proof);

describe("a server adopting a fold (slice 43)", () => {
  it("takes a fold proved elsewhere, serves the same paths, and continues it with a next fold", async () => {
    const prover = server();
    await prover.extend(blocks.slice(0, 3));
    const fold = await prover.extend(blocks.slice(3, 5));
    const taker = server();
    expect(await taker.adopt(fold, blocks.slice(0, 5), verify)).toEqual(fold);
    expect(taker.latest).toEqual(fold);
    for (const subject of [s, u, new Uint8Array(32)]) {
      const key = subjectKey(subject), answer = await taker.key(fold.inputs.endHeight, key, 0n);
      expect(answer).toEqual(await prover.key(fold.inputs.endHeight, key, 0n));
      expect(pathRoot(key, answer!.path)).toBe(fold.inputs.mapRoot);
    }
    const next = await taker.extend(blocks.slice(5));
    expect(next.first).toBe(false);
    expect(next).toEqual(await prover.extend(blocks.slice(5)));
    expect(await taker.transaction(start.height + 7n, 1n)).toEqual(await prover.transaction(start.height + 7n, 1n));
  });

  it("refuses a fold of another start or key hash, one that does not verify, and one ending elsewhere than its blocks, before appending", async () => {
    const prover = server(), fold = await prover.extend(blocks.slice(0, 4)), taker = server();
    const other = testExhaustionSet("another", start);
    const refusals: [Fold, ServedBlock[], string][] = [
      [{ ...fold, inputs: { ...fold.inputs, startHeight: start.height + 1n } }, blocks.slice(0, 4), "of another start or key hash"],
      [{ ...fold, inputs: { ...fold.inputs, foldKeyHash: other.foldKeyHash } }, blocks.slice(0, 4), "of another start or key hash"],
      [{ ...fold, proof: other.prove(true, fold.inputs) }, blocks.slice(0, 4), "does not verify"],
      [{ ...fold, first: false }, blocks.slice(0, 4), "does not verify"],
      [fold, blocks.slice(0, 3), "not 3 blocks above"],
      [fold, [], "not 0 blocks above"],
    ];
    for (const [offered, given, why] of refusals) {
      await expect(taker.adopt(offered, given, verify)).rejects.toSatisfy((e: unknown) => e instanceof ExhaustionServerError && e.code === "FOLD" && e.message.includes(why));
    }
    // Nothing was appended: the fold is still taken over the same blocks.
    expect(taker.height).toBe(start.height);
    expect(await taker.adopt(fold, blocks.slice(0, 4), verify)).toEqual(fold);
    await expect(taker.adopt(fold, null as never, verify)).rejects.toBeInstanceOf(EncodingError);
    await expect(taker.adopt({ ...fold, proof: "x" } as never, blocks.slice(0, 4), verify)).rejects.toBeInstanceOf(EncodingError);
  });

  it("reads a fold's blocks by height one at a time, and refuses one whose block is not at hand before appending", async () => {
    const fold = await server().extend(blocks.slice(0, 6)), at = (h: bigint) => blocks[Number(h - start.height - 1n)];
    const gap = server();
    await expect(gap.adopt(fold, h => h === start.height + 3n ? undefined : at(h), verify)).rejects.toMatchObject({ code: "FOLD",
      message: expect.stringContaining("is not at hand") });
    expect(gap.height).toBe(start.height);
    const reads: bigint[] = [], taker = server();
    expect(await taker.adopt(fold, h => { reads.push(h); return at(h); }, verify)).toEqual(fold);
    // Checked at hand, then appended to the map, then to the served map: three reads a height, the end once more.
    expect(reads.length).toBe(6 * 3 + 1);
    expect(await taker.key(fold.inputs.endHeight, subjectKey(s), 0n)).toBeDefined();
    // A block that cannot be read again after verification breaks the server as an availability fault, not a disagreement.
    let seen = 0;
    const flaky = server();
    await expect(flaky.adopt(fold, h => { if (h === start.height + 3n && ++seen > 1) throw new Error("storage"); return at(h); }, verify))
      .rejects.toMatchObject({ code: "BLOCKS" });
    expect(await flaky.fold(1n << 40n)).toBeUndefined();
    await expect(flaky.extend(blocks.slice(6))).rejects.toMatchObject({ code: "BLOCKS" });
  });

  it("refuses a fold while a period is pending", async () => {
    let fail = true;
    const pending = new ExhaustionServer({ start, foldKeyHash: set.foldKeyHash, prove: (first, inputs) => {
      if (fail) throw new Error("the prover stopped");
      return set.prove(first, inputs);
    } });
    await expect(pending.extend(blocks.slice(0, 2))).rejects.toThrow("the prover stopped");
    const fold = await server().extend(blocks.slice(0, 2));
    await expect(pending.adopt(fold, [], verify)).rejects.toMatchObject({ code: "PENDING" });
    fail = false;
    expect(await pending.extend([])).toEqual(fold);
  });

  it("stops serving where a fold verifies but the map over its blocks ends elsewhere", async () => {
    const prover = server(), fold = await prover.extend(blocks.slice(0, 4)), taker = server();
    // The same headers with block 2's section changed (one shaped output fewer): the fold verifies, the map disagrees.
    const altered = blocks.slice(0, 4).map((b, i) => i === 2 ? { ...b, section: [b.section[0]!] } : b);
    await expect(taker.adopt(fold, altered, verify)).rejects.toMatchObject({ code: "DISAGREEMENT" });
    expect(await taker.fold(1n << 40n)).toBeUndefined();
    expect(await taker.key(fold.inputs.endHeight, subjectKey(s), 0n)).toBeUndefined();
    await expect(taker.extend(blocks.slice(4))).rejects.toMatchObject({ code: "DISAGREEMENT" });
    await expect(taker.adopt(fold, [], verify)).rejects.toMatchObject({ code: "DISAGREEMENT" });
  });
});

describe("the shipped exhaustion set (slice 43)", () => {
  it("ships each circuit's key under the manifest's identity", () => {
    const keys = exhaustionKeys();
    expect(Object.keys(keys)).toEqual([...EXHAUSTION_CIRCUITS]);
    for (const name of EXHAUSTION_CIRCUITS) {
      expect(keys[name].vk.length).toBe(EXHAUSTION_KEY_BYTES);
      expect(Buffer.from(sha256(keys[name].vk)).toString("hex")).toBe(EXHAUSTION_SET_MANIFEST.circuits[name].vk);
      expect(fieldToHex(keys[name].keyHash)).toBe(EXHAUSTION_SET_MANIFEST.circuits[name].keyHash);
    }
    expect(EXHAUSTION_SET_MANIFEST.sizes).toEqual({ t: 167, m: 380, u: 746 });
  });

  it("names the set by its identities and start, as over built circuits, and starts no verifier before a fold", async () => {
    let started = 0;
    const shipped = shippedExhaustionSet(start, async () => { started++; throw new Error("no backend here"); });
    expect(shipped.test).toBe(true);
    expect(shipped.foldKeyHash).toBe(exhaustionKeys()["fold-next"].keyHash);
    expect(shipped.identity).toEqual(exhaustionSetIdentity(EXHAUSTION_SET_MANIFEST.circuits, start));
    expect(shipped.identity).not.toEqual(shippedExhaustionSet({ ...start, height: start.height + 1n }, async () => { throw new Error(); }).identity);
    expect(started).toBe(0);
    // A proof of another length is false without a verifier; a fold's verification starts one, which failed here.
    expect(await shipped.verifyFold(true, [], new Uint8Array(32))).toBe(false);
    await expect(shipped.verifyFold(true, new Array(8).fill(0n), new Uint8Array(458 * 32))).rejects.toThrow("no backend here");
    expect(started).toBe(1);
    await shipped.close();
    await expect(shipped.verifyFold(true, new Array(8).fill(0n), new Uint8Array(458 * 32))).rejects.toThrow("closed");
    expect(started).toBe(1);
    // Built circuits with the same identities make the same set (their programs' bytecode hashed as the manifest is).
    const keys = exhaustionKeys(), built = { sizes: EXHAUSTION_SET_MANIFEST.sizes, circuits: Object.fromEntries(EXHAUSTION_CIRCUITS.map(name =>
      [name, { program: { bytecode: "", abi: {} }, ...keys[name] }])) } as unknown as ExhaustionCircuits;
    const ids = circuitIdentities(built);
    expect(ids["fold-next"].keyHash).toBe(EXHAUSTION_SET_MANIFEST.circuits["fold-next"].keyHash);
    expect(exhaustionSetIdentity(ids, start)).not.toEqual(shipped.identity);
    expect(() => circuitExhaustionSet(built, { ...start, height: -1n }, null as never)).toThrow("invalid exhaustion start");
  });
});
