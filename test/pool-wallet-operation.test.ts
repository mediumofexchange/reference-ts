import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { PoolWalletStore as Wallet, WalletDelivery } from "../src/pool/wallet-store.js";
import type * as Payment from "../src/pool/wallet-payment.js";
import { commitmentOf, nullifierOf, type NoteOpening } from "../src/pool/notes.js";
import { notePathProves } from "../src/pool/note-tree.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import { encodeWalletPairing, decodeWalletPairing, walletPairingDigest } from "../src/pool/wallet-pairing.js";
import { createWalletBackupKey } from "../src/pool/wallet-backup.js";
import { deriveWalletField } from "../src/pool/wallet.js";
import { LocalVenue } from "../src/venue.js";
import { CONFIG, DOMAIN, issueStatement, Oracle, VENUE } from "./pool-support.js";
import { evidence, open, terms } from "./pool-record-support.js";
import { SECRETS } from "./support.js";

describe.skipIf(Number(process.versions.node.split(".")[0]) < 24)("ordinary local wallet operation", () => {
  let PoolWalletStore: typeof import("../src/pool/wallet-store.js").PoolWalletStore;
  let prepareWalletPayment: typeof Payment.prepareWalletPayment, walletPayment: typeof Payment.walletPayment,
    walletChangeRequestId: typeof Payment.walletChangeRequestId;
  const wallets: Wallet[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ PoolWalletStore } = await import("../src/pool/wallet-store.js"));
    ({ prepareWalletPayment, walletPayment, walletChangeRequestId } = await import("../src/pool/wallet-payment.js"));
  });
  afterEach(() => {
    for (const w of wallets.splice(0)) w.close();
    for (const path of directories.splice(0)) {
      if (!resolve(path).startsWith(scratch + sep)) throw new Error("unsafe cleanup");
      rmSync(path, { recursive: true, force: true });
    }
  });
  async function setup(values = [4n, 6n], price = 7n) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "wallet-operation-")); directories.push(directory);
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), backing = terms("EUR");
    const segment = open(venue, [backing], oracle), authority = segment.authority();
    const empty = evidence(segment); venue.publish(empty.commitment);
    const create = (name: string) => { const w = new PoolWalletStore(join(directory, name + ".db"), authority); wallets.push(w); return w; };
    const payer = create("payer"), receiver = create("receiver"), deliveries: WalletDelivery[] = [];
    for (const [i, value] of values.entries()) {
      const request = payer.request("fund" + i, backing.backing.name, value);
      const opening = { backing: request.backing, value, owner: request.owner,
        rho: deriveWalletField(SECRETS.backer, DOMAIN, "issue-rho", [request.owner]) };
      const statement = oracle.accept(issueStatement(authority, request.backing, value, commitmentOf(DOMAIN, opening), SECRETS.backer));
      const receipt = signPoolReceipt(SECRETS.operator, authority, await segment.admit(statement), 0n);
      deliveries.push({ opening, statement, receipt });
    }
    const checkpoint = evidence(segment, 2n); venue.publish(checkpoint.commitment);
    const args = { configuration: CONFIG, venue, verifier: oracle, checkpoint: checkpoint.commitment, evidence: [checkpoint, empty] };
    for (const [i, delivery] of deliveries.entries()) await payer.fulfill("fund" + i, delivery, args);
    receiver.installDeliveryCredentials({ key: readFileSync(new URL("./fixtures/wallet-tls/localhost-key.pem", import.meta.url), "utf8"),
      cert: readFileSync(new URL("./fixtures/wallet-tls/localhost-cert.pem", import.meta.url), "utf8") }, 0n);
    const request = receiver.request("order17", backing.backing.name, price);
    const invitation = receiver.deliveryInvitation(request.id, "https://localhost:7443/delivery/" + request.id);
    payer.acceptPairing("shop", invitation, walletPairingDigest(invitation), request);
    let witness: Record<string, unknown> | undefined, calls = 0;
    const prove = async (publicInputs: readonly bigint[], input: Record<string, unknown>) => {
      calls++; witness = input;
      const statement = oracle.accept({ kind: 2, publicInputs, proof: new Uint8Array(32).fill(41) });
      return statement.proof;
    };
    return { directory, create, payer, receiver, request, invitation, segment, authority, oracle, args, empty, prove,
      witness: () => witness!, calls: () => calls };
  }
  const values = (witness: Record<string, unknown>, key: string) => (witness[key] as { value: string }[]).map(n => BigInt(n.value));

  it("selects two notes, proves local paths, preserves sorted-nullifier derivation and reuses durable bytes", async () => {
    const f = await setup();
    expect((await prepareWalletPayment(f.payer, "shop", f.args, f.prove)).kind).toBe("prepared");
    const pending = walletPayment(f.payer, "shop"), w = f.witness();
    expect(values(w, "inputs").sort()).toEqual([4n, 6n]); expect(values(w, "output_notes")).toEqual([7n, 3n]);
    const nfs = (w["nullifiers"] as string[]).map(BigInt); expect(nfs[0]! < nfs[1]!).toBe(true);
    const notes = w["inputs"] as { backing: string[]; value: string; owner: string; rho: string }[];
    for (const [i, n] of notes.entries()) {
      const opening: NoteOpening = { backing: f.request.backing, value: BigInt(n.value), owner: BigInt(n.owner), rho: BigInt(n.rho) };
      const cm = commitmentOf(DOMAIN, opening);
      expect(notePathProves(BigInt((w["anchors"] as string[])[i]!), cm,
        { siblings: (w["siblings"] as string[][])[i]!.map(BigInt), right: (w["right"] as boolean[][])[i]! })).toBe(true);
      expect(nullifierOf(DOMAIN, cm, BigInt((w["secrets"] as string[])[i]!))).toBe(nfs[i]);
    }
    expect(pending.opening!.rho).toBe(f.payer.derive("output-rho", nfs));
    const restarted = f.create("payer");
    await prepareWalletPayment(restarted, "shop", { ...f.args, evidence: [] }, f.prove);
    expect(f.calls()).toBe(1); expect(walletPayment(restarted, "shop")).toEqual(pending);
    const status = await restarted.inspectNotes(f.args); expect(status.kind).toBe("final");
    if (status.kind === "final") expect(status.notes.map(n => [n.state, n.reservation])).toEqual([["unspent", "shop"], ["unspent", "shop"]]);
  });
  it("prefers the smallest single note, pads locally, and excludes zero change from requests", async () => {
    const f = await setup([4n, 8n, 7n], 7n);
    await prepareWalletPayment(f.payer, "shop", f.args, f.prove);
    expect(values(f.witness(), "inputs")).toEqual([7n, 0n]);
    expect(values(f.witness(), "output_notes")).toEqual([7n, 0n]);
    expect(() => walletChangeRequestId("shop", 0n)).toThrow();
  });
  it("distinguishes absent historical notes, withheld history, invalid evidence and two-note capacity", async () => {
    const f = await setup([2n, 2n, 2n], 5n);
    const older = await f.payer.inspectNotes({ ...f.args, checkpoint: f.empty.commitment });
    expect(older.kind).toBe("final");
    if (older.kind === "final") expect(older.notes.map(n => n.state)).toEqual(["absent", "absent", "absent"]);
    expect((await f.payer.inspectNotes({ ...f.args, evidence: [] })).kind).toBe("unavailable");
    expect((await prepareWalletPayment(f.payer, "shop", { ...f.args, evidence: [] }, f.prove)).kind).toBe("unavailable");
    const broken = { ...f.args.checkpoint, root: new Uint8Array(32) };
    expect((await f.payer.inspectNotes({ ...f.args, checkpoint: broken })).kind).toBe("invalid");
    await expect(prepareWalletPayment(f.payer, "shop", f.args, f.prove)).rejects.toThrow(/one- or two-note/);
    expect(f.calls()).toBe(0); expect(() => f.payer.pending("shop")).toThrow(/unknown/);
  });
  it("keeps verified spentness separate from durable reservations", async () => {
    const f = await setup(); await prepareWalletPayment(f.payer, "shop", f.args, f.prove);
    await f.segment.admit(walletPayment(f.payer, "shop").statement);
    const later = evidence(f.segment, 3n); f.args.venue.publish(later.commitment);
    const status = await f.payer.inspectNotes({ ...f.args, checkpoint: later.commitment, evidence: [later, ...f.args.evidence] });
    expect(status.kind).toBe("final");
    if (status.kind === "final") expect(status.notes.map(n => [n.state, n.reservation])).toEqual([["spent", "shop"], ["spent", "shop"]]);
  });
  it("rejects duplicate owner enrollment and reserved invoice namespace", async () => {
    const f = await setup();
    expect(() => f.payer.acceptPairing("other", f.invitation, walletPairingDigest(f.invitation), f.request)).toThrow(/already enrolled/);
    const pair = decodeWalletPairing(f.invitation); const changed = encodeWalletPairing({ ...pair, request: { ...pair.request, id: "other" }, endpoint: "https://localhost:7443/delivery/other" });
    expect(() => f.payer.acceptPairing("other", changed, walletPairingDigest(changed), { ...f.request, id: "other" })).toThrow(/already enrolled/);
    expect(() => f.payer.request(walletChangeRequestId("shop", 3n), f.request.backing, 3n)).toThrow(/namespace/);
    f.payer.changeRequest("shop", f.request.backing, 3n);
    f.payer.deliveryToken(walletChangeRequestId("shop", 3n));
    await expect(prepareWalletPayment(f.payer, "shop", f.args, f.prove)).rejects.toThrow(/already used/);
    expect(f.calls()).toBe(0);
  });
  it("arbitrates competing preparations through separate handles and refuses freeze during proving", async () => {
    const f = await setup(), second = f.create("payer");
    const request = f.receiver.request("another", f.request.backing, 7n);
    const frame = f.receiver.deliveryInvitation(request.id, "https://localhost:7443/delivery/another");
    second.acceptPairing("another", frame, walletPairingDigest(frame), request);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const slow = prepareWalletPayment(f.payer, "shop", f.args, async (p, w) => { entered(); await gate; return f.prove(p, w); });
    await ready; await prepareWalletPayment(second, "another", f.args, f.prove); release();
    await expect(slow).rejects.toThrow(/reserved/); expect(() => f.payer.pending("shop")).toThrow(/unknown/);
    const g = await setup();
    await expect(prepareWalletPayment(g.payer, "shop", g.args, async (p, w) => {
      g.create("payer").exportBackup(createWalletBackupKey()); return g.prove(p, w);
    })).rejects.toThrow(/frozen/);
    expect(() => g.payer.pending("shop")).toThrow(/unknown/);
  });
  it("does not reserve notes on proof failure and owns callback input arrays", async () => {
    const f = await setup();
    await expect(prepareWalletPayment(f.payer, "shop", f.args, async () => { throw new Error("prover failed"); })).rejects.toThrow(/prover failed/);
    const status = await f.payer.inspectNotes(f.args);
    if (status.kind === "final") expect(status.notes.every(n => n.reservation === undefined)).toBe(true);
    await prepareWalletPayment(f.payer, "shop", f.args, async (p, w) => {
      const proof = await f.prove(p, w); (p as bigint[]).fill(0n); return proof;
    });
    expect(walletPayment(f.payer, "shop").statement.publicInputs.every(n => n === 0n)).toBe(false);
  });
  it("rechecks change use during proving and refuses historical prepared change-owner collisions", async () => {
    const f = await setup(), other = f.create("payer");
    await expect(prepareWalletPayment(f.payer, "shop", f.args, async (p, w) => {
      other.deliveryToken(walletChangeRequestId("shop", 3n)); return f.prove(p, w);
    })).rejects.toThrow(/already used/);
    expect(() => other.pending("shop")).toThrow(/unknown/);
    const g = await setup();
    const request = g.payer.changeRequest("shop", g.request.backing, 3n);
    const opening = { backing: request.backing, value: 3n, owner: request.owner, rho: 99n };
    const statement = issueStatement(g.authority, request.backing, 3n, commitmentOf(DOMAIN, opening), SECRETS.backer);
    g.payer.prepare("older-issue", statement, opening);
    await expect(prepareWalletPayment(g.payer, "shop", g.args, g.prove)).rejects.toThrow(/prepared output/);
    expect(g.calls()).toBe(0);
  });
  it("refuses new preparation with legacy alias duplication but preserves an exact saved retry", async () => {
    const f = await setup(); await prepareWalletPayment(f.payer, "shop", f.args, f.prove);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(f.directory, "payer.db"));
    try { db.prepare("INSERT INTO wallet_pairings VALUES (?, ?)").run("legacy", f.invitation); }
    finally { db.close(); }
    await expect(prepareWalletPayment(f.payer, "legacy", f.args, f.prove)).rejects.toThrow(/ambiguous aliases/);
    expect((await prepareWalletPayment(f.payer, "shop", { ...f.args, evidence: [] }, f.prove)).kind).toBe("prepared");
    expect(walletPayment(f.payer, "shop").opening!.owner).toBe(f.request.owner);
    expect(f.calls()).toBe(1);
    const renewed = encodeWalletPairing({ ...decodeWalletPairing(f.invitation), generation: "2", token: "12".repeat(32) });
    expect(f.payer.acceptPairing("shop", renewed, walletPairingDigest(renewed), f.request, walletPairingDigest(f.invitation))).toBe(walletPairingDigest(renewed));
    expect((await prepareWalletPayment(f.payer, "shop", { ...f.args, evidence: [] }, f.prove)).kind).toBe("prepared");
    await expect(prepareWalletPayment(f.payer, "legacy", f.args, f.prove)).rejects.toThrow(/ambiguous aliases/);
  });
  it("selects the least-total pair with stable ID ties and refuses another backing", async () => {
    const f = await setup([4n, 4n, 3n, 3n], 7n);
    await prepareWalletPayment(f.payer, "shop", f.args, f.prove);
    const status = await f.payer.inspectNotes(f.args);
    expect(status.kind).toBe("final");
    if (status.kind === "final") expect(status.notes.filter(n => n.reservation).map(n => n.id)).toEqual(["fund0", "fund2"]);
    const request = f.receiver.request("dollars", terms("USD").backing.name, 1n);
    const frame = f.receiver.deliveryInvitation(request.id, "https://localhost:7443/delivery/dollars");
    f.payer.acceptPairing("dollars", frame, walletPairingDigest(frame), request);
    await expect(prepareWalletPayment(f.payer, "dollars", f.args, f.prove)).rejects.toThrow(/one- or two-note/);
    expect(f.calls()).toBe(1);
  });
  it("adopts a concurrent exact alias winner without changing its saved proof", async () => {
    const f = await setup(), second = f.create("payer");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const slow = prepareWalletPayment(f.payer, "shop", f.args, async () => { entered(); await gate; return new Uint8Array(32).fill(42); });
    await ready; const winner = await prepareWalletPayment(second, "shop", f.args, f.prove); release();
    expect(await slow).toEqual(winner);
    expect(walletPayment(f.payer, "shop").statement.proof).toEqual(new Uint8Array(32).fill(41));
  });
  it("refuses an invoice owner already used by another pending change output", async () => {
    const f = await setup();
    const opening = { backing: f.request.backing, value: f.request.value, owner: f.request.owner, rho: 333n };
    const statement = issueStatement(f.authority, opening.backing, opening.value, commitmentOf(DOMAIN, opening), SECRETS.backer);
    f.payer.prepare("legacy", statement, undefined, opening);
    await expect(prepareWalletPayment(f.payer, "shop", f.args, f.prove)).rejects.toThrow(/already has a prepared payment/);
    expect(f.calls()).toBe(0);
  });
  it("preserves exact legacy request replay while reserving new change IDs", async () => {
    const f = await setup();
    const original = f.payer.request("old-invoice", f.request.backing, 2n);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(f.directory, "payer.db"));
    try { db.prepare("UPDATE wallet_requests SET id=? WHERE id=?").run("change_legacy", original.id); }
    finally { db.close(); }
    expect(f.payer.request("change_legacy", original.backing, original.value)).toEqual({ ...original, id: "change_legacy" });
    expect(() => f.payer.request("change_legacy", original.backing, 3n)).toThrow(/changed terms/);
    expect(() => f.payer.request("change_new", original.backing, 2n)).toThrow(/namespace/);
  });
});
