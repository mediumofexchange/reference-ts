// The runtime package entry (src/pool/v3/package-reader.ts readPackage) reads
// every multi-backing scope group of local-check to the harness's own verdict:
// refusal, receipt, state totals and roots, carrying classes, clocks,
// publication force and non-service counts. Selections whose own header
// scopes several backings take the scope reader directly in both paths.
import assert from "node:assert/strict";
import { EncodingError } from "../../../dist/bytes.js";
import { FixtureVenue } from "../../../dist/record-venue.js";
import { decodeSegmentHeader } from "../../../dist/pool/v3/headers.js";
import { readPackage } from "../../../dist/pool/v3/package-reader.js";
import { decodedTrails } from "../../../dist/pool/v3/reader.js";
import { EvidenceRefusal, ReplayRefusal } from "../../../dist/pool/v3/refusals.js";

const hex = bytes => Buffer.from(bytes).toString("hex");
const text = value => value === undefined ? null : value.toString();
const faults = result => result.faultEvidence === undefined ? {} : { faultEvidence: result.faultEvidence };

/** The harness report's verdict fields, without its own flags, seed scan or evidence hash. */
function expected(result) {
  if (result.status === "receipt-status") return { receipt: result.receipt, ...faults(result) };
  if (result.audit === null) return { status: result.status, check: result.check, ...(result.clock === undefined ? {} : { clock: result.clock }), ...faults(result) };
  const { evidenceHash: _evidence, ...audit } = result.audit;
  return { audit, ...faults(result) };
}

function observed(result) {
  if (result.receipt !== undefined) return { receipt: result.receipt, ...faults(result) };
  const { state, ranges } = result;
  return { audit: { records: state.position.toString(), issued: state.issued.toString(), burned: state.burned.toString(),
    outstanding: (state.issued - state.burned).toString(), noteRoot: state.tree.root().toString(), spentRoot: hex(state.spent.root()),
    historyHash: hex(state.history),
    range: { judgingIndex: ranges.judgingIndex.toString(), lag: ranges.lag.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
      revokedAt: text(ranges.revokedAt), heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter,
      chain: ranges.chain.map(link => ({ operator: hex(link.operator), from: link.from.toString(), link: hex(link.link) })),
      carrying: result.carrying, clock: result.clock, publications: ranges.publications,
      ...(ranges.nonService === undefined ? {} : { nonService: ranges.nonService }) } }, ...faults(result) };
}

export async function checkScopeRuntime({ pairs, portable, configuration, verifier, reference, codec, test }) {
  let compared = 0;
  await test("the runtime package reader reads every multi-backing scope group to the harness verdict", async () => {
    for (const { payload, result } of pairs) {
      const header = decodeSegmentHeader(decodedTrails([payload.package.trail])[0].header);
      if (header.entries.length < 2 || payload.seed !== undefined) continue;
      const { package: bytes, selection, venue } = portable(payload);
      let actual;
      try {
        actual = observed(await readPackage(bytes, selection, { configuration, verifier: { verify: verifier.verify }, venue: FixtureVenue.from(venue), reference }));
      } catch (error) {
        if (error instanceof ReplayRefusal) actual = { status: "invalid-local-replay", check: error.check };
        else if (error instanceof EvidenceRefusal) actual = { status: error.status, check: null, ...(error.clock === undefined ? {} : { clock: error.clock }) };
        else if (error instanceof codec.TrailLimitError || error instanceof codec.RangeLimitError) actual = { status: "resource-refusal", check: null };
        else if (error instanceof EncodingError) actual = { status: "unresolved-evidence", check: null };
        else throw error;
      }
      const wanted = expected(result);
      // A refusal's fault facts are read from the reader's observer after the throw; compare verdicts only.
      if (wanted.status !== undefined) delete wanted.faultEvidence;
      assert.deepEqual(actual, wanted);
      compared++;
    }
    assert.ok(compared > 0, "no multi-backing selection compared");
  });
  return { compared };
}
