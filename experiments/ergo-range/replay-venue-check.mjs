// Fast hostile ownership regressions, before the proof harness starts.
import assert from "node:assert/strict";
import { ergoReplayVenue, RAW_EVIDENCE_LIMITS } from "./replay-venue.mjs";
import { fixtureEvidence, profile } from "./replay-fixture.mjs";

export function checkErgoOwnership(codec) {
  const bounds = { maxBytes: 1_048_576n, maxEntries: 4096n };
  // Heights 1..5 under the harness profile (depth 1): the genesis anchor, then indices 0..2 witnessed.
  const fixture = () => fixtureEvidence({ witnessedIndex: 2n, lag: 2n, records: [] });
  const request = { venue: codec.ergoProfileIdentity(profile), kind: 2, subject: new Uint8Array(32), fromIndex: 0n, toIndex: 2n };
  const refusal = error => error?.status === "unresolved-evidence";
  const oversized = fixture(), large = new Uint8Array(2000);
  Object.defineProperty(large, "length", { value: 0 });
  oversized.blocks[0].transactions[0] = large;
  assert.throws(() => ergoReplayVenue(profile, oversized, codec, bounds, { ...RAW_EVIDENCE_LIMITS, maxBytes: 1000n }), codec.RangeLimitError);
  const hidden = fixture(), shared = new Uint8Array(new SharedArrayBuffer(100));
  Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(0) });
  hidden.blocks[0].transactions[0] = shared;
  assert.throws(() => ergoReplayVenue(profile, hidden, codec, bounds), refusal);
  // Exactly what the adapter charges: the anchor and scripts, 96 bytes per header, 32 per block id and every transaction.
  const charged = evidence => 32 + Object.values(profile.scripts).reduce((n, s) => n + s.length, 0) + 96 * evidence.headers.length
    + evidence.blocks.reduce((n, block) => n + 32 + block.transactions.reduce((m, tx) => m + tx.length, 0), 0);
  const total = BigInt(charged(fixture()));
  for (const operation of ["grow", "detach"]) {
    // The index-0 section (height 2) is the resizable view; a getter on the next block mutates it after ownership.
    const evidence = fixture(), bytes = evidence.blocks[1].transactions[0];
    const buffer = new ArrayBuffer(bytes.length, { maxByteLength: 10_000 });
    const view = new Uint8Array(buffer); view.set(bytes);
    evidence.blocks[1].transactions[0] = view;
    const later = evidence.blocks[2].transactions[0];
    Object.defineProperty(evidence.blocks[2].transactions, 0, { get() {
      if (operation === "grow") { buffer.resize(10_000); view.fill(0); }
      else structuredClone(buffer, { transfer: [buffer] });
      return later;
    } });
    // Total raw bytes fit the budget exactly before the hostile getter. It cannot increase
    // copied bytes or change the earlier transaction/root after ownership.
    const record = ergoReplayVenue(profile, evidence, codec, bounds, { ...RAW_EVIDENCE_LIMITS, maxBytes: total });
    assert.equal(record.range(request).length, 102);
  }
  for (const outOfBounds of [false, true]) {
    const evidence = fixture(), buffer = new ArrayBuffer(10, { maxByteLength: 20 }), view = new Uint8Array(buffer, 5, 5);
    if (outOfBounds) buffer.resize(1);
    else structuredClone(buffer, { transfer: [buffer] });
    evidence.blocks[0].transactions[0] = view;
    assert.throws(() => ergoReplayVenue(profile, evidence, codec, bounds), refusal);
  }
}
