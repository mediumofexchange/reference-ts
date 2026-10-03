// The frontier reader (src/pool/v3/package-reader.ts readFrontier) over the
// single-backing compact fault, import and recovery groups: from the root terms
// alone it reaches the selected read's classification, facts and canonical
// state, and refuses where the selected read's descent does.
import assert from "node:assert/strict";
import { readFrontier } from "../../../dist/pool/v3/package-reader.js";
import { EvidenceRefusal } from "../../../dist/pool/v3/refusals.js";
import { LIMITS } from "./codec.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");

/** Selections whose own header scopes several backings are read by their scope groups. Both reads take
 * canonical package bytes and independently selected readers; `result` is the harness's selected read. */
export async function checkFrontier({ payload, result, verifier, codec, portable, label }) {
  if (!payload.package.faults?.length) return false;
  const trail = codec.decodeTrail(payload.package.trail, LIMITS);
  if (codec.decodeSegmentHeader(trail.header).entries.length !== 1) return false;
  const bytes = portable(payload).package;
  const options = { verifier: { verify: verifier.verify, identities: verifier.identities }, reference: verifier.reference,
    venue: await verifier.record(payload.venue) };
  const read = () => readFrontier(bytes, trail.terms[0], payload.selection.judgingIndex, options);
  if (!["selected-local-replay", "historical-local-replay", "receipt-status"].includes(result.status)) {
    // These fixture refusals concern the descent's missing dependencies or unsupported compact target, not
    // selection currency or its full envelope: the frontier, with no caller-selected checkpoint, refuses them too.
    if (["unresolved-evidence", "resource-refusal"].includes(result.status)) {
      await assert.rejects(read, error => error instanceof EvidenceRefusal && error.status === result.status, `${label}: frontier refusal`);
    }
    return true;
  }
  if (result.status === "receipt-status") return true;
  const frontier = await read();
  assert.deepEqual(frontier.carrying, result.audit.range.carrying, `${label}: frontier classification`);
  assert.deepEqual(frontier.faultEvidence, result.faultEvidence, `${label}: frontier facts`);
  const { commitment, state } = frontier.canonical;
  assert.deepEqual([hex(commitment.operator), commitment.sequence, hex(commitment.root)],
    [hex(payload.selection.operator), payload.selection.sequence, hex(payload.selection.root)], `${label}: canonical checkpoint`);
  assert.deepEqual([hex(state.history), hex(state.spentRoot())], [result.audit.historyHash, result.audit.spentRoot], `${label}: canonical state`);
  return true;
}
