import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import * as contexts from "../src/contexts.js";
import { prepareExactOutput } from "../src/pool/v3/capsules.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { decodeRecord, encodeRecord, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import {
  createWalletBackupKey, decodeWalletSnapshot, encodeWalletSnapshot, MAX_WALLET_BACKUP_BYTES, openWalletBackup,
  sealWalletBackup, WALLET_V3_BACKUP_CONTEXT, walletBackupDigest,
} from "../src/pool/v3/wallet-backup.js";
import type { PaymentRequest } from "../src/pool/v3/wallet-request.js";
import type { LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { authorizeIssue, issueTask, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeReplacement, replacementMessage, type Replacement } from "../src/venue-records.js";

// Ports the frozen v2 offline-handoff cases (test/pool-wallet-backup.test.ts)
// to the v3 wallet, plus C4.6 seed restoration. Stand-in proofs, as in the payer tests.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), successorSecret = b(18);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret), successorKey = ed25519.getPublicKey(successorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const TABLES = ["receiver_requests", "receiver_fulfilled", "saved_records", "saved_inputs", "saved_outputs", "saved_superseded", "backer_acceptances"];
const COLUMNS = [5, 6, 15, 2, 5, 4, 5];
/** The specific refusal, not merely a throw. */
function throws(action: () => unknown, shape: unknown): void {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toEqual(shape);
}

describe("v3 wallet backup envelope", () => {
  const venue = b(7);

  it("authenticates key, domain, venue, digest, header, nonce, body, tag, length and suffix", () => {
    const key = createWalletBackupKey(), plaintext = new TextEncoder().encode("private wallet material");
    const sealed = sealWalletBackup(plaintext, key, domain, venue), digest = walletBackupDigest(sealed);
    expect(openWalletBackup(sealed, key, domain, venue, digest)).toEqual(plaintext);
    const refused = (...args: Parameters<typeof openWalletBackup>) =>
      expect(() => openWalletBackup(...args)).toThrow(new EncodingError("invalid wallet backup or recovery credentials"));
    refused(sealed, new Uint8Array(32), domain, venue, digest);
    refused(sealed, key, b(9), venue, digest);
    refused(sealed, key, domain, b(9), digest);
    refused(sealed, key, domain, venue, "0".repeat(64));
    refused(sealed, key, domain, venue, digest.toUpperCase());
    expect(() => walletBackupDigest(sealed.subarray(0, 40))).toThrow(EncodingError);
    for (const index of [0, WALLET_V3_BACKUP_CONTEXT.length, WALLET_V3_BACKUP_CONTEXT.length + 12, sealed.length - 1]) {
      const altered = sealed.slice(); altered[index]! ^= 1;
      refused(altered, key, domain, venue, walletBackupDigest(altered));
    }
    for (const framed of [sealed.subarray(0, sealed.length - 1), Uint8Array.from([...sealed, 0])]) {
      refused(framed, key, domain, venue, walletBackupDigest(framed));
    }
  });

  it("owns cipher inputs and plaintext outputs, and refuses invalid sizes and keys", () => {
    const key = createWalletBackupKey(), kept = key.slice(), plaintext = new Uint8Array([1, 2, 3, 4]), keptText = plaintext.slice();
    const sealed = sealWalletBackup(plaintext, key, domain, venue), keptSealed = sealed.slice();
    plaintext.fill(9); key.fill(8); sealed.fill(7);
    const opened = openWalletBackup(keptSealed, kept, domain, venue, walletBackupDigest(keptSealed));
    expect(opened).toEqual(keptText); opened.fill(0);
    expect(openWalletBackup(keptSealed, kept, domain, venue, walletBackupDigest(keptSealed))).toEqual(keptText);
    expect(() => sealWalletBackup(new Uint8Array(MAX_WALLET_BACKUP_BYTES), kept, domain, venue)).toThrow(EncodingError);
    expect(() => sealWalletBackup(new Uint8Array(), new Uint8Array(31), domain, venue)).toThrow(EncodingError);
    expect(() => sealWalletBackup(new Uint8Array(), kept, new Uint8Array(31), venue)).toThrow(EncodingError);
  });

  it("decodes only the exact snapshot framing", () => {
    const snapshot = { profile: "moe/wallet/v3/3", seed: b(3), tables: [[["a", new Uint8Array([1]), null]], []] };
    const bytes = encodeWalletSnapshot(snapshot);
    expect(decodeWalletSnapshot(bytes, [3, 2])).toEqual(snapshot);
    for (const bad of [bytes.subarray(0, bytes.length - 1), Uint8Array.from([...bytes, 0])]) {
      expect(() => decodeWalletSnapshot(bad, [3, 2])).toThrow(EncodingError);
    }
    expect(() => decodeWalletSnapshot(bytes, [3, 2, 1])).toThrow(/truncated/);
    expect(() => decodeWalletSnapshot(bytes, [2, 2])).toThrow(EncodingError);
    const kind = bytes.slice(); kind[4 + 15 + 32 + 4] = 3;
    expect(() => decodeWalletSnapshot(kind, [3, 2])).toThrow(/cell/);
    const text = encodeWalletSnapshot({ ...snapshot, tables: [[["é", null, null]], []] });
    text[text.indexOf(0xc3)] = 0xff;
    expect(() => decodeWalletSnapshot(text, [3, 2])).toThrow(/UTF-8/);
  });

  it("keeps its tag prefix-free against the protocol contexts and the request frame", async () => {
    const { WALLET_V3_REQUEST_CONTEXT } = await import("../src/pool/v3/wallet-request.js");
    const tags = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    expect(contexts.contextsArePrefixFree([...tags, WALLET_V3_REQUEST_CONTEXT, WALLET_V3_BACKUP_CONTEXT])).toBe(true);
  });
});

describe.skipIf(!supported)("v3 wallet offline handoff and seed restoration", () => {
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  const wallets: Wallet[] = [], journals: Journal[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    ({ DatabaseSync } = await import("node:sqlite"));
  });
  afterEach(() => {
    for (const wallet of wallets.splice(0)) { try { wallet.close(); } catch { /* already closed */ } }
    for (const journal of journals.splice(0)) journal.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const track = (wallet: Wallet): Wallet => { wallets.push(wallet); return wallet; };

  /** A payer with a final payment and a submitted pending one; a receiver with a
   * fulfilled request and an unpaid one. */
  async function fixture(readerVerifier: { verify: (...args: Parameters<typeof verifier.verify>) => boolean | Promise<boolean>; identities: typeof verifier.identities } = verifier) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-wallet-backup-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id,
      interval: 20n, payout: { thing: "backup units", quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    // The verifier declares the configuration's circuits, so each read keeps its replay state in the wallet's own files.
    const reader = { venue, reference, verifier: readerVerifier };
    const path = (name: string) => join(directory, `${name}.db`);
    const open = (name: string) => track(new V3Wallet(path(name), reader));
    const payer = open("payer"), receiver = open("receiver");
    const j = new V3OperatorJournal(join(directory, "journal.db"), { venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    for (const [i, value] of [10n, 6n, 4n].entries()) {
      await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, payer.request(`fund-${i}`, backing, value))), issuerSecret)));
    }
    let checkpoints = 0;
    const publish = async () => { await j.commit(`c${checkpoints++}`); await j.publish(); return (await j.package()).package; };
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    const invoice = receiver.request("invoice", backing, 7n), fee = prepareExactOutput(b(22), domain, b(33), backing, 1n);
    const feeRequest: PaymentRequest = { domain, opening: fee.opening, cm: fee.cm, capsule: fee.capsule };
    let served = await publish();
    await payer.prepare("shop", { request: invoice, value: 7n, fee: { request: feeRequest, value: 1n } }, served, signed, prove);
    await payer.submit("shop", service);
    served = await publish();
    await payer.sync(served, signed); await receiver.fulfill("invoice", served, signed);
    const second = receiver.request("second", backing, 3n), unpaid = receiver.request("unpaid", backing, 5n);
    await payer.prepare("pending", { request: second, value: 3n }, served, signed, prove);
    const receipt = await payer.submit("pending", service);
    const replace = async () => {
      const effective = venue.witnessedIndex() + 2n * lag + 2n;
      const unsigned: Replacement = { role: 1, successor: successorKey, predecessor: backing, effective,
        signature: new Uint8Array(64), successorSignature: new Uint8Array(64) };
      const message = replacementMessage(backing, unsigned);
      await venue.publishRecord(2, backing, encodeReplacement(backing,
        { ...unsigned, signature: ed25519.sign(message, issuerSecret), successorSignature: ed25519.sign(message, successorSecret) }));
      venue.advance(effective);
    };
    const takeover = async () => {
      const b2 = new V3OperatorJournal(join(directory, "successor.db"), { venue, reference, verifier, secret: successorSecret });
      journals.push(b2); await b2.takeover("takeover", signed, (await j.package()).package); await b2.publish(); await b2.adopt();
      return b2;
    };
    /** A further issue the journal serves and publishes: evidence no wallet has yet read, so a reader must judge its proof. */
    const issueMore = async (name: string, value: bigint) => {
      await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, payer.request(name, backing, value))), issuerSecret)));
      return publish();
    };
    return { directory, venue, signed, backing, reader, path, open, payer, receiver, j, publish, service, served, invoice, second,
      unpaid, receipt, replace, takeover, issueMore };
  }
  /** Every state row in storage order: what a handoff must carry exactly. */
  function rows(file: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return TABLES.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); } finally { db.close(); }
  }

  it("carries all local state, freezes every source handle across restart and continues in the restored copy", async () => {
    const f = await fixture(), key = createWalletBackupKey();
    const shop = f.payer.payment("shop")!, pending = f.payer.payment("pending")!, seed = f.payer.recoverySeed();
    const funds = [10n, 6n, 4n].map((value, i) => f.payer.request(`fund-${i}`, f.backing, value));
    expect(shop.status).toBe("final");
    const backup = f.payer.exportBackup(key), digest = walletBackupDigest(backup);
    expect(f.payer.custody()).toEqual({ frozen: true });
    // A lost reply retries the exact bytes, from any later handle and only to the same key.
    expect(f.payer.exportBackup(key)).toEqual(backup);
    const returned = f.payer.exportBackup(key); returned.fill(0);
    expect(f.payer.exportBackup(key)).toEqual(backup);
    throws(() => f.payer.exportBackup(new Uint8Array(32)), expect.objectContaining({ code: "INVALID" }));
    throws(() => f.payer.exportBackup(new Uint8Array(31)), expect.objectContaining({ code: "INVALID" }));
    const later = f.open("payer");
    expect(later.custody()).toEqual({ frozen: true });
    expect(later.exportBackup(key)).toEqual(backup);
    expect(later.payment("pending")).toEqual(pending);

    // Nothing acts on the frozen source, and nothing reaches the service.
    let sent = false;
    const spy = { submit: async (bytes: Uint8Array) => { sent = true; return f.service.submit(bytes); } };
    const fenced = expect.objectContaining({ code: "FENCED", message: "wallet was exported; only its restored copy may act" });
    throws(() => later.request("blocked", f.backing, 1n), fenced);
    await expect(later.submit("pending", spy)).rejects.toEqual(fenced);
    await expect(later.sync(f.served, f.signed)).rejects.toEqual(fenced);
    await expect(later.fulfill("fund-0", f.served, f.signed)).rejects.toEqual(fenced);
    await expect(later.prepare("pending", { request: f.second, value: 3n }, new Uint8Array(), f.signed, prove)).rejects.toEqual(fenced);
    await expect(later.reprove("pending", f.served, f.signed, prove)).rejects.toEqual(fenced);
    expect(sent).toBe(false);
    later.close();

    const restored = track(V3Wallet.restoreBackup(f.path("restored"), f.reader, backup, key, digest));
    expect(restored.custody()).toEqual({ frozen: false, restoredFrom: digest });
    expect(rows(f.path("restored"))).toEqual(rows(f.path("payer")));
    expect(restored.recoverySeed()).toEqual(seed);
    expect(restored.payment("shop")).toEqual(shop);
    expect(restored.payment("pending")).toEqual(pending);
    for (const [i, value] of [10n, 6n, 4n].entries()) expect(restored.request(`fund-${i}`, f.backing, value)).toEqual(funds[i]);
    // Exact retries and reservations continue; the saved receipt answers without the network.
    expect(await restored.prepare("pending", { request: f.second, value: 3n }, new Uint8Array(), f.signed, undefined as never)).toEqual(pending);
    expect(await restored.submit("pending", spy)).toEqual(f.receipt);
    expect(sent).toBe(false);
    const view = await restored.sync(f.served, f.signed);
    expect(view.holdings.filter(h => h.status === "reserved").map(h => h.cm)).toHaveLength(1);
    await restored.sync(await f.publish(), f.signed);
    expect(restored.payment("pending")).toMatchObject({ status: "final", receipt: f.receipt });
    expect(restored.request("fresh", f.backing, 1n).cm).not.toBe(restored.request("fresh-2", f.backing, 1n).cm);

    // The receiver's labels, fulfillment and unpaid request travel the same way.
    const fulfilled = f.receiver.fulfillment("invoice")!, receiverKey = createWalletBackupKey();
    const receiverBackup = f.receiver.exportBackup(receiverKey);
    const receiver = track(V3Wallet.restoreBackup(f.path("receiver-restored"), f.reader, receiverBackup, receiverKey,
      walletBackupDigest(receiverBackup)));
    expect(receiver.fulfillment("invoice")).toEqual(fulfilled);
    expect(receiver.request("unpaid", f.backing, 5n)).toEqual(f.unpaid);
    await expect(receiver.fulfill("invoice", f.served, f.signed)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await receiver.fulfill("second", (await f.j.package()).package, f.signed)).request).toEqual(f.second);
  });

  it("refuses wrong credentials, another wallet's venue, corruption, inconsistent state and occupied destinations", async () => {
    const f = await fixture(), key = createWalletBackupKey(), backup = f.payer.exportBackup(key), digest = walletBackupDigest(backup);
    const invalid = expect.objectContaining({ code: "INVALID", message: "invalid wallet backup or recovery credentials" });
    let n = 0;
    const attempt = (reader: typeof f.reader, bytes: Uint8Array, k: Uint8Array, d: string) =>
      () => V3Wallet.restoreBackup(f.path(`bad-${n++}`), reader, bytes, k, d);
    throws(attempt(f.reader, backup, new Uint8Array(32), digest), invalid);
    throws(attempt(f.reader, backup, key, "0".repeat(64)), invalid);
    throws(attempt(f.reader, backup, key, digest.toUpperCase()), invalid);
    throws(attempt({ ...f.reader, venue: FixtureVenue.reference(b(13), lag), reference: { ...reference, label: b(13) } }, backup, key, digest), invalid);
    // The same state sealed under a domain other than the adopted configuration's.
    const foreign = sealWalletBackup(openWalletBackup(backup, key, domain, f.venue.id, digest), key, b(9), f.venue.id);
    throws(attempt(f.reader, foreign, key, walletBackupDigest(foreign)), invalid);
    const altered = backup.slice(); altered[altered.length >> 1]! ^= 1;
    throws(attempt(f.reader, altered, key, walletBackupDigest(altered)), invalid);

    // Authentic envelopes whose plaintext no wallet could have written.
    const sealed = (plaintext: Uint8Array) => { const bytes = sealWalletBackup(plaintext, key, domain, f.venue.id); return [bytes, walletBackupDigest(bytes)] as const; };
    const snapshot = decodeWalletSnapshot(openWalletBackup(backup, key, domain, f.venue.id, digest), COLUMNS);
    const variant = (change: (tables: unknown[][][]) => void, profile = snapshot.profile) => {
      const tables = snapshot.tables.map(rows => rows.map(row => [...row])); change(tables);
      return sealed(encodeWalletSnapshot({ profile, seed: snapshot.seed, tables: tables as never }));
    };
    const refused = (pair: readonly [Uint8Array, string], message: RegExp) =>
      throws(attempt(f.reader, pair[0], key, pair[1]), expect.objectContaining({ code: "INVALID", message: expect.stringMatching(message) }));
    refused(sealed(new TextEncoder().encode("[[],[],[],[],[],[],[],[],[]]")), /invalid wallet snapshot/);
    refused(variant(() => {}, "moe/wallet/v3/3"), /another profile/);
    refused(variant(t => { t[3]!.push(["1", "nobody"]); }), /does not fit|unmatched references/);
    refused(variant(t => { t[4]!.push(["1", "nobody", "1", "1", "1"]); }), /does not fit|unmatched references/);
    refused(variant(t => { t[5]!.push(["00", "nobody", b(1), null]); }), /does not fit|unmatched references/);
    refused(variant(t => { t[2]![0]![1] = "7"; }), /does not fit/);
    refused(variant(t => {
      // The prepared payment's twin under another alias, reserving the same note.
      const pending = t[2]!.find(row => row[9] === "prepared")!, held = t[3]!.find(row => row[1] === pending[0])!;
      t[2]!.push(["twin", ...pending.slice(1, 3), "ab".repeat(32), ...pending.slice(4)]); t[3]!.push([held[0], "twin"]);
    }), /reserves a note twice/);
    refused(variant(t => { t[1]!.push(["stranger", "123", b(1), "0", b(3), b(4)]); }), /unmatched references/);
    refused(variant(t => { t[0]![0]![3] = new Uint8Array([1]) as never; }), /does not fit/);
    refused(variant(t => { t[2]![0]![9] = "cancelled"; }), /does not fit/);
    refused(variant(t => { t[0]!.push(t[0]![0]!); }), /does not fit/);
    // Repeats belong to demands only; a freshen intent names one demand and has one positive output.
    refused(variant(t => { t[2]![0]![14] = "[]"; }), /does not fit/);
    refused(variant(t => { const row = t[2]!.find(r => r[1] === "2")!; row[2] = JSON.stringify(["00", "freshen", "zz"]); }), /malformed saved record/);

    // Destinations must be new: files, the source, memory and leftover sidecars refuse.
    const occupied = f.path("occupied"); writeFileSync(occupied, "keep");
    const conflict = expect.objectContaining({ code: "CONFLICT", message: "recovery requires a new destination" });
    throws(() => V3Wallet.restoreBackup(occupied, f.reader, backup, key, digest), conflict);
    throws(() => V3Wallet.restoreBackup(f.path("payer"), f.reader, backup, key, digest), conflict);
    throws(() => V3Wallet.restoreBackup(":memory:", f.reader, backup, key, digest), expect.objectContaining({ code: "STORAGE" }));
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = f.path(`sidecar${suffix}`); writeFileSync(`${sidecar}${suffix}`, "keep");
      throws(() => V3Wallet.restoreBackup(sidecar, f.reader, backup, key, digest), conflict);
      expect(existsSync(sidecar)).toBe(false);
    }
    // A refused restore leaves nothing a later open could turn into a wallet, and no staging file.
    expect(readdirSync(f.directory).filter(name => name.startsWith("bad-") || name.includes(".restore-"))).toEqual([]);
    // Caller buffers are read once: a restore owns what it was given.
    const ownedBytes = backup.slice(), ownedKey = key.slice();
    const owned = track(V3Wallet.restoreBackup(f.path("owned"), f.reader, ownedBytes, ownedKey, digest));
    ownedBytes.fill(0); ownedKey.fill(0);
    expect(owned.payment("pending")).toEqual(f.payer.payment("pending"));
  });

  it.each(["table", "column", "oversize"] as const)("refuses unsupported or excessive %s state without freezing the source", async kind => {
    const f = await fixture(); f.payer.close();
    const db = new DatabaseSync(f.path("payer"));
    if (kind === "table") db.exec("CREATE TABLE extension (value TEXT)");
    if (kind === "column") db.exec("ALTER TABLE saved_inputs ADD COLUMN extension TEXT");
    if (kind === "oversize") db.prepare("UPDATE receiver_requests SET cm=? WHERE alias='fund-0'").run("1".repeat(MAX_WALLET_BACKUP_BYTES));
    db.close();
    const wallet = f.open("payer");
    throws(() => wallet.exportBackup(createWalletBackupKey()), expect.objectContaining({ code: "INVALID",
      message: expect.stringMatching(/unsupported wallet (schema|columns)|exceeds the offline backup limit/) }));
    expect(wallet.custody()).toEqual({ frozen: false });
    expect(wallet.request(`after-${kind}`, f.backing, 1n).cm).toBeTypeOf("bigint");
  });

  it("refuses a submit completion after the freeze and the restored copy's exact retry obtains the receipt", async () => {
    const f = await fixture(), other = f.receiver.request("racing", f.backing, 2n);
    const racing = await f.payer.prepare("racing", { request: other, value: 2n }, f.served, f.signed, prove);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
    const submitting = f.payer.submit("racing", { submit: async bytes => { entered(); await gate; return f.service.submit(bytes); } });
    await started;
    const key = createWalletBackupKey(), backup = f.payer.exportBackup(key);
    release();
    await expect(submitting).rejects.toMatchObject({ code: "FENCED" });
    const restored = track(V3Wallet.restoreBackup(f.path("submit-restored"), f.reader, backup, key, walletBackupDigest(backup)));
    expect(restored.payment("racing")).toEqual({ ...racing, receipt: undefined });
    // The journal answers the identical bytes with its original receipt.
    const receipt = await restored.submit("racing", f.service);
    expect(receipt.statementHash).toEqual(racing.statement);
    expect(restored.payment("racing")!.receipt).toEqual(receipt);
  });

  it("refuses a fulfillment completion after the freeze and the restored copy fulfills once", async () => {
    let gate: Promise<void> | undefined, release = () => {}, entered = () => {};
    const started = new Promise<void>(r => { entered = r; });
    const f = await fixture({ verify: async (...args) => {
      const held = gate;
      if (held !== undefined) { gate = undefined; entered(); await held; }
      return verifier.verify(...args);
    }, identities: configuration.circuits });
    await f.publish();
    const served = (await f.j.package()).package;
    gate = new Promise(r => { release = r; });
    const fulfilling = f.receiver.fulfill("second", served, f.signed);
    await started;
    const key = createWalletBackupKey(), backup = f.receiver.exportBackup(key);
    release();
    await expect(fulfilling).rejects.toMatchObject({ code: "FENCED" });
    const restored = track(V3Wallet.restoreBackup(f.path("fulfill-restored"), f.reader, backup, key, walletBackupDigest(backup)));
    expect(restored.fulfillment("second")).toBeUndefined();
    expect((await restored.fulfill("second", served, f.signed)).request).toEqual(f.second);
    await expect(restored.fulfill("second", served, f.signed)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses to prove a payment whose evidence read spanned the freeze", async () => {
    let gate: Promise<void> | undefined, release = () => {}, entered = () => {};
    const started = new Promise<void>(r => { entered = r; });
    const f = await fixture({ verify: async (...args) => {
      const held = gate;
      if (held !== undefined) { gate = undefined; entered(); await held; }
      return verifier.verify(...args);
    }, identities: configuration.circuits });
    const other = f.receiver.request("late", f.backing, 2n);
    // The wallet keeps what it has judged, so the read that spans the freeze must meet a proof it has not: a further issue.
    const fresh = await f.issueMore("fund-late", 5n);
    let proved = false;
    gate = new Promise(r => { release = r; });
    const preparing = f.payer.prepare("late", { request: other, value: 2n }, fresh, f.signed, async task => { proved = true; return prove(task); });
    await started;
    const key = createWalletBackupKey(), backup = f.payer.exportBackup(key);
    release();
    await expect(preparing).rejects.toMatchObject({ code: "FENCED" });
    expect(proved).toBe(false);
    const restored = track(V3Wallet.restoreBackup(f.path("late-restored"), f.reader, backup, key, walletBackupDigest(backup)));
    expect(restored.payment("late")).toBeUndefined();
  });

  it("does not erase a destination another process created during the restore", async () => {
    const f = await fixture(), key = createWalletBackupKey(), backup = f.payer.exportBackup(key);
    const destination = f.path("raced"), original = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string): void {
      if (!injected && sql === "BEGIN IMMEDIATE") {
        injected = true;
        const other = new V3Wallet(destination, f.reader); other.request("interleaved", f.backing, 1n); other.close();
      }
      original.call(this, sql);
    };
    try {
      throws(() => V3Wallet.restoreBackup(destination, f.reader, backup, key, walletBackupDigest(backup)),
        expect.objectContaining({ code: "CONFLICT", message: "recovery requires a new destination" }));
    } finally { DatabaseSync.prototype.exec = original; }
    expect(injected).toBe(true);
    expect(readdirSync(f.directory).filter(name => name.includes(".restore-"))).toEqual([]);
    const reopened = f.open("raced");
    expect(reopened.custody()).toEqual({ frozen: false });
    expect(reopened.payment("pending")).toBeUndefined();
    expect(reopened.request("interleaved", f.backing, 1n).cm).toBeTypeOf("bigint");
  });

  it("reproves an exported pending payment from the restored copy after operator takeover", async () => {
    const f = await fixture(), pending = f.payer.payment("pending")!;
    const key = createWalletBackupKey(), backup = f.payer.exportBackup(key);
    await f.replace();
    const successor = await f.takeover(), served = (await successor.package()).package;
    const restored = track(V3Wallet.restoreBackup(f.path("reproof-restored"), f.reader, backup, key, walletBackupDigest(backup)));
    const reproven = await restored.reprove("pending", served, f.signed, prove);
    expect(decodeRecord(reproven.record).publicInputs.slice(7)).toEqual(decodeRecord(pending.record).publicInputs.slice(7));
    expect(reproven.superseded).toEqual([{ record: pending.record, receipt: f.receipt }]);
    const receipt = await restored.submit("pending", { submit: async bytes => decodeReceipt(await successor.submit(bytes)) });
    expect(receipt.operator).toEqual(successorKey);
    await successor.commit("reproven"); await successor.publish();
    await restored.sync((await successor.package()).package, f.signed);
    expect(restored.payment("pending")).toMatchObject({ status: "final" });
  });

  it("restores holdings, change included, from the seed alone and nothing else (C4.6)", async () => {
    const f = await fixture();
    await f.payer.submit("pending", f.service);
    const served = await f.publish(), seed = f.payer.recoverySeed();
    const original = await f.payer.sync(served, f.signed);
    const fromSeed = track(V3Wallet.restoreSeed(f.path("seed"), f.reader, seed));
    expect(fromSeed.recoverySeed()).toEqual(seed);
    expect(fromSeed.custody()).toEqual({ frozen: false });
    const view = await fromSeed.sync(served, f.signed);
    expect(view.holdings).toEqual(original.holdings);
    // Change from both payments is among them; the labels, payments and requests are not.
    expect(view.holdings.map(h => h.value).sort()).toEqual([1n, 2n, 6n]);
    expect(fromSeed.payment("shop")).toBeUndefined();
    expect(fromSeed.fulfillment("invoice")).toBeUndefined();
    // New requests draw fresh identifiers; a seed-found note pays like any other.
    expect(fromSeed.request("fund-0", f.backing, 10n).cm).not.toBe(f.payer.request("fund-0", f.backing, 10n).cm);
    const other = f.receiver.request("from-seed", f.backing, 5n);
    const paid = await fromSeed.prepare("from-seed", { request: other, value: 5n }, served, f.signed, prove);
    expect(paid.inputs).toHaveLength(1);
    throws(() => V3Wallet.restoreSeed(f.path("short"), f.reader, new Uint8Array(31)), expect.objectContaining({ code: "INVALID" }));
    throws(() => V3Wallet.restoreSeed(f.path("seed"), f.reader, seed), expect.objectContaining({ code: "CONFLICT" }));
  });

  it("opens and exports a database created before offline handoff", async () => {
    const f = await fixture(); f.payer.close();
    const db = new DatabaseSync(f.path("payer")); db.exec("DROP TABLE wallet_custody"); db.close();
    const wallet = f.open("payer");
    expect(wallet.custody()).toEqual({ frozen: false });
    const key = createWalletBackupKey(), backup = wallet.exportBackup(key);
    const restored = track(V3Wallet.restoreBackup(f.path("legacy-restored"), f.reader, backup, key, walletBackupDigest(backup)));
    expect(restored.payment("pending")).toEqual(wallet.payment("pending"));
  });
});
