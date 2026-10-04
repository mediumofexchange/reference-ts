import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToField, fieldToBytes, identifierOf, limbsOf } from "../src/pool/field.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { acceptanceBytes, acceptanceId, decodeRecord, encodePublication, encodeSettlementAuthorization, releaseBytes, settlementAuthorization,
  statementHash, type Acceptance, type Record } from "../src/pool/v3/records.js";
import { tagOf } from "../src/pool/v3/recovery.js";
import { presenterSecret, settlementRho } from "../src/pool/v3/redemption.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import type { BackerSigner, LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import type { ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeReplacement, replacementMessage, type Replacement } from "../src/venue-records.js";

// Stand-in proofs isolate the wallet's redemption custody (slice 9, M9a): the backer issues, accepts and burns
// through its own wallet and signer, the holder demands, settles and withdraws through its own, under service.
const b = (n: number) => new Uint8Array(32).fill(n);
const domain = configurationHash(adoptedConfiguration());
const issuerSecret = b(15), operatorSecret = b(16), successorSecret = b(18);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret), successorKey = ed25519.getPublicKey(successorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const configuration = adoptedConfiguration();
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
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

  /** The backer issues `funds` to the holder through its own wallet; each act is submitted and committed. With
   * `silence`, the terms declare that no-commitment duration, so an offline operator opens a gap (C2b.6.1). */
  async function fixture(funds: readonly bigint[] = [10n], silence?: bigint) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-redemption-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id,
      interval: 20n, payout: { thing: "redemption units", quantumExponent: 0, perUnit: 1n },
      ...(silence === undefined ? {} : { silence: { noCommitmentDuration: silence, challengeWindow: 5n } }) });
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
    /** The backer replaces the operator with B; once effective, B takes over from A's published package and adopts. */
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
    const restore = (name: string, wallet: Wallet) => {
      const restored = V3Wallet.restoreSeed(join(directory, `${name}.db`), reader, wallet.recoverySeed()); wallets.push(restored); return restored;
    };
    return { directory, venue, signed, backing, backer, holder, open, j, publish, service, served: () => served, replace, takeover, restore };
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
    // A prepared demand reserves its notes; once it stands, its lock holds them (C3.7).
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["reserved"]);
    await f.holder.submit("redeem", f.service);
    await f.publish();
    const locked = await f.holder.sync(f.served(), f.signed);
    expect(locked.holdings.map(h => h.status)).toEqual(["locked"]);
    expect(locked.demands).toEqual([{ id: demand.demand, quantity: 10n, instant: at, deadline, holdings: [locked.holdings[0]!.cm] }]);
    expect(f.holder.act("redeem")!.status).toBe("final");

    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    expect(ed25519.verify(acceptance.signature, acceptanceBytes(acceptance), issuer)).toBe(true);
    expect(await f.backer.accept("answer", demand.demand!, deadline - 5n, new Uint8Array(), f.signed, undefined as never)).toEqual(acceptance);

    const settled = await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
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
    // A demand names a positive quantity (C3.4); nothing is planned or saved for another.
    for (const quantity of [0n, -1n, 5 as never as bigint, 1n << 64n]) {
      await expect(f.holder.demand("none", quantity, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove))
        .rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/invalid demand/) });
    }
    expect(f.holder.act("none")).toBeUndefined();
    const deadline = f.venue.witnessedIndex() + 20n;
    const demand = await f.holder.demand("pair", 10n, deadline, f.served(), f.signed, prove);
    expect(demand.inputs.length).toBe(2);
    await f.holder.submit("pair", f.service); await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => [h.value, h.status]).sort())
      .toEqual([[4n, "locked"], [5n, "available"], [6n, "locked"]].sort());

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
    await expect(f.holder.settle("forged", forged, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "INVALID" });
    await expect(f.holder.settle("other", { ...good, owner: good.owner + 1n }, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "INVALID" });

    const withdrawn = await f.holder.withdraw("back", f.holder.act("pair")!.demand!, f.served(), f.signed);
    expect(withdrawn).toMatchObject({ kind: 5, demand: demand.demand });
    await f.holder.submit("back", f.service); await f.publish();
    const view = await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("back")!.status).toBe("final");
    expect(view.holdings.map(h => h.status)).toEqual(["available", "available", "available"]);
    // The withdrawn demand can no longer be settled.
    await expect(f.holder.settle("after", good, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "ABSENT" });
    expect(statementHash(decodeRecord(withdrawn.record))).toEqual(withdrawn.statement);
    // The freed notes can be demanded again under a new alias; one acceptance is saved under one alias.
    await expect(f.backer.accept("good-again", demand.demand!, deadline - 1n, f.served(), f.signed, sign))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const again = await f.holder.demand("again", 10n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    expect(again.inputs).toEqual(demand.inputs);
    await f.holder.submit("again", f.service); await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings.filter(h => h.status === "locked").length).toBe(2);
  });

  it("fails a demand whose instant left the window unadmitted and frees its notes; never decides by output alone", async () => {
    const f = await fixture([10n, 3n]);
    await f.holder.sync(f.served(), f.signed);
    const at = f.venue.witnessedIndex();
    await f.holder.demand("late", 10n, at + 30n, f.served(), f.signed, prove);
    // At instant + 2·lag a relayed publication could still be witnessed inside C3.3's window.
    f.venue.advance(at + 2n * lag);
    await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("late")!.status).toBe("prepared");
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
    expect((await restored.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["locked"]);
    // The lock ends at the demand's deadline (C3.7): unsettled by then, its notes are available with no withdrawal.
    const deadline = decodeRecord(demand.record).publicInputs[15]!;
    f.venue.advance(deadline);
    expect((await restored.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["locked"]);
    f.venue.advance(deadline + 1n);
    const lapsed = await restored.sync(f.served(), f.signed);
    expect(lapsed.holdings.map(h => h.status)).toEqual(["available"]);
    expect(lapsed.demands.map(d => d.id)).toEqual([demand.demand]);
  });

  it("finds a demand again from the seed alone and settles it as the lost wallet would, by the demand's identity", async () => {
    const f = await fixture([10n, 6n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 30n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    // The device is lost after the demand stood: a wallet from the seed alone has no saved record of it.
    const restored = f.restore("restored", f.holder);
    expect(restored.act("redeem")).toBeUndefined();
    const view = await restored.sync(f.served(), f.signed), ten = view.holdings.find(h => h.value === 10n)!;
    // The seed's derived presenter key recognizes the standing demand; its note is locked by it, not reserved.
    expect(view.demands).toEqual([{ id: demand.demand, quantity: 10n, instant: decodeRecord(demand.record).publicInputs[14], deadline,
      holdings: [ten.cm] }]);
    expect(view.holdings.map(h => [h.value, h.status]).sort()).toEqual([[10n, "locked"], [6n, "available"]].sort());
    await expect(restored.demand("again", 10n, deadline, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "FUNDS" });
    // Another seed's view lists none, and it can neither withdraw nor settle the demand.
    expect((await f.backer.sync(f.served(), f.signed)).demands).toEqual([]);
    await expect(f.backer.withdraw("theirs", demand.demand!, f.served(), f.signed)).rejects
      .toMatchObject({ code: "UNKNOWN", message: "the demand is not this wallet's" });
    expect(f.backer.act("theirs")).toBeUndefined();
    await expect(restored.withdraw("missing", b(9), f.served(), f.signed)).rejects.toMatchObject({ code: "ABSENT" });

    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    await expect(f.backer.settle("theirs", acceptance, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(restored.settle("late", { ...acceptance, deadline: deadline + 1n, signature: ed25519.sign(acceptanceBytes(
      { ...acceptance, deadline: deadline + 1n }), issuerSecret) }, f.served(), f.signed, prove)).rejects
      .toMatchObject({ code: "INVALID", message: "the acceptance is due after the demand" });
    // The lost wallet's settlement and the restored one's are the same record: one segment, one disclosure count.
    const lost = await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
    const settled = await restored.settle("settle", acceptance, f.served(), f.signed, prove);
    expect(settled.record).toEqual(lost.record);
    expect(await restored.settle("settle", acceptance, new Uint8Array(), f.signed, undefined as never)).toEqual(settled);
    await restored.submit("settle", f.service); await f.publish();
    const after = await restored.sync(f.served(), f.signed);
    expect(after.holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"]]);
    expect(after.demands).toEqual([]);
    expect(restored.act("settle")!.status).toBe("final");
    await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("settle")!.status).toBe("final");
  });

  it("fails an act whose segment ended; after succession a restored seed finds the demand and settles it again", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 40n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    // A admits the settlement but its term ends before any checkpoint includes it.
    const old = await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
    const receipt = await f.holder.submit("settle", f.service);
    await f.replace();
    const successor = await f.takeover(), served = (await successor.package()).package;
    const view = await f.holder.sync(served, f.signed);
    expect(f.holder.act("settle")).toMatchObject({ status: "failed", receipt });
    // The demand stands in the imported history; its lock holds its notes.
    expect(view.demands.map(d => d.id)).toEqual([demand.demand]);
    expect(view.holdings.map(h => h.status)).toEqual(["locked"]);
    // A wallet from the seed finds it in B's segment too. The acceptance stands (C2.10.8): a settlement under a new
    // alias re-proves the same nullifiers for the successor's segment, into an output derived for that segment.
    const restored = f.restore("restored", f.holder);
    expect((await restored.sync(served, f.signed)).demands.map(d => d.id)).toEqual([demand.demand]);
    const again = await restored.settle("again", acceptance, served, f.signed, prove);
    const s = decodeRecord(again.record).publicInputs, o = decodeRecord(old.record).publicInputs, segment = identifierOf(s[2]!, s[3]!);
    expect(segment).not.toEqual(identifierOf(o[2]!, o[3]!));
    expect(s.slice(12, 14)).toEqual(o.slice(12, 14));
    expect(s[9]).toBe(settlementRho(f.holder.recoverySeed(), domain, s.slice(12, 14), segment, 0n));
    expect(s[14]).not.toBe(o[14]);
    const next = await restored.submit("again", { submit: async bytes => decodeReceipt(await successor.submit(bytes)) });
    expect(next.operator).toEqual(successorKey);
    await successor.commit("settled"); await successor.publish();
    const final = (await successor.package()).package;
    expect((await restored.sync(final, f.signed)).holdings).toEqual([]);
    expect(restored.act("again")!.status).toBe("final");
    expect((await f.holder.sync(final, f.signed)).holdings).toEqual([]);
    expect(f.holder.act("settle")!.status).toBe("failed");
    // The backer's seed finds the settled note in the successor's segment.
    expect((await f.backer.sync(final, f.signed)).holdings.map(h => [h.value, h.status])).toEqual([[10n, "available"]]);
  });

  it("builds nothing from a view older than its records and fails nothing from one", async () => {
    const f = await fixture([10n, 6n]);
    await f.holder.sync(f.served(), f.signed);
    const early = f.venue.export(), earlyPackage = f.served();
    const demand = await f.holder.demand("redeem", 10n, f.venue.witnessedIndex() + 40n, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed);
    await f.replace();
    const successor = await f.takeover(), served = (await successor.package()).package;
    expect((await f.holder.sync(served, f.signed)).demands.map(d => d.id)).toEqual([demand.demand]);
    const burn = await f.holder.burn("burn", 6n, served, f.signed, prove);
    const restored = f.restore("restored", f.holder);
    await restored.sync(served, f.signed); restored.close();
    // The same database read at a venue view from before the demand and the takeover: A's segment looks live there.
    const lagging = new V3Wallet(join(f.directory, "holder.db"), { venue: FixtureVenue.from(early), reference, verifier });
    wallets.push(lagging);
    const old = await lagging.sync(earlyPackage, f.signed);
    expect(old.holdings.map(h => [h.value, h.status]).sort()).toEqual([[10n, "available"], [6n, "reserved"]].sort());
    expect(lagging.act("burn")).toEqual(burn);
    for (const build of [() => lagging.burn("again", 10n, earlyPackage, f.signed, prove),
      () => lagging.demand("again", 10n, f.venue.witnessedIndex() + 40n, earlyPackage, f.signed, prove)]) {
      await expect(build()).rejects.toMatchObject({ code: "CHANGED_VIEW", message: "the venue view is older than one this wallet has judged at" });
    }
    expect(lagging.act("again")).toBeUndefined();
    // A wallet from the seed that has only read the current view, with no saved record, builds nothing from the older one.
    const behind = new V3Wallet(join(f.directory, "restored.db"), { venue: FixtureVenue.from(early), reference, verifier });
    wallets.push(behind);
    await expect(behind.burn("burn", 10n, earlyPackage, f.signed, prove)).rejects.toMatchObject({ code: "CHANGED_VIEW" });
  });

  it("reserves a demand's notes for its prepared settlement, which takes them over a payment prepared before the demand stood", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 40n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service);
    // A copy from the seed reads the note free before the demand is checkpointed, and pays it.
    const restored = f.restore("restored", f.holder);
    expect((await restored.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["available"]);
    const payment = await restored.prepare("pay", { request: f.backer.request("shop", f.backing, 10n), value: 10n }, f.served(), f.signed, prove);
    await f.publish();
    const view = await restored.sync(f.served(), f.signed);
    expect([view.holdings.map(h => h.status), view.demands.map(d => d.id)]).toEqual([["reserved"], [demand.demand]]);
    await expect(restored.submit("pay", f.service)).rejects.toMatchObject({ check: "LOCKED" });
    await f.backer.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    const other = await f.backer.accept("other", demand.demand!, deadline - 6n, f.served(), f.signed, sign);
    const settled = await restored.settle("settle", acceptance, f.served(), f.signed, prove);
    expect(settled.inputs).toEqual(payment.inputs);
    await expect(restored.settle("settle", other, f.served(), f.signed, prove)).rejects
      .toMatchObject({ code: "CONFLICT", message: "alias names another act" });
    // The prepared settlement reserves the note: nothing else is built over it.
    await expect(restored.burn("burn", 10n, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "FUNDS" });
    await restored.submit("settle", f.service); await f.publish();
    expect((await restored.sync(f.served(), f.signed)).holdings).toEqual([]);
    expect([restored.act("settle")!.status, restored.payment("pay")!.status]).toEqual(["final", "failed"]);
  });

  /** A fixture whose operator goes offline after funding: the venue clock is moved to the first index whose horizon
   * is in the gap, and `relay` publishes an act so the venue witnesses it at its read index plus the lag. */
  async function gap(funds: readonly bigint[]) {
    const f = await fixture(funds, SILENCE), checkpoint = f.venue.witnessedIndex();
    await f.holder.sync(f.served(), f.signed);
    f.venue.advance(checkpoint + SILENCE - lag + 1n);
    const relay = async (wallet: Wallet, name: string, at: bigint) => { f.venue.advance(at + lag - 1n); await wallet.publish(name, f.venue); };
    return { ...f, checkpoint, relay };
  }
  const SILENCE = 6n;

  it("demands, settles and withdraws at the venue in a gap; publications with force make the acts final", async () => {
    const f = await gap([10n, 4n, 6n]);
    const at = f.venue.witnessedIndex();
    // Service is closed: an issue and a payment refuse as the journal would, before any proof.
    await expect(f.backer.issue("late", f.holder.request("late", f.backing, 1n), 1n, f.served(), f.signed, prove, sign))
      .rejects.toMatchObject({ code: "SILENCE" });
    await expect(f.holder.prepare("pay", { request: f.holder.request("self", f.backing, 4n), value: 4n }, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "SILENCE" });
    // A gap demand's deadline must lie past every index C3.3's window lets its publication be witnessed at.
    await expect(f.holder.demand("short", 10n, at + 2n * lag, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "INVALID" });
    const demand = await f.holder.demand("redeem", 10n, at + 30n, f.served(), f.signed, prove);
    const p = decodeRecord(demand.record).publicInputs, segment = identifierOf(p[2]!, p[3]!);
    await expect(f.holder.publish("missing", f.venue)).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(f.holder.publish("redeem", {} as never)).rejects.toMatchObject({ code: "INVALID" });
    await f.relay(f.holder, "redeem", at);
    // A retry sends the same bytes; this venue witnesses an exact record once.
    await f.holder.publish("redeem", f.venue);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => [h.value, h.status]).sort())
      .toEqual([[10n, "locked"], [4n, "available"], [6n, "available"]].sort());
    expect(f.holder.act("redeem")!.status).toBe("final");

    // The backer answers the forced demand; the holder's release is bound to the snapshot's segment and has force.
    await f.backer.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", demand.demand!, at + 25n, f.served(), f.signed, sign);
    const settleAt = f.venue.witnessedIndex(), settled = await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
    const s = decodeRecord(settled.record).publicInputs;
    expect(identifierOf(s[2]!, s[3]!)).toEqual(segment);
    expect(s[9]).toBe(settlementRho(f.holder.recoverySeed(), domain, s.slice(12, 14), segment, 0n));
    await f.relay(f.holder, "settle", settleAt);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.value).sort()).toEqual([4n, 6n]);
    expect(f.holder.act("settle")!.status).toBe("final");
    // A burn needs service: the settled note waits for the operator's return to be adopted.
    await expect(f.backer.burn("retire", 10n, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "SILENCE" });

    // A pair demanded and withdrawn in the gap is available again.
    const pairAt = f.venue.witnessedIndex();
    await f.holder.demand("pair", 10n, pairAt + 30n, f.served(), f.signed, prove);
    await f.relay(f.holder, "pair", pairAt);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["locked", "locked"]);
    const backAt = f.venue.witnessedIndex();
    await f.holder.withdraw("back", f.holder.act("pair")!.demand!, f.served(), f.signed);
    await f.relay(f.holder, "back", backAt);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["available", "available"]);
    expect([f.holder.act("pair")!.status, f.holder.act("back")!.status]).toEqual(["final", "final"]);
  });

  it("withdraws in a gap a demand with force that a wallet restored from the seed found again", async () => {
    const f = await gap([4n, 6n]);
    const at = f.venue.witnessedIndex();
    const demand = await f.holder.demand("pair", 10n, at + 30n, f.served(), f.signed, prove);
    await f.relay(f.holder, "pair", at);
    const restored = f.restore("restored", f.holder);
    const view = await restored.sync(f.served(), f.signed);
    expect(view.demands.map(d => [d.id, d.quantity, d.holdings.length])).toEqual([[demand.demand, 10n, 2]]);
    expect(view.holdings.map(h => h.status)).toEqual(["locked", "locked"]);
    const backAt = f.venue.witnessedIndex();
    const withdrawn = await restored.withdraw("back", demand.demand!, f.served(), f.signed);
    expect(await restored.withdraw("back", demand.demand!, new Uint8Array(), f.signed)).toEqual(withdrawn);
    await expect(restored.withdraw("back", b(9), f.served(), f.signed)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.relay(restored, "back", backAt);
    const after = await restored.sync(f.served(), f.signed);
    expect(after.holdings.map(h => h.status)).toEqual(["available", "available"]);
    expect(after.demands).toEqual([]);
    expect(restored.act("back")!.status).toBe("final");
    // The lost wallet reads its demand ended by the withdrawal, so its notes are free there too.
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["available", "available"]);
    // Both copies read the notes as presented by the ended demand: the restored one from its forced publication alone.
    expect(after.holdings.map(h => h.presented)).toEqual([[demand.demand], [demand.demand]]);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.presented)).toEqual([[demand.demand], [demand.demand]]);
  });

  it("pays and burns no presented note, presents again one earlier demand's notes only, and freshens them (M10b item 9)", async () => {
    const f = await fixture([6n, 4n, 5n, 2n]);
    await f.holder.sync(f.served(), f.signed);
    const presented = async (wallet = f.holder) => (await wallet.sync(f.served(), f.signed)).holdings
      .map(h => [h.value, h.status, h.presented.map(id => Buffer.from(id).toString("hex"))] as const).sort((x, y) => Number(x[0] - y[0]));
    const hexOf = (id: Uint8Array | undefined) => Buffer.from(id!).toString("hex");
    const a = await f.holder.demand("a", 10n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    expect(a.repeats).toEqual([]);
    await f.holder.submit("a", f.service); await f.publish();
    await f.holder.withdraw("a-back", a.demand!, f.served(), f.signed); await f.holder.submit("a-back", f.service); await f.publish();
    const A = hexOf(a.demand);
    expect(await presented()).toEqual([[2n, "available", []], [4n, "available", [A]], [5n, "available", []], [6n, "available", [A]]]);
    // A payment or burn of 9 would need a presented note: refused, pointing to freshen.
    const request = f.backer.request("shop", f.backing, 9n);
    await expect(f.holder.prepare("pay", { request, value: 9n }, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "FUNDS", message: expect.stringContaining("freshen") });
    await expect(f.holder.burn("burn", 9n, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "FUNDS" });

    // No unpresented note is 6, so A's note is presented again; the demand links to A only.
    const b6 = await f.holder.demand("b", 6n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    expect(b6.repeats).toEqual([a.demand]);
    expect(f.holder.act("b")).toEqual(b6);
    await f.holder.submit("b", f.service); await f.publish();
    await f.holder.withdraw("b-back", b6.demand!, f.served(), f.signed); await f.holder.submit("b-back", f.service); await f.publish();
    const B = hexOf(b6.demand);
    // A seed-restored copy finds both ended demands in the record by their tags.
    expect(await presented(f.restore("restored", f.holder))).toEqual(await presented());
    expect(await presented()).toEqual([[2n, "available", []], [4n, "available", [A]], [5n, "available", []], [6n, "available", [A, B].sort()]]);
    // 11 is only A's 6 beside the unpresented 5: refused. (10 from A's 4 and 6 would be taken: B already repeats A's tag.)
    await expect(f.holder.demand("c", 11n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "FUNDS", message: expect.stringContaining("freshen") });
    // 7 is two unpresented notes, preferred over anything presented.
    const d = await f.holder.demand("d", 7n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    expect(d.repeats).toEqual([]);
    await f.holder.submit("d", f.service); await f.publish(); await f.holder.sync(f.served(), f.signed);
    // A standing demand's notes are locked: freshen refuses them; an unknown demand presents nothing.
    await expect(f.holder.freshen("x", d.demand!, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "LOCKED" });
    await expect(f.holder.freshen("x", b(9), f.served(), f.signed, prove)).rejects.toMatchObject({ code: "ABSENT" });

    // Freshen spends A's two notes, and only them, into one fresh note of their sum.
    const fresh = await f.holder.freshen("fresh", a.demand!, f.served(), f.signed, prove);
    expect(fresh).toMatchObject({ value: 10n, fee: undefined, freshens: a.demand, status: "prepared" });
    expect(fresh.inputs.length).toBe(2);
    expect(await f.holder.freshen("fresh", a.demand!, new Uint8Array(), f.signed, undefined as never)).toEqual(fresh);
    await expect(f.holder.freshen("fresh", b6.demand!, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.holder.prepare("fresh", { request, value: 9n }, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.holder.submit("fresh", f.service); await f.publish();
    const D = hexOf(d.demand);
    expect(await presented()).toEqual([[2n, "locked", [D]], [5n, "locked", [D]], [10n, "available", []]]);
    expect(f.holder.payment("fresh")!.status).toBe("final");
    await expect(f.holder.freshen("again", a.demand!, f.served(), f.signed, prove)).rejects.toMatchObject({ code: "ABSENT" });
    // The fresh note pays.
    await f.holder.prepare("pay", { request, value: 9n }, f.served(), f.signed, prove);
    await f.holder.submit("pay", f.service); await f.publish(); await f.holder.sync(f.served(), f.signed);
    expect(f.holder.payment("pay")!.status).toBe("final");
  });

  it("never presents the notes of two unlinked earlier demands together, and freshens one demand's alone", async () => {
    const f = await fixture([6n, 4n]);
    await f.holder.sync(f.served(), f.signed);
    const a = await f.holder.demand("a", 6n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    const b4 = await f.holder.demand("b", 4n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
    for (const name of ["a", "b"]) await f.holder.submit(name, f.service);
    await f.publish();
    await f.holder.withdraw("a-back", a.demand!, f.served(), f.signed); await f.holder.submit("a-back", f.service);
    await f.holder.withdraw("b-back", b4.demand!, f.served(), f.signed); await f.holder.submit("b-back", f.service);
    await f.publish(); await f.holder.sync(f.served(), f.signed);
    await expect(f.holder.demand("c", 10n, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "FUNDS" });
    const fresh = await f.holder.freshen("fresh", a.demand!, f.served(), f.signed, prove);
    expect([fresh.value, fresh.inputs.length]).toEqual([6n, 1]);
  });

  it("refuses at save a payment or demand whose note another demand presented while it was proved", async () => {
    // A prover held open until the race has run: another demand presents the note, stands and is withdrawn, so no
    // reservation holds the note any more when the first call saves.
    const held = () => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
      const slow: LocalProver = async task => { entered(); await gate; return record(task); };
      return { slow, started, release };
    };
    const race = async (f: Awaited<ReturnType<typeof fixture>>, quantity: bigint) => {
      const d = await f.holder.demand("d", quantity, f.venue.witnessedIndex() + 20n, f.served(), f.signed, prove);
      await f.holder.submit("d", f.service); await f.publish(); await f.holder.sync(f.served(), f.signed);
      await f.holder.withdraw("d-back", d.demand!, f.served(), f.signed); await f.holder.submit("d-back", f.service); await f.publish();
      await f.holder.sync(f.served(), f.signed);
    };
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const pay = held();
    const paying = f.holder.prepare("pay", { request: f.backer.request("shop", f.backing, 10n), value: 10n }, f.served(), f.signed, pay.slow);
    await pay.started; await race(f, 10n); pay.release();
    await expect(paying).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("presented") });
    expect(f.holder.payment("pay")).toBeUndefined();

    const g = await fixture([6n, 4n]);
    await g.holder.sync(g.served(), g.signed);
    const late = held();
    const demanding = g.holder.demand("late", 10n, g.venue.witnessedIndex() + 30n, g.served(), g.signed, late.slow);
    await late.started; await race(g, 6n); late.release();
    await expect(demanding).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("presented") });
  });

  it("counts releases witnessed without force, so the next settlement names an output nobody has seen", async () => {
    const f = await gap([10n]);
    const at = f.venue.witnessedIndex();
    const demand = await f.holder.demand("redeem", 10n, at + 40n, f.served(), f.signed, prove);
    await f.relay(f.holder, "redeem", at);
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    const now = f.venue.witnessedIndex(), early = await f.backer.accept("early", demand.demand!, now + lag + 1n, f.served(), f.signed, sign);
    const late = await f.holder.settle("late", early, f.served(), f.signed, prove);
    // Published after its acceptance deadline, the release has no force but discloses its output.
    f.venue.advance(early.deadline);
    await f.holder.publish("late", f.venue);
    await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("late")!.status).toBe("failed");
    const read = await readFrontier(f.served(), f.signed, f.venue.witnessedIndex(), { venue: f.venue, reference, verifier, answers: true });
    expect(read.answers.map(a => [a.release?.output, a.release?.force, a.release?.check]))
      .toEqual([[decodeRecord(late.record).publicInputs[14], false, "DEADLINE"]]);
    expect(read.force.map(x => x.record.kind)).toEqual([4]);
    // Another party's settlement of this demand to another output, with a release no presenter signed, is
    // witnessed without force too and is not counted.
    const copy = decodeRecord(late.record), auth = copy.authorization.slice(), inputs = [...copy.publicInputs];
    auth.fill(7, 72); inputs[14] = inputs[14]! + 1n;
    await f.venue.publishRecord(4, f.backing, encodePublication({ domain, backing: f.backing, kind: 3,
      record: { ...copy, publicInputs: inputs, authorization: auth } }));

    await f.backer.sync(f.served(), f.signed);
    const later = await f.backer.accept("later", demand.demand!, f.venue.witnessedIndex() + 20n, f.served(), f.signed, sign);
    const settleAt = f.venue.witnessedIndex(), again = await f.holder.settle("again", later, f.served(), f.signed, prove);
    const s = decodeRecord(again.record).publicInputs, l = decodeRecord(late.record).publicInputs, segment = identifierOf(s[2]!, s[3]!);
    expect(s.slice(12, 14)).toEqual(l.slice(12, 14));
    expect(s[9]).toBe(settlementRho(f.holder.recoverySeed(), domain, s.slice(12, 14), segment, 1n));
    expect(s[14]).not.toBe(l[14]);
    await f.relay(f.holder, "again", settleAt);
    expect((await f.holder.sync(f.served(), f.signed)).holdings).toEqual([]);
    expect(f.holder.act("again")!.status).toBe("final");
    // The reader lists every release with its verdict: the late and the forged one without force, the last with it.
    const after = await readFrontier(f.served(), f.signed, f.venue.witnessedIndex(), { venue: f.venue, reference, verifier, answers: true });
    expect(after.force.map(x => x.record.kind)).toEqual([4, 6]);
    expect(after.answers.map(a => [a.release?.output, a.release?.force])).toEqual([[l[14], false], [l[14]! + 1n, false], [s[14], true]]);
  });

  it("counts a release published under terms without silence, and refuses a second settlement at one count", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 30n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    const first = await f.backer.accept("first", demand.demand!, deadline - 2n, f.served(), f.signed, sign);
    const second = await f.backer.accept("second", demand.demand!, deadline - 1n, f.served(), f.signed, sign);
    const s0 = await f.holder.settle("s0", first, f.served(), f.signed, prove);
    // rho_out reads no acceptance: a second settlement at the same count would disclose with the first.
    await expect(f.holder.settle("s0b", second, f.served(), f.signed, prove))
      .rejects.toMatchObject({ code: "CONFLICT", message: "another settlement of this demand is prepared at this disclosure count; publish it, or sync to resolve it" });
    // Only an act a venue record carries is published.
    await expect(f.backer.publish("issue-0", f.venue)).rejects.toMatchObject({ code: "INVALID",
      message: "only a demand, a withdrawal or a release is published" });
    // No gap can open here, so the release has no force; it still discloses its output and counts.
    await f.holder.publish("s0", f.venue);
    const s1 = await f.holder.settle("s1", second, f.served(), f.signed, prove);
    const p0 = decodeRecord(s0.record).publicInputs, p1 = decodeRecord(s1.record).publicInputs, segment = identifierOf(p1[2]!, p1[3]!);
    expect(identifierOf(p0[2]!, p0[3]!)).toEqual(segment);
    expect(p1[9]).toBe(settlementRho(f.holder.recoverySeed(), domain, p1.slice(12, 14), segment, 1n));
    expect(p1[9]).not.toBe(p0[9]);
    await f.holder.submit("s1", f.service); await f.publish();
    expect((await f.holder.sync(f.served(), f.signed)).holdings).toEqual([]);
    expect([f.holder.act("s1")!.status, f.holder.act("s0")!.status]).toEqual(["final", "failed"]);
  });

  it("publishes no failed settlement, whose release would disclose the output a later one at its count names (C3.5)", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 40n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    const early = await f.backer.accept("early", demand.demand!, f.venue.witnessedIndex() + 2n * lag + 1n, f.served(), f.signed, sign);
    const s1 = await f.holder.settle("s1", early, f.served(), f.signed, prove);
    // s1 is not admitted before its acceptance deadline, so it fails; no release of it was witnessed.
    f.venue.advance(early.deadline + 1n);
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    expect(f.holder.act("s1")!.status).toBe("failed");
    const later = await f.backer.accept("later", demand.demand!, f.venue.witnessedIndex() + 20n, f.served(), f.signed, sign);
    const s2 = await f.holder.settle("s2", later, f.served(), f.signed, prove);
    expect(decodeRecord(s2.record).publicInputs[9]).toBe(decodeRecord(s1.record).publicInputs[9]);
    await expect(f.holder.publish("s1", f.venue)).rejects.toMatchObject({ code: "CONFLICT", message: "a failed settlement is not published" });
    await f.holder.submit("s2", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed);
    expect(f.holder.act("s2")!.status).toBe("final");
  });

  it("fails a saved withdrawal once another copy of the wallet settled its demand", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 30n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    await f.holder.withdraw("back", demand.demand!, f.served(), f.signed);
    const restored = f.restore("restored", f.holder);
    await restored.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    await restored.settle("s", acceptance, f.served(), f.signed, prove);
    await restored.submit("s", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed);
    expect([f.holder.act("redeem")!.status, f.holder.act("back")!.status]).toEqual(["final", "failed"]);
  });

  // C3.8: any wallet reads a demand's outcome from public evidence, each event from the index it was witnessed at.
  it("reads an unanswered demand as the backer's dishonour past its deadline, kept through a later withdrawal", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 10n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove), id = demand.demand!;
    await f.holder.submit("redeem", f.service); await f.publish();
    const stranger = f.open("stranger"), filed = f.venue.witnessedIndex();
    expect(await stranger.presentation(id, f.served(), f.signed)).toEqual({ demand: id, backing: f.backing, quantity: 10n, deadline,
      witnessed: filed, inTerm: true, ended: undefined, overdue: undefined, acceptances: [] });
    // Past its deadline it is the backer's failure, from the next index on, to anybody holding the record.
    f.venue.advance(deadline);
    expect((await stranger.presentation(id, f.served(), f.signed)).overdue).toBeUndefined();
    f.venue.advance(deadline + 3n);
    expect((await stranger.presentation(id, f.served(), f.signed)).overdue).toEqual({ reading: "dishonour", from: deadline + 1n, through: deadline + 3n });
    // The holder withdraws it later: ended from the index the withdrawal was witnessed at, the earlier indices kept.
    await f.holder.withdraw("back", id, f.served(), f.signed);
    await f.holder.submit("back", f.service); await f.publish();
    const at = f.venue.witnessedIndex(), after = await f.backer.presentation(id, f.served(), f.signed);
    expect([after.ended, after.overdue]).toEqual([{ by: "withdrawal", at }, { reading: "dishonour", from: deadline + 1n, through: at - 1n }]);
    await expect(stranger.presentation(b(9), f.served(), f.signed)).rejects.toMatchObject({ code: "ABSENT" });
  });

  it("reads a timely published acceptance left unreleased as the holder's lapse, a settlement as settled, a withdrawal in time as no failure", async () => {
    const f = await fixture([10n, 6n, 4n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 20n;
    const [lapsed, settled, withdrawn] = [await f.holder.demand("lapsed", 6n, deadline, f.served(), f.signed, prove),
      await f.holder.demand("settled", 10n, deadline, f.served(), f.signed, prove), await f.holder.demand("withdrawn", 4n, deadline, f.served(), f.signed, prove)];
    for (const name of ["lapsed", "settled", "withdrawn"]) await f.holder.submit(name, f.service);
    await f.publish(); await f.backer.sync(f.served(), f.signed);
    const a1 = await f.backer.accept("a1", lapsed.demand!, deadline - 5n, f.served(), f.signed, sign);
    const a2 = await f.backer.accept("a2", settled.demand!, deadline - 5n, f.served(), f.signed, sign);
    await expect(f.backer.publishAcceptance("missing", f.venue)).rejects.toMatchObject({ code: "UNKNOWN" });
    await expect(f.backer.publishAcceptance("a1", {} as never)).rejects.toMatchObject({ code: "INVALID" });
    await f.backer.publishAcceptance("a1", f.venue);
    const a1At = f.venue.witnessedIndex();
    // A retry publishes the same bytes, which this venue witnesses once.
    await f.backer.publishAcceptance("a1", f.venue);
    expect(f.venue.witnessedIndex()).toBe(a1At);
    await f.backer.publishAcceptance("a2", f.venue);
    await f.holder.settle("s2", a2, f.served(), f.signed, prove); await f.holder.submit("s2", f.service);
    await f.holder.withdraw("w3", withdrawn.demand!, f.served(), f.signed); await f.holder.submit("w3", f.service);
    await f.publish();
    const settledAt = f.venue.witnessedIndex();
    f.venue.advance(deadline + 1n);
    const lapse = await f.holder.presentation(lapsed.demand!, f.served(), f.signed);
    expect(lapse.acceptances).toEqual([{ id: acceptanceId(a1), owner: a1.owner, deadline: a1.deadline, witnessed: a1At, timely: true, taken: false }]);
    expect([lapse.ended, lapse.overdue]).toEqual([undefined, { reading: "lapse", from: deadline + 1n, through: deadline + 1n }]);
    const done = await f.backer.presentation(settled.demand!, f.served(), f.signed);
    expect([done.ended, done.overdue, done.acceptances.length]).toEqual([{ by: "settlement", at: settledAt }, undefined, 1]);
    const back = await f.backer.presentation(withdrawn.demand!, f.served(), f.signed);
    expect([back.ended, back.overdue]).toEqual([{ by: "withdrawal", at: settledAt }, undefined]);
  });

  it("counts no acceptance K did not sign, one due after the demand, one of another demand or backing, or one witnessed too late", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 20n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove), id = demand.demand!;
    await f.holder.submit("redeem", f.service); await f.publish();
    const publish = (acceptance: Acceptance, signer = issuerSecret, routing = f.backing) => f.venue.publishRecord(4, routing,
      encodePublication({ domain, backing: routing, kind: 2, acceptance: { ...acceptance, signature: ed25519.sign(acceptanceBytes(acceptance), signer) } }));
    const base: Acceptance = { domain, demand: id, owner: 5n, deadline: deadline - 3n };
    await publish(base, b(77));
    await publish({ ...base, owner: 6n, deadline: deadline + 1n });
    await publish({ ...base, owner: 7n, demand: b(9) });
    await publish({ ...base, owner: 8n }, issuerSecret, b(99));
    // K's own acceptance witnessed with its deadline only the lag ahead: no release could be witnessed inside it (C3.4).
    f.venue.advance(base.deadline - lag - 1n);
    await publish({ ...base, owner: 9n });
    f.venue.advance(deadline + 1n);
    const read = await f.holder.presentation(id, f.served(), f.signed);
    expect(read.acceptances.map(a => [a.owner, a.witnessed, a.timely])).toEqual([[9n, base.deadline - lag, false]]);
    expect(read.overdue?.reading).toBe("dishonour");
  });

  it("reads no failure for a demand first witnessed after its deadline, and the record's own timing for a withdrawal witnessed late", async () => {
    const f = await fixture([10n, 6n], 1000n);
    await f.holder.sync(f.served(), f.signed);
    const at = f.venue.witnessedIndex();
    const withdrawn = await f.holder.demand("withdrawn", 6n, at + 10n, f.served(), f.signed, prove);
    await f.holder.submit("withdrawn", f.service); await f.publish();
    await f.holder.sync(f.served(), f.signed);
    // A demand and a withdrawal are admitted in time, but the operator holds its checkpoint past both deadlines.
    const deadline = at + 20n, late = await f.holder.demand("late", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("late", f.service);
    await f.holder.withdraw("back", withdrawn.demand!, f.served(), f.signed); await f.holder.submit("back", f.service);
    // The checkpoint is witnessed exactly at the late demand's deadline.
    f.venue.advance(deadline - 1n);
    await f.publish();
    const back = f.venue.witnessedIndex();
    f.venue.advance(deadline + 5n);
    // The late demand reaches the record at its deadline: no term K could meet, so no dishonour (C3.3).
    const read = await f.backer.presentation(late.demand!, f.served(), f.signed);
    expect([read.witnessed, read.inTerm, read.overdue]).toEqual([deadline, false, undefined]);
    // The withdrawal counts from the checkpoint that witnessed it: the indices before it read as they stood.
    const w = await f.backer.presentation(withdrawn.demand!, f.served(), f.signed);
    expect([w.inTerm, w.ended, w.overdue]).toEqual([true, { by: "withdrawal", at: back }, { reading: "dishonour", from: at + 11n, through: back - 1n }]);
  });

  it("names the end first in history order at one index, and places an acceptance at its first copy, a release's included", async () => {
    const f = await fixture([10n, 6n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 20n;
    const spent = await f.holder.demand("spent", 10n, deadline - 10n, f.served(), f.signed, prove);
    const answered = await f.holder.demand("answered", 6n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("spent", f.service); await f.holder.submit("answered", f.service); await f.publish();
    await f.backer.sync(f.served(), f.signed);
    // K's acceptance first reaches the venue inside the holder's release (no gap here, so no force), then on its own.
    const acceptance = await f.backer.accept("answer", answered.demand!, deadline - 5n, f.served(), f.signed, sign);
    await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
    await f.holder.publish("settle", f.venue);
    const carried = f.venue.witnessedIndex();
    await f.backer.publishAcceptance("answer", f.venue);
    // Past the first demand's deadline, one checkpoint holds a spend of its note and then its withdrawal.
    f.venue.advance(deadline - 9n);
    await f.holder.sync(f.served(), f.signed);
    // A presented note moves only by freshen (item 9 of the M10b decision), itself a spend of it.
    await f.holder.freshen("pay", spent.demand!, f.served(), f.signed, prove);
    await f.holder.submit("pay", f.service);
    await f.holder.withdraw("back", spent.demand!, f.served(), f.signed); await f.holder.submit("back", f.service);
    await f.publish();
    expect((await f.backer.presentation(spent.demand!, f.served(), f.signed)).ended).toEqual({ by: "void", at: f.venue.witnessedIndex() });
    f.venue.advance(deadline + 1n);
    const read = await f.backer.presentation(answered.demand!, f.served(), f.signed);
    expect(read.acceptances.map(a => [a.witnessed, a.timely, a.taken])).toEqual([[carried, true, false]]);
    expect(read.overdue?.reading).toBe("lapse");
  });

  it("reads a demand voided from the index a spend of its note was witnessed at, keeping the dishonour before it", async () => {
    const f = await fixture([10n]);
    await f.holder.sync(f.served(), f.signed);
    const deadline = f.venue.witnessedIndex() + 10n;
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.service); await f.publish();
    // Past its deadline its lock no longer stands: the holder spends the note to a fresh one, which voids the demand.
    f.venue.advance(deadline + 2n);
    expect((await f.holder.sync(f.served(), f.signed)).holdings.map(h => h.status)).toEqual(["available"]);
    await f.holder.freshen("pay", demand.demand!, f.served(), f.signed, prove);
    await f.holder.submit("pay", f.service); await f.publish();
    const at = f.venue.witnessedIndex(), read = await f.backer.presentation(demand.demand!, f.served(), f.signed);
    expect([read.ended, read.overdue]).toEqual([{ by: "void", at }, { reading: "dishonour", from: deadline + 1n, through: at - 1n }]);
  });

  it("reads a gap release taken by another demand's settlement as released: the acceptance's lapse becomes the backer's dishonour", async () => {
    const f = await gap([10n, 10n]);
    const at = f.venue.witnessedIndex(), deadline = at + 40n;
    const held = await f.holder.demand("held", 10n, deadline, f.served(), f.signed, prove);
    await f.relay(f.holder, "held", at);
    const otherAt = f.venue.witnessedIndex(), other = await f.holder.demand("other", 10n, deadline, f.served(), f.signed, prove);
    await f.relay(f.holder, "other", otherAt);
    await f.holder.sync(f.served(), f.signed); await f.backer.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", held.demand!, deadline - 5n, f.served(), f.signed, sign);
    await f.backer.publishAcceptance("answer", f.venue);
    const release = decodeRecord((await f.holder.settle("settle", acceptance, f.served(), f.signed, prove)).record).publicInputs;
    // Before the release is witnessed, a settlement of the other demand, under an acceptance K signed naming the same
    // owner, creates the release's output (its owner and rho_out) first, with force.
    const d = decodeRecord(other.record).publicInputs, id = other.demand!, taking: Acceptance = { domain, demand: id, owner: release[8]!, deadline: deadline - 5n };
    const unsigned: Record = { domain, kind: 6, proof: b(6), capsules: [], authorization: new Uint8Array(136), publicInputs: [...d.slice(0, 7), 10n,
      release[8]!, release[9]!, d[8]!, d[8]!, f.holder.act("other")!.inputs[0]!, 12345n, release[14]!, ...limbsOf(id)] };
    const presenter = presenterSecret(f.holder.recoverySeed(), domain, d.slice(10, 12), d[14]!, d[15]!);
    const takes: Record = { ...unsigned, authorization: encodeSettlementAuthorization(taking.deadline, ed25519.sign(acceptanceBytes(taking), issuerSecret),
      ed25519.sign(releaseBytes(domain, id, acceptanceId(taking), statementHash(unsigned)), presenter)) };
    await f.venue.publishRecord(4, f.backing, encodePublication({ domain, backing: f.backing, kind: 3, record: takes }));
    const releaseAt = f.venue.witnessedIndex();
    await f.relay(f.holder, "settle", releaseAt);
    const read = await readFrontier(f.served(), f.signed, f.venue.witnessedIndex(), { venue: f.venue, reference, verifier, answers: true });
    expect(read.answers.filter(a => a.release !== undefined).map(a => [a.release!.output, a.release!.force, a.release!.check]))
      .toEqual([[release[14], true, undefined], [release[14], false, "TAKEN"]]);
    // The holder's timely acceptance reads as released: past the deadline the demand is the backer's failure, not a lapse.
    f.venue.advance(deadline + 1n);
    const reading = await f.holder.presentation(held.demand!, f.served(), f.signed);
    expect(reading.acceptances.map(a => [a.timely, a.taken])).toEqual([[true, true]]);
    expect([reading.ended, reading.overdue?.reading]).toEqual([undefined, "dishonour"]);
    expect((await f.holder.presentation(id, f.served(), f.signed)).ended?.by).toBe("settlement");
  });

  /** Rewrite the holder's kept mark of its note worth `value` so its tag (bytes 104–135, M11b8) is `tag`, under a
   * re-recorded digest: kept state §14's check cannot see. Returns each note's value and nullifier. */
  function tamperTag(directory: string, value: bigint, tag: (notes: readonly { readonly value: bigint; readonly nf: bigint }[]) => bigint) {
    const path = join(directory, "holder.db.replay"), db = new DatabaseSync(path, { readBigInts: true });
    const rows = (db.prepare("SELECT ns, leaf, nf, note FROM witness").all() as { ns: bigint; leaf: bigint; nf: Uint8Array; note: Uint8Array }[])
      .map(row => ({ ...row, value: new DataView(new Uint8Array(row.note).buffer).getBigUint64(96), nfValue: bytesToField(new Uint8Array(row.nf)) }));
    const notes = rows.map(row => ({ value: row.value, nf: row.nfValue })), target = rows.find(row => row.value === value)!;
    const note = new Uint8Array(target.note); note.set(fieldToBytes(tag(notes)), 104);
    db.prepare("UPDATE witness SET note = ? WHERE ns = ? AND leaf = ?").run(note, target.ns, target.leaf); db.close();
    writeFileSync(`${path}.sha256`, createHash("sha256").update(readFileSync(path)).digest("hex"));
    return notes;
  }

  it("settles a demand over its own notes when a kept tag is damaged or forged: the wallet discards its kept state and replays", async () => {
    for (const [demanded, damaged, forge] of [
      // The demanded note's own tag damaged: missed by its tag, the miss finds a tag that is not its nullifier's.
      [10n, 10n, (notes: readonly { value: bigint; nf: bigint }[]) => tagOf(notes.find(n => n.value === 10n)!.nf) ^ 1n],
      // Another note's tag forged equal to the demanded note's: found first, refused when completed.
      [5n, 10n, (notes: readonly { value: bigint; nf: bigint }[]) => tagOf(notes.find(n => n.value === 5n)!.nf)],
    ] as const) {
      const f = await fixture([10n, 5n]);
      await f.holder.sync(f.served(), f.signed);
      const deadline = f.venue.witnessedIndex() + 20n;
      const demand = await f.holder.demand("redeem", demanded, deadline, f.served(), f.signed, prove);
      await f.holder.submit("redeem", f.service); await f.publish();
      const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
      f.holder.close();
      const notes = tamperTag(f.directory, damaged, forge), holder = f.open("holder");
      const settled = await holder.settle("settle", acceptance, f.served(), f.signed, prove);
      // The settlement spends exactly the demanded note's nullifier, never the other's.
      const nfs = decodeRecord(settled.record).publicInputs.slice(12, 14);
      expect(nfs).toContain(notes.find(n => n.value === demanded)!.nf);
      expect(nfs).not.toContain(notes.find(n => n.value !== demanded)!.nf);
    }
  });
});

