import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { FixtureVenue, LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment, type SnapshotDigest } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { classifyScopes } from "../src/pool/v3/scope-reader.js";
import { deliveryHash, encodePublication, encodeRecord, statementBytes, type Record } from "../src/pool/v3/records.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentState } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";
import { requestTask } from "../src/pool/v3/witness.js";

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const domain = b(1), label = b(2), lag = 2n, venueId = localVenueIdentity(label, lag);
const issuerSecret = b(3), operatorSecret = b(4), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const terms: RootTerms = { configuration: domain, venue: venueId, obligor: issuer, operator, interval: 10n,
  payout: { thing: "budget test", quantumExponent: 0, perUnit: 1n }, nonService: { duration: 2n, count: 1n, window: 10n } };
const encodedTerms = encodeRootTerms(terms), signed = { terms: encodedTerms, signature: ed25519.sign(rootTermsSignatureMessage(encodedTerms), issuerSecret) };
const backing = rootTermsName(encodedTerms), verifier = { verify: () => true };
const operatorStore = new ReplayStore();
interface Segment { header: SegmentHeader; id: Uint8Array; state: SegmentState; records: Uint8Array[] }
function segment(sequence: bigint, predecessor?: Commitment, imported?: SegmentState): Segment {
  const header: SegmentHeader = { domain, venue: venueId, operator, sequence, entries: [{ backing, link: backing,
    ...(predecessor === undefined ? {} : { opening: { operator, sequence: predecessor.sequence, root: predecessor.root } }) }] };
  const id = segmentIdentity(header);
  return { header, id, state: openSegmentState(operatorStore, id, b(90), imported), records: [] };
}
async function issue(target: Segment, output?: { readonly cm: bigint; readonly capsule: Uint8Array }): Promise<void> {
  const capsules = [output?.capsule ?? new Uint8Array(89).fill(1)], outputs = [output?.cm ?? 101n], scope = new ScopeTree(target.header.entries).root();
  const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(target.id), scope, ...limbsOf(backing),
    5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
  const bytes = encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
  await applyRecord(target.state, bytes, { domain, backing, segment: target.id, scope, terms, verifier, index: 2n, block: [], witness: () => true });
  target.records.push(bytes);
}
/** A payment spending `nfs` under `anchor` into four fresh outputs. */
async function spend(target: Segment, nfs: readonly [bigint, bigint], anchor: bigint, outputs: readonly bigint[]): Promise<void> {
  const capsules = outputs.map(() => new Uint8Array(89).fill(1)), scope = new ScopeTree(target.header.entries).root();
  const bytes = encodeRecord({ domain, kind: 2, publicInputs: [...limbsOf(domain), ...limbsOf(target.id), scope, anchor, anchor, ...nfs, ...outputs,
    ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(), capsules });
  await applyRecord(target.state, bytes, { domain, backing, segment: target.id, scope, terms, verifier, index: 2n, block: [] });
  target.records.push(bytes);
}
function fixture(proofVerifier: ProofCheck = verifier) {
  const venue = FixtureVenue.reference(label, lag, 200n), directories = new Map<string, readonly SnapshotDigest[]>();
  const snapshots: Uint8Array[] = [], trails: Uint8Array[] = [];
  const snapshotIds = new Set<string>(), trailIds = new Set<string>();
  function checkpoint(target: Segment, sequence: bigint, index = sequence, misstated = 0n): Commitment {
    const total = target.state.total(hex(backing));
    const snapshot = { backing, segment: target.id, historyHash: target.state.history, evidenceHash: target.state.evidence,
      ...total, issued: total.issued + misstated };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }], root = directoryRoot(directory);
    const commitment = signCommitment(operatorSecret, sequence, root);
    directories.set(hex(root), directory);
    const encodedSnapshot = snapshotBytes(snapshot), encodedTrail = encodeTrail({ header: segmentBytes(target.header), terms: [signed], records: target.records });
    if (!snapshotIds.has(hex(encodedSnapshot))) { snapshotIds.add(hex(encodedSnapshot)); snapshots.push(encodedSnapshot); }
    if (!trailIds.has(hex(encodedTrail))) { trailIds.add(hex(encodedTrail)); trails.push(encodedTrail); }
    venue.witness(1, operator, index, encodeCommitment(commitment)); return commitment;
  }
  const read = (target: Segment, selected: Commitment) => {
    const stored = new EvidenceStore().importTrails(trails);
    return classifyScopes({ store: new ReplayStore(),
      selection: { mode: "current-fixture", domain, venue: venueId, backing, operator, sequence: selected.sequence,
        root: selected.root, judgingIndex: venue.witnessedIndex() }, terms, header: target.header, verifier: proofVerifier,
      reference: { context: LOCAL_REFERENCE, label, lag },
    }, venue, { directory: root => directories.get(hex(root)), snapshot: digest => snapshots.find(s => hex(sha256(s)) === hex(digest)),
      trails: stored, answers: stored });
  };
  return { checkpoint, read, venue };
}

describe("the single-backing reader walk", () => {
  it("checks a known request's proof variants only once its counting window opens", async () => {
    let requestChecks = 0;
    const f = fixture({ verify: (kind, _inputs, proof) => {
      if (kind !== 7) return true;
      requestChecks++; return proof[0] === 7;
    } }), original = segment(1n);
    f.checkpoint(original, 1n);
    const note = prepareExactOutput(b(21), domain, b(22), backing, 5n);
    await issue(original, note); const selected = f.checkpoint(original, 2n);
    const placed = original.state.path(note.cm)!, task = requestTask(domain, { note, anchor: placed.anchor, path: placed.path }, 0n);
    const request: Record = { domain, kind: task.kind, publicInputs: task.publicInputs,
      proof: b(7), authorization: new Uint8Array(), capsules: task.capsules };
    // One statement identity, first a rejected proof variant and then a valid
    // one. Both bytes are already witnessed at t, but neither is counted yet.
    for (const proof of [b(0), b(7)]) f.venue.witness(4, backing, 200n,
      encodePublication({ domain, backing, kind: 5, record: { ...request, proof } }));
    const before = await f.read(original, selected);
    expect(before.ranges?.nonService).toMatchObject({ count: "0", fires: false });
    expect(requestChecks).toBe(0);
    const published = f.venue.export().records.length;
    f.venue.advance(202n); // Existing identity now lies in [t-W, t-d].
    expect(f.venue.export().records.length).toBe(published);
    const after = await f.read(original, selected);
    expect(after.ranges?.nonService).toMatchObject({ count: "1", fires: true, snapshotIndex: "2" });
    // The rejected variant, then the verifying one.
    expect(requestChecks).toBe(2);
  });

  it("counts at the judging index against the snapshot strictly before it, though the selection there moved the segment on", async () => {
    const f = fixture(), original = segment(1n); f.checkpoint(original, 1n);
    const note = prepareExactOutput(b(21), domain, b(22), backing, 5n);
    await issue(original, note); f.checkpoint(original, 2n);
    const placed = original.state.path(note.cm)!, task = requestTask(domain, { note, anchor: placed.anchor, path: placed.path }, 0n);
    f.venue.witness(4, backing, 195n, encodePublication({ domain, backing, kind: 5, record: { domain, kind: task.kind,
      publicInputs: task.publicInputs, proof: b(7), authorization: new Uint8Array(), capsules: task.capsules } }));
    // The checkpoint selected at t spends the requested note, in the same segment's
    // state; C2b.5.2 reads that segment at its position strictly before t, where it is unspent.
    await spend(original, [note.nf, 777n], placed.anchor, [201n, 202n, 203n, 204n]);
    const selected = f.checkpoint(original, 3n, 200n);
    const result = await f.read(original, selected);
    expect(result.state!.hasNullifier(note.nf)).toBe(true);
    expect(result.ranges?.nonService).toMatchObject({ count: "1", fires: true, snapshotIndex: "2" });
  });

  it("imports each opening's ancestry and resumes an empty continuation in its opening's namespace", async () => {
    const f = fixture(), a = segment(1n); f.checkpoint(a, 1n);
    await issue(a); const a1 = f.checkpoint(a, 2n);
    const next = segment(3n, a1, a.state); f.checkpoint(next, 3n);
    const continued = f.checkpoint(next, 4n);
    const last = segment(5n, continued, next.state), selected = f.checkpoint(last, 5n);
    const result = await f.read(last, selected);
    expect(result.carrying!.map(item => item.class)).toEqual(["valid", "valid", "valid", "valid", "valid"]);
    // The one issue reaches the last opening through both imports.
    expect([result.state!.issued, result.state!.eventCount(), result.state!.imports().size]).toEqual([5n, 1n, 2]);
  });

  it("founds a segment on an opening excluded for its own snapshot, so a later valid checkpoint of it finalizes (C2.10.12)", async () => {
    const f = fixture(), original = segment(1n);
    f.checkpoint(original, 1n, 1n, 1n); // The opening misstates its supply.
    await issue(original); const selected = f.checkpoint(original, 2n);
    const result = await f.read(original, selected);
    expect(result.carrying!.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "excluded", "SNAPSHOT"], ["2", "valid", undefined]]);
    expect(result.state!.issued).toBe(5n);
  });

  it("classifies every held checkpoint past the retired 128-checkpoint total, even when their public objects deduplicate", async () => {
    const f = fixture(), original = segment(1n); let selected!: Commitment;
    for (let sequence = 1n; sequence <= 129n; sequence++) selected = f.checkpoint(original, sequence);
    const result = await f.read(original, selected);
    expect(result.carrying!.length).toBe(129);
    expect(result.carrying!.every(item => item.class === "valid")).toBe(true);
  }, 90_000); // A complete 129-checkpoint signature walk, including on slower CI hosts.
});
