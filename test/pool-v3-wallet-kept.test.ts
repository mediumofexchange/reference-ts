// The wallet on its own kept files (pool-v3 §14, storage decision 2026-09-29 items 6 and 8, M5b.5c): its
// evidence file is synced from the service over HTTP, its reads keep their replay state and this seed's
// witnesses, and a later sync fetches, verifies and scans only what is new. Stand-in proofs of real proof
// size; the real-proof acceptance is scripts/pool/v3/store-check.mjs.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { decodeReceipt } from "../src/pool/v3/commitments.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { ownedNotes, seedWitness } from "../src/pool/v3/holdings.js";
import { decodeEvidencePackage } from "../src/pool/v3/package.js";
import { readFrontier } from "../src/pool/v3/package-reader.js";
import { ReplayStore } from "../src/pool/v3/replay-store.js";
import { encodeRecord, type Record } from "../src/pool/v3/records.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import type { LocalProver, V3Wallet as Wallet, WalletView } from "../src/pool/v3/wallet-store.js";
import { authorizeIssue, issueTask, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE, type RecordVenue } from "../src/record-venue.js";

const b = (n: number) => new Uint8Array(32).fill(n);
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
/** A stand-in proof of a real proof's size, so the evidence passes the old one-megabyte package. */
const PROOF_BYTES = 14_720;
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: new Uint8Array(PROOF_BYTES).fill(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const holdings = (view: WalletView) => view.holdings.map(h => [h.cm, h.value, h.status]);

describe("v3 wallet reads over its kept evidence and replay files", () => {
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let createV3Service: typeof import("../src/pool/v3/service-http.js").createV3Service;
  const wallets: Wallet[] = [], journals: Journal[] = [], servers: Server[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    ({ createV3Service } = await import("../src/pool/v3/service-http.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    for (const wallet of wallets.splice(0)) { try { wallet.close(); } catch { /* already closed */ } }
    for (const journal of journals.splice(0)) journal.close();
    for (const directory of directories.splice(0)) {
      if (!resolve(directory).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  /** A journal served over HTTP, and a payer wallet whose verifier declares its circuits and counts what it is
   * asked to verify, on a venue that counts the ranges it is asked and can show an earlier clock. */
  async function fixture(notes: number) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-wallet-kept-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 1_000n,
      payout: { thing: "kept wallet units", quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const counts = { verified: 0, asked: 0 }, view: { at?: bigint } = {}, gate: { wait?: Promise<void> } = {};
    // A verification waits for the gate while one is set, which holds a read in flight.
    const counting = { identities: configuration.circuits, verify: (...args: Parameters<typeof verifier.verify>) => {
      counts.verified++; return gate.wait === undefined ? verifier.verify(...args) : gate.wait.then(() => verifier.verify(...args));
    } };
    const seen: RecordVenue = { get id() { return venue.id; }, lag: () => venue.lag(), witnessedIndex: () => view.at ?? venue.witnessedIndex(),
      range: (request, limits) => { counts.asked++; return venue.range(request, limits); } };
    const reader = { configuration, venue: seen, reference, verifier: counting };
    const path = (name: string) => join(directory, `${name}.db`);
    const open = (name: string) => { const wallet = new V3Wallet(path(name), reader); wallets.push(wallet); return wallet; };
    const j = new V3OperatorJournal(path("journal"), { configuration, venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    const tokens = { walletToken: "11".repeat(32), adminToken: "22".repeat(32) }, requests: { url: string; bytes: number }[] = [];
    const server = createV3Service(j, tokens); servers.push(server);
    server.prependListener("request", (request, response) => {
      const entry = { url: request.url ?? "", bytes: 0 }, write = response.write.bind(response) as (...args: unknown[]) => boolean;
      requests.push(entry);
      response.write = ((chunk: Uint8Array, ...rest: unknown[]) => { entry.bytes += chunk.length; return write(chunk, ...rest); }) as typeof response.write;
    });
    await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", done); });
    const client = new V3ServiceClient(`http://127.0.0.1:${(server.address() as { port: number }).port}/`, tokens.walletToken, { domain, operator, reference });
    const payer = open("payer"), receiver = open("receiver");
    // The backer issues one unit to each of the payer's requests: `notes` statements in one checkpoint.
    for (let i = 0; i < notes; i++) {
      await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, payer.request(`fund-${i}`, backing, 1n))), issuerSecret)));
    }
    let checkpoints = 0;
    const publish = async () => { await j.commit(`c${checkpoints++}`); return j.publish(); };
    await publish();
    /** Sync the wallet's evidence file from the service, then read with the read's own package. */
    const synced = async (wallet: Wallet, options: { full?: boolean } = {}) => {
      const served = await wallet.supply(evidence => client.sync(backing, evidence, options));
      return { served, view: await wallet.sync(served.package, signed) };
    };
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    return { directory, venue, view, gate, signed, backing, counts, requests, client, payer, receiver, open, path, reader, j, publish, synced, service };
  }

  it("syncs past the old one-megabyte ceiling over HTTP, then fetches, verifies and scans only what is new", async () => {
    const NOTES = 72, f = await fixture(NOTES);
    const first = await f.synced(f.payer);
    // Past the old ceiling: 67 statements and one megabyte in one package. The read's own package is two small items.
    expect(f.requests.at(-1)!.bytes).toBeGreaterThan(1_048_576);
    expect(decodeEvidencePackage(first.served.package).map(item => item.kind)).toEqual([1, 2]);
    expect(first.served.package.length).toBeLessThan(1_000);
    expect(f.counts.verified).toBe(NOTES);
    expect(first.view.holdings).toHaveLength(NOTES);
    expect(first.view.holdings.every(h => h.value === 1n && h.status === "available")).toBe(true);

    // A payment of two notes: preparing reads the kept state (nothing is verified again but the wallet's own new record).
    const invoice = f.receiver.request("invoice", f.backing, 2n), asked = f.counts.asked;
    f.counts.verified = 0;
    const payment = await f.payer.prepare("shop", { request: invoice, value: 2n }, first.served.package, f.signed, prove);
    expect(f.counts.verified).toBe(1);
    expect(f.counts.asked).toBe(asked);
    await f.payer.submit("shop", f.service);
    const checkpoint = await f.publish();

    // The second sync fetches the new record and the new checkpoint's objects, verifies that one record and
    // asks the venue only for the indices after the first read's.
    f.counts.verified = 0;
    const second = await f.synced(f.payer);
    expect(f.requests.at(-1)!.url.endsWith(`&after=${first.served.selection.sequence}`)).toBe(true);
    expect(f.requests.at(-1)!.bytes).toBeLessThan(payment.record.length + 2_500);
    expect(f.counts.verified).toBe(1);
    expect(f.counts.asked).toBeGreaterThan(asked);
    expect(second.view.checkpoint).toEqual(checkpoint);
    // The two spent notes are gone and no change is due (1 + 1 − 2): the view is NOTES − 2 unit notes.
    expect(second.view.holdings).toHaveLength(NOTES - 2);
    expect(f.payer.payment("shop")).toMatchObject({ status: "final", final: { checkpoint, judgingIndex: second.view.judgingIndex } });
    expect((await f.receiver.fulfill("invoice", (await f.receiver.supply(evidence => f.client.sync(f.backing, evidence))).package, f.signed)).checkpoint).toEqual(checkpoint);

    // A wallet restored from the seed alone reads the same view from a first sync of its own.
    const restored = V3Wallet.restoreSeed(f.path("restored"), f.reader, f.payer.recoverySeed()); wallets.push(restored);
    f.counts.verified = 0;
    expect(holdings((await f.synced(restored)).view)).toEqual(holdings(second.view));
    expect(f.counts.verified).toBe(NOTES + 1);

    // After a restart, with nothing new: nothing is fetched beyond the selection, verified or asked of the venue.
    f.payer.close();
    const reopened = f.open("payer"), before = f.counts.asked;
    f.counts.verified = 0;
    const third = await f.synced(reopened);
    expect(holdings(third.view)).toEqual(holdings(second.view));
    expect([f.counts.verified, f.counts.asked - before]).toEqual([0, 0]);
    expect(f.requests.at(-1)!.bytes).toBeLessThan(1_500);
    // The kept witnesses are this read's paths: the wallet pays again from them, and the journal admits the anchor.
    const next = await reopened.prepare("again", { request: f.receiver.request("second", f.backing, 1n), value: 1n }, third.served.package, f.signed, prove);
    expect((await reopened.submit("again", f.service)).statementHash).toEqual(next.statement);
  }, 240_000);

  it("falls back to a full read where its kept state is damaged, lost or past the venue's view, and to a full sync where its evidence is", async () => {
    const f = await fixture(3);
    const first = await f.synced(f.payer), early = f.venue.witnessedIndex();
    await f.payer.prepare("shop", { request: f.receiver.request("invoice", f.backing, 1n), value: 1n }, first.served.package, f.signed, prove);
    await f.payer.submit("shop", f.service); await f.publish();
    const second = await f.synced(f.payer);
    expect(second.view.holdings).toHaveLength(2);
    const replay = `${f.path("payer")}.replay`, evidence = `${f.path("payer")}.evidence`;

    // A venue view older than the last read's: the kept witnesses are past it, so the state is discarded and replayed.
    // Nothing kept is used, answers included: the venue is asked for everything again.
    f.view.at = early; f.counts.verified = 0; f.counts.asked = 0;
    const earlier = await f.payer.sync(second.served.package, f.signed);
    expect(f.counts.asked).toBeGreaterThanOrEqual(3);
    // At that index the payment is not yet in history: its input shows reserved beside the two free notes.
    const free = second.view.holdings.map(h => h.cm);
    expect(holdings(earlier)).toEqual(first.view.holdings.map(h => [h.cm, h.value, free.includes(h.cm) ? "available" : "reserved"]));
    expect(earlier.checkpoint).toEqual(first.view.checkpoint);
    expect(f.counts.verified).toBe(3);
    delete f.view.at; f.counts.verified = 0;
    expect(holdings(await f.payer.sync(second.served.package, f.signed))).toEqual(holdings(second.view));
    expect(f.counts.verified).toBe(1);

    // A replay file changed in place, or one whose digest is lost, is not reused: the read verifies everything again.
    for (const damage of ["corrupt", "undigested"] as const) {
      f.payer.close();
      if (damage === "corrupt") { const bytes = readFileSync(replay), at = bytes.length >> 1; bytes[at] = bytes[at]! ^ 1; writeFileSync(replay, bytes); }
      else rmSync(`${replay}.sha256`);
      f.payer = f.open("payer"); f.counts.verified = 0;
      expect(holdings(await f.payer.sync(second.served.package, f.signed))).toEqual(holdings(second.view));
      expect(f.counts.verified).toBe(4);
    }

    // Evidence rows lost while the file's mark stands: an ordinary sync brings nothing, the read stays unresolved,
    // and a full sync repairs it. A kept class is judged on the evidence again, so the kept state alone reads nothing.
    f.payer.close();
    const db = new DatabaseSync(evidence); db.exec("DELETE FROM chain"); db.close();
    f.payer = f.open("payer");
    await expect(f.synced(f.payer)).rejects.toMatchObject({ status: "unresolved-evidence" });
    f.counts.verified = 0;
    expect(holdings((await f.synced(f.payer, { full: true })).view)).toEqual(holdings(second.view));
    expect(f.counts.verified).toBe(0);

    // An evidence file that is no database is never replaced by the wallet: the holder removes it.
    f.payer.close(); writeFileSync(evidence, new Uint8Array(8192).fill(7));
    f.payer = f.open("payer");
    await expect(f.payer.sync(second.served.package, f.signed)).rejects.toMatchObject({ code: "STORAGE", message: "the wallet's evidence file cannot be read; remove it to sync again" });
    await expect(f.payer.supply(async () => {})).rejects.toMatchObject({ code: "STORAGE" });

    // A lost evidence file loses its mark with it: the next sync asks from nothing.
    f.payer.close(); rmSync(evidence);
    f.payer = f.open("payer");
    await expect(f.payer.sync(second.served.package, f.signed)).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(holdings((await f.synced(f.payer)).view)).toEqual(holdings(second.view));
    expect(f.requests.at(-1)!.url.endsWith("&after=0")).toBe(true);
  }, 120_000);

  it("keeps the witnesses a fresh replay of the same evidence computes, across payments both ways and later reads", async () => {
    const f = await fixture(5);
    let { served } = await f.synced(f.payer);
    // Two rounds, each its own checkpoint and read: the payer pays one unit and the receiver pays it back to a
    // new request, so the payer's kept witnesses move under later outputs and new ones start at later leaves.
    for (const round of [0, 1]) {
      await f.payer.prepare(`out-${round}`, { request: f.receiver.request(`invoice-${round}`, f.backing, 1n), value: 1n }, served.package, f.signed, prove);
      await f.payer.submit(`out-${round}`, f.service); await f.publish();
      const paid = (await f.synced(f.receiver)).served;
      await f.receiver.prepare(`back-${round}`, { request: f.payer.request(`refund-${round}`, f.backing, 1n), value: 1n }, paid.package, f.signed, prove);
      await f.receiver.submit(`back-${round}`, f.service); await f.publish();
      ({ served } = await f.synced(f.payer));
    }
    const seed = f.payer.recoverySeed(), path = f.path("payer"), at = f.venue.witnessedIndex(), records = 5 + 4;
    f.payer.close();
    // The wallet's own two files, read as the wallet reads them: nothing is verified, so the state is the kept one.
    const evidence = new EvidenceStore(`${path}.evidence`), keptStore = new ReplayStore(`${path}.replay`, { digest: `${path}.replay.sha256` });
    try {
      const paths = (result: Awaited<ReturnType<typeof readFrontier>>) =>
        ownedNotes(seed, domain, f.backing, result.canonical!.state).map(note => ({ cm: note.cm, leaf: note.leaf, anchor: note.anchor, path: note.path }));
      f.counts.verified = 0;
      const kept = paths(await readFrontier(served.package, f.signed, at, { ...f.reader, evidence, store: keptStore, witness: seedWitness(seed, domain) }));
      expect(f.counts.verified).toBe(0);
      // The same evidence replayed from nothing in memory.
      const fresh = paths(await readFrontier(served.package, f.signed, at, { ...f.reader, evidence, witness: seedWitness(seed, domain) }));
      expect(f.counts.verified).toBe(records);
      // Three funded notes never spent and the two refunds, whose leaves follow every funded one.
      expect(kept.map(note => note.leaf < 5n)).toEqual([true, true, true, false, false]);
      expect(kept).toEqual(fresh);
    } finally { keptStore.close(); evidence.close(); }
  }, 60_000);

  it("fences a handle replaced during its read, whose kept replay file the newer handle cannot take from under it", async () => {
    const f = await fixture(2);
    const served = await f.payer.supply(evidence => f.client.sync(f.backing, evidence));
    let release!: () => void;
    f.gate.wait = new Promise<void>(done => { release = done; });
    // The first handle's first read stops at its first verification, its walk open on the kept replay file.
    const settled = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
    const older = settled(f.payer.sync(served.package, f.signed));
    while (f.counts.verified === 0) await new Promise(done => setImmediate(done));
    // A newer handle owns the wallet from here, and reads while the older read still holds the file.
    const second = f.open("payer"), newer = settled(second.sync(served.package, f.signed));
    await new Promise(done => setTimeout(done, 50));
    delete f.gate.wait; release();
    // The older read finishes in a kept file, which holds any reader's own classes, and answers nothing.
    expect(await older).toMatchObject({ error: { code: "FENCED" } });
    await expect(f.payer.sync(served.package, f.signed)).rejects.toMatchObject({ code: "FENCED" });
    // Windows does not let the newer handle replace the file an open walk holds: its read refuses until the
    // older handle closes. Elsewhere it replaces the file and replays into its own; the older read's kept
    // state goes with the unlinked file (storage decision, M5b.5c.1 limits).
    const outcome = await newer;
    if (process.platform === "win32" || "error" in outcome) expect(outcome).toMatchObject({ error: { code: "STORAGE", message: "another handle holds this wallet's kept replay file" } });
    else expect(outcome.value.holdings).toHaveLength(2);
    f.payer.close();
    // Either way the newer handle then reads kept state: nothing is verified again.
    f.counts.verified = 0;
    expect((await second.sync(served.package, f.signed)).holdings).toHaveLength(2);
    expect(f.counts.verified).toBe(0);
  });

  it("takes turns between supplies and reads, and supplies nothing through a frozen or closed wallet", async () => {
    const f = await fixture(2);
    const order: string[] = [];
    const supplied = f.payer.supply(async evidence => { order.push("supply"); const served = await f.client.sync(f.backing, evidence); order.push("supplied"); return served; });
    const late = f.payer.supply(async () => { order.push("second"); });
    const served = await supplied; await late;
    expect(order).toEqual(["supply", "supplied", "second"]);
    // A failed transport does not hold up the next turn.
    await expect(f.payer.supply(async () => { throw new Error("transport failed"); })).rejects.toThrow("transport failed");
    expect((await f.payer.sync(served.package, f.signed)).holdings).toHaveLength(2);
    await expect(f.payer.supply(undefined as never)).rejects.toMatchObject({ code: "INVALID" });
    // A venue of the same identity behind the kept answers (a replaced local venue): nothing kept answers for it.
    // It holds no record, so the receiver's request is not fulfilled from what an earlier venue showed.
    const invoice = f.receiver.request("invoice", f.backing, 1n);
    await f.payer.prepare("shop", { request: invoice, value: 1n }, served.package, f.signed, prove);
    await f.payer.submit("shop", f.service); await f.publish();
    const paid = await f.receiver.supply(evidence => f.client.sync(f.backing, evidence));
    expect((await f.receiver.sync(paid.package, f.signed)).holdings).toHaveLength(1);
    f.receiver.close();
    const behind = FixtureVenue.reference(label, lag, f.venue.witnessedIndex() - 1n);
    const replaced = new V3Wallet(f.path("receiver"), { ...f.reader, venue: behind }); wallets.push(replaced);
    await expect(replaced.fulfill("invoice", paid.package, f.signed)).rejects.toMatchObject({ code: "ABSENT" });
    expect(replaced.fulfillment("invoice")).toBeUndefined();
    f.payer.exportBackup(b(9));
    await expect(f.payer.supply(async () => {})).rejects.toMatchObject({ code: "FENCED" });
    f.payer.close();
    await expect(f.payer.supply(async () => {})).rejects.toMatchObject({ code: "STORAGE" });
  });
});
