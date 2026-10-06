import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../src/bytes.js";
import { decodeReceipt, decodeSnapshot, verifyReceipt } from "../src/lit/commitments.js";
import { litConfigHash, litConfigurationBytes } from "../src/lit/configuration.js";
import { LIT } from "../src/lit/construction.js";
import { noteCommitment, type Opening, type Output } from "../src/lit/notes.js";
import {
  acceptanceBytes, acceptanceId, derivedOutputs, encodePublication, encodeRecord, encodeSettlementAuthorization, releaseBytes, statementBytes,
  statementHash, type LitRecord, type Statement,
} from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { decodeLitPackage, decodeLitSegmentHeader, decodeLitTrail, litSegmentIdentity } from "../src/lit/transport.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { adoptedConfiguration, adoptedDomain } from "../src/pool/v3/configuration.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { encodeRecord as encodePoolRecord } from "../src/pool/v3/records.js";
import { authorizeIssue, issueTask } from "../src/pool/v3/witness.js";
import type { SegmentHeader } from "../src/pool/v3/headers.js";
import type { ServedPackage, V3OperatorJournal as Journal, V3StoreError as StoreError } from "../src/pool/v3/store.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

// The operator journal (src/pool/v3/store.ts) serving a lit-v1 scope (slice 14 M14f): the same journal, its construction
// an option. It admits lit records through the one state machine with lit receipts (lit-v1 §5), commits, publishes and
// serves lit packages the independent package reader reads, reopens from its rows, rescopes, returns and adopts. No
// verifier is given anywhere: a lit record has no proof.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const same = (a: Uint8Array, z: Uint8Array): boolean => compareBytes(a, z) === 0;
const DOMAIN = litConfigHash(), label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(15), OPERATOR = b(16), RULE = b(19), ALICE = b(101), BOB = b(102), CAROL = b(103), PRESENTER = b(104), MALLORY = b(109);
const operator = pub(OPERATOR);

describe("the operator journal over a lit scope", () => {
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

  function fixture(clauses: Pick<LitRootTerms, "silence"> = {}) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "lit-journal-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator, interval: 30n,
      payout: { thing: "lit journal test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(RULE), ...clauses };
    const terms = encodeLitTerms(fields), backing = litTermsName(terms);
    const signed = { terms, signature: ed25519.sign(litTermsSignatureMessage(terms), K) };
    const file = join(directory, "journal.db");
    /** The journal over this fixture's file: lit's by default, pool-v3's with a verifier of its circuits for `pool`. */
    const create = (pool = false): Journal => {
      const options = pool ? { verifier: { verify: () => true, identities: adoptedConfiguration().circuits } } : { construction: LIT };
      const j = new V3OperatorJournal(file, { secret: OPERATOR, venue, reference, ...options }); journals.push(j); return j;
    };
    const record = (statement: Statement, authorization: Uint8Array): Uint8Array => encodeRecord({ statement, authorization } as LitRecord);
    const sign = (statement: Statement, ...signers: Uint8Array[]): Uint8Array =>
      Uint8Array.from(signers.flatMap(signer => [...ed25519.sign(statementBytes(statement), signer)]));
    let nonce = 0;
    const issue = (segment: Uint8Array, quantity: bigint, owner: Uint8Array, signer = K): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 1, segment, backing, quantity, owner: pub(owner), nonce: b(150 + nonce++) };
      return record(statement, sign(statement, signer));
    };
    const spend = (segment: Uint8Array, inputs: Opening[], outputs: Output[], signers: Uint8Array[]): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 2, segment, inputs, outputs };
      return record(statement, sign(statement, ...signers));
    };
    const burn = (segment: Uint8Array, quantity: bigint, inputs: Opening[], outputs: Output[], signers: Uint8Array[]): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 3, segment, quantity, inputs, outputs };
      return record(statement, sign(statement, ...signers));
    };
    const demand = (segment: Uint8Array, inputs: Opening[], signers: Uint8Array[], instant: bigint, deadline: bigint): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 4, segment, inputs, presenter: pub(PRESENTER), instant, deadline };
      return record(statement, sign(statement, ...signers));
    };
    const withdraw = (segment: Uint8Array, bytes: Uint8Array): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 5, segment, demand: statementHash(LIT.decode(bytes).statement) };
      return record(statement, sign(statement, PRESENTER));
    };
    /** A settlement of the demand `bytes` to `owner`: K's acceptance and the presenter's release (lit-v1 §§3–4). */
    const settle = (segment: Uint8Array, bytes: Uint8Array, owner: Uint8Array, deadline: bigint): Uint8Array => {
      const demandId = statementHash(LIT.decode(bytes).statement);
      const statement: Statement = { domain: DOMAIN, kind: 6, segment, demand: demandId, owner: pub(owner) };
      const acceptance = { domain: DOMAIN, demand: demandId, owner: pub(owner), deadline };
      return record(statement, encodeSettlementAuthorization(deadline, ed25519.sign(acceptanceBytes(acceptance), K),
        ed25519.sign(releaseBytes(DOMAIN, demandId, acceptanceId(acceptance), statementHash(statement)), PRESENTER)));
    };
    const request = (input: Opening, signer: Uint8Array): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 7, input, refresh: 1n };
      return record(statement, sign(statement, signer));
    };
    const outputsOf = (bytes: Uint8Array): Opening[] => [...derivedOutputs(LIT.decode(bytes).statement)];
    const to = (value: bigint, owner: Uint8Array): Output => ({ backing, value, owner: pub(owner) });
    /** The independent reader's verdict on a served package at the venue's current index. */
    const read = async (served: ServedPackage) => {
      const result = await readPackage<LitRecord>(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        { construction: LIT, venue, reference });
      if (result.state === undefined) throw new Error("unexpected receipt verdict");
      return result;
    };
    /** The journal's newest segment header, as served. */
    const header = async (j: Journal): Promise<SegmentHeader> => {
      const headers = decodeLitPackage((await j.package()).package).filter(item => item.kind === 6)
        .map(item => decodeLitSegmentHeader(decodeLitTrail(item.payload).header))
        .sort((p, q) => (p.sequence > q.sequence ? -1 : p.sequence < q.sequence ? 1 : 0));
      return headers[0]!;
    };
    const genesis: SegmentHeader = { domain: DOMAIN, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] };
    return { venue, backing, signed, file, create, issue, spend, burn, demand, withdraw, settle, request, outputsOf, to, read, header,
      segment: litSegmentIdentity(genesis) };
  }
  async function refusal(action: Promise<unknown>): Promise<[string, string | undefined]> {
    const error = await action.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(V3StoreError);
    return [(error as StoreError).code, (error as StoreError).check];
  }

  it("admits every lit statement kind with lit receipts, commits, and serves a package the lit reader reads to the same state", async () => {
    const f = fixture(), j = f.create(), segment = f.segment;
    expect(j.configurationDomain).toEqual(DOMAIN);
    await j.open("genesis", f.signed);
    expect(await refusal(j.submit(f.issue(segment, 10n, ALICE)))).toEqual(["STALE", undefined]);
    await j.publish();
    const now = f.venue.witnessedIndex();
    const issued = f.issue(segment, 10n, ALICE), [note] = f.outputsOf(issued);
    const paid = f.spend(segment, [note!], [f.to(7n, BOB), f.to(3n, ALICE)], [ALICE]), [bobs, change] = f.outputsOf(paid);
    const burned = f.burn(segment, 5n, [bobs!], [f.to(2n, BOB)], [BOB]), [bobsChange] = f.outputsOf(burned);
    const presented = f.demand(segment, [change!], [ALICE], now, now + 50n);
    const settled = f.settle(segment, presented, CAROL, now + 40n);
    const withdrawn = f.demand(segment, [bobsChange!], [BOB], now, now + 50n);
    const records = [issued, paid, burned, presented, settled, withdrawn, f.withdraw(segment, withdrawn)];
    const receipts = [];
    for (const bytes of records) {
      const receipt = decodeReceipt(await j.submit(bytes));
      // Lit-v1 §5's receipt: no scope root, since the segment binds the scope, and no proof digest.
      expect(verifyReceipt({ domain: DOMAIN, segment, operator }, receipt)).toBe(true);
      expect(receipt.statementHash).toEqual(statementHash(LIT.decode(bytes).statement));
      expect(receipt.after).toBe(1n);
      receipts.push(receipt);
    }
    expect(receipts.map(r => r.position)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect((await j.commit("c2")).sequence).toBe(2n);
    await j.publish();
    const served = await j.package(), items = decodeLitPackage(served.package);
    expect(served.selection.domain).toEqual(DOMAIN);
    expect(items.map(item => item.kind)).toEqual([1, 2, 3, 3, 4, 4, 6]);
    expect(items[0]!.payload).toEqual(litConfigurationBytes());
    expect(decodeLitTrail(items.find(item => item.kind === 6)!.payload).records).toEqual(records);
    const snapshots = items.filter(item => item.kind === 4).map(item => decodeSnapshot(item.payload));
    expect(snapshots.map(s => [s.issued, s.burned])).toContainEqual([10n, 5n]);
    const read = await f.read(served);
    expect([read.state.position, read.state.issued, read.state.burned]).toEqual([7n, 10n, 5n]);
    expect(read.carrying.filter(item => item.class !== "valid")).toEqual([]);
    // The reader's state is the journal's: the latest snapshot's history and evidence chains.
    const latest = snapshots.find(s => s.issued === 10n)!;
    expect([read.state.history, read.state.evidence]).toEqual([latest.historyHash, latest.evidenceHash]);
    // Settled to Carol, withdrawn from Bob's change: every note spent or presented is spent.
    expect(read.state.demands()).toEqual([]);
    await j.audit();
  });

  it("answers an exact replay with its original receipt and names each refusal, a pool record's included", async () => {
    const f = fixture(), j = f.create(), segment = f.segment;
    await j.open("genesis", f.signed); await j.publish();
    const issued = f.issue(segment, 10n, ALICE), [note] = f.outputsOf(issued);
    const first = await j.submit(issued);
    expect(await j.submit(issued)).toEqual(first);
    // Malformed bytes, and a pool-v3 issue of the same backing into the same segment, which does not decode as lit.
    expect(await refusal(j.submit(Uint8Array.of(1, 2, 3)))).toEqual(["REFUSED", "MALFORMED"]);
    const poolDomain = adoptedDomain(), poolHeader: SegmentHeader = { ...(await f.header(j)), domain: poolDomain };
    const task = issueTask({ domain: poolDomain, header: poolHeader }, prepareExactOutput(b(21), poolDomain, b(31), f.backing, 10n));
    const pool = encodePoolRecord(authorizeIssue({ domain: poolDomain, kind: 1, publicInputs: task.publicInputs, proof: new Uint8Array(32).fill(1),
      authorization: new Uint8Array(), capsules: task.capsules }, K));
    expect(await refusal(j.submit(pool))).toEqual(["REFUSED", "MALFORMED"]);
    // An issue not signed by K, and a spend not signed by the note's owner.
    expect(await refusal(j.submit(f.issue(segment, 1n, ALICE, MALLORY)))).toEqual(["REFUSED", "SIGNATURE"]);
    expect(await refusal(j.submit(f.spend(segment, [note!], [f.to(10n, MALLORY)], [MALLORY])))).toEqual(["REFUSED", "SIGNATURE"]);
    // More out than in, a note no statement created, and another segment's statement.
    expect(await refusal(j.submit(f.spend(segment, [note!], [f.to(11n, BOB)], [ALICE])))).toEqual(["REFUSED", "ARITHMETIC"]);
    const forged: Opening = { ...note!, rho: b(77) };
    expect(await refusal(j.submit(f.spend(segment, [forged], [f.to(10n, BOB)], [ALICE])))).toEqual(["REFUSED", "INPUT"]);
    expect(await refusal(j.submit(f.issue(b(5), 1n, ALICE)))).toEqual(["REFUSED", "CONTEXT"]);
    // A request is no history event: it is published, never admitted.
    expect(await refusal(j.submit(f.request(note!, ALICE)))).toEqual(["REFUSED", "KIND"]);
    await j.submit(f.spend(segment, [note!], [f.to(10n, BOB)], [ALICE]));
    expect(await refusal(j.submit(f.spend(segment, [note!], [f.to(9n, BOB), f.to(1n, ALICE)], [ALICE])))).toEqual(["REFUSED", "SPENT"]);
    expect(decodeReceipt(await j.submit(issued)).position).toBe(1n);
  });

  it("refuses to open a journal file of another construction, and a scope whose terms name another", async () => {
    const f = fixture(), j = f.create();
    await j.open("genesis", f.signed); j.close();
    // The same file opened as a pool-v3 journal: the identity names lit's domain.
    expect(() => f.create(true)).toThrow(expect.objectContaining({ code: "STORAGE", message: "journal identity does not match" }));
    const other = fixture(), pool = other.create(true);
    // Lit terms do not decode under the pool's construction clause.
    expect(await refusal(pool.open("genesis", other.signed))).toEqual(["REFUSED", "TERMS"]);
  });

  it("reopens from its rows, rebuilding its outputs from the trail it serves, and keeps admitting", async () => {
    const f = fixture(), segment = f.segment;
    let j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const issued = f.issue(segment, 10n, ALICE), [note] = f.outputsOf(issued);
    const paid = f.spend(segment, [note!], [f.to(4n, BOB), f.to(6n, ALICE)], [ALICE]), [bobs] = f.outputsOf(paid);
    const receipt = await j.submit(issued); await j.submit(paid);
    await j.commit("c2"); await j.publish();
    j.close();
    j = f.create();
    expect(await j.submit(issued)).toEqual(receipt);
    // C2.8.2: a restarted journal waits the lag before it signs again.
    f.venue.advance(f.venue.witnessedIndex() + lag);
    const toCarol = f.spend(segment, [bobs!], [f.to(4n, CAROL)], [BOB]), [carols] = f.outputsOf(toCarol);
    expect(decodeReceipt(await j.submit(toCarol)).position).toBe(3n);
    await j.commit("c3"); await j.publish();
    expect((await f.read(await j.package())).state.position).toBe(3n);
    // Admitted after the last commitment, and so in no signed snapshot.
    await j.submit(f.spend(segment, [carols!], [f.to(4n, ALICE)], [CAROL]));
    // No root in a lit snapshot checks the output set (lit-v1 §10): an output row changed behind the journal is found on
    // reopening, here the latest, which only the admission state's tip reaches.
    j.close();
    const db = new DatabaseSync(f.file), { ns } = db.prepare("SELECT ns FROM journal_state WHERE id = 1").get() as { ns: number };
    expect(db.prepare("UPDATE output SET cm = ? WHERE ns = ? AND leaf = (SELECT MAX(leaf) FROM output WHERE ns = ?)").run(b(66), ns, ns).changes).toBe(1);
    db.close();
    expect(await refusal(f.create().status())).toEqual(["STORAGE", undefined]);
  });

  it("refuses on reopening an output row past its tip, and a trail record that no longer chains, as storage", async () => {
    const f = fixture(), segment = f.segment;
    let j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const issued = f.issue(segment, 10n, ALICE), [note] = f.outputsOf(issued);
    await j.submit(issued); await j.submit(f.spend(segment, [note!], [f.to(10n, BOB)], [ALICE]));
    await j.commit("c2"); await j.publish();
    j.close();
    // A phantom note's row one position past the tip would become visible, and spendable, at the next admission.
    let db = new DatabaseSync(f.file);
    const { ns } = db.prepare("SELECT ns FROM journal_state WHERE id = 1").get() as { ns: number };
    const phantom: Opening = { backing: f.backing, value: 1000n, owner: pub(MALLORY), rho: b(88) };
    const row = db.prepare("INSERT INTO output (cm, ns, position, leaf, capsule, settlement) VALUES (?, ?, 3, 1000, NULL, 0)");
    expect(row.run(noteCommitment(DOMAIN, phantom), ns).changes).toBe(1);
    db.close();
    j = f.create();
    expect(await refusal(j.status())).toEqual(["STORAGE", undefined]);
    j.close();
    db = new DatabaseSync(f.file);
    db.prepare("DELETE FROM output WHERE leaf = 1000").run();
    // The trail's first record replaced: the second no longer chains to the stored evidence.
    expect(db.prepare("UPDATE chain SET bytes = ? WHERE position = 1").run(Uint8Array.of(0, 0, 0, 1, 1, 0, 0, 0, 0)).changes).toBe(1);
    db.close();
    expect(await refusal(f.create().status())).toEqual(["STORAGE", undefined]);
  });

  it("refuses on reopening a demand row the trail did not stand up, from which a settlement would derive its output", async () => {
    const f = fixture(), j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const now = f.venue.witnessedIndex();
    const issued = f.issue(f.segment, 10n, ALICE), [note] = f.outputsOf(issued);
    await j.submit(issued); await j.submit(f.demand(f.segment, [note!], [ALICE], now, now + 200n));
    await j.commit("c2"); await j.publish();
    j.close();
    const db = new DatabaseSync(f.file);
    expect(db.prepare("UPDATE demand SET quantity = '1000'").run().changes).toBe(1);
    db.close();
    expect(await refusal(f.create().status())).toEqual(["STORAGE", undefined]);
  });

  it("reopens after a demand stood up in one segment is settled in its successor and a third segment imports both", async () => {
    const f = fixture(), j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const now = f.venue.witnessedIndex();
    const issued = f.issue(f.segment, 10n, ALICE), [note] = f.outputsOf(issued);
    const presented = f.demand(f.segment, [note!], [ALICE], now, now + 200n);
    await j.submit(issued); await j.submit(presented);
    await j.commit("c2"); await j.publish();
    await j.rescope("p", { keep: [f.backing] }); await j.publish(); await j.adopt();
    const p = litSegmentIdentity(await f.header(j)), settled = f.settle(p, presented, CAROL, now + 150n);
    const [carols] = derivedOutputs(LIT.decode(settled).statement, LIT.decode(presented).statement as never);
    await j.submit(settled); await j.commit("c4"); await j.publish();
    await j.rescope("q", { keep: [f.backing] }); await j.publish(); await j.adopt();
    const q = litSegmentIdentity(await f.header(j));
    await j.submit(f.spend(q, [carols!], [f.to(10n, BOB)], [CAROL]));
    await j.commit("c6"); await j.publish();
    const served = await j.package();
    expect((await f.read(served)).state.position).toBe(1n);
    // Each imported copy is rebuilt; the settlement's demand is read from the closure the third segment imports.
    j.close();
    const reopened = f.create();
    expect(await reopened.package()).toEqual(served);
    expect((await reopened.status()).signed?.sequence).toBe(6n);
    await reopened.audit();
  });

  it("changes scope electively after its tail is witnessed, importing its own state, and spends an imported note", async () => {
    const f = fixture(), j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const issued = f.issue(f.segment, 10n, ALICE), [note] = f.outputsOf(issued);
    await j.submit(issued);
    expect(await refusal(j.rescope("again", { keep: [f.backing] }))).toEqual(["STALE", "TAIL"]);
    await j.commit("c2"); await j.publish();
    const opening = await j.rescope("again", { keep: [f.backing] });
    expect(opening.sequence).toBe(3n);
    expect(await j.rescope("again", { keep: [f.backing] })).toEqual(opening);
    await j.publish(); expect(await j.adopt()).toEqual([]);
    const next = await f.header(j), segment = litSegmentIdentity(next);
    expect(next.entries).toEqual([{ backing: f.backing, link: f.backing, opening: { operator, sequence: 2n, root: expect.any(Uint8Array) } }]);
    expect(decodeReceipt(await j.submit(f.spend(segment, [note!], [f.to(10n, BOB)], [ALICE]))).position).toBe(1n);
    await j.commit("c4"); await j.publish();
    const served = await j.package(), read = await f.read(served);
    expect([read.state.position, read.state.issued, read.state.eventCount()]).toEqual([1n, 10n, 2n]);
    // A fresh process derives the same journal, its imported outputs rebuilt from the predecessor's trail.
    j.close();
    const reopened = f.create();
    expect(await reopened.package()).toEqual(served);
    f.venue.advance(f.venue.witnessedIndex() + lag);
    expect(await refusal(reopened.submit(f.spend(segment, [note!], [f.to(10n, CAROL)], [ALICE])))).toEqual(["REFUSED", "SPENT"]);
    await reopened.audit();
  });

  it("returns after silence and adopts a forced lit demand published on the venue (C2b.4)", async () => {
    const f = fixture({ silence: { noCommitmentDuration: 4n } }), j = f.create();
    await j.open("genesis", f.signed); await j.publish();
    const issued = f.issue(f.segment, 10n, ALICE), [note] = f.outputsOf(issued);
    await j.submit(issued); await j.commit("c2"); await j.publish();
    const held = f.venue.witnessedIndex();
    f.venue.advance(held + 4n);
    expect(await refusal(j.submit(f.issue(f.segment, 1n, ALICE)))).toEqual(["SCHEDULE", "SILENCE"]);
    expect(await refusal(j.return("early"))).toEqual(["STALE", undefined]);
    f.venue.advance(held + 6n);
    const now = f.venue.witnessedIndex();
    const presented = f.demand(f.segment, [note!], [ALICE], now - 1n, now + 30n);
    await f.venue.publishRecord(4, f.backing, encodePublication({ domain: DOMAIN, backing: f.backing, kind: 1, record: LIT.decode(presented) }));
    const opening = await j.return("returned");
    expect(await j.return("returned")).toEqual(opening);
    await j.publish();
    const receipts = await j.adopt();
    expect(receipts.map(bytes => hex(decodeReceipt(bytes).statementHash))).toEqual([hex(statementHash(LIT.decode(presented).statement))]);
    const returned = await f.header(j);
    expect(returned.entries.map(entry => entry.opening?.sequence)).toEqual([2n]);
    await j.commit("adopted"); await j.publish();
    const read = await f.read(await j.package());
    expect([read.state.issued, read.state.position, read.state.demands().length]).toEqual([10n, 1n, 1]);
    expect(same(read.state.segment, litSegmentIdentity(returned))).toBe(true);
  });
});
