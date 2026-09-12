import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { deriveWalletField } from "../src/pool/wallet.js";
import { commitmentOf } from "../src/pool/notes.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import type { PoolWalletStore as Wallet } from "../src/pool/wallet-store.js";
import { CONFIG, DOMAIN, issueStatement, Oracle, spendStatement, VENUE } from "./pool-support.js";
import { evidence, open, terms } from "./pool-record-support.js";
import { LocalVenue } from "../src/venue.js";
import { SECRETS } from "./support.js";

it("derives repeatable, purpose/slot/root-separated randomness without segment context", () => {
  const root = new Uint8Array(32).fill(1), derive = () => deriveWalletField(root, DOMAIN, "output-rho", [3n, 7n]);
  expect(derive()).toBe(derive());
  expect(derive()).not.toBe(deriveWalletField(root, DOMAIN, "padding-rho", [3n, 7n]));
  expect(derive()).not.toBe(deriveWalletField(root, DOMAIN, "output-rho", [3n, 7n], 1));
  expect(derive()).not.toBe(deriveWalletField(new Uint8Array(32).fill(2), DOMAIN, "output-rho", [3n, 7n]));
  expect(() => deriveWalletField(root, DOMAIN, "output-rho", [7n, 3n])).toThrow();
});

describe.skipIf(Number(process.versions.node.split(".")[0]) < 24)("local pool wallet custody", () => {
  let PoolWalletStore: typeof import("../src/pool/wallet-store.js").PoolWalletStore;
  const wallets: Wallet[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => { ({ PoolWalletStore } = await import("../src/pool/wallet-store.js")); });
  afterEach(() => {
    for (const wallet of wallets.splice(0)) wallet.close();
    for (const path of directories.splice(0)) {
      if (!resolve(path).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(path, { recursive: true, force: true });
    }
  });
  async function setup() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "pool-wallet-")); directories.push(directory);
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), backing = terms("EUR"), segment = open(venue, [backing], oracle);
    const authority = segment.authority(), path = join(directory, "wallet.db");
    const create = () => { const w = new PoolWalletStore(path, authority); wallets.push(w); return w; };
    const wallet = create(), request = wallet.request("invoice", backing.backing.name, 10n);
    const opening = { backing: request.backing, value: request.value, owner: request.owner, rho: deriveWalletField(SECRETS.backer, DOMAIN, "issue-rho", [request.owner]) };
    const statement = oracle.accept(issueStatement(authority, request.backing, request.value, commitmentOf(DOMAIN, opening), SECRETS.backer));
    const accepted = await segment.admit(statement), receipt = signPoolReceipt(SECRETS.operator, authority, accepted, 0n);
    const checkpoint = evidence(segment); venue.publish(checkpoint.commitment);
    const args = { configuration: CONFIG, venue, verifier: oracle, checkpoint: checkpoint.commitment, evidence: [checkpoint] };
    return { wallet, create, request, opening, statement, receipt, args, segment, oracle, authority };
  }
  it("commits fresh request secrets before return and restores exact pending bytes", async () => {
    const f = await setup();
    const secret = f.wallet.secret("invoice");
    f.wallet.prepare("pay", f.statement, f.opening);
    f.wallet.close(); wallets.pop(); const restored = f.create();
    expect(restored.request("invoice", f.request.backing, 10n)).toEqual(f.request);
    expect(restored.secret("invoice")).toBe(secret);
    expect(restored.request("another", f.request.backing, 10n).owner).not.toBe(f.request.owner);
    expect(restored.pending("pay")).toEqual({ statement: f.statement, opening: f.opening });
    expect(() => restored.request("invoice", f.request.backing, 11n)).toThrow(/changed terms/);
    expect(() => restored.prepare("pay", { ...f.statement, proof: new Uint8Array(32) }, f.opening)).toThrow(/changed/);
  });
  it("keeps complete pending state after a lost reply and verifies caller authority on retry", async () => {
    const f = await setup(); f.wallet.prepare("pay", f.statement, f.opening);
    let submitted: unknown;
    await expect(f.wallet.submit("pay", { submit: async input => { submitted = input; throw new Error("reply lost"); } })).rejects.toThrow("reply lost");
    expect(submitted).toEqual({ domain: DOMAIN, statement: f.statement });
    expect(f.wallet.pending("pay").receipt).toBeUndefined();
    await expect(f.wallet.submit("pay", { submit: async () => ({ ...f.receipt, operator: new Uint8Array(32) }) })).rejects.toThrow(/receipt/);
    const other = f.oracle.accept(issueStatement(f.authority, f.request.backing, 10n, 987n, SECRETS.backer));
    const otherReceipt = signPoolReceipt(SECRETS.operator, f.authority, await f.segment.admit(other), 0n);
    await expect(f.wallet.submit("pay", { submit: async () => otherReceipt })).rejects.toThrow(/receipt/);
    await expect(f.wallet.submit("pay", { submit: async () => f.receipt })).resolves.toEqual(f.receipt);
    await expect(f.wallet.submit("pay", { submit: async () => f.receipt })).resolves.toEqual(f.receipt);
  });
  it("requires matching positive output and independently verified checkpoint before one fulfillment", async () => {
    const f = await setup(), delivery = { statement: f.statement, opening: f.opening, receipt: f.receipt };
    expect((await f.wallet.fulfill("invoice", delivery, { ...f.args, evidence: [] })).kind).toBe("unavailable");
    expect(f.wallet.received("invoice")).toBeUndefined();
    await expect(f.wallet.fulfill("invoice", { ...delivery, opening: { ...f.opening, rho: f.opening.rho + 1n } }, f.args)).rejects.toThrow(/output/);
    await expect(f.wallet.fulfill("invoice", { ...delivery, opening: { ...f.opening, value: 0n } }, f.args)).rejects.toThrow(/match/);
    await expect(f.wallet.fulfill("invoice", { ...delivery, receipt: { ...f.receipt, position: 2n } }, f.args)).rejects.toThrow(/receipt/);
    expect((await f.wallet.fulfill("invoice", delivery, f.args)).kind).toBe("final");
    f.wallet.close(); wallets.pop(); const restored = f.create();
    expect(restored.received("invoice")).toEqual(f.opening);
    await expect(restored.fulfill("invoice", delivery, f.args)).rejects.toThrow(/already fulfilled/);
    restored.request("other-invoice", f.request.backing, 10n);
    await expect(restored.fulfill("other-invoice", delivery, f.args)).rejects.toThrow(/match/);
  });
  it("refuses another pending command that reserves the same input nullifier", async () => {
    const f = await setup();
    const statement = spendStatement(f.authority, [1n, 1n], [8n, 9n], [10n, 11n]);
    f.wallet.prepare("one", statement);
    expect(() => f.wallet.prepare("two", { ...statement, publicInputs: [...statement.publicInputs.slice(0, 9), 12n, 13n] })).toThrow(/reserved/);
    expect(() => f.wallet.pending("two")).toThrow(/unknown/);
  });
  it("allows only one concurrent durable fulfillment across separate wallet handles", async () => {
    const f = await setup(), second = f.create();
    const delivery = { statement: f.statement, opening: f.opening, receipt: f.receipt };
    const results = await Promise.allSettled([f.wallet.fulfill("invoice", delivery, f.args), second.fulfill("invoice", delivery, f.args)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(second.received("invoice")).toEqual(f.opening);
  });
  it("persists both private output openings before submission and owns returned bytes", async () => {
    const f = await setup();
    const change = { ...f.opening, rho: f.opening.rho + 1n, value: 3n };
    const statement = spendStatement(f.authority, [1n, 1n], [8n, 9n], [commitmentOf(DOMAIN, f.opening), commitmentOf(DOMAIN, change)]);
    f.wallet.prepare("pay", statement, f.opening, change);
    f.wallet.close(); wallets.pop(); const restored = f.create();
    expect(restored.pending("pay").change).toEqual(change);
    restored.pending("pay").change!.backing.fill(0);
    expect(restored.pending("pay").change).toEqual(change);
    expect(() => restored.prepare("pay", statement, f.opening)).toThrow(/changed/);
  });
});
