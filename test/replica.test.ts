import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { litConfigHash } from "../src/lit/configuration.js";
import { LIT } from "../src/lit/construction.js";
import { encodeRecord, statementBytes, type Statement } from "../src/lit/records.js";
import { encodeLitTerms, litTermsName, litTermsSignatureMessage, type LitRootTerms } from "../src/lit/terms.js";
import { decodeLitPackage, decodeLitSegmentHeader, decodeLitTrail, encodeLitTrail, litSegmentIdentity } from "../src/lit/transport.js";
import { EncodingError } from "../src/bytes.js";
import { EvidenceStore, type EvidencePart } from "../src/pool/v3/evidence-store.js";
import { EvidenceRefusal } from "../src/pool/v3/refusals.js";
import { V3ServiceClient, V3ServiceClientError } from "../src/pool/v3/service-client.js";
import type { V3OperatorJournal as Journal } from "../src/pool/v3/store.js";
import type { RepairRecord, Skipped, Synced } from "../src/cli/reader.js";
import type { V3Wallet as Wallet } from "../src/pool/v3/wallet-store.js";
import { FixtureVenue, LOCAL_REFERENCE } from "../src/record-venue.js";

// Slice 12 M12b: a replica's kept, verified evidence served through the one wire, with no credential. Its index is its
// own: what it kept is served after a reader's mark once the replica serves a selection taken after it.

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = (secret: Uint8Array): Uint8Array => ed25519.getPublicKey(secret);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const DOMAIN = litConfigHash(), label = b(12), lag = 2n, reference = { context: LOCAL_REFERENCE, label, lag } as const;
const K = b(15), OPERATOR = b(16), RULE = b(19);
const expected = () => ({ operator: pub(OPERATOR), reference: { ...reference, label: label.slice() }, construction: LIT });

describe("a replica of a lit operator's evidence", () => {
  let V3OperatorJournal: typeof import("../src/pool/v3/store.js").V3OperatorJournal;
  let V3Wallet: typeof import("../src/pool/v3/wallet-store.js").V3Wallet;
  let service: typeof import("../src/pool/v3/service-http.js");
  let V3Replica: typeof import("../src/pool/v3/replica.js").V3Replica;
  let passedOver: typeof import("../src/cli/reader.js").passedOver;
  let readRepaired: typeof import("../src/cli/reader.js").readRepaired;
  const closing: { close(): void }[] = [], servers: Server[] = [], directories: string[] = [], scratch = resolve("scratch");
  beforeAll(async () => {
    ({ V3OperatorJournal } = await import("../src/pool/v3/store.js"));
    ({ V3Wallet } = await import("../src/pool/v3/wallet-store.js"));
    service = await import("../src/pool/v3/service-http.js");
    ({ V3Replica } = await import("../src/pool/v3/replica.js"));
    ({ passedOver, readRepaired } = await import("../src/cli/reader.js"));
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

  async function fixture() {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, "replica-test-")); directories.push(directory);
    const venue = FixtureVenue.reference(label, lag);
    const fields: LitRootTerms = { configuration: DOMAIN, venue: venue.id, obligor: pub(K), operator: pub(OPERATOR), interval: 30n,
      payout: { thing: "replica test", quantumExponent: 0, perUnit: 1n }, replacementRule: pub(RULE) };
    const terms = encodeLitTerms(fields), backing = litTermsName(terms);
    const signed = { terms, signature: ed25519.sign(litTermsSignatureMessage(terms), K) };
    const j: Journal = new V3OperatorJournal(join(directory, "journal.db"), { secret: OPERATOR, venue, reference, construction: LIT }); closing.push(j);
    await j.open("genesis", signed); await j.publish();
    const headers = decodeLitPackage((await j.package()).package).filter(item => item.kind === 6)
      .map(item => decodeLitSegmentHeader(decodeLitTrail(item.payload).header));
    const segment = litSegmentIdentity(headers[0]!);
    const operator = new V3ServiceClient(await listen(service.createV3Service(j, { walletToken: TOKEN, adminToken: ADMIN })), TOKEN, expected(), ADMIN);
    // The replica's own file, opened shared, its index, and its credential-free listener; each request's credential seen.
    const path = join(directory, "replica.db"), store = new EvidenceStore(path, { construction: LIT, shared: true }); closing.push(store);
    const replica = new V3Replica(path, store, venue.id), server = service.createV3EvidenceService(replica), seen: (string | undefined)[] = [];
    server.on("request", request => { seen.push(request.headers.authorization); });
    const url = await listen(server), client = new V3ServiceClient(url, undefined, expected());
    let nonce = 0;
    const issue = (owner: Uint8Array, quantity: bigint): Uint8Array => {
      const statement: Statement = { domain: DOMAIN, kind: 1, segment, backing, quantity, owner, nonce: b(150 + nonce++) };
      return encodeRecord({ statement, authorization: ed25519.sign(statementBytes(statement), K) });
    };
    const open = (name: string): Wallet => {
      const w = new V3Wallet(join(directory, `${name}.db`), { construction: LIT, venue, reference }); closing.push(w); return w;
    };
    /** The replica's round: sync from the operator, then serve the selection (its read is the command's, M12b). */
    const mirror = async () => { const served = await operator.sync(backing, store); expect(replica.keep(served)).toBe(true); return served; };
    const commit = async (id: string) => { await operator.commit(id); return operator.publish(); };
    /** A longer trail of the genuine segment that diverges at its first record, as a hostile supplier could send. */
    const fork = async () => {
      const t = decodeLitTrail(decodeLitPackage((await j.package()).package).find(item => item.kind === 6)!.payload);
      return encodeLitTrail({ header: t.header, terms: t.terms, records: Array.from({ length: t.records.length + 3 }, () => issue(pub(b(77)), 1n)) });
    };
    return { j, venue, backing, signed, operator, store, path, replica, url, client, seen, issue, open, mirror, commit, fork, directory };
  }
  /** The items of each package part of a served stream, and the trails it carries. */
  const counted = async (parts: AsyncIterable<EvidencePart> | Iterable<EvidencePart>) => {
    let items = 0, trails = 0;
    for await (const part of parts) {
      if ("package" in part) items += decodeLitPackage(part.package).length;
      else { trails++; for await (const _ of part.trail.chunks) { /* drained */ } }
    }
    return { items, trails };
  };

  it("serves a wallet the operator's evidence with no credential, and after its mark only what it kept since", async () => {
    const f = await fixture(), payer = f.open("payer"), payee = f.open("payee");
    const fund = payer.keyedRequest("fund", f.backing, 10n);
    await f.operator.submit(f.issue(fund.owner, 10n));
    const first = (await f.commit("c1")).sequence;
    await f.mirror();
    const read = async (wallet: Wallet) => wallet.sync((await wallet.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    expect((await read(payer)).holdings.map(h => h.value)).toEqual([10n]);
    // A replica takes no credential and its client sends none.
    expect(f.seen).toEqual([undefined]);
    const invoice = payee.keyedRequest("invoice", f.backing, 4n);
    const payment = await payer.prepare("shop", { request: invoice, value: 4n }, (await payer.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    await payer.submit("shop", f.operator);
    const second = (await f.commit("c2")).sequence;
    // Taken but not yet served: the replica serves its earlier selection, and nothing after it.
    await f.operator.sync(f.backing, f.store);
    expect((await f.replica.serve(f.backing, first)).selection.sequence).toBe(first);
    expect(await counted((await f.replica.serve(f.backing, first)).parts)).toEqual({ items: 0, trails: 0 });
    await f.mirror();
    // After a reader's mark, only what the replica kept since: fewer items than from nothing.
    const whole = await counted((await f.replica.serve(f.backing, 0n)).parts), after = await counted((await f.replica.serve(f.backing, first)).parts);
    expect(after.trails).toBe(1); expect(after.items).toBeGreaterThan(0); expect(after.items).toBeLessThan(whole.items);
    expect((await read(payer)).holdings.map(h => [h.value, h.status])).toEqual([[6n, "available"]]);
    expect(payer.payment("shop")).toMatchObject({ status: "final" });
    // A wallet that never synced reads from the replica alone, from nothing.
    const credited = await payee.keyedFulfill("invoice", (await payee.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    expect(credited.cm).toBe(payment.payee);
    expect((await f.replica.serve(f.backing, 0n)).selection.sequence).toBe(second);
    expect(f.seen.every(header => header === undefined)).toBe(true);
  });

  it("serves only its own selections, rising, each operator's index apart, and refuses everything but the evidence route", async () => {
    const f = await fixture();
    await f.operator.submit(f.issue(pub(b(40)), 3n));
    await f.commit("c1");
    const served = await f.mirror();
    // A lower selection of the same operator is not served: a reader served through the higher would learn nothing.
    const earlier = { ...served, selection: { ...served.selection, sequence: served.selection.sequence - 1n } };
    expect(f.replica.keep(earlier)).toBe(false);
    expect(f.replica.selection(f.backing)!.selection.sequence).toBe(served.selection.sequence);
    // Parts kept from another operator's evidence wait for that operator's own served selection.
    const other = pub(b(41)), parts = (await f.j.serve(f.backing, 0n)).parts;
    expect(await f.store.take(parts, other)).toBe(true);
    expect(await counted(EvidenceStore.served(f.path, LIT, other, 5n, 0n))).toEqual({ items: 0, trails: 0 });
    f.store.keepSelection(b(42), served.package, other, 5n);
    expect((await counted(EvidenceStore.served(f.path, LIT, other, 5n, 0n))).items).toBeGreaterThan(0);
    // The served reads come back with the file.
    const again = new V3Replica(f.path, f.store, f.venue.id);
    expect(again.selection(f.backing)!.selection.sequence).toBe(served.selection.sequence);
    // No command, no other route, no backing it does not serve.
    const post = await fetch(new URL("/commands", f.url), { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }) });
    expect([post.status, await post.json()]).toEqual([404, { code: "NOT_FOUND" }]);
    const unknown = await fetch(new URL(`/evidence?backing=${bytesToHex(b(43))}&after=0`, f.url));
    expect([unknown.status, await unknown.json()]).toEqual([409, { code: "STALE" }]);
    // A credential sent anyway is ignored.
    const credentialed = await fetch(new URL(`/evidence?backing=${bytesToHex(f.backing)}&after=0`, f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(credentialed.status).toBe(200); await credentialed.arrayBuffer();
  });

  it("files what a source ahead sent under a later selection only, never one a reader already holds", async () => {
    const f = await fixture(), payer = f.open("payer");
    await f.operator.submit(f.issue(payer.keyedRequest("fund", f.backing, 10n).owner, 10n));
    await f.commit("c1");
    const s1 = await f.mirror();
    const read = async (wallet: Wallet) => wallet.sync((await wallet.supply(store => f.client.sync(f.backing, store))).package, f.signed);
    expect((await read(payer)).holdings.map(h => h.value)).toEqual([10n]);
    // The replica takes c2 from the operator before its read finds c2 canonical, then a round reads s1 final again (the
    // operator not answering, another replica at s1): s1 is served still, and c2's objects wait for a higher selection.
    await f.operator.submit(f.issue(payer.keyedRequest("fund2", f.backing, 5n).owner, 5n));
    await f.commit("c2");
    const s2 = await f.operator.sync(f.backing, f.store);
    expect(f.replica.keep(s1)).toBe(true);
    expect(await counted((await f.replica.serve(f.backing, s1.selection.sequence)).parts)).toEqual({ items: 0, trails: 0 });
    expect(f.replica.keep(s2)).toBe(true);
    expect((await read(payer)).holdings.map(h => h.value).sort()).toEqual([10n, 5n].sort());
    // A lower selection than the highest served is refused.
    expect(f.replica.keep(s1)).toBe(false);
  });

  it("serves the trail its read used beside a longer fork a supplier sent", async () => {
    const f = await fixture(), payer = f.open("payer");
    await f.operator.submit(f.issue(payer.keyedRequest("fund", f.backing, 10n).owner, 10n));
    await f.commit("c1");
    const served = await f.operator.sync(f.backing, f.store), bytes = await f.fork();
    expect(await f.store.take([{ trail: { size: BigInt(bytes.length), chunks: [bytes] } }], pub(OPERATOR))).toBe(true);
    expect(f.replica.keep(served)).toBe(true);
    expect((await counted((await f.replica.serve(f.backing, 0n)).parts)).trails).toBe(2);
    expect((await payer.sync((await payer.supply(store => f.client.sync(f.backing, store))).package, f.signed)).holdings.map(h => h.value)).toEqual([10n]);
  });

  it("ends a stream at a damaged object, so the reader keeps its mark", async () => {
    const f = await fixture();
    await f.operator.submit(f.issue(pub(b(44)), 2n));
    await f.commit("c1"); await f.mirror();
    const db = new DatabaseSync(f.path); db.exec("UPDATE object SET payload = x'00' WHERE kind = 4"); db.close();
    await expect(counted((await f.replica.serve(f.backing, 0n)).parts)).rejects.toMatchObject({ status: "unresolved-evidence" });
    const reader = new EvidenceStore(":memory:", { construction: LIT }); closing.push(reader);
    // The stream ends short of its end mark: the connection is cut, which a holder reads as a source that did not answer.
    await expect(f.client.sync(f.backing, reader)).rejects.toThrow(/^(fetch failed|terminated)$/);
    const source = Buffer.concat([DOMAIN, f.venue.id, pub(OPERATOR), Buffer.from(f.url)]);
    expect(reader.suppliedThrough(source)).toBe(0n);
  });

  it("indexes a file kept before the index from a whole sync, and passes over a replica's refusal but not the holder's proxy", async () => {
    const f = await fixture();
    const path = join(f.directory, "earlier.db"), earlier = new EvidenceStore(path, { construction: LIT });
    await f.operator.sync(f.backing, earlier);
    const source = Buffer.concat([DOMAIN, f.venue.id, pub(OPERATOR)]);
    expect(earlier.suppliedThrough(source)).toBeGreaterThan(0n);
    earlier.close();
    const shared = new EvidenceStore(path, { construction: LIT, shared: true }); closing.push(shared);
    expect(shared.suppliedThrough(source)).toBe(0n);
    // A replica's reply naming PROXY is its refusal; the holder's own proxy that is not there stops the read.
    expect(passedOver(new V3ServiceClientError(400, "PROXY", "service request failed"))).toBe("PROXY");
    expect(passedOver(new V3ServiceClientError(0, "PROXY", "the proxy did not answer"))).toBeUndefined();
    expect(passedOver(new V3ServiceClientError(409, "STALE", "service request failed"))).toBe("STALE");
    expect(passedOver(new TypeError("fetch failed"))).toBe("UNAVAILABLE");
    expect(passedOver(new EncodingError("truncated served evidence"))).toBe("INVALID");
    expect(passedOver(new EvidenceRefusal("unresolved-evidence"))).toBe("EVIDENCE");
    expect(passedOver(new Error("a programming failure"))).toBeUndefined();
  });

  it("repairs a read a source left unresolved past its mark: from nothing, then from the next source (audit 30 (au))", async () => {
    const f = await fixture(), payer = f.open("payer");
    await f.operator.submit(f.issue(payer.keyedRequest("fund", f.backing, 10n).owner, 10n));
    await f.commit("c1"); await f.mirror();
    // A source that sends the selection whole but leaves out an earlier dependency (here the segment's terms field,
    // which the selection's directory, snapshots and trails do not include), modelled by dropping it from the
    // wallet's file after each of that source's answers. Its mark moves past what it withheld.
    const evidenceFile = join(f.directory, "payer.db.evidence");
    const withhold = () => { const db = new DatabaseSync(evidenceFile); db.exec("DELETE FROM segment_terms"); db.close(); };
    const asked: string[] = [];
    const sources = [{ url: "operator", client: f.operator, withholds: Infinity }, { url: f.url, client: f.client, withholds: 0 }];
    type Supplied = Synced | { readonly skipped: readonly Skipped[] };
    const supply = (withheld: Map<string, number>) => async (options: { readonly full: (url: string) => boolean; readonly except: readonly string[] }): Promise<Supplied> => {
      const source = sources.find(s => !options.except.includes(s.url));
      if (source === undefined) return { skipped: [] };
      const full = options.full(source.url);
      asked.push(`${source.url}${full ? " full" : ""}`);
      const served = await payer.supply(store => source.client.sync(f.backing, store, { full }));
      const left = withheld.get(source.url) ?? source.withholds;
      if (left > 0) { withhold(); withheld.set(source.url, left - 1); }
      return { served, origin: source.url === "operator" ? "served" : "replica", url: source.url, skipped: [] };
    };
    const read = (synced: Supplied) => {
      if (!("served" in synced)) throw new Error("no source");
      return payer.sync(synced.served.package, f.signed).then(view => ({ view, skipped: synced.skipped, url: synced.url }));
    };
    // Without the repair the read stays unresolved over the withheld field, whatever later syncs from that source send.
    const plain = await supply(new Map())({ full: () => false, except: [] });
    await expect(read(plain)).rejects.toMatchObject({ status: "unresolved-evidence" });
    // The record of sources whose answer from nothing stayed unresolved, at the selection they served (in a directory,
    // unresolved.json).
    const recorded = new Map<string, bigint>();
    const record: RepairRecord = { unresolvedAt: url => recorded.get(url), record: (url, sequence) => { if (sequence === undefined) recorded.delete(url); else recorded.set(url, sequence); } };
    // The operator withholds on every answer: synced again from nothing, still unresolved, it is passed over as
    // UNRESOLVED, and the replica, asked from nothing, resolves the read.
    asked.length = 0;
    const repaired = await readRepaired(supply(new Map()), read, record);
    expect(asked).toEqual(["operator", "operator full", `${f.url} full`]);
    expect(repaired.url).toBe(f.url);
    expect(repaired.skipped).toEqual([{ url: "operator", code: "UNRESOLVED" }]);
    expect(repaired.view.holdings.map(h => h.value)).toEqual([10n]);
    const selection = repaired.view.checkpoint!.sequence;
    expect([...recorded]).toEqual([["operator", selection]]);
    // A source that lost the field once is repaired by its own answer from nothing.
    withhold(); sources[0]!.withholds = 0; asked.length = 0;
    recorded.clear();
    const once = await readRepaired(supply(new Map([["operator", 1]])), read, record);
    expect(asked).toEqual(["operator", "operator full"]);
    expect([once.url, once.skipped]).toEqual(["operator", []]);
    // No source left: the refusal names the sources passed over, and each one's selection is recorded. The next read
    // asks each only after its mark while it serves that selection: no answer from nothing again.
    sources[0]!.withholds = Infinity; sources[1]!.withholds = Infinity; asked.length = 0;
    await expect(readRepaired(supply(new Map()), read, record)).rejects.toMatchObject({ status: "unresolved-evidence",
      message: `unresolved-evidence: no source resolved the read (operator UNRESOLVED, ${f.url} UNRESOLVED)` });
    expect(asked).toEqual(["operator", "operator full", `${f.url} full`]);
    expect([...recorded]).toEqual([["operator", selection], [f.url, selection]]);
    asked.length = 0;
    await expect(readRepaired(supply(new Map()), read, record)).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(asked).toEqual(["operator", f.url]);
    // A source whose selection moved is asked from nothing once more, and a read that resolves clears its record.
    sources[0]!.withholds = 0; await f.commit("c2"); asked.length = 0;
    expect((await readRepaired(supply(new Map()), read, record)).url).toBe("operator");
    expect(asked).toEqual(["operator", "operator full"]);
    expect([...recorded]).toEqual([[f.url, selection]]);
    asked.length = 0;
    await expect(readRepaired(supply(new Map()), async () => { throw new EvidenceRefusal("unsupported-scope"); }, record))
      .rejects.toMatchObject({ status: "unsupported-scope" });
    expect(asked).toEqual(["operator"]);
  });
});
