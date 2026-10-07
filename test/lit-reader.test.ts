import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareBytes } from "../src/bytes.js";
import { encodeReceipt, receiptBytes, snapshotBytes, snapshotDigest, type Snapshot } from "../src/lit/commitments.js";
import { LIT } from "../src/lit/construction.js";
import { litConfigHash, litConfigurationBytes } from "../src/lit/configuration.js";
import { encodeFaultEvidence } from "../src/lit/fault-evidence.js";
import { noteCommitment, type Opening, type Output } from "../src/lit/notes.js";
import {
  acceptanceBytes, acceptanceId, derivedOutputs, encodePublication, encodeRecord, encodeSettlementAuthorization, evidencePair, releaseBytes,
  statementBytes, statementHash, type LitRecord, type Statement,
} from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { encodeLitPackage, encodeLitTrail, litSegmentBytes, litSegmentIdentity } from "../src/lit/transport.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { directoryRoot, encodeCommitment, signCommitment, type Commitment } from "../src/venue-records.js";
import { adoptedConfiguration, adoptedDomain } from "../src/pool/v3/configuration.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { FAULT_LIMITS } from "../src/pool/v3/fault-observer.js";
import type { SegmentHeader } from "../src/pool/v3/headers.js";
import { encodeEvidenceDirectory, type EvidenceItem } from "../src/pool/v3/package.js";
import { readFrontier, readPackage } from "../src/pool/v3/package-reader.js";
import { keptStateHolds } from "../src/pool/v3/reader.js";
import { keptFileDigest, ReplayStore } from "../src/pool/v3/replay-store.js";
import { applyRecord, openSegmentState, type ProofCheck, type SegmentReplay, type SegmentState } from "../src/pool/v3/state.js";
import type { RootTerms } from "../src/pool/v3/terms.js";

// Lit-v1 packages read end to end by the one package reader and walk (slice 14 M14d): the selection's configuration
// names the construction, whose frames (§§5–6, 9) read the package, trails, snapshots, receipts, publications and
// fault evidence, and whose view (src/lit/construction.ts) the state machine replays. No verifier is given anywhere.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const DOMAIN = litConfigHash(), label = b(2), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(3), OPERATOR = b(4), ALICE = b(101), BOB = b(102), PRESENTER = b(104), MALLORY = b(109);
const operator = pub(OPERATOR);
// The operator's own replay: a lit record never asks for a proof.
const NO_PROOF: ProofCheck = { verify: () => { throw new Error("a lit record has no proof"); } };
const stateOf = <T extends { readonly receipt?: unknown }>(result: T): Exclude<T, { readonly receipt: object }> => {
  if (result.receipt !== undefined) throw new Error("a receipt verdict");
  return result as Exclude<T, { readonly receipt: object }>;
};
const key = (bytes: Uint8Array): bigint => BigInt(`0x${hex(bytes)}`);
/** §5's pair over a committed record's split fields; one that does not split commits some value no prefix reproduces. */
const pairOf = (bytes: Uint8Array) => {
  try { return LIT.reader.digests(bytes); } catch { return { statementHash: sha256(bytes), proofHash: new Uint8Array(0), signatureHash: sha256(bytes) }; }
};

/** One operator's lit scope of one backing on a reference venue at index 200, with the records each checkpoint carries. */
function litScope(clauses: Pick<LitRootTerms, "silence" | "nonService"> = {}) {
  const venue = FixtureVenue.reference(label, lag, 200n), operatorStore = new ReplayStore();
  const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator, interval: 10n,
    payout: { thing: "lit reader test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(b(6)), ...clauses };
  const termsBytes = encodeLitTerms(fields), backing = litTermsName(termsBytes);
  const signed = { terms: termsBytes, signature: ed25519.sign(litTermsSignatureMessage(termsBytes), K) };
  const terms = fields as unknown as RootTerms;
  const open = (sequence: bigint, predecessor?: Commitment, imported?: SegmentState) => {
    const header: SegmentHeader = { domain: DOMAIN, venue: venue.id, operator, sequence,
      entries: [{ backing, link: backing, ...(predecessor === undefined ? {} : { opening: { operator, sequence: predecessor.sequence, root: predecessor.root } }) }] };
    const id = litSegmentIdentity(header);
    return { header, id, records: [] as Uint8Array[], state: openSegmentState(operatorStore, id, b(90), imported, LIT) };
  };
  let current = open(1n);
  const items: EvidenceItem[] = [];
  const add = (kind: number, payload: Uint8Array): void => {
    if (!items.some(item => item.kind === kind && compareBytes(item.payload, payload) === 0)) items.push({ kind, payload });
  };
  /** The evidence chain over the current trail as committed, valid or not (§5). */
  const evidenceOf = (records: readonly Uint8Array[]): Uint8Array =>
    records.reduce((chain, bytes, i) => LIT.nextEvidence(chain, pairOf(bytes), BigInt(i + 1)), LIT.genesisEvidence(current.id));
  const snapshotNow = (): Snapshot => ({ backing, segment: current.id, historyHash: current.state.history, evidenceHash: evidenceOf(current.records),
    ...current.state.total(hex(backing)) });
  /** Commit the current trail at `index`; `alter` may change the snapshot, and `withhold` keeps its trail out of the package. */
  function checkpoint(sequence: bigint, index: bigint, options: { alter?: (s: Snapshot) => Snapshot; withhold?: boolean } = {}): Commitment {
    const snapshot = (options.alter ?? (s => s))(snapshotNow());
    const directory = [{ name: backing, digest: snapshotDigest(snapshot) }];
    add(4, snapshotBytes(snapshot)); add(3, encodeEvidenceDirectory(directory));
    if (options.withhold !== true) add(6, encodeLitTrail({ header: litSegmentBytes(current.header), terms: [signed], records: current.records }));
    const commitment = signCommitment(OPERATOR, sequence, directoryRoot(directory));
    venue.witness(1, operator, index, encodeCommitment(commitment));
    return commitment;
  }
  const replayOf = (): SegmentReplay => ({ domain: DOMAIN, backing, segment: current.id, scope: undefined, terms,
    scopedTerms: new Map([[hex(backing), terms]]), verifier: NO_PROOF, index: 2n, block: [] });
  /** Admit a record into the operator's state and trail. */
  async function admit(bytes: Uint8Array): Promise<void> { await applyRecord(current.state, bytes, replayOf()); current.records.push(bytes); }
  /** Put a record the operator's state would refuse into the trail, as a faulty operator commits it. */
  const commitRaw = (bytes: Uint8Array): void => { current.records.push(bytes); };
  // Records (§3), signed as lit-v1 says; outputs derived by the construction's view.
  const record = (statement: Statement, authorization: Uint8Array): Uint8Array => encodeRecord({ statement, authorization } as LitRecord);
  const sign = (statement: Statement, ...signers: Uint8Array[]): Uint8Array =>
    Uint8Array.from(signers.flatMap(signer => [...ed25519.sign(statementBytes(statement), signer)]));
  // Each output's opening by §2's derivation (oracle-checked in lit-records and lit-state tests), and the view's commitments.
  const outputsOf = (bytes: Uint8Array): Opening[] => {
    const decoded = LIT.decode(bytes), openings = [...derivedOutputs(decoded.statement)];
    expect(openings.map(opening => key(noteCommitment(DOMAIN, opening)))).toEqual(LIT.view(decoded, () => undefined).outputs);
    return openings;
  };
  let nonce = 0;
  const issue = (quantity: bigint, owner: Uint8Array, signer = K): Uint8Array => {
    const statement: Statement = { domain: DOMAIN, kind: 1, segment: current.id, backing, quantity, owner: pub(owner), nonce: b(150 + nonce++) };
    return record(statement, sign(statement, signer));
  };
  const spend = (inputs: Opening[], outputs: Output[], signers: Uint8Array[]): Uint8Array => {
    const statement: Statement = { domain: DOMAIN, kind: 2, segment: current.id, inputs, outputs };
    return record(statement, sign(statement, ...signers));
  };
  const demand = (inputs: Opening[], signers: Uint8Array[], instant: bigint, deadline: bigint): Uint8Array => {
    const statement: Statement = { domain: DOMAIN, kind: 4, segment: current.id, inputs, presenter: pub(PRESENTER), instant, deadline };
    return record(statement, sign(statement, ...signers));
  };
  /** A settlement of the demand `bytes` to `owner`: K's acceptance and the presenter's release (§§3–4). */
  const settle = (bytes: Uint8Array, owner: Uint8Array, deadline: bigint): Uint8Array => {
    const demandId = statementHash(LIT.decode(bytes).statement);
    const statement: Statement = { domain: DOMAIN, kind: 6, segment: current.id, demand: demandId, owner: pub(owner) };
    const acceptance = { domain: DOMAIN, demand: demandId, owner: pub(owner), deadline };
    return record(statement, encodeSettlementAuthorization(deadline, ed25519.sign(acceptanceBytes(acceptance), K), ed25519.sign(acceptanceBytes(acceptance), owner),
      ed25519.sign(releaseBytes(DOMAIN, demandId, acceptanceId(acceptance), statementHash(statement)), PRESENTER)));
  };
  const request = (input: Opening, signer: Uint8Array): Uint8Array => {
    const statement: Statement = { domain: DOMAIN, kind: 7, input, refresh: 1n };
    return record(statement, sign(statement, signer));
  };
  const to = (value: bigint, owner: Uint8Array): Output => ({ backing, value, owner: pub(owner) });
  const selection = (commitment: Commitment) => ({ mode: "current-fixture" as const, domain: DOMAIN, venue: venue.id, backing, operator,
    sequence: commitment.sequence, root: commitment.root, judgingIndex: venue.witnessedIndex() });
  const pack = (extra: readonly EvidenceItem[] = []): Uint8Array => encodeLitPackage([...items, ...extra].sort((a, z) =>
    a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
  const read = (commitment: Commitment, extra: readonly EvidenceItem[] = [], options: { evidence?: EvidenceStore; store?: ReplayStore } = {}) =>
    readPackage<LitRecord>(pack([...extra, { kind: 1, payload: litConfigurationBytes() }, { kind: 2, payload: encodeCommitment(commitment) }]),
      selection(commitment), { construction: LIT, reference, venue, ...options });
  /** The operator's receipt for the current segment's latest record, given after sequence `after` (§5). */
  function receipt(after: bigint): Uint8Array {
    const bytes = current.records.at(-1)!, pair = evidencePair(LIT.decode(bytes));
    const fields = { domain: DOMAIN, segment: current.id, position: BigInt(current.records.length), statementHash: pair.statementHash,
      historyHash: current.state.history, signatureHash: pair.signatureHash, after };
    return encodeReceipt({ ...fields, operator, signature: ed25519.sign(receiptBytes(fields), OPERATOR) });
  }
  /** §9 fault evidence for the trail's record at `position`, against the snapshot `checkpoint` committed. */
  function fault(snapshot: Snapshot, position: bigint): Uint8Array {
    const records = current.records, bytes = records[Number(position) - 1]!, length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    return encodeFaultEvidence({ snapshot, position, length: BigInt(records.length), previous: evidenceOf(records.slice(0, Number(position) - 1)),
      statement: bytes.subarray(4, 4 + length), authorization: bytes.subarray(8 + length),
      suffix: records.slice(Number(position)).map(r => evidencePair(LIT.decode(r))) }, FAULT_LIMITS.maxSuffixEntries);
  }
  const publish = (index: bigint, kind: 1 | 5, bytes: Uint8Array): void =>
    venue.witness(4, backing, index, encodePublication({ domain: DOMAIN, backing, kind, record: LIT.decode(bytes) }));
  const successor = (sequence: bigint, predecessor: Commitment): void => { current = open(sequence, predecessor, current.state); };
  /** The current trail as a reader's evidence store serves it, cut at its last record. */
  const trailOf = () => new EvidenceStore(":memory:", { construction: LIT })
    .importTrails([encodeLitTrail({ header: litSegmentBytes(current.header), terms: [signed], records: current.records })])
    .trail(current.id, evidenceOf(current.records))!;
  return { trailOf, venue, backing, signed, items, checkpoint, admit, commitRaw, outputsOf, issue, spend, demand, settle, request, to, read, receipt, fault,
    snapshotNow, publish, successor, pack, current: () => current };
}

describe("lit packages through the one reader (M14d)", () => {
  it("reads an issue and a payment from a lit package with no verifier: derived outputs, totals and the selection's class", async () => {
    const f = litScope();
    const opening = f.checkpoint(1n, 1n);
    const issued = f.issue(10n, ALICE); await f.admit(issued);
    const [note] = f.outputsOf(issued);
    const paid = f.spend([note!], [f.to(6n, BOB), f.to(4n, ALICE)], [ALICE]); await f.admit(paid);
    const latest = f.checkpoint(2n, 3n);
    const read = stateOf(await f.read(latest));
    expect(read.state.issued).toBe(10n); expect(read.state.position).toBe(2n);
    expect(read.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"]]);
    expect(read.canonical.scope).toBeUndefined();
    expect(read.state.history).toEqual(f.current().state.history);
    for (const output of f.outputsOf(paid)) expect(read.state.hasOutput(key(noteCommitment(DOMAIN, output)))).toBe(true);
    expect(read.state.hasOutput(key(noteCommitment(DOMAIN, note!)))).toBe(true);
    expect(read.state.hasNullifier(LIT.view(LIT.decode(paid), () => undefined).nfs[0]!)).toBe(true);
    // The opening is superseded by the later valid checkpoint.
    await expect(f.read(opening)).rejects.toMatchObject({ status: "superseded-selection" });
  });

  it("excludes a checkpoint whose lit trail fails by name, and its successor reads the last valid state", async () => {
    const cases: { check: string; build: (f: ReturnType<typeof litScope>, note: Opening) => Uint8Array }[] = [
      { check: "SIGNATURE", build: (f, note) => f.spend([note], [f.to(10n, BOB)], [MALLORY]) },
      { check: "ARITHMETIC", build: (f, note) => f.spend([note], [f.to(11n, BOB)], [ALICE]) },
      { check: "INPUT", build: (f, note) => f.spend([{ ...note, rho: b(77) }], [f.to(10n, BOB)], [ALICE]) },
      { check: "SIGNATURE", build: f => f.issue(5n, ALICE, MALLORY) },
      { check: "KIND", build: (f, note) => f.request(note, ALICE) },
      // The note spent twice in one trail: the second spend finds its nullifier spent.
      { check: "SPENT", build: (f, note) => f.spend([note], [f.to(10n, ALICE)], [ALICE]) },
    ];
    for (const { check, build } of cases) {
      const f = litScope();
      f.checkpoint(1n, 1n);
      const issued = f.issue(10n, ALICE); await f.admit(issued);
      const [note] = f.outputsOf(issued);
      if (check === "SPENT") await f.admit(f.spend([note!], [f.to(10n, BOB)], [ALICE]));
      const valid = f.checkpoint(2n, 3n);
      f.commitRaw(build(f, note!));
      const hostile = f.checkpoint(3n, 4n);
      await expect(f.read(hostile)).rejects.toMatchObject({ check });
      // The last valid checkpoint stays canonical: the hostile one is classified, and excluded by its check.
      const read = stateOf(await f.read(valid));
      expect(read.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
        ["3", "excluded", check]]);
    }
  });

  it("refuses a misstated supply and a snapshot whose history the trail does not reproduce", async () => {
    const f = litScope();
    f.checkpoint(1n, 1n); await f.admit(f.issue(10n, ALICE));
    await expect(f.read(f.checkpoint(2n, 3n, { alter: s => ({ ...s, issued: 11n }) }))).rejects.toMatchObject({ check: "SNAPSHOT" });
    const g = litScope();
    g.checkpoint(1n, 1n); await g.admit(g.issue(10n, ALICE));
    await expect(g.read(g.checkpoint(2n, 3n, { alter: s => ({ ...s, historyHash: b(9) }) }))).rejects.toMatchObject({ check: "SNAPSHOT" });
  });

  it("imports a predecessor into a successor segment and spends its note there (C2.10.5–7)", async () => {
    const f = litScope();
    f.checkpoint(1n, 1n);
    const issued = f.issue(10n, ALICE); await f.admit(issued);
    const predecessor = f.checkpoint(2n, 3n);
    f.successor(3n, predecessor);
    f.checkpoint(3n, 4n);
    const [note] = f.outputsOf(issued);
    // The successor's statements name its own segment; the imported note is live there.
    await f.admit(f.spend([note!], [f.to(10n, BOB)], [ALICE]));
    const latest = f.checkpoint(4n, 5n);
    const read = stateOf(await f.read(latest));
    expect(read.state.issued).toBe(10n); expect(read.state.position).toBe(1n);
    expect(read.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["2", "valid"], ["3", "valid"], ["4", "valid"]]);
    expect(read.state.importedEventCount()).toBe(1n);
  });

  it("reads a lit receipt final where a valid checkpoint includes it, with no scope root (§5)", async () => {
    const f = litScope();
    f.checkpoint(1n, 1n); await f.admit(f.issue(10n, ALICE));
    const receipt = f.receipt(1n), latest = f.checkpoint(2n, 3n);
    expect((await f.read(latest, [{ kind: 10, payload: receipt }])).receipt).toMatchObject({ status: "final", includedAt: [{ sequence: "2" }] });
    // A receipt whose signature is not the operator's is refused.
    const forged = Uint8Array.from(receipt); forged[forged.length - 1]! ^= 1;
    await expect(f.read(latest, [{ kind: 10, payload: forged }])).rejects.toMatchObject({ status: "invalid-receipt" });
  });

  it("excludes a withheld checkpoint by compact fault evidence of an intrinsic failure, and reports the facts (§6)", async () => {
    for (const { check, role, bad } of [
      { check: "SIGNATURE", role: "owner", bad: (f: ReturnType<typeof litScope>, note: Opening) => f.spend([note], [f.to(10n, BOB)], [MALLORY]) },
      { check: "ARITHMETIC", role: undefined, bad: (f: ReturnType<typeof litScope>, note: Opening) => f.spend([note], [f.to(12n, BOB)], [ALICE]) },
    ]) {
      const f = litScope();
      f.checkpoint(1n, 1n);
      const issued = f.issue(10n, ALICE); await f.admit(issued);
      const valid = f.checkpoint(2n, 3n);
      f.commitRaw(bad(f, f.outputsOf(issued)[0]!));
      const snapshot = f.snapshotNow();
      f.checkpoint(3n, 4n, { withhold: true });
      // Without the trail or fault evidence the withheld checkpoint leaves the read unresolved.
      await expect(f.read(valid)).rejects.toMatchObject({ status: "unresolved-evidence" });
      const read = stateOf(await f.read(valid, [{ kind: 7, payload: f.fault(snapshot, 2n) }]));
      expect(read.carrying.map(item => [item.sequence, item.class, item.check])).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
        ["3", "excluded", check]]);
      expect(read.faultEvidence).toEqual([expect.objectContaining({ check, sequence: "3", position: "2", classification: "not-established",
        configuration: hex(DOMAIN), ...(role === undefined ? {} : { authorizationRole: role, signer: hex(pub(ALICE)) }) })]);
      expect(read.faultEvidence![0]).not.toHaveProperty("proofHash");
    }
  });

  it("forces a demand published past the silence duration, and refuses a forged one by its check (C2b.3.2, §7)", async () => {
    const f = litScope({ silence: { noCommitmentDuration: 5n } });
    f.checkpoint(1n, 1n);
    const issued = f.issue(10n, ALICE); await f.admit(issued);
    f.checkpoint(2n, 2n);
    const [note] = f.outputsOf(issued);
    const forged = f.demand([note!], [MALLORY], 18n, 100n), honest = f.demand([note!], [ALICE], 18n, 100n);
    f.publish(20n, 1, forged); f.publish(20n, 1, honest);
    const frontier = await readFrontier<LitRecord>(f.pack(), f.signed, 200n, { construction: LIT, reference, venue: f.venue });
    expect(frontier.ranges.publications.map(p => [p.index, p.force, p.check])).toEqual([["20", false, "SIGNATURE"], ["20", true, undefined]]);
    expect(frontier.force).toHaveLength(1);
    expect(frontier.force[0]!.record.statement.kind).toBe(4);
    expect(statementHash(frontier.force[0]!.record.statement)).toEqual(statementHash(LIT.decode(honest).statement));
    expect(frontier.canonical!.scope).toBeUndefined();
    // A demand whose summed value passes a u64, or whose inputs name two backings, does not decode as a publication
    // (§4's derived routing backing), so it has no force and is not judged by ARITHMETIC (pool-v3 §13.3).
    const g = litScope({ silence: { noCommitmentDuration: 5n } });
    g.checkpoint(1n, 1n);
    const minted = g.issue(10n, ALICE); await g.admit(minted);
    g.checkpoint(2n, 2n);
    const [held] = g.outputsOf(minted), max = (1n << 64n) - 1n;
    const raw = (bytes: Uint8Array): Uint8Array => Uint8Array.from([...new TextEncoder().encode("moe/lit/v1/publication"), ...DOMAIN, ...g.backing, 1,
      ...[24, 16, 8, 0].map(shift => (bytes.length >>> shift) & 255), ...bytes]);
    for (const inputs of [[{ ...held!, value: max }, held!], [held!, { ...held!, backing: b(55) }]]) {
      g.venue.witness(4, g.backing, 20n, raw(g.demand(inputs, [ALICE, ALICE], 18n, 100n)));
    }
    const unread = await readFrontier<LitRecord>(g.pack(), g.signed, 200n, { construction: LIT, reference, venue: g.venue });
    expect(unread.ranges.publications.map(p => [p.index, p.ordinal, p.force, "check" in p])).toEqual([["20", "0", false, false], ["20", "1", false, false]]);
    expect(unread.force).toHaveLength(0);
    // A holder's answers read pool-v3's releases; a lit read lists none.
    await expect(readFrontier(f.pack(), f.signed, 200n, { construction: LIT, reference, venue: f.venue, answers: true })).rejects.toThrow(TypeError);
  });

  it("counts a request whose owner signs it and whose note is an output of the canonical state (C2b.5.2, §7)", async () => {
    const f = litScope({ nonService: { duration: 2n, count: 1n, window: 10n } });
    f.checkpoint(1n, 1n);
    const issued = f.issue(10n, ALICE); await f.admit(issued);
    const latest = f.checkpoint(2n, 2n);
    const [note] = f.outputsOf(issued);
    // A forged request and one for a note never created are not counted; the owner's request is.
    f.publish(194n, 5, f.request(note!, MALLORY));
    f.publish(195n, 5, f.request({ ...note!, rho: b(78) }, ALICE));
    expect(stateOf(await f.read(latest)).ranges.nonService).toMatchObject({ count: "0", fires: false });
    f.publish(196n, 5, f.request(note!, ALICE));
    expect(stateOf(await f.read(latest)).ranges.nonService).toMatchObject({ count: "1", fires: true, snapshotIndex: "2" });
  });

  it("excludes a checkpoint whose record splits but does not decode by MALFORMED, and leaves one that does not split unresolved (§6)", async () => {
    // A valid spend's record, patched after its fields split: offsets past the 4-byte statement length.
    const patched = (f: ReturnType<typeof litScope>, note: Opening, patch: (bytes: Uint8Array) => Uint8Array): Uint8Array =>
      patch(Uint8Array.from(f.spend([note], [f.to(10n, BOB)], [ALICE])));
    const field = (statement: Uint8Array, authorization: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + statement.length + authorization.length), view = new DataView(out.buffer);
      view.setUint32(0, statement.length); out.set(statement, 4);
      view.setUint32(4 + statement.length, authorization.length); out.set(authorization, 8 + statement.length);
      return out;
    };
    const fields = (bytes: Uint8Array) => { const n = new DataView(bytes.buffer).getUint32(0); return { s: bytes.slice(4, 4 + n), a: bytes.slice(8 + n) }; };
    const output = 4 + 53 + 32 + 1 + 104 + 1;
    const cases: [string, (f: ReturnType<typeof litScope>, note: Opening) => Uint8Array][] = [
      ["value 0", (f, note) => patched(f, note, r => { r.fill(0, output + 32, output + 40); return r; })],
      ["small-order owner", (f, note) => patched(f, note, r => { r.fill(0, output + 40, output + 72); r[output + 40] = 1; return r; })],
      ["kind 8", (f, note) => patched(f, note, r => { r[4 + 52] = 8; return r; })],
      ["63-byte authorization", (f, note) => patched(f, note, r => { const { s, a } = fields(r); return field(s, a.subarray(0, 63)); })],
      ["both lengths zero", () => new Uint8Array(8)],
      ["5000-byte statement", (f, note) => patched(f, note, r => field(new Uint8Array(5000), fields(r).a))],
    ];
    for (const [name, build] of cases) {
      const f = litScope();
      f.checkpoint(1n, 1n);
      const issued = f.issue(10n, ALICE); await f.admit(issued);
      const valid = f.checkpoint(2n, 3n);
      f.commitRaw(build(f, f.outputsOf(issued)[0]!));
      const hostile = f.checkpoint(3n, 4n);
      await expect(f.read(hostile), name).rejects.toMatchObject({ check: "MALFORMED" });
      const read = stateOf(await f.read(valid));
      expect(read.carrying.map(item => [item.sequence, item.class, item.check]), name).toEqual([["1", "valid", undefined], ["2", "valid", undefined],
        ["3", "excluded", "MALFORMED"]]);
    }
    // A record that does not split authenticates nothing: the checkpoint stays unresolved (§10.1).
    const g = litScope();
    g.checkpoint(1n, 1n);
    const minted = g.issue(10n, ALICE); await g.admit(minted);
    g.checkpoint(2n, 3n);
    g.commitRaw(Uint8Array.from([...g.spend([g.outputsOf(minted)[0]!], [g.to(10n, BOB)], [ALICE]), 0]));
    await expect(g.read(g.checkpoint(3n, 4n))).rejects.toMatchObject({ status: "unresolved-evidence" });
    // An opening whose trail holds one is excluded as no opening (an opening's trail is empty).
    const h = litScope();
    h.commitRaw(new Uint8Array(8));
    await expect(h.read(h.checkpoint(1n, 1n))).rejects.toMatchObject({ check: "OPENING" });
    // A later trail that replaces the last valid prefix's record with one does not extend it.
    const k = litScope();
    k.checkpoint(1n, 1n);
    await k.admit(k.issue(10n, ALICE));
    k.checkpoint(2n, 3n);
    k.current().records.length = 0; k.commitRaw(new Uint8Array(8));
    await expect(k.read(k.checkpoint(3n, 4n))).rejects.toMatchObject({ check: "CONTINUITY" });
  });

  it("passes another construction's checkpoint of the same operator key as non-carrying by its directory alone (§6)", async () => {
    const f = litScope();
    f.checkpoint(1n, 1n); await f.admit(f.issue(10n, ALICE));
    // The key commits a pool-v3 checkpoint between the lit ones: its directory names a backing no lit scope holds,
    // and the package carries nothing else of it.
    const directory = [{ name: b(77), digest: b(78) }], foreign = signCommitment(OPERATOR, 2n, directoryRoot(directory));
    f.venue.witness(1, operator, 2n, encodeCommitment(foreign));
    f.items.push({ kind: 3, payload: encodeEvidenceDirectory(directory) });
    const latest = f.checkpoint(3n, 3n);
    const read = stateOf(await f.read(latest));
    expect(read.carrying.map(item => [item.sequence, item.class])).toEqual([["1", "valid"], ["3", "valid"]]);
    expect(read.state.issued).toBe(10n);
    // A receipt whose `after` names the pool's checkpoint is not of the receipt's segment (pool-v3 §7.1).
    expect((await f.read(latest, [{ kind: 10, payload: f.receipt(1n) }])).receipt).toMatchObject({ status: "final", includedAt: [{ sequence: "3" }] });
    await expect(f.read(latest, [{ kind: 10, payload: f.receipt(2n) }])).rejects.toMatchObject({ status: "invalid-receipt" });
  });

  it("rebuilds a kept lit namespace's outputs from its trail before reusing it (§10), and resumes a kept file without discarding it", async () => {
    const f = litScope(), other = litScope();
    f.checkpoint(1n, 1n);
    const issued = f.issue(10n, ALICE); await f.admit(issued);
    const [note] = f.outputsOf(issued);
    await f.admit(f.spend([note!], [f.to(6n, BOB), f.to(4n, ALICE)], [ALICE]));
    // A demand and its settlement: the settlement's output is derived from the demand the trail carries.
    const [, change] = f.outputsOf(f.current().records[1]!);
    const presented = f.demand([change!], [ALICE], 0n, 100n); await f.admit(presented);
    await f.admit(f.settle(presented, BOB, 50n));
    other.checkpoint(1n, 1n);
    for (const quantity of [10n, 6n, 4n, 3n]) await other.admit(other.issue(quantity, BOB));
    const { state } = f.current(), snapshot = f.snapshotNow(), identity = b(90);
    expect([...state.store.outputs(state.ns, 4n)].map(output => output.position)).toEqual([1n, 2n, 2n, 4n]);
    // The operator's rows (written by no reader's replay) against another segment's trail of as many records, or with no
    // trail, do not hold; against their own trail they do, and are then known, so a lower position holds without one.
    expect(keptStateHolds(state.store, state.ns, 4n, identity, snapshot, LIT, other.trailOf())).toBe(false);
    expect(keptStateHolds(state.store, state.ns, 4n, identity, snapshot, LIT)).toBe(false);
    expect(keptStateHolds(state.store, state.ns, 4n, identity, snapshot, LIT, f.trailOf())).toBe(true);
    // A namespace is read only under its own construction.
    expect(keptStateHolds(state.store, state.ns, 4n, identity, snapshot)).toBe(false);

    const g = litScope(), directory = mkdtempSync(join(tmpdir(), "lit-kept-"));
    const files = { path: join(directory, "replay.sqlite"), digest: join(directory, "replay.sha256"), evidence: join(directory, "evidence.sqlite") };
    try {
      g.checkpoint(1n, 1n);
      const minted = g.issue(10n, ALICE); await g.admit(minted);
      const first = g.checkpoint(2n, 3n);
      let store = new ReplayStore(files.path, { digest: files.digest }), evidence = new EvidenceStore(files.evidence, { construction: LIT });
      expect(stateOf(await g.read(first, [], { store, evidence })).state.issued).toBe(10n);
      store.close(); evidence.close();
      await g.admit(g.spend([g.outputsOf(minted)[0]!], [g.to(6n, BOB), g.to(4n, ALICE)], [ALICE]));
      // The venue moves on past the index the first read kept its answers through.
      g.venue.advance(210n);
      const second = g.checkpoint(3n, 205n);
      store = new ReplayStore(files.path, { digest: files.digest }); evidence = new EvidenceStore(files.evidence, { construction: LIT });
      const discard = vi.spyOn(store, "discardKept");
      const resumed = stateOf(await g.read(second, [], { store, evidence })), fresh = stateOf(await g.read(second));
      expect(discard).not.toHaveBeenCalled();
      expect([resumed.carrying, resumed.state.history, resumed.state.position]).toEqual([fresh.carrying, fresh.state.history, 2n]);
      store.close(); evidence.close();
    } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });

  it("rebuilds an imported namespace's outputs before a kept successor resumes on them (§10)", async () => {
    const g = litScope(), directory = mkdtempSync(join(tmpdir(), "lit-imported-"));
    const files = { path: join(directory, "replay.sqlite"), digest: join(directory, "replay.sha256"), evidence: join(directory, "evidence.sqlite") };
    try {
      g.checkpoint(1n, 1n);
      const minted = g.issue(10n, ALICE); await g.admit(minted);
      const predecessor = g.checkpoint(2n, 3n);
      g.successor(3n, predecessor);
      const opened = g.checkpoint(3n, 4n);
      let store = new ReplayStore(files.path, { digest: files.digest }), evidence = new EvidenceStore(files.evidence, { construction: LIT });
      expect(stateOf(await g.read(opened, [], { store, evidence })).state.importedEventCount()).toBe(1n);
      store.close(); evidence.close();
      // Reopened, the honest kept rows rebuild from the predecessor's trail and the kept walk stands.
      store = new ReplayStore(files.path, { digest: files.digest }); evidence = new EvidenceStore(files.evidence, { construction: LIT });
      const honest = vi.spyOn(store, "discardKept");
      expect(stateOf(await g.read(opened, [], { store, evidence })).state.importedEventCount()).toBe(1n);
      expect(honest).not.toHaveBeenCalled();
      store.close(); evidence.close();
      // The imported note's row now names a note of Mallory's worth 1000, under a digest re-recorded for it: §14's
      // digest check cannot see it, and only the rebuild from the predecessor's trail can.
      const [note] = g.outputsOf(minted), forged: Opening = { ...note!, value: 1000n, owner: pub(MALLORY) };
      const db = new DatabaseSync(files.path);
      expect(db.prepare("UPDATE output SET cm = ? WHERE cm = ?").run(noteCommitment(DOMAIN, forged), noteCommitment(DOMAIN, note!)).changes).toBe(1);
      db.close();
      writeFileSync(files.digest, keptFileDigest(files.path)!);
      g.commitRaw(g.spend([forged], [g.to(1000n, MALLORY)], [MALLORY]));
      g.venue.advance(210n);
      const hostile = g.checkpoint(4n, 205n);
      store = new ReplayStore(files.path, { digest: files.digest }); evidence = new EvidenceStore(files.evidence, { construction: LIT });
      const discard = vi.spyOn(store, "discardKept");
      await expect(g.read(hostile, [], { store, evidence })).rejects.toMatchObject({ check: "INPUT" });
      expect(discard).toHaveBeenCalled();
      await expect(g.read(hostile)).rejects.toMatchObject({ check: "INPUT" });
      store.close(); evidence.close();
    } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); }
  });

  it("reads each construction only under its own configuration, store and evidence file", async () => {
    const f = litScope();
    f.checkpoint(1n, 1n); await f.admit(f.issue(10n, ALICE));
    const latest = f.checkpoint(2n, 3n);
    // A lit selection with the pool's evidence store, and a pool selection of the lit package.
    await expect(f.read(latest, [], { evidence: new EvidenceStore() })).rejects.toThrow(TypeError);
    const verifier = { verify: () => true, identities: adoptedConfiguration().circuits };
    const pool = readPackage(f.pack([{ kind: 1, payload: litConfigurationBytes() }, { kind: 2, payload: encodeCommitment(latest) }]),
      { mode: "current-fixture", domain: adoptedDomain(), venue: f.venue.id, backing: f.backing, operator, sequence: latest.sequence,
        root: latest.root, judgingIndex: f.venue.witnessedIndex() }, { verifier, reference, venue: f.venue });
    await expect(pool).rejects.toThrow();
    // A lit selection read as the pool's (the default construction), or under another configuration, is refused by name.
    for (const [domain, construction] of [[DOMAIN, undefined], [b(1), LIT]] as const) {
      await expect(readPackage(f.pack(), { mode: "current-fixture", domain, venue: f.venue.id, backing: f.backing, operator,
        sequence: latest.sequence, root: latest.root, judgingIndex: f.venue.witnessedIndex() }, { construction, verifier, reference, venue: f.venue }))
        .rejects.toMatchObject({ check: "CONFIGURATION" });
    }
    // Lit terms read as the pool's do not decode under its construction clause.
    await expect(readFrontier(f.pack(), f.signed, 200n, { verifier, reference, venue: f.venue })).rejects.toThrow();
    // A party's evidence file reads one construction's evidence.
    const directory = mkdtempSync(join(tmpdir(), "lit-evidence-"));
    try {
      const path = join(directory, "evidence.db");
      const lit = new EvidenceStore(path, { construction: LIT });
      expect(stateOf(await f.read(latest, [], { evidence: lit })).state.issued).toBe(10n);
      lit.close();
      expect(() => new EvidenceStore(path)).toThrow(TypeError);
      const reopened = new EvidenceStore(path, { construction: LIT });
      reopened.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
