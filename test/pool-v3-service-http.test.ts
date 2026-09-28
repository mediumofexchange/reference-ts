import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { encodeReceipt, receiptBytes } from "../src/pool/v3/commitments.js";
import { encodeRecord } from "../src/pool/v3/records.js";
import { V3_SERVICE_PROFILE } from "../src/pool/v3/service-wire.js";
import { signCommitment } from "../src/venue-records.js";
import type { V3OperatorJournal } from "../src/pool/v3/store.js";

// Mock only the journal boundary. Process acceptance covers actual persistence.
const supported = Number(process.versions.node.split(".")[0]) >= 24;
const TOKEN = "11".repeat(32), ADMIN = "22".repeat(32);
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const domain = b(1), secret = b(2), operator = ed25519.getPublicKey(secret);
const command = (fields: Record<string, unknown>) => ({ version: 1, profile: V3_SERVICE_PROFILE, ...fields });
const record = (d = domain) => encodeRecord({ domain: d, kind: 5,
  publicInputs: [...limbsOf(d), ...limbsOf(b(3)), 7n, ...limbsOf(b(4))],
  proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] });
const fields = { domain, segment: b(3), scopeRoot: 7n, position: 1n, statementHash: b(5), historyHash: b(6),
  proofHash: b(7), signatureHash: b(8), after: 1n };
const receipt = encodeReceipt({ ...fields, operator, signature: ed25519.sign(receiptBytes(fields), secret) });

describe.skipIf(!supported)("v3 service HTTP trust boundary (Node 24)", () => {
  let createV3Service: typeof import("../src/pool/v3/service-http.js").createV3Service;
  let V3StoreError: typeof import("../src/pool/v3/store.js").V3StoreError;
  const servers: Server[] = [];
  beforeAll(async () => {
    ({ createV3Service } = await import("../src/pool/v3/service-http.js"));
    ({ V3StoreError } = await import("../src/pool/v3/store.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  });
  async function fixture() {
    const commitment = signCommitment(secret, 2n, b(9));
    const journal = { configurationDomain: domain.slice(), submit: vi.fn(async (_bytes: Uint8Array) => receipt.slice()),
      commit: vi.fn(async (_id: string) => commitment), publish: vi.fn(async () => commitment),
      package: vi.fn(async () => ({ selection: { domain, operator, venue: b(10), backing: b(11), root: b(9), sequence: 2n }, package: b(12) })) };
    const server = createV3Service(journal as unknown as V3OperatorJournal, { walletToken: TOKEN, adminToken: ADMIN });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    return { journal, url };
  }
  async function raw(url: string, body: unknown, token = TOKEN, headers: Record<string, string> = {}) {
    const response = await fetch(new URL("/commands", url), { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: body instanceof Uint8Array ? Buffer.from(body) : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }

  it("authorizes wallet submit/package and reserves commit/publish for the admin credential", async () => {
    const f = await fixture(), submission = command({ kind: "submit", record: bytesToHex(record()) });
    expect((await raw(f.url, submission)).status).toBe(200);
    expect(f.journal.submit).toHaveBeenCalledExactlyOnceWith(record());
    expect(await raw(f.url, command({ kind: "commit", id: "checkpoint" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect(await raw(f.url, command({ kind: "publish" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect(f.journal.commit).not.toHaveBeenCalled(); expect(f.journal.publish).not.toHaveBeenCalled();
    expect((await raw(f.url, command({ kind: "commit", id: "checkpoint" }), ADMIN)).status).toBe(200);
    expect((await raw(f.url, command({ kind: "publish" }), ADMIN)).status).toBe(200);
    const response = await fetch(new URL("/package", f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    await response.arrayBuffer(); expect(f.journal.package).toHaveBeenCalledExactlyOnceWith(undefined);
    // A multi-backing scope serves the holder's backing by name; any other query is not a route.
    const named = await fetch(new URL(`/package?backing=${"0b".repeat(32)}`, f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(named.status).toBe(200); await named.arrayBuffer();
    expect(f.journal.package).toHaveBeenLastCalledWith(b(11));
    for (const query of ["?backing=0B", `?backing=${"0b".repeat(31)}`, `?backing=${"0b".repeat(32)}&x=1`, "?other=1"]) {
      const refused = await fetch(new URL(`/package${query}`, f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(refused.status).toBe(404); await refused.arrayBuffer();
    }
    expect(f.journal.package).toHaveBeenCalledTimes(2);
  });

  it("rejects wrong and duplicate authorization before invoking the journal", async () => {
    const f = await fixture(), body = JSON.stringify(command({ kind: "publish" }));
    expect(await raw(f.url, body, "33".repeat(32))).toEqual({ status: 401, body: { code: "UNAUTHORIZED" } });
    const duplicate = await new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
      const request = httpRequest(new URL("/commands", f.url), { method: "POST", headers: [
        "Host", new URL(f.url).host, "Connection", "close",
        "Authorization", `Bearer ${ADMIN}`, "Authorization", `Bearer ${ADMIN}`, "Content-Type", "application/json",
        "Content-Length", String(Buffer.byteLength(body)),
      ] }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
        response.on("error", reject);
      });
      request.on("error", reject); request.setTimeout(5000, () => request.destroy(new Error("duplicate-auth request stalled"))); request.end(body);
    });
    expect(duplicate).toEqual({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect(f.journal.publish).not.toHaveBeenCalled();
  });

  it("rejects malformed bytes, unknown fields, wrong domains and oversized requests without mutation", async () => {
    const f = await fixture();
    for (const body of ["{", Buffer.from([0xff]), command({ kind: "publish", extra: true }),
      command({ kind: "submit", record: bytesToHex(record(b(20))) }), " ".repeat(300001)]) {
      expect(await raw(f.url, body, ADMIN)).toEqual({ status: 400, body: { code: "INVALID" } });
    }
    expect(await raw(f.url, command({ kind: "publish" }), ADMIN, { "content-encoding": "gzip" }))
      .toEqual({ status: 400, body: { code: "INVALID" } });
    expect(f.journal.submit).not.toHaveBeenCalled(); expect(f.journal.commit).not.toHaveBeenCalled(); expect(f.journal.publish).not.toHaveBeenCalled();
  });

  it("returns only named refusal codes and sanitizes arbitrary storage/verifier errors", async () => {
    const f = await fixture();
    f.journal.publish.mockRejectedValueOnce(new V3StoreError("FENCED", `private path ${ADMIN}`));
    expect(await raw(f.url, command({ kind: "publish" }), ADMIN)).toEqual({ status: 409, body: { code: "FENCED" } });
    f.journal.publish.mockRejectedValueOnce(new Error(`verifier failure ${TOKEN}`));
    expect(await raw(f.url, command({ kind: "publish" }), ADMIN)).toEqual({ status: 503, body: { code: "UNAVAILABLE" } });
    f.journal.submit.mockRejectedValueOnce(new V3StoreError("REFUSED", "proof secret", "PROOF"));
    expect(await raw(f.url, command({ kind: "submit", record: bytesToHex(record()) })))
      .toEqual({ status: 400, body: { code: "REFUSED" } });
  });
});
