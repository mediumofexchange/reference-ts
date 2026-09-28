import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment } from "../src/venue-records.js";
import { limbsOf } from "../src/pool/field.js";
import { ScopeTree } from "../src/pool/scope.js";
import { snapshotBytes, snapshotDigest } from "../src/pool/v3/commitments.js";
import { configurationBytes, configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { readPackage, readSingleBackingPackage, PACKAGE_LIMITS } from "../src/pool/v3/package-reader.js";
import { encodeEvidenceDirectory, encodeEvidencePackage, type EvidenceItem } from "../src/pool/v3/package.js";
import { TRAIL_LIMITS } from "../src/pool/v3/reader.js";
import { deliveryHash, encodeRecord, statementBytes, type Record } from "../src/pool/v3/records.js";
import { ScopeRequired } from "../src/pool/v3/refusals.js";
import { mergeFinalizedPrefixes } from "../src/pool/v3/scope-reader.js";
import { applyRecord, openSegmentState } from "../src/pool/v3/state.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { encodeTrail } from "../src/pool/v3/trail.js";

// Oracle proofs isolate the scope reader's evidence contract; real-proof
// scope groups run in scripts/pool/v3/local-check.mjs (scope-runtime-check.mjs).
const b = (n: number) => new Uint8Array(32).fill(n);
const issuerSecret = b(3), operatorSecret = b(4);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), label = b(2), lag = 2n;
const reference = { context: LOCAL_REFERENCE, label, lag } as const, verifier = { verify: () => true };
const stateOf = <T extends { readonly receipt?: unknown }>(result: T): Exclude<T, { readonly receipt: object }> => {
  if (result.receipt !== undefined) throw new Error("a receipt verdict");
  return result as Exclude<T, { readonly receipt: object }>;
};
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))), PACKAGE_LIMITS);

/** One operator opens a segment scoping two backings and issues into the first. */
async function twoBackings() {
  const venue = FixtureVenue.reference(label, lag, 10n);
  const termsOf = (thing: string): RootTerms => ({ configuration: domain, venue: venue.id, obligor: issuer, operator, interval: 10n,
    payout: { thing, quantumExponent: 0, perUnit: 1n }, replacementRule: ed25519.getPublicKey(b(6)) });
  const backings = ["scope test x", "scope test y"].map(thing => {
    const fields = termsOf(thing), terms = encodeRootTerms(fields);
    return { fields, name: rootTermsName(terms), signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) } };
  }).sort((a, z) => compareBytes(a.name, z.name));
  const [x, y] = backings as [typeof backings[0], typeof backings[0]];
  const header: SegmentHeader = { domain, venue: venue.id, operator, sequence: 1n,
    entries: backings.map(item => ({ backing: item.name, link: item.name })) };
  const id = segmentIdentity(header), scope = new ScopeTree(header.entries).root();
  const scopedTerms = new Map(backings.map(item => [hex(item.name), item.fields]));
  const state = openSegmentState(id, undefined, undefined, undefined, () => {}), records: Uint8Array[] = [];
  const items: EvidenceItem[] = [];
  const add = (kind: number, payload: Uint8Array) => {
    if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
  };
  /** Commit the current state; `alter` may drop or change the directory's snapshots. */
  function checkpoint(sequence: bigint, index: bigint, alter = (snapshots: ReturnType<typeof snapshotsNow>) => snapshots): Commitment {
    const snapshots = alter(snapshotsNow());
    const directory = snapshots.map(snapshot => ({ name: snapshot.backing, digest: snapshotDigest(snapshot) }));
    for (const snapshot of snapshots) add(4, snapshotBytes(snapshot));
    add(3, encodeEvidenceDirectory(directory, PACKAGE_LIMITS));
    add(6, encodeTrail({ header: segmentBytes(header), terms: backings.map(item => item.signed), records }, TRAIL_LIMITS));
    const commitment = signCommitment(operatorSecret, sequence, directoryRoot(directory));
    venue.witness(1, operator, index, encodeCommitment(commitment));
    return commitment;
  }
  function snapshotsNow() {
    return backings.map(item => ({ backing: item.name, segment: id, historyHash: state.history, evidenceHash: state.evidence,
      ...(state.totals.get(hex(item.name)) ?? { issued: 0n, burned: 0n }) }));
  }
  async function issue(value: bigint, output: bigint) {
    const capsules = [new Uint8Array(89).fill(1)], outputs = [output];
    const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(id), scope, ...limbsOf(x.name),
      value, ...outputs, ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
    const bytes = encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), issuerSecret) });
    await applyRecord(state, bytes, { domain, backing: x.name, segment: id, scope, terms: x.fields, scopedTerms, verifier, index: 2n, block: [] });
    records.push(bytes);
  }
  const selection = (backing: Uint8Array, commitment: Commitment) => ({ mode: "current-fixture" as const, domain, venue: venue.id,
    backing, operator, sequence: commitment.sequence, root: commitment.root, judgingIndex: venue.witnessedIndex() });
  const read = (backing: Uint8Array, commitment: Commitment) => readPackage(pack([...items,
    { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(commitment) }]),
  selection(backing, commitment), { configuration, verifier, reference, venue });
  return { venue, x, y, items, checkpoint, issue, selection, read };
}

describe("multi-backing scope reader", () => {
  it("reads each scoped backing's totals from one shared history through the runtime entry", async () => {
    const f = await twoBackings();
    const opening = f.checkpoint(1n, 1n);
    await f.issue(5n, 101n);
    const latest = f.checkpoint(2n, 3n);
    const [readX, readY] = [stateOf(await f.read(f.x.name, latest)), stateOf(await f.read(f.y.name, latest))];
    expect(readX.state.issued).toBe(5n); expect(readY.state.issued).toBe(0n);
    expect(readX.state.history).toEqual(readY.state.history);
    expect(readX.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"]]);
    expect(readX.ranges.heldBefore).toBe(1);
    await expect(f.read(f.x.name, opening)).rejects.toMatchObject({ status: "superseded-selection" });
    const selected = pack([...f.items, { kind: 1, payload: configurationBytes(configuration) }, { kind: 2, payload: encodeCommitment(latest) }]);
    await expect(readSingleBackingPackage(selected, f.selection(f.x.name, latest), { configuration, verifier, reference, venue: f.venue }))
      .rejects.toBeInstanceOf(ScopeRequired);
  });

  it("excludes a checkpoint whose directory omits a scoped backing or misstates its supply", async () => {
    const omitted = await twoBackings();
    omitted.checkpoint(1n, 1n); await omitted.issue(5n, 101n);
    const partial = omitted.checkpoint(2n, 3n, snapshots => snapshots.filter(s => compareBytes(s.backing, omitted.x.name) === 0));
    await expect(omitted.read(omitted.x.name, partial)).rejects.toMatchObject({ check: "SCOPE" });
    const misstated = await twoBackings();
    misstated.checkpoint(1n, 1n); await misstated.issue(5n, 101n);
    const wrong = misstated.checkpoint(2n, 3n, snapshots => snapshots.map(s =>
      compareBytes(s.backing, misstated.y.name) === 0 ? { ...s, issued: 5n } : s));
    await expect(misstated.read(misstated.x.name, wrong)).rejects.toMatchObject({ check: "SNAPSHOT" });
  });

  it("merges imported prefixes once per event and refuses a conflicting identity", async () => {
    const f = await twoBackings();
    f.checkpoint(1n, 1n); await f.issue(5n, 101n);
    const read = await f.read(f.x.name, f.checkpoint(2n, 3n));
    let charged = 0n;
    const merged = mergeFinalizedPrefixes([{ state: read.state! }, { state: read.state! }, undefined], amount => { charged += amount; });
    // Each parent's events are charged when read, even when they repeat.
    expect(merged.events.size).toBe(1); expect(charged).toBe(2n);
    expect(merged.totals.get(hex(f.x.name))).toEqual({ issued: 5n, burned: 0n });
    const [id, event] = [...read.state!.events][0]!;
    const conflicting = { ...read.state!, events: new Map([[id, { ...event, identity: "other" }]]) };
    expect(() => mergeFinalizedPrefixes([{ state: read.state! }, { state: conflicting }], () => {})).toThrow(expect.objectContaining({ check: "CONTINUITY" }));
  });
});
