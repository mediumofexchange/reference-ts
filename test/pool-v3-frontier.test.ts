import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, encodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR,
  signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationBytes, configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readSingleBackingFrontier, readSingleBackingPackage, PACKAGE_LIMITS } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { TRAIL_LIMITS } from "../src/pool/v3/reader.js";
import { deliveryHash, encodeRecord, statementBytes, type Record } from "../src/pool/v3/records.js";
import { applyRecord, openSegmentState, type SegmentState } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), originalSecret = b(4), nextSecret = b(5), ruleSecret = b(6);
const issuer = ed25519.getPublicKey(issuerSecret), original = ed25519.getPublicKey(originalSecret), next = ed25519.getPublicKey(nextSecret);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), label = b(2), lag = 2n;
const reference = { context: LOCAL_REFERENCE, label, lag } as const, verifier = { verify: () => true };
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))), PACKAGE_LIMITS);
interface Segment { header: SegmentHeader; id: Uint8Array; state: SegmentState; records: Uint8Array[]; secret: Uint8Array }

function fixture() {
  const venue = FixtureVenue.reference(label, lag, 10n);
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
    return { header, id, state: openSegmentState(id, undefined, imported, undefined, () => {}), records: [], secret };
  }
  function checkpoint(target: Segment, sequence: bigint, index = sequence): Commitment {
    const total = target.state.totals.get(hex(backing)) ?? { issued: 0n, burned: 0n };
    const snapshot = { backing, segment: target.id, historyHash: target.state.history, evidenceHash: target.state.evidence, ...total };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }];
    const commitment = signCommitment(target.secret, sequence, directoryRoot(directory));
    add(3, encodeEvidenceDirectory(directory, PACKAGE_LIMITS)); add(4, snapshotBytes(snapshot));
    add(6, encodeTrail({ header: segmentBytes(target.header), terms: [signed], records: target.records }, TRAIL_LIMITS));
    venue.witness(1, target.header.operator, index, encodeCommitment(commitment));
    return commitment;
  }
  async function issue(target: Segment) {
    const scope = new ScopeTree(target.header.entries).root(), capsules = [new Uint8Array(89).fill(1)], outputs = [101n];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(target.id), scope, ...limbsOf(backing),
      5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
    const bytes = encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
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
  const read = (evidence = pack(items)) => readSingleBackingFrontier(evidence, signed, venue.witnessedIndex(), options);
  return { venue, fields, signed, backing, items, options, segment, checkpoint, issue, replace, selection, selectedPackage, read };
}

describe("single-backing complete frontier reader", () => {
  it("proves an empty frontier and pending replacement from complete venue answers", async () => {
    const f = fixture(); f.replace();
    const empty = await readSingleBackingFrontier(pack([]), f.signed, 4n, f.options);
    expect(empty.canonical).toBeUndefined(); expect(empty.clock).toBeUndefined();
    expect(empty.ranges).not.toHaveProperty("checkpointIndex");
    expect(empty.ranges.chain).toHaveLength(1);
    expect(empty.work).toEqual({ checkpoints: 0n, events: 0n, requestProofs: 0n, requestProofReserve: 0n });
    expect((await f.read()).ranges.chain.at(-1)!.operator).toEqual(next);
  });

  it("accepts a successor empty opening when the original never committed", async () => {
    const f = fixture(), link = f.replace(), segment = f.segment(nextSecret, link);
    const opening = f.checkpoint(segment, 1n, 8n), frontier = await f.read();
    expect(frontier.canonical!.commitment).toEqual(opening);
    expect(frontier.canonical!.state.position).toBe(0n);
    const selected = await readSingleBackingPackage(f.selectedPackage(opening), f.selection(opening), f.options);
    expect(selected.canonical!.commitment).toEqual(opening);
    expect(selected.carrying).toEqual(frontier.carrying);
  });

  it("requires non-carrying directories before concluding empty", async () => {
    const f = fixture(), directory = [{ name: b(80), digest: b(81) }];
    const held = signCommitment(originalSecret, 1n, directoryRoot(directory));
    f.venue.witness(1, original, 1n, encodeCommitment(held));
    await expect(f.read(pack([]))).rejects.toMatchObject({ status: "unresolved-evidence" });
    const result = await f.read(pack([{ kind: 3, payload: encodeEvidenceDirectory(directory, PACKAGE_LIMITS) }]));
    expect(result.canonical).toBeUndefined(); expect(result.work.checkpoints).toBe(1n);
  });

  it("matches selection replay while ignoring supplied selection and receipt metadata", async () => {
    const f = fixture(), segment = f.segment(), opening = f.checkpoint(segment, 1n);
    await f.issue(segment); const latest = f.checkpoint(segment, 2n);
    const frontier = await f.read(pack([...f.items, { kind: 2, payload: new Uint8Array() }, { kind: 10, payload: b(90) }]));
    const selected = await readSingleBackingPackage(f.selectedPackage(latest), f.selection(latest), f.options);
    expect(frontier.canonical!.commitment).toEqual(latest);
    expect(frontier.canonical!.state.issued).toBe(5n);
    expect(frontier.canonical!.state.history).toEqual(selected.state!.history);
    expect(frontier.carrying).toEqual(selected.carrying); expect(frontier.work).toEqual(selected.work);
    await expect(readSingleBackingPackage(f.selectedPackage(opening), f.selection(opening), f.options))
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
    const rollbackTrail = encodeTrail({ header: segmentBytes(rollback.header), terms: [f.signed], records: [] }, TRAIL_LIMITS);
    await expect(f.read(pack(f.items.filter(item => item.kind !== 6 || compareBytes(item.payload, rollbackTrail) !== 0))))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("validates independent terms, configuration, venue and package scope", async () => {
    const f = fixture();
    await expect(readSingleBackingFrontier(pack([]), { ...f.signed, signature: new Uint8Array(64) }, 10n, f.options))
      .rejects.toMatchObject({ check: "TERMS_SIGNATURE" });
    for (const [fields, check] of [[{ ...f.fields, configuration: b(99) }, "CONFIGURATION"],
      [{ ...f.fields, venue: b(99) }, "VENUE_REFERENCE"]] as const) {
      const terms = encodeRootTerms(fields), signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
      await expect(readSingleBackingFrontier(pack([]), signed, 10n, f.options)).rejects.toMatchObject({ check });
    }
    await expect(f.read(pack([{ kind: 5, payload: b(1) }]))).rejects.toMatchObject({ status: "unsupported-scope" });
    await expect(f.read(pack([{ kind: 1, payload: b(1) }]))).rejects.toMatchObject({ check: "CONFIGURATION" });
  });

  it("owns caller bytes and options before the first asynchronous venue descent", async () => {
    const f = fixture(), opening = f.checkpoint(f.segment(), 1n);
    const bytes = Buffer.from(pack(f.items)), signed = { terms: Buffer.from(f.signed.terms), signature: Buffer.from(f.signed.signature) };
    const options = { ...f.options, configuration: structuredClone(configuration), reference: structuredClone(reference),
      importLimits: { maxCheckpoints: 1n, maxEvents: 0n } };
    const pending = readSingleBackingFrontier(bytes, signed, 10n, options);
    bytes.fill(0); signed.terms.fill(0); signed.signature.fill(0); options.configuration.helper.fill(0);
    options.reference.label.fill(0); options.importLimits.maxCheckpoints = 0n;
    expect((await pending).canonical!.commitment).toEqual(opening);
  });

  it("owns evidence and terms before a synchronous venue getter can mutate caller inputs", async () => {
    const f = fixture(), opening = f.checkpoint(f.segment(), 1n), venueId = f.venue.id;
    const bytes = Buffer.from(pack(f.items)), signed = { terms: Buffer.from(f.signed.terms), signature: Buffer.from(f.signed.signature) };
    const options = { ...f.options, configuration: structuredClone(configuration), reference: structuredClone(reference),
      importLimits: { maxCheckpoints: 1n, maxEvents: 0n } };
    Object.defineProperty(f.venue, "id", { get() {
      bytes.fill(0); signed.terms.fill(0); signed.signature.fill(0);
      options.configuration.helper.fill(0); options.reference.label.fill(0); options.importLimits.maxCheckpoints = 0n;
      return venueId;
    } });
    expect((await readSingleBackingFrontier(bytes, signed, 10n, options)).canonical!.commitment).toEqual(opening);
  });

  it("charges both checkpoint descent and record replay under independent limits", async () => {
    const f = fixture(), segment = f.segment(); f.checkpoint(segment, 1n); await f.issue(segment); f.checkpoint(segment, 2n);
    const bytes = pack(f.items);
    expect((await f.read()).work).toMatchObject({ checkpoints: 2n, events: 1n });
    for (const importLimits of [{ maxCheckpoints: 1n, maxEvents: 1n }, { maxCheckpoints: 2n, maxEvents: 0n }]) {
      await expect(readSingleBackingFrontier(bytes, f.signed, 10n, { ...f.options, importLimits }))
        .rejects.toMatchObject({ status: "resource-refusal" });
    }
  });
});
