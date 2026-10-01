import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { identifierOf } from "../src/pool/field.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { configurationHash, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { acceptanceBytes, decodeRecord, encodePublication, settlementAuthorization, statementHash, type Record } from "../src/pool/v3/records.js";
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
      await expect(build()).rejects.toMatchObject({ code: "CHANGED_VIEW", message: "the venue view is older than one this wallet has read" });
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
    const read = await readFrontier(f.served(), f.signed, f.venue.witnessedIndex(), { venue: f.venue, reference, verifier, releases: true });
    expect(read.releases.map(r => r.output)).toEqual([decodeRecord(late.record).publicInputs[14]]);
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
    // The reader lists releases without force only: the forged one and the late one, not the one with force.
    const after = await readFrontier(f.served(), f.signed, f.venue.witnessedIndex(), { venue: f.venue, reference, verifier, releases: true });
    expect(after.force.map(x => x.record.kind)).toEqual([4, 6]);
    expect(after.releases.map(r => r.output)).toEqual([l[14], l[14]! + 1n]);
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
});

