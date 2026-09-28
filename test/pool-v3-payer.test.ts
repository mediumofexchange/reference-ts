import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput, recoverCapsule } from "../src/pool/v3/capsules.js";
import { decodeReceipt, type Receipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, type CandidateConfiguration } from "../src/pool/v3/configuration.js";
import { decodeRecord, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import type { PaymentRequest } from "../src/pool/v3/wallet-request.js";
import type { LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { authorizeIssue, burnTask, issueTask, spendTask, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

// Stand-in proofs isolate payer custody; store-check.mjs proves the same flow
// under the candidate keys. v2 cases ported: selection, padding, reservation,
// exact and concurrent retry, proof failure, receipt checks and restart.
const b = (n: number) => new Uint8Array(32).fill(n), supported = Number(process.versions.node.split(".")[0]) >= 24;
const configuration: CandidateConfiguration = { helper: hexToBytes("44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8"),
  circuits: Object.fromEntries(RELATIONS.map((name, i) => [name, { bytecode: b(40 + i), vk: b(50 + i) }])) as CandidateConfiguration["circuits"] };
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const outputsOf = (bytes: Uint8Array) => decodeRecord(bytes).publicInputs.slice(9, 13);

describe.skipIf(!supported)("v3 payer custody over restored holdings", () => {
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

  /** The payer wallet holds two issued notes of `funds`; a receiver and an operator fee recipient request payment. */
  async function fixture(funds: readonly bigint[] = [10n, 6n]) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-payer-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, configuration: domain, venue: venue.id, interval: 20n,
      payout: { thing: "payer units", quantumExponent: 0, perUnit: 1n } });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    const reader = { configuration, venue, reference, verifier };
    const open = (name: string) => { const wallet = new V3Wallet(join(directory, `${name}.db`), reader); wallets.push(wallet); return wallet; };
    const payer = open("payer"), receiver = open("receiver");
    const j = new V3OperatorJournal(join(directory, "journal.db"), { configuration, venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    const funding = funds.map((value, i) => payer.request(`fund-${i}`, backing, value));
    for (const request of funding) await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, request)), issuerSecret)));
    let checkpoints = 0;
    const publish = async () => { await j.commit(`c${checkpoints++}`); await j.publish(); return (await j.package()).package; };
    const invoice = receiver.request("invoice", backing, 7n), fee = prepareExactOutput(b(22), domain, b(33), backing, 1n);
    const feeRequest: PaymentRequest = { domain, opening: fee.opening, cm: fee.cm, capsule: fee.capsule };
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
    return { directory, venue, signed, backing, context, payer, receiver, open, j, publish, funding, invoice, feeRequest, service,
      served: await publish(), order: { request: invoice, value: 7n, fee: { request: feeRequest, value: 1n } } };
  }

  it("pays the exact request, fee and change from the smallest covering note and reconciles from evidence", async () => {
    const f = await fixture();
    const before = await f.payer.sync(f.served, f.signed);
    expect(before.holdings.map(h => [h.cm, h.value, h.status])).toEqual(f.funding.map(r => [r.cm, r.opening.value, "available"]));
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    const funded = recoverCapsule(f.payer.recoverySeed(), domain, f.funding[0]!.cm, f.funding[0]!.capsule)!;
    expect(payment).toMatchObject({ payee: f.invoice.cm, value: 7n, fee: { cm: f.feeRequest.cm, value: 1n }, inputs: [funded.nf],
      status: "prepared", receipt: undefined, final: undefined });
    const outputs = outputsOf(payment.record);
    expect(outputs).toContain(f.invoice.cm); expect(outputs).toContain(f.feeRequest.cm);
    const capsules = decodeRecord(payment.record).capsules;
    expect(capsules[outputs.indexOf(f.invoice.cm)]).toEqual(f.invoice.capsule);
    expect(payment.statement).toEqual(statementHash(decodeRecord(payment.record)));
    // Exact retry needs neither evidence nor a prover.
    expect(await f.payer.prepare("shop", f.order, new Uint8Array(), f.signed, undefined as never)).toEqual(payment);
    expect((await f.payer.sync(f.served, f.signed)).holdings.map(h => h.status)).toEqual(["reserved", "available"]);
    const receipt = await f.payer.submit("shop", f.service);
    expect(receipt.statementHash).toEqual(payment.statement);
    const served = await f.publish();
    expect((await f.receiver.fulfill("invoice", served, f.signed)).request).toEqual(f.invoice);
    const after = await f.payer.sync(served, f.signed);
    // The change note is found by the seed scan alone: 10 − 7 − 1.
    expect(after.holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"], [2n, "available"]]);
    expect(f.payer.payment("shop")).toMatchObject({ status: "final", receipt, final: { checkpoint: after.checkpoint, judgingIndex: after.judgingIndex } });
  });

  it("selects the least-total pair, pads a single input and refuses a payment needing three notes", async () => {
    const f = await fixture([3n, 5n, 9n, 4n]);
    const pair = await f.payer.prepare("pair", { request: f.invoice, value: 7n }, f.served, f.signed, prove);
    const nfs = (values: bigint[]) => values.map(v => f.funding.find(r => r.opening.value === v)!)
      .map(r => recoverCapsule(f.payer.recoverySeed(), domain, r.cm, r.capsule)!.nf).sort((a, b) => a < b ? -1 : 1);
    // 7 is covered by 9 alone; the pair search starts only when no single note covers.
    expect(pair.inputs).toEqual(nfs([9n]));
    const p = decodeRecord(pair.record).publicInputs;
    expect(p.slice(7, 9)).toContain(nfs([9n])[0]); expect(new Set(p.slice(7, 9)).size).toBe(2);
    const other = f.receiver.request("second", f.backing, 8n);
    const second = await f.payer.prepare("second", { request: other, value: 8n }, f.served, f.signed, prove);
    // Of 3, 4 and 5, the pair 3 + 5 covers 8 exactly; 4 + 5 would leave change.
    expect(second.inputs).toEqual(nfs([3n, 5n]));
    const third = f.receiver.request("third", f.backing, 3n);
    expect((await f.payer.prepare("third", { request: third, value: 3n }, f.served, f.signed, prove)).inputs).toEqual(nfs([4n]));
    const fourth = f.receiver.request("fourth", f.backing, 1n);
    await expect(f.payer.prepare("fourth", { request: fourth, value: 1n }, f.served, f.signed, prove)).rejects.toMatchObject({ code: "FUNDS" });
    const g = await fixture([2n, 2n, 2n, 2n]);
    await expect(g.payer.prepare("big", { request: g.invoice, value: 7n }, g.served, g.signed, prove)).rejects.toMatchObject({ code: "FUNDS" });
    expect(g.payer.payment("big")).toBeUndefined();
  });

  it("checks agreed request terms and refuses an already saved or already paid request", async () => {
    const f = await fixture();
    await expect(f.payer.prepare("wrong", { request: f.invoice, value: 8n }, f.served, f.signed, prove)).rejects.toThrow(EncodingError);
    await expect(f.payer.prepare("same-fee", { request: f.invoice, value: 7n, fee: { request: f.invoice, value: 7n } }, f.served, f.signed, prove))
      .rejects.toMatchObject({ code: "INVALID" });
    await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    await expect(f.payer.prepare("again", { request: f.invoice, value: 7n }, f.served, f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.payer.prepare("fee-again", { request: f.receiver.request("other", f.backing, 1n), value: 1n,
      fee: { request: f.feeRequest, value: 1n } }, f.served, f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    // Another payer already paid this request in canonical history.
    const g = await fixture(), note = recoverCapsule(g.payer.recoverySeed(), domain, g.funding[1]!.cm, g.funding[1]!.capsule)!;
    const tree = new NoteTree(); tree.appendAll(g.funding.map(r => r.cm));
    const input = { note, anchor: tree.root(), path: tree.path(1n) }, pad = prepareExactOutput(b(60), domain, b(61), g.backing, 0n);
    const zero = (id: number) => prepareExactOutput(b(60), domain, b(id), g.backing, 0n);
    await expect(g.payer.prepare("late", { request: g.receiver.request("late", g.backing, 6n), value: 6n }, g.served, g.signed, prove))
      .resolves.toMatchObject({ status: "prepared" });
    const paid = g.receiver.request("paid", g.backing, 3n), rest = prepareExactOutput(b(60), domain, b(63), g.backing, 3n);
    await g.j.submit(encodeRecord(record(spendTask(g.context, [input, { ...input, note: pad }], [paid, rest, zero(64), zero(65)]))));
    const served = await g.publish();
    await expect(g.payer.prepare("paid", { request: paid, value: 3n }, served, g.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("reserves nothing when proving fails or the prover returns another statement", async () => {
    const f = await fixture([10n]);
    await expect(f.payer.prepare("shop", f.order, f.served, f.signed, async () => { throw new Error("prover crashed"); }))
      .rejects.toThrow("prover crashed");
    const changed: LocalProver = async task => ({ ...record(task), publicInputs: task.publicInputs.map((v, i) => i === 9 ? v + 1n : v) });
    await expect(f.payer.prepare("shop", f.order, f.served, f.signed, changed)).rejects.toMatchObject({ code: "INVALID" });
    const capsule: LocalProver = async task => ({ ...record(task), capsules: [new Uint8Array(89), ...task.capsules.slice(1)] });
    await expect(f.payer.prepare("shop", f.order, f.served, f.signed, capsule)).rejects.toMatchObject({ code: "INVALID" });
    const unverified: LocalProver = async task => ({ ...record(task), proof: b(1) });
    await expect(f.payer.prepare("shop", f.order, f.served, f.signed, unverified)).rejects.toMatchObject({ code: "INVALID" });
    const signed: LocalProver = async task => ({ ...record(task), authorization: b(3) });
    await expect(f.payer.prepare("shop", f.order, f.served, f.signed, signed)).rejects.toMatchObject({ code: "INVALID" });
    expect(f.payer.payment("shop")).toBeUndefined();
    expect((await f.payer.sync(f.served, f.signed)).holdings.map(h => h.status)).toEqual(["available"]);
    expect((await f.payer.prepare("shop", f.order, f.served, f.signed, prove)).status).toBe("prepared");
  });

  it("adopts the first saved record for concurrent exact preparations and refuses a competing alias", async () => {
    const f = await fixture([10n]);
    const [first, second] = await Promise.all([f.payer.prepare("shop", f.order, f.served, f.signed, prove),
      f.payer.prepare("shop", f.order, f.served, f.signed, prove)]);
    expect(second).toEqual(first);
    const g = await fixture([10n]), other = g.receiver.request("other", g.backing, 2n);
    const results = await Promise.allSettled([g.payer.prepare("one", g.order, g.served, g.signed, prove),
      g.payer.prepare("two", { request: other, value: 2n }, g.served, g.signed, prove)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  });

  it("keeps the first authenticated receipt and refuses one for another statement or operator", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    await expect(f.payer.submit("unknown", f.service)).rejects.toMatchObject({ code: "UNKNOWN" });
    const receipt = decodeReceipt(await f.j.submit(payment.record));
    const forged = (fields: Partial<Receipt>) => ({ submit: async () => ({ ...receipt, ...fields }) });
    await expect(f.payer.submit("shop", forged({ statementHash: b(1) }))).rejects.toMatchObject({ code: "INVALID" });
    await expect(f.payer.submit("shop", forged({ operator: issuer }))).rejects.toMatchObject({ code: "INVALID" });
    await expect(f.payer.submit("shop", forged({ signature: new Uint8Array(64) }))).rejects.toMatchObject({ code: "INVALID" });
    expect(f.payer.payment("shop")!.receipt).toBeUndefined();
    let sent: Uint8Array | undefined;
    await expect(f.payer.submit("shop", { submit: async bytes => { sent = bytes; await f.j.submit(bytes); throw new Error("reply lost"); } }))
      .rejects.toThrow("reply lost");
    expect(sent).toEqual(payment.record);
    expect(await f.payer.submit("shop", f.service)).toEqual(receipt);
    expect(await f.payer.submit("shop", { submit: async () => { throw new Error("not called"); } })).toEqual(receipt);
  });

  it("restores the exact pending record and reservation after restart and fences the old handle", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    const next = f.open("payer");
    await expect(f.payer.submit("shop", f.service)).rejects.toMatchObject({ code: "FENCED" });
    expect(next.payment("shop")).toEqual(payment);
    expect((await next.sync(f.served, f.signed)).holdings.map(h => h.status)).toEqual(["reserved", "available"]);
    const other = f.receiver.request("other", f.backing, 5n);
    const second = await next.prepare("other", { request: other, value: 5n }, f.served, f.signed, prove);
    expect(second.inputs).not.toEqual(payment.inputs);
  });

  it("marks a payment failed when another statement spends its input, and returns only unspent holdings", async () => {
    const f = await fixture([10n]);
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    // A restored copy of the same seed burns the reserved note elsewhere.
    const note = recoverCapsule(f.payer.recoverySeed(), domain, f.funding[0]!.cm, f.funding[0]!.capsule)!;
    const tree = new NoteTree(); tree.append(note.cm);
    const input = { note, anchor: tree.root(), path: tree.path(0n) };
    const change = prepareExactOutput(f.payer.recoverySeed(), domain, b(80), f.backing, 4n);
    await f.j.submit(encodeRecord(record(burnTask(f.context, 6n, [input, { ...input, note: prepareExactOutput(b(81), domain, b(82), f.backing, 0n) }], change))));
    const served = await f.publish();
    const view = await f.payer.sync(served, f.signed);
    expect(view.holdings.map(h => [h.cm, h.value, h.status])).toEqual([[change.cm, 4n, "available"]]);
    expect(f.payer.payment("shop")).toMatchObject({ status: "failed", final: undefined, inputs: payment.inputs });
    await expect(f.j.submit(payment.record)).rejects.toMatchObject({ code: "REFUSED" });
  });
});
