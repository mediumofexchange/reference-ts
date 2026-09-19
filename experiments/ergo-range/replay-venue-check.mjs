// Fast hostile ownership regressions, before the proof harness starts.
import assert from "node:assert/strict";
import { ergoReplayVenue, RAW_EVIDENCE_LIMITS } from "./replay-venue.mjs";
import { fixtureEvidence, profile } from "./replay-fixture.mjs";

export function checkErgoOwnership(codec) {
  const bounds = { maxBytes: 1_048_576n, maxEntries: 4096n };
  const fixture = () => fixtureEvidence({ witnessedIndex: 1n, records: [] });
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
  for (const operation of ["grow", "detach"]) {
    const evidence = fixture(), bytes = evidence.blocks[0].transactions[0];
    const buffer = new ArrayBuffer(bytes.length, { maxByteLength: 10_000 });
    const view = new Uint8Array(buffer); view.set(bytes);
    evidence.blocks[0].transactions[0] = view;
    const later = evidence.blocks[1].transactions[0];
    Object.defineProperty(evidence.blocks[1].transactions, 0, { get() {
      if (operation === "grow") { buffer.resize(10_000); view.fill(0); }
      else structuredClone(buffer, { transfer: [buffer] });
      return later;
    } });
    // Total raw bytes fit 1,000 before the hostile getter. It cannot increase
    // copied bytes or change the earlier transaction/root after ownership.
    const record = ergoReplayVenue(profile, evidence, codec, bounds, { ...RAW_EVIDENCE_LIMITS, maxBytes: 1000n });
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
