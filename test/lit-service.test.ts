import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EncodingError } from "../src/bytes.js";
import { decodeReceipt, encodeReceipt, receiptBytes } from "../src/lit/commitments.js";
import { litConfigHash } from "../src/lit/configuration.js";
import { LIT } from "../src/lit/construction.js";
import { encodeRecord, statementBytes, statementHash, type Statement } from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { decodeLitPackage, decodeLitSegmentHeader, decodeLitTrail, litSegmentIdentity } from "../src/lit/transport.js";
import { POOL_V3, type KeyedReceipt } from "../src/pool/v3/construction.js";
import { encodeReceipt as encodeV3Receipt, receiptBytes as v3ReceiptBytes } from "../src/pool/v3/commitments.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { encodeRecord as encodeV3Record } from "../src/pool/v3/records.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import { parseV3ServiceCommand, replyFromReceipt, V3_SERVICE_PROFILE } from "../src/pool/v3/service-wire.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import type { V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";
import { limbsOf } from "../src/pool/field.js";
import { adoptedDomain } from "../src/pool/v3/configuration.js";

// The operator's local service, its wire and its client for a lit journal (slice 14 M14g3): one profile, the records,
// receipts and packages read through the journal's construction and the construction the client expects.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const DOMAIN = litConfigHash(), label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(15), OPERATOR = b(16), RULE = b(19);
const expected = (operator = pub(OPERATOR)) => ({ operator, reference: { ...reference, label: label.slice() }, construction: LIT });

describe("the operator's service for a lit scope", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let createV3Service: typeof import("../src/pool/v3/service-http.js").createV3Service;
  const journals: Journal[] = [], wallets: Wallet[] = [], servers: Server[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    ({ createV3Service } = await import("../src/pool/v3/service-http.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); })));
    for (const w of wallets.splice(0)) { try { w.close(); } catch { /* closed */ } }
    for (const j of journals.splice(0)) { try { j.close(); } catch { /* closed */ } }
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

  async function fixture() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "lit-service-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator: pub(OPERATOR), interval: 30n,
      payout: { thing: "lit service test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(RULE) };
    const terms = encodeLitTerms(fields), backing = litTermsName(terms);
    const signed = { terms, signature: ed25519.sign(litTermsSignatureMessage(terms), K) };
    const j = new V3OperatorJournal(join(directory, "journal.db"), { secret: OPERATOR, venue, reference, construction: LIT }); journals.push(j);
    await j.open("genesis", signed); await j.publish();
    const headers = decodeLitPackage((await j.package()).package).filter(item => item.kind === 6)
      .map(item => decodeLitSegmentHeader(decodeLitTrail(item.payload).header));
    const segment = litSegmentIdentity(headers[0]!);
    const url = await listen(createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN }));
    const client = new V3ServiceClient(url, TOKEN, expected(), ADMIN);
    let nonce = 0;
    /** K's issue of `quantity` to `owner` (lit-v1 §3 kind 1). */
    const issue = (owner: Uint8Array, quantity: bigint): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 1, segment, backing, quantity, owner, nonce: b(150 + nonce++) };
      return encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), K) });
    };
    const open = (name: string): Wallet => {
      const w = new V3Wallet(join(directory, `${name}.db`), { construction: LIT, venue, reference }); wallets.push(w); return w;
    };
    return { j, url, client, venue, backing, signed, segment, issue, open, directory };
  }

  it("admits a lit record through the client, which reads lit-v1's receipt, and signs and publishes commitments", async () => {
    const f = await fixture(), record = f.issue(pub(b(40)), 7n);
    const receipt = await f.client.submit(record) as KeyedReceipt;
    // Lit-v1 §5's receipt: the record's segment and statement, no scope root or proof digest, signed by the operator.
    expect(receipt).toMatchObject({ position: 1n, segment: f.segment, operator: pub(OPERATOR) });
    expect(receipt).not.toHaveProperty("scopeRoot"); expect(receipt).not.toHaveProperty("proofHash");
    expect(encodeReceipt(receipt).length).toBe(290);
    // An exact replay answers with the original receipt.
    expect(await f.client.submit(record)).toEqual(receipt);
    expect((await f.client.commit("c1")).sequence).toBe(2n);
    expect((await f.client.publish()).sequence).toBe(2n);
    // The served evidence is the lit construction's package, carried by the one served frame.
    const whole = await f.client.package(f.backing);
    expect(whole.selection.domain).toEqual(DOMAIN); expect(whole.selection.sequence).toBe(2n);
    expect(decodeLitPackage(whole.package).some(item => item.kind === 6)).toBe(true);
    const evidence = new EvidenceStore(":memory:", { construction: LIT });
    try { expect((await f.client.sync(f.backing, evidence)).selection.sequence).toBe(2n); } finally { evidence.close(); }
  });

  it("refuses records, replies and evidence of the other construction on each side", async () => {
    const f = await fixture(), record = f.issue(pub(b(41)), 3n);
    // A client expecting pool-v3 sends no lit record, and reads no lit evidence as its own.
    const v3 = new V3ServiceClient(f.url, TOKEN, { operator: pub(OPERATOR), reference });
    await expect(v3.submit(record)).rejects.toBeInstanceOf(EncodingError);
    await expect(v3.package(f.backing)).rejects.toThrow("wrong service package context");
    // The lit service reads a pool-v3 record as no record of its construction.
    const v3Record = encodeV3Record({ domain: adoptedDomain(), kind: 5, publicInputs: [...limbsOf(adoptedDomain()), ...limbsOf(b(3)), 7n, ...limbsOf(b(4))],
      proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] });
    const raw = await fetch(new URL("/commands", f.url), { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: bytesToHex(v3Record) }) });
    expect(raw.status).toBe(400); expect(await raw.json()).toEqual({ code: "INVALID" });
    expect(() => parseV3ServiceCommand({ version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: bytesToHex(record) })).toThrow(EncodingError);
    expect(parseV3ServiceCommand({ version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: bytesToHex(record) }, LIT).kind).toBe("submit");
    // A lit request (kind 7) is no segment admission: refused on the wire and by the client before any exchange.
    const request: Statement = { domain: DOMAIN, kind: 7, input: { backing: f.backing, value: 1n, owner: pub(b(42)), rho: b(43) }, refresh: 1n };
    const requestRecord = encodeRecord({ statement: request, authorization: ed25519.sign(statementBytes(request), b(42)) });
    expect(() => parseV3ServiceCommand({ version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: bytesToHex(requestRecord) }, LIT))
      .toThrow("a request is not a segment admission");
    await expect(f.client.submit(requestRecord)).rejects.toThrow("wrong submission domain or kind");
    // A client of another operator refuses the service's commitments and evidence.
    const other = new V3ServiceClient(f.url, TOKEN, expected(pub(b(44))), ADMIN);
    await expect(other.commit("c1")).rejects.toThrow("wrong commitment authority");
    await expect(other.package(f.backing)).rejects.toThrow("wrong service package context");
  });

  it("binds a lit receipt to the submitted statement, its segment and the expected operator", async () => {
    const f = await fixture(), record = f.issue(pub(b(45)), 5n), other = f.issue(pub(b(46)), 5n);
    const statement = (bytes: Uint8Array) => statementHash(LIT.decode(bytes).statement);
    const lit = (overrides: Partial<{ segment: Uint8Array; statementHash: Uint8Array; domain: Uint8Array }> = {}, signer = OPERATOR) => {
      const fields = { domain: DOMAIN, segment: f.segment, position: 1n, statementHash: statement(record), historyHash: b(50),
        signatureHash: b(51), after: 1n, ...overrides };
      return encodeReceipt({ ...fields, operator: pub(signer), signature: ed25519.sign(receiptBytes(fields), signer) });
    };
    const answering = (receipt: Uint8Array) => listen(createServer((request, response) => {
      request.resume(); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(replyFromReceipt(receipt, LIT)));
    }));
    expect((await new V3ServiceClient(await answering(lit()), TOKEN, expected()).submit(record)).position).toBe(1n);
    for (const receipt of [lit({ statementHash: statement(other) }), lit({ segment: b(52) }), lit({ domain: b(53) }), lit({}, b(54))]) {
      await expect(new V3ServiceClient(await answering(receipt), TOKEN, expected()).submit(record))
        .rejects.toThrow("receipt does not authenticate the submitted statement");
    }
    // Each construction's codec reads only its own receipts, and verifies one under its own authority's shape.
    const v3Fields = { domain: DOMAIN, segment: f.segment, scopeRoot: 7n, position: 1n, statementHash: statement(record), historyHash: b(50),
      proofHash: b(55), signatureHash: b(51), after: 1n };
    const v3Receipt = encodeV3Receipt({ ...v3Fields, operator: pub(OPERATOR), signature: ed25519.sign(v3ReceiptBytes(v3Fields), OPERATOR) });
    expect(() => replyFromReceipt(v3Receipt, LIT)).toThrow(EncodingError);
    expect(() => replyFromReceipt(lit())).toThrow(EncodingError);
    expect(() => replyFromReceipt(lit().subarray(0, 289), LIT)).toThrow(EncodingError);
    const authority = { domain: DOMAIN, segment: f.segment, operator: pub(OPERATOR) };
    expect(LIT.journal.receipts.verify({ ...authority, scopeRoot: undefined }, decodeReceipt(lit()))).toBe(true);
    expect(LIT.journal.receipts.verify({ ...authority, scopeRoot: 0n }, decodeReceipt(lit()))).toBe(false);
    const v3 = POOL_V3.journal.receipts;
    expect(v3.verify({ ...authority, scopeRoot: 7n }, v3.decode(v3Receipt))).toBe(true);
    expect(v3.verify({ ...authority, scopeRoot: undefined }, v3.decode(v3Receipt))).toBe(false);
  });

  it("serves a lit wallet: it submits, syncs its evidence and is credited through the client", async () => {
    const f = await fixture(), payer = f.open("payer"), payee = f.open("payee");
    const fund = payer.keyedRequest("fund", f.backing, 10n);
    await f.client.submit(f.issue(fund.owner, 10n)); await f.client.commit("c1"); await f.client.publish();
    const read = async (wallet: Wallet) => wallet.sync((await wallet.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    expect((await read(payer)).holdings.map(h => h.value)).toEqual([10n]);
    const invoice = payee.keyedRequest("invoice", f.backing, 4n);
    const payment = await payer.prepare("shop", { request: invoice, value: 4n },
      (await payer.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    // The wallet's one receipt check reads the client's lit receipt; an exact retry keeps it.
    // A receipt the operator signed for the statement under other signatures, or in another segment, is refused.
    const saved = LIT.decode(payment.record), view = LIT.view(saved, () => undefined), digests = LIT.reader.digests(payment.record);
    const forged = (fields: Partial<KeyedReceipt>) => {
      const r = { domain: DOMAIN, segment: view.segment, position: 2n, statementHash: view.identity, historyHash: b(60),
        signatureHash: digests.signatureHash, after: 1n, ...fields };
      return { ...r, operator: pub(OPERATOR), signature: ed25519.sign(receiptBytes(r), OPERATOR) };
    };
    for (const answer of [forged({ signatureHash: b(61) }), forged({ segment: b(62) }), { ...forged({}), signature: new Uint8Array(64) }]) {
      await expect(payer.submit("shop", { submit: async () => answer })).rejects.toMatchObject({ code: "INVALID" });
    }
    await expect(payer.submit("shop", { submit: async () => ({ position: 2n }) as unknown as KeyedReceipt })).rejects.toMatchObject({ code: "INVALID" });
    expect(payer.payment("shop")!.receipt).toBeUndefined();
    const receipt = await payer.submit("shop", f.client);
    expect(receipt.position).toBe(2n);
    expect(await payer.submit("shop", f.client)).toEqual(receipt);
    await f.client.commit("c2"); await f.client.publish();
    expect((await read(payer)).holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"]]);
    expect(payer.payment("shop")).toMatchObject({ status: "final", payee: payment.payee });
    const credited = await payee.keyedFulfill("invoice", (await payee.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    expect(credited.cm).toBe(payment.payee);
  });
});
