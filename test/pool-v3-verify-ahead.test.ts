// Proof verification ahead of a trail's replay (storage decision M5b.6): what verifyAhead starts, when, how much it
// may drop, and where a failure reading the trail surfaces. The reader's verdicts ahead and in turn are compared
// through readFrontier in pool-v3-kept-state.test.ts.
import { describe, expect, it } from "vitest";
import { limbsOf } from "../src/pool/field.js";
import { decodeRecord, deliveryHash, encodeRecord } from "../src/pool/v3/records.js";
import type { Adopted, ProofCheck } from "../src/pool/v3/state.js";
import { verifyAhead } from "../src/pool/v3/verify-ahead.js";

const b = (n: number) => new Uint8Array(32).fill(n);
/** Issue records with distinct outputs; their proofs are opaque bytes the scripted verifier reads. */
const records = (count: number, proofOf: (i: number) => number = () => 7) => Array.from({ length: count }, (_, i) => {
  const capsules = [new Uint8Array(89).fill(1)], cm = BigInt(100 + i);
  return encodeRecord({ domain: b(1), kind: 1, publicInputs: [...limbsOf(b(1)), ...limbsOf(b(2)), 3n, ...limbsOf(b(4)), 5n, cm,
    ...limbsOf(deliveryHash(b(1), [cm], capsules))], proof: b(proofOf(i)), authorization: new Uint8Array(64), capsules });
});

/** A verifier off the caller's turn: each call settles on a later turn, refusing proof 99; it counts calls and the most unsettled. */
function scripted(parallel: number) {
  const verifier = { calls: 0, unsettled: 0, most: 0, parallel,
    verify(_kind: number, _inputs: bigint[], proof: Uint8Array): Promise<boolean> {
      verifier.calls++; verifier.unsettled++; verifier.most = Math.max(verifier.most, verifier.unsettled);
      return new Promise(done => setImmediate(() => { verifier.unsettled--; done(proof[0] !== 99); }));
    } };
  return verifier;
}
/** A replay's judgments as state.ts makes them: each record's proof asked for in order, stopping at a refused one or at `stop`. */
async function replay(verifier: ProofCheck, trail: Iterable<Uint8Array>, options: { block?: readonly Adopted[]; stop?: number; onRecord?: (i: number) => void } = {}) {
  const ahead = verifyAhead(verifier, trail, 0n, options.block ?? []);
  let judged = 0;
  for (const bytes of ahead.records) {
    options.onRecord?.(judged);
    if (judged === options.stop) return { judged, refused: true };
    const record = decodeRecord(bytes);
    if (options.block?.[judged] === undefined && await ahead.verifier.verify(record.kind, [...record.publicInputs], new Uint8Array(record.proof)) !== true) {
      return { judged, refused: true };
    }
    judged++;
  }
  return { judged, refused: false };
}

describe("pool-v3 proofs verified ahead of the replay (M5b.6)", () => {
  it("asks for the first proof in turn, then keeps up to two per instance started, each proof verified once", async () => {
    const verifier = scripted(2), before: number[] = [];
    expect(await replay(verifier, records(40), { onRecord: () => before.push(verifier.calls) })).toEqual({ judged: 40, refused: false });
    expect(verifier.calls).toBe(40);
    // Nothing is started before a proof has verified; then one more per verified proof, up to the window of four.
    expect(before.slice(0, 4)).toEqual([0, 2, 4, 6]);
    expect(verifier.most).toBe(4);
  });

  it("drops no more than it used: nothing for a replay refused before its first proof, at most as many as verified", async () => {
    for (const stop of [0, 1, 2, 5, 30]) {
      const verifier = scripted(8);
      await replay(verifier, records(40), { stop });
      expect(verifier.calls).toBeLessThanOrEqual(2 * stop);
      expect(verifier.calls).toBeGreaterThanOrEqual(stop);
    }
    // A refused proof ends the replay; what was started after it is at most what verified before it.
    const verifier = scripted(8);
    expect(await replay(verifier, records(40, i => (i === 6 ? 99 : 7)))).toEqual({ judged: 6, refused: true });
    expect(verifier.calls).toBeLessThanOrEqual(2 * 7);
  });

  it("never holds more than the window started ahead for one verifier, however many replays abandon theirs", async () => {
    const verifier = scripted(1), trail = records(40);
    for (let i = 0; i < 50; i++) await replay(verifier, trail, { stop: 10 });
    // The window of two, beside the proof a judgment asks for in turn.
    expect(verifier.most).toBe(3);
    await new Promise(done => setImmediate(done));
    expect(verifier.unsettled).toBe(0);
  });

  it("starts nothing for the adopted block or a record that does not decode", async () => {
    const trail = records(20), asked: bigint[] = [];
    const verifier: ProofCheck = { parallel: 4, verify: (_kind, inputs) => { asked.push(inputs[8]!); return Promise.resolve(true); } };
    const block = Array.from({ length: 20 }, (_, i) => (i >= 5 && i < 9 ? { bytes: trail[i]!, index: 1n } : undefined)) as Adopted[];
    expect(await replay(verifier, trail, { block })).toEqual({ judged: 20, refused: false });
    expect(asked).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(100 + i)).filter((_, i) => i < 5 || i >= 9));
    const broken = [...records(6), new Uint8Array([1, 2, 3]), ...records(3)];
    const seen: number[] = [];
    await expect(replay({ parallel: 4, verify: () => Promise.resolve(true) }, broken, { onRecord: i => seen.push(i) })).rejects.toThrow();
    expect(seen.at(-1)).toBe(6);
  });

  it("raises a failure reading the trail when its record is due, after every record before it", async () => {
    const failure = new Error("stored trail unreadable");
    const failing = (count: number) => (function* () { yield* records(count); throw failure; })();
    // The replay refuses at the second record: the failure reading the fourth is never seen, ahead or in turn.
    for (const verifier of [scripted(4), { verify: () => true }]) {
      expect(await replay(verifier, failing(3), { stop: 1 })).toEqual({ judged: 1, refused: true });
      const reached: number[] = [];
      await expect(replay(verifier, failing(3), { onRecord: i => reached.push(i) })).rejects.toBe(failure);
      expect(reached).toEqual([0, 1, 2]);
    }
  });
});
