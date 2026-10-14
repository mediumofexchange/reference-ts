// Slice 38 (succinct-read §§2–3, Next 12 step 4): a wallet reading succinctly. Its public evidence is proof-free, synced
// from the operator's service, with covers a replica's prover keeps and the tail's proofs fetched by place; its own
// records stay complete. Twins restored from one seed, one complete and one succinct, read one history (issues over
// several checkpoints, a demand, its acceptance and settlement, a payment) and must agree on every view. Stand-in proofs
// of a cover's length, which the test verifier accepts where the first byte is the kind, under a test check set.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { adoptedConfiguration, configurationHash } from "../src/pool/v3/configuration.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import type { Record } from "../src/pool/v3/records.js";
import { serviceSupply, V3ServiceClient } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { COVER_PROOF_BYTES, testCheckSet, testProver, type CheckSupply, type RecordAt } from "../src/pool/v3/succinct.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import type { BackerSigner, LocalProver, V3Wallet as Wallet, WalletOptions, WalletView } from "../src/pool/v3/wallet-store.js";
import type { ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration(), domain = configurationHash(configuration);
const issuerSecret = b(15), operatorSecret = b(16), issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind, identities: configuration.circuits };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(COVER_PROOF_BYTES).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const sign: BackerSigner = message => ed25519.sign(message, issuerSecret);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const SET = testCheckSet("succinct wallet");
/** What a wallet's view shows a holder. */
const shown = (view: WalletView) => ({ checkpoint: view.checkpoint, judgingIndex: view.judgingIndex, gap: view.gap,
  holdings: view.holdings.map(h => [h.cm, h.value, h.status, h.presented]), demands: view.demands });

describe("a wallet reading succinctly (slice 38)", () => {
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let service: typeof import("../src/pool/v3/service-http.js");
  let V3Replica: typeof import("../src/pool/v3/replica.js").V3Replica;
  const closing: { close(): void }[] = [], servers: Server[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    service = await import("../src/pool/v3/service-http.js");
    ({ V3Replica } = await import("../src/pool/v3/replica.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    for (const c of closing.splice(0).reverse()) { try { c.close(); } catch { /* closed */ } }
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const listen = async (server: Server): Promise<string> => {
    servers.push(server);
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  };

  /** The backer issues `funds` to the holder, one issue a checkpoint; a replica mirrors the operator and proves covers. */
  async function fixture(funds: readonly bigint[]) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-succinct-wallet-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: "succinct wallet units", quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const complete: WalletOptions = { venue, reference, verifier };
    const j = new V3OperatorJournal(join(directory, "journal.db"), { venue, reference, verifier, secret: operatorSecret }); closing.push(j);
    await j.open("genesis", signed); await j.publish();
    const operatorUrl = await listen(service.createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN }));
    const identity = { operator, reference: { ...reference, label: label.slice() } };
    const replicaPath = join(directory, "replica.db"), replicaStore = new EvidenceStore(replicaPath, { shared: true }); closing.push(replicaStore);
    const replica = new V3Replica(replicaPath, replicaStore, venue.id);
    const replicaUrl = await listen(service.createV3EvidenceService(replica));
    const operatorClient = new V3ServiceClient(operatorUrl, TOKEN, identity);
    /** The replica syncs from the operator and its prover covers what it holds. */
    const mirror = async () => { replica.keep(await operatorClient.sync(backing, replicaStore)); await replica.prove(testProver(SET, verifier)); };
    let checkpoints = 0, served = (await j.package()).package;
    const publish = async () => { await j.commit(`c${checkpoints++}`); await j.publish(); served = (await j.package()).package; return served; };
    const submitter = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    const open = (name: string, options = complete) => { const w = new V3Wallet(join(directory, `${name}.db`), options); closing.push(w); return w; };
    /** A succinct reader's options, its supply counting what it asks: the replica's covers, then the operator's proofs. */
    const asked = { covers: 0, answered: 0, proofs: 0, places: [] as RecordAt[] };
    const succinct = (): WalletOptions => {
      const wire = serviceSupply(SET.identity, [new V3ServiceClient(replicaUrl, undefined, identity), new V3ServiceClient(operatorUrl, TOKEN, identity)]);
      const supply: CheckSupply = {
        cover: async (digest, accept) => { asked.covers++; const answer = await wire.cover(digest, accept); if (answer !== undefined) asked.answered++; return answer; },
        proof: async (hash, at) => { asked.proofs++; if (at !== undefined) asked.places.push(at); return wire.proof(hash, at); },
      };
      return { ...complete, succinct: { set: SET, supply } };
    };
    const restore = (name: string, wallet: Wallet, options: WalletOptions) => {
      const w = V3Wallet.restoreSeed(join(directory, `${name}.db`), options, wallet.recoverySeed()); closing.push(w); return w;
    };
    /** A succinct wallet's sync: proof-free evidence from the operator's service, then the read over its own package. */
    const syncSuccinct = async (wallet: Wallet) => {
      const client = new V3ServiceClient(operatorUrl, TOKEN, { ...identity, construction: wallet.reading });
      return (await wallet.supply(evidence => client.sync(backing, evidence))).package;
    };
    const backer = open("backer"), holder = open("holder");
    for (const [i, value] of funds.entries()) {
      await backer.issue(`issue-${i}`, holder.request(`fund-${i}`, backing, value), value, served, signed, prove, sign);
      await backer.submit(`issue-${i}`, submitter);
      await publish();
    }
    return { directory, venue, signed, backing, backer, holder, open, publish, served: () => served, submitter, mirror, succinct, restore,
      syncSuccinct, asked };
  }

  it("agrees with a complete wallet of the same seed on every view, finds a settlement's output from its proof-free form, and pays", async () => {
    const f = await fixture([10n, 3n, 2n, 4n]);
    // A demand of the 10, accepted and settled to the backer's own seed (C4.7): its output is found by the settlement's
    // statement and acceptance, which the proof-free form carries.
    const deadline = f.venue.witnessedIndex() + 20n;
    await f.holder.sync(f.served(), f.signed);
    const demand = await f.holder.demand("redeem", 10n, deadline, f.served(), f.signed, prove);
    await f.holder.submit("redeem", f.submitter); await f.publish();
    await f.backer.sync(f.served(), f.signed);
    const acceptance = await f.backer.accept("answer", demand.demand!, deadline - 5n, f.served(), f.signed, sign);
    await f.holder.sync(f.served(), f.signed);
    await f.holder.settle("settle", acceptance, f.served(), f.signed, prove);
    await f.holder.submit("settle", f.submitter); await f.publish();
    await f.mirror();

    const options = f.succinct();
    const holder = f.restore("holder-succinct", f.holder, options), backer = f.restore("backer-succinct", f.backer, f.succinct());
    expect(holder.reading).not.toBe(f.holder.reading);
    const fullHolder = await f.holder.sync(f.served(), f.signed), fullBacker = await f.backer.sync(f.served(), f.signed);
    expect(fullBacker.holdings.map(h => h.value)).toEqual([10n]);
    expect(shown(await holder.sync(await f.syncSuccinct(holder), f.signed))).toEqual(shown(fullHolder));
    expect(shown(await backer.sync(await f.syncSuccinct(backer), f.signed))).toEqual(shown(fullBacker));
    // Every proved record was covered: nothing fetched. Its evidence is proof-free and kept apart from a complete file.
    expect(f.asked).toMatchObject({ proofs: 0 });
    expect(f.asked.answered).toBeGreaterThan(0);
    expect(existsSync(join(f.directory, "holder-succinct.db.succinct-evidence"))).toBe(true);
    expect(existsSync(join(f.directory, "holder-succinct.db.evidence"))).toBe(false);

    // The succinct holder pays a succinct receiver from its own view; its record is complete and the operator admits it.
    const receiver = f.open("receiver", f.succinct());
    const payment = await holder.prepare("shop", { request: receiver.request("invoice", f.backing, 5n), value: 5n },
      await f.syncSuccinct(holder), f.signed, prove);
    expect(payment.record.length).toBeGreaterThan(COVER_PROOF_BYTES);
    await holder.submit("shop", f.submitter);
    await f.publish();
    // The new payment is the tail no cover reaches yet: its proof is fetched by its place, from the operator.
    const before = f.asked.places.length;
    const fulfilled = await receiver.fulfill("invoice", await f.syncSuccinct(receiver), f.signed);
    expect(f.asked.places.length).toBeGreaterThan(before);
    const after = await holder.sync(await f.syncSuccinct(holder), f.signed);
    expect(fulfilled.checkpoint).toEqual(after.checkpoint);
    expect(holder.payment("shop")).toMatchObject({ status: "final" });
    // 3 + 2 + 4 held, 5 paid.
    expect(after.holdings.reduce((n, h) => n + h.value, 0n)).toBe(4n);
  });

  it("refuses a succinct read of a construction other than pool-v3", async () => {
    const f = await fixture([1n]);
    const { LIT } = await import("../src/lit/construction.js");
    expect(() => f.open("lit", { ...f.succinct(), construction: LIT as never })).toThrow("a succinct read is pool-v3's");
  });
});
