import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { encodeReceipt, receiptBytes, type Receipt, type ReceiptFields } from "../src/pool/v3/commitments.js";
import { adoptedDomain } from "../src/pool/v3/configuration.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { EvidenceStore } from "../src/pool/v3/evidence-store.js";
import { encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord, evidenceHashes, type Record as StatementRecord } from "../src/pool/v3/records.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import { MAX_V3_SERVICE_REPLY_BYTES, replyFromReceipt, replyFromCommitment, servedFrames } from "../src/pool/v3/service-wire.js";
import type { ServedEvidence } from "../src/pool/v3/store.js";
import { encodeCommitment, signCommitment } from "../src/venue-records.js";

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const domain = adoptedDomain(), segment = b(2), secret = b(3), operator = ed25519.getPublicKey(secret), backing = b(4);
const reference = { context: LOCAL_REFERENCE, label: b(5), lag: 2n } as const;
const expected = () => ({ operator: operator.slice(), reference: { ...reference, label: reference.label.slice() } });
// A bounded burn-lock record gives changed-proof retries without capsule fixtures.
const record = (): StatementRecord => ({ domain, kind: 4, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 7n,
  ...limbsOf(backing), 10n, 11n, 12n, 13n, 14n, ...limbsOf(b(6)), 20n, 30n],
  proof: b(7), authorization: new Uint8Array(), capsules: [] });
const receipt = (fields: Partial<ReceiptFields> = {}, signingKey = secret) => {
  const r = { domain, segment, scopeRoot: 7n, position: 1n, ...evidenceHashes(record()), historyHash: b(8), after: 1n, ...fields };
  return encodeReceipt({ ...r, operator: ed25519.getPublicKey(signingKey), signature: ed25519.sign(receiptBytes(r), signingKey) });
};
/** A selection whose own package carries the commitment it names, and no further parts. */
const served = (signer = secret, sequence = 1n): ServedEvidence => ({ selection: { domain, operator, venue: localVenueIdentity(reference.label, reference.lag), backing,
  sequence: 1n, root: b(9) }, package: encodeEvidencePackage([{ kind: 2, payload: encodeCommitment(signCommitment(signer, sequence, b(9))) }]), parts: [] });
const servers: Server[] = [];
async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
const responding = (body: unknown) => endpoint((request, response) => {
  request.resume(); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
});
/** Answers every request with `value` as a served stream. */
const serving = (value: ServedEvidence, seen: (url: string | undefined) => void = () => {}) => endpoint(async (request, response) => {
  seen(request.url); request.resume(); response.setHeader("content-type", "application/octet-stream");
  for await (const chunk of servedFrames(value)) response.write(chunk);
  response.end();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("bounded v3 local service client", () => {
  it("owns expected routing and submitted bytes, verifies acceptance, and allows changed-proof retry", async () => {
    const encoded = encodeRecord(record()), original = encoded.slice(), authority = expected();
    const url = await endpoint((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { record: string };
        expect(command.record).toBe(bytesToHex(original));
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify(replyFromReceipt(receipt())));
      });
    });
    const client = new V3ServiceClient(url, TOKEN, authority, ADMIN);
    authority.operator.fill(0); authority.reference.label.fill(0);
    const submitted = client.submit(encoded); encoded.fill(0);
    expect((await submitted).position).toBe(1n);
    expect(JSON.stringify(client)).not.toContain(TOKEN); expect(JSON.stringify(client)).not.toContain(ADMIN);
    const replayUrl = await responding(replyFromReceipt(receipt()));
    const changed = record(); changed.proof.fill(10);
    const retried = await new V3ServiceClient(replayUrl, TOKEN, expected()).submit(encodeRecord(changed));
    expect((retried as Receipt).proofHash).not.toEqual(evidenceHashes(changed).proofHash);
  });

  it("rejects signed receipts for another statement, segment, scope, domain or operator and invalid signatures", async () => {
    const invalidSignature = receipt(); invalidSignature[invalidSignature.length - 1]! ^= 1;
    for (const bytes of [receipt({ statementHash: b(20) }), receipt({ segment: b(21) }), receipt({ scopeRoot: 8n }),
      receipt({ domain: b(22) }), receipt({}, b(23)), invalidSignature]) {
      const url = await responding(replyFromReceipt(bytes));
      await expect(new V3ServiceClient(url, TOKEN, expected()).submit(encodeRecord(record()))).rejects.toThrow("receipt does not authenticate the submitted statement");
    }
  });

  it("sends nothing for a statement under a domain other than the adopted configuration's", async () => {
    let asked = false;
    const url = await endpoint((request, response) => { asked = true; request.resume(); response.end(); });
    const foreign = { ...record(), domain: b(9), publicInputs: [...limbsOf(b(9)), ...record().publicInputs.slice(2)] };
    await expect(new V3ServiceClient(url, TOKEN, expected()).submit(encodeRecord(foreign))).rejects.toThrow("wrong submission domain or kind");
    expect(asked).toBe(false);
  });

  it("requires admin credentials and binds signed commit and publish replies to the expected operator", async () => {
    const commitment = signCommitment(secret, 2n, b(24));
    const url = await endpoint((request, response) => {
      request.resume(); expect(request.headers.authorization).toBe(`Bearer ${ADMIN}`);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(replyFromCommitment("committed", commitment)));
    });
    await expect(new V3ServiceClient(url, TOKEN, expected()).commit("test")).rejects.toMatchObject({ code: "ADMIN_REQUIRED", status: 403 });
    expect(await new V3ServiceClient(url, TOKEN, expected(), ADMIN).commit("test")).toEqual(commitment);
    for (const kind of ["committed", "published"] as const) {
      const wrong = await responding(replyFromCommitment(kind, signCommitment(b(25), 2n, b(24))));
      const client = new V3ServiceClient(wrong, TOKEN, expected(), ADMIN);
      await expect(kind === "committed" ? client.commit("test") : client.publish()).rejects.toThrow("wrong commitment authority");
    }
  });

  it("pins evidence routing and context without treating served metadata as a finality verdict", async () => {
    const good = served(), paths: (string | undefined)[] = [];
    const url = await serving(good, path => paths.push(path));
    expect(await new V3ServiceClient(url, TOKEN, expected()).package(backing)).toEqual({ selection: good.selection, package: good.package });
    // The holder names its own backing; a multi-backing service selects it. A whole package is served from nothing.
    expect(paths).toEqual([`/evidence?backing=${Buffer.from(backing).toString("hex")}&after=0`]);
    for (const field of ["domain", "venue", "operator", "backing"] as const) {
      const wrong = await serving({ ...good, selection: { ...good.selection, [field]: b(26) } });
      await expect(new V3ServiceClient(wrong, TOKEN, expected()).package(backing)).rejects.toThrow("wrong service package context");
    }
    // The read's own package must carry the named commitment, signed by the expected operator: a sequence
    // recorded as served is one that operator signed.
    for (const wrong of [served(b(25)), served(secret, 2n), { ...good, selection: { ...good.selection, root: b(27) } },
      { ...good, package: encodeEvidencePackage([]) }]) {
      await expect(new V3ServiceClient(await serving(wrong), TOKEN, expected()).package(backing)).rejects.toThrow("wrong commitment authority");
    }
    // A response past the caller's budget is refused as it arrives.
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing, 100n)).rejects.toThrow("served evidence exceeds the reader's budget");
    // A JSON body where a stream is expected is no served evidence.
    const json = await responding({ code: "OK" });
    await expect(new V3ServiceClient(json, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
  });

  it("keeps served parts in the caller's store, records the signed sequence, and refuses a part it does not read", async () => {
    // The operator's service has one mark at whatever URL; a replica (no credential) has its own per URL (M12b).
    const operatorSource = Buffer.concat([domain, localVenueIdentity(reference.label, reference.lag), operator]), object = b(30);
    const source = (url?: string) => url === undefined ? operatorSource : Buffer.concat([operatorSource, Buffer.from(url)]);
    const store = new EvidenceStore(), good = { ...served(), parts: [{ package: encodeEvidencePackage([{ kind: 4, payload: object }]) }] };
    const goodUrl = await serving(good);
    expect(await new V3ServiceClient(goodUrl, TOKEN, expected()).sync(backing, store)).toEqual({ selection: good.selection, package: good.package });
    expect([store.suppliedThrough(source()), store.retained().snapshot(sha256(object))]).toEqual([1n, object]);
    // A selection with no parts is a complete answer: nothing is new.
    const empty = new EvidenceStore(), emptyUrl = await serving(served());
    await new V3ServiceClient(emptyUrl, TOKEN, expected()).sync(backing, empty);
    expect(empty.suppliedThrough(source())).toBe(1n);
    // A replica's mark is its own: the operator's is not asked of it, nor its of the operator.
    const replicaStore = new EvidenceStore();
    await new V3ServiceClient(emptyUrl, undefined, expected()).sync(backing, replicaStore);
    expect([replicaStore.suppliedThrough(source()), replicaStore.suppliedThrough(source(emptyUrl))]).toEqual([0n, 1n]);
    replicaStore.close();
    // A kind no v3 reader reads refuses the sync, and another context is refused before any part is kept: no sequence is recorded.
    const other = new EvidenceStore(), unread = { ...served(), parts: [{ package: encodeEvidencePackage([{ kind: 9, payload: object }]) }] };
    const unreadUrl = await serving(unread), wrongUrl = await serving({ ...good, selection: { ...good.selection, venue: b(26) } });
    await expect(new V3ServiceClient(unreadUrl, TOKEN, expected()).sync(backing, other)).rejects.toMatchObject({ status: "unsupported-scope" });
    await expect(new V3ServiceClient(wrongUrl, TOKEN, expected()).sync(backing, other)).rejects.toThrow("wrong service package context");
    expect([other.suppliedThrough(source()), other.retained().snapshot(sha256(object))]).toEqual([0n, undefined]);
    for (const opened of [store, empty, other]) opened.close();
  });

  it("rejects remote or ambiguous URLs and malformed credentials before a request", () => {
    for (const url of ["https://127.0.0.1/", "http://example.com/", "http://127.0.0.1/path", "http://127.0.0.1/?token=x",
      "http://user:pass@127.0.0.1/", "http://localhost/", "http://example.onion/", `https://${"a".repeat(55)}d.onion/`]) {
      expect(() => new V3ServiceClient(url, TOKEN, expected())).toThrow("a local or onion URL and distinct 32-byte credentials required");
    }
    expect(() => new V3ServiceClient("http://127.0.0.1/", TOKEN, expected(), TOKEN)).toThrow("distinct 32-byte credentials required");
    expect(() => new V3ServiceClient("http://127.0.0.1/", "bad", expected())).toThrow("distinct 32-byte credentials required");
  });

  it("refuses redirects without forwarding bearer credentials to the destination", async () => {
    let contacted = false;
    const target = await endpoint((_, response) => { contacted = true; response.end(); });
    const url = await endpoint((_, response) => { response.writeHead(302, { location: target }); response.end(); });
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
    expect(contacted).toBe(false);
  });

  it("bounds declared and chunked reply bodies before parsing", async () => {
    for (const declared of [false, true]) {
      const url = await endpoint((_, response) => {
        response.setHeader("content-type", "application/json");
        if (declared) response.setHeader("content-length", String(MAX_V3_SERVICE_REPLY_BYTES + 1));
        else response.flushHeaders();
        response.end(" ".repeat(MAX_V3_SERVICE_REPLY_BYTES + 1));
      });
      await expect(new V3ServiceClient(url, TOKEN, expected(), ADMIN).commit("test")).rejects.toThrow("response too large");
    }
  });

  it("rejects malformed UTF-8, response compression and untrusted error text", async () => {
    const utf8 = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.end(Buffer.from([0xff])); });
    await expect(new V3ServiceClient(utf8, TOKEN, expected(), ADMIN).commit("test")).rejects.toThrow(/JSON|UTF-8/);
    const compressed = await endpoint((_, response) => {
      response.setHeader("content-type", "application/octet-stream"); response.setHeader("content-encoding", "br"); response.end();
    });
    await expect(new V3ServiceClient(compressed, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
    const error = await endpoint((_, response) => {
      response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: `secret ${TOKEN}` }));
    });
    await expect(new V3ServiceClient(error, TOKEN, expected()).package(backing)).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
    const refused = await endpoint((_, response) => { response.writeHead(409, { "content-type": "application/json" }); response.end(JSON.stringify({ code: "FENCED" })); });
    await expect(new V3ServiceClient(refused, TOKEN, expected()).package(backing)).rejects.toMatchObject({ code: "FENCED", status: 409 });
  });

  it("stops waiting on a source that drips evidence below the minimum rate, as a source that did not answer", async () => {
    // A valid selection, then a trail of a terabyte, one byte at a time: each byte comes within the stall bound, and
    // the clock moves three seconds per byte, so the waits pass fifteen seconds.
    const head: Uint8Array[] = [];
    for await (const chunk of servedFrames({ ...served(), parts: [{ trail: { size: 1n << 40n, chunks: [] } }] })) {
      head.push(chunk);
      if (head.length === 2) break;
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const url = await endpoint((request, response) => {
        request.resume(); response.setHeader("content-type", "application/octet-stream"); response.writeHead(200);
        for (const chunk of head) response.write(chunk);
        const tick = setInterval(() => { vi.setSystemTime(Date.now() + 3_000); response.write(Uint8Array.of(0x70)); }, 5);
        response.once("close", () => clearInterval(tick));
      });
      await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toMatchObject({ name: "TimeoutError" });
    } finally { vi.useRealTimers(); }
  });

  it("aborts a real server that stalls after response headers", async () => {
    const url = await endpoint((_, response) => { response.setHeader("content-type", "application/octet-stream"); response.flushHeaders(); });
    const started = Date.now();
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 15_000);
});
