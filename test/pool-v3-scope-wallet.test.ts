import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes } from "../src/bytes.js";
import { identifierOf } from "../src/pool/field.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput, recoverCapsule } from "../src/pool/v3/capsules.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { decodeSegmentHeader, segmentIdentity } from "../src/pool/v3/headers.js";
import { decodeEvidencePackage } from "../src/pool/v3/package.js";
import { acceptanceBytes, decodeRecord, encodePublication, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail } from "../src/pool/v3/trail.js";
import type { LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { authorizeIssue, demandTask, issueTask, withdrawalRecord, type ProofTask, type SegmentContext } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeReplacement, replacementHash, replacementMessage, type Replacement } from "../src/venue-records.js";

// Slice 7 M3: one wallet seed receives, holds, pays and re-proves notes of two
// backings whose canonical segments share, split and rejoin one scope. Stand-in
// proofs isolate custody and scope reads; scope-store-check.mjs proves a wallet
// payment in the rejoined scope under the candidate keys.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), aSecret = b(16), bSecret = b(17), ruleSecret = b(19);
const issuerX = b(14), issuerY = b(15), aKey = ed25519.getPublicKey(aSecret), bKey = ed25519.getPublicKey(bSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(32).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const same = (a: Uint8Array, z: Uint8Array) => compareBytes(a, z) === 0;
const segmentOf = (bytes: Uint8Array) => { const p = decodeRecord(bytes).publicInputs; return identifierOf(p[2]!, p[3]!); };

describe.skipIf(!supported)("v3 wallet over multi-backing scopes", () => {
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  const wallets: Wallet[] = [], journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
  });
  afterEach(() => {
    for (const wallet of wallets.splice(0)) { try { wallet.close(); } catch { /* already closed */ } }
    for (const journal of journals.splice(0)) journal.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** A opens {x, y} and issues 10 x and 20 y to the payer's requests in one shared history. */
  async function shared(silence?: bigint) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-scope-wallet-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const backingOf = (thing: string, issuer: Uint8Array) => {
      const terms = encodeRootTerms({ obligor: ed25519.getPublicKey(issuer), operator: aKey, replacementRule: ed25519.getPublicKey(ruleSecret),
        configuration: domain, venue: venue.id, interval: 30n, payout: { thing, quantumExponent: 0, perUnit: 1n },
        ...(silence === undefined ? {} : { silence: { noCommitmentDuration: silence, challengeWindow: 5n } }) });
      return { name: rootTermsName(terms), issuer, signed: { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuer) } };
    };
    const x = backingOf("scope wallet x", issuerX), y = backingOf("scope wallet y", issuerY);
    // The wallet's verifier declares the configuration's circuits, so its reads keep their state in a file (§14).
    const reader = { venue, reference, verifier: { ...verifier, identities: configuration.circuits } };
    const open = (name: string) => { const wallet = new V3Wallet(join(directory, `${name}.db`), reader); wallets.push(wallet); return wallet; };
    const create = (secret: Uint8Array, name: string): Journal => {
      const j = new V3OperatorJournal(join(directory, `${name}.db`), { secret, venue, reference, verifier });
      journals.push(j); return j;
    };
    /** Appoint `secret` to x after `predecessor` and wait until it is effective. */
    const replace = async (secret: Uint8Array, predecessor: Uint8Array) => {
      const effective = venue.witnessedIndex() + 2n * lag + 2n;
      const unsigned: Replacement = { role: 1, successor: ed25519.getPublicKey(secret), predecessor, effective,
        signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(x.name, unsigned);
      const replacement = { ...unsigned, signature: ed25519.sign(message, ruleSecret), successorSignature: ed25519.sign(message, secret) };
      await venue.publishRecord(2, x.name, encodeReplacement(x.name, replacement));
      venue.advance(effective);
      return replacementHash(x.name, replacement);
    };
    /** The segment header an operator's served package names last. */
    const header = async (j: Journal, backing?: Uint8Array) => {
      const served = await j.package(backing);
      return decodeEvidencePackage(served.package).filter(item => item.kind === 6)
        .map(item => decodeSegmentHeader(decodeTrail(item.payload).header))
        .filter(h => same(h.operator, j.operatorKey)).sort((p, q) => p.sequence > q.sequence ? -1 : p.sequence < q.sequence ? 1 : 0)[0]!;
    };
    const served = async (j: Journal, backing?: Uint8Array) => (await j.package(backing)).package;
    const checkpoint = async (j: Journal, id: string) => { await j.commit(id); await j.publish(); };
    const service = (j: Journal) => ({ submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) });
    const payer = open("payer"), receiver = open("receiver"), a = create(aSecret, "a");
    await a.open("genesis", [x.signed, y.signed]); await a.publish();
    const ctx: SegmentContext = { domain, header: await header(a) };
    const fundX = payer.request("fund-x", x.name, 10n), fundY = payer.request("fund-y", y.name, 20n);
    await a.submit(encodeRecord(authorizeIssue(record(issueTask(ctx, fundX)), x.issuer)));
    await a.submit(encodeRecord(authorizeIssue(record(issueTask(ctx, fundY)), y.issuer)));
    await checkpoint(a, "issued");
    const invoiceX = receiver.request("invoice-x", x.name, 4n), invoiceY = receiver.request("invoice-y", y.name, 7n);
    const orders = { x: { request: invoiceX, value: 4n }, y: { request: invoiceY, value: 7n } };
    return { venue, x, y, open, create, replace, header, served, checkpoint, service, payer, receiver, a, ctx, fundX, fundY,
      invoiceX, invoiceY, orders, held: await served(a) };
  }
  const values = (view: { holdings: readonly { value: bigint; status: string }[] }) => view.holdings.map(h => [h.value, h.status]);

  it("holds each backing's notes apart in a shared segment and pays either backing through its own scope entry", async () => {
    const f = await shared();
    expect(f.ctx.header.entries.map(entry => entry.backing)).toEqual([f.x.name, f.y.name].sort(compareBytes));
    // One package, two views: each shows only its backing's notes of the shared history.
    expect(values(await f.payer.sync(f.held, f.x.signed))).toEqual([[10n, "available"]]);
    expect(values(await f.payer.sync(f.held, f.y.signed))).toEqual([[20n, "available"]]);
    const payX = await f.payer.prepare("shop-x", f.orders.x, f.held, f.x.signed, prove);
    const payY = await f.payer.prepare("shop-y", f.orders.y, f.held, f.y.signed, prove);
    // Both statements name the shared segment and scope; the journal admits both.
    for (const payment of [payX, payY]) {
      expect(segmentOf(payment.record)).toEqual(segmentIdentity(f.ctx.header));
      await f.payer.submit(payment === payX ? "shop-x" : "shop-y", f.service(f.a));
    }
    await f.checkpoint(f.a, "paid");
    const paid = await f.served(f.a);
    expect(values(await f.payer.sync(paid, f.x.signed))).toEqual([[6n, "available"]]);
    expect(values(await f.payer.sync(paid, f.y.signed))).toEqual([[13n, "available"]]);
    expect([f.payer.payment("shop-x")!.status, f.payer.payment("shop-y")!.status]).toEqual(["final", "final"]);
    expect((await f.receiver.fulfill("invoice-x", paid, f.x.signed)).request).toEqual(f.invoiceX);
    expect((await f.receiver.fulfill("invoice-y", paid, f.y.signed)).request).toEqual(f.invoiceY);
  });

  it("re-proves each backing's pending payment into its own successor segment after a split and pays under imported roots after a rejoin", async () => {
    const f = await shared();
    const payX = await f.payer.prepare("shop-x", f.orders.x, f.held, f.x.signed, prove);
    const payY = await f.payer.prepare("shop-y", f.orders.y, f.held, f.y.signed, prove);
    const toB = await f.replace(bSecret, f.x.name);
    // x's term under A has ended; y's has not, but A's shared segment admits nothing more for either.
    for (const [name, signed] of [["shop-x", f.x.signed], ["shop-y", f.y.signed]] as const) {
      await expect(f.payer.reprove(name, f.held, signed, prove))
        .rejects.toMatchObject({ code: "CONFLICT", message: "the canonical segment's operator term has ended" });
    }
    for (const [name, backing, signed] of [["late-x", f.x.name, f.x.signed], ["late-y", f.y.name, f.y.signed]] as const) {
      await expect(f.payer.prepare(name, { request: f.receiver.request(name, backing, 1n), value: 1n }, f.held, signed, prove))
        .rejects.toMatchObject({ code: "CONFLICT", message: "the canonical segment's operator term has ended" });
      expect(f.payer.payment(name)).toBeUndefined();
    }
    const bj = f.create(bSecret, "b");
    await bj.takeover("take-x", f.x.signed, f.held);
    await f.a.rescope("split", { keep: [f.y.name] });
    for (const j of [bj, f.a]) { await j.publish(); expect(await j.adopt()).toEqual([]); }
    const [heldB, heldA] = [await f.served(bj), await f.served(f.a)];
    const [headerB, headerA] = [await f.header(bj), await f.header(f.a)];
    expect(headerB.entries).toMatchObject([{ backing: f.x.name, link: toB }]);
    expect(headerA.entries).toMatchObject([{ backing: f.y.name, link: f.y.name }]);
    // A's split package lacks B's carriage of x, so it establishes no x view; B's carries x's imported notes.
    await expect(f.payer.sync(heldA, f.x.signed)).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(values(await f.payer.sync(heldB, f.x.signed))).toEqual([[10n, "reserved"]]);
    const reX = await f.payer.reprove("shop-x", heldB, f.x.signed, prove), reY = await f.payer.reprove("shop-y", heldA, f.y.signed, prove);
    expect(segmentOf(reX.record)).toEqual(segmentIdentity(headerB)); expect(segmentOf(reY.record)).toEqual(segmentIdentity(headerA));
    for (const [before, after] of [[payX, reX], [payY, reY]] as const) {
      expect(decodeRecord(after.record).publicInputs.slice(7)).toEqual(decodeRecord(before.record).publicInputs.slice(7));
      expect(after.superseded).toEqual([{ record: before.record, receipt: undefined }]);
    }
    expect(await f.payer.submit("shop-x", f.service(bj))).toMatchObject({ operator: bKey });
    expect(await f.payer.submit("shop-y", f.service(f.a))).toMatchObject({ operator: aKey });
    await f.checkpoint(bj, "spent-x"); await f.checkpoint(f.a, "spent-y");
    const [spentB, spentA] = [await f.served(bj), await f.served(f.a)];
    expect(values(await f.payer.sync(spentB, f.x.signed))).toEqual([[6n, "available"]]);
    expect(values(await f.payer.sync(spentA, f.y.signed))).toEqual([[13n, "available"]]);
    expect([f.payer.payment("shop-x")!.status, f.payer.payment("shop-y")!.status]).toEqual(["final", "final"]);
    expect((await f.receiver.fulfill("invoice-x", spentB, f.x.signed)).request).toEqual(f.invoiceX);

    // x returns to A, which rejoins x and y once its own tail is witnessed.
    await f.replace(aSecret, toB);
    await f.a.rescope("rejoin", { take: [f.x.signed], keep: [f.y.name], evidence: spentB });
    await f.a.publish(); expect(await f.a.adopt()).toEqual([]);
    const joined = await f.served(f.a), header = await f.header(f.a);
    expect(header.entries.map(entry => entry.opening!.operator).sort(compareBytes)).toEqual([aKey, bKey].sort(compareBytes));
    // Both change notes are imported from distinct segments; each pays in the joined one.
    const viewX = await f.payer.sync(joined, f.x.signed), viewY = await f.payer.sync(joined, f.y.signed);
    expect([values(viewX), values(viewY)]).toEqual([[[6n, "available"]], [[13n, "available"]]]);
    const again = { x: { request: f.receiver.request("again-x", f.x.name, 5n), value: 5n },
      y: { request: f.receiver.request("again-y", f.y.name, 12n), value: 12n } };
    for (const [name, order, signed] of [["again-x", again.x, f.x.signed], ["again-y", again.y, f.y.signed]] as const) {
      const payment = await f.payer.prepare(name, order, joined, signed, prove);
      expect(segmentOf(payment.record)).toEqual(segmentIdentity(header));
      // The inputs are proven under the roots of the segments that created them.
      const anchors = decodeRecord(payment.record).publicInputs.slice(5, 7);
      expect(anchors.every(anchor => anchor !== 0n)).toBe(true);
      await f.payer.submit(name, f.service(f.a));
    }
    await f.checkpoint(f.a, "again");
    const final = await f.served(f.a);
    expect(values(await f.payer.sync(final, f.x.signed))).toEqual([[1n, "available"]]);
    expect(values(await f.payer.sync(final, f.y.signed))).toEqual([[1n, "available"]]);
    expect((await f.receiver.fulfill("again-x", final, f.x.signed)).request.cm).toBe(again.x.request.cm);
    expect((await f.receiver.fulfill("again-y", final, f.y.signed)).request.cm).toBe(again.y.request.cm);
    expect((await f.receiver.fulfill("invoice-y", final, f.y.signed)).request).toEqual(f.invoiceY);
  });

  it("refuses a shared segment of the backing's ended term when the same operator is appointed again", async () => {
    const f = await shared();
    await f.replace(aSecret, await f.replace(bSecret, f.x.name));
    // A holds x again under a new link, but its shared segment opened x under the first term.
    await expect(f.payer.prepare("shop-x", f.orders.x, f.held, f.x.signed, prove))
      .rejects.toMatchObject({ code: "CONFLICT", message: "the canonical segment's operator term has ended" });
    expect(values(await f.payer.sync(f.held, f.x.signed))).toEqual([[10n, "available"]]);
  });

  it("applies a demand adopted and withdrawn before a split once, never again at the split opening", async () => {
    const f = await shared(8n), presenter = b(18);
    const owned = recoverCapsule(f.payer.recoverySeed(), domain, f.fundY.cm, f.fundY.capsule)!;
    const tree = new NoteTree(); tree.appendAll([f.fundX.cm, f.fundY.cm]);
    const input = { note: owned, anchor: tree.root(), path: tree.path(1n) };
    // A falls silent; the holder forces a demand on its y note, and A returns and adopts it.
    f.venue.advance(f.venue.witnessedIndex() + 11n);
    const instant = f.venue.witnessedIndex() - 1n;
    const demand = record(demandTask(f.ctx, [input, { ...input, note: prepareExactOutput(b(21), domain, b(34), f.y.name, 0n) }],
      { backing: f.y.name, quantity: 20n, presenter: ed25519.getPublicKey(presenter), instant, deadline: instant + 80n }));
    await f.venue.publishRecord(4, f.y.name, encodePublication({ domain, backing: f.y.name, kind: 1, record: demand }));
    await f.a.return("returned"); await f.a.publish();
    expect((await f.a.adopt()).map(bytes => decodeReceipt(bytes).statementHash)).toEqual([statementHash(demand)]);
    await f.checkpoint(f.a, "adopted");
    expect(values(await f.payer.sync(await f.served(f.a), f.y.signed))).toEqual([[20n, "locked"]]);
    await f.a.submit(encodeRecord(withdrawalRecord({ domain, header: await f.header(f.a) }, statementHash(demand), presenter)));
    await f.checkpoint(f.a, "withdrawn");
    expect(values(await f.payer.sync(await f.served(f.a), f.y.signed))).toEqual([[20n, "available"]]);
    // x moves to B and A splits y off: the opening imports the withdrawn state, whose demand stays withdrawn.
    await f.replace(bSecret, f.x.name);
    const bj = f.create(bSecret, "b");
    await bj.takeover("take-x", f.x.signed, await f.served(f.a));
    await f.a.rescope("split", { keep: [f.y.name] });
    for (const j of [bj, f.a]) { await j.publish(); expect(await j.adopt()).toEqual([]); }
    const view = await f.payer.sync(await f.served(f.a), f.y.signed);
    expect(view.checkpoint!.sequence).toBe((await f.header(f.a)).sequence);
    expect(values(view)).toEqual([[20n, "available"]]);
  });

  it("acts on and reads a demand only under its own backing's terms in a shared segment", async () => {
    const f = await shared();
    await f.payer.sync(f.held, f.y.signed);
    const deadline = f.venue.witnessedIndex() + 30n;
    const demand = await f.payer.demand("dy", 20n, deadline, f.held, f.y.signed, prove), id = demand.demand!;
    await f.payer.submit("dy", f.service(f.a)); await f.checkpoint(f.a, "demanded");
    const served = await f.served(f.a), signX = (message: Uint8Array) => ed25519.sign(message, issuerX);
    // The shared history holds y's demand, but x's terms never reach it: no withdrawal, acceptance or reading under x.
    await expect(f.payer.withdraw("wx", id, served, f.x.signed)).rejects.toMatchObject({ code: "ABSENT" });
    await expect(f.payer.accept("ax", id, deadline - 2n, served, f.x.signed, signX)).rejects.toMatchObject({ code: "ABSENT" });
    await expect(f.payer.presentation(id, served, f.x.signed)).rejects.toMatchObject({ code: "ABSENT" });
    expect(f.payer.act("wx")).toBeUndefined();
    // y's K signs an acceptance of it, routed to the sibling x: evidence only beside its demand's own backing, so none.
    const acceptance = { domain, demand: id, owner: 5n, deadline: deadline - 2n };
    await f.venue.publishRecord(4, f.x.name, encodePublication({ domain, backing: f.x.name, kind: 2,
      acceptance: { ...acceptance, signature: ed25519.sign(acceptanceBytes(acceptance), issuerY) } }));
    expect(await f.payer.presentation(id, await f.served(f.a), f.y.signed)).toMatchObject({ backing: f.y.name, quantity: 20n, deadline,
      ended: undefined, acceptances: [] });
    // The same acceptance routed to y counts.
    await f.venue.publishRecord(4, f.y.name, encodePublication({ domain, backing: f.y.name, kind: 2,
      acceptance: { ...acceptance, signature: ed25519.sign(acceptanceBytes(acceptance), issuerY) } }));
    expect((await f.payer.presentation(id, await f.served(f.a), f.y.signed)).acceptances.map(a => a.owner)).toEqual([5n]);
    expect(await f.payer.withdraw("wy", id, served, f.y.signed)).toMatchObject({ kind: 5, demand: id });
  });

  it("closes admission for every scoped backing on the scope's one silence clock", async () => {
    const f = await shared(4n);
    f.venue.advance(f.venue.witnessedIndex() + 5n);
    for (const [name, order, signed] of [["shop-x", f.orders.x, f.x.signed], ["shop-y", f.orders.y, f.y.signed]] as const) {
      await expect(f.payer.prepare(name, order, f.held, signed, prove)).rejects.toMatchObject({ code: "SILENCE" });
      expect(f.payer.payment(name)).toBeUndefined();
    }
    // Holdings stay readable; only new statements are refused.
    expect(values(await f.payer.sync(f.held, f.y.signed))).toEqual([[20n, "available"]]);
  });
});
