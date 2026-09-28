import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { commitmentOf, ownerOf } from "../src/pool/notes.js";
import { prepareExactOutput, recoverCapsule } from "../src/pool/v3/capsules.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import type { PackageReader } from "../src/pool/v3/package-reader.js";
import { encodePublication, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { copyPaymentRequest, type PaymentRequest } from "../src/pool/v3/wallet-request.js";
import type { V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { authorizeAcceptance, authorizeIssue, authorizeSettlement, burnTask, demandTask, issueTask, settleTask, spendTask,
  type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeCommitment, signCommitment } from "../src/venue-records.js";

// Stand-in proofs isolate custody and receiving checks. The acceptance harness
// proves the corresponding four-output spend under the actual candidate keys.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), presenterSecret = b(17);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });

describe.skipIf(!supported)("durable v3 receiver requests and current fulfillment", () => {
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
  async function fixture(options: { readerVerifier?: PackageReader["verifier"]; capsule?: (request: PaymentRequest) => Uint8Array } = {}) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-wallet-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: "receiver units", quantumExponent: 0, perUnit: 1n },
      silence: { noCommitmentDuration: 4n, challengeWindow: 5n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const reader: PackageReader = { configuration, venue, reference, verifier: options.readerVerifier ?? verifier };
    const path = join(directory, "receiver.db");
    const reopen = (selected = reader) => { const wallet = new V3Wallet(path, selected); wallets.push(wallet); return wallet; };
    const wallet = reopen(), request = wallet.request("invoice", backing, 7n);
    const j = new V3OperatorJournal(join(directory, "journal.db"), { configuration, venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    const funded = prepareExactOutput(b(21), domain, b(31), backing, 10n), pad = prepareExactOutput(b(21), domain, b(32), backing, 0n);
    await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, funded)), issuerSecret)));
    const tree = new NoteTree(); tree.append(funded.cm);
    const input = { note: funded, anchor: tree.root(), path: tree.path(0n) };
    const fee = prepareExactOutput(b(22), domain, b(33), backing, 1n), change = prepareExactOutput(b(21), domain, b(34), backing, 2n);
    const zero = prepareExactOutput(b(21), domain, b(35), backing, 0n);
    const paid = { ...request, capsule: options.capsule?.(request) ?? request.capsule };
    await j.submit(encodeRecord(record(spendTask(context, [input, { ...input, note: pad }], [fee, paid, zero, change]))));
    const checkpoint = await j.commit("payment"); await j.publish();
    const served = await j.package();
    tree.appendAll([fee.cm, request.cm, zero.cm, change.cm]);
    const owned = recoverCapsule(wallet.recoverySeed(), domain, request.cm, request.capsule)!;
    const receivedInput = { note: owned, anchor: tree.root(), path: tree.path(2n) };
    const inputs = [receivedInput, { ...receivedInput, note: prepareExactOutput(b(24), domain, b(36), backing, 0n) }];
    return { wallet, reopen, reader, path, request, backing, signed, venue, j, served, checkpoint, context, inputs };
  }

  it("persists a random exact request before exposure and owns recovery material across restart", async () => {
    const f = await fixture(), seed = f.wallet.recoverySeed();
    expect(Object.keys(f.request).sort()).toEqual(["capsule", "cm", "domain", "opening"]);
    expect(f.request).not.toHaveProperty("secret"); expect(f.request).not.toHaveProperty("requestId");
    const recovered = recoverCapsule(seed, domain, f.request.cm, f.request.capsule)!;
    expect(recovered.opening).toEqual(f.request.opening);
    f.wallet.close(); const next = f.reopen();
    expect(next.recoverySeed()).toEqual(seed);
    expect(next.request("invoice", f.backing, 7n)).toEqual(f.request);
    const other = next.request("other", f.backing, 7n);
    expect(other.cm).not.toBe(f.request.cm);
    expect(recoverCapsule(seed, domain, other.cm, other.capsule)!.requestId).not.toEqual(recovered.requestId);
    expect(() => next.request("invoice", f.backing, 8n)).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => next.request("zero", f.backing, 0n)).toThrow(expect.objectContaining({ code: "INVALID" }));
    seed.fill(0); other.opening.backing.fill(0); other.capsule.fill(0);
    expect(next.recoverySeed()).not.toEqual(seed);
    expect(next.request("other", f.backing, 7n).opening.backing).toEqual(f.backing);
  });

  it("validates exact payer-agreed request terms and capsule framing without private material", async () => {
    const f = await fixture(), expected = { domain, backing: f.backing, value: 7n };
    expect(copyPaymentRequest(f.request, expected)).toEqual(f.request);
    const invalid = [
      { ...f.request, domain: b(90) }, { ...f.request, cm: f.request.cm + 1n },
      { ...f.request, opening: { ...f.request.opening, backing: b(90) } },
      { ...f.request, opening: { ...f.request.opening, value: 8n } },
      { ...f.request, opening: { ...f.request.opening, owner: 0n } },
      { ...f.request, capsule: new Uint8Array(89) }, { ...f.request, capsule: f.request.capsule.slice(1) },
    ];
    for (const request of invalid) expect(() => copyPaymentRequest(request, expected)).toThrow(EncodingError);
    const copied = copyPaymentRequest(f.request, expected); copied.domain.fill(0); copied.capsule.fill(0); copied.opening.backing.fill(0);
    expect(copyPaymentRequest(f.request, expected)).toEqual(f.request);
  });

  it("records one current four-output payment and reconciles a lost reply through historical lookup", async () => {
    const f = await fixture();
    expect(f.wallet.fulfillment("invoice")).toBeUndefined();
    const fulfilled = await f.wallet.fulfill("invoice", f.served.package, f.signed);
    expect(fulfilled.request).toEqual(f.request); expect(fulfilled.checkpoint).toEqual(f.checkpoint);
    expect(fulfilled.judgingIndex).toBe(f.venue.witnessedIndex()); expect(fulfilled.package).toEqual(f.served.package);
    f.wallet.close(); const next = f.reopen();
    expect(next.fulfillment("invoice")).toEqual(fulfilled);
    await expect(next.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "CONFLICT" });
    fulfilled.package.fill(0); fulfilled.terms.terms.fill(0); fulfilled.checkpoint.root.fill(0); fulfilled.request.capsule.fill(0);
    expect(next.fulfillment("invoice")!.package).toEqual(f.served.package);
    next.request("second-invoice", f.backing, 7n);
    await expect(next.fulfill("second-invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "ABSENT" });
  });

  it("refuses a proof-bound substituted capsule even when the commitment is the requested output", async () => {
    const f = await fixture({ capsule: request => { const changed = request.capsule.slice(); changed[88] = changed[88]! ^ 1; return changed; } });
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "ABSENT" });
    expect(f.wallet.fulfillment("invoice")).toBeUndefined();
  });

  it("requires complete current history and refuses a note spent after the payment checkpoint", async () => {
    const f = await fixture();
    const change = prepareExactOutput(b(25), domain, b(37), f.backing, 2n);
    await f.j.submit(encodeRecord(record(burnTask(f.context, 5n, f.inputs, change))));
    await f.j.commit("spent"); await f.j.publish();
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ status: "unresolved-evidence" });
    const latest = await f.j.package();
    await expect(f.wallet.fulfill("invoice", latest.package, f.signed)).rejects.toMatchObject({ code: "SPENT" });
    expect(f.wallet.fulfillment("invoice")).toBeUndefined();
  });

  it("checks current forced demand and settlement effects beyond the canonical checkpoint", async () => {
    const f = await fixture(); f.venue.advance(7n);
    const demand = record(demandTask(f.context, f.inputs, { backing: f.backing, quantity: 7n,
      presenter: ed25519.getPublicKey(presenterSecret), instant: 5n, deadline: 12n }));
    f.venue.witness(4, f.backing, 7n, encodePublication({ domain, backing: f.backing, kind: 1, record: demand }));
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "LOCKED" });
    const opening = { backing: f.backing, value: 7n, owner: ownerOf(42n), rho: 43n };
    const output = { opening, cm: commitmentOf(domain, opening) }, id = statementHash(demand);
    const acceptance = authorizeAcceptance({ domain, demand: id, owner: opening.owner, deadline: 12n }, issuerSecret);
    const settlement = authorizeSettlement(record(settleTask(f.context, f.inputs, output, id)), acceptance, presenterSecret);
    f.venue.advance(8n);
    f.venue.witness(4, f.backing, 8n, encodePublication({ domain, backing: f.backing, kind: 3, record: settlement }));
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "SPENT" });
    expect(f.wallet.fulfillment("invoice")).toBeUndefined();
  });

  it("owns package and signed terms before asynchronous replay", async () => {
    const f = await fixture(), bytes = Buffer.from(f.served.package);
    const signed = { terms: Buffer.from(f.signed.terms), signature: Buffer.from(f.signed.signature) };
    const pending = f.wallet.fulfill("invoice", bytes, signed);
    bytes.fill(0); signed.terms.fill(0); signed.signature.fill(0);
    const fulfilled = await pending;
    expect(fulfilled.package).toEqual(f.served.package); expect(fulfilled.terms).toEqual(f.signed);
  });

  it.each([false, true])("refuses venue drift during proof callbacks, including same-index changes (%s)", async sameIndex => {
    let mutate = () => {};
    const f = await fixture({ readerVerifier: { verify: (...args) => { mutate(); return verifier.verify(...args); } } });
    let changed = false;
    mutate = () => {
      if (changed) return; changed = true;
      if (!sameIndex) f.venue.advance(f.venue.witnessedIndex() + 1n);
      else f.venue.witness(1, operator, f.venue.witnessedIndex(), encodeCommitment(signCommitment(operatorSecret, 99n, b(90))));
    };
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "CHANGED_VIEW" });
    expect(f.wallet.fulfillment("invoice")).toBeUndefined();
  });

  it("fences an old handle and an in-flight fulfillment after reopening", async () => {
    let replace = () => {};
    const f = await fixture({ readerVerifier: { verify: (...args) => { replace(); return verifier.verify(...args); } } });
    let next: Wallet | undefined;
    replace = () => { next ??= f.reopen({ ...f.reader, verifier }); };
    await expect(f.wallet.fulfill("invoice", f.served.package, f.signed)).rejects.toMatchObject({ code: "FENCED" });
    expect(() => f.wallet.request("new", f.backing, 1n)).toThrow(expect.objectContaining({ code: "FENCED" }));
    expect(next!.fulfillment("invoice")).toBeUndefined();
    expect((await next!.fulfill("invoice", f.served.package, f.signed)).request).toEqual(f.request);
  });

  it("serializes competing fulfillments into one local credit", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.wallet.fulfill("invoice", f.served.package, f.signed),
      f.wallet.fulfill("invoice", f.served.package, f.signed)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect(f.wallet.fulfillment("invoice")!.request).toEqual(f.request);
  });
});
