import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { ERGO_SYNTHETIC_REFERENCE } from "../src/ergo-profile.js";
import { Chain } from "../src/ergo-synthetic.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { decodeReceipt, decodeSnapshot, verifyReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { CandidateVenueError, referenceVenue, requireReferenceVenue, type VenueReference } from "../src/pool/v3/guard.js";
import { segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidenceDirectory, decodeEvidencePackage } from "../src/pool/v3/package.js";
import { TRAIL_LIMITS } from "../src/pool/v3/reader.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal, V3StoreError as StoreError } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage, type RootTerms } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeIssue, burnTask, issueTask, spendTask, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { ScopeTree } from "../src/pool/scope.js";
import { FixtureVenue, LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { encodeCommitment, encodeRevocation, signCommitment, signRevocation } from "../src/venue-records.js";

// The pool-v3 operator journal (src/pool/v3/store.ts) on the local reference
// venue, over records built by witness.ts with proofs a test verifier judges.
// Real proofs, the served package's independent replay and seed restoration
// run in the acceptance script (scripts/pool/v3/store-check.mjs).

const supported = Number(process.versions.node.split(".")[0]) >= 24;
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const HELPER = hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8");
const configuration: CandidateConfiguration = {
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"],
  helper: HELPER,
};
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
    expect(refused(reference, new FixtureVenue(b(12), 0n, lag))).toThrow(CandidateVenueError);
    expect(refused({ ...reference, label: b(13) }, venue)).toThrow(CandidateVenueError);
    expect(refused({ ...reference, lag: 3n }, venue)).toThrow(CandidateVenueError);
    expect(refused(reference, { id: venue.id, lag: () => 3n })).toThrow(CandidateVenueError);
    // Contexts outside the closed set, and malformed preimages.
    expect(refused({ context: "moe/venue/ergo/v3" } as unknown as VenueReference, venue)).toThrow(CandidateVenueError);
    expect(refused({ ...reference, label: b(1).subarray(1) }, venue)).toThrow(CandidateVenueError);
    expect(refused(null as unknown as VenueReference, venue)).toThrow(CandidateVenueError);
  });
  it("recomputes the synthetic chain's identity and refuses every deployment profile", () => {
    const profile = new Chain().profile(1n), synthetic = referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile });
    expect(synthetic.lag).toBe(2n);
    expect(requireReferenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile }, { id: synthetic.id, lag: () => 2n })).toEqual(synthetic.id);
    // The same anchor, depth and locations under venue-ergo's own context: the mainnet profile.
    const { reference: _, ...mainnet } = profile;
    expect(() => referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile: mainnet })).toThrow(CandidateVenueError);
    // A context that reads as synthetic once and as venue-ergo's afterwards is hashed as it was checked.
    let reads = 0;
    const shifting = { ...mainnet, get reference() { return reads++ === 0 ? ERGO_SYNTHETIC_REFERENCE : undefined; } };
    const shifted = referenceVenue({ context: ERGO_SYNTHETIC_REFERENCE, profile: shifting as typeof profile });
    expect(shifted.id).toEqual(synthetic.id);
  });
});

describe("a local venue's publishing side", () => {
  it("witnesses each new record at the next index and an exact repeat nowhere", async () => {
    const venue = FixtureVenue.reference(label, lag, 4n), record = encodeRevocation(signRevocation(issuerSecret));
    await venue.publishRecord(3, issuer, record);
    await venue.publishRecord(3, issuer, record);
    expect(venue.witnessedIndex()).toBe(5n);
    expect(venue.export().records.map(r => r.index)).toEqual([5n]);
    await expect(venue.publishRecord(3, b(1).subarray(1), record)).rejects.toThrow(TypeError);
  });
});

describe.skipIf(!supported)("the v3 operator journal (Node 24)", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let V3StoreError: typeof import("../src/pool/v3/store.js").V3StoreError;
  const journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => { ({ V3OperatorJournal, V3StoreError } = await import("../src/pool/v3/store.js")); });
  afterEach(() => {
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
  function journal(file: string, venue: FixtureVenue, secret = operatorSecret): Journal {
    const j = new V3OperatorJournal(file, { configuration, secret, venue, reference, verifier }); journals.push(j); return j;
  }
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

  it("refuses a venue the guard does not recompute before touching the path", () => {
    expect(() => new V3OperatorJournal(path(), { configuration, secret: operatorSecret, venue: new FixtureVenue(venueId, 0n, 3n), reference, verifier }))
      .toThrow(CandidateVenueError);
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
    const trail = decodeTrail(items.find(i => i.kind === 6)!.payload, TRAIL_LIMITS);
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
    // A demand (kind 4): recovery kinds are admitted in slice 3.
    const demand = encodeRecord({ domain, kind: 4, publicInputs: [...issueTask(context, funded).publicInputs.slice(0, 7), 5n, 1n, 2n, 3n, 4n, 5n, 6n, 1n, 9n],
      proof: new Uint8Array(32).fill(4), authorization: new Uint8Array(), capsules: [] });
    expect(await refusal(j.submit(demand))).toEqual(["UNSUPPORTED", undefined]);
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
  });

  it("refuses service when the venue holds a commitment of this key the journal did not sign", async () => {
    const { venue, j } = await opened();
    await venue.publishRecord(1, operator, encodeCommitment(signCommitment(operatorSecret, 2n, b(5))));
    expect(await refusal(j.submit(issue()))).toEqual(["CONFLICT", undefined]);
    const fresh = journal(path(), venue);
    expect(await refusal(fresh.open("genesis", signed))).toEqual(["CONFLICT", undefined]);
  });

  it("refuses terms for another operator, venue or configuration and clauses it does not serve", async () => {
    const venue = FixtureVenue.reference(label, lag), j = journal(path(), venue);
    expect(await refusal(j.open("a", signedTerms(termsFields({ operator: issuer }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("b", signedTerms(termsFields({ venue: b(7) }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("c", signedTerms(termsFields({ configuration: b(7) }))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("d", signedTerms(termsFields(), b(98))))).toEqual(["REFUSED", undefined]);
    expect(await refusal(j.open("e", signedTerms(termsFields({ silence: { noCommitmentDuration: 5n, challengeWindow: 5n } }))))).toEqual(["UNSUPPORTED", undefined]);
  });

  it("admits and signs only what it can still serve within the reader's budget", async () => {
    const { j } = await opened();
    // Stand-in proofs at the §5 maximum: the trail passes the reader's 1 MiB budget within a few records.
    const large = (n: number): Uint8Array => {
      const r = record(issueTask(context, output(payerSeed, 100 + n, 1n)));
      return encodeRecord(authorizeIssue({ ...r, proof: new Uint8Array(131040).fill(1) }, issuerSecret));
    };
    let admitted = 0;
    for (;; admitted++) {
      const error = await j.submit(large(admitted)).then(() => undefined, (e: unknown) => e);
      if (error === undefined) continue;
      expect([(error as StoreError).code, (error as StoreError).check]).toEqual(["REFUSED", "RESOURCE"]);
      break;
    }
    expect(admitted).toBeGreaterThan(0);
    // The refusal changed nothing: the admitted records commit, publish and serve.
    await j.commit("c2"); await j.publish();
    const trail = decodeTrail(decodeEvidencePackage((await j.package()).package, { maxBytes: 1n << 21n, maxItems: 64n })
      .find(i => i.kind === 6)!.payload, { maxBytes: 1n << 21n, maxEvents: 1024n });
    expect(trail.records.length).toBe(admitted);
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

  it("fences an older handle and replays the journal on reopening", async () => {
    const { file, venue, j } = await opened();
    await j.submit(issue()); await j.submit(payment()); await j.commit("c2"); await j.publish();
    const served = await j.package();
    const second = journal(file, venue);
    expect(await refusal(j.submit(burning()))).toEqual(["FENCED", undefined]);
    expect(await second.package()).toEqual(served);
    // A restarted journal waits the lag before it signs or admits again (C2.8.2).
    expect(await refusal(second.submit(burning()))).toEqual(["SCHEDULE", undefined]);
    venue.advance(venue.witnessedIndex() + lag);
    expect(decodeReceipt(await second.submit(burning())).position).toBe(3n);
    expect(decodeReceipt(await second.submit(issue())).position).toBe(1n);
  });
});
