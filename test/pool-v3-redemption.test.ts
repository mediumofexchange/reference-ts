import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { identifierOf } from "../src/pool/field.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { acceptanceBytes, decodeRecord, settlementAuthorization, statementHash, type Record } from "../src/pool/v3/records.js";
import { presenterSecret, settlementRho } from "../src/pool/v3/redemption.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import type { BackerSigner, LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import type { ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

// Stand-in proofs isolate the wallet's redemption custody (slice 9, M9a): the backer issues, accepts and burns
// through its own wallet and signer, the holder demands, settles and withdraws through its own, under service.
const b = (n: number) => new Uint8Array(32).fill(n);
const domain = configurationHash(adoptedConfiguration());
const issuerSecret = b(15), operatorSecret = b(16);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const sign: BackerSigner = message => ed25519.sign(message, issuerSecret);

describe("v3 redemption through the backer's and the holder's wallets", () => {
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

  /** The backer issues `funds` to the holder through its own wallet; each act is submitted and committed. */
  async function fixture(funds: readonly bigint[] = [10n]) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-redemption-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id,
      interval: 20n, payout: { thing: "redemption units", quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const reader = { venue, reference, verifier };
    const open = (name: string) => { const wallet = new V3Wallet(join(directory, `${name}.db`), reader); wallets.push(wallet); return wallet; };
    const backer = open("backer"), holder = open("holder");
    const j = new V3OperatorJournal(join(directory, "journal.db"), { venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    let checkpoints = 0, served = (await j.package()).package;
    const publish = async () => { await j.commit(`c${checkpoints++}`); await j.publish(); served = (await j.package()).package; return served; };
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    for (const [i, value] of funds.entries()) {
      await backer.issue(`issue-${i}`, holder.request(`fund-${i}`, backing, value), value, served, signed, prove, sign);
      await backer.submit(`issue-${i}`, service);
    }
    await publish();
    return { directory, venue, signed, backing, backer, holder, open, j, publish, service, served: () => served };
  }

  it("issues, demands, accepts, settles and burns through wallet operations with unchanged supply until the burn", async () => {
    const f = await fixture();
    expect(f.backer.act("issue-0")).toMatchObject({ kind: 1, status: "prepared" });
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => [h.value, h.status])).toEqual([[10n, "available"]]);
    await f.backer.sync(f.served(), f.signed);
    expect(f.backer.act("issue-0")!.status).toBe("final");

    const at = f.venue.witnessedIndex(), deadline = at + 20n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    expect(demand).toMatchObject({ kind: 4, status: "prepared", demand: demand.statement });
    // Exact retry needs neither evidence nor a prover; another intent under the alias refuses.
    expect(await f.holder.demand("redeem", 10n, deadline, new Uint8Array(), f.signed, undefined as never)).toEqual(demand);
    await expect(f.holder.demand("redeem", 10n, deadline + 1n, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    // The notice's presenter is the seed's derivation over its tags, instant and deadline.
    const p = decodeRecord(demand.record).publicInputs;
    expect(p[14]).toBe(at);
    expect(identifierOf(p[12]!, p[13]!)).toEqual(ed25519.getPublicKey(presenterSecret(f.holder.recoverySeed(), domain, p.slice(10, 12), at, deadline)));
    await f.holder.submit("redeem", f.service);
    await f.publish();
    const locked = await f.holder.sync(f.served(), f.signed);
    expect(locked.holdings.map(h => h.status)).toEqual(["reserved"]);
    expect(f.holder.act("redeem")!.status).toBe("final");

    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    expect(ed25519.verify(acceptance.signature, acceptanceBytes(acceptance), issuer)).toBe(true);
    expect(await f.backer.accept("answer", demand.demand!, deadline - 5n, new Uint8Array(), f.signed, undefined as never)).toEqual(acceptance);

    const settled = await f.holder.settle("settle", "redeem", acceptance, f.served(), f.signed, prove);
    const s = decodeRecord(settled.record);
    expect(s.kind).toBe(6);
    expect(settlementAuthorization(s).acceptance).toMatchObject({ owner: acceptance.owner, deadline: acceptance.deadline });
    // rho_out is the seed's derivation over the inputs, the segment and a zero disclosure count.
    expect(s.publicInputs[9]).toBe(settlementRho(f.holder.recoverySeed(), domain, s.publicInputs.slice(12, 14),
      identifierOf(s.publicInputs[2]!, s.publicInputs[3]!), 0n));
    await f.holder.submit("settle", f.service);
    await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings).toEqual([]);
    expect(f.holder.act("settle")!.status).toBe("final");

    // The backer's own seed finds the settled note through C4.7's owner and burns it.
    const backerView = await f.backer.sync(f.served(), f.signed);
    expect(backerView.holdings.map(h => [h.value, h.status])).toEqual([[10n, "available"]]);
    await f.backer.burn("retire", 10n, f.served(), f.signed, prove);
    await f.backer.submit("retire", f.service);
    await f.publish();
    expect((await f.backer.sync(f.served(), f.signed)).holdings).toEqual([]);
    expect(f.backer.act("retire")!.status).toBe("final");
  });

  it("withdraws a standing demand and frees its notes; refuses non-exact quantities, foreign signers and bad deadlines", async () => {
    const f = await fixture([6n, 4n, 5n]);
    await f.holder.sync(f.served(), f.signed);
    await expect(f.holder.demand("odd", 7n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "FUNDS" });
    await expect(f.holder.demand("now", 10n, f.venue.witnessedIndex() + lag, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "INVALID" });
    const deadline = f.venue.witnessedIndex() + 20n;
    const demand = await f.holder.demand("pair", 10n, deadline, f.served(), f.signed, prove);
    expect(demand.inputs.length).toBe(2);
    await f.holder.submit("pair", f.service); await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => [h.value, h.status]).sort())
      .toEqual([[4n, "reserved"], [5n, "available"], [6n, "reserved"]].sort());

    const stranger: BackerSigner = message => ed25519.sign(message, b(77));
    await expect(f.backer.accept("bad", demand.demand!, deadline - 1n, f.served(), f.signed, stranger))
      .rejects.toMatchObject({ code: "INVALID" });
    await expect(f.backer.accept("late", demand.demand!, deadline + 1n, f.served(), f.signed, sign))
      .rejects.toMatchObject({ code: "INVALID" });
    await expect(f.backer.accept("unknown", b(9), deadline - 1n, f.served(), f.signed, sign))
      .rejects.toMatchObject({ code: "ABSENT" });
    // An acceptance the obligor never signed is refused before any proof.
    const good = await f.backer.accept("good", demand.demand!, deadline - 1n, f.served(), f.signed, sign);
    const forged = { ...good, signature: ed25519.sign(acceptanceBytes(good), b(77)) };
    await expect(f.holder.settle("forged", "pair", forged, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "INVALID" });
    await expect(f.holder.settle("other", "pair", { ...good, owner: good.owner + 1n }, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "INVALID" });

    const withdrawn = await f.holder.withdraw("back", "pair", f.served(), f.signed);
    expect(withdrawn).toMatchObject({ kind: 5, demand: demand.demand });
    await f.holder.submit("back", f.service); await f.publish();
    const view = await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("back")!.status).toBe("final");
    expect(view.holdings.map(h => h.status)).toEqual(["available", "available", "available"]);
    // The withdrawn demand can no longer be settled.
    await expect(f.holder.settle("after", "pair", good, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "ABSENT" });
    expect(statementHash(decodeRecord(withdrawn.record))).toEqual(withdrawn.statement);
    // The freed notes can be demanded again under a new alias; one acceptance is saved under one alias.
    await expect(f.backer.accept("good-again", demand.demand!, deadline - 1n, f.served(), f.signed, sign))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const again = await f.holder.demand("again", 10n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    expect(again.inputs).toEqual(demand.inputs);
    await f.holder.submit("again", f.service); await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings.filter(h => h.status === "reserved").length).toBe(2);
  });

  it("fails a demand whose instant left the window unadmitted and frees its notes; never decides by output alone", async () => {
    const f = await fixture([10n, 3n]);
    await f.holder.sync(f.served(), f.signed);
    const at = f.venue.witnessedIndex();
    await f.holder.demand("late", 10n, at + 30n, f.served(), f.signed, prove);
    f.venue.advance(at + 2n * lag + 1n);
    await expect(f.holder.submit("late", f.service)).rejects.toMatchObject({ check: "DEADLINE" });
    await f.publish();
    const view = await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("late")!.status).toBe("failed");
    expect(view.holdings.map(h => h.status)).toEqual(["available", "available"]);
    // The freed note is demanded again under a new alias and admitted.
    await f.holder.demand("again", 10n, f.venue.witnessedIndex() + 30n, f.served(), f.signed, prove);
    await f.holder.submit("again", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("again")!.status).toBe("final");
    // An issue whose request a payment paid first is failed, not final, though its output exists.
    const request = f.holder.request("shared", f.backing, 3n);
    await f.backer.issue("late-issue", request, 3n, f.served(), f.signed, prove, sign);
    await f.holder.prepare("paid-first", { request, value: 3n }, f.served(), f.signed, prove);
    await f.holder.submit("paid-first", f.service); await f.publish();
    await expect(f.backer.submit("late-issue", f.service)).rejects.toMatchObject({ code: "REFUSED" });
    await f.backer.sync(f.served(), f.signed);
    expect(f.backer.act("late-issue")!.status).toBe("failed");
  });

  it("keeps acts across an offline backup and refuses a payment alias for an act", async () => {
    const f = await fixture();
    await f.holder.sync(f.served(), f.signed);
    const demand = await f.holder.demand("redeem", 10n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    await expect(f.holder.payment("redeem")).toBeUndefined();
    const key = b(41), bytes = f.holder.exportBackup(key);
    const { walletBackupDigest } = await import("../src/pool/v3/wallet-backup.js");
    const restored = V3Wallet.restoreBackup(join(f.directory, "restored.db"),
      { venue: f.venue, reference, verifier }, bytes, key, walletBackupDigest(bytes));
    wallets.push(restored);
    expect(restored.act("redeem")).toEqual(demand);
    await restored.submit("redeem", f.service); await f.publish();
    expect((await restored.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["reserved"]);
  });
});

