import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import type { SegmentAuthority } from "../src/pool/statement.js";
import type { PoolWalletStore as Wallet, WalletDelivery } from "../src/pool/wallet-store.js";
import {
  MAX_WALLET_BACKUP_BYTES,
  createWalletBackupKey,
  openWalletBackup,
  sealWalletBackup,
  walletBackupDigest,
} from "../src/pool/wallet-backup.js";
import { LocalVenue } from "../src/venue.js";
import { CONFIG, DOMAIN, issueStatement, Oracle, spendStatement, VENUE } from "./pool-support.js";
import { evidence, open, terms } from "./pool-record-support.js";
import { SECRETS } from "./support.js";

const nodeHasSqlite = Number(process.versions.node.split(".")[0]) >= 24;

function changedAuthority(authority: SegmentAuthority): SegmentAuthority {
  const segment = authority.segment.slice();
  segment[0] = segment[0]! ^ 1;
  return { ...authority, segment };
}

describe("wallet backup envelope", () => {
  const authority = { domain: new Uint8Array(32).fill(1), segment: new Uint8Array(32).fill(2),
    operator: new Uint8Array(32).fill(3), scopeRoot: 4n };

  it("authenticates key, authority, digest, header, nonce, body, tag, length, and suffix", () => {
    const key = createWalletBackupKey(), plaintext = new TextEncoder().encode("private wallet material");
    const sealed = sealWalletBackup(plaintext, key, authority), digest = walletBackupDigest(sealed);
    expect(openWalletBackup(sealed, key, authority, digest)).toEqual(plaintext);
    expect(() => openWalletBackup(sealed, new Uint8Array(32), authority, digest)).toThrow(/invalid wallet backup/);
    for (const wrong of [changedAuthority(authority), { ...authority, domain: new Uint8Array(32).fill(9) },
      { ...authority, operator: new Uint8Array(32).fill(9) }, { ...authority, scopeRoot: 9n }]) {
      expect(() => openWalletBackup(sealed, key, wrong, digest)).toThrow(/invalid wallet backup/);
    }
    expect(() => openWalletBackup(sealed, key, authority, "0".repeat(64))).toThrow(/invalid wallet backup/);
    expect(() => openWalletBackup(sealed, key, authority, digest.toUpperCase())).toThrow(/invalid wallet backup/);
    expect(() => walletBackupDigest(sealed.subarray(0, 20))).toThrow(/invalid wallet backup/);

    for (const index of [0, 22, 35, sealed.length - 1]) {
      const altered = sealed.slice(); altered[index]! ^= 1;
      expect(() => openWalletBackup(altered, key, authority, walletBackupDigest(altered))).toThrow(/invalid wallet backup/);
    }
    for (const framed of [sealed.subarray(0, sealed.length - 1), Uint8Array.from([...sealed, 0])]) {
      expect(() => openWalletBackup(framed, key, authority, walletBackupDigest(framed))).toThrow(/invalid wallet backup/);
    }
  });

  it("owns cipher inputs and plaintext outputs", () => {
    const key = createWalletBackupKey(), retainedKey = key.slice();
    const plaintext = new Uint8Array([1, 2, 3, 4]), retainedPlaintext = plaintext.slice();
    const sealed = sealWalletBackup(plaintext, key, authority), retainedSealed = sealed.slice();
    plaintext.fill(9); key.fill(8); sealed.fill(7);
    const opened = openWalletBackup(retainedSealed, retainedKey, authority, walletBackupDigest(retainedSealed));
    expect(opened).toEqual(retainedPlaintext);
    opened.fill(0);
    expect(openWalletBackup(retainedSealed, retainedKey, authority, walletBackupDigest(retainedSealed))).toEqual(retainedPlaintext);
  });

  it("rejects invalid sizes and key shapes", () => {
    expect(() => createWalletBackupKey()).not.toThrow();
    expect(() => sealWalletBackup(new Uint8Array(MAX_WALLET_BACKUP_BYTES), new Uint8Array(32), authority)).toThrow(/invalid wallet backup/);
    expect(() => sealWalletBackup(new Uint8Array(), new Uint8Array(31), authority)).toThrow(/invalid wallet backup/);
  });
});

describe.skipIf(!nodeHasSqlite)("offline pool wallet export and recovery", () => {
  let PoolWalletStore: typeof import("../src/pool/wallet-store.js").PoolWalletStore;
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  const wallets: Wallet[] = [], directories: string[] = [], scratch = resolve("scratch");

  beforeAll(async () => {
    ({ PoolWalletStore } = await import("../src/pool/wallet-store.js"));
    ({ DatabaseSync } = await import("node:sqlite"));
  });
  afterEach(() => {
    for (const wallet of wallets.splice(0)) {
      try { wallet.close(); } catch { /* already closed */ }
    }
    for (const path of directories.splice(0)) {
      if (!resolve(path).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(path, { recursive: true, force: true });
    }
  });

  function directory(): string {
    mkdirSync(scratch, { recursive: true });
    const path = mkdtempSync(join(scratch, "pool-wallet-backup-")); directories.push(path); return path;
  }
  function track(wallet: Wallet): Wallet { wallets.push(wallet); return wallet; }
  function close(wallet: Wallet): void { wallet.close(); wallets.splice(wallets.indexOf(wallet), 1); }

  async function fullFixture(fulfill = true) {
    const dir = directory(), venue = new LocalVenue(VENUE), oracle = new Oracle(), backing = terms("EUR");
    const segment = open(venue, [backing], oracle), authority = segment.authority(), path = join(dir, "source.db");
    const wallet = track(new PoolWalletStore(path, authority));
    const invoice = wallet.request("invoice", backing.backing.name, 10n), invoiceSecret = wallet.secret("invoice");
    const deliveryToken = wallet.deliveryToken("invoice");
    const opening = { backing: invoice.backing, value: invoice.value, owner: invoice.owner,
      rho: wallet.derive("output-rho", [1n]) };
    const issue = oracle.accept(issueStatement(authority, invoice.backing, invoice.value,
      commitmentOf(DOMAIN, opening), SECRETS.backer));
    const issueAccepted = await segment.admit(issue);
    const issueReceipt = signPoolReceipt(SECRETS.operator, authority, issueAccepted, 0n);
    const checkpoint = evidence(segment); venue.publish(checkpoint.commitment);
    const checkpointArgs = { configuration: CONFIG, venue, verifier: oracle,
      checkpoint: checkpoint.commitment, evidence: [checkpoint] };
    const delivery: WalletDelivery = { statement: issue, opening, receipt: issueReceipt };
    wallet.receiveDelivery("invoice", delivery);
    if (fulfill) await wallet.fulfill("invoice", delivery, checkpointArgs);

    const other = wallet.request("pending-invoice", backing.backing.name, 7n), otherSecret = wallet.secret("pending-invoice");
    const payment = { backing: other.backing, value: other.value, owner: other.owner,
      rho: wallet.derive("output-rho", [2n]) };
    const change = { ...payment, value: 3n, rho: wallet.derive("output-rho", [2n], 1) };
    const root = segment.prefix().roots.at(-1)!;
    const spend = oracle.accept(spendStatement(authority, [root, root], [81n, 82n],
      [commitmentOf(DOMAIN, payment), commitmentOf(DOMAIN, change)]));
    wallet.prepare("payment", spend, payment, change);
    const spendReceipt = signPoolReceipt(SECRETS.operator, authority, await segment.admit(spend), 0n);
    await wallet.submit("payment", { submit: async () => spendReceipt });
    return { dir, path, wallet, authority, backing, segment, oracle, venue, invoice, invoiceSecret,
      deliveryToken, delivery, checkpointArgs, other, otherSecret, payment, change, spend, spendReceipt };
  }

  it("round trips all logical state and freezes every source handle across restart", async () => {
    const f = await fullFixture(), second = track(new PoolWalletStore(f.path, f.authority));
    const expectedNext = ownerOf(f.wallet.derive("request-secret", [3n]));
    const key = createWalletBackupKey(), backup = f.wallet.exportBackup(key), digest = walletBackupDigest(backup);
    expect(f.wallet.custody()).toEqual({ frozen: true });
    expect(second.custody()).toEqual({ frozen: true });
    expect(f.wallet.exportBackup(key)).toEqual(backup);
    const returned = second.exportBackup(key);
    expect(returned).toEqual(backup);
    returned.fill(0);
    expect(second.exportBackup(key)).toEqual(backup);
    expect(() => second.exportBackup(new Uint8Array(32))).toThrow(/invalid wallet backup/);
    expect(f.wallet.secret("invoice")).toBe(f.invoiceSecret);
    expect(f.wallet.pending("payment")).toEqual({ statement: f.spend, opening: f.payment, change: f.change, receipt: f.spendReceipt });
    expect(f.wallet.inbox("invoice")).toEqual(f.delivery);
    expect(f.wallet.fulfillment("invoice")).toEqual({ opening: f.delivery.opening,
      receipt: f.delivery.receipt, checkpoint: f.checkpointArgs.checkpoint });

    let submitted = false;
    expect(() => second.request("blocked", f.invoice.backing, 1n)).toThrow(/frozen/);
    expect(() => second.deliveryToken("invoice")).toThrow(/frozen/);
    expect(second.authorizesDelivery("invoice", f.deliveryToken)).toBe(false);
    expect(() => second.receiveDelivery("invoice", f.delivery)).toThrow(/frozen/);
    expect(() => second.prepare("blocked", f.spend)).toThrow(/frozen/);
    await expect(second.submit("payment", { submit: async () => { submitted = true; return f.spendReceipt; } })).rejects.toThrow(/frozen/);
    expect(submitted).toBe(false);
    await expect(second.fulfill("invoice", f.delivery, f.checkpointArgs)).rejects.toThrow(/frozen/);

    close(f.wallet); close(second);
    const restarted = track(new PoolWalletStore(f.path, f.authority));
    expect(restarted.custody()).toEqual({ frozen: true });
    expect(() => restarted.request("blocked", f.invoice.backing, 1n)).toThrow(/frozen/);
    expect(restarted.exportBackup(key)).toEqual(backup);

    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "restored.db"), f.authority, backup, key, digest));
    expect(restored.custody()).toEqual({ frozen: false, restoredFrom: digest });
    expect(restored.request("invoice", f.invoice.backing, f.invoice.value)).toEqual(f.invoice);
    expect(restored.secret("invoice")).toBe(f.invoiceSecret);
    expect(restored.request("pending-invoice", f.other.backing, f.other.value)).toEqual(f.other);
    expect(restored.secret("pending-invoice")).toBe(f.otherSecret);
    expect(restored.deliveryToken("invoice")).toBe(f.deliveryToken);
    expect(restored.inbox("invoice")).toEqual(f.delivery);
    expect(restored.pending("payment")).toEqual({ statement: f.spend, opening: f.payment, change: f.change, receipt: f.spendReceipt });
    expect(restored.fulfillment("invoice")).toEqual({ opening: f.delivery.opening,
      receipt: f.delivery.receipt, checkpoint: f.checkpointArgs.checkpoint });
    expect(() => restored.prepare("reuse-first", spendStatement(f.authority, [1n, 1n], [81n, 91n], [1n, 2n]))).toThrow(/reserved/);
    expect(() => restored.prepare("reuse-second", spendStatement(f.authority, [1n, 1n], [92n, 82n], [1n, 2n]))).toThrow(/reserved/);
    expect(restored.request("fresh", f.invoice.backing, 1n).owner).toBe(expectedNext);
  });

  it("keeps secrets out of ciphertext and rejects wrong credentials, corruption, noncanonical state, and occupied paths", async () => {
    const f = await fullFixture(), key = createWalletBackupKey(), backup = f.wallet.exportBackup(key), digest = walletBackupDigest(backup);
    const cipherText = Buffer.from(backup).toString("utf8");
    for (const secret of [f.invoiceSecret.toString(), f.otherSecret.toString(), f.deliveryToken,
      bytesToHex(f.delivery.statement.proof), bytesToHex(f.delivery.receipt.signature)]) {
      expect(cipherText).not.toContain(secret);
    }
    const attempts: Array<[Uint8Array, Uint8Array, SegmentAuthority, string]> = [
      [backup, new Uint8Array(32), f.authority, digest],
      [backup, key, changedAuthority(f.authority), digest],
      [backup, key, f.authority, "0".repeat(64)],
    ];
    for (const [bytes, suppliedKey, authority, expected] of attempts) {
      expect(() => PoolWalletStore.restoreBackup(join(f.dir, `bad-${Math.random()}.db`), authority, bytes, suppliedKey, expected)).toThrow(/invalid wallet backup/);
    }
    const altered = backup.slice(); altered[altered.length >> 1]! ^= 1;
    expect(() => PoolWalletStore.restoreBackup(join(f.dir, "altered.db"), f.authority, altered, key, walletBackupDigest(altered))).toThrow(/invalid wallet backup/);
    const noncanonical = sealWalletBackup(new TextEncoder().encode("[ [],[],[],[],[],[],[] ]"), key, f.authority);
    expect(() => PoolWalletStore.restoreBackup(join(f.dir, "noncanonical.db"), f.authority, noncanonical, key, walletBackupDigest(noncanonical))).toThrow(/snapshot/);

    const ownedBytes = backup.slice(), ownedKey = key.slice();
    const owned = track(PoolWalletStore.restoreBackup(join(f.dir, "owned.db"), f.authority, ownedBytes, ownedKey, digest));
    ownedBytes.fill(0); ownedKey.fill(0);
    expect(owned.secret("invoice")).toBe(f.invoiceSecret);

    const occupied = join(f.dir, "occupied.db"); writeFileSync(occupied, "keep");
    expect(() => PoolWalletStore.restoreBackup(occupied, f.authority, backup, key, digest)).toThrow(/EEXIST|new destination/);
    expect(() => PoolWalletStore.restoreBackup(f.path, f.authority, backup, key, digest)).toThrow(/EEXIST|new destination/);
    expect(() => PoolWalletStore.restoreBackup(":memory:", f.authority, backup, key, digest)).toThrow(/new destination/);
    const sidecar = join(f.dir, "sidecar.db"); writeFileSync(sidecar + "-wal", "keep");
    expect(() => PoolWalletStore.restoreBackup(sidecar, f.authority, backup, key, digest)).toThrow(/new destination/);
  });

  it.each(["pending", "fulfilled", "inbox"] as const)("rejects legacy %s evidence under a different authority", async (kind) => {
    const f = await fullFixture(); close(f.wallet);
    const db = new DatabaseSync(f.path);
    db.exec("DROP TABLE wallet_custody");
    if (kind !== "pending") db.exec("DELETE FROM wallet_pending; DELETE FROM wallet_reservations");
    if (kind !== "fulfilled") db.exec("DELETE FROM wallet_fulfilled");
    if (kind !== "inbox") db.exec("DELETE FROM wallet_inbox");
    db.close();
    expect(() => new PoolWalletStore(f.path, changedAuthority(f.authority))).toThrow(/authority differs/);
  });

  it.each(["table", "column", "oversize"] as const)("refuses unsupported or excessive %s state without freezing the source", async (kind) => {
    const f = await fullFixture(); close(f.wallet);
    const db = new DatabaseSync(f.path);
    if (kind === "table") db.exec("CREATE TABLE extension (value TEXT)");
    if (kind === "column") db.exec("ALTER TABLE wallet_inbox ADD COLUMN extension TEXT");
    if (kind === "oversize") db.prepare("UPDATE wallet_delivery_tokens SET token=? WHERE id='invoice'").run("a".repeat(MAX_WALLET_BACKUP_BYTES));
    db.close();
    const wallet = track(new PoolWalletStore(f.path, f.authority));
    expect(() => wallet.exportBackup(createWalletBackupKey())).toThrow(/unsupported|exceeds/);
    expect(wallet.custody()).toEqual({ frozen: false });
    expect(wallet.request(`after-${kind}`, f.invoice.backing, 1n).id).toBe(`after-${kind}`);
  });

  it("refuses a submit completion after freeze and restores the exact retry", async () => {
    const f = await fullFixture(false);
    const root = f.segment.prefix().roots.at(-1)!;
    const statement = f.oracle.accept(spendStatement(f.authority, [root, root], [101n, 102n], [201n, 202n]));
    f.wallet.prepare("racing-submit", statement);
    const receipt = signPoolReceipt(SECRETS.operator, f.authority, await f.segment.admit(statement), 0n);
    let release!: (receipt: typeof f.spendReceipt) => void;
    const waiting = new Promise<typeof f.spendReceipt>(resolve => { release = resolve; });
    const submitting = f.wallet.submit("racing-submit", { submit: async () => waiting });
    await Promise.resolve();
    const freezer = track(new PoolWalletStore(f.path, f.authority)), key = createWalletBackupKey();
    const backup = freezer.exportBackup(key), digest = walletBackupDigest(backup);
    release(receipt);
    await expect(submitting).rejects.toThrow(/frozen/);
    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "submit-restored.db"), f.authority, backup, key, digest));
    expect(restored.pending("racing-submit")).toEqual({ statement });
    await expect(restored.submit("racing-submit", { submit: async () => receipt })).resolves.toEqual(receipt);
    expect(restored.pending("racing-submit").receipt).toEqual(receipt);
  });

  it("refuses a fulfillment completion after freeze and restores an unfulfilled retry", async () => {
    const f = await fullFixture(false);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const verifier = { verify: async (...args: Parameters<Oracle["verify"]>) => {
      if (first) { first = false; entered(); await gate; }
      return f.oracle.verify(...args);
    } };
    const fulfilling = f.wallet.fulfill("invoice", f.delivery, { ...f.checkpointArgs, verifier });
    await started;
    const freezer = track(new PoolWalletStore(f.path, f.authority)), key = createWalletBackupKey();
    const backup = freezer.exportBackup(key), digest = walletBackupDigest(backup);
    release();
    await expect(fulfilling).rejects.toThrow(/frozen/);
    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "fulfill-restored.db"), f.authority, backup, key, digest));
    expect(restored.fulfillment("invoice")).toBeUndefined();
    await expect(restored.fulfill("invoice", f.delivery, f.checkpointArgs)).resolves.toMatchObject({ kind: "final" });
    expect(restored.fulfillment("invoice")).toBeDefined();
  });

  it("allows domain-scoped reads under a different segment only in explicit read-only mode", async () => {
    const f = await fullFixture(), otherAuthority = changedAuthority(f.authority);
    const reader = track(new PoolWalletStore(f.path, otherAuthority, { readOnly: true }));
    expect(reader.secret("invoice")).toBe(f.invoiceSecret);
    expect(reader.pending("payment")).toEqual({ statement: f.spend, opening: f.payment, change: f.change, receipt: f.spendReceipt });
    expect(reader.inbox("invoice")).toEqual(f.delivery);
    expect(reader.fulfillment("invoice")).toBeDefined();
    expect(reader.authorizesDelivery("invoice", f.deliveryToken)).toBe(false);
    expect(() => reader.request("blocked", f.invoice.backing, 1n)).toThrow(/read-only/);
    expect(() => reader.deliveryToken("invoice")).toThrow(/read-only/);
    expect(() => reader.receiveDelivery("invoice", f.delivery)).toThrow();
    expect(() => reader.prepare("blocked", f.spend)).toThrow();
    expect(() => reader.exportBackup(createWalletBackupKey())).toThrow(/read-only/);
    let submitted = false, verified = false;
    await expect(reader.submit("payment", { submit: async () => { submitted = true; return f.spendReceipt; } })).rejects.toThrow(/read-only/);
    await expect(reader.fulfill("invoice", f.delivery, { ...f.checkpointArgs,
      verifier: { verify: async () => { verified = true; return true; } } })).rejects.toThrow(/read-only/);
    expect({ submitted, verified }).toEqual({ submitted: false, verified: false });

    close(reader); close(f.wallet);
    const db = new DatabaseSync(f.path); db.exec("DROP TABLE wallet_custody"); db.close();
    const migrated = new PoolWalletStore(f.path, f.authority); migrated.close();
    const legacyReader = track(new PoolWalletStore(f.path, otherAuthority, { readOnly: true }));
    expect(legacyReader.secret("invoice")).toBe(f.invoiceSecret);
  });

  it("does not erase an acknowledged destination write interleaved after initialization", async () => {
    const f = await fullFixture(), key = createWalletBackupKey(), backup = f.wallet.exportBackup(key), digest = walletBackupDigest(backup);
    const destination = join(f.dir, "raced.db"), original = DatabaseSync.prototype.exec;
    let injected = false;
    DatabaseSync.prototype.exec = function (sql: string): void {
      original.call(this, sql);
      if (!injected && sql === "COMMIT" && existsSync(destination)) {
        injected = true;
        const other = new PoolWalletStore(destination, f.authority);
        other.request("interleaved", f.invoice.backing, 1n);
        other.close();
      }
    };
    try {
      expect(() => PoolWalletStore.restoreBackup(destination, f.authority, backup, key, digest)).toThrow(/new destination|changed during recovery|no longer pristine/);
    } finally { DatabaseSync.prototype.exec = original; }
    expect(injected).toBe(true);
    const reopened = track(new PoolWalletStore(destination, f.authority));
    expect(reopened.request("interleaved", f.invoice.backing, 1n).id).toBe("interleaved");
  });
});
