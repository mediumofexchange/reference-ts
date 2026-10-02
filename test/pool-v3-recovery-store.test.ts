import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../src/pool/v3/capsules.js";
import { decodeReceipt, encodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { readPackage } from "../src/pool/v3/package-reader.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { describeState } from "./pool-v3-state-description.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodePublication, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal, ServedPackage } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, demandTask, issueTask, requestTask, settleTask,
  withdrawalRecord, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeCommitment, signCommitment } from "../src/venue-records.js";

// Journal and reader integration with explicit stand-in proofs. The companion
// recovery-store-check.mjs runs these recovery builders under all real keys.
const b = (n: number) => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(17);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

describe("v3 recovery journal and independent package reader", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  const journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => { ({ V3OperatorJournal } = await import("../src/pool/v3/store.js")); });
  afterEach(() => {
    for (const j of journals.splice(0)) j.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function fixture(beforeVerify = () => {}) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-recovery-journal-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: "recovery units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: 4n, challengeWindow: 5n }, nonService: { duration: 2n, count: 1n, window: 5n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const funded = prepareExactOutput(b(21), domain, b(31), backing, 10n), pad = prepareExactOutput(b(21), domain, b(32), backing, 0n);
    const tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) }, inputs = [input, { ...input, note: pad }];
    const j = new V3OperatorJournal(join(directory, "journal.db"), { secret: operatorSecret, venue, reference,
      verifier: { verify: (...args) => { beforeVerify(); return verifier.verify(...args); } } }); journals.push(j);
    await j.open("genesis", signed); await j.publish();
    await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)));
    await j.commit("issued"); await j.publish();
    const held = await j.package();
    const read = async (served: ServedPackage = held) => {
      const result = await readPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        { verifier, venue, reference });
      if (result.state === undefined) throw new Error("unexpected receipt verdict");
      return result;
    };
    const demand = (instant: bigint, deadline = 20n, secret = presenterSecret) => record(demandTask(context, inputs,
      { backing, quantity: 10n, presenter: ed25519.getPublicKey(secret), instant, deadline }));
    const settle = (d: Record, deadline: bigint, secret = presenterSecret) => {
      const id = statementHash(d), ownerSecret = deriveSettlementOwnerSecret(b(22), domain, id, deadline).value;
      const opening = { backing, value: 10n, owner: ownerOf(ownerSecret), rho: 42n }, output = { opening, cm: commitmentOf(domain, opening) };
      const acceptance = authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline }, issuerSecret);
      return authorizeSettlement(record(settleTask(context, inputs, output, id)), acceptance, secret);
    };
    const publication = (kind: 1 | 3 | 4 | 5, r: Record) => encodePublication({ domain, backing, kind, record: r });
    return { j, venue, context, inputs, input, backing, held, read, demand, settle, publication };
  }

  it("serves holder demand, authorized withdrawal and inclusive-deadline settlement with unchanged supply", async () => {
    const f = await fixture(), first = f.demand(2n, 6n);
    const receipt = await f.j.submit(encodeRecord(first));
    expect(await f.j.submit(encodeRecord(first))).toEqual(receipt);
    const withdraw = withdrawalRecord(f.context, statementHash(first), presenterSecret);
    await f.j.submit(encodeRecord(withdraw));
    const second = f.demand(1n, 7n), settled = f.settle(second, 4n);
    await f.j.submit(encodeRecord(second));
    expect(decodeReceipt(await f.j.submit(encodeRecord(settled))).position).toBe(5n);
    await f.j.commit("settled"); await f.j.publish();
    const result = await f.read(await f.j.package());
    expect(result.state.issued - result.state.burned).toBe(10n);
    expect(result.state.demands().length).toBe(0);
    expect(result.state.hasNullifier(f.input.note.nf)).toBe(true);
    expect(result.state.position).toBe(5n);
  });

  it("refuses strict demand deadlines, invalid instants, wrong withdrawal keys and expired acceptance", async () => {
    const f = await fixture();
    for (const r of [f.demand(2n, 4n), f.demand(3n), f.demand(0n, 3n)]) {
      await expect(f.j.submit(encodeRecord(r))).rejects.toMatchObject({ code: "REFUSED", check: "DEADLINE" });
    }
    const d = f.demand(2n); await f.j.submit(encodeRecord(d));
    await expect(f.j.submit(encodeRecord(withdrawalRecord(f.context, statementHash(d), b(90)))))
      .rejects.toMatchObject({ code: "REFUSED", check: "SIGNATURE" });
    await expect(f.j.submit(encodeRecord(f.settle(d, 3n)))).rejects.toMatchObject({ code: "REFUSED", check: "DEADLINE" });
    await f.j.submit(encodeRecord(f.settle(d, 4n)));
  });

  it("refuses the silence horizon before retiring the tail at a witnessed boundary", async () => {
    const f = await fixture(); f.venue.advance(5n);
    await expect(f.j.submit(encodeRecord(f.demand(5n)))).rejects.toMatchObject({ code: "SCHEDULE", check: "SILENCE" });
    await expect(f.j.return("too-early")).rejects.toMatchObject({ code: "STALE" });
    expect((await f.read()).clock!.boundary).toBeNull();
    f.venue.advance(7n);
    expect((await f.read()).clock!.boundary).toBe("7");
    const opening = await f.j.return("returned");
    expect(await f.j.return("returned")).toEqual(opening);
    await expect(f.j.adopt()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await f.j.publish(); expect(await f.j.adopt()).toEqual([]);
  });

  it("refuses return and adoption after an authentic hidden commitment from the same key", async () => {
    const f = await fixture(); f.venue.advance(7n);
    f.venue.witness(1, operator, 7n, encodeCommitment(signCommitment(operatorSecret, 1n, b(255))));
    await expect(f.j.return("compromised-return")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.j.package()).toEqual(f.held);

    const g = await fixture(); g.venue.advance(7n);
    const opening = await g.j.return("return"); await g.j.publish();
    g.venue.witness(1, operator, g.venue.witnessedIndex(),
      encodeCommitment(signCommitment(operatorSecret, 1n, b(255))));
    await expect(g.j.adopt()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await g.j.return("return")).toEqual(opening);
    expect((await g.j.package()).selection.sequence).toBe(opening.sequence);
  });

  it("checks for a conflict appearing during adoption verification before signing any receipt", async () => {
    let duringProof = () => {};
    const f = await fixture(() => duringProof()); f.venue.advance(7n);
    await f.venue.publishRecord(4, f.backing, f.publication(1, f.demand(6n)));
    await f.j.return("return"); await f.j.publish();
    const saved = await f.j.package(), twin = encodeCommitment(signCommitment(operatorSecret, 1n, b(255)));
    // A witnessed index is final (§13.2): a record witnessed during verification moves the venue's clock, and
    // the adoption judged by the earlier view signs nothing.
    duringProof = () => {
      duringProof = () => {};
      f.venue.advance(f.venue.witnessedIndex() + 1n); f.venue.witness(1, operator, f.venue.witnessedIndex(), twin);
    };
    const sign = vi.spyOn(ed25519, "sign");
    try {
      await expect(f.j.adopt()).rejects.toMatchObject({ code: "STALE" });
      expect(sign).not.toHaveBeenCalled();
    } finally { sign.mockRestore(); }
    // Failed adoption must not persist receipts or make exact retry succeed.
    await expect(f.j.adopt()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.j.package()).toEqual(saved);
  });

  it("reads force without the journal and adopts exact venue order including settlement at return index", async () => {
    const f = await fixture(); f.venue.advance(7n);
    const first = f.demand(6n), withdrawal = withdrawalRecord(f.context, statementHash(first), presenterSecret);
    const second = f.demand(8n, 21n, b(18)), settlement = f.settle(second, 20n, b(18));
    await f.venue.publishRecord(4, f.backing, f.publication(1, first));
    await f.venue.publishRecord(4, f.backing, f.publication(4, withdrawal));
    await f.venue.publishRecord(4, f.backing, f.publication(1, second));
    const missing = await f.read();
    expect(missing.force.map(f => f.record.kind)).toEqual([4, 5, 4]);
    expect(missing.canonical.state.issued - missing.canonical.state.burned).toBe(10n);
    await f.j.return("return");
    await expect(f.j.commit("before-opening-held")).rejects.toMatchObject({ code: "STALE" });
    await f.j.publish();
    f.venue.witness(4, f.backing, f.venue.witnessedIndex(), f.publication(3, settlement));
    const expected = [first, withdrawal, second, settlement].map(encodeRecord);
    const receipts = await f.j.adopt();
    expect(receipts.map(bytes => decodeReceipt(bytes).statementHash)).toEqual([first, withdrawal, second, settlement].map(statementHash));
    expect(await f.j.adopt()).toEqual(receipts);
    await f.j.commit("adopted"); await f.j.publish();
    const served = await f.j.package(), result = await f.read(served);
    expect(result.state.position).toBe(4n);
    expect(result.state.issued - result.state.burned).toBe(10n);
    expect(result.state.hasNullifier(f.input.note.nf)).toBe(true);
    expect(result.state.adoptionIndices.get(hex(f.backing))).toBe(11n);
    const items = decodeEvidencePackage(served.package);
    expect(items.filter(item => item.kind === 6).map(item => decodeTrail(item.payload).records)).toContainEqual(expected);
    for (const kind of [3, 4, 6]) {
      const packageBytes = encodeEvidencePackage(items.filter(item => item.kind !== kind));
      await expect(f.read({ ...served, package: packageBytes })).rejects.toMatchObject({ status: "unresolved-evidence" });
    }
    // Removing one old snapshot leaves the selected one available but loses ancestry.
    const old = items.findIndex(item => item.kind === 4);
    await expect(f.read({ ...served, package: encodeEvidencePackage(items.filter((_, i) => i !== old)) }))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
  });

  it("answers a statement adopted from the gap with the adopting segment's receipt, not its discarded tail's (C2b.4.2, §7.2)", async () => {
    const f = await fixture(); f.venue.advance(3n);
    // Admitted after the last witnessed checkpoint, never committed: a tail the return discards (C2b.4.1).
    const demand = f.demand(3n), bytes = encodeRecord(demand);
    const tail = decodeReceipt(await f.j.submit(bytes));
    // The holder publishes the same statement with force once the gap is open, and the returning segment adopts it.
    f.venue.advance(6n);
    await f.venue.publishRecord(4, f.backing, f.publication(1, demand));
    const opening = await f.j.return("return"); await f.j.publish();
    const [adopted] = await f.j.adopt(), receipt = decodeReceipt(adopted!);
    expect([receipt.statementHash, receipt.position, receipt.after]).toEqual([statementHash(demand), 1n, opening.sequence]);
    expect(receipt.segment).not.toEqual(tail.segment);
    // Exact resubmission, and a re-proof of the statement, return the adopted receipt.
    expect(await f.j.submit(bytes)).toEqual(adopted);
    const reproved = encodeRecord({ ...demand, proof: new Uint8Array(32).fill(4).fill(9, 1) });
    expect(await f.j.submit(reproved)).toEqual(adopted);
    expect(await f.j.adopt()).toEqual([adopted]);
    await f.j.audit();
    // A reader finalizes the adopted receipt once the segment commits it; the tail's lapsed at the silence boundary.
    await f.j.commit("adopted"); await f.j.publish();
    const served = await f.j.package(), items = decodeEvidencePackage(served.package);
    const verdict = async (receipt: Uint8Array) => (await readPackage(encodeEvidencePackage([...items, { kind: 10, payload: receipt }]),
      { ...served.selection, judgingIndex: f.venue.witnessedIndex(), mode: "current-fixture" }, { verifier, venue: f.venue, reference })).receipt;
    expect(await verdict(adopted!)).toMatchObject({ status: "final" });
    expect(await verdict(encodeReceipt(tail))).toMatchObject({ status: "lapsed" });
  });

  it("reads force, publications and the non-service count through kept state and retained evidence as a fresh read does", async () => {
    const f = await fixture(); f.venue.advance(7n);
    const first = f.demand(6n), withdrawal = withdrawalRecord(f.context, statementHash(first), presenterSecret), second = f.demand(8n, 21n, b(18));
    await f.venue.publishRecord(4, f.backing, f.publication(1, first));
    await f.venue.publishRecord(4, f.backing, f.publication(4, withdrawal));
    await f.venue.publishRecord(4, f.backing, f.publication(1, second));
    await f.venue.publishRecord(4, f.backing, f.publication(5, record(requestTask(domain, f.input, 0n))));
    const directory = mkdtempSync(join(scratch, "v3-recovery-kept-test-")); directories.push(directory);
    const store = new ReplayStore(join(directory, "replay.sqlite"), { digest: join(directory, "replay.sha256") });
    const evidence = new EvidenceStore(join(directory, "evidence.sqlite"));
    try {
      const identified = { verify: verifier.verify, identities: configuration.circuits };
      const read = (packageBytes: Uint8Array, kept: { store?: ReplayStore; evidence?: EvidenceStore } = {}) => readPackage(packageBytes,
        { ...f.held.selection, judgingIndex: f.venue.witnessedIndex(), mode: "current-fixture" }, { verifier: identified, venue: f.venue, reference, ...kept });
      const comparable = async (result: ReturnType<typeof read>) => {
        const r = await result;
        if (r.state === undefined) throw new Error("unexpected receipt verdict");
        return { ...r, state: describeState(r.state), canonical: { ...r.canonical, state: describeState(r.canonical.state) } };
      };
      const fresh = await comparable(read(f.held.package));
      expect(fresh.force.map(item => item.record.kind)).toEqual([4, 5, 4]);
      expect(fresh.ranges.nonService).toMatchObject({ count: "0" });
      expect(await comparable(read(f.held.package, { store, evidence }))).toEqual(fresh);
      // Later, with one more publication: the package carries only the configuration and the selected commitment.
      await f.venue.publishRecord(4, f.backing, f.publication(5, record(requestTask(domain, f.input, 1n))));
      f.venue.advance(f.venue.witnessedIndex() + 2n);
      const minimal = encodeEvidencePackage(decodeEvidencePackage(f.held.package).filter(item => item.kind === 1 || item.kind === 2));
      const later = await comparable(read(f.held.package));
      // The first request now counts, strictly before the judging index.
      expect(later.ranges.nonService).toMatchObject({ count: "1" });
      expect(await comparable(read(minimal, { store, evidence }))).toEqual(later);
      await expect(read(minimal)).rejects.toMatchObject({ status: "unresolved-evidence" });
    } finally { store.close(); evidence.close(); }
  });

  it("counts one unanswered request per tag and requires complete venue answers", async () => {
    const f = await fixture(), request = record(requestTask(domain, f.input, 0n));
    await f.venue.publishRecord(4, f.backing, f.publication(5, request));
    f.venue.advance(5n);
    expect((await f.read()).ranges.nonService).toMatchObject({ count: "1", fires: true, snapshotIndex: "2" });
    const refresh = record(requestTask(domain, f.input, 1n));
    f.venue.witness(4, f.backing, 3n, f.publication(5, refresh));
    expect((await f.read()).ranges.nonService?.count).toBe("1");
    const unavailable = { id: f.venue.id, lag: () => lag, witnessedIndex: () => 5n, range: () => undefined };
    await expect(readPackage(f.held.package, { ...f.held.selection, judgingIndex: 5n, mode: "current-fixture" },
      { verifier, venue: unavailable, reference })).rejects.toMatchObject({ status: "unresolved-evidence" });
  });
});
