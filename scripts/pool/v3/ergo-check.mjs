// Real-proof replay over the candidate Ergo profile. Headers are independently
// chosen synthetic fixtures; only raw transaction sections come from the supplier.
import assert from "node:assert/strict";
import { replayEvidencePackage, RANGE_LIMITS } from "./local-replay.mjs";

export async function checkErgoReplay({ imported, fixture, adapter, codec, verifier, portable, test }) {
  const { decodeTransaction } = await import("../../../experiments/ergo-range/decoder.mjs");
  const evidence = fixture.fixtureEvidence(imported.payload.venue), headers = evidence.headers;
  const payload = { ...imported.payload, selection: { ...imported.payload.selection,
    judgingIndex: imported.payload.selection.judgingIndex + 1n }, venue: { blocks: evidence.blocks } };
  const selected = (profile = fixture.profile, trustedHeaders = headers, rawLimits = adapter.RAW_EVIDENCE_LIMITS, rangeLimits = RANGE_LIMITS) => ({
    ...verifier, record: data => adapter.ergoReplayVenue(profile, { headers: trustedHeaders, blocks: data.blocks }, codec, rangeLimits, rawLimits),
  });
  const ergoVerifier = selected();
  const run = (input = payload, chosen = ergoVerifier) => replayEvidencePackage(portable(input), chosen, codec);
  const refusal = async (input, expected = "unresolved-evidence", chosen = ergoVerifier) => {
    const result = await run(input, chosen);
    assert.equal(result.status, expected); assert.equal(result.audit, null); assert.deepEqual(result.candidates, []);
    assert.equal(result.spendable, false); assert.equal(result.fullV3Replay, false);
    return result;
  };
  let result;
  await test("Ergo range adapter replays the real-proof import closure from exact transaction bytes and checked roots", async () => {
    result = await run();
    assert.equal(result.status, "selected-local-replay"); assert.equal(result.rangeEvidence, "candidate-ergo-profile-synthetic-headers");
    const { range: originalRange, ...originalAudit } = imported.result.audit;
    const { range, ...audit } = result.audit;
    assert.deepEqual(audit, originalAudit);
    assert.equal(range.judgingIndex, "21"); assert.equal(range.lag, "1");
    assert.equal(range.checkpointIndex, (BigInt(originalRange.checkpointIndex) + 1n).toString());
    assert.deepEqual(range.carrying.map(c => c.class), originalRange.carrying.map(c => c.class));
    for (const flag of ["fullV3Replay", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) assert.equal(result[flag], false);
    assert.equal(result.unresolvedCoverage, true);
  });
  const missing = structuredClone(payload); missing.venue.blocks.splice(2, 1);
  const tampered = structuredClone(payload); tampered.venue.blocks[2].transactions[0][1] ^= 1;
  assert.notEqual(decodeTransaction(tampered.venue.blocks[2].transactions[0]), undefined,
    "root-mismatch mutation must remain decodable");
  const undecodable = structuredClone(payload); undecodable.venue.blocks[2].transactions[0] = new Uint8Array([255]);
  await test("missing, tampered and undecodable Ergo sections refuse against unchanged trusted headers", async () => {
    for (const input of [missing, tampered, undecodable]) await refusal(input);
    const injected = { ...missing, venue: { ...missing.venue, profile: fixture.profile, headers,
      witnessedIndex: 21n, complete: true, rangeEvidence: "authenticated-chain" } };
    await refusal(injected);
  });
  await test("reader-selected Ergo profile and header chain cannot be replaced by package claims", async () => {
    const wrong = structuredClone(fixture.profile); wrong.genesis[0] ^= 1;
    await refusal(payload, "unresolved-evidence", selected(wrong));
    const wrongHeaders = structuredClone(headers); wrongHeaders[1].parentId[0] ^= 1;
    await refusal(payload, "unresolved-evidence", selected(fixture.profile, wrongHeaders));
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: 22n } });
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: 20n } });
    const historical = await run({ ...payload, selection: { ...payload.selection, judgingIndex: 20n, mode: "historical-fixture" } });
    assert.equal(historical.status, "historical-local-replay"); assert.equal(historical.currentRangeAuthenticated, false);
    assert.equal(historical.rangeEvidence, "candidate-ergo-profile-synthetic-headers");
  });
  await test("stray and root-failing duplicate blocks cannot erase a valid Ergo section", async () => {
    const extra = structuredClone(payload), stray = structuredClone(evidence.blocks[2]); stray.headerId[0] ^= 1;
    extra.venue.blocks.unshift(stray, tampered.venue.blocks[2]); extra.venue.blocks.push(evidence.blocks[2]);
    assert.deepEqual(await run(extra), result);
  });
  await test("Ergo evidence and answer limits refuse before proof replay without cloning the raw envelope", async () => {
    const noProof = { ...ergoVerifier, verify() { throw new Error("resource guard ran after proof replay"); } };
    const oversized = { ...payload, venue: { blocks: [{ headerId: headers[2].id,
      transactions: [new Uint8Array(Number(adapter.RAW_EVIDENCE_LIMITS.maxBytes) + 1)] }] } };
    const originalClone = globalThis.structuredClone;
    try {
      globalThis.structuredClone = value => {
        assert.equal(value?.venue, undefined, "raw venue evidence reached the generic ownership clone");
        return originalClone(value);
      };
      await refusal(oversized, "resource-refusal", noProof);
    } finally { globalThis.structuredClone = originalClone; }
    for (const limits of [{ ...adapter.RAW_EVIDENCE_LIMITS, maxBlocks: 1n },
      { ...adapter.RAW_EVIDENCE_LIMITS, maxTransactions: 1n }]) {
      await refusal(payload, "resource-refusal", { ...selected(fixture.profile, headers, limits), verify: noProof.verify });
    }
    await refusal(payload, "resource-refusal", { ...selected(fixture.profile, headers, adapter.RAW_EVIDENCE_LIMITS,
      { maxBytes: 102n, maxEntries: 0n }), verify: noProof.verify });
  });
  await test("Ergo adapter owns exact byte views before awaits and refuses shared storage", async () => {
    const owned = structuredClone(payload);
    const tx = owned.venue.blocks[2].transactions[0], large = new Uint8Array(2_097_152); large.set(tx, 17);
    owned.venue.blocks[2].transactions[0] = large.subarray(17, 17 + tx.length);
    let calls = 0;
    const mutate = { ...ergoVerifier, verify: (...args) => {
      if (calls++ === 0) { large.fill(0); owned.venue.blocks.length = 0; }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await run(owned, mutate), result);
    const shared = structuredClone(payload), original = shared.venue.blocks[2].transactions[0];
    shared.venue.blocks[2].transactions[0] = new Uint8Array(new SharedArrayBuffer(original.length));
    shared.venue.blocks[2].transactions[0].set(original);
    await refusal(shared);
  });
  return { payload, headers, verifier: ergoVerifier, result, missing, tampered,
    rawBytes: evidence.blocks.reduce((sum, block) => sum + block.transactions.reduce((n, tx) => n + tx.length, 0), 0) };
}
