// Real-proof replay over the candidate Ergo profile. Headers are independently
// chosen synthetic fixtures; only raw transaction sections come from the supplier.
// Every replay group the fixture verifier answered is answered again by the
// Ergo verifier from exact transaction bytes and checked roots (pool-v3 §13.2).
import assert from "node:assert/strict";
import { replayEvidencePackage, RANGE_LIMITS } from "./local-replay.mjs";
import { FixtureVenue } from "./fixture-venue.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
export const ERGO_EVIDENCE_KIND = "candidate-ergo-profile-synthetic-headers";

/** A fixture-verifier result as the Ergo verifier must report it. Each fixture
 * record is its own transaction in the fixture's insertion order, so a kind-4
 * ordinal is the fixture's ordinal as a transaction position (`<< 32`), and
 * the provenance names the candidate. Nothing else may differ. */
export function underErgo(value) {
  if (Array.isArray(value)) return value.map(underErgo);
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "ordinal" && typeof item === "string" ? (BigInt(item) << 32n).toString()
      : key === "rangeEvidence" && item === "fixture-verifier" ? ERGO_EVIDENCE_KIND : underErgo(item)]));
}

/** Every (payload, result) pair the builders returned, including receiver and
 * issuer restorations (`restored` reads the payload under the nearest enclosing
 * `issuerSeed`), as `{ label, payload, result }`. Only payloads carrying a
 * fixture venue export are replayable through a venue verifier. */
export function replayPairs(built, seeds) {
  const out = [], seen = new Set();
  const walk = (value, path, issuerSeed) => {
    if (value === null || typeof value !== "object" || value instanceof Uint8Array || value instanceof Map || value instanceof Set || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item, i) => walk(item, `${path}[${i}]`, issuerSeed)); return; }
    const issuer = value.issuerSeed ?? issuerSeed;
    for (const [p, r] of [["payload", "result"], ["payloadY", "resultY"], ["joinedPayload", "joinedResult"], ["adoptedPayload", "adoptedResult"],
      ["issuerPayload", "issuerRestored"], ["issuerPayloadY", "issuerRestoredY"]]) {
      if (value[p]?.venue === undefined || value[r] === undefined) continue;
      const seed = p.startsWith("issuer") ? issuer : undefined;
      out.push({ label: `${path}.${p}`, payload: seed === undefined ? value[p] : { ...value[p], seed }, result: value[r] });
    }
    if (value.payload?.venue !== undefined && value.payload.seed === undefined) {
      if (value.receiver !== undefined) out.push({ label: `${path}.receiver`, payload: { ...value.payload, seed: seeds.receiverSeed }, result: value.receiver });
      if (value.restored !== undefined && issuer !== undefined) out.push({ label: `${path}.restored`, payload: { ...value.payload, seed: issuer }, result: value.restored });
    }
    if (value.payloadY?.venue !== undefined && value.receiverY !== undefined) {
      out.push({ label: `${path}.receiverY`, payload: { ...value.payloadY, seed: seeds.receiverSeed }, result: value.receiverY });
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, issuer);
  };
  walk(built, "", undefined);
  return out;
}

export async function checkErgoReplay({ groups, primary, fixture, adapter, codec, verifier, portable, test }) {
  const { decodeTransaction } = await import("../../../experiments/ergo-range/contained-decoder.mjs");
  const { profile } = fixture, identity = codec.ergoProfileIdentity(profile);
  const selected = (chosen = profile, trustedHeaders, rawLimits = adapter.RAW_EVIDENCE_LIMITS, rangeLimits = RANGE_LIMITS) => ({
    ...verifier, record: data => adapter.ergoReplayVenue(chosen, { headers: trustedHeaders, blocks: data.blocks }, codec, rangeLimits, rawLimits),
  });
  /** The reader's conversion of a fixture export into raw sections under its own synthetic headers. */
  const convert = payload => {
    assert.equal(payload.venue.lag, 2n, "the harness fixtures declare lag 2, the profile's depth 1");
    const evidence = fixture.fixtureEvidence(payload.venue);
    return { input: { ...payload, venue: { blocks: evidence.blocks } }, headers: evidence.headers,
      rawBytes: evidence.blocks.reduce((sum, block) => sum + block.transactions.reduce((n, tx) => n + tx.length, 0), 0) };
  };
  const run = (input, headers, chosen = selected(profile, headers)) => replayEvidencePackage(portable(input), chosen, codec);
  const counts = { groups: 0, kind4Subjects: 0, unionPositions: 0, otherRanges: 0, rawBytes: 0, blocks: 0 };
  await test("every replay group agrees through the Ergo adapter from exact transaction bytes and checked roots", async () => {
    for (const { label, payload, result } of groups) {
      const { input, headers, rawBytes } = convert(payload);
      const witnessed = FixtureVenue.from(payload.venue), ergo = adapter.ergoReplayVenue(profile, { headers, blocks: input.venue.blocks }, codec, RANGE_LIMITS);
      assert.notEqual(ergo, undefined, label);
      assert.equal(ergo.witnessedIndex(), witnessed.witnessedIndex, label); assert.equal(ergo.lag(), witnessed.lag, label);
      // Each subject's kind-4 answer entry by entry, and their union in venue order (C2b.4.2): the Ergo
      // ordinal is the fixture's position in the section. Kinds 1-3 answer identically.
      const subjectsOf = kind => [...new Map(payload.venue.records.filter(r => r.kind === kind).map(r => [hex(r.subject), r.subject])).values()];
      const answers = [];
      for (const subject of subjectsOf(4)) {
        const request = { venue: identity, kind: 4, subject, fromIndex: 0n, toIndex: witnessed.witnessedIndex };
        const expected = codec.decodeRangeAnswer(witnessed.answer(request, codec, RANGE_LIMITS), request, RANGE_LIMITS);
        const actual = codec.decodeRangeAnswer(ergo.range(request), request, RANGE_LIMITS);
        assert.deepEqual(actual.entries.map(e => [e.index, e.ordinal, hex(e.record)]), expected.entries.map(e => [e.index, e.ordinal << 32n, hex(e.record)]), `${label}: kind 4`);
        answers.push([expected, actual]); counts.kind4Subjects++;
      }
      if (answers.length > 0) {
        const union = codec.mergeVenueOrder(answers.map(([expected]) => expected)), ergoUnion = codec.mergeVenueOrder(answers.map(([, actual]) => actual));
        assert.deepEqual(ergoUnion.map(e => [e.index, e.ordinal, hex(e.subject), hex(e.record)]), union.map(e => [e.index, e.ordinal << 32n, hex(e.subject), hex(e.record)]), `${label}: union`);
        counts.unionPositions += union.length;
      }
      for (const kind of [1, 2, 3]) for (const subject of subjectsOf(kind)) {
        const request = { venue: identity, kind, subject, fromIndex: 0n, toIndex: witnessed.witnessedIndex };
        assert.deepEqual(hex(ergo.range(request)), hex(witnessed.answer(request, codec, RANGE_LIMITS)), `${label}: kind ${kind}`);
        counts.otherRanges++;
      }
      assert.deepEqual(await run(input, headers), underErgo(result), label);
      counts.groups++; counts.rawBytes += rawBytes; counts.blocks += input.venue.blocks.length;
    }
  });
  // Refusals and substitutions on the primary group, the single-backing silence-bearing import.
  const { input: payload, headers } = convert(primary.payload), result = underErgo(primary.result), t = payload.selection.judgingIndex;
  const ergoVerifier = selected(profile, headers);
  const refusal = async (input, expected = "unresolved-evidence", chosen = ergoVerifier) => {
    const outcome = await run(input, headers, chosen);
    assert.equal(outcome.status, expected); assert.equal(outcome.audit, null); assert.deepEqual(outcome.candidates, []);
    assert.equal(outcome.spendable, false); assert.equal(outcome.fullV3Replay, false);
    return outcome;
  };
  await test("the Ergo replay names its provenance and closes no finality, completeness or spendability flag", async () => {
    // The adapter's own answer, not the harness's conversion of the fixture result.
    const actual = await run(payload, headers);
    assert.equal(actual.status, "selected-local-replay"); assert.equal(actual.rangeEvidence, ERGO_EVIDENCE_KIND);
    assert.equal(actual.audit.range.lag, "2"); assert.equal(actual.audit.range.judgingIndex, t.toString());
    for (const flag of ["fullV3Replay", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) assert.equal(actual[flag], false);
    assert.equal(actual.unresolvedCoverage, true);
    assert.deepEqual(actual, result);
  });
  const missing = structuredClone(payload); missing.venue.blocks.splice(3, 1);
  const tampered = structuredClone(payload); tampered.venue.blocks[3].transactions[0][1] ^= 1;
  assert.notEqual(decodeTransaction(tampered.venue.blocks[3].transactions[0]), undefined,
    "root-mismatch mutation must remain decodable");
  const undecodable = structuredClone(payload); undecodable.venue.blocks[3].transactions[0] = new Uint8Array([255]);
  await test("missing, tampered and undecodable Ergo sections refuse against unchanged trusted headers", async () => {
    for (const input of [missing, tampered, undecodable]) await refusal(input);
    const injected = { ...missing, venue: { ...missing.venue, profile, headers, witnessedIndex: t, complete: true, rangeEvidence: "authenticated-chain" } };
    await refusal(injected);
  });
  await test("reader-selected Ergo profile and header chain cannot be replaced by package claims", async () => {
    const wrong = structuredClone(profile); wrong.anchor[0] ^= 1;
    await refusal(payload, "unresolved-evidence", selected(wrong, headers));
    const wrongHeaders = structuredClone(headers); wrongHeaders[1].parentId[0] ^= 1;
    await refusal(payload, "unresolved-evidence", selected(profile, wrongHeaders));
    // Headers without the anchor's child give no verifier; a chain from the child alone answers.
    await refusal(payload, "unresolved-evidence", selected(profile, headers.slice(2)));
    assert.deepEqual(await run(payload, headers.slice(1)), result);
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: t + 1n } });
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: t - 1n } });
    const historical = await run({ ...payload, selection: { ...payload.selection, judgingIndex: t - 1n, mode: "historical-fixture" } }, headers);
    assert.equal(historical.status, "historical-local-replay"); assert.equal(historical.currentRangeAuthenticated, false);
    assert.equal(historical.rangeEvidence, ERGO_EVIDENCE_KIND);
  });
  await test("stray and root-failing duplicate blocks cannot erase a valid Ergo section", async () => {
    const extra = structuredClone(payload), stray = structuredClone(payload.venue.blocks[3]); stray.headerId[0] ^= 1;
    extra.venue.blocks.unshift(stray, tampered.venue.blocks[3]); extra.venue.blocks.push(payload.venue.blocks[3]);
    assert.deepEqual(await run(extra, headers), result);
  });
  await test("Ergo evidence and answer limits refuse before proof replay without cloning the raw envelope", async () => {
    const noProof = { ...ergoVerifier, verify() { throw new Error("resource guard ran after proof replay"); } };
    const oversized = { ...payload, venue: { blocks: [{ headerId: headers[3].id,
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
      await refusal(payload, "resource-refusal", { ...selected(profile, headers, limits), verify: noProof.verify });
    }
    await refusal(payload, "resource-refusal", { ...selected(profile, headers, adapter.RAW_EVIDENCE_LIMITS,
      { maxBytes: 102n, maxEntries: 0n }), verify: noProof.verify });
  });
  await test("Ergo adapter owns exact byte views before awaits and refuses shared storage", async () => {
    const owned = structuredClone(payload);
    const tx = owned.venue.blocks[3].transactions[0], large = new Uint8Array(2_097_152); large.set(tx, 17);
    owned.venue.blocks[3].transactions[0] = large.subarray(17, 17 + tx.length);
    let calls = 0;
    const mutate = { ...ergoVerifier, verify: (...args) => {
      if (calls++ === 0) { large.fill(0); owned.venue.blocks.length = 0; }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await run(owned, headers, mutate), result);
    const shared = structuredClone(payload), original = shared.venue.blocks[3].transactions[0];
    shared.venue.blocks[3].transactions[0] = new Uint8Array(new SharedArrayBuffer(original.length));
    shared.venue.blocks[3].transactions[0].set(original);
    await refusal(shared);
  });
  return { counts, convert, primary: { input: payload, headers, result }, missing, tampered };
}
