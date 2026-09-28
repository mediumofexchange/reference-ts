import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { LOCAL_REFERENCE, localVenueIdentity } from "../src/record-venue.js";
import { encodeReceipt, receiptBytes, type ReceiptFields } from "../src/pool/v3/commitments.js";
import { encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord, evidenceHashes, type Record as StatementRecord } from "../src/pool/v3/records.js";
import { V3ServiceClient } from "../src/pool/v3/service-client.js";
import { MAX_V3_SERVICE_RESPONSE_BYTES, packageReply, replyFromReceipt, replyFromCommitment } from "../src/pool/v3/service-wire.js";
import { signCommitment } from "../src/venue-records.js";

const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const domain = b(1), segment = b(2), secret = b(3), operator = ed25519.getPublicKey(secret), backing = b(4);
const reference = { context: LOCAL_REFERENCE, label: b(5), lag: 2n } as const;
const expected = () => ({ domain: domain.slice(), operator: operator.slice(), reference: { ...reference, label: reference.label.slice() } });
// A bounded burn-lock record gives changed-proof retries without capsule fixtures.
const record = (): StatementRecord => ({ domain, kind: 4, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 7n,
  ...limbsOf(backing), 10n, 11n, 12n, 13n, 14n, ...limbsOf(b(6)), 20n, 30n],
  proof: b(7), authorization: new Uint8Array(), capsules: [] });
const receipt = (fields: Partial<ReceiptFields> = {}, signingKey = secret) => {
  const r = { domain, segment, scopeRoot: 7n, position: 1n, ...evidenceHashes(record()), historyHash: b(8), after: 1n, ...fields };
  return encodeReceipt({ ...r, operator: ed25519.getPublicKey(signingKey), signature: ed25519.sign(receiptBytes(r), signingKey) });
};
const served = () => ({ selection: { domain, operator, venue: localVenueIdentity(reference.label, reference.lag), backing,
  sequence: 1n, root: b(9) }, package: encodeEvidencePackage([], { maxBytes: 1_048_576n, maxItems: 1024n }) });
const servers: Server[] = [];
async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
const responding = (body: unknown) => endpoint((request, response) => {
  request.resume(); response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body));
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
    authority.domain.fill(0); authority.operator.fill(0); authority.reference.label.fill(0);
    const submitted = client.submit(encoded); encoded.fill(0);
    expect((await submitted).position).toBe(1n);
    expect(JSON.stringify(client)).not.toContain(TOKEN); expect(JSON.stringify(client)).not.toContain(ADMIN);
    const replayUrl = await responding(replyFromReceipt(receipt()));
    const changed = record(); changed.proof.fill(10);
    const retried = await new V3ServiceClient(replayUrl, TOKEN, expected()).submit(encodeRecord(changed));
    expect(retried.proofHash).not.toEqual(evidenceHashes(changed).proofHash);
  });

  it("rejects signed receipts for another statement, segment, scope, domain or operator and invalid signatures", async () => {
    const invalidSignature = receipt(); invalidSignature[invalidSignature.length - 1]! ^= 1;
    for (const bytes of [receipt({ statementHash: b(20) }), receipt({ segment: b(21) }), receipt({ scopeRoot: 8n }),
      receipt({ domain: b(22) }), receipt({}, b(23)), invalidSignature]) {
      const url = await responding(replyFromReceipt(bytes));
      await expect(new V3ServiceClient(url, TOKEN, expected()).submit(encodeRecord(record()))).rejects.toThrow("receipt does not authenticate the submitted statement");
    }
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

  it("pins package routing without treating package metadata as a finality verdict", async () => {
    const good = served(), url = await responding(packageReply(good));
    expect(await new V3ServiceClient(url, TOKEN, expected()).package(backing)).toEqual(good);
    for (const field of ["domain", "venue", "operator", "backing"] as const) {
      const wrong = await responding(packageReply({ ...good, selection: { ...good.selection, [field]: b(26) } }));
      await expect(new V3ServiceClient(wrong, TOKEN, expected()).package(backing)).rejects.toThrow("wrong service package context");
    }
  });

  it("rejects remote or ambiguous URLs and malformed credentials before a request", () => {
    for (const url of ["https://127.0.0.1/", "http://example.com/", "http://127.0.0.1/path", "http://127.0.0.1/?token=x",
      "http://user:pass@127.0.0.1/", "http://localhost/"]) {
      expect(() => new V3ServiceClient(url, TOKEN, expected())).toThrow("local URL and distinct 32-byte credentials required");
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

  it("bounds declared and chunked response bodies before parsing", async () => {
    for (const declared of [false, true]) {
      const url = await endpoint((_, response) => {
        response.setHeader("content-type", "application/json");
        if (declared) response.setHeader("content-length", String(MAX_V3_SERVICE_RESPONSE_BYTES + 1));
        else response.flushHeaders();
        response.end(" ".repeat(MAX_V3_SERVICE_RESPONSE_BYTES + 1));
      });
      await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toThrow("response too large");
    }
  });

  it("rejects malformed UTF-8, response compression and untrusted error text", async () => {
    const utf8 = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.end(Buffer.from([0xff])); });
    await expect(new V3ServiceClient(utf8, TOKEN, expected()).package(backing)).rejects.toThrow(/JSON|UTF-8/);
    const compressed = await endpoint((_, response) => {
      response.setHeader("content-type", "application/json"); response.setHeader("content-encoding", "br"); response.end();
    });
    await expect(new V3ServiceClient(compressed, TOKEN, expected()).package(backing)).rejects.toThrow("unexpected service response");
    const error = await endpoint((_, response) => {
      response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ code: `secret ${TOKEN}` }));
    });
    await expect(new V3ServiceClient(error, TOKEN, expected()).package(backing)).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
  });

  it("aborts a real server that stalls after response headers", async () => {
    const url = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); });
    const started = Date.now();
    await expect(new V3ServiceClient(url, TOKEN, expected()).package(backing)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 15_000);
});
