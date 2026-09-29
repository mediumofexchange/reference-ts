import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compareBytes, EncodingError } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR,
  signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { decodeSnapshot, genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationBytes, configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { decodeFaultEvidence, encodeFaultEvidence } from "../src/pool/v3/fault-evidence.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import type { CanonicalCheckpoint } from "../src/pool/v3/scope-reader.js";
import { readFrontier, readPackage } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentState } from "../src/pool/v3/state.js";
import { describeState } from "./pool-v3-state-description.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail } from "../src/pool/v3/trail.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), originalSecret = b(4), nextSecret = b(5), ruleSecret = b(6);
const issuer = ed25519.getPublicKey(issuerSecret), original = ed25519.getPublicKey(originalSecret), next = ed25519.getPublicKey(nextSecret);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), label = b(2), lag = 2n;
const reference = { context: LOCAL_REFERENCE, label, lag } as const, verifier = { verify: () => true };
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
interface Segment { header: SegmentHeader; id: Uint8Array; state: SegmentState; records: Uint8Array[]; secret: Uint8Array; evidence?: Uint8Array }

function fixture() {
  const venue = FixtureVenue.reference(label, lag, 10n), operatorStore = new ReplayStore();
  const fields = { configuration: domain, venue: venue.id, obligor: issuer, operator: original, interval: 10n,
    payout: { thing: "frontier test", quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(ruleSecret) };
  const terms = encodeRootTerms(fields), backing = rootTermsName(terms);
  const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
  const items: EvidenceItem[] = [], options = { configuration, verifier, reference, venue };
  const add = (kind: number, payload: Uint8Array) => {
    if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
  };
  function segment(secret = originalSecret, link = backing, sequence = 1n, predecessor?: Commitment, imported?: SegmentState): Segment {
    const header: SegmentHeader = { domain, venue: venue.id, operator: ed25519.getPublicKey(secret), sequence,
      entries: [{ backing, link, ...(predecessor === undefined ? {} : { opening: predecessor }) }] };
    const id = segmentIdentity(header);
    return { header, id, state: openSegmentState(operatorStore, id, b(90), imported), records: [], secret };
  }
  function checkpoint(target: Segment, sequence: bigint, index = sequence): Commitment {
    const total = target.state.total(hex(backing));
    const snapshot = { backing, segment: target.id, historyHash: target.state.history, evidenceHash: target.evidence ?? target.state.evidence, ...total };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }];
    const commitment = signCommitment(target.secret, sequence, directoryRoot(directory));
    add(3, encodeEvidenceDirectory(directory)); add(4, snapshotBytes(snapshot));
    add(6, encodeTrail({ header: segmentBytes(target.header), terms: [signed], records: target.records }));
    venue.witness(1, target.header.operator, index, encodeCommitment(commitment));
    return commitment;
  }
  function issued(target: Segment, output = 101n, signer = issuerSecret): Uint8Array {
    const scope = new ScopeTree(target.header.entries).root(), capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(target.id), scope, ...limbsOf(backing),
      5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
    return encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), signer) });
  }
  async function issue(target: Segment, output = 101n) {
    const bytes = issued(target, output), scope = new ScopeTree(target.header.entries).root();
    await applyRecord(target.state, bytes, { domain, backing, segment: target.id, scope, terms: fields, verifier, index: 2n, block: [] });
    target.records.push(bytes);
  }
  function replace() {
    const fields = { role: ROLE_OPERATOR, successor: next, predecessor: backing, effective: 8n,
      signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
    const message = replacementMessage(backing, fields);
    const replacement = { ...fields, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, nextSecret) };
    venue.witness(2, backing, 3n, encodeReplacement(backing, replacement));
    return replacementHash(backing, replacement);
  }
  const selection = (commitment: Commitment) => ({ mode: "current-fixture" as const, domain, venue: venue.id, backing,
    operator: commitment.operator, sequence: commitment.sequence, root: commitment.root, judgingIndex: venue.witnessedIndex() });
  const selectedPackage = (commitment: Commitment) => pack([...items,
    { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(commitment) }]);
  const read = (evidence = pack(items)) => readFrontier(evidence, signed, venue.witnessedIndex(), options);
  return { venue, fields, signed, backing, items, options, segment, checkpoint, issued, issue, replace, selection, selectedPackage, read };
}

// Oracle proofs isolate the reader's evidence contract. The invalid checkpoint
// otherwise extends its valid prefix, including an authenticated suffix record.
async function compactFixture(failure: "PROOF" | "SIGNATURE" = "PROOF", validTail = false) {
  const f = fixture(), segment = f.segment(), opening = f.checkpoint(segment, 1n);
  await f.issue(segment); const predecessor = f.checkpoint(segment, 2n);
  const tail = f.segment(originalSecret, f.backing, 4n, predecessor, segment.state);
  await f.issue(segment, 102n); await f.issue(segment, 103n);
  const records = segment.records.map(decodeRecord), target = records[1]!;
  records[1] = failure === "PROOF" ? { ...target, proof: b(99) } : { ...target, authorization: new Uint8Array(64) };
  segment.records = records.map(encodeRecord);
  segment.evidence = records.reduce((previous, record, i) => nextEvidenceHash(previous, evidenceHashes(record), BigInt(i + 1)),
    genesisEvidenceHash(segment.id));
  const hostile = f.checkpoint(segment, 3n), fullTrail = encodeTrail({ header: segmentBytes(segment.header), terms: [f.signed],
    records: segment.records });
  const snapshot = f.items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload))
    .find(value => compareBytes(value.evidenceHash, segment.evidence!) === 0)!;
  const fault = encodeFaultEvidence({ snapshot, position: 2n, length: 3n,
    previous: nextEvidenceHash(genesisEvidenceHash(segment.id), evidenceHashes(records[0]!), 1n),
    statement: statementBytes(records[1]!), proof: records[1]!.proof, authorization: records[1]!.authorization,
    suffix: [evidenceHashes(records[2]!)] }, 1024n);
  const selected = validTail ? f.checkpoint(tail, 4n) : predecessor;
  const compactItems = f.items.filter(item => item.kind !== 6 || compareBytes(item.payload, fullTrail) !== 0);
  const proofVerifier: ProofCheck = { verify: (_kind, _inputs, proof) => compareBytes(proof, b(99)) !== 0 };
  const options = { ...f.options, verifier: proofVerifier };
  const readCompact = (items = compactItems, faults = [fault], custom = proofVerifier) =>
    readFrontier(pack([...items, ...faults.map(payload => ({ kind: 7, payload }))]), f.signed, 10n, { ...options, verifier: custom });
  const readSelected = (items = compactItems, faults = [fault], commitment = selected) =>
    readPackage(pack([...items, ...faults.map(payload => ({ kind: 7, payload })),
      { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(commitment) }]),
    f.selection(commitment), options);
  return { f, opening, predecessor, hostile, selected, fault, compactItems, readCompact, readSelected };
}

// Each read keeps its state in its own store under its own verifier. Compare
// what the replayed state holds.
function canonicalEvidence(canonical: CanonicalCheckpoint | undefined) {
  if (canonical === undefined) return undefined;
  return { ...canonical, state: describeState(canonical.state) };
}

describe("single-backing complete frontier reader", () => {
  it("rolls an excluded checkpoint's writes back and drops a scratch replay, continuing in one namespace", async () => {
    const f = fixture(), segment = f.segment(); f.checkpoint(segment, 1n);
    await f.issue(segment, 101n); f.checkpoint(segment, 2n);
    const chain = (records: readonly Uint8Array[]): Uint8Array => records.reduce((previous, bytes, i) =>
      nextEvidenceHash(previous, evidenceHashes(decodeRecord(bytes)), BigInt(i + 1)), genesisEvidenceHash(segment.id));
    // Checkpoint 3 appends a valid issue, then one with a foreign signature: excluded, its valid record undone.
    const hostile = [...segment.records, f.issued(segment, 102n), f.issued(segment, 103n, b(9))];
    f.checkpoint({ ...segment, records: hostile, evidence: chain(hostile) }, 3n);
    // Checkpoint 4 rewrites the first record: its prefix does not reproduce, so it replays from the seed in a
    // scratch namespace, which fails CONTINUITY at the last valid position and is dropped.
    const rewritten = [f.issued(segment, 104n), f.issued(segment, 105n)];
    f.checkpoint({ ...segment, records: rewritten, evidence: chain(rewritten) }, 4n);
    await f.issue(segment, 106n); const valid = f.checkpoint(segment, 5n);
    const store = new ReplayStore();
    const read = await readFrontier(pack(f.items), f.signed, f.venue.witnessedIndex(), { ...f.options, store });
    expect(read.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
      ["3", "excluded", "SIGNATURE"], ["4", "excluded", "CONTINUITY"], ["5", "valid", undefined]]);
    const state = read.canonical!.state;
    expect(read.canonical!.commitment).toEqual(valid);
    expect([101n, 102n, 103n, 104n, 105n, 106n].map(cm => state.hasOutput(cm))).toEqual([true, false, false, false, false, true]);
    // Each valid checkpoint resumed in the one namespace its replay identity names; neither refused replay left one behind.
    expect(store.namespaces(state.identity)).toEqual([state.ns]);
  });

  it("proves an empty frontier and pending replacement from complete venue answers", async () => {
    const f = fixture(); f.replace();
    const empty = await readFrontier(pack([]), f.signed, 4n, f.options);
    expect(empty.canonical).toBeUndefined(); expect(empty.clock).toBeUndefined();
    expect(empty.ranges).not.toHaveProperty("checkpointIndex");
    expect(empty.ranges.chain).toHaveLength(1);
    expect((await f.read()).ranges.chain.at(-1)!.operator).toEqual(next);
  });

  it("accepts a successor empty opening when the original never committed", async () => {
    const f = fixture(), link = f.replace(), segment = f.segment(nextSecret, link);
    const opening = f.checkpoint(segment, 1n, 8n), frontier = await f.read();
    expect(frontier.canonical!.commitment).toEqual(opening);
    expect(frontier.canonical!.state.position).toBe(0n);
    const selected = await readPackage(f.selectedPackage(opening), f.selection(opening), f.options);
    expect(selected.canonical!.commitment).toEqual(opening);
    expect(selected.carrying).toEqual(frontier.carrying);
  });

  it("requires non-carrying directories before concluding empty", async () => {
    const f = fixture(), directory = [{ name: b(80), digest: b(81) }];
    const held = signCommitment(originalSecret, 1n, directoryRoot(directory));
    f.venue.witness(1, original, 1n, encodeCommitment(held));
    await expect(f.read(pack([]))).rejects.toMatchObject({ status: "unresolved-evidence" });
    const result = await f.read(pack([{ kind: 3, payload: encodeEvidenceDirectory(directory) }]));
    expect(result.canonical).toBeUndefined(); expect(result.carrying).toEqual([]);
  });

  it("matches selection replay while ignoring supplied selection and receipt metadata", async () => {
    const f = fixture(), segment = f.segment(), opening = f.checkpoint(segment, 1n);
    await f.issue(segment); const latest = f.checkpoint(segment, 2n);
    const frontier = await f.read(pack([...f.items, { kind: 2, payload: new Uint8Array() }, { kind: 10, payload: b(90) }]));
    const selected = await readPackage(f.selectedPackage(latest), f.selection(latest), f.options);
    expect(frontier.canonical!.commitment).toEqual(latest);
    expect(frontier.canonical!.state.issued).toBe(5n);
    expect(frontier.canonical!.state.history).toEqual(selected.state!.history);
    expect(frontier.carrying).toEqual(selected.carrying);
    await expect(readPackage(f.selectedPackage(opening), f.selection(opening), f.options))
      .rejects.toMatchObject({ status: "superseded-selection" });
  });

  it("refuses omitted carrying evidence and an unavailable range", async () => {
    const f = fixture(); f.checkpoint(f.segment(), 1n);
    for (const omitted of [3, 4, 6]) await expect(f.read(pack(f.items.filter(item => item.kind !== omitted))))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
    const empty = fixture(); empty.venue.range = () => undefined;
    await expect(empty.read()).rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("excludes a proved empty rollback but cannot exclude its withheld trail", async () => {
    const f = fixture(), first = f.segment(); f.checkpoint(first, 1n);
    await f.issue(first); const funded = f.checkpoint(first, 2n);
    const link = f.replace(), rollback = f.segment(nextSecret, link);
    f.checkpoint(rollback, 1n, 8n);
    const result = await f.read();
    expect(result.canonical!.commitment).toEqual(funded);
    expect(result.carrying.at(-1)).toMatchObject({ class: "excluded", check: "IMPORT" });
    const rollbackTrail = encodeTrail({ header: segmentBytes(rollback.header), terms: [f.signed], records: [] });
    await expect(f.read(pack(f.items.filter(item => item.kind !== 6 || compareBytes(item.payload, rollbackTrail) !== 0))))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("validates independent terms, configuration, venue and package scope", async () => {
    const f = fixture();
    await expect(readFrontier(pack([]), { ...f.signed, signature: new Uint8Array(64) }, 10n, f.options))
      .rejects.toMatchObject({ check: "TERMS_SIGNATURE" });
    for (const [fields, check] of [[{ ...f.fields, configuration: b(99) }, "CONFIGURATION"],
      [{ ...f.fields, venue: b(99) }, "VENUE_REFERENCE"]] as const) {
      const terms = encodeRootTerms(fields), signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
      await expect(readFrontier(pack([]), signed, 10n, f.options)).rejects.toMatchObject({ check });
    }
    await expect(f.read(pack([{ kind: 5, payload: b(1) }]))).rejects.toMatchObject({ status: "unsupported-scope" });
    await expect(f.read(pack([{ kind: 1, payload: b(1) }]))).rejects.toMatchObject({ check: "CONFIGURATION" });
  });

  it("owns caller bytes and options before the first asynchronous venue descent", async () => {
    const f = fixture(), opening = f.checkpoint(f.segment(), 1n);
    const bytes = Buffer.from(pack(f.items)), signed = { terms: Buffer.from(f.signed.terms), signature: Buffer.from(f.signed.signature) };
    const options = { ...f.options, configuration: structuredClone(configuration), reference: structuredClone(reference) };
    const pending = readFrontier(bytes, signed, 10n, options);
    bytes.fill(0); signed.terms.fill(0); signed.signature.fill(0); options.configuration.helper.fill(0);
    options.reference.label.fill(0);
    expect((await pending).canonical!.commitment).toEqual(opening);
  });

  it("owns evidence and terms before a synchronous venue getter can mutate caller inputs", async () => {
    const f = fixture(), opening = f.checkpoint(f.segment(), 1n), venueId = f.venue.id;
    const bytes = Buffer.from(pack(f.items)), signed = { terms: Buffer.from(f.signed.terms), signature: Buffer.from(f.signed.signature) };
    const options = { ...f.options, configuration: structuredClone(configuration), reference: structuredClone(reference) };
    Object.defineProperty(f.venue, "id", { get() {
      bytes.fill(0); signed.terms.fill(0); signed.signature.fill(0);
      options.configuration.helper.fill(0); options.reference.label.fill(0);
      return venueId;
    } });
    expect((await readFrontier(bytes, signed, 10n, options)).canonical!.commitment).toEqual(opening);
  });

  it("keeps no walk rows after a read, and none after a refused one", async () => {
    const f = fixture(), segment = f.segment(); f.checkpoint(segment, 1n); await f.issue(segment); f.checkpoint(segment, 2n);
    const store = new ReplayStore(), walks = (): number => store.walkRows();
    expect((await readFrontier(pack(f.items), f.signed, 10n, { ...f.options, store })).carrying).toHaveLength(2);
    expect(walks()).toBe(0);
    await expect(readFrontier(pack(f.items.filter(item => item.kind !== 4)), f.signed, 10n, { ...f.options, store }))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(walks()).toBe(0);
  });
});

describe("single-backing compact fault packages", () => {
  it.each(["PROOF", "SIGNATURE"] as const)("agrees with complete replay for an intrinsic %s failure", async failure => {
    const f = await compactFixture(failure);
    const compact = await f.readCompact(), complete = await f.readCompact(f.f.items);
    expect(canonicalEvidence(compact.canonical)).toEqual(canonicalEvidence(complete.canonical));
    expect(compact.canonical!.commitment).toEqual(f.predecessor);
    expect(compact.carrying).toEqual(complete.carrying);
    expect(compact.carrying.at(-1)).toMatchObject({ class: "excluded", check: failure });
    expect(compact.ranges).toEqual(complete.ranges); expect(compact.clock).toEqual(complete.clock);
    expect(compact.force).toEqual(complete.force);
    expect(compact.faultEvidence).toEqual(complete.faultEvidence);
    expect(compact.faultEvidence).toEqual([expect.objectContaining({ check: failure, sequence: "3", position: "2", length: "3",
      classification: "not-established", ...(failure === "SIGNATURE" ? { authorizationRole: "issue", signer: hex(issuer) } : {}) })]);
    const selected = await f.readSelected(), fullSelected = await f.readSelected(f.f.items);
    expect(canonicalEvidence(selected.canonical)).toEqual(canonicalEvidence(fullSelected.canonical));
    expect(selected.carrying).toEqual(fullSelected.carrying);
    expect(selected.faultEvidence).toEqual(compact.faultEvidence);
    expect((await f.readCompact(f.f.items, [])).faultEvidence).toBeUndefined();
    await expect(f.readCompact(f.compactItems, [])).rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("preserves a valid later opening's inherited state after excluding a compact target", async () => {
    const f = await compactFixture("PROOF", true), compact = await f.readCompact(), complete = await f.readCompact(f.f.items);
    expect(canonicalEvidence(compact.canonical)).toEqual(canonicalEvidence(complete.canonical));
    expect(compact.canonical!.commitment).toEqual(f.selected);
    expect(compact.canonical!.state.issued).toBe(5n);
    expect(compact.carrying.map(item => item.class)).toEqual(["valid", "valid", "excluded", "valid"]);
    expect(canonicalEvidence((await f.readSelected()).canonical)).toEqual(canonicalEvidence(compact.canonical));
  });

  it("requires complete opening and predecessor evidence despite an authenticated fault", async () => {
    const f = await compactFixture("PROOF", true);
    const snapshots = f.f.items.filter(item => item.kind === 4);
    for (const missing of snapshots.slice(0, 2)) {
      const items = f.compactItems.filter(item => item !== missing);
      await expect(f.readCompact(items)).rejects.toMatchObject({ status: "unresolved-evidence" });
      await expect(f.readSelected(items)).rejects.toMatchObject({ status: "unresolved-evidence" });
    }
    const withheldPrefix = f.compactItems.filter(item => item.kind !== 6 || decodeTrail(item.payload).records.length !== 1);
    await expect(f.readCompact(withheldPrefix)).rejects.toMatchObject({ status: "unresolved-evidence" });
    await expect(f.readSelected(withheldPrefix)).rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("never substitutes a compact target for the selected checkpoint's complete envelope", async () => {
    const f = await compactFixture();
    await expect(f.readSelected(f.compactItems, [f.fault], f.hostile)).rejects.toMatchObject({ status: "unresolved-evidence" });
    await expect(f.readSelected(f.f.items, [f.fault], f.hostile)).rejects.toMatchObject({ check: "PROOF" });
  });

  it("cannot descend with altered target fields, snapshot fields, positions or suffix", async () => {
    const f = await compactFixture(), value = decodeFaultEvidence(f.fault, 1024n), variants: Uint8Array[] = [];
    for (const key of ["statement", "proof", "authorization", "previous"] as const) {
      const changed = structuredClone(value); changed[key][0]! ^= 1; variants.push(encodeFaultEvidence(changed, 1024n));
    }
    for (const key of ["backing", "segment", "historyHash", "evidenceHash"] as const) {
      const changed = structuredClone(value); changed.snapshot[key][0]! ^= 1; variants.push(encodeFaultEvidence(changed, 1024n));
    }
    const suffix = structuredClone(value); suffix.suffix[0]!.proofHash[0]! ^= 1;
    variants.push(encodeFaultEvidence(suffix, 1024n), encodeFaultEvidence({ ...value, position: 1n, length: 2n }, 1024n),
      f.fault.subarray(0, f.fault.length - 1));
    for (const changed of variants) {
      await expect(f.readCompact(f.compactItems, [changed])).rejects.toMatchObject({ status: "unresolved-evidence" });
      await expect(f.readSelected(f.compactItems, [changed])).rejects.toMatchObject({ status: "unresolved-evidence" });
    }
  });

  it("requires strict false from the proof verifier and exposes verifier exceptions", async () => {
    const f = await compactFixture();
    for (const outcome of [true, undefined, null, 0]) {
      const custom = { verify: (_kind: number, _inputs: bigint[], proof: Uint8Array) => compareBytes(proof, b(99)) === 0 ? outcome : true };
      await expect(f.readCompact(f.compactItems, [f.fault], custom as ProofCheck))
        .rejects.toMatchObject({ status: "unresolved-evidence" });
    }
    for (const cause of [new Error("verifier failed"), new EncodingError("verifier encoding failed")]) {
      const custom: ProofCheck = { verify(_kind, _inputs, proof) { if (compareBytes(proof, b(99)) === 0) throw cause; return true; } };
      await expect(f.readCompact(f.compactItems, [f.fault], custom)).rejects.toMatchObject({ cause });
    }
  });

  it("refuses more than 32 fault items or 1024 suffix entries before verification", async () => {
    const f = await compactFixture(), value = decodeFaultEvidence(f.fault, 1024n);
    // Canonical package items are distinct even when all 33 claims are invalid.
    const excessiveItems = Array.from({ length: 33 }, (_, i) => encodeFaultEvidence({ ...value, previous: b(i) }, 1024n));
    const excessiveSuffix = encodeFaultEvidence({ ...value, length: value.position + 1025n,
      suffix: Array.from({ length: 1025 }, () => value.suffix[0]!) }, 1025n);
    const custom: ProofCheck = { verify() { throw new Error("resource refusal must precede proof verification"); } };
    for (const faults of [excessiveItems, [excessiveSuffix]]) {
      await expect(f.readCompact(f.compactItems, faults, custom)).rejects.toMatchObject({ status: "resource-refusal" });
      await expect(f.readSelected(f.compactItems, faults)).rejects.toMatchObject({ status: "resource-refusal" });
    }
  });

  it("owns compact bytes across the first asynchronous venue descent and proof check", async () => {
    const f = await compactFixture(), expected = await f.readCompact();
    const bytes = Buffer.from(pack([...f.compactItems, { kind: 7, payload: f.fault }]));
    const pending = readFrontier(bytes, f.f.signed, 10n, { ...f.f.options,
      verifier: { async verify(_kind, _inputs, proof) { await Promise.resolve(); return compareBytes(proof, b(99)) !== 0; } } });
    bytes.fill(0);
    const actual = await pending;
    expect({ ...actual, canonical: canonicalEvidence(actual.canonical) })
      .toEqual({ ...expected, canonical: canonicalEvidence(expected.canonical) });
  });
});
