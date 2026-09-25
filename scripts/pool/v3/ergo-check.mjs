// Real-proof replay through the runtime's ErgoVenue over the synthetic
// reference chain (src/ergo-synthetic.ts). The reader chooses the profile, the
// anchor's context and the chain it reads: at difficulty 1 anyone can mine a
// heavier branch, so the reader pins the id of the block its clock must stand
// on, as it held the headers themselves before (a trust input beside the keys,
// never read from the package). The package's venue data is a chain of blocks
// that ErgoVenue verifies itself, header by header under the mainnet rules at
// difficulty 1 and section by section against each header's root, before
// answering pool-v3 §13 (§13.2). Every replay group the fixture venue answered
// is answered again by the Ergo venue from exact unsigned transaction bytes.
import assert from "node:assert/strict";
import { ErgoVenue } from "../../../dist/ergo.js";
import { ergoProfileIdentity, frameTransaction } from "../../../dist/ergo-profile.js";
import { BranchSupplier, Chain, plainOutput, recordOutput, transaction } from "../../../dist/ergo-synthetic.js";
import { FixtureVenue } from "../../../dist/record-venue.js";
import { mergeVenueOrder } from "../../../dist/record-range.js";
import { recordReader, replayEvidencePackage, RANGE_LIMITS } from "./local-replay.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
export const ERGO_EVIDENCE_KIND = "ergo-venue-synthetic-chain";
/** The reader's chain: the synthetic anchor and its context, the same in every process. */
export const ERGO_CHAIN = new Chain();
/** The harness fixtures declare lag 2, so the reader selects depth 1. */
export const ERGO_PROFILE = ERGO_CHAIN.profile(1n);
export const ERGO_VENUE = ergoProfileIdentity(ERGO_PROFILE);
// A kind-4 record is split into outputs of at most this many bytes, as a box's register limit requires on the chain.
const PIECE = 3981;

/** The reader's record factory over an Ergo package: a fresh ErgoVenue on its
 * own anchor context, synced from a supplier serving the package's blocks, is
 * the record only where its clock stands on the reader's pinned block. */
export async function ergoRecord(data, { pin, profile = ERGO_PROFILE, context = ERGO_CHAIN.context, policy }) {
  assert.ok(pin instanceof Uint8Array && pin.length === 32, "the reader pins the block its clock stands on");
  const venue = new ErgoVenue(profile, context, policy);
  const suppliers = (data?.tips ?? [data?.tip]).filter(tip => tip !== undefined).map((tip, i) => new BranchSupplier(`package-${i}`, tip, ERGO_CHAIN));
  const { witnessedHeaderId } = await venue.sync(suppliers);
  if (witnessedHeaderId === undefined || hex(witnessedHeaderId) !== hex(pin)) return undefined;
  return recordReader(venue, ERGO_EVIDENCE_KIND);
}

/** A fixture-venue result as the Ergo venue must report it. Each fixture
 * record is its own transaction in the fixture's insertion order, so a kind-4
 * ordinal is the fixture's ordinal as a transaction position (`<< 32`), and
 * the provenance names the Ergo venue. Nothing else may differ. */
export function underErgo(value) {
  if (Array.isArray(value)) return value.map(underErgo);
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "ordinal" && typeof item === "string" ? (BigInt(item) << 32n).toString()
      : key === "rangeEvidence" && item === "fixture-verifier" ? ERGO_EVIDENCE_KIND : underErgo(item)]));
}

/** The fixture export's records as blocks of the synthetic chain under the
 * same indices: index `i` is the block `i + 1` above the anchor, so records
 * carrying absolute indices (replacement effect, demand deadlines) keep their
 * meaning. The fixture's lag `l` is the profile's depth `l - 1`: the chain runs
 * `l - 1` blocks past the fixture's witnessed index, so the venue's witnessed
 * index is the fixture's. Each record is a separate transaction in the
 * fixture's insertion order, preserving within-index order across every kind
 * and subject and keeping adjacent publication runs apart. */
export function fixtureChain(fixture) {
  const { witnessedIndex, lag, records } = fixture;
  assert.equal(lag, 2n, "the harness fixtures declare lag 2, the profile's depth 1");
  const at = new Map();
  for (const record of records) {
    assert.ok(record.index <= witnessedIndex, "a fixture record is witnessed");
    const list = at.get(record.index) ?? [];
    const outputs = record.kind !== 4 || record.record.length === 0 ? [recordOutput(record.kind, record.subject, record.record)] : [];
    if (record.kind === 4) {
      for (let offset = 0; offset < record.record.length; offset += PIECE) {
        outputs.push(recordOutput(4, record.subject, record.record.subarray(offset, offset + PIECE)));
      }
    }
    list.push(transaction(outputs, 1n, `moe/test/ergo-replay/${record.index}/${list.length}`));
    at.set(record.index, list);
  }
  const blocks = ERGO_CHAIN.extend(ERGO_CHAIN.anchor, Number(witnessedIndex + lag),
    i => at.get(BigInt(i)) ?? [transaction([plainOutput], 1n, `moe/test/ergo-replay/${i}/plain`)]);
  return blocks;
}

/** Every (payload, result) pair the builders returned, including receiver and
 * issuer restorations (`restored` reads the payload under the nearest enclosing
 * `issuerSeed`), as `{ label, payload, result }`. Only payloads carrying a
 * fixture venue export are replayable through a venue. */
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

/** A copy of `blocks` on the same anchor whose block `n` serves `sectionOf(section, n)` under its unchanged header. */
function reserved(blocks, sectionOf) {
  const out = [];
  let parent = blocks[0].parent;
  for (const [n, block] of blocks.entries()) {
    const next = { ...block, parent, section: sectionOf(block.section, n) };
    out.push(next); parent = next;
  }
  return out;
}
const withSection = (blocks, i, section) => reserved(blocks, (own, n) => (n === i ? section : own));

export async function checkErgoReplay({ groups, primary, codec, verifier, portable, test }) {
  const selected = options => ({ ...verifier, record: data => ergoRecord(data, options) });
  /** The package's venue data, the chain's tip whose ancestry carries every block, and the reader's
   * pin: the block at the fixture's witnessed index. */
  const convert = payload => {
    const blocks = fixtureChain(payload.venue);
    return { input: { ...payload, venue: { tip: blocks.at(-1) } }, blocks, pin: blocks[Number(payload.venue.witnessedIndex)].id,
      rawBytes: blocks.reduce((sum, block) => sum + block.bytes.length + block.section.reduce((n, tx) => n + tx.unsigned.length + tx.witnessId.length, 0), 0) };
  };
  const run = (input, chosen) => replayEvidencePackage(portable(input), chosen, codec);
  const counts = { groups: 0, kind4Subjects: 0, unionPositions: 0, otherRanges: 0, rawBytes: 0, blocks: 0 };
  await test("every replay group agrees through ErgoVenue from verified headers, exact unsigned bytes and checked roots", async () => {
    for (const { label, payload, result } of groups) {
      const { input, blocks, pin, rawBytes } = convert(payload);
      const witnessed = FixtureVenue.from(payload.venue), ergo = await ergoRecord(input.venue, { pin });
      assert.equal(ergo.witnessedIndex(), witnessed.witnessedIndex(), label); assert.equal(ergo.lag(), witnessed.lag(), label);
      // Each subject's kind-4 answer entry by entry, and their union in venue order (C2b.4.2): the Ergo
      // ordinal is the fixture's position in the section. Kinds 1-3 answer identically.
      const subjectsOf = kind => [...new Map(payload.venue.records.filter(r => r.kind === kind).map(r => [hex(r.subject), r.subject])).values()];
      const answers = [];
      for (const subject of subjectsOf(4)) {
        const request = { venue: ERGO_VENUE, kind: 4, subject, fromIndex: 0n, toIndex: witnessed.witnessedIndex() };
        const expected = codec.decodeRangeAnswer(witnessed.range(request, RANGE_LIMITS), request, RANGE_LIMITS);
        const actual = codec.decodeRangeAnswer(ergo.range(request), request, RANGE_LIMITS);
        assert.deepEqual(actual.entries.map(e => [e.index, e.ordinal, hex(e.record)]), expected.entries.map(e => [e.index, e.ordinal << 32n, hex(e.record)]), `${label}: kind 4`);
        answers.push([expected, actual]); counts.kind4Subjects++;
      }
      if (answers.length > 0) {
        const union = mergeVenueOrder(answers.map(([expected]) => expected)), ergoUnion = mergeVenueOrder(answers.map(([, actual]) => actual));
        assert.deepEqual(ergoUnion.map(e => [e.index, e.ordinal, hex(e.subject), hex(e.record)]), union.map(e => [e.index, e.ordinal << 32n, hex(e.subject), hex(e.record)]), `${label}: union`);
        counts.unionPositions += union.length;
      }
      for (const kind of [1, 2, 3]) for (const subject of subjectsOf(kind)) {
        const request = { venue: ERGO_VENUE, kind, subject, fromIndex: 0n, toIndex: witnessed.witnessedIndex() };
        assert.deepEqual(hex(ergo.range(request)), hex(witnessed.range(request, RANGE_LIMITS)), `${label}: kind ${kind}`);
        counts.otherRanges++;
      }
      assert.deepEqual(await run(input, selected({ pin })), underErgo(result), label);
      counts.groups++; counts.rawBytes += rawBytes; counts.blocks += blocks.length;
    }
  });
  // Refusals and substitutions on the primary group, the single-backing silence-bearing import.
  const { input: payload, blocks, pin } = convert(primary.payload), result = underErgo(primary.result), t = payload.selection.judgingIndex;
  const ergoVerifier = selected({ pin });
  const refusal = async (input, expected = "unresolved-evidence", chosen = ergoVerifier) => {
    const outcome = await run(input, chosen);
    assert.equal(outcome.status, expected); assert.equal(outcome.audit, null); assert.deepEqual(outcome.candidates, []);
    assert.equal(outcome.spendable, false); assert.equal(outcome.fullV3Replay, false);
    return outcome;
  };
  await test("the Ergo replay names its provenance and closes no finality, completeness or spendability flag", async () => {
    // The venue's own answers, not the harness's conversion of the fixture result.
    const actual = await run(payload, ergoVerifier);
    assert.equal(actual.status, "selected-local-replay"); assert.equal(actual.rangeEvidence, ERGO_EVIDENCE_KIND);
    assert.equal(actual.audit.range.lag, "2"); assert.equal(actual.audit.range.judgingIndex, t.toString());
    for (const flag of ["fullV3Replay", "completenessClaim", "noMatchesMeansZeroBalance", "spendable"]) assert.equal(actual[flag], false);
    assert.equal(actual.unresolvedCoverage, true);
    assert.deepEqual(actual, result);
  });
  // Index 2's section: withheld (an empty section cannot reproduce the root), one flipped byte of the first input's
  // box id (still framable), or bytes outside the framer's grammar. The clock stops before it.
  const section = blocks[2].section, flipped = new Uint8Array(section[0].unsigned); flipped[1] ^= 1;
  const missing = { ...payload, venue: { tip: withSection(blocks, 2, []).at(-1) } };
  const tampered = { ...payload, venue: { tip: withSection(blocks, 2, [{ ...section[0], unsigned: flipped }, ...section.slice(1)]).at(-1) } };
  const malformed = { ...payload, venue: { tip: withSection(blocks, 2, [{ ...section[0], unsigned: new Uint8Array([255]) }]).at(-1) } };
  assert.notEqual(frameTransaction(flipped), undefined, "root-mismatch mutation must remain framable");
  await test("missing, tampered and malformed Ergo sections stop the clock before them and refuse", async () => {
    for (const input of [missing, tampered, malformed]) await refusal(input);
    const injected = { ...missing, venue: { ...missing.venue, profile: ERGO_PROFILE, witnessedIndex: t, complete: true, rangeEvidence: "authenticated-chain" } };
    await refusal(injected);
    // Another supplier's honest section is read beside the tampered one, whichever is asked first.
    assert.deepEqual(await run({ ...payload, venue: { tips: [tampered.venue.tip, payload.venue.tip] } }, ergoVerifier), result);
  });
  await test("the reader's anchor, header rules and clock cannot be replaced by package claims", async () => {
    // A chain of valid blocks that does not descend from the reader's anchor adds no header.
    const elsewhere = { ...ERGO_CHAIN.anchor, id: new Uint8Array(32).fill(9) };
    const foreign = ERGO_CHAIN.extend(elsewhere, blocks.length, i => blocks[i].section);
    await refusal({ ...payload, venue: { tip: foreign.at(-1) } });
    // A heavier branch re-mined from the anchor at difficulty 1, index 2's records dropped, is the chain an unpinned
    // reader would follow; the pinned reader refuses it, alone or beside the pinned chain.
    const remined = ERGO_CHAIN.extend(ERGO_CHAIN.anchor, blocks.length + 1,
      i => (i === 2 ? [transaction([plainOutput], 1n, "moe/test/ergo-replay/remined")] : blocks[i]?.section ?? []), 1);
    const unpinned = new ErgoVenue(ERGO_PROFILE, ERGO_CHAIN.context);
    const report = await unpinned.sync([new BranchSupplier("pinned", payload.venue.tip, ERGO_CHAIN), new BranchSupplier("remined", remined.at(-1), ERGO_CHAIN)]);
    assert.equal(hex(report.witnessedHeaderId), hex(remined[Number(t) + 1].id), "the re-mined branch is the heavier one");
    await refusal({ ...payload, venue: { tip: remined.at(-1) } });
    await refusal({ ...payload, venue: { tips: [payload.venue.tip, remined.at(-1)] } });
    // A profile at another depth names another venue, so the package's identity has no answer.
    await refusal(payload, "unresolved-evidence", selected({ pin, profile: ERGO_CHAIN.profile(2n) }));
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: t + 1n } });
    await refusal({ ...payload, selection: { ...payload.selection, judgingIndex: t - 1n } });
    const historical = await run({ ...payload, selection: { ...payload.selection, judgingIndex: t - 1n, mode: "historical-fixture" } }, ergoVerifier);
    assert.equal(historical.status, "historical-local-replay"); assert.equal(historical.currentRangeAuthenticated, false);
    assert.equal(historical.rangeEvidence, ERGO_EVIDENCE_KIND);
  });
  await test("Ergo evidence and answer limits refuse before proof replay without cloning the package's chain", async () => {
    const noProof = chosen => ({ ...chosen, verify() { throw new Error("resource guard ran after proof replay"); } });
    const originalClone = globalThis.structuredClone;
    try {
      globalThis.structuredClone = value => {
        assert.equal(value?.venue, undefined, "raw venue evidence reached the generic ownership clone");
        return originalClone(value);
      };
      // A retained-bytes budget below the records stops the clock: unresolved, before any proof.
      await refusal(payload, "unresolved-evidence", noProof(selected({ pin, policy: { retainedBytes: 64 } })));
    } finally { globalThis.structuredClone = originalClone; }
    // An answer over the reader's budget is a resource refusal.
    const tight = { ...verifier, record: async data => {
      const record = await ergoRecord(data, { pin });
      return { ...record, range: request => record.range(request, { maxBytes: 102n, maxEntries: 0n }) };
    } };
    await refusal(payload, "resource-refusal", noProof(tight));
  });
  await test("the venue's own copies answer: blocks mutated during replay change no verdict", async () => {
    // Every section copied, so the mutation reaches no other test's chain.
    const copies = reserved(blocks, own => own.map(tx => ({ unsigned: new Uint8Array(tx.unsigned), witnessId: new Uint8Array(tx.witnessId) })));
    const owned = { ...payload, venue: { tip: copies.at(-1) } };
    let calls = 0;
    const mutate = { ...ergoVerifier, verify: (...args) => {
      if (calls++ === 0) for (const block of copies) for (const tx of block.section) { tx.unsigned.fill(0); tx.witnessId.fill(0); }
      return verifier.verify(...args);
    } };
    assert.deepEqual(await run(owned, mutate), result);
  });
  return { counts, convert, primary: { input: payload, pin, result }, missing, tampered };
}
