import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import { NoteTree } from "../src/pool/note-tree.js";
import { prepareExactOutput, recoverCapsule } from "../src/pool/v3/capsules.js";
import { decodeReceipt, encodeReceipt, receiptBytes, type Receipt } from "../src/pool/v3/commitments.js";
import { configurationHash, RELATIONS, adoptedConfiguration } from "../src/pool/v3/configuration.js";
import { decodeRecord, encodeRecord, statementHash, type Record } from "../src/pool/v3/records.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import { encodeRootTerms, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { authenticatePaymentRequest, encodePaymentRequest, paymentRequestDigest, readPaymentRequest, type PaymentRequest } from "../src/pool/v3/wallet-request.js";
import type { LocalProver, V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { authorizeIssue, burnTask, issueTask, spendTask, type ProofTask } from "../src/pool/v3/witness.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { encodeReplacement, replacementMessage, type Replacement } from "../src/venue-records.js";

// Stand-in proofs isolate payer custody; store-check.mjs proves the same flow
// under the candidate keys. v2 cases ported: selection, padding, reservation,
// exact and concurrent retry, proof failure, receipt checks and restart.
const b = (n: number) => new Uint8Array(32).fill(n);
const configuration = adoptedConfiguration();
const domain = configurationHash(configuration), issuerSecret = b(15), operatorSecret = b(16), successorSecret = b(18);
const issuer = ed25519.getPublicKey(issuerSecret), operator = ed25519.getPublicKey(operatorSecret), successorKey = ed25519.getPublicKey(successorSecret);
const label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const verifier = { verify: (kind: number, _inputs: readonly bigint[], proof: Uint8Array) => proof[0] === kind };
const record = (task: ProofTask): Record => ({ domain, kind: task.kind, publicInputs: task.publicInputs,
  proof: b(task.kind), authorization: new Uint8Array(), capsules: task.capsules });
const prove: LocalProver = async task => record(task);
const outputsOf = (bytes: Uint8Array) => decodeRecord(bytes).publicInputs.slice(9, 13);

describe("v3 payer custody over restored holdings", () => {
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
  async function fixture(funds: readonly bigint[] = [10n, 6n], readerVerifier: typeof verifier | { verify: (...args: Parameters<typeof verifier.verify>) => Promise<boolean> } = verifier,
    clauses: { silence?: { noCommitmentDuration: bigint; challengeWindow: bigint } } = {}) {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "v3-payer-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const terms = encodeRootTerms({ obligor: issuer, operator, replacementRule: issuer, configuration: domain, venue: venue.id,
      interval: 20n, payout: { thing: "payer units", quantumExponent: 0, perUnit: 1n }, ...clauses });
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) }, backing = rootTermsName(terms);
    const context = { domain, header: { domain, venue: venue.id, operator, sequence: 1n, entries: [{ backing, link: backing }] } };
    // This verifier declares no circuits, so each read replays in memory; the receiver, multi-backing and kept suites run on kept files.
    const reader = { venue, reference, verifier: readerVerifier };
    const open = (name: string) => { const wallet = new V3Wallet(join(directory, `${name}.db`), reader); wallets.push(wallet); return wallet; };
    const payer = open("payer"), receiver = open("receiver");
    const j = new V3OperatorJournal(join(directory, "journal.db"), { venue, reference, verifier, secret: operatorSecret });
    journals.push(j); await j.open("genesis", signed); await j.publish();
    const funding = funds.map((value, i) => payer.request(`fund-${i}`, backing, value));
    for (const request of funding) await j.submit(encodeRecord(authorizeIssue(record(issueTask(context, request)), issuerSecret)));
    let checkpoints = 0;
    const publish = async () => { await j.commit(`c${checkpoints++}`); await j.publish(); return (await j.package()).package; };
    const invoice = receiver.request("invoice", backing, 7n), fee = prepareExactOutput(b(22), domain, b(33), backing, 1n);
    const feeRequest: PaymentRequest = { domain, opening: fee.opening, cm: fee.cm, capsule: fee.capsule };
    const service = { submit: async (bytes: Uint8Array) => decodeReceipt(await j.submit(bytes)) };
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
    return { directory, venue, signed, backing, context, payer, receiver, open, j, publish, replace, takeover, funding, invoice, feeRequest, service,
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

  it("pays a request carried as bytes only after its independently obtained digest matches", async () => {
    const f = await fixture();
    // The receiver shows the digest on its authenticated channel; the frame may travel any private way.
    const frame = encodePaymentRequest(f.invoice), trusted = paymentRequestDigest(frame);
    const receiver = f.open("receiver");
    expect(encodePaymentRequest(receiver.request("invoice", f.backing, 7n))).toEqual(frame);
    // A substituted request, however well formed, fails against the receiver's digest before anything is reserved.
    const attacker = encodePaymentRequest(f.open("attacker").request("invoice", f.backing, 7n));
    expect(() => authenticatePaymentRequest(attacker, trusted)).toThrow(EncodingError);
    // Display terms from an unauthenticated read carry no capsule and cannot be paid.
    await expect(f.payer.prepare("shop", { ...f.order, request: readPaymentRequest(frame) as never }, f.served, f.signed, prove))
      .rejects.toThrow(EncodingError);
    const request = authenticatePaymentRequest(frame, trusted);
    expect(request).toEqual(f.invoice);
    await expect(f.payer.prepare("shop", { ...f.order, request, value: 8n }, f.served, f.signed, prove))
      .rejects.toThrow("invalid exact payment request");
    expect(f.payer.payment("shop")).toBeUndefined();
    const payment = await f.payer.prepare("shop", { ...f.order, request }, f.served, f.signed, prove);
    expect(outputsOf(payment.record)).toContain(f.invoice.cm);
    await f.payer.submit("shop", f.service);
    expect((await receiver.fulfill("invoice", await f.publish(), f.signed)).request).toEqual(f.invoice);
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
    // Multi-backing payments and cross-backing fees refuse: the agreed backing is the signed terms' own.
    const foreign = f.receiver.request("foreign", b(99), 7n);
    await expect(f.payer.prepare("foreign", { request: foreign, value: 7n }, f.served, f.signed, prove)).rejects.toThrow("invalid exact payment request");
    await expect(f.payer.prepare("foreign-fee", { ...f.order, fee: { request: f.receiver.request("foreign-fee", b(99), 1n), value: 1n } },
      f.served, f.signed, prove)).rejects.toThrow("invalid exact payment request");
    expect(f.payer.payment("foreign")).toBeUndefined(); expect(f.payer.payment("foreign-fee")).toBeUndefined();
    const saved = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    // Returned records are the caller's copies; the saved record is unchanged.
    const inputs = [...saved.inputs];
    saved.record.fill(0); (saved.inputs as bigint[]).length = 0;
    expect(f.payer.payment("shop")!.record).not.toEqual(saved.record);
    expect(f.payer.payment("shop")!.inputs).toEqual(inputs);
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
    // Two orders that both read the one note free: each proves, and the second to save finds it reserved.
    const g = await fixture([10n]), other = g.receiver.request("other", g.backing, 2n);
    let proving = 0, both = () => {};
    const together = new Promise<void>(resolve => { both = resolve; });
    const gated: LocalProver = async task => { if (++proving === 2) both(); await together; return record(task); };
    const results = await Promise.allSettled([g.payer.prepare("one", g.order, g.served, g.signed, gated),
      g.payer.prepare("two", { request: other, value: 2n }, g.served, g.signed, gated)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT", message: "an input is reserved by another payment or act" } });
    // A third order, read after that save, finds no note free to select.
    await expect(g.payer.prepare("three", { request: g.receiver.request("third", g.backing, 2n), value: 2n }, g.served, g.signed, prove))
      .rejects.toMatchObject({ code: "FUNDS" });
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
    // A reproof request resolves the failure from evidence without proving.
    expect(await f.payer.reprove("shop", served, f.signed, async () => { throw new Error("not called"); }))
      .toMatchObject({ status: "failed", final: undefined, inputs: payment.inputs, superseded: [] });
    const view = await f.payer.sync(served, f.signed);
    expect(view.holdings.map(h => [h.cm, h.value, h.status])).toEqual([[change.cm, 4n, "available"]]);
    expect(f.payer.payment("shop")).toMatchObject({ status: "failed", final: undefined, inputs: payment.inputs });
    await expect(f.j.submit(payment.record)).rejects.toMatchObject({ code: "REFUSED" });
  });

  it("answers an exact retry with the saved record when the winner reserved the only note meanwhile", async () => {
    // A wallet's reads take turns, so the first call is overtaken while it proves, or while it waits its turn to read.
    let release = () => {}, entered = () => {};
    const blocked = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture([10n]);
    const late = f.payer.prepare("shop", f.order, f.served, f.signed, async task => { entered(); await gate; return record(task); });
    await blocked;
    const winner = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    release();
    expect(await late).toEqual(winner);
    // Waiting its turn behind another read: the saved record answers before any selection or proof.
    const g = await fixture([10n]);
    const first = g.payer.prepare("shop", g.order, g.served, g.signed, prove);
    const queued = g.payer.prepare("shop", g.order, g.served, g.signed, async () => { throw new Error("a saved order is not proved again"); });
    expect(await queued).toEqual(await first);
  });

  it("refuses the same alias with another order, including a concurrent one", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    await expect(f.payer.prepare("shop", { request: f.invoice, value: 7n }, f.served, f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.payer.prepare("shop", { ...f.order, fee: { request: f.receiver.request("fee2", f.backing, 1n), value: 1n } },
      new Uint8Array(), f.signed, prove)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.payer.payment("shop")).toEqual(payment);
    const g = await fixture();
    const results = await Promise.allSettled([g.payer.prepare("race", g.order, g.served, g.signed, prove),
      g.payer.prepare("race", { request: g.invoice, value: 7n }, g.served, g.signed, prove)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
  });

  it("refuses an operator-signed receipt for the statement with another proof", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    const receipt = decodeReceipt(await f.j.submit(payment.record));
    const fields = { ...receipt, proofHash: b(1) }, other = { ...fields, signature: ed25519.sign(receiptBytes(fields), operatorSecret) };
    await expect(f.payer.submit("shop", { submit: async () => other })).rejects.toMatchObject({ code: "INVALID" });
    expect(f.payer.payment("shop")!.receipt).toBeUndefined();
    expect(encodeReceipt(await f.payer.submit("shop", f.service))).toEqual(encodeReceipt(receipt));
  });

  it("reconciles a payment final across operator takeover and pays from an imported note in the successor segment", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    await f.payer.submit("shop", f.service); await f.publish();
    await f.replace();
    // A's term has ended: a statement for its segment would be refused and stay reserved.
    const other = f.receiver.request("other", f.backing, 3n);
    await expect(f.payer.prepare("stale", { request: other, value: 3n }, (await f.j.package()).package, f.signed, prove))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.payer.payment("stale")).toBeUndefined();
    const successor = await f.takeover(), served = (await successor.package()).package;
    // The checkpointed statement is final in the imported history: reprove resolves it without proving.
    expect(await f.payer.reprove("shop", served, f.signed, async () => { throw new Error("not called"); }))
      .toMatchObject({ status: "final", superseded: [] });
    const view = await f.payer.sync(served, f.signed);
    expect(f.payer.payment("shop")).toMatchObject({ status: "final", inputs: payment.inputs });
    expect(view.holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"], [2n, "available"]]);
    expect((await f.receiver.fulfill("invoice", served, f.signed)).request).toEqual(f.invoice);
    const next = await f.payer.prepare("next", { request: other, value: 3n }, served, f.signed, prove);
    const receipt = await f.payer.submit("next", { submit: async bytes => decodeReceipt(await successor.submit(bytes)) });
    expect(receipt.operator).toEqual(successorKey);
    await successor.commit("next"); await successor.publish();
    await f.payer.sync((await successor.package()).package, f.signed);
    expect(f.payer.payment("next")).toMatchObject({ status: "final", inputs: next.inputs });
  });

  it("reproves a lapsed pending payment in the successor segment with the same nullifiers, outputs and capsules", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    // A admits the statement but its term ends before any checkpoint includes it.
    const receipt = await f.payer.submit("shop", f.service);
    await f.replace();
    const pending = f.payer.payment("shop")!;
    await expect(f.payer.reprove("shop", (await f.j.package()).package, f.signed, prove)).rejects
      .toMatchObject({ code: "CONFLICT", message: "the canonical segment's operator term has ended" });
    expect(f.payer.payment("shop")).toEqual(pending);
    const successor = await f.takeover(), served = (await successor.package()).package;
    await f.payer.sync(served, f.signed);
    expect(f.payer.payment("shop")).toEqual(pending);
    const changed: LocalProver = async task => ({ ...record(task), publicInputs: task.publicInputs.map((v, i) => i === 9 ? v + 1n : v) });
    await expect(f.payer.reprove("shop", served, f.signed, changed)).rejects.toMatchObject({ code: "INVALID" });
    expect(f.payer.payment("shop")).toEqual(pending);
    const reproven = await f.payer.reprove("shop", served, f.signed, prove);
    const before = decodeRecord(payment.record), after = decodeRecord(reproven.record);
    // Nullifiers, outputs, delivery hash and capsules are the saved ones; segment and anchors are the successor's.
    expect(after.publicInputs.slice(7)).toEqual(before.publicInputs.slice(7));
    expect(after.capsules).toEqual(before.capsules);
    expect(after.publicInputs.slice(2, 4)).not.toEqual(before.publicInputs.slice(2, 4));
    expect(reproven).toMatchObject({ status: "prepared", receipt: undefined, inputs: payment.inputs, payee: payment.payee, fee: payment.fee,
      superseded: [{ record: payment.record, receipt }] });
    expect(reproven.statement).not.toEqual(payment.statement);
    expect(await f.payer.prepare("shop", f.order, new Uint8Array(), f.signed, undefined as never)).toEqual(reproven);
    expect(await f.payer.reprove("shop", served, f.signed, prove)).toEqual(reproven);
    expect((await f.payer.sync(served, f.signed)).holdings.map(h => [h.value, h.status])).toEqual([[10n, "reserved"], [6n, "available"]]);
    const next = await f.payer.submit("shop", { submit: async bytes => decodeReceipt(await successor.submit(bytes)) });
    expect(next).toMatchObject({ operator: successorKey, statementHash: reproven.statement });
    await successor.commit("reproven"); await successor.publish();
    const final = (await successor.package()).package, view = await f.payer.sync(final, f.signed);
    expect(f.payer.payment("shop")).toMatchObject({ status: "final", receipt: next, superseded: [{ record: payment.record, receipt }] });
    expect(view.holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"], [2n, "available"]]);
    expect((await f.receiver.fulfill("invoice", final, f.signed)).request).toEqual(f.invoice);
    expect(await f.payer.reprove("shop", final, f.signed, async () => { throw new Error("not called"); })).toEqual(f.payer.payment("shop"));
  });

  it("keeps no receipt for a record a reproof replaced during submission", async () => {
    const f = await fixture();
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    const stale = decodeReceipt(await f.j.submit(payment.record));
    const early = f.venue.export(), earlyPackage = (await f.j.package()).package;
    await f.replace();
    const served = (await (await f.takeover()).package()).package;
    const racing = { submit: async () => { await f.payer.reprove("shop", served, f.signed, prove); return stale; } };
    await expect(f.payer.submit("shop", racing)).rejects.toMatchObject({ code: "CONFLICT" });
    const reproven = f.payer.payment("shop")!;
    expect(reproven).toMatchObject({ receipt: undefined, superseded: [{ record: payment.record, receipt: stale }] });
    // At an older index A is still canonical and admitting: that view cannot move the record back.
    const lagging = new V3Wallet(join(f.directory, "payer.db"), { venue: FixtureVenue.from(early), reference, verifier });
    wallets.push(lagging);
    await expect(lagging.reprove("shop", earlyPackage, f.signed, prove)).rejects.toMatchObject({ code: "CHANGED_VIEW" });
    expect(lagging.payment("shop")).toEqual(reproven);
  });

  it("refuses preparation while the silence clock closes admission and reproves into the returned segment", async () => {
    const f = await fixture([10n, 6n], verifier, { silence: { noCommitmentDuration: 4n, challengeWindow: 5n } });
    const payment = await f.payer.prepare("shop", f.order, f.served, f.signed, prove);
    await f.payer.submit("shop", f.service);
    const other = f.receiver.request("other", f.backing, 3n), late = { request: other, value: 3n };
    f.venue.advance(5n);
    // The operator's horizon reaches silence: it would refuse, so nothing is proven or reserved.
    await expect(f.payer.prepare("late", late, f.served, f.signed, prove)).rejects.toMatchObject({ code: "SILENCE" });
    f.venue.advance(7n);
    await expect(f.payer.prepare("late", late, f.served, f.signed, prove)).rejects.toMatchObject({ code: "SILENCE" });
    expect(f.payer.payment("late")).toBeUndefined();
    await expect(f.payer.reprove("shop", (await f.j.package()).package, f.signed, prove)).rejects.toMatchObject({ code: "SILENCE" });
    expect(f.payer.payment("shop")!.record).toEqual(payment.record);
    await f.j.return("returned"); await f.j.publish(); await f.j.adopt();
    const served = (await f.j.package()).package;
    await f.payer.sync(served, f.signed);
    expect(f.payer.payment("shop")!.status).toBe("prepared");
    const reproven = await f.payer.reprove("shop", served, f.signed, prove);
    expect(decodeRecord(reproven.record).publicInputs.slice(7)).toEqual(decodeRecord(payment.record).publicInputs.slice(7));
    await f.payer.submit("shop", f.service);
    const final = await f.publish();
    await f.payer.sync(final, f.signed);
    expect(f.payer.payment("shop")).toMatchObject({ status: "final", superseded: [{ record: payment.record }] });
    expect((await f.payer.prepare("late", late, final, f.signed, prove)).status).toBe("prepared");
    // A returned segment whose own horizon reaches silence refuses the reproof and keeps the record.
    const g = await fixture([10n, 6n], verifier, { silence: { noCommitmentDuration: 4n, challengeWindow: 5n } });
    const pending = await g.payer.prepare("shop", g.order, g.served, g.signed, prove);
    g.venue.advance(7n); await g.j.return("returned"); await g.j.publish(); await g.j.adopt();
    const returned = (await g.j.package()).package;
    g.venue.advance(g.venue.witnessedIndex() + 3n);
    await expect(g.payer.reprove("shop", returned, g.signed, prove)).rejects.toMatchObject({ code: "SILENCE" });
    expect(g.payer.payment("shop")).toEqual(pending);
  });

  it("refuses a database from the earlier receiver-only profile instead of replacing its seed", async () => {
    const f = await fixture(), { DatabaseSync } = await import("node:sqlite"), path = join(f.directory, "old.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE receiver_identity (id INTEGER PRIMARY KEY, seed BLOB NOT NULL) STRICT;"); db.close();
    expect(() => f.open("old")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    // The first payer profile kept no output openings, so it cannot reprove.
    f.open("first").close();
    const first = new DatabaseSync(join(f.directory, "first.db"));
    first.exec("UPDATE wallet_identity SET profile='moe/wallet/v3/1'"); first.close();
    expect(() => f.open("first")).toThrow(expect.objectContaining({ code: "CONFLICT", message: "wallet database has another profile" }));
  });
});
