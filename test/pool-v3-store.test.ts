import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { Server } from "node:http";
import { ERGO_SYNTHETIC_REFERENCE, ERGO_TESTNET_REFERENCE } from "../src/ergo-profile.js";
import { ErgoPublisher, verifyErgoProof } from "../src/ergo-publisher.js";
import { MempoolNode, plainBox, SCRIPTS } from "./ergo-chain.js";
import { Chain } from "../src/ergo-synthetic.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { decodeReceipt, decodeSnapshot, verifyReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { EvidenceStore, type EvidencePart } from "../src/pool/v3/evidence-store.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import { ReferenceVenueError, referenceVenue, requireReferenceVenue, type VenueReference } from "../src/pool/v3/guard.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidenceDirectory, decodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import type { ServedPackage, V3OperatorJournal as Journal, V3StoreError as StoreError } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail } from "../src/pool/v3/trail.js";
import { authorizeIssue, burnTask, issueTask, spendTask, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { ScopeTree } from "../src/pool/scope.js";
import { RangeLimitError, type RangeRequest } from "../src/record-range.js";
import { FixtureVenue, LOCAL_REFERENCE, localVenueIdentity, type RecordPublisher, type RecordVenue } from "../src/record-venue.js";
import { encodeCommitment, encodeRevocation, isEquivocation, signCommitment, signRevocation } from "../src/venue-records.js";

// The pool-v3 operator journal (src/pool/v3/store.ts) on the local reference
// venue, over records built by witness.ts with proofs a test verifier judges.
// Real proofs, the served package's independent replay and seed restoration
// run in the acceptance script (scripts/pool/v3/store-check.mjs).

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const HELPER = hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8");
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration);
const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference: VenueReference = { context: LOCAL_REFERENCE, label, lag };
const venueId = localVenueIdentity(label, lag);
const termsFields = (overrides: Partial<RootTerms> = {}): RootTerms => ({ obligor: issuer, payout: { thing: "test units", quantumExponent: 0, perUnit: 1n },
  operator, configuration: domain, venue: venueId, interval: 10n, ...overrides });
const signedTerms = (fields = termsFields(), secret = issuerSecret) => {
  const terms = encodeRootTerms(fields);
  return { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), secret) };
};
const signed = signedTerms(), backing = rootTermsName(signed.terms);
const header: SegmentHeader = { domain, venue: venueId, operator, sequence: 1n, entries: [{ backing, link: backing }] };
const context: SegmentContext = { domain, header };
const payerSeed = b(21), receiverSeed = b(22), operatorSeed = b(23);
const output = (seed: Uint8Array, id: number, value: bigint) => prepareExactOutput(seed, domain, b(id), backing, value);
const funded = output(payerSeed, 31, 10n), pad = output(payerSeed, 36, 0n);
const paid = output(receiverSeed, 32, 7n), fee = output(operatorSeed, 33, 1n), change = output(payerSeed, 34, 2n), zero = output(payerSeed, 35, 0n);
const receiverPad = output(receiverSeed, 38, 0n), burnChange = output(receiverSeed, 37, 2n);
/** A record with the task's exact public inputs and a stand-in proof the test verifier judges. */
const record = (task: ProofTask, proofByte: number = task.kind): Record =>
  ({ domain, kind: task.kind, publicInputs: task.publicInputs, proof: new Uint8Array(32).fill(proofByte), authorization: new Uint8Array(), capsules: task.capsules });
const issue = (out = funded, secret = issuerSecret): Uint8Array => encodeRecord(authorizeIssue(record(issueTask(context, out)), secret));
/** Spend `funded` and a padding input under the tree after the issue. */
function payment(outputs = [paid, fee, change, zero]): Uint8Array {
  const tree = new NoteTree(); tree.append(funded.cm);
  const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
  return encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], outputs)));
}
function burning(): Uint8Array {
  const tree = new NoteTree(); tree.appendAll([funded.cm, paid.cm, fee.cm, change.cm, zero.cm]);
  const input = { note: paid, anchor: tree.root(), path: tree.path(1n) };
  return encodeRecord(record(burnTask(context, 5n, [input, { ...input, note: receiverPad }], burnChange)));
}

describe("the candidate guard", () => {
  it("accepts a venue only where its identity and lag recompute from a reference preimage", () => {
    const venue = FixtureVenue.reference(label, lag);
    expect(venue.id).toEqual(venueId);
    expect(requireReferenceVenue(reference, venue)).toEqual(venueId);
    const refused = (ref: VenueReference, v: { id: Uint8Array; lag(): bigint }) => () => requireReferenceVenue(ref, v);
    // A caller-chosen identity, another label, another lag, and a lag the venue misstates.
    expect(refused(reference, new FixtureVenue(b(12), 0n, lag))).toThrow(ReferenceVenueError);
    expect(refused({ ...reference, label: b(13) }, venue)).toThrow(ReferenceVenueError);
    expect(refused({ ...reference, lag: 3n }, venue)).toThrow(ReferenceVenueError);
    expect(refused(reference, { id: venue.id, lag: () => 3n })).toThrow(ReferenceVenueError);
    // Contexts outside the closed set, and malformed preimages.
    expect(refused({ context: "moe/venue/ergo/v3" } as unknown as VenueReference, venue)).toThrow(ReferenceVenueError);
    expect(refused({ ...reference, label: b(1).subarray(1) }, venue)).toThrow(ReferenceVenueError);
    expect(refused(null as unknown as VenueReference, venue)).toThrow(ReferenceVenueError);
  });
  it("recomputes the synthetic chain's identity and refuses every deployment profile", () => {
    const profile = new Chain().profile(1n), synthetic = referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile });
    expect(synthetic.lag).toBe(2n);
    expect(requireReferenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile }, { id: synthetic.id, lag: () => 2n })).toEqual(synthetic.id);
    // The same anchor, depth and locations under venue-ergo's own context: the mainnet profile.
    const { reference: _, ...mainnet } = profile;
    expect(() => referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile: mainnet })).toThrow(ReferenceVenueError);
    // A context that reads as synthetic once and as venue-ergo's afterwards is hashed as it was checked.
    let reads = 0;
    const shifting = { ...mainnet, get reference() { return reads++ === 0 ? ERGO_SYNTHETIC_REFERENCE : undefined; } };
    const shifted = referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile: shifting as typeof profile });
    expect(shifted.id).toEqual(synthetic.id);
  });
  it("binds testnet to its own context, profile and lag, without inferring a network from an id", () => {
    const profile = { ...new Chain().profile(2n), reference: ERGO_TESTNET_REFERENCE } as const;
    const reference = { context: ERGO_TESTNET_REFERENCE, profile } as const, expected = referenceVenue(reference);
    expect(expected.lag).toBe(3n);
    expect(requireReferenceVenue(reference, { id: expected.id, lag: () => 3n })).toEqual(expected.id);
    const synthetic = { ...profile, reference: ERGO_SYNTHETIC_REFERENCE } as const;
    expect(referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile: synthetic }).id).not.toEqual(expected.id);
    expect(() => referenceVenue({ ...reference, profile: synthetic })).toThrow(ReferenceVenueError);
    expect(() => referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile })).toThrow(ReferenceVenueError);
    const { reference: _, ...deployment } = profile;
    expect(() => referenceVenue({ ...reference, profile: deployment })).toThrow(ReferenceVenueError);
    expect(() => requireReferenceVenue(reference, { id: expected.id, lag: () => 2n })).toThrow(ReferenceVenueError);
  });
});

describe("a local venue's publishing side", () => {
  it("witnesses each new record at the next index and an exact repeat nowhere", async () => {
    const venue = FixtureVenue.reference(label, lag, 4n), record = encodeRevocation(signRevocation(issuerSecret));
    await venue.publishRecord(3, issuer, record);
    await venue.publishRecord(3, issuer, record);
    expect(venue.witnessedIndex()).toBe(5n);
    expect(venue.export().records.map(r => r.index)).toEqual([5n]);
    // A malformed record is the caller's error (RecordPublisher).
    await expect(venue.publishRecord(3, b(1).subarray(1), record)).rejects.toThrow("invalid fixture venue record");
    await expect(venue.publishRecord(3, b(1).subarray(1), record)).rejects.not.toThrow(TypeError);
  });
});

describe("the v3 operator journal", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let V3StoreError: typeof import("../src/pool/v3/store.js").V3StoreError;
  let createV3Service: typeof import("../src/pool/v3/service-http.js").createV3Service;
  const journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch"), servers: Server[] = [];
  beforeAll(async () => {
    ({ V3OperatorJournal, V3StoreError } = await import("../src/pool/v3/store.js"));
    ({ createV3Service } = await import("../src/pool/v3/service-http.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    for (const j of journals.splice(0)) { try { j.close(); } catch { /* a fenced or closed handle */ } }
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  function path(): string {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pool-v3-store-")); directories.push(directory);
    return join(directory, "journal.db");
  }
  /** A verifier that accepts exactly the stand-in proofs whose first byte is the kind. */
  const verifier = { verify: (kind: number, _inputs: bigint[], proof: Uint8Array) => proof[0] === kind };
  function journal(file: string, venue: RecordVenue & RecordPublisher, secret = operatorSecret): Journal {
    const j = new V3OperatorJournal(file, { secret, venue, reference, verifier }); journals.push(j); return j;
  }
  /** `venue`, telling `asked` each range request the journal makes of it. */
  const asking = (venue: FixtureVenue, asked: (request: RangeRequest) => void): RecordVenue & RecordPublisher => ({
    id: venue.id, lag: () => venue.lag(), witnessedIndex: () => venue.witnessedIndex(),
    range: (request, limits) => { asked(request); return venue.range(request, limits); },
    publishRecord: (kind, subject, record) => venue.publishRecord(kind, subject, record) });
  async function refusal(action: Promise<unknown>): Promise<[string, string | undefined]> {
    const error = await action.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(V3StoreError);
    return [(error as StoreError).code, (error as StoreError).check];
  }
  async function opened(venue = FixtureVenue.reference(label, lag)) {
    const file = path(), j = journal(file, venue);
    await j.open("genesis", signed); await j.publish();
    return { file, venue, j };
  }

  it("persists exact publisher retries in the owning journal and fences its replaced owner", async () => {
    const file = path(), venue = FixtureVenue.reference(label, lag), j = journal(file, venue);
    const n = new MempoolNode("outbox", verifyErgoProof);
    const p = new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence: j.publisherPersistence() });
    n.fund(plainBox(p.tree, 10_000_000n, 0n));
    const request = { location: SCRIPTS[1], subject: b(90), record: b(89), height: 0n };
    n.refuse = () => true;
    await expect(p.publish(request)).rejects.toThrow(/kept and sent again/);
    const submitted = [...n.submitted];
    const next = journal(file, venue); // replace the database owner before retry
    await expect(p.publish(request)).rejects.toMatchObject({ code: "FENCED" });
    expect(n.submitted).toEqual(submitted);
    const restored = new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence: next.publisherPersistence() });
    n.refuse = () => false;
    const retry = await restored.publish(request);
    expect(bytesToHex(retry.id)).toBe(submitted[0]);
    const competing = new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence: next.publisherPersistence() });
    await competing.publish({ ...request, record: b(88) });
    await expect(restored.publish(request)).rejects.toMatchObject({ code: "FENCED" });
  });

  it("writes the publisher outbox from inside journal publication without reentering its operation queue", async () => {
    const venue = FixtureVenue.reference(label, lag), j = journal(path(), venue);
    const n = new MempoolNode("outbox", verifyErgoProof);
    const p = new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence: j.publisherPersistence() });
    n.fund(plainBox(p.tree, 10_000_000n, 0n));
    const publish = venue.publishRecord.bind(venue);
    venue.publishRecord = async (kind, subject, record) => {
      await p.publish({ location: SCRIPTS[1], subject, record, height: 0n });
      return publish(kind, subject, record);
    };
    const opening = await j.open("genesis", signed);
    expect(await j.publish()).toEqual(opening);
    expect((await j.package()).selection.sequence).toBe(1n);
    expect(p.unsettled).toBe(1);
  });

  it("fences an existing retry when ownership changes during supplier lookup", async () => {
    const file = path(), venue = FixtureVenue.reference(label, lag), j = journal(file, venue);
    const n = new MempoolNode("outbox", verifyErgoProof);
    const p = new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence: j.publisherPersistence() });
    n.fund(plainBox(p.tree, 10_000_000n, 0n)); n.refuse = () => true;
    const request = { location: SCRIPTS[1], subject: b(90), record: b(89), height: 0n };
    await expect(p.publish(request)).rejects.toThrow(/kept and sent again/);
    n.hasTransaction = async () => { journal(file, venue); return false; };
    await expect(p.publish(request)).rejects.toMatchObject({ code: "FENCED" });
    expect(n.submitted).toHaveLength(1);
  });

  it("allows only one publisher to load each persistence adapter", () => {
    const j = journal(path(), FixtureVenue.reference(label, lag)), persistence = j.publisherPersistence();
    const n = new MempoolNode("outbox", verifyErgoProof);
    new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence });
    expect(() => new ErgoPublisher({ secretKey: b(91), suppliers: [n], persistence })).toThrow(/adapter is already loaded/);
  });

  it("refuses a venue the guard does not recompute before touching the path", () => {
    expect(() => new V3OperatorJournal(path(), { secret: operatorSecret, venue: new FixtureVenue(venueId, 0n, 3n), reference, verifier }))
      .toThrow(ReferenceVenueError);
  });

  it("opens, admits issue, payment with a fee and burn, commits and serves the package", async () => {
    const venue = FixtureVenue.reference(label, lag), j = journal(path(), venue);
    const opening = await j.open("genesis", signed);
    expect(opening.sequence).toBe(1n);
    // Service waits for the opening to be published (C2.10.9).
    expect(await refusal(j.submit(issue()))).toEqual(["STALE", undefined]);
    await j.publish();
    const authority = { domain, segment: segmentIdentity(header), scopeRoot: new ScopeTree(header.entries).root(), operator };
    const receipts = [];
    for (const bytes of [issue(), payment(), burning()]) {
      const receipt = decodeReceipt(await j.submit(bytes));
      expect(verifyReceipt(authority, receipt)).toBe(true);
      expect(receipt.after).toBe(1n);
      receipts.push(receipt);
    }
    expect(receipts.map(r => r.position)).toEqual([1n, 2n, 3n]);
    const checkpoint = await j.commit("c2");
    expect(checkpoint.sequence).toBe(2n);
    await j.publish();
    const served = await j.package(), items = decodeEvidencePackage(served.package, { maxBytes: 1n << 20n, maxItems: 64n });
    expect(served.selection.sequence).toBe(2n);
    expect(items.map(i => i.kind)).toEqual([1, 2, 3, 3, 4, 4, 6]);
    const snapshots = items.filter(i => i.kind === 4).map(i => decodeSnapshot(i.payload));
    expect(snapshots.map(s => [s.issued, s.burned])).toContainEqual([10n, 5n]);
    expect(snapshots.map(s => [s.issued, s.burned])).toContainEqual([0n, 0n]);
    const trail = decodeTrail(items.find(i => i.kind === 6)!.payload);
    expect(trail.records.length).toBe(3);
    const directories = items.filter(i => i.kind === 3).map(i => decodeEvidenceDirectory(i.payload, { maxBytes: 1n << 20n, maxItems: 64n }));
    expect(directories.every(d => d.length === 1 && Buffer.from(d[0]!.name).equals(Buffer.from(backing)))).toBe(true);
    // Admitted after the last commitment: not served until committed.
    const next = await j.package();
    expect(next.package).toEqual(served.package);
  });

  it("returns original replies to exact retries and refuses a reused identifier", async () => {
    const { j } = await opened();
    const first = await j.submit(issue());
    expect(await j.submit(issue())).toEqual(first);
    // The same statement with another proof keeps its original receipt and evidence (§7.2).
    const other = encodeRecord(authorizeIssue(record(issueTask(context, funded), 1), issuerSecret));
    expect(await j.submit(other)).toEqual(first);
    expect(await j.open("genesis", signed)).toEqual(await j.open("genesis", signed));
    const c = await j.commit("c2");
    expect(await j.commit("c2")).toEqual(c);
    expect(await refusal(j.open("c2", signed))).toEqual(["CONFLICT", undefined]);
    expect(await refusal(j.open("second", signed))).toEqual(["UNSUPPORTED", undefined]);
  });

  it("names each admission refusal and leaves the journal serving", async () => {
    const { j } = await opened();
    expect(await refusal(j.submit(Uint8Array.of(1, 2, 3)))).toEqual(["REFUSED", "MALFORMED"]);
    expect(await refusal(j.submit(issue(funded, b(99))))).toEqual(["REFUSED", "SIGNATURE"]);
    expect(await refusal(j.submit(encodeRecord(authorizeIssue(record(issueTask(context, funded), 9), issuerSecret))))).toEqual(["REFUSED", "PROOF"]);
    const elsewhere: SegmentContext = { domain, header: { ...header, sequence: 2n } };
    expect(await refusal(j.submit(encodeRecord(authorizeIssue(record(issueTask(elsewhere, funded)), issuerSecret))))).toEqual(["REFUSED", "CONTEXT"]);
    expect(await refusal(j.submit(payment()))).toEqual(["REFUSED", "ANCHOR"]);
    await j.submit(issue());
    await j.submit(payment());
    // The same input again, into other outputs.
    const again = [output(payerSeed, 60, 7n), output(payerSeed, 61, 1n), output(payerSeed, 62, 2n), output(payerSeed, 63, 0n)];
    expect(await refusal(j.submit(payment(again)))).toEqual(["REFUSED", "SPENT"]);
    // A demand must place its anchors even though its stand-in proof verifies.
    const demand = encodeRecord({ domain, kind: 4, publicInputs: [...issueTask(context, funded).publicInputs.slice(0, 7), 5n, 1n, 2n, 3n, 4n, 5n, 6n, 1n, 9n],
      proof: new Uint8Array(32).fill(4), authorization: new Uint8Array(), capsules: [] });
    expect(await refusal(j.submit(demand))).toEqual(["REFUSED", "ANCHOR"]);
    expect(decodeReceipt(await j.submit(burning())).position).toBe(3n);
  });

  it("refuses issuance once K's revocation is witnessed, and an unfinalized issuance tail", async () => {
    const { venue, j } = await opened();
    await j.submit(issue());
    await venue.publishRecord(3, issuer, encodeRevocation(signRevocation(issuerSecret)));
    // The issue is not in a checkpoint witnessed before the revocation.
    expect(await refusal(j.commit("c2"))).toEqual(["UNSUPPORTED", undefined]);
    const { venue: v2, j: j2 } = await opened();
    await j2.submit(issue()); await j2.commit("c2"); await j2.publish();
    await v2.publishRecord(3, issuer, encodeRevocation(signRevocation(issuerSecret)));
    v2.advance(v2.witnessedIndex() + lag);
    expect(await refusal(j2.submit(issue(output(payerSeed, 70, 3n))))).toEqual(["REFUSED", "REVOKED"]);
    await j2.submit(payment());
    // A commitment held after the revocation finalizes no issuance: the issue stays finalized by the one before it.
    await j2.commit("c3"); await j2.publish(); v2.advance(v2.witnessedIndex() + lag);
    expect(decodeReceipt(await j2.submit(burning())).position).toBe(3n);
    expect(await refusal(j2.submit(issue(output(payerSeed, 71, 3n))))).toEqual(["REFUSED", "REVOKED"]);
  });

  it("refuses service when the venue holds a commitment of this key the journal did not sign", async () => {
    const { venue, j } = await opened();
    await venue.publishRecord(1, operator, encodeCommitment(signCommitment(operatorSecret, 2n, b(5))));
    expect(await refusal(j.submit(issue()))).toEqual(["CONFLICT", undefined]);
    const fresh = journal(path(), venue);
    expect(await refusal(fresh.open("genesis", signed))).toEqual(["CONFLICT", undefined]);
  });

  it.each(["same index", "later index"])("refuses a hidden same-sequence twin at %s while retaining historical replies", async location => {
    // The journal's own opening is witnessed at the next index; a twin at that index is in the same window.
    const file = path(), venue = FixtureVenue.reference(label, lag), j = journal(file, venue);
    const own = await j.open("genesis", signed);
    const twin = signCommitment(operatorSecret, own.sequence, new Uint8Array(32).fill(255));
    // The larger root loses the same-index tie; only the raw range retains it.
    expect(Buffer.compare(encodeCommitment(own), encodeCommitment(twin))).toBe(-1);
    expect(isEquivocation(own, twin)).toBe(true);
    await j.publish();
    let receipt: Uint8Array | undefined;
    if (location === "later index") { receipt = await j.submit(issue()); venue.advance(venue.witnessedIndex() + 1n); }
    // A witnessed index is final (§13.2): the twin arrives at an index the journal has not read yet.
    venue.witness(1, operator, venue.witnessedIndex(), encodeCommitment(twin));
    expect(await refusal(j.submit(payment()))).toEqual(["CONFLICT", undefined]);
    expect(await refusal(j.commit("after-twin"))).toEqual(["CONFLICT", undefined]);
    expect(await j.open("genesis", signed)).toEqual(own);
    if (receipt !== undefined) expect(await j.submit(issue())).toEqual(receipt);
    expect(await j.publish()).toEqual(own);
    const saved = await j.package();
    expect(saved.selection.sequence).toBe(own.sequence);
    j.close();
    // The conflict is kept with the answer that showed it: a restarted journal refuses without reading that index again.
    let asked = 0;
    const restored = journal(file, asking(venue, () => { asked++; }));
    expect(await refusal(restored.submit(payment()))).toEqual(["CONFLICT", undefined]);
    expect(asked).toBe(0);
    venue.advance(venue.witnessedIndex() + lag);
    if (receipt !== undefined) expect(await restored.submit(issue())).toEqual(receipt);
    expect(await restored.package()).toEqual(saved);
    expect(await refusal(restored.submit(payment()))).toEqual(["CONFLICT", undefined]);
  });

  it("ignores exact reposts, invalid signatures and another key's records", async () => {
    const { venue, j } = await opened(), own = await j.open("genesis", signed);
    const forged = encodeCommitment(signCommitment(operatorSecret, own.sequence, b(255)));
    forged[135] = forged[135]! ^ 1;
    venue.advance(2n);
    for (const bytes of [encodeCommitment(own), forged, new Uint8Array(136),
      encodeCommitment(signCommitment(issuerSecret, own.sequence, b(255)))]) {
      venue.witness(1, operator, 2n, bytes);
    }
    expect(decodeReceipt(await j.submit(issue())).position).toBe(1n);
    expect((await j.commit("after-junk")).sequence).toBe(2n);
  });

  it("rechecks hidden conflicts after proof verification before signing a receipt", async () => {
    const venue = FixtureVenue.reference(label, lag);
    let duringProof = () => {};
    const j = new V3OperatorJournal(path(), { secret: operatorSecret, venue, reference,
      verifier: { verify: (...args) => { duringProof(); return verifier.verify(...args); } } });
    journals.push(j);
    const own = await j.open("genesis", signed); await j.publish();
    // A witnessed index is final (§13.2), so a record witnessed during the proof check moves the venue's clock:
    // the command is judged by a view the venue has left, and the next one reads the conflict.
    duringProof = () => {
      duringProof = () => {};
      venue.advance(venue.witnessedIndex() + 1n);
      venue.witness(1, operator, venue.witnessedIndex(), encodeCommitment(signCommitment(operatorSecret, own.sequence, b(255))));
    };
    expect(await refusal(j.submit(issue()))).toEqual(["STALE", undefined]);
    expect(await refusal(j.submit(issue()))).toEqual(["CONFLICT", undefined]);
    expect((await j.package()).selection.sequence).toBe(1n);
  });

  it("refuses a command whose view the venue's clock has left, and admits it on the next view", async () => {
    const venue = FixtureVenue.reference(label, lag);
    let duringProof = () => {};
    const j = new V3OperatorJournal(path(), { secret: operatorSecret, venue, reference,
      verifier: { verify: (...args) => { duringProof(); return verifier.verify(...args); } } });
    journals.push(j);
    await j.open("genesis", signed); await j.publish();
    // Nothing was witnessed: the clock alone moved while the proof was checked.
    duringProof = () => { duringProof = () => {}; venue.advance(venue.witnessedIndex() + 1n); };
    expect(await refusal(j.submit(issue()))).toEqual(["STALE", undefined]);
    expect(decodeReceipt(await j.submit(issue())).position).toBe(1n);
  });

  it("keeps the answers and the conflict that a refused command read", async () => {
    const { venue, j, file } = await opened();
    venue.advance(venue.witnessedIndex() + 1n);
    venue.witness(1, operator, venue.witnessedIndex(), encodeCommitment(signCommitment(operatorSecret, 9n, b(5))));
    // The scope change is refused for its own reason, after it read the window that shows the conflict.
    expect(await refusal(j.rescope("outside", { keep: [b(77)] }))).toEqual(["REFUSED", "SCOPE"]);
    j.close();
    let asked = 0;
    const restored = journal(file, asking(venue, request => { if (request.kind === 1) asked++; }));
    expect(await refusal(restored.commit("c2"))).toEqual(["CONFLICT", undefined]);
    expect(asked).toBe(0);
    // A restart on a venue behind the index the kept answers reach is refused.
    restored.close();
    expect(await refusal((async () => journal(file, FixtureVenue.reference(label, lag, venue.witnessedIndex() - 1n)))())).toEqual(["UNAVAILABLE", undefined]);
  });

  it("refuses terms for another operator, venue or configuration and accepts silence terms", async () => {
    const venue = FixtureVenue.reference(label, lag), j = journal(path(), venue);
    expect(await refusal(j.open("a", signedTerms(termsFields({ operator: issuer }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("b", signedTerms(termsFields({ venue: b(7) }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("c", signedTerms(termsFields({ configuration: b(7) }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("d", signedTerms(termsFields(), b(98))))).toEqual(["REFUSED", undefined]);
    expect((await j.open("e", signedTerms(termsFields({ silence: { noCommitmentDuration: 5n, challengeWindow: 5n } })))).sequence).toBe(1n);
  });

  it("admits, signs and serves past the retired 1 MiB served-package ceiling, from rows", async () => {
    const { j, venue } = await opened();
    // Stand-in proofs at the §5 maximum: twelve records are about 1.5 MiB of trail.
    const large = (n: number): Uint8Array => {
      const r = record(issueTask(context, output(payerSeed, 100 + n, 1n)));
      return encodeRecord(authorizeIssue({ ...r, proof: new Uint8Array(131040).fill(1) }, issuerSecret));
    };
    for (let n = 0; n < 12; n++) expect(decodeReceipt(await j.submit(large(n))).position).toBe(BigInt(n + 1));
    await j.commit("c2"); await j.publish();
    const served = await j.package();
    expect(served.package.length).toBeGreaterThan(1_048_576);
    const result = await readPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      { verifier, venue, reference });
    expect(result.state?.position).toBe(12n);
    expect(result.state?.issued).toBe(12n);
  });

  it("signs and serves many checkpoints: no total over them bounds the journal", async () => {
    const { j, venue } = await opened();
    for (let sequence = 2; sequence <= 40; sequence++) {
      expect((await j.commit(`empty-${sequence}`)).sequence).toBe(BigInt(sequence));
      await j.publish();
    }
    await j.submit(issue());
    expect((await j.commit("after")).sequence).toBe(41n);
    await j.publish();
    const served = await j.package();
    expect(served.selection.sequence).toBe(41n);
    const result = await readPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      { verifier, venue, reference });
    expect(result.carrying?.length).toBe(41);
    expect(result.state?.position).toBe(1n);
  }, 90_000);

  it("keeps its venue answers: asks only past the index they are kept through, by windows within the answer budget", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path(), answered: RangeRequest[] = [];
    // A venue whose answers span at most four indices: a longer range is past the asker's budget (§13.1).
    const narrow: RecordVenue & RecordPublisher = { ...asking(venue, () => {}), range: (request, limits) => {
      if (request.toIndex - request.fromIndex >= 4n) throw new RangeLimitError("past the budget");
      answered.push(request); return venue.range(request, limits);
    } };
    let j = journal(file, narrow);
    const verify = vi.spyOn(ed25519, "verify"), signatures = [(await j.open("genesis", signed)).signature];
    try {
      await j.publish();
      for (let sequence = 2; sequence <= 6; sequence++) {
        venue.advance(venue.witnessedIndex() + 9n);
        await j.submit(issue(output(payerSeed, 100 + sequence, 1n)));
        const checkpoint = await j.commit(`c${sequence}`); await j.publish();
        expect(checkpoint.sequence).toBe(BigInt(sequence)); signatures.push(checkpoint.signature);
      }
      expect((await j.package()).selection.sequence).toBe(6n);
      // Each held commitment was verified once, in the window that first carried it.
      for (const signature of signatures) expect(verify.mock.calls.filter(call => Buffer.from(call[0] as Uint8Array).equals(signature))).toHaveLength(1);
    } finally { verify.mockRestore(); }
    // Each kind and subject was asked once for every index, in adjacent windows from index zero to the clock.
    const asked = new Map<string, bigint>();
    for (const request of answered) {
      const key = `${request.kind}:${bytesToHex(request.subject)}`;
      expect(request.fromIndex, key).toBe((asked.get(key) ?? -1n) + 1n);
      asked.set(key, request.toIndex);
    }
    expect([...asked].sort()).toEqual([[`1:${bytesToHex(operator)}`, venue.witnessedIndex()], [`2:${bytesToHex(backing)}`, venue.witnessedIndex()],
      [`3:${bytesToHex(issuer)}`, venue.witnessedIndex()]].sort());
    // While the clock stands, a command asks the venue nothing; nor does a restarted journal, which reads its rows.
    answered.length = 0;
    const served = await j.package();
    j.close(); j = journal(file, narrow);
    expect(await j.package()).toEqual(served);
    expect(answered).toEqual([]);
    // The audit reads the venue again from its first index, in windows of its own, and finds the same answers.
    await j.audit();
    expect(answered.some(request => request.kind === 1 && request.fromIndex === 0n)).toBe(true);
    const result = await readPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      { verifier, venue, reference });
    expect([result.carrying?.length, result.state?.issued]).toEqual([6, 5n]);
  });

  it("serves on a venue holding more records under its key than one answer's budget", async () => {
    // Anyone may file records under the key (C2.3.1); before kept windows, one whole answer past 4,096 entries ended service.
    const venue = FixtureVenue.reference(label, lag, 4200n);
    for (let index = 1n; index <= 4200n; index++) venue.witness(1, operator, index, new Uint8Array(136));
    const j = journal(path(), venue);
    await j.open("genesis", signed); await j.publish();
    await j.submit(issue()); await j.commit("c2"); await j.publish();
    expect((await j.package()).selection.sequence).toBe(2n);
    await j.audit();
  }, 60_000);

  it("audits its kept venue answers against the venue", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    for (const tamper of [
      "DELETE FROM answer_held WHERE seq = (SELECT MIN(seq) FROM answer_held)",
      "UPDATE answer_held SET idx = zeroblob(8) WHERE seq = (SELECT MAX(seq) FROM answer_held)",
      "UPDATE answer SET value = zeroblob(8) WHERE kind = 3",
      "UPDATE answer SET through = x'00000000000000ff' WHERE kind = 1",
      "UPDATE answer SET through = x'00000000000000ff' WHERE kind = 2",
      "INSERT INTO journal_conflict VALUES(1,'1',zeroblob(136))",
    ]) {
      const { file, venue, j } = await opened();
      await j.submit(issue()); await j.commit("c2"); await j.publish(); await j.package(); j.close();
      const db = new DatabaseSync(file);
      expect(Number(db.prepare(tamper).run().changes), tamper).toBeGreaterThan(0); db.close();
      const reopened = journal(file, venue);
      expect(await refusal(reopened.audit()), tamper).toEqual(["STORAGE", undefined]);
    }
    // A conflict the venue shows and the rows have lost or changed is found by the audit too, segment or none.
    for (const [tamper, open] of [["DELETE FROM journal_conflict", true], ["UPDATE journal_conflict SET idx = '0'", true],
      ["DELETE FROM journal_conflict", false]] as const) {
      const file = path(), venue = FixtureVenue.reference(label, lag), j = journal(file, venue);
      if (open) { await j.open("genesis", signed); await j.publish(); }
      venue.advance(venue.witnessedIndex() + 1n);
      venue.witness(1, operator, venue.witnessedIndex(), encodeCommitment(signCommitment(operatorSecret, 9n, b(5))));
      expect(await refusal(open ? j.commit("c2") : j.open("genesis", signed))).toEqual(["CONFLICT", undefined]);
      // With no segment there is nothing else to read, and the honest rows pass. (A foreign held commitment's
      // directory is not the journal's to serve, so an open journal's own read stays unresolved.)
      if (!open) await j.audit();
      j.close();
      const db = new DatabaseSync(file);
      expect(Number(db.prepare(tamper).run().changes)).toBe(1); db.close();
      expect(await refusal(journal(file, venue).audit()), tamper).toEqual(["STORAGE", undefined]);
    }
  });

  it("serves only published commitments and the records they carry", async () => {
    const { j } = await opened();
    await j.submit(issue()); await j.commit("c2");
    // The second commitment is still in the outbox: the opening is served, with no records.
    const before = await j.package();
    expect(before.selection.sequence).toBe(1n);
    await j.publish();
    expect((await j.package()).selection.sequence).toBe(2n);
    // Held on the venue though the journal never recorded its publication, as after a lost reply: served.
    const { venue, j: k } = await opened();
    await k.submit(issue());
    await venue.publishRecord(1, operator, encodeCommitment(await k.commit("c2")));
    expect((await k.package()).selection.sequence).toBe(2n);
  });

  it("fences an older handle and reopens from its rows without verifying a proof", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path();
    let verified = 0;
    const counting = { verify: (...args: Parameters<typeof verifier.verify>) => { verified++; return verifier.verify(...args); } };
    const open = (): Journal => { const j = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference, verifier: counting }); journals.push(j); return j; };
    const j = open();
    await j.open("genesis", signed); await j.publish();
    const receipts = [await j.submit(issue()), await j.submit(payment())];
    const checkpoint = await j.commit("c2"); await j.publish();
    const served = await j.package();
    expect(verified).toBe(2);
    const second = open();
    expect(await refusal(j.submit(burning()))).toEqual(["FENCED", undefined]);
    // The same replies and the same served bytes, read from rows.
    expect(await second.package()).toEqual(served);
    expect(await second.commit("c2")).toEqual(checkpoint);
    expect([await second.submit(issue()), await second.submit(payment())]).toEqual(receipts);
    expect(verified).toBe(2);
    // Only the audit verifies again, reading the served evidence from its seed; it does not pass over a proof that fails.
    await second.audit();
    expect(verified).toBe(4);
    const rejecting = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference, verifier: { verify: () => false } });
    expect((await rejecting.package()).package).toEqual(served.package);
    expect(await refusal(rejecting.audit())).toEqual(["STORAGE", "PROOF"]);
    rejecting.close();
    const third = open();
    expect(await refusal(second.submit(burning()))).toEqual(["FENCED", undefined]);
    // A restarted journal waits the lag before it signs or admits again (C2.8.2).
    expect(await refusal(third.submit(burning()))).toEqual(["SCHEDULE", undefined]);
    venue.advance(venue.witnessedIndex() + lag);
    expect(decodeReceipt(await third.submit(burning())).position).toBe(3n);
    expect(verified).toBe(5);
    expect(decodeReceipt(await third.submit(issue())).position).toBe(1n);
  });

  it("requires a persistent path and refuses stored rows that do not reproduce", async () => {
    const venue = FixtureVenue.reference(label, lag);
    for (const file of [":memory:", "file:journal.db", " "]) expect(await refusal((async () => journal(file, venue))())).toEqual(["STORAGE", undefined]);
    const { DatabaseSync } = await import("node:sqlite");
    const tampered = async (tamper: string) => {
      const { file, venue: v, j } = await opened();
      await j.submit(issue()); await j.commit("c2"); await j.publish(); await j.submit(payment()); j.close();
      const db = new DatabaseSync(file);
      expect(Number(db.prepare(tamper).run().changes), tamper).toBeGreaterThan(0); db.close();
      return journal(file, v);
    };
    // A truncated log, an admission state that is not the signed snapshot's or its own tip's, a lost directory,
    // a trail that stops short of the state, and a signed row that is not this key's commitment.
    for (const tamper of [
      "DELETE FROM events WHERE seq = (SELECT MAX(seq) FROM events)",
      "UPDATE event SET history = zeroblob(32) WHERE position = 1",
      "UPDATE total SET issued = '11'",
      "UPDATE namespace SET history = zeroblob(32)",
      "UPDATE namespace SET leaves = leaves + 1",
      "UPDATE spent SET hash = zeroblob(32)",
      "DELETE FROM object WHERE kind = 3",
      "DELETE FROM chain WHERE position = 2",
      "UPDATE journal_signed SET commitment = zeroblob(136) WHERE sequence = 2",
      "UPDATE journal_state SET ns = ns + 1",
      "DELETE FROM journal_state",
      // A lost signed row would let the next commitment reuse its sequence; so would a rewritten reply.
      "DELETE FROM journal_signed WHERE sequence = (SELECT MAX(sequence) FROM journal_signed)",
      "DELETE FROM journal_signed WHERE sequence = 1",
      "UPDATE events SET response = (SELECT response FROM events WHERE seq = 1) WHERE request = 'commit'",
    ]) expect(await refusal((async () => (await tampered(tamper)).package())()), tamper).toEqual(["STORAGE", undefined]);
    // What reopening does not read, the audit does: a record, a receipt, an earlier reply or publication, a fact row.
    for (const tamper of [
      "UPDATE chain SET bytes = zeroblob(length(bytes)) WHERE position = 1",
      "UPDATE journal_receipt SET receipt = zeroblob(length(receipt))",
      "DELETE FROM journal_receipt",
      "UPDATE events SET response = (SELECT response FROM events WHERE request = 'commit') WHERE seq = 1",
      "UPDATE journal_signed SET published = 0 WHERE sequence = 1",
      "DELETE FROM anchor WHERE position = 1",
      "DELETE FROM output WHERE position = 1",
    ]) {
      const j = await tampered(tamper);
      const error = await j.audit().then(() => undefined, (e: unknown) => e);
      expect(error, tamper).toBeInstanceOf(V3StoreError);
    }
    await (await tampered("UPDATE identity SET observed = observed")).audit();
  });

  it("verifies each record of its own history once across its reads", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path();
    let verified = 0;
    // A verifier that declares the configuration's circuits names the kept context across reads and processes (§14).
    const declared = { identities: configuration.circuits, verify: (...args: Parameters<typeof verifier.verify>) => { verified++; return verifier.verify(...args); } };
    const open = (): Journal => { const j = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference, verifier: declared }); journals.push(j); return j; };
    // A silence clause makes every admission read the journal's own canonical checkpoint first.
    const silent = signedTerms(termsFields({ silence: { noCommitmentDuration: 50n, challengeWindow: 5n } })), name = rootTermsName(silent.terms);
    const own: SegmentContext = { domain, header: { ...header, entries: [{ backing: name, link: name }] } };
    const issued = (n: number): Uint8Array =>
      encodeRecord(authorizeIssue(record(issueTask(own, prepareExactOutput(payerSeed, domain, b(100 + n), name, 1n))), issuerSecret));
    let j = open();
    await j.open("genesis", silent); await j.publish();
    await j.submit(issued(0)); await j.submit(issued(1)); await j.commit("c2"); await j.publish();
    expect(verified).toBe(2);
    // The next admission's read replays the two committed records once; the one after it replays nothing again.
    await j.submit(issued(2)); expect(verified).toBe(5);
    await j.submit(issued(3)); expect(verified).toBe(6);
    await j.commit("c3"); await j.publish();
    await j.submit(issued(4)); expect(verified).toBe(9);
    j.close(); j = open();
    venue.advance(venue.witnessedIndex() + lag);
    // Another process with the same declared verifier resumes the kept classes and replays.
    await j.submit(issued(5)); expect(verified).toBe(10);
  });

  it("holds no transaction on its database while it reads its own history", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path();
    let during = () => {};
    const hooked = { verify: (...args: Parameters<typeof verifier.verify>) => { during(); return verifier.verify(...args); } };
    const j = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference, verifier: hooked }); journals.push(j);
    const silent = signedTerms(termsFields({ silence: { noCommitmentDuration: 50n, challengeWindow: 5n } })), name = rootTermsName(silent.terms);
    const own: SegmentContext = { domain, header: { ...header, entries: [{ backing: name, link: name }] } };
    const issued = (n: number): Uint8Array =>
      encodeRecord(authorizeIssue(record(issueTask(own, prepareExactOutput(payerSeed, domain, b(100 + n), name, 1n))), issuerSecret));
    await j.open("genesis", silent); await j.publish();
    await j.submit(issued(0)); await j.commit("c2"); await j.publish();
    // The publication outbox writes through the journal's connection while a read verifies (an Ergo venue's
    // sync settles it at any time): the read must not hold that connection.
    const persistence = j.publisherPersistence(); persistence.load();
    let calls = 0;
    during = () => { calls++; persistence.guard(); persistence.save(`outbox-${calls}`); };
    expect(decodeReceipt(await j.submit(issued(1))).position).toBe(2n);
    expect(calls).toBeGreaterThan(1);
    // A new owner opens at once during a read; the replaced owner then signs nothing.
    let next: Journal | undefined;
    during = () => { next ??= journal(file, venue); };
    expect(await refusal(j.submit(issued(2)))).toEqual(["FENCED", undefined]);
    venue.advance(venue.witnessedIndex() + lag);
    expect(decodeReceipt(await next!.submit(issued(2))).position).toBe(3n);
  });

  it("answers BUSY while a replaced owner still reads the kept file, and reads once it has finished", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path();
    let during: () => Promise<void> = async () => {};
    const declared = { identities: configuration.circuits,
      verify: async (...args: Parameters<typeof verifier.verify>) => { await during(); return verifier.verify(...args); } };
    const open = (): Journal => { const j = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference, verifier: declared }); journals.push(j); return j; };
    const silent = signedTerms(termsFields({ silence: { noCommitmentDuration: 50n, challengeWindow: 5n } })), name = rootTermsName(silent.terms);
    const own: SegmentContext = { domain, header: { ...header, entries: [{ backing: name, link: name }] } };
    const issued = (n: number): Uint8Array =>
      encodeRecord(authorizeIssue(record(issueTask(own, prepareExactOutput(payerSeed, domain, b(100 + n), name, 1n))), issuerSecret));
    const a = open();
    await a.open("genesis", silent); await a.publish();
    await a.submit(issued(0)); await a.commit("c2"); await a.publish();
    let next: Journal | undefined, first: [string, string | undefined] | undefined;
    during = async () => {
      if (next !== undefined) return;
      next = open(); venue.advance(venue.witnessedIndex() + lag);
      first = await refusal(next.submit(issued(1)));
    };
    expect(await refusal(a.submit(issued(1)))).toEqual(["FENCED", undefined]);
    expect(first).toEqual(["BUSY", undefined]);
    expect(decodeReceipt(await next!.submit(issued(1))).position).toBe(2n);
  });

  it("reopens between a return opening and its adoption, still pending", async () => {
    const venue = FixtureVenue.reference(label, lag), file = path();
    const silent = signedTerms(termsFields({ silence: { noCommitmentDuration: 4n, challengeWindow: 5n } })), name = rootTermsName(silent.terms);
    const own: SegmentContext = { domain, header: { ...header, entries: [{ backing: name, link: name }] } };
    const spendable = prepareExactOutput(payerSeed, domain, b(100), name, 10n);
    let j = journal(file, venue);
    await j.open("genesis", silent); await j.publish();
    await j.submit(encodeRecord(authorizeIssue(record(issueTask(own, spendable)), issuerSecret))); const checkpoint = await j.commit("c2"); await j.publish();
    venue.advance(venue.witnessedIndex() + 6n);
    const opening = await j.return("returned");
    j.close(); j = journal(file, venue);
    // The rows say a return is pending: no service, the same reply, and adoption once it is witnessed.
    expect(await j.return("returned")).toEqual(opening);
    expect(await refusal(j.commit("early"))).toEqual(["STALE", undefined]);
    await j.publish();
    j.close(); j = journal(file, venue);
    venue.advance(venue.witnessedIndex() + lag);
    expect(await j.adopt()).toEqual([]);
    expect(await j.adopt()).toEqual([]);
    await j.audit();
    // The returned segment imports the note issued before it, copied into the journal's database with its
    // opening: the note's old root is an anchor there, and its spend is admitted once.
    const returned: SegmentContext = { domain, header: { ...own.header, sequence: opening.sequence,
      entries: [{ backing: name, link: name, opening: { operator, sequence: 2n, root: checkpoint.root } }] } };
    const tree = new NoteTree(); tree.append(spendable.cm);
    const input = { note: spendable, anchor: tree.root(), path: tree.path(0n) };
    const out = (id: number, value: bigint) => prepareExactOutput(receiverSeed, domain, b(id), name, value);
    const spend = (first: number) => encodeRecord(record(spendTask(returned, [input, { ...input, note: prepareExactOutput(payerSeed, domain, b(101), name, 0n) }],
      [out(first, 10n), out(first + 1, 0n), out(first + 2, 0n), out(first + 3, 0n)])));
    expect(decodeReceipt(await j.submit(spend(110))).position).toBe(1n);
    expect(await refusal(j.submit(spend(120)))).toEqual(["REFUSED", "SPENT"]);
    j.close(); j = journal(file, venue);
    expect(await refusal(j.submit(spend(120)))).toEqual(["SCHEDULE", undefined]);
  });

  it("answers a concurrent operation BUSY and hands the caller owned package bytes", async () => {
    const { j } = await opened();
    const first = j.submit(issue());
    expect(await refusal(j.submit(payment()))).toEqual(["BUSY", undefined]);
    await first; await j.commit("c2"); await j.publish();
    const served = await j.package(), copy = structuredClone(served);
    served.package.fill(0); served.selection.root.fill(0); served.selection.backing.fill(0);
    expect(await j.package()).toEqual(copy);
  });

  it("refuses a genesis opening where this key already has commitments on the venue", async () => {
    // Another journal of the same key has published its opening there.
    const { venue } = await opened();
    const fresh = journal(path(), venue);
    await expect(fresh.open("genesis", signed)).rejects.toThrow(/a commitment this journal did not sign/);
    expect(await refusal(fresh.open("genesis", signed))).toEqual(["CONFLICT", undefined]);
  });

  /** The journal behind its HTTP service, a client of it, and each evidence request with the bytes it was answered by. */
  async function service(j: Journal) {
    const tokens = { walletToken: "11".repeat(32), adminToken: "22".repeat(32) }, requests: { url: string; bytes: number }[] = [];
    const server = createV3Service(j, tokens); servers.push(server);
    server.prependListener("request", (request, response) => {
      const entry = { url: request.url ?? "", bytes: 0 }, write = response.write.bind(response) as (...args: unknown[]) => boolean;
      requests.push(entry);
      response.write = ((chunk: Uint8Array, ...rest: unknown[]) => { entry.bytes += chunk.length; return write(chunk, ...rest); }) as typeof response.write;
    });
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", done); });
    const client = new V3ServiceClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, tokens.walletToken, { domain, operator, reference });
    return { client, requests };
  }
  const kinds = (parts: Iterable<EvidencePart>): string[] => [...parts].map(part => "package" in part ?
    `package:${decodeEvidencePackage(part.package).map(item => item.kind).join("")}` : `trail:${part.trail.after?.position ?? "whole"}`);

  it("serves a reader's later sync only what is new, over HTTP, and its reads equal a read of the whole package", async () => {
    const { j, venue } = await opened(), { client, requests } = await service(j);
    const evidence = new EvidenceStore(), source = concatBytes(domain, venueId, operator), records = [issue(), payment(), burning()];
    const read = async (served: ServedPackage, kept?: EvidenceStore) => (await readPackage(served.package,
      { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
      { verifier, venue, reference, ...(kept === undefined ? {} : { evidence: kept }) })).state!;
    const framed = (record: Uint8Array): number => 4 + record.length;
    const head = encodeTrail({ header: segmentBytes(header), terms: [signed], records: [] }).length;

    await j.submit(records[0]!); await j.commit("c2"); await j.publish();
    const first = await client.sync(backing, evidence);
    expect([first.selection.sequence, evidence.suppliedThrough(source)]).toEqual([2n, 2n]);
    // The read's own package carries only the configuration and the selected commitment; the rest is kept evidence.
    expect(decodeEvidencePackage(first.package).map(item => item.kind)).toEqual([1, 2]);
    expect((await read(first, evidence)).position).toBe(1n);
    expect(requests.map(r => r.url)).toEqual([`/evidence?backing=${bytesToHex(backing)}&after=0`]);

    await j.submit(records[1]!); await j.submit(records[2]!); await j.commit("c3"); await j.publish();
    // After sequence 2 the journal serves the new checkpoint's directory and snapshot, and the trail's head
    // with the records after position 1: nothing a reader served through 2 holds.
    const parts = [...(await j.serve(backing, 2n)).parts];
    expect(kinds(parts)).toEqual(["package:34", "trail:1"]);
    const trail = parts[1] as Extract<EvidencePart, { trail: unknown }>, sent = Buffer.concat([...trail.trail.chunks as Iterable<Uint8Array>]);
    expect(sent.length).toBe(head + framed(records[1]!) + framed(records[2]!));
    expect([sent.includes(Buffer.from(records[0]!)), sent.includes(Buffer.from(records[1]!)), sent.includes(Buffer.from(records[2]!))]).toEqual([false, true, true]);
    const second = await client.sync(backing, evidence);
    expect([second.selection.sequence, evidence.suppliedThrough(source), requests.at(-1)!.url]).toEqual([3n, 3n, `/evidence?backing=${bytesToHex(backing)}&after=2`]);
    // The response is the frame, the read's own package, one small package part and that trail part.
    expect(requests.at(-1)!.bytes).toBeLessThan(sent.length + 1200);
    const whole = await j.package(backing), incremental = await read(second, evidence), complete = await read(whole);
    expect([incremental.position, incremental.history, incremental.evidence, incremental.issued, incremental.burned])
      .toEqual([3n, complete.history, complete.evidence, 10n, 5n]);
    // The whole package over HTTP is the journal's, from the same parts served from nothing.
    expect(await client.package(backing)).toEqual(whole);

    // Nothing new: the selection and the read's own package only. A sequence past the selection serves nothing either.
    expect([kinds((await j.serve(backing, 3n)).parts), kinds((await j.serve(backing, 99n)).parts)]).toEqual([[], []]);
    const third = await client.sync(backing, evidence);
    expect(third).toEqual(second);
    expect(requests.at(-1)!.bytes).toBe(20 + 172 + second.package.length + 1);
    // Checkpoints without records add their objects and no trail.
    await j.commit("c4"); await j.publish();
    expect(kinds((await j.serve(backing, 3n)).parts)).toEqual(["package:34"]);
    expect((await read(await client.sync(backing, evidence), evidence)).position).toBe(3n);

    // A store that lacks what its recorded sequence implies is served again from nothing, once.
    const lost = new EvidenceStore(); lost.supplied(source, 3n);
    const before = requests.length, again = await client.sync(backing, lost);
    expect(requests.slice(before).map(r => r.url.split("&")[1])).toEqual(["after=3"]);
    await expect(read(again, lost)).rejects.toMatchObject({ status: "unresolved-evidence" });
    const two = new EvidenceStore(); two.supplied(source, 2n);
    const from = requests.length, refetched = await client.sync(backing, two);
    expect(requests.slice(from).map(r => r.url.split("&")[1])).toEqual(["after=2", "after=0"]);
    expect([(await read(refetched, two)).position, two.suppliedThrough(source)]).toEqual([3n, 4n]);
    // `full` asks from nothing outright, which resupplies every object.
    const all = requests.length;
    expect((await read(await client.sync(backing, lost, { full: true }), lost)).position).toBe(3n);
    expect(requests.slice(all).map(r => r.url.split("&")[1])).toEqual(["after=0"]);
    // One response past the caller's budget is refused, and the recorded sequence stays.
    const bounded = new EvidenceStore();
    await expect(client.sync(backing, bounded, { maxBytes: 1000n })).rejects.toThrow("served evidence exceeds the reader's budget");
    expect(bounded.suppliedThrough(source)).toBe(0n);
    await expect(j.serve(backing, -1n)).rejects.toMatchObject({ code: "REFUSED", check: "SEQUENCE" });
    for (const store of [evidence, lost, two, bounded]) store.close();
  });

  it("serves its parts while other commands run, from rows a command never changes", async () => {
    const { j } = await opened();
    await j.submit(issue()); await j.commit("c2"); await j.publish();
    const served = await j.serve(), parts = served.parts[Symbol.iterator]();
    // Between two parts: an admission, a commitment and its publication.
    const taken: EvidencePart[] = [parts.next().value as EvidencePart];
    await j.submit(payment()); await j.commit("c3"); await j.publish();
    for (let next = parts.next(); next.done !== true; next = parts.next()) taken.push(next.value);
    // The parts are the selection's: what was admitted and signed meanwhile is not among them.
    expect(kinds(taken)).toEqual(["package:3344", "trail:whole"]);
    const evidence = new EvidenceStore();
    expect(await evidence.take(taken)).toBe(true);
    expect(evidence.retained().trail(segmentIdentity(header), decodeSnapshot(decodeEvidencePackage((taken[0] as { package: Uint8Array }).package)
      .filter(item => item.kind === 4).map(item => item.payload).find(payload => decodeSnapshot(payload).issued === 10n)!).evidenceHash)?.length).toBe(1n);
    expect((await j.package()).selection.sequence).toBe(3n);
    evidence.close();
  });
});
