import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes } from "../src/bytes.js";
import { decodeReceipt } from "../src/lit/commitments.js";
import { litConfigHash } from "../src/lit/configuration.js";
import { LIT } from "../src/lit/construction.js";
import { noteCommitment, noteNullifier, noteTag } from "../src/lit/notes.js";
import { acceptanceBytes, decodePublication, decodeRecord, encodePublication, encodeRecord, statementBytes, type Statement } from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { decodeLitPackage, decodeLitSegmentHeader, decodeLitTrail, litSegmentIdentity } from "../src/lit/transport.js";
import { acceptSecret, issueNonce, ownerSecret, presentSecret } from "../src/lit/wallet-keys.js";
import type { LitPaymentRequest } from "../src/lit/wallet.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import type { V3Wallet as Wallet, V3WalletError as WalletError } from "../src/pool/v3/wallet-store.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { keptFileDigest } from "../src/pool/v3/replay-store.js";

// The one wallet (src/pool/v3/wallet-store.ts) holding lit-v1 notes (slice 14 M14g1): requests by owner key, notes found by
// owner keys per backing under doubling windows (lit-v1 §8), payments signed by the notes' owners, credited once; and (M14g2)
// K's issue and acceptance, the holder's burn, demand, withdrawal and settlement, their publication, and §8's window move. A lit
// operator journal serves the evidence; no verifier is given anywhere.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const same = (a: Uint8Array, z: Uint8Array): boolean => compareBytes(a, z) === 0;
const DOMAIN = litConfigHash(), label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(15), OPERATOR = b(16), RULE = b(19);

describe("the one wallet holding lit notes", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let V3WalletError: typeof import("../src/pool/v3/wallet-store.js").V3WalletError;
  const journals: Journal[] = [], wallets: Wallet[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    ({ V3Wallet, V3WalletError } = await import("../src/pool/v3/wallet-store.js"));
  });
  afterEach(() => {
    for (const w of wallets.splice(0)) { try { w.close(); } catch { /* closed */ } }
    for (const j of journals.splice(0)) { try { j.close(); } catch { /* closed */ } }
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function fixture() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "lit-wallet-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator: pub(OPERATOR), interval: 30n,
      payout: { thing: "lit wallet test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(RULE) };
    const terms = encodeLitTerms(fields), backing = litTermsName(terms);
    const signed = { terms, signature: ed25519.sign(litTermsSignatureMessage(terms), K) };
    const options = { construction: LIT, venue, reference };
    const open = (name: string): Wallet => { const w = new V3Wallet(join(directory, `${name}.db`), options); wallets.push(w); return w; };
    const restore = (name: string, seed: Uint8Array): Wallet => {
      const w = V3Wallet.restoreSeed(join(directory, `${name}.db`), options, seed); wallets.push(w); return w;
    };
    const j = new V3OperatorJournal(join(directory, "journal.db"), { secret: OPERATOR, venue, reference, construction: LIT }); journals.push(j);
    await j.open("genesis", signed); await j.publish();
    const headers = decodeLitPackage((await j.package()).package).filter(item => item.kind === 6)
      .map(item => decodeLitSegmentHeader(decodeLitTrail(item.payload).header));
    const segment = litSegmentIdentity(headers[0]!);
    let nonce = 0, commits = 0;
    /** K issues `request`'s quantity to its key (lit-v1 §3 kind 1). */
    const issue = async (request: LitPaymentRequest) => {
      const statement: Statement = { domain: DOMAIN, kind: 1, segment, backing, quantity: request.value, owner: request.owner, nonce: b(150 + nonce++) };
      await j.submit(encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), K) }));
    };
    const checkpoint = async () => { await j.commit(`c${commits++}`); await j.publish(); };
    const served = async () => (await j.package()).package;
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    return { venue, backing, signed, open, restore, j, issue, checkpoint, served, service, segment, path: (name: string) => join(directory, `${name}.db`) };
  }
  async function refusal(action: Promise<unknown> | (() => unknown)): Promise<string> {
    const error = typeof action === "function" ? (() => { try { action(); return undefined; } catch (e) { return e; } })() :
      await action.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(V3WalletError);
    return (error as WalletError).code;
  }
  /** The refusal's code and message, where two refusals share a code. */
  async function refusalOf(action: Promise<unknown>): Promise<string> {
    const error = await action.then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(V3WalletError);
    return `${(error as WalletError).code}: ${(error as Error).message}`;
  }
  const values = (view: { holdings: readonly { value: bigint; status: string }[] }) => view.holdings.map(h => [h.value, h.status]);

  it("requests by owner key, pays with change to the next index, and credits the payee's output once", async () => {
    const f = await fixture(), payer = f.open("payer"), receiver = f.open("receiver");
    const fund = payer.keyedRequest("fund", f.backing, 10n);
    // Index 0 of the backing, from the seed: lit-v1 §8's owner key.
    expect(same(fund.owner, pub(ownerSecret(payer.recoverySeed(), DOMAIN, f.backing, 0n)))).toBe(true);
    expect(payer.keyedRequest("fund", f.backing, 10n)).toEqual(fund);
    expect(await refusal(() => payer.keyedRequest("fund", f.backing, 11n))).toBe("CONFLICT");
    await f.issue(fund); await f.checkpoint();
    expect(values(await payer.sync(await f.served(), f.signed))).toEqual([[10n, "available"]]);
    // An issue consumes no note: K's issue to the payer's request credits it.
    expect((await payer.keyedFulfill("fund", await f.served(), f.signed)).request).toEqual(fund);

    const invoice = receiver.keyedRequest("invoice", f.backing, 4n);
    const order = { request: invoice, value: 4n };
    const payment = await payer.prepare("shop", order, await f.served(), f.signed);
    expect(payment).toMatchObject({ status: "prepared", value: 4n, fee: undefined });
    // An exact retry returns the saved record; another order under the alias refuses.
    expect((await payer.prepare("shop", order, await f.served(), f.signed)).record).toEqual(payment.record);
    expect(await refusal(payer.prepare("shop", { request: invoice, value: 3n }, await f.served(), f.signed))).toBe("INVALID");
    expect(values(await payer.sync(await f.served(), f.signed))).toEqual([[10n, "reserved"]]);
    // Not yet paid: no output to the key.
    expect(await refusal(receiver.keyedFulfill("invoice", await f.served(), f.signed))).toBe("ABSENT");

    const receipt = await payer.submit("shop", f.service);
    expect(receipt.position).toBe(2n);
    expect(await payer.submit("shop", f.service)).toEqual(receipt);
    await f.checkpoint();
    expect(values(await payer.sync(await f.served(), f.signed))).toEqual([[6n, "available"]]);
    expect(payer.payment("shop")).toMatchObject({ status: "final" });

    const credited = await receiver.keyedFulfill("invoice", await f.served(), f.signed);
    expect(credited).toMatchObject({ cm: payment.payee, judgingIndex: f.venue.witnessedIndex() });
    expect(receiver.keyedFulfillment("invoice")).toEqual(credited);
    expect(await refusal(receiver.keyedFulfill("invoice", await f.served(), f.signed))).toBe("CONFLICT");
    expect(values(await receiver.sync(await f.served(), f.signed))).toEqual([[4n, "available"]]);
    // A pool request on a lit wallet refuses by name.
    expect(await refusal(() => receiver.request("pool", f.backing, 1n))).toBe("INVALID");
  });

  it("credits no request with an output of the wallet's own notes", async () => {
    const f = await fixture(), holder = f.open("holder");
    const fund = holder.keyedRequest("fund", f.backing, 5n);
    await f.issue(fund); await f.checkpoint();
    // A payment of the holder's own note to its own request: the output is the holder's, but credits nothing (§8).
    const own = holder.keyedRequest("own", f.backing, 5n);
    await holder.prepare("self", { request: own, value: 5n }, await f.served(), f.signed);
    await holder.submit("self", f.service); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([[5n, "available"]]);
    expect(await refusal(holder.keyedFulfill("own", await f.served(), f.signed))).toBe("ABSENT");
    // The spent input's mark withheld from the kept file under a re-recorded digest: the saved payment still names it.
    holder.close();
    const replay = `${f.path("holder")}.replay`, db = new DatabaseSync(replay, { readBigInts: true });
    const first = db.prepare("SELECT ns, leaf FROM witness ORDER BY ns, leaf LIMIT 1").get() as { ns: bigint; leaf: bigint };
    db.prepare("DELETE FROM witness WHERE ns = ? AND leaf = ?").run(first.ns, first.leaf); db.close();
    writeFileSync(`${replay}.sha256`, keptFileDigest(replay)!);
    const reopened = f.open("holder");
    expect(await refusal(reopened.keyedFulfill("own", await f.served(), f.signed))).toBe("ABSENT");
  });

  it("names a payment the payee already spent, and trusts no kept mark's owner fields", async () => {
    const f = await fixture(), payer = f.open("payer"), receiver = f.open("receiver"), third = f.open("third");
    await f.issue(payer.keyedRequest("fund", f.backing, 4n)); await f.checkpoint();
    const invoice = receiver.keyedRequest("invoice", f.backing, 4n);
    await payer.prepare("shop", { request: invoice, value: 4n }, await f.served(), f.signed);
    await payer.submit("shop", f.service); await f.checkpoint();
    // The receiver spends the note before crediting it: the credit is refused as spent, not absent.
    await receiver.sync(await f.served(), f.signed);
    await receiver.prepare("onward", { request: third.keyedRequest("onward", f.backing, 4n), value: 4n }, await f.served(), f.signed);
    await receiver.submit("onward", f.service); await f.checkpoint();
    expect(await refusal(receiver.keyedFulfill("invoice", await f.served(), f.signed))).toBe("SPENT");

    // A kept mark rewritten to name index 300 under a re-recorded digest: read back against the seed's keys, it is
    // discarded and the read replays, so the found index (0) and the exposure (through 256) stay the true ones; trusted, it
    // would have refused the first request (an index past 300 beyond the reach of h).
    expect(values(await third.sync(await f.served(), f.signed))).toEqual([[4n, "available"]]);
    third.close();
    const replay = `${f.path("third")}.replay`, db = new DatabaseSync(replay, { readBigInts: true });
    const row = db.prepare("SELECT ns, leaf, note FROM witness ORDER BY ns, leaf LIMIT 1").get() as { ns: bigint; leaf: bigint; note: Uint8Array };
    const note = new Uint8Array(row.note); note[143] = 1; note[144] = 44;
    db.prepare("UPDATE witness SET note = ? WHERE ns = ? AND leaf = ?").run(note, row.ns, row.leaf); db.close();
    writeFileSync(`${replay}.sha256`, keptFileDigest(replay)!);
    const reopened = f.open("third");
    expect(values(await reopened.sync(await f.served(), f.signed))).toEqual([[4n, "available"]]);
    for (let i = 1; i <= 256; i++) reopened.keyedRequest(`r${i}`, f.backing, 1n);
    expect(await refusal(() => reopened.keyedRequest("r257", f.backing, 1n))).toBe("WINDOW");
  });

  it("signs a payment again for the canonical segment after a scope change, its outputs unchanged", async () => {
    const f = await fixture(), payer = f.open("payer"), receiver = f.open("receiver");
    await f.issue(payer.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    const invoice = receiver.keyedRequest("invoice", f.backing, 4n);
    const first = await payer.prepare("shop", { request: invoice, value: 4n }, await f.served(), f.signed);
    // Before the scope changes the saved record names the canonical segment: it is returned unchanged.
    expect((await payer.reprove("shop", await f.served(), f.signed)).record).toEqual(first.record);
    await f.j.rescope("again", { keep: [f.backing] }); await f.j.publish(); await f.j.adopt();
    const again = await payer.reprove("shop", await f.served(), f.signed);
    expect(again.record).not.toEqual(first.record);
    expect([again.payee, again.inputs, again.superseded.length]).toEqual([first.payee, first.inputs, 1]);
    await payer.submit("shop", f.service); await f.checkpoint();
    expect(values(await payer.sync(await f.served(), f.signed))).toEqual([[6n, "available"]]);
    expect(payer.payment("shop")).toMatchObject({ status: "final" });
    expect((await receiver.keyedFulfill("invoice", await f.served(), f.signed)).cm).toBe(first.payee);
  });

  it("hands its exposed indices to an encrypted backup's restored copy, which never names a key twice", async () => {
    const f = await fixture(), holder = f.open("holder");
    for (let i = 0; i < 5; i++) holder.keyedRequest(`r${i}`, f.backing, 1n);
    const key = b(77), backup = holder.exportBackup(key);
    expect(await refusal(() => holder.keyedRequest("r5", f.backing, 1n))).toBe("FENCED");
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const restored = V3Wallet.restoreBackup(join(resolve(directories.at(-1)!), "copy.db"), { construction: LIT, venue: f.venue, reference },
      backup, key, walletBackupDigest(backup));
    wallets.push(restored);
    const next = restored.keyedRequest("r5", f.backing, 1n);
    expect(same(next.owner, pub(ownerSecret(restored.recoverySeed(), DOMAIN, f.backing, 5n)))).toBe(true);
    expect(restored.keyedRequest("r0", f.backing, 1n).owner).toEqual(pub(ownerSecret(restored.recoverySeed(), DOMAIN, f.backing, 0n)));
  });

  it("restores every note from the seed under doubling windows and exposes nothing it may have exposed", async () => {
    const f = await fixture(), holder = f.open("holder");
    // Indices 0..700: paid at 200, then 450 (h = 200 exposes through 456), then 700 (h = 450 exposes through 706).
    const requests = new Map<number, LitPaymentRequest>();
    const ask = (from: number, to: number) => { for (let i = from; i <= to; i++) requests.set(i, holder.keyedRequest(`r${i}`, f.backing, BigInt(i + 1))); };
    ask(0, 255);
    expect(await refusal(() => holder.keyedRequest("r256", f.backing, 257n))).toBe("WINDOW");
    await f.issue(requests.get(200)!); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    ask(256, 456);
    expect(await refusal(() => holder.keyedRequest("r457", f.backing, 458n))).toBe("WINDOW");
    await f.issue(requests.get(450)!); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    ask(457, 700);
    await f.issue(requests.get(700)!); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([[201n, "available"], [451n, "available"], [701n, "available"]]);

    const restored = f.restore("restored", holder.recoverySeed());
    expect(await refusal(() => restored.keyedRequest("next", f.backing, 1n))).toBe("WINDOW");
    // A first read under 512 finds 200 and 450; h = 450 doubles the window, and the read again finds 700.
    const view = await restored.sync(await f.served(), f.signed);
    expect(values(view).sort((p, q) => (p[0]! < q[0]! ? -1 : 1))).toEqual([[201n, "available"], [451n, "available"], [701n, "available"]]);
    // Every index through h + 256 = 956 reads as exposed: no new request until the window moves.
    expect(await refusal(() => restored.keyedRequest("next", f.backing, 1n))).toBe("WINDOW");
    // §8: the restored wallet pays itself at 956, and once that is final requests again past it.
    await restored.moveWindow("move", await f.served(), f.signed);
    await restored.submit("move", f.service); await f.checkpoint();
    await restored.sync(await f.served(), f.signed);
    expect(same(restored.keyedRequest("next", f.backing, 1n).owner, pub(ownerSecret(restored.recoverySeed(), DOMAIN, f.backing, 957n)))).toBe(true);
  });

  // --- M14g2: the acts and the window move -----------------------------------------------------------------------------
  const sign = (message: Uint8Array): Uint8Array => ed25519.sign(message, K);

  it("issues once per request key under a nonce K's wallet derives, and credits no issue the wallet's own seed made", async () => {
    const f = await fixture(), backer = f.open("backer"), holder = f.open("holder");
    await f.issue(holder.keyedRequest("seed", f.backing, 1n)); await f.checkpoint();
    const fund = holder.keyedRequest("fund", f.backing, 7n);
    const issued = await backer.issue("i1", fund, 7n, await f.served(), f.signed, undefined, sign);
    expect(issued).toMatchObject({ kind: 1, status: "prepared", inputs: [] });
    expect((await backer.issue("i1", fund, 7n, await f.served(), f.signed, undefined, sign)).record).toEqual(issued.record);
    expect(await refusal(backer.issue("i1", fund, 8n, await f.served(), f.signed, undefined, sign))).toBe("INVALID");
    // One issue per key: another alias for the same key refuses while the first is saved.
    expect(await refusal(backer.issue("i2", fund, 7n, await f.served(), f.signed, undefined, sign))).toBe("CONFLICT");
    // A signer that is not the obligor's is refused before anything is saved.
    expect(await refusal(f.open("other").issue("x", fund, 7n, await f.served(), f.signed, undefined, m => ed25519.sign(m, b(99))))).toBe("INVALID");
    // The nonce is the seed's: a wallet restored from it builds the same record, so at most one is ever admitted (§2).
    const copy = f.restore("copy", backer.recoverySeed());
    expect((await copy.issue("i1", fund, 7n, await f.served(), f.signed, undefined, sign)).record).toEqual(issued.record);
    await backer.submit("i1", f.service); await f.checkpoint();
    await backer.sync(await f.served(), f.signed);
    expect(backer.act("i1")).toMatchObject({ status: "final" });
    expect(await refusal(f.restore("again", backer.recoverySeed()).issue("i9", fund, 7n, await f.served(), f.signed, undefined, sign))).toBe("CONFLICT");
    expect((await holder.keyedFulfill("fund", await f.served(), f.signed)).request).toEqual(fund);
    // K's wallet issuing to its own key credits no request: refused by name.
    const mine = backer.keyedRequest("mine", f.backing, 3n);
    expect(await refusal(backer.issue("i3", mine, 3n, await f.served(), f.signed, undefined, sign))).toBe("OWN_KEY");
    // An issue whose nonce the holder's own seed derives is the holder's own: it credits nothing (§8).
    const own = holder.keyedRequest("own", f.backing, 2n);
    const statement: Statement = { domain: DOMAIN, kind: 1, segment: f.segment, backing: f.backing, quantity: 2n, owner: own.owner,
      nonce: issueNonce(holder.recoverySeed(), DOMAIN, f.backing, own.owner, 2n) };
    await f.j.submit(encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), K) })); await f.checkpoint();
    expect(await refusal(holder.keyedFulfill("own", await f.served(), f.signed))).toBe("ABSENT");
  });

  it("burns from its notes with change to the next index, and with none where nothing is left", async () => {
    const f = await fixture(), holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const burn = await holder.burn("b1", 3n, await f.served(), f.signed);
    expect(burn).toMatchObject({ kind: 3, status: "prepared" });
    const s = decodeRecord(burn.record).statement as Extract<Statement, { kind: 3 }>;
    expect([s.quantity, s.outputs.length, s.outputs[0]!.value]).toEqual([3n, 1, 7n]);
    expect(same(s.outputs[0]!.owner, pub(ownerSecret(holder.recoverySeed(), DOMAIN, f.backing, 1n)))).toBe(true);
    expect((await holder.burn("b1", 3n, await f.served(), f.signed)).record).toEqual(burn.record);
    expect(await refusal(holder.burn("b1", 4n, await f.served(), f.signed))).toBe("CONFLICT");
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([[10n, "reserved"]]);
    await holder.submit("b1", f.service); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([[7n, "available"]]);
    expect(holder.act("b1")).toMatchObject({ status: "final" });
    const all = await holder.burn("b2", 7n, await f.served(), f.signed);
    expect((decodeRecord(all.record).statement as Extract<Statement, { kind: 3 }>).outputs).toEqual([]);
    await holder.submit("b2", f.service); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([]);
    expect(holder.act("b2")).toMatchObject({ status: "final" });
  });

  it("demands whole notes, and settles K's acceptance to its owner, which K's wallet then holds", async () => {
    const f = await fixture(), holder = f.open("holder"), backer = f.open("backer");
    await f.issue(holder.keyedRequest("five", f.backing, 5n)); await f.issue(holder.keyedRequest("three", f.backing, 3n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 100n;
    const demand = await holder.demand("d", 8n, deadline, await f.served(), f.signed);
    expect(demand).toMatchObject({ kind: 4, status: "prepared", repeats: [] });
    expect(demand.inputs.length).toBe(2);
    expect((await holder.demand("d", 8n, deadline, await f.served(), f.signed)).record).toEqual(demand.record);
    // §8: the presenter key derives from the seed, the inputs' tags in input order, the instant and the deadline.
    const d = decodeRecord(demand.record).statement as Extract<Statement, { kind: 4 }>;
    const tags = d.inputs.map(input => noteTag(noteNullifier(noteCommitment(DOMAIN, input))));
    expect(same(d.presenter, pub(presentSecret(holder.recoverySeed(), DOMAIN, tags, d.instant, deadline)))).toBe(true);
    await holder.submit("d", f.service); await f.checkpoint();
    const view = await holder.sync(await f.served(), f.signed);
    expect(values(view).sort((p, q) => (p[0]! < q[0]! ? -1 : 1))).toEqual([[3n, "locked"], [5n, "locked"]]);
    expect(view.demands.map(x => [x.id, x.quantity])).toEqual([[demand.demand, 8n]]);
    expect(holder.act("d")).toMatchObject({ status: "final" });

    const acceptance = await backer.keyedAccept("a", demand.demand!, deadline, await f.served(), f.signed, sign);
    expect(same(acceptance.owner, pub(acceptSecret(backer.recoverySeed(), DOMAIN, demand.demand!, deadline)))).toBe(true);
    expect(await backer.keyedAccept("a", demand.demand!, deadline, await f.served(), f.signed, sign)).toEqual(acceptance);
    expect(ed25519.verify(acceptance.ownerSignature, acceptanceBytes(acceptance), acceptance.owner)).toBe(true);
    // Its publication (kind 2) is the same acceptance, both signatures included.
    const sent: Uint8Array[] = [];
    await backer.publishAcceptance("a", { publishRecord: async (_kind: number, _subject: Uint8Array, bytes: Uint8Array) => { sent.push(bytes); } } as never);
    const published = decodePublication(sent[0]!);
    expect(published.kind === 2 ? published.acceptance : undefined).toEqual(acceptance);
    // §§4, 7: K cannot sign for the holder's own owner key or the demand's presenter key, so an acceptance naming either
    // carries no owner signature and is no acceptance; nor is one K did not sign.
    const signedFor = (owner: Uint8Array) => {
      const bytes = acceptanceBytes({ domain: DOMAIN, demand: demand.demand!, owner, deadline });
      return { ...acceptance, owner, signature: ed25519.sign(bytes, K), ownerSignature: ed25519.sign(bytes, K) };
    };
    const unsigned = "INVALID: the acceptance's owner key did not sign it";
    expect(await refusalOf(holder.settle("s0", signedFor(d.inputs[0]!.owner), await f.served(), f.signed))).toBe(unsigned);
    expect(await refusalOf(holder.settle("s0", signedFor(d.presenter), await f.served(), f.signed))).toBe(unsigned);
    expect(await refusalOf(holder.settle("s0", { ...acceptance, ownerSignature: new Uint8Array(64) }, await f.served(), f.signed))).toBe(unsigned);
    expect(await refusalOf(holder.settle("s0", { ...acceptance, signature: new Uint8Array(64) }, await f.served(), f.signed)))
      .toBe("INVALID: the acceptance does not answer a demand under the backing's obligor");
    const settled = await holder.settle("s", acceptance, await f.served(), f.signed);
    expect(settled).toMatchObject({ kind: 6, status: "prepared", demand: demand.demand });
    expect((await holder.settle("s", acceptance, await f.served(), f.signed)).record).toEqual(settled.record);
    await holder.submit("s", f.service); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([]);
    expect([holder.act("d")!.status, holder.act("s")!.status]).toEqual(["final", "final"]);
    expect(values(await backer.sync(await f.served(), f.signed))).toEqual([[8n, "available"]]);
  });

  it("reads C3.8 over lit: only an acceptance K and its owner key both signed answers a demand (§7), so K cannot escape dishonour", async () => {
    const f = await fixture(), holder = f.open("holder"), backer = f.open("backer");
    for (const [name, value] of [["five", 5n], ["three", 3n], ["two", 2n]] as const) await f.issue(holder.keyedRequest(name, f.backing, value));
    await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 40n, demands: Statement[] = [], ids: Uint8Array[] = [];
    for (const [name, value] of [["d5", 5n], ["d3", 3n], ["d2", 2n]] as const) {
      const made = await holder.demand(name, value, deadline, await f.served(), f.signed);
      await holder.submit(name, f.service); ids.push(made.demand!); demands.push(decodeRecord(made.record).statement);
    }
    await f.checkpoint();
    const read = async (id: Uint8Array) => holder.presentation(id, await f.served(), f.signed);
    expect(await read(ids[0]!)).toMatchObject({ backing: f.backing, quantity: 5n, deadline, inTerm: true, ended: undefined, overdue: undefined, acceptances: [] });
    expect(await refusal(read(b(1)))).toBe("ABSENT");
    // K signs acceptances of d5 naming keys of the holder's it can see (an input's owner, the presenter key), and signs
    // for them itself: published and timely, but their owner keys did not sign them, so none answers.
    const d5 = demands[0] as Extract<Statement, { kind: 4 }>;
    const publish = (acceptance: { demand: Uint8Array; owner: Uint8Array; deadline: bigint; signature: Uint8Array; ownerSignature: Uint8Array }) =>
      f.venue.publishRecord(4, f.backing, encodePublication({ domain: DOMAIN, backing: f.backing, kind: 2, acceptance: { domain: DOMAIN, ...acceptance } }));
    const byK = (demand: Uint8Array, owner: Uint8Array, ownerSecret: Uint8Array = K) => {
      const bytes = acceptanceBytes({ domain: DOMAIN, demand, owner, deadline: deadline - 10n });
      return { demand, owner, deadline: deadline - 10n, signature: ed25519.sign(bytes, K), ownerSignature: ed25519.sign(bytes, ownerSecret) };
    };
    await publish(byK(ids[0]!, d5.inputs[0]!.owner)); await publish(byK(ids[0]!, d5.presenter));
    // d3: K's own acceptance through its wallet (owner `acceptSecret`'s key), published and never settled.
    const answer = await backer.keyedAccept("a3", ids[1]!, deadline - 10n, await f.served(), f.signed, sign);
    await backer.publishAcceptance("a3", f.venue);
    // d2: an acceptance naming K itself carries two equal signatures and is valid (§7); the holder settles it.
    const own = byK(ids[2]!, pub(K));
    await publish(own);
    await holder.settle("s2", { domain: DOMAIN, ...own }, await f.served(), f.signed);
    await holder.submit("s2", f.service); await f.checkpoint();
    const settled = await read(ids[2]!);
    expect(settled).toMatchObject({ ended: { by: "settlement" }, overdue: undefined });
    expect(settled.acceptances.map(a => [a.owner, a.timely, a.taken])).toEqual([[pub(K), true, false]]);

    f.venue.advance(deadline + 5n); await f.checkpoint();
    const t = f.venue.witnessedIndex(), dishonoured = await read(ids[0]!), lapsed = await read(ids[1]!);
    expect(dishonoured).toMatchObject({ ended: undefined, overdue: { reading: "dishonour", from: deadline + 1n, through: t }, acceptances: [] });
    expect(lapsed).toMatchObject({ ended: undefined, overdue: { reading: "lapse", from: deadline + 1n, through: t } });
    expect(lapsed.acceptances.map(a => [a.owner, a.deadline, a.timely, a.taken])).toEqual([[answer.owner, deadline - 10n, true, false]]);
    expect((await read(ids[2]!)).ended).toEqual(settled.ended);
  });

  it("withdraws a demand, after which its notes pay as any other; publishes lit frames; has nothing to freshen", async () => {
    const f = await fixture(), holder = f.open("holder"), receiver = f.open("receiver");
    await f.issue(holder.keyedRequest("fund", f.backing, 6n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const demand = await holder.demand("d", 6n, f.venue.witnessedIndex() + 100n, await f.served(), f.signed);
    await holder.submit("d", f.service); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const withdrawal = await holder.withdraw("w", demand.demand!, await f.served(), f.signed);
    expect(withdrawal).toMatchObject({ kind: 5, demand: demand.demand });
    await holder.submit("w", f.service); await f.checkpoint();
    const view = await holder.sync(await f.served(), f.signed);
    expect(values(view)).toEqual([[6n, "available"]]);
    expect(view.holdings[0]!.presented).toEqual([demand.demand]);
    expect(holder.act("w")).toMatchObject({ status: "final" });
    expect(await refusal(holder.freshen("fresh", demand.demand!, await f.served(), f.signed))).toBe("INVALID");
    // A presented note pays as any other: lit's tags hide nothing (§2).
    await holder.prepare("pay", { request: receiver.keyedRequest("invoice", f.backing, 6n), value: 6n }, await f.served(), f.signed);
    await holder.submit("pay", f.service); await f.checkpoint();
    expect(values(await receiver.sync(await f.served(), f.signed))).toEqual([[6n, "available"]]);
    // §4's publication frames, routed to the act's backing.
    const sent: { kind: number; subject: Uint8Array; bytes: Uint8Array }[] = [];
    const publisher = { publishRecord: async (kind: number, subject: Uint8Array, bytes: Uint8Array) => { sent.push({ kind, subject, bytes }); } };
    await holder.publish("d", publisher as never); await holder.publish("w", publisher as never);
    const frames = sent.map(x => decodePublication(x.bytes));
    expect(sent.map(x => [x.kind, same(x.subject, f.backing)])).toEqual([[4, true], [4, true]]);
    expect(frames.map(x => [x.kind, x.kind === 2 ? 0 : x.record.statement.kind])).toEqual([[1, 4], [4, 5]]);
    expect(await refusal(holder.publish("pay", publisher as never))).toBe("UNKNOWN");
  });

  it("moves a full window by paying itself at the highest exposed key, closing that request but crediting a payer's output to it", async () => {
    const f = await fixture(), holder = f.open("holder"), payer = f.open("payer");
    await f.issue(holder.keyedRequest("fund", f.backing, 2n)); await f.issue(payer.keyedRequest("fund", f.backing, 2n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    expect(await refusal(payer.moveWindow("early", await f.served(), f.signed))).toBe("CONFLICT");
    const requests: LitPaymentRequest[] = [];
    for (let i = 1; i <= 256; i++) requests.push(holder.keyedRequest(`r${i}`, f.backing, 2n));
    expect(await refusal(() => holder.keyedRequest("r257", f.backing, 2n))).toBe("WINDOW");
    const move = await holder.moveWindow("move", await f.served(), f.signed);
    expect(move).toMatchObject({ status: "prepared", value: 2n, fee: undefined });
    const outputs = (decodeRecord(move.record).statement as Extract<Statement, { kind: 2 }>).outputs;
    expect(outputs.map(o => same(o.owner, pub(ownerSecret(holder.recoverySeed(), DOMAIN, f.backing, 256n))))).toEqual([true]);
    expect((await holder.moveWindow("move", await f.served(), f.signed)).record).toEqual(move.record);
    expect(await refusal(holder.moveWindow("again", await f.served(), f.signed))).toBe("CONFLICT");
    // The request that named index 256 is closed: no retry hands its key out again.
    expect(await refusal(() => holder.keyedRequest("r256", f.backing, 2n))).toBe("CLOSED");
    await holder.submit("move", f.service); await f.checkpoint();
    expect(values(await holder.sync(await f.served(), f.signed))).toEqual([[2n, "available"]]);
    expect(holder.payment("move")).toMatchObject({ status: "final" });
    // The move's own output is never credited; a payer's to the closed request's key is.
    expect(await refusal(holder.keyedFulfill("r256", await f.served(), f.signed))).toBe("ABSENT");
    await payer.sync(await f.served(), f.signed);
    const paid = await payer.prepare("pay", { request: requests[255]!, value: 2n }, await f.served(), f.signed);
    await payer.submit("pay", f.service); await f.checkpoint();
    expect((await holder.keyedFulfill("r256", await f.served(), f.signed)).cm).toBe(paid.payee);
    // h reached 256: requests resume at 257.
    const next = holder.keyedRequest("r257", f.backing, 2n);
    expect(same(next.owner, pub(ownerSecret(holder.recoverySeed(), DOMAIN, f.backing, 257n)))).toBe(true);
  });

  it("refuses a second issue racing to one key, a move to a key a burn's change pays, and an acceptance naming any presenter key of its own", async () => {
    // Two issues to one key with different quantities, saved concurrently: the check runs again where each saves.
    const f = await fixture(), backer = f.open("backer"), holder = f.open("holder");
    const fund = holder.keyedRequest("fund", f.backing, 7n), served = await f.served();
    const raced = await Promise.allSettled([backer.issue("i1", fund, 7n, served, f.signed, undefined, sign),
      backer.issue("i2", { ...fund, value: 8n }, 8n, served, f.signed, undefined, sign)]);
    expect(raced.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(((raced[1] as PromiseRejectedResult).reason as WalletError).code).toBe("CONFLICT");

    // A burn's change filling the window at h + 256 already moves it once final: no second statement pays that key.
    const g = await fixture(), burner = g.open("burner");
    await g.issue(burner.keyedRequest("fund", g.backing, 10n)); await g.issue(burner.keyedRequest("fund2", g.backing, 5n)); await g.checkpoint();
    await burner.sync(await g.served(), g.signed);
    for (let i = 2; i <= 255; i++) burner.keyedRequest(`r${i}`, g.backing, 1n);
    await burner.burn("b", 3n, await g.served(), g.signed);
    expect(await refusal(burner.moveWindow("move", await g.served(), g.signed))).toBe("CONFLICT");

    // An acceptance naming the presenter key of the holder's other standing demand, whose output no scan marks.
    const h = await fixture(), presenter = h.open("presenter");
    await h.issue(presenter.keyedRequest("five", h.backing, 5n)); await h.issue(presenter.keyedRequest("three", h.backing, 3n)); await h.checkpoint();
    await presenter.sync(await h.served(), h.signed);
    const deadline = h.venue.witnessedIndex() + 100n;
    const d1 = await presenter.demand("d1", 5n, deadline, await h.served(), h.signed);
    const d2 = await presenter.demand("d2", 3n, deadline, await h.served(), h.signed);
    await presenter.submit("d1", h.service); await presenter.submit("d2", h.service); await h.checkpoint();
    await presenter.sync(await h.served(), h.signed);
    const other = (decodeRecord(d2.record).statement as Extract<Statement, { kind: 4 }>).presenter;
    const otherBytes = acceptanceBytes({ domain: DOMAIN, demand: d1.demand!, owner: other, deadline });
    const acceptance = { domain: DOMAIN, demand: d1.demand!, owner: other, deadline, signature: ed25519.sign(otherBytes, K),
      ownerSignature: ed25519.sign(otherBytes, K) };
    expect(await refusalOf(presenter.settle("s", acceptance, await h.served(), h.signed))).toBe("INVALID: the acceptance's owner key did not sign it");
  });

  it("hands a window move to an encrypted backup's restored copy, which reads it as the same payment", async () => {
    const f = await fixture(), holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 2n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    for (let i = 1; i <= 256; i++) holder.keyedRequest(`r${i}`, f.backing, 2n);
    const move = await holder.moveWindow("move", await f.served(), f.signed);
    const key = b(78), backup = holder.exportBackup(key);
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const restored = V3Wallet.restoreBackup(join(resolve(directories.at(-1)!), "copy.db"), { construction: LIT, venue: f.venue, reference },
      backup, key, walletBackupDigest(backup));
    wallets.push(restored);
    expect(restored.payment("move")).toEqual(move);
    expect(await refusal(() => restored.keyedRequest("r256", f.backing, 2n))).toBe("CLOSED");
  });

  it("fails an issue whose segment ended, and makes it again under a new alias with the same output, admitted and credited once", async () => {
    const f = await fixture(), backer = f.open("backer"), holder = f.open("holder");
    const fund = holder.keyedRequest("fund", f.backing, 7n);
    const first = await backer.issue("i1", fund, 7n, await f.served(), f.signed, undefined, sign);
    await f.j.rescope("again", { keep: [f.backing] }); await f.j.publish(); await f.j.adopt();
    await backer.sync(await f.served(), f.signed);
    expect(backer.act("i1")).toMatchObject({ status: "failed" });
    const again = await backer.issue("i2", fund, 7n, await f.served(), f.signed, undefined, sign);
    const nonce = (bytes: Uint8Array) => (decodeRecord(bytes).statement as Extract<Statement, { kind: 1 }>).nonce;
    expect([again.record.length, same(nonce(again.record), nonce(first.record))]).toEqual([first.record.length, true]);
    expect(again.record).not.toEqual(first.record);
    await backer.submit("i2", f.service); await f.checkpoint();
    await backer.sync(await f.served(), f.signed);
    expect([backer.act("i1")!.status, backer.act("i2")!.status]).toEqual(["failed", "final"]);
    expect((await holder.keyedFulfill("fund", await f.served(), f.signed)).request).toEqual(fund);
  });

  it("moves the window over a burn whose segment ended, whose change derived the move's output, without poisoning the handle", async () => {
    const f = await fixture(), holder = f.open("holder"), operator = f.open("operator");
    await f.issue(holder.keyedRequest("fund", f.backing, 10n)); await f.issue(holder.keyedRequest("fund2", f.backing, 5n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    for (let i = 2; i <= 256; i++) holder.keyedRequest(`r${i}`, f.backing, 1n);
    // The burn's change of 2 takes index 256 = h + 256; its segment then ends, and the burn fails with its note free.
    await holder.burn("b", 3n, await f.served(), f.signed);
    await f.j.rescope("again", { keep: [f.backing] }); await f.j.publish(); await f.j.adopt();
    await holder.sync(await f.served(), f.signed);
    expect(holder.act("b")).toMatchObject({ status: "failed" });
    // A move of that note with a fee of 3 derives exactly the failed burn's change (§2: output 0 over the same nullifier).
    const move = await holder.moveWindow("move", await f.served(), f.signed, { request: operator.keyedRequest("fee", f.backing, 3n), value: 3n });
    expect(move).toMatchObject({ status: "prepared", value: 2n, fee: { value: 3n } });
    expect(values(await holder.sync(await f.served(), f.signed)).sort((p, q) => (p[0]! < q[0]! ? -1 : 1))).toEqual([[5n, "reserved"], [10n, "available"]]);
  });
});

describe("lit-v1 §8's reach and the scan window", () => {
  it("reaches the highest index whose gap from the last is within 256, and sizes the window above it", async () => {
    const { reached, windowFor } = await import("../src/lit/holdings.js");
    expect([reached([]), reached([0n]), reached([0n, 256n, 300n]), reached([0n, 300n]), reached([255n]), reached([256n])])
      .toEqual([-1n, 0n, 300n, 0n, 255n, -1n]);
    expect([windowFor(-1n), windowFor(255n), windowFor(256n), windowFor(767n), windowFor(768n)]).toEqual([512n, 512n, 1024n, 1024n, 2048n]);
  });
});
