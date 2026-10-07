import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { prepareExactOutput, deriveSettlementOwnerSecret } from "../src/pool/v3/capsules.js";
import { decodeReceipt, encodeReceipt, verifyReceipt } from "../src/pool/v3/commitments.js";
import { segmentIdentity } from "../src/pool/v3/headers.js";
import { ScopeTree } from "../src/pool/scope.js";
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
import { encodeCommitment, isEquivocation, signCommitment } from "../src/venue-records.js";

// An adopted block the opening's state refuses: no input reaches one (the reader forced each record against the
// state the opening imports), so the test refuses through the state machine's own judgment.
const adoption = vi.hoisted(() => ({ refuse: undefined as string | undefined }));
vi.mock("../src/pool/v3/state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/pool/v3/state.js")>(), { ReplayRefusal } = await import("../src/pool/v3/refusals.js");
  return { ...actual, judgeAdopted: (...args: Parameters<typeof actual.judgeAdopted>) => {
    if (adoption.refuse !== undefined) throw new ReplayRefusal(adoption.refuse);
    return actual.judgeAdopted(...args);
  } };
});

// Journal and reader integration with explicit stand-in proofs. The companion
// recovery-store-check.mjs runs these recovery builders under all real keys.
const b = (n: number) => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(17);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
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
  async function fixture(noCommitmentDuration = 4n) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-recovery-journal-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: "recovery units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration, challengeWindow: 5n }, nonService: { duration: 2n, count: 1n, window: 5n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const funded = prepareExactOutput(b(21), domain, b(31), backing, 10n), pad = prepareExactOutput(b(21), domain, b(32), backing, 0n);
    const tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) }, inputs = [input, { ...input, note: pad }];
    const file = join(directory, "journal.db"), j = new V3OperatorJournal(file, { secret: operatorSecret, venue, reference,
      verifier }); journals.push(j);
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
    const settle = (d: Record, deadline: bigint, secret = presenterSecret, acceptor = issuerSecret) => {
      const id = statementHash(d), ownerSecret = deriveSettlementOwnerSecret(b(22), domain, id, deadline).value;
      const opening = { backing, value: 10n, owner: ownerOf(ownerSecret), rho: 42n }, output = { opening, cm: commitmentOf(domain, opening) };
      const acceptance = authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline }, acceptor);
      return authorizeSettlement(record(settleTask(context, inputs, output, id)), acceptance, secret);
    };
    const publication = (kind: 1 | 3 | 4 | 5, r: Record) => encodePublication({ domain, backing, kind, record: r });
    return { j, file, venue, context, inputs, input, backing, held, read, demand, settle, publication };
  }

  it("serves holder demand, authorized withdrawal and inclusive-deadline settlement with unchanged supply", async () => {
    const f = await fixture(), first = f.demand(2n, 6n);
    const receipt = await f.j.submit(encodeRecord(first));
    expect(await f.j.submit(encodeRecord(first))).toEqual(receipt);
    const withdraw = withdrawalRecord(f.context, statementHash(first), presenterSecret);
    await f.j.submit(encodeRecord(withdraw));
    const second = f.demand(1n, 7n), settled = f.settle(second, 4n);
    const filed = await f.j.submit(encodeRecord(second));
    // An acceptance K did not sign is refused at admission, whoever released (C3.5).
    await expect(f.j.submit(encodeRecord(f.settle(second, 4n, presenterSecret, b(91))))).rejects.toMatchObject({ code: "REFUSED", check: "SIGNATURE" });
    const closing = await f.j.submit(encodeRecord(settled));
    expect(decodeReceipt(closing).position).toBe(5n);
    // Demand, withdrawal and settlement receipts verify under the segment's authority, each bound to its own statement.
    const header = f.context.header, authority = { domain, segment: segmentIdentity(header), scopeRoot: new ScopeTree(header.entries).root(), operator };
    const receipts = [receipt, await f.j.submit(encodeRecord(withdraw)), filed, closing].map(decodeReceipt);
    expect(receipts.map(r => verifyReceipt(authority, r))).toEqual([true, true, true, true]);
    expect(verifyReceipt(authority, { ...receipts[3]!, statementHash: receipts[2]!.statementHash })).toBe(false);
    await f.j.commit("settled"); await f.j.publish();
    const result = await f.read(await f.j.package());
    expect(result.state.issued - result.state.burned).toBe(10n);
    expect(result.state.demands().length).toBe(0);
    expect(result.state.hasNullifier(f.input.note.nf)).toBe(true);
    expect(result.state.position).toBe(5n);
  });

  it("answers an exact repeat of an ended demand, its withdrawal or its settlement with the first receipt, and refuses the other exit (C3.6-7, inv 26)", async () => {
    const f = await fixture(), first = f.demand(2n, 6n), withdraw = withdrawalRecord(f.context, statementHash(first), presenterSecret);
    const receipts = [await f.j.submit(encodeRecord(first)), await f.j.submit(encodeRecord(withdraw))];
    // The withdrawn demand leaves the record: it can be settled no more.
    await expect(f.j.submit(encodeRecord(f.settle(first, 4n)))).rejects.toMatchObject({ code: "REFUSED", check: "DEMAND" });
    const second = f.demand(1n, 7n), settled = f.settle(second, 4n);
    receipts.push(await f.j.submit(encodeRecord(second)), await f.j.submit(encodeRecord(settled)));
    await expect(f.j.submit(encodeRecord(withdrawalRecord(f.context, statementHash(second), presenterSecret))))
      .rejects.toMatchObject({ code: "REFUSED", check: "DEMAND" });
    // Past every deadline, after a commit and a publication, each exact repeat is answered before any door judges it.
    await f.j.commit("ended"); await f.j.publish(); f.venue.advance(8n - f.venue.witnessedIndex());
    // A new demand over the settled note is judged, and refused.
    await expect(f.j.submit(encodeRecord(f.demand(6n, 12n)))).rejects.toMatchObject({ code: "REFUSED", check: "LOCKED" });
    for (const [i, r] of [first, withdraw, second, settled].entries()) expect(await f.j.submit(encodeRecord(r))).toEqual(receipts[i]);
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

  /** The fixture's journal directory copied while the journal is closed (an owner's backup), the original reopened,
   * and a way to open the copy (M13d). */
  async function copied(f: Awaited<ReturnType<typeof fixture>>) {
    f.j.close();
    const directory = f.file.slice(0, -"/journal.db".length), copy = `${directory}-copy`; directories.push(copy);
    cpSync(directory, copy, { recursive: true });
    const open = (file: string, restored?: boolean) => {
      const j = new V3OperatorJournal(file, { secret: operatorSecret, venue: f.venue, reference, verifier, restored }); journals.push(j); return j;
    };
    return { original: open(f.file), copy: (restored?: boolean) => open(join(copy, "journal.db"), restored) };
  }

  /** The receipt verdict a reader draws from what `j` serves, judging at the venue's index. */
  async function verdict(f: Awaited<ReturnType<typeof fixture>>, j: Journal, receipt: Uint8Array) {
    const served = await j.package(), items = decodeEvidencePackage(served.package);
    return (await readPackage(encodeEvidencePackage([...items, { kind: 10, payload: receipt }]),
      { ...served.selection, judgingIndex: f.venue.witnessedIndex(), mode: "current-fixture" }, { verifier, venue: f.venue, reference })).receipt;
  }
  /** A venue view that takes no publication: the lost instance's commitments go unwitnessed. */
  const dropping = (venue: FixtureVenue) => ({ get id() { return venue.id; }, lag: () => venue.lag(), witnessedIndex: () => venue.witnessedIndex(),
    range: venue.range.bind(venue), publishRecord: async () => {} }) as unknown as FixtureVenue;

  it("refuses a copied journal; a restored copy signs only a return past every sequence its lost instance signed, where the lost tail lapses (M13d)", async () => {
    const f = await fixture(12n), { original, copy } = await copied(f);
    original.close();
    // The lost instance, at its own file, co-signs a demand, commits it unwitnessed and co-signs a withdrawal after.
    const lost = new V3OperatorJournal(f.file, { secret: operatorSecret, venue: dropping(f.venue), reference, verifier }); journals.push(lost);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    const first = f.demand(f.venue.witnessedIndex()), tail = decodeReceipt(await lost.submit(encodeRecord(first)));
    const unwitnessed = await lost.commit("later"); await lost.publish();
    const after = decodeReceipt(await lost.submit(encodeRecord(withdrawalRecord(f.context, statementHash(first), presenterSecret))));
    expect([tail.position, unwitnessed.sequence, after.after]).toEqual([2n, 3n, 3n]);
    lost.close();
    expect(() => copy()).toThrow(expect.objectContaining({ code: "COPIED" }));
    const restored = copy(true);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    // Deny by default: nothing but the return.
    const other = encodeRecord(f.demand(f.venue.witnessedIndex(), 20n, b(18)));
    await expect(restored.submit(other)).rejects.toMatchObject({ code: "RESTORED" });
    await expect(restored.commit("keep-alive")).rejects.toMatchObject({ code: "RESTORED" });
    await expect(restored.rescope("repair", { keep: [f.backing] })).rejects.toMatchObject({ code: "RESTORED" });
    await expect(restored.open("genesis-2", [])).rejects.toMatchObject({ code: "RESTORED" });
    await expect(restored.return("early")).rejects.toMatchObject({ code: "STALE" });
    // Recording the restoration again before its return keeps its index and spacing.
    const at = (await restored.status()).restoredAt!;
    restored.close();
    const again = copy(true);
    expect((await again.status()).restoredAt).toBe(at);
    f.venue.advance(f.venue.witnessedIndex() + 16n);
    const opening = await again.return("restored");
    expect(opening.sequence > unwitnessed.sequence + (1n << 16n)).toBe(true);
    expect(opening.sequence % (1n << 16n)).toBe(2n);
    expect(isEquivocation(unwitnessed, opening)).toBe(false);
    expect(await again.return("restored")).toEqual(opening);
    expect((await again.status()).restoredOpening).toBe(opening.sequence);
    await expect(again.return("second")).rejects.toMatchObject({ code: "STALE" });
    await again.publish();
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    expect(await again.adopt()).toEqual([]);
    expect((await again.status()).restoredAt).toBeUndefined();
    // The lost tail lapses, the receipt given after the unwitnessed commitment included; none reads invalid.
    for (const receipt of [tail, after]) expect(await verdict(f, again, encodeReceipt(receipt))).toMatchObject({ status: "lapsed" });
    const next = await again.commit("served"); await again.publish();
    expect(next.sequence).toBe(opening.sequence + 1n);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    expect((await again.package()).selection.sequence).toBe(next.sequence);
    await again.audit();
    // A reader served through the lost instance's in-flight commitment, inside the skip, is served from the return on.
    let served = 0;
    for await (const _ of (await again.serve(f.backing, unwitnessed.sequence)).parts) served++;
    expect(served).toBeGreaterThan(0);
    // The lost instance's commitment landing late, inside the skip, is no conflict: the record moved past it.
    f.venue.witness(1, operator, f.venue.witnessedIndex(), encodeCommitment(unwitnessed));
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    const late = await again.commit("after-late"); await again.publish();
    expect(late.sequence).toBe(next.sequence + 1n);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    for (const receipt of [tail, after]) expect(await verdict(f, again, encodeReceipt(receipt))).toMatchObject({ status: "lapsed" });
    // Reopened, it reads its rows across the skip.
    again.close();
    const reopened = copy(); expect((await reopened.package()).selection.sequence).toBe(late.sequence); reopened.close();
    // A skipped range that disagrees with the signed rows is damage.
    const raw = new DatabaseSync(join(`${f.file.slice(0, -"/journal.db".length)}-copy`, "journal.db"));
    raw.prepare("UPDATE journal_skipped SET below=below+1").run(); raw.close();
    const damaged = copy();
    await expect(damaged.package()).rejects.toMatchObject({ code: "STORAGE", message: "a signed row is missing" });
    await expect(damaged.status()).rejects.toMatchObject({ code: "STORAGE", message: "a skipped range disagrees with the signed rows" });
    // The obsolete lost instance, restarted, publishes and signs nothing under the restored return.
    const obsolete = new V3OperatorJournal(f.file, { secret: operatorSecret, venue: f.venue, reference, verifier }); journals.push(obsolete);
    await expect(obsolete.publish()).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(obsolete.submit(other)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("restores a copy taken after the restoration's return was signed as a restoration of its own (M13d)", async () => {
    const f = await fixture(12n), { original, copy } = await copied(f);
    original.close();
    const first = copy(true);
    f.venue.advance(f.venue.witnessedIndex() + 16n);
    const opening = await first.return("restored"); await first.publish();
    first.close();
    // A backup of the restored directory, taken now, and restored once the first has adopted and served on.
    const directory = f.file.slice(0, -"/journal.db".length), later = `${directory}-later`; directories.push(later);
    cpSync(`${directory}-copy`, later, { recursive: true });
    const live = copy();
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await live.adopt();
    live.close();
    const second = new V3OperatorJournal(join(later, "journal.db"), { secret: operatorSecret, venue: f.venue, reference, verifier, restored: true });
    journals.push(second);
    expect((await second.status()).restoredOpening).toBeUndefined();
    // The first restoration's return is adopted as any pending opening, and the fence stands.
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await second.adopt();
    expect((await second.status()).restoredAt).toBeDefined();
    await expect(second.commit("served")).rejects.toMatchObject({ code: "RESTORED" });
    f.venue.advance(f.venue.witnessedIndex() + 16n);
    // The earlier restoration's identifier answers nothing under this one.
    await expect(second.return("restored")).rejects.toMatchObject({ code: "RESTORED" });
    const next = await second.return("restored-again");
    expect(next.sequence > opening.sequence + (1n << 16n)).toBe(true);
    // Past the lost instance's band, a commitment of this key in the gap is another signer's: a conflict (invariant 22).
    await second.publish();
    f.venue.witness(1, operator, f.venue.witnessedIndex(), encodeCommitment(signCommitment(operatorSecret, next.sequence - 5n, b(9))));
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await expect(second.adopt()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps a restored copy refused when the record holds a commitment it did not sign (M13d)", async () => {
    const f = await fixture(12n), { original, copy } = await copied(f);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await original.submit(encodeRecord(f.demand(f.venue.witnessedIndex())));
    await original.commit("later"); await original.publish(); original.close();
    const restored = copy(true);
    f.venue.advance(f.venue.witnessedIndex() + 16n);
    await expect(restored.return("restored")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(restored.publish()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("adopts a return the copy already held as the lost instance would, keeping the fence until its own opening (M13d)", async () => {
    const f = await fixture(12n);
    f.venue.advance(16n);
    const first = await f.j.return("return"); await f.j.publish();
    const { original, copy } = await copied(f);
    original.close();
    const restored = copy(true);
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await restored.adopt();
    expect((await restored.status()).restoredAt).toBeDefined();
    expect((await restored.package()).selection.sequence).toBe(first.sequence);
    await expect(restored.commit("served")).rejects.toMatchObject({ code: "RESTORED" });
    f.venue.advance(f.venue.witnessedIndex() + 16n);
    const opening = await restored.return("restored"); await restored.publish();
    f.venue.advance(f.venue.witnessedIndex() + lag + 1n);
    await restored.adopt();
    expect((await restored.status()).restoredAt).toBeUndefined();
    expect((await restored.package()).selection.sequence).toBe(opening.sequence);
  });

  it("refuses the silence horizon before retiring the tail at a witnessed boundary", async () => {
    const f = await fixture(), admitted = f.demand(0n, 6n), receipt = await f.j.submit(encodeRecord(admitted)); f.venue.advance(5n);
    await expect(f.j.submit(encodeRecord(f.demand(5n)))).rejects.toMatchObject({ code: "SCHEDULE", check: "SILENCE" });
    // An exact repeat of a statement admitted before the horizon is still answered with its receipt (inv 26).
    expect(await f.j.submit(encodeRecord(admitted))).toEqual(receipt);
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

  it("checks for a conflict appearing during the adoption read before signing any receipt", async () => {
    let duringRead = () => {};
    const f = await fixture(); f.venue.advance(7n);
    await f.venue.publishRecord(4, f.backing, f.publication(1, f.demand(6n)));
    await f.j.return("return"); await f.j.publish();
    const saved = await f.j.package(), twin = encodeCommitment(signCommitment(operatorSecret, 1n, b(255)));
    // A witnessed index is final (§13.2): a record witnessed during the read moves the venue's clock, and
    // the adoption judged by the earlier view signs nothing. Kept state holds every proof already judged, so the
    // adoption verifies none and the change lands at its first venue range instead.
    duringRead = () => {
      duringRead = () => {};
      f.venue.advance(f.venue.witnessedIndex() + 1n); f.venue.witness(1, operator, f.venue.witnessedIndex(), twin);
    };
    const range = f.venue.range.bind(f.venue), ranges = vi.spyOn(f.venue, "range").mockImplementation((...args) => { duringRead(); return range(...args); });
    const sign = vi.spyOn(ed25519, "sign");
    try {
      await expect(f.j.adopt()).rejects.toMatchObject({ code: "STALE", message: "the venue changed during the journal operation" });
      expect(sign).not.toHaveBeenCalled();
    } finally { sign.mockRestore(); ranges.mockRestore(); }
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

  it("names an adopted block the opening's state refuses, and keeps none of it (C2b.4.2)", async () => {
    const f = await fixture(); f.venue.advance(7n);
    await f.venue.publishRecord(4, f.backing, f.publication(1, f.demand(6n)));
    await f.j.return("return"); await f.j.publish();
    adoption.refuse = "DEADLINE";
    try { await expect(f.j.adopt()).rejects.toMatchObject({ name: "V3StoreError", code: "REFUSED", check: "DEADLINE" }); } finally { adoption.refuse = undefined; }
    // Nothing of the refused block was kept: the adoption judged again takes it whole.
    expect((await f.j.adopt()).map(bytes => decodeReceipt(bytes).position)).toEqual([1n]);
  });

  it("keeps a package read's refusal when its evidence then fails to close, with that failure as its cause", async () => {
    const f = await fixture(), selection = { ...f.held.selection, root: new Uint8Array(32), judgingIndex: f.venue.witnessedIndex(), mode: "current-fixture" as const };
    const close = vi.spyOn(EvidenceStore.prototype, "close").mockImplementation(() => { throw new Error("disk I/O error"); });
    let error: unknown;
    try { error = await readPackage(f.held.package, selection, { verifier, venue: f.venue, reference }).then(() => undefined, (e: unknown) => e); }
    finally { close.mockRestore(); }
    expect(error).toMatchObject({ status: "selection-mismatch", cause: { message: "disk I/O error" } });
  });

  it("refuses to serve an older segment of its own whose trail storage lost, as storage", async () => {
    const f = await fixture(); f.venue.advance(7n);
    await f.j.return("return"); await f.j.publish(); await f.j.adopt();
    await f.j.commit("adopted"); await f.j.publish();
    expect((await f.j.package()).selection.sequence).toBe(4n);
    // The genesis segment's one record is lost; its head stays, so its opening checkpoint is still served.
    const { DatabaseSync } = await import("node:sqlite"), db = new DatabaseSync(f.file);
    try { expect(Number(db.prepare("DELETE FROM chain WHERE segment = ?").run(segmentIdentity(f.context.header)).changes)).toBe(1); } finally { db.close(); }
    await expect(f.j.package()).rejects.toMatchObject({ code: "STORAGE", message: "a signed segment's trail is missing" });
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

  it("reads a receipt the held checkpoints have not yet reached as pending, and final once its checkpoint is held (C2b.4)", async () => {
    const f = await fixture(), receipt = await f.j.submit(encodeRecord(f.demand(1n)));
    const verdict = async () => {
      const served = await f.j.package(), items = decodeEvidencePackage(served.package);
      return (await readPackage(encodeEvidencePackage([...items, { kind: 10, payload: receipt }]),
        { ...served.selection, judgingIndex: f.venue.witnessedIndex(), mode: "current-fixture" }, { verifier, venue: f.venue, reference })).receipt;
    };
    expect(await verdict()).toMatchObject({ status: "pending", includedAt: [], contradictedAt: [] });
    // Signed and published, the commitment carrying it makes the receipt final.
    await f.j.commit("carrying"); await f.j.publish();
    expect(await verdict()).toMatchObject({ status: "final" });
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
