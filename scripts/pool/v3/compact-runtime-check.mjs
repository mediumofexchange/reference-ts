// Public package/frontier acceptance over existing real-proof hostile fixtures.
import assert from "node:assert/strict";
import { readFrontier, readPackage } from "../../../dist/pool/v3/package-reader.js";
import { EvidenceRefusal, ReplayRefusal } from "../../../dist/pool/v3/refusals.js";
import { LIMITS } from "./evidence-reader.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");

/** Selections whose own header scopes several backings are compared by
 * scope-runtime-check.mjs. Both APIs receive canonical package bytes and
 * independently selected readers. */
export async function checkCompactRuntime({ payload, result, verifier, codec, portable, label }) {
  if (!payload.package.faults?.length) return false;
  const trail = codec.decodeTrail(payload.package.trail, LIMITS);
  if (codec.decodeSegmentHeader(trail.header).entries.length !== 1) return false;
  const bytes = portable(payload).package;
  const options = { configuration: verifier.configuration, verifier, reference: verifier.reference,
    venue: await verifier.record(payload.venue) };
  if (!["selected-local-replay", "historical-local-replay", "receipt-status"].includes(result.status)) {
    await assert.rejects(() => readPackage(bytes, payload.selection, options), error =>
      result.status === "invalid-local-replay" ? error instanceof ReplayRefusal && error.check === result.check :
        error instanceof EvidenceRefusal && error.status === result.status, label);
    // These fixture refusals concern the descent's missing dependencies or
    // unsupported compact target, not selection currency or its full envelope.
    // Frontier must refuse the same inside-block/cross-checkpoint cases even
    // though it has no caller-selected checkpoint.
    if (["unresolved-evidence", "resource-refusal"].includes(result.status)) {
      await assert.rejects(() => readFrontier(bytes, trail.terms[0], payload.selection.judgingIndex, options),
        error => error instanceof EvidenceRefusal && error.status === result.status, `${label}: frontier refusal`);
    }
    return true;
  }
  const selected = await readPackage(bytes, payload.selection, options);
  assert.deepEqual(selected.faultEvidence, result.faultEvidence, `${label}: exact observational facts`);
  if (result.status === "receipt-status") {
    assert.deepEqual(selected.receipt, result.receipt, `${label}: receipt`);
    return true;
  }
  const state = selected.state, audit = result.audit;
  assert.deepEqual({ records: String(state.position), issued: String(state.issued), burned: String(state.burned),
    noteRoot: String(state.noteRoot()), spentRoot: hex(state.spentRoot()), historyHash: hex(state.history) }, Object.fromEntries(
    ["records", "issued", "burned", "noteRoot", "spentRoot", "historyHash"].map(key => [key, audit[key]])), label);
  assert.deepEqual(selected.carrying, audit.range.carrying, `${label}: classification`);
  assert.deepEqual(selected.clock, audit.range.clock, `${label}: clock`);
  const frontier = await readFrontier(bytes, trail.terms[0], payload.selection.judgingIndex, options);
  assert.deepEqual(frontier.carrying, selected.carrying, `${label}: frontier classification`);
  assert.deepEqual(frontier.faultEvidence, selected.faultEvidence, `${label}: frontier facts`);
  assert.deepEqual(frontier.canonical.commitment, selected.canonical.commitment, `${label}: canonical checkpoint`);
  assert.deepEqual(frontier.canonical.state.history, state.history, `${label}: canonical history`);
  assert.deepEqual(frontier.canonical.state.spentRoot(), state.spentRoot(), `${label}: spent state`);
  return true;
}
