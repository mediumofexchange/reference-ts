import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import * as contexts from "../src/contexts.js";
import {
  authenticateLitPaymentRequest, encodeLitPaymentRequest, litPaymentRequestDigest, WALLET_LIT_REQUEST_CONTEXT, type LitPaymentRequest,
} from "../src/lit/wallet.js";
import { WALLET_V3_REQUEST_CONTEXT } from "../src/pool/v3/wallet-request.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import type { V3Wallet as Wallet, V3WalletError as WalletError } from "../src/pool/v3/wallet-store.js";
import { FixtureVenue, LOCAL_REFERENCE, type RecordVenue } from "../src/record-venue.js";
import type { RangeLimits, RangeRequest } from "../src/record-range.js";
import { keptFileDigest } from "../src/pool/v3/replay-store.js";

// The one wallet (src/pool/v3/wallet-store.ts) holding lit-v1 notes (slice 14 M14g1): requests by owner key, notes found by
// owner keys per backing under doubling windows (lit-v1 §8), payments signed by the notes' owners, credited once; and (M14g2)
// K's issue and acceptance, the holder's burn, demand, withdrawal and settlement, their publication, and §8's window move. A lit
// operator journal serves the evidence; no verifier is given anywhere.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const same = (a: Uint8Array, z: Uint8Array): boolean => compareBytes(a, z) === 0;
const DOMAIN = litConfigHash(), label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(15), K2 = b(25), OPERATOR = b(16), RULE = b(19);

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

  /** A lit journal over one backing or, `scoped`, two in one scope (the second's K is `K2`). */
  async function fixture(scoped = false) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "lit-wallet-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator: pub(OPERATOR), interval: 30n,
      payout: { thing: "lit wallet test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(RULE) };
    const terms = encodeLitTerms(fields), backing = litTermsName(terms);
    const signed = { terms, signature: ed25519.sign(litTermsSignatureMessage(terms), K) };
    const otherTerms = encodeLitTerms({ ...fields, obligor: pub(K2), payout: { ...fields.payout, thing: "lit wallet test, second" } });
    const other = { backing: litTermsName(otherTerms), signed: { terms: otherTerms, signature: ed25519.sign(litTermsSignatureMessage(otherTerms), K2) } };
    const options = { construction: LIT, venue, reference };
    const open = (name: string): Wallet => { const w = new V3Wallet(join(directory, `${name}.db`), options); wallets.push(w); return w; };
    const restore = (name: string, seed: Uint8Array, view: RecordVenue = venue): Wallet => {
      const w = V3Wallet.restoreSeed(join(directory, `${name}.db`), { ...options, venue: view }, seed); wallets.push(w); return w;
    };
    const j = new V3OperatorJournal(join(directory, "journal.db"), { secret: OPERATOR, venue, reference, construction: LIT }); journals.push(j);
    await j.open("genesis", scoped ? [signed, other.signed] : signed); await j.publish();
    const headers = decodeLitPackage((await j.package()).package).filter(item => item.kind === 6)
      .map(item => decodeLitSegmentHeader(decodeLitTrail(item.payload).header));
    const segment = litSegmentIdentity(headers[0]!);
    let nonce = 0, commits = 0;
    /** K (K2 for the second backing) issues `request`'s quantity to its key (lit-v1 §3 kind 1). */
    const issue = async (request: LitPaymentRequest) => {
      const second = same(request.backing, other.backing);
      const statement: Statement = { domain: DOMAIN, kind: 1, segment, backing: request.backing, quantity: request.value, owner: request.owner,
        nonce: b(150 + nonce++) };
      await j.submit(encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), second ? K2 : K) }));
    };
    const checkpoint = async () => { await j.commit(`c${commits++}`); await j.publish(); };
    const served = async () => (await j.package()).package;
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    return { venue, backing, signed, other, open, restore, j, issue, checkpoint, served, service, segment, path: (name: string) => join(directory, `${name}.db`) };
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
    // §8: the restored wallet pays itself at 956. Prepared from a checkpoint its first read had, that move may be its lost
    // instance's own (Next 4 (bc)), so once final it counts and exposes through 1212; a second move, prepared after, does
    // not, and requests resume past it.
    for (const name of ["move", "move-2"]) {
      expect(await refusalOf(Promise.resolve().then(() => restored.keyedRequest("next", f.backing, 1n)))).toMatch(/^WINDOW: every owner key within 256/);
      await restored.moveWindow(name, await f.served(), f.signed);
      await restored.submit(name, f.service); await f.checkpoint();
      await restored.sync(await f.served(), f.signed);
    }
    expect(same(restored.keyedRequest("next", f.backing, 1n).owner, pub(ownerSecret(restored.recoverySeed(), DOMAIN, f.backing, 1213n)))).toBe(true);
  });

  // --- Next 4 (bc): a restoration whose first read is older than its lost instance's view ------------------------------
  /** `holder`'s requests by index, asked from `from` to `to`. */
  const asker = (holder: Wallet, backing: Uint8Array, requests = new Map<number, LitPaymentRequest>()) => Object.assign(
    (from: number, to: number) => { for (let i = from; i <= to; i++) requests.set(i, holder.keyedRequest(`r${i}`, backing, BigInt(i + 1))); },
    { requests });
  const keyAt = (seed: Uint8Array, backing: Uint8Array, index: bigint) => pub(ownerSecret(seed, DOMAIN, backing, index));
  const FULL = /^WINDOW: every owner key within 256 of the highest one paid is exposed/;
  const requestRefusal = (wallet: Wallet, backing: Uint8Array) => refusalOf(Promise.resolve().then(() => wallet.keyedRequest("next", backing, 1n)));
  /** A view of `venue` that lags behind it from `hold` until `release`, as a node still catching up does. */
  const lagging = (venue: FixtureVenue) => {
    let cap: bigint | undefined;
    const view: RecordVenue = { get id() { return venue.id; }, lag: () => venue.lag(), witnessedIndex: () => cap ?? venue.witnessedIndex(),
      range: (request: RangeRequest, limits: RangeLimits) => (cap !== undefined && request.toIndex > cap ? undefined : venue.range(request, limits)) };
    return { view, hold: () => { cap = venue.witnessedIndex(); }, release: () => { cap = undefined; } };
  };

  it("raises a restoration's exposure at each read until it names a key, so a first read older than its lost instance's view " +
    "never names a key that instance exposed, and its own later window moves do not fill the window again (Next 4 (bc))", async () => {
    const f = await fixture(), holder = f.open("holder"), ask = asker(holder, f.backing), { requests } = ask, node = lagging(f.venue);
    ask(0, 255);
    node.hold();
    const old = await f.served();
    await f.issue(requests.get(100)!); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    ask(256, 356);
    // The holder is lost, having exposed through 356 = h + 256. Its restoration first reads from a node behind that
    // payment: h = −1 exposes through 255. Caught up, a read raises that to 356, so index 256 is never named again.
    const first = f.restore("first", holder.recoverySeed(), node.view);
    await first.sync(old, f.signed);
    node.release();
    await first.sync(await f.served(), f.signed);
    expect(await requestRefusal(first, f.backing)).toMatch(FULL);
    // An encrypted handoff keeps raising.
    const key = b(78), backup = first.exportBackup(key);
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const restored = V3Wallet.restoreBackup(f.path("restored"), { construction: LIT, venue: f.venue, reference }, backup, key, walletBackupDigest(backup));
    wallets.push(restored);
    // A move prepared from a checkpoint witnessed after the first read is one the lost instance never made. It pays index
    // 356, and a payer of the lost instance's request pays 356 too, in the same checkpoint: the payer's output counts, so
    // h reaches 356 and exposes through 612; the move's own output does not.
    await restored.moveWindow("move", await f.served(), f.signed);
    await restored.submit("move", f.service); await f.issue(requests.get(356)!); await f.checkpoint();
    await restored.sync(await f.served(), f.signed);
    expect(await requestRefusal(restored, f.backing)).toMatch(FULL);
    await restored.moveWindow("move-2", await f.served(), f.signed);
    await restored.submit("move-2", f.service); await f.checkpoint();
    await restored.sync(await f.served(), f.signed);
    // Its move to 612 final, h = 612, and the first key it names is 613's; that ends the raising.
    expect(same(restored.keyedRequest("next", f.backing, 1n).owner, keyAt(holder.recoverySeed(), f.backing, 613n))).toBe(true);
    await restored.sync(await f.served(), f.signed);
    expect(same(restored.keyedRequest("after", f.backing, 1n).owner, keyAt(holder.recoverySeed(), f.backing, 614n))).toBe(true);
  });

  it("counts a restoration's window move prepared from a checkpoint its first read had, which may be its lost instance's own, " +
    "byte for byte (Next 4 (bc) review)", async () => {
    const f = await fixture(), lost = f.open("lost"), node = lagging(f.venue);
    await f.issue(lost.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    await lost.sync(await f.served(), f.signed);
    for (let i = 1; i <= 256; i++) lost.keyedRequest(`r${i}`, f.backing, 1n);
    // The lost instance moves its full window to 256, reads the move final and hands index 257 out.
    node.hold();
    const old = await f.served(), moved = await lost.moveWindow("move", old, f.signed);
    await lost.submit("move", f.service); await f.checkpoint();
    await lost.sync(await f.served(), f.signed);
    const handedOut = lost.keyedRequest("r257", f.backing, 1n);
    // Its restoration first reads from a node behind that move and moves the same way: the same record.
    const restored = f.restore("restored", lost.recoverySeed(), node.view);
    await restored.sync(old, f.signed);
    expect((await restored.moveWindow("move", old, f.signed)).record).toEqual(moved.record);
    node.release();
    await restored.submit("move", f.service);
    // Final at the caught-up read, the move counts: h = 256 exposes through 512. A move from a checkpoint witnessed after
    // the first read does not count.
    await restored.sync(await f.served(), f.signed);
    expect(await requestRefusal(restored, f.backing)).toMatch(FULL);
    await restored.moveWindow("move-2", await f.served(), f.signed);
    await restored.submit("move-2", f.service); await f.checkpoint();
    await restored.sync(await f.served(), f.signed);
    const next = restored.keyedRequest("next", f.backing, 1n);
    expect(same(next.owner, handedOut.owner)).toBe(false);
    expect(same(next.owner, keyAt(lost.recoverySeed(), f.backing, 513n))).toBe(true);
  });

  it("raises a restoration's exposure of every backing it holds at a read of any one in its scope, and reads outputs within " +
    "that reach as its lost instance's, not as another instance acting (Next 4 (bc) review)", async () => {
    const f = await fixture(true), lost = f.open("lost"), ask = asker(lost, f.other.backing), { requests } = ask, node = lagging(f.venue);
    ask(0, 255);
    node.hold();
    const old = await f.served();
    // Paid at 200, the lost instance exposed through 300 and was paid there, above the first read's 255 but within reach.
    await f.issue(requests.get(200)!); await f.checkpoint();
    await lost.sync(await f.served(), f.other.signed);
    ask(256, 300);
    await f.issue(requests.get(300)!); await f.checkpoint();
    const restored = f.restore("restored", lost.recoverySeed(), node.view);
    await restored.sync(old, f.other.signed);
    node.release();
    // A read of the scope's first backing raises the second's exposure to 556 and finds no other instance acting.
    expect((await restored.sync(await f.served(), f.signed)).forked).toBeUndefined();
    expect(await requestRefusal(restored, f.other.backing)).toMatch(FULL);
    // So does a read of the second backing itself.
    expect((await restored.sync(await f.served(), f.other.signed)).forked).toBeUndefined();
    expect(await requestRefusal(restored, f.other.backing)).toMatch(FULL);
  });

  // --- Slice 13 M13e: a wallet restored from a copy of its files ------------------------------------------------------
  /** A plain copy of a closed wallet's database and side files, as an owner's backup takes it. */
  const copyWallet = (from: string, to: string) => {
    for (const suffix of ["", "-wal", "-shm", ".evidence", ".replay", ".replay.sha256"]) {
      if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
    }
  };

  it("acts on nothing from a copy until its restoration is recorded, which never names a key the lost instance exposed " +
    "and fulfills a request it may have credited only on the holder's word", async () => {
    const f = await fixture(), payer = f.open("payer");
    await f.issue(payer.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    let shop = f.open("shop");
    const invoice = shop.keyedRequest("invoice", f.backing, 4n);
    await shop.sync(await f.served(), f.signed); shop.close();
    // The owner's backup, after which the original exposes another key, is paid and credits the invoice, and is lost.
    copyWallet(f.path("shop"), f.path("backup"));
    shop = V3Wallet.open(f.path("shop"), { construction: LIT, venue: f.venue, reference }); wallets.push(shop);
    const lost = shop.keyedRequest("order-A", f.backing, 4n);
    await payer.prepare("pay", { request: invoice, value: 4n }, await f.served(), f.signed);
    await payer.submit("pay", f.service); await f.checkpoint();
    expect((await shop.keyedFulfill("invoice", await f.served(), f.signed)).request.value).toBe(4n);
    shop.close();

    const restored = V3Wallet.open(f.path("backup"), { construction: LIT, venue: f.venue, reference }); wallets.push(restored);
    expect(restored.isCopy()).toBe(true);
    expect(await refusal(() => restored.keyedRequest("order-B", f.backing, 4n))).toBe("COPIED");
    expect(await refusal(() => restored.exportBackup(b(79)))).toBe("COPIED");
    expect(await refusal(restored.keyedFulfill("invoice", await f.served(), f.signed))).toBe("COPIED");
    // Reads stay open.
    expect(restored.recoverySeed().length).toBe(32);
    expect(restored.recordRestoration()).toEqual({ requests: ["invoice"] });
    expect(restored.isCopy()).toBe(false);
    // Before its first read the backing's exposure is unknown; that read exposes every index through h + 256 (lit-v1 §8),
    // so the key the lost instance gave order-A is never given again.
    expect(await refusal(() => restored.keyedRequest("order-B", f.backing, 4n))).toBe("WINDOW");
    await restored.sync(await f.served(), f.signed);
    expect(await refusal(() => restored.keyedRequest("order-B", f.backing, 4n))).toBe("WINDOW");
    expect(same(lost.owner, pub(ownerSecret(restored.recoverySeed(), DOMAIN, f.backing, 1n)))).toBe(true);
    // The invoice the lost instance credited is refused, and credited only on the holder's word.
    expect(await refusalOf(restored.keyedFulfill("invoice", await f.served(), f.signed))).toMatch(/^RESTORED: .*--uncredited/);
    expect(restored.restoredRequests()).toEqual(["invoice"]);
    expect((await restored.keyedFulfill("invoice", await f.served(), f.signed, { uncredited: true })).request.value).toBe(4n);
    expect(restored.restoredRequests()).toEqual([]);
    // Recording again on the wallet's own file changes no key it exposed.
    expect(restored.recordRestoration()).toEqual({ requests: [] });
    await restored.sync(await f.served(), f.signed);
    expect(await refusal(() => restored.keyedRequest("order-B", f.backing, 4n))).toBe("WINDOW");
  });

  it("refuses paying again a request its lost instance paid, which the record shows from the seed's own spends (M13f)", async () => {
    const f = await fixture(), shop = f.open("shop");
    let payer = f.open("payer");
    await f.issue(payer.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    const invoice = shop.keyedRequest("invoice", f.backing, 4n), other = shop.keyedRequest("other", f.backing, 4n);
    await payer.sync(await f.served(), f.signed); payer.close();
    copyWallet(f.path("payer"), f.path("backup"));
    // After the backup the payer pays the invoice and is lost.
    payer = V3Wallet.open(f.path("payer"), { construction: LIT, venue: f.venue, reference }); wallets.push(payer);
    await payer.prepare("pay", { request: invoice, value: 4n }, await f.served(), f.signed);
    await payer.submit("pay", f.service); await f.checkpoint(); payer.close();

    const restored = V3Wallet.open(f.path("backup"), { construction: LIT, venue: f.venue, reference }); wallets.push(restored);
    restored.recordRestoration();
    expect((await restored.sync(await f.served(), f.signed)).forked).toBeUndefined();
    // Its spend of the backup's note created the invoice's exact output: a retry is refused before anything is built.
    expect(await refusalOf(restored.prepare("pay", { request: invoice, value: 4n }, await f.served(), f.signed)))
      .toBe("CONFLICT: a statement of this seed that this wallet did not save already paid the request: ask the payee before paying it again");
    expect(restored.payment("pay")).toBeUndefined();
    // A request nobody paid passes that check (and then waits for the window move a restoration asks for its change).
    expect(await refusal(restored.prepare("other", { request: other, value: 4n }, await f.served(), f.signed))).toBe("WINDOW");
    // A wallet restored from the seed alone reads the same.
    const seeded = f.restore("seeded", restored.recoverySeed());
    await seeded.sync(await f.served(), f.signed);
    expect(await refusalOf(seeded.prepare("pay", { request: invoice, value: 4n }, await f.served(), f.signed))).toMatch(/^CONFLICT: a statement of this seed that this wallet did not save already paid/);
  });

  it("refuses a window move's fee its lost instance already paid, as any payment of that request (M13f)", async () => {
    const f = await fixture(), operator = f.open("operator");
    let holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    for (let i = 1; i <= 256; i++) holder.keyedRequest(`r${i}`, f.backing, 1n);
    holder.close();
    copyWallet(f.path("holder"), f.path("backup"));
    // After the backup the holder moves its full window paying the operator's fee, and is lost.
    holder = V3Wallet.open(f.path("holder"), { construction: LIT, venue: f.venue, reference }); wallets.push(holder);
    const fee = { request: operator.keyedRequest("fee", f.backing, 1n), value: 1n };
    await holder.moveWindow("move", await f.served(), f.signed, fee);
    await holder.submit("move", f.service); await f.checkpoint(); holder.close();
    const restored = V3Wallet.open(f.path("backup"), { construction: LIT, venue: f.venue, reference }); wallets.push(restored);
    restored.recordRestoration();
    expect((await restored.sync(await f.served(), f.signed)).forked).toBeUndefined();
    expect(await refusalOf(restored.moveWindow("move", await f.served(), f.signed, fee)))
      .toBe("CONFLICT: a statement of this seed that this wallet did not save already paid the request: ask the payee before paying it again");
    expect(restored.payment("move")).toBeUndefined();
  });

  it("acts on nothing once a read finds its key paid above every index it exposed, or a note it held spent by another instance (M13f)", async () => {
    const f = await fixture(), holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    expect((await holder.sync(await f.served(), f.signed)).forked).toBeUndefined();
    // A second instance from the seed, beside the live one: its first read is its baseline and exposes through h + 256.
    const other = f.restore("other", holder.recoverySeed());
    expect((await other.sync(await f.served(), f.signed)).forked).toBeUndefined();
    // It moves its window, paying itself at index 256, which the live wallet never exposed (it exposed index 0).
    await other.moveWindow("move", await f.served(), f.signed);
    await other.submit("move", f.service); await f.checkpoint();
    expect((await other.sync(await f.served(), f.signed)).forked).toBeUndefined();
    const view = await holder.sync(await f.served(), f.signed);
    expect(view.forked).toBe(`an output of backing ${Buffer.from(f.backing).toString("hex")} pays its owner key at index 256, above every index this wallet exposed (0)`);
    expect(await refusalOf(Promise.resolve().then(() => holder.keyedRequest("next", f.backing, 1n))))
      .toMatch(/^FORKED: another instance of this wallet's seed has acted: an output of backing/);
    expect(await refusal(holder.burn("burn", 1n, await f.served(), f.signed))).toBe("FORKED");
    // An exact retry still answers with what was saved.
    expect(holder.keyedRequest("fund", f.backing, 10n).value).toBe(10n);
    // Recorded as the only instance, it reads every index through h + 256 as exposed, the other instance's included.
    holder.recordRestoration();
    expect((await holder.sync(await f.served(), f.signed)).forked).toBeUndefined();
    expect(await refusal(() => holder.keyedRequest("next", f.backing, 1n))).toBe("WINDOW");
    // The other instance, still running, finds the live one's window move in turn. Its exposure is restoration-derived and
    // reaches the move's key at 512 (Next 4 (bc)), but the move spent the note at 256 it held.
    await holder.moveWindow("move-2", await f.served(), f.signed);
    await holder.submit("move-2", f.service); await f.checkpoint();
    expect((await other.sync(await f.served(), f.signed)).forked).toMatch(/^the note \d+ of backing [0-9a-f]{64}, held at this wallet's read at index \d+, is spent by a statement this wallet did not make/);
  });

  it("trips on another instance's spend of a note even where its own spend of that note failed, and refuses paying that request (M13f review)", async () => {
    const f = await fixture(), shop = f.open("shop"), holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 10n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    const other = f.restore("other", holder.recoverySeed());
    await other.sync(await f.served(), f.signed);
    const x = shop.keyedRequest("x", f.backing, 10n), y = shop.keyedRequest("y", f.backing, 10n);
    // Both instances sign a spend of the one note; the other's is admitted, so the live wallet's own saved record fails.
    await holder.prepare("x", { request: x, value: 10n }, await f.served(), f.signed);
    await other.prepare("y", { request: y, value: 10n }, await f.served(), f.signed);
    await other.submit("y", f.service); await f.checkpoint();
    await expect(holder.submit("x", f.service)).rejects.toThrow(/SPENT/);
    const view = await holder.sync(await f.served(), f.signed);
    expect(holder.payment("x")!.status).toBe("failed");
    // The statement that spent the note is compared, not the note: x named it, but y spent it.
    expect(view.forked).toMatch(/^the note \d+ of backing [0-9a-f]{64}, held at this wallet's read at index \d+, is spent by a statement this wallet did not make/);
    expect(await refusal(() => holder.keyedRequest("next", f.backing, 1n))).toBe("FORKED");
    // Recorded as the only instance, it still refuses paying y, which a statement of its seed paid.
    holder.recordRestoration();
    await holder.sync(await f.served(), f.signed);
    expect(await refusalOf(holder.prepare("y-again", { request: y, value: 10n }, await f.served(), f.signed)))
      .toBe("CONFLICT: a statement of this seed that this wallet did not save already paid the request: ask the payee before paying it again");
  });

  /** A judgement no consistent history yields, written directly: the saved payment `name` reads failed while a door can still
   * admit it. */
  const markFailed = (path: string, name: string) => {
    const db = new DatabaseSync(path); db.prepare("UPDATE saved_records SET status='failed' WHERE alias=?").run(name); db.close();
  };

  it("pays a failed payment's request again only by spending a note the failed one spends, so at most one is admitted (Next 4 (bd))", async () => {
    const f = await fixture(), payer = f.open("payer"), shop = f.open("shop");
    await f.issue(payer.keyedRequest("a", f.backing, 10n)); await f.issue(payer.keyedRequest("b", f.backing, 7n)); await f.checkpoint();
    await payer.sync(await f.served(), f.signed);
    const invoice = shop.keyedRequest("invoice", f.backing, 6n), order = { request: invoice, value: 6n };
    const x = await payer.prepare("x", order, await f.served(), f.signed);
    // A prepared payment of the request holds it.
    expect(await refusalOf(payer.prepare("x-2", order, await f.served(), f.signed))).toBe("CONFLICT: request is already in a saved payment");
    markFailed(f.path("payer"), "x");
    await f.issue(payer.keyedRequest("c", f.backing, 6n)); await f.checkpoint();
    // The retry's output to the key derives from its own nullifiers, so it spends x's note, not the exact one.
    const retry = await payer.prepare("x-2", order, await f.served(), f.signed);
    expect(retry.inputs).toEqual(x.inputs);
    // Its outputs derive from the same nullifiers, the payee's included; only the change's key is new.
    expect([retry.payee === x.payee, same(retry.statement, x.statement)]).toEqual([true, false]);
    await payer.submit("x-2", f.service); await f.checkpoint();
    await expect(payer.submit("x", f.service)).rejects.toMatchObject({ code: "REFUSED", check: "SPENT" });
    await payer.sync(await f.served(), f.signed);
    expect([payer.payment("x")!.status, payer.payment("x-2")!.status]).toEqual(["failed", "final"]);
    expect((await shop.keyedFulfill("invoice", await f.served(), f.signed)).cm).toBe(retry.payee);
    // Once its retry is final, the request is held again.
    expect(await refusalOf(payer.prepare("x-3", order, await f.served(), f.signed))).toBe("CONFLICT: request is already in a saved payment");

    // A failed payment whose input another statement spent in canonical history is never admitted: its retry spends any notes.
    const other = shop.keyedRequest("other", f.backing, 5n), third = shop.keyedRequest("third", f.backing, 6n);
    const p = await payer.prepare("p", { request: other, value: 5n }, await f.served(), f.signed);
    markFailed(f.path("payer"), "p");
    const q = await payer.prepare("q", { request: third, value: 6n }, await f.served(), f.signed);
    expect(q.inputs).toEqual(p.inputs);
    await payer.submit("q", f.service); await f.checkpoint();
    const again = await payer.prepare("p-2", { request: other, value: 5n }, await f.served(), f.signed);
    expect(again.inputs.some(nf => p.inputs.includes(nf))).toBe(false);
  });

  it("refuses paying a failed payment's request again where no note it spends is free, or where it is final (Next 4 (bd))", async () => {
    const f = await fixture(), payer = f.open("payer"), shop = f.open("shop");
    await f.issue(payer.keyedRequest("a", f.backing, 10n)); await f.checkpoint();
    await payer.sync(await f.served(), f.signed);
    const invoice = shop.keyedRequest("invoice", f.backing, 4n), order = { request: invoice, value: 4n };
    await payer.prepare("x", order, await f.served(), f.signed);
    markFailed(f.path("payer"), "x");
    // Another payment takes the note x no longer reserves.
    await payer.prepare("z", { request: shop.keyedRequest("other", f.backing, 4n), value: 4n }, await f.served(), f.signed);
    expect(await refusalOf(payer.prepare("x-2", order, await f.served(), f.signed))).toBe("CONFLICT: the failed payment x to this " +
      "request can still be admitted and no note it spends is available: sync until it is decided");
    // Admitted and checkpointed, x is final whatever was written: its request is paid.
    const g = await fixture(), holder = g.open("holder"), seller = g.open("seller");
    await g.issue(holder.keyedRequest("a", g.backing, 10n)); await g.checkpoint();
    await holder.sync(await g.served(), g.signed);
    const bill = seller.keyedRequest("bill", g.backing, 4n);
    await holder.prepare("x", { request: bill, value: 4n }, await g.served(), g.signed);
    await holder.submit("x", g.service); await g.checkpoint();
    markFailed(g.path("holder"), "x");
    expect(await refusalOf(holder.prepare("x-2", { request: bill, value: 4n }, await g.served(), g.signed))).toBe("CONFLICT: request is already paid");
  });

  it("meets a failed fee's payment, names what blocks a retry, and keeps a window move's fee key held by a failed payment (Next 4 (bd) review)", async () => {
    const f = await fixture(), payer = f.open("payer"), shop = f.open("shop"), op = f.open("op");
    for (const n of ["a", "b", "c", "d"]) await f.issue(payer.keyedRequest(n, f.backing, 3n));
    await f.checkpoint(); await payer.sync(await f.served(), f.signed);
    const X = shop.keyedRequest("X", f.backing, 5n), Y = shop.keyedRequest("Y", f.backing, 5n);
    const p1 = await payer.prepare("p1", { request: X, value: 5n }, await f.served(), f.signed);
    const p2 = await payer.prepare("p2", { request: Y, value: 5n }, await f.served(), f.signed);
    markFailed(f.path("payer"), "p1"); markFailed(f.path("payer"), "p2");
    await f.issue(payer.keyedRequest("e", f.backing, 100n)); await f.checkpoint();
    // The 100 covers it but meets neither failed payment, and one note of each covers only 6: the rule blocks it, not funds.
    expect(await refusalOf(payer.prepare("r", { request: X, value: 5n, fee: { request: Y, value: 5n } }, await f.served(), f.signed)))
      .toBe("CONFLICT: no one- or two-note selection covers it while spending a note of each failed payment to its requests: sync until they are decided");
    // A failed payment to a key as a fee is met as one to it as the payee.
    const Z = shop.keyedRequest("Z", f.backing, 1n);
    const r = await payer.prepare("r", { request: Z, value: 1n, fee: { request: X, value: 5n } }, await f.served(), f.signed);
    expect(r.inputs.some(nf => p1.inputs.includes(nf))).toBe(true);

    // A retry that meets the failed payment by its one exact note and no change repeats its statement byte for byte.
    const g = await fixture(), holder = g.open("holder"), seller = g.open("seller");
    await g.issue(holder.keyedRequest("a", g.backing, 6n)); await g.issue(holder.keyedRequest("b", g.backing, 50n)); await g.checkpoint();
    await holder.sync(await g.served(), g.signed);
    const bill = { request: seller.keyedRequest("bill", g.backing, 6n), value: 6n };
    await holder.prepare("x", bill, await g.served(), g.signed);
    markFailed(g.path("holder"), "x");
    expect(await refusalOf(holder.prepare("x-2", bill, await g.served(), g.signed)))
      .toBe("CONFLICT: the payment repeats a statement this wallet saved: submit that payment again, or sync until it is decided");

    // A window move's fee key stays held by a failed payment naming it, also when the move's read turn follows that payment's.
    const h = await fixture(), mover = h.open("mover"), fee = h.open("fee"), store = h.open("store");
    await h.issue(mover.keyedRequest("a", h.backing, 2n)); await h.issue(mover.keyedRequest("b", h.backing, 5n)); await h.checkpoint();
    await mover.sync(await h.served(), h.signed);
    for (let i = 0; ; i++) { try { mover.keyedRequest(`r${i}`, h.backing, 1n); } catch { break; } }
    const F = fee.keyedRequest("F", h.backing, 2n), W = store.keyedRequest("W", h.backing, 2n), served = await h.served();
    const paying = mover.prepare("p", { request: F, value: 2n }, served, h.signed);
    const other = mover.prepare("z", { request: W, value: 2n }, served, h.signed);
    const move = mover.moveWindow("m", served, h.signed, { request: F, value: 2n });
    const p = await paying; markFailed(h.path("mover"), "p");
    // The note p no longer reserves went to z first: p had failed before the move's turn read it.
    expect((await other).inputs).toEqual(p.inputs);
    expect(await refusalOf(move)).toBe("CONFLICT: request is already in a saved payment");
  });

  it("restores a backup holding a failed window move read final beside the next move to its target (Next 4 (bd) read-back)", async () => {
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const f = await fixture(), w = f.open("w"), shop = f.open("shop");
    await f.issue(w.keyedRequest("a", f.backing, 5n)); await f.issue(w.keyedRequest("b", f.backing, 7n)); await f.checkpoint();
    await w.sync(await f.served(), f.signed);
    for (let i = 0; ; i++) { try { w.keyedRequest(`r${i}`, f.backing, 1n); } catch { break; } }
    await w.moveWindow("m1", await f.served(), f.signed);
    markFailed(f.path("w"), "m1");
    await w.prepare("pay", { request: shop.keyedRequest("s", f.backing, 5n), value: 5n }, await f.served(), f.signed);
    await w.moveWindow("m2", await f.served(), f.signed);
    // Evidence may move a failed record final (`resolve`); both moves then pay the wallet's own target key.
    const db = new DatabaseSync(f.path("w")); db.prepare("UPDATE saved_records SET status='final' WHERE alias='m1'").run(); db.close();
    const key = b(9), bytes = w.exportBackup(key);
    const copy = V3Wallet.restoreBackup(f.path("copy"), { construction: LIT, venue: f.venue, reference }, bytes, key, walletBackupDigest(bytes));
    wallets.push(copy);
    expect([copy.payment("m1")!.status, copy.payment("m2")!.status]).toEqual(["final", "prepared"]);
  });

  it("hands a restoration's marks to an encrypted backup's restored copy", async () => {
    const f = await fixture(), shop = f.open("shop");
    shop.keyedRequest("invoice", f.backing, 4n); shop.close();
    copyWallet(f.path("shop"), f.path("backup"));
    const restored = V3Wallet.open(f.path("backup"), { construction: LIT, venue: f.venue, reference }); wallets.push(restored);
    restored.recordRestoration();
    const key = b(80), backup = restored.exportBackup(key);
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const handed = V3Wallet.restoreBackup(f.path("handed"), { construction: LIT, venue: f.venue, reference }, backup, key, walletBackupDigest(backup));
    wallets.push(handed);
    expect(handed.isCopy()).toBe(false);
    expect(handed.restoredRequests()).toEqual(["invoice"]);
    expect(await refusal(handed.keyedFulfill("invoice", await f.served(), f.signed))).toBe("RESTORED");
  });

  it("hands a restored copy holding a saved window move, read or not, to a handoff that restores (M13e review)", async () => {
    const f = await fixture(), holder = f.open("holder");
    await f.issue(holder.keyedRequest("fund", f.backing, 2n)); await f.checkpoint();
    await holder.sync(await f.served(), f.signed);
    for (let i = 1; i <= 256; i++) holder.keyedRequest(`r${i}`, f.backing, 2n);
    await holder.moveWindow("move", await f.served(), f.signed);
    holder.close();
    copyWallet(f.path("holder"), f.path("backup"));
    const restored = V3Wallet.open(f.path("backup"), { construction: LIT, venue: f.venue, reference }); wallets.push(restored);
    restored.recordRestoration();
    // Exported before any read, its exposure unknown: the move's index is within h + 256.
    const key = b(81), backup = restored.exportBackup(key);
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const handed = V3Wallet.restoreBackup(f.path("handed"), { construction: LIT, venue: f.venue, reference }, backup, key, walletBackupDigest(backup));
    wallets.push(handed);
    expect(handed.payment("move")?.status).toBe("prepared");
    expect(handed.restoredRequests().length).toBe(257);
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
    for (let i = 2; i <= 256; i++) burner.keyedRequest(`r${i}`, g.backing, 1n);
    // h = 1: the burn's change takes index 257 = h + 256, the highest exposed key, which the move would pay.
    await burner.burn("b", 3n, await g.served(), g.signed);
    await expect(burner.moveWindow("move", await g.served(), g.signed))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("already pays the highest exposed key") });

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
    // The burn's change of 2 takes index 257 = h + 256; its segment then ends, and the burn fails with its note free.
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

describe("lit payment request frame (lit-v1 §8)", () => {
  it("is one fixed-width frame under a prefix-free tag, authenticated only by its exact digest", () => {
    const tags = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    expect(contexts.contextsArePrefixFree([...tags, WALLET_V3_REQUEST_CONTEXT, WALLET_LIT_REQUEST_CONTEXT])).toBe(true);
    const request: LitPaymentRequest = { domain: litConfigHash(), backing: new Uint8Array(32).fill(2), value: 7n,
      owner: ed25519.getPublicKey(new Uint8Array(32).fill(3)) };
    const frame = encodeLitPaymentRequest(request), digest = litPaymentRequestDigest(frame);
    expect(frame.length).toBe(WALLET_LIT_REQUEST_CONTEXT.length + 104);
    expect(authenticateLitPaymentRequest(frame, digest)).toEqual(request);
    const changed = Uint8Array.from(frame); changed[changed.length - 33]! ^= 1;
    expect(() => authenticateLitPaymentRequest(changed, digest)).toThrow("payment request does not match the trusted digest");
    expect(() => litPaymentRequestDigest(frame.subarray(1))).toThrow("not a lit payment request");
  });
});
