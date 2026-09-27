import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../src/pool/v3/capsules.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { readSingleBackingPackage, PACKAGE_LIMITS } from "../src/pool/v3/package-reader.js";
import { decodeEvidencePackage, encodeEvidencePackage } from "../src/pool/v3/package.js";
import { TRAIL_LIMITS } from "../src/pool/v3/reader.js";
import { encodePublication, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal, ServedPackage } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, demandTask, issueTask, requestTask, settleTask,
  withdrawalRecord, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

// Journal and reader integration with explicit stand-in proofs. The companion
// recovery-store-check.mjs runs these recovery builders under all real keys.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(17);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

describe.skipIf(!supported)("v3 recovery journal and independent package reader", () => {
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
  async function fixture() {
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
    const j = new V3OperatorJournal(join(directory, "journal.db"), { configuration, secret: operatorSecret, venue, reference, verifier }); journals.push(j);
    await j.open("genesis", signed); await j.publish();
    await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)));
    await j.commit("issued"); await j.publish();
    const held = await j.package();
    const read = async (served: ServedPackage = held) => {
      const result = await readSingleBackingPackage(served.package, { ...served.selection, judgingIndex: venue.witnessedIndex(), mode: "current-fixture" },
        { configuration, verifier, venue, reference });
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
    expect(result.state.demands.size).toBe(0);
    expect(result.state.nullifiers.has(f.input.note.nf)).toBe(true);
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
    expect((await f.read()).selectedClock.boundary).toBeUndefined();
    f.venue.advance(7n);
    expect((await f.read()).selectedClock.boundary).toBe(7n);
    const opening = await f.j.return("returned");
    expect(await f.j.return("returned")).toEqual(opening);
    await expect(f.j.adopt()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await f.j.publish(); expect(await f.j.adopt()).toEqual([]);
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
    expect(result.state.nullifiers.has(f.input.note.nf)).toBe(true);
    expect(result.state.adoptionIndex).toBe(11n);
    const items = decodeEvidencePackage(served.package, PACKAGE_LIMITS);
    expect(items.filter(item => item.kind === 6).map(item => decodeTrail(item.payload, TRAIL_LIMITS).records)).toContainEqual(expected);
    for (const kind of [3, 4, 6]) {
      const packageBytes = encodeEvidencePackage(items.filter(item => item.kind !== kind), PACKAGE_LIMITS);
      await expect(f.read({ ...served, package: packageBytes })).rejects.toMatchObject({ status: "unresolved-evidence" });
    }
    // Removing one old snapshot leaves the selected one available but loses ancestry.
    const old = items.findIndex(item => item.kind === 4);
    await expect(f.read({ ...served, package: encodeEvidencePackage(items.filter((_, i) => i !== old), PACKAGE_LIMITS) }))
      .rejects.toMatchObject({ status: "unresolved-evidence" });
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
    await expect(readSingleBackingPackage(f.held.package, { ...f.held.selection, judgingIndex: 5n, mode: "current-fixture" },
      { configuration, verifier, venue: unavailable, reference })).rejects.toMatchObject({ status: "unresolved-evidence" });
  });
});
