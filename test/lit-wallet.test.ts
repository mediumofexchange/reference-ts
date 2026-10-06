import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { compareBytes } from "../src/bytes.js";
import { decodeReceipt } from "../src/lit/commitments.js";
import { litConfigHash } from "../src/lit/configuration.js";
import { LIT } from "../src/lit/construction.js";
import { encodeRecord, statementBytes, type Statement } from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { decodeLitPackage, decodeLitSegmentHeader, decodeLitTrail, litSegmentIdentity } from "../src/lit/transport.js";
import { ownerSecret } from "../src/lit/wallet-keys.js";
import type { LitPaymentRequest } from "../src/lit/wallet.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import type { V3Wallet as Wallet, V3WalletError as WalletError } from "../src/pool/v3/wallet-store.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { keptFileDigest } from "../src/pool/v3/replay-store.js";

// The one wallet (src/pool/v3/wallet-store.ts) holding lit-v1 notes (slice 14 M14g1): requests by owner key, notes found by
// owner keys per backing under doubling windows (lit-v1 §8), payments signed by the notes' owners, credited once. A lit
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
    // A pool request on a lit wallet, and a lit act not taken yet, refuse by name.
    expect(await refusal(() => receiver.request("pool", f.backing, 1n))).toBe("INVALID");
    expect(await refusal(receiver.burn("burn", 1n, await f.served(), f.signed, async () => { throw new Error("no prover"); }))).toBe("INVALID");
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
