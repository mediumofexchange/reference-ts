import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { FixtureVenue, LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment, type SnapshotDigest } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { classifyImports, type ImportLimits } from "../src/pool/v3/import-reader.js";
import { TRAIL_LIMITS } from "../src/pool/v3/reader.js";
import { deliveryHash, encodePublication, encodeRecord, statementBytes, type Record } from "../src/pool/v3/records.js";
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
interface Segment { header: SegmentHeader; id: Uint8Array; state: SegmentState; records: Uint8Array[] }
function segment(sequence: bigint, predecessor?: Commitment, imported?: SegmentState): Segment {
  const header: SegmentHeader = { domain, venue: venueId, operator, sequence, entries: [{ backing, link: backing,
    ...(predecessor === undefined ? {} : { opening: { operator, sequence: predecessor.sequence, root: predecessor.root } }) }] };
  const id = segmentIdentity(header);
  return { header, id, state: openSegmentState(id, undefined, imported, undefined, () => {}), records: [] };
}
async function issue(target: Segment, output?: { readonly cm: bigint; readonly capsule: Uint8Array }): Promise<void> {
  const capsules = [output?.capsule ?? new Uint8Array(89).fill(1)], outputs = [output?.cm ?? 101n], scope = new ScopeTree(target.header.entries).root();
  const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(target.id), scope, ...limbsOf(backing),
    5n, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
  const bytes = encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
  await applyRecord(target.state, bytes, { domain, backing, segment: target.id, scope, terms, verifier, index: 2n, block: [] });
  target.records.push(bytes);
}
function fixture(proofVerifier: ProofCheck = verifier) {
  const venue = FixtureVenue.reference(label, lag, 200n), directories = new Map<string, readonly SnapshotDigest[]>();
  const snapshots: Uint8Array[] = [], trails: Uint8Array[] = [];
  const snapshotIds = new Set<string>(), trailIds = new Set<string>();
  function checkpoint(target: Segment, sequence: bigint): Commitment {
    const total = target.state.totals.get(hex(backing)) ?? { issued: 0n, burned: 0n };
    const snapshot = { backing, segment: target.id, historyHash: target.state.history, evidenceHash: target.state.evidence, ...total };
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }], root = directoryRoot(directory);
    const commitment = signCommitment(operatorSecret, sequence, root);
    directories.set(hex(root), directory);
    const encodedSnapshot = snapshotBytes(snapshot), encodedTrail = encodeTrail({ header: segmentBytes(target.header), terms: [signed], records: target.records }, TRAIL_LIMITS);
    if (!snapshotIds.has(hex(encodedSnapshot))) { snapshotIds.add(hex(encodedSnapshot)); snapshots.push(encodedSnapshot); }
    if (!trailIds.has(hex(encodedTrail))) { trailIds.add(hex(encodedTrail)); trails.push(encodedTrail); }
    venue.witness(1, operator, sequence, encodeCommitment(commitment)); return commitment;
  }
  const read = (target: Segment, selected: Commitment, limits: ImportLimits) => classifyImports({
    selection: { mode: "current-fixture", domain, venue: venueId, backing, operator, sequence: selected.sequence,
      root: selected.root, judgingIndex: venue.witnessedIndex() }, terms, header: target.header, verifier: proofVerifier,
    reference: { context: LOCAL_REFERENCE, label, lag }, importLimits: limits,
  }, directories, venue, { snapshots, trails });
  return { checkpoint, read, venue };
}

describe("single-backing reader work budgets", () => {
  it("reserves known request proof variants before their counting window opens", async () => {
    let requestChecks = 0;
    const f = fixture({ verify: (kind, _inputs, proof) => {
      if (kind !== 7) return true;
      requestChecks++; return proof[0] === 7;
    } }), original = segment(1n);
    f.checkpoint(original, 1n);
    const note = prepareExactOutput(b(21), domain, b(22), backing, 5n);
    await issue(original, note); const selected = f.checkpoint(original, 2n);
    const task = requestTask(domain, { note, anchor: original.state.tree.root(), path: original.state.tree.path(0n) }, 0n);
    const request: Record = { domain, kind: task.kind, publicInputs: task.publicInputs,
      proof: b(7), authorization: new Uint8Array(), capsules: task.capsules };
    // One statement identity, first a rejected proof variant and then a valid
    // one. Both bytes are already witnessed at t, but neither is counted yet.
    for (const proof of [b(0), b(7)]) f.venue.witness(4, backing, 200n,
      encodePublication({ domain, backing, kind: 5, record: { ...request, proof } }));
    const before = await f.read(original, selected, { maxCheckpoints: 2n, maxEvents: 3n });
    expect(before.work).toEqual({ checkpoints: 2n, events: 3n, requestProofs: 0n, requestProofReserve: 2n });
    expect(before.ranges?.nonService).toMatchObject({ count: "0", fires: false });
    expect(requestChecks).toBe(0);
    const reserved = before.work!.events - before.work!.requestProofs + before.work!.requestProofReserve;
    const published = f.venue.export().records.length;
    f.venue.advance(202n); // Existing identity now lies in [t-W, t-d].
    expect(f.venue.export().records.length).toBe(published);
    const after = await f.read(original, selected, { maxCheckpoints: 2n, maxEvents: reserved });
    expect(after.work).toEqual({ checkpoints: 2n, events: 5n, requestProofs: 2n, requestProofReserve: 2n });
    expect(after.ranges?.nonService).toMatchObject({ count: "1", fires: true, snapshotIndex: "2" });
    expect(requestChecks).toBe(2);
    expect(after.work!.events - after.work!.requestProofs + after.work!.requestProofReserve).toBe(reserved);
    // Reserving only the former actual work would fail with no new bytes.
    await expect(f.read(original, selected, { maxCheckpoints: 2n, maxEvents: before.work!.events }))
      .rejects.toMatchObject({ status: "resource-refusal" });
  });

  it("charges every fresh imported ancestry scan and no repeated work for a resumable empty continuation", async () => {
    const f = fixture(), a = segment(1n); f.checkpoint(a, 1n);
    await issue(a); const a1 = f.checkpoint(a, 2n);
    const next = segment(3n, a1, a.state); f.checkpoint(next, 3n);
    const continued = f.checkpoint(next, 4n);
    const last = segment(5n, continued, next.state), selected = f.checkpoint(last, 5n);
    const result = await f.read(last, selected, { maxCheckpoints: 5n, maxEvents: 3n });
    expect(result.work).toEqual({ checkpoints: 5n, events: 3n, requestProofs: 0n, requestProofReserve: 0n });
    // One issue plus two fresh scans of that inherited event. A budget that
    // covers only the local records must refuse, never publish partial state.
    await expect(f.read(last, selected, { maxCheckpoints: 5n, maxEvents: 2n })).rejects.toMatchObject({ status: "resource-refusal" });
    await expect(f.read(last, selected, { maxCheckpoints: 4n, maxEvents: 3n })).rejects.toMatchObject({ status: "resource-refusal" });
  });

  it("counts identical held checkpoints even when their public objects deduplicate", async () => {
    const f = fixture(), original = segment(1n); let selected!: Commitment;
    for (let sequence = 1n; sequence <= 128n; sequence++) selected = f.checkpoint(original, sequence);
    const result = await f.read(original, selected, { maxCheckpoints: 128n, maxEvents: 0n });
    expect(result.work).toEqual({ checkpoints: 128n, events: 0n, requestProofs: 0n, requestProofReserve: 0n });
    selected = f.checkpoint(original, 129n);
    await expect(f.read(original, selected, { maxCheckpoints: 128n, maxEvents: 0n })).rejects.toMatchObject({ status: "resource-refusal" });
  }, 90_000); // Two complete 128-checkpoint signature walks, including on slower CI hosts.
});
