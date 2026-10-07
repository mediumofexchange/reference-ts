import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { encodeReceipt, receiptBytes } from "../src/pool/v3/commitments.js";
import { POOL_V3 } from "../src/pool/v3/construction.js";
import { encodeRecord } from "../src/pool/v3/records.js";
import { signCommitment } from "../src/venue-records.js";
import { readServed, V3_SERVICE_PROFILE } from "../src/pool/v3/service-wire.js";
import type { ServedEvidence, V3OperatorJournal } from "../src/pool/v3/store.js";

// Mock only the journal boundary. Process acceptance covers actual persistence.
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

describe("v3 service HTTP trust boundary", () => {
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
  async function fixture(credentials: { walletToken: string; adminToken?: string } = { walletToken: TOKEN, adminToken: ADMIN }) {
    const commitment = signCommitment(secret, 2n, b(9));
    const journal = { configurationDomain: domain.slice(), construction: POOL_V3, submit: vi.fn(async (_bytes: Uint8Array) => receipt.slice()),
      commit: vi.fn(async (_id: string) => commitment), publish: vi.fn(async () => commitment),
      serve: vi.fn(async (_backing: Uint8Array, _after: bigint): Promise<ServedEvidence> => ({
        selection: { domain, operator, venue: b(10), backing: b(11), root: b(9), sequence: 2n }, package: b(12),
        parts: [{ package: b(13) }, { trail: { size: 200_000n, chunks: [new Uint8Array(200_000).fill(7)] } }] })) };
    const server = createV3Service(journal as unknown as V3OperatorJournal, credentials);
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    return { journal, url, server };
  }
  async function raw(url: string, body: unknown, token = TOKEN, headers: Record<string, string> = {}) {
    const response = await fetch(new URL("/commands", url), { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: body instanceof Uint8Array ? Buffer.from(body) : typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }

  it("starts only with two distinct 32-byte credentials", () => {
    const journal = { configurationDomain: domain.slice() } as unknown as V3OperatorJournal;
    for (const credentials of [{ walletToken: TOKEN, adminToken: TOKEN }, { walletToken: "bad", adminToken: ADMIN },
      { walletToken: TOKEN, adminToken: "AA".repeat(32) }, { walletToken: TOKEN.slice(2), adminToken: ADMIN }]) {
      expect(() => createV3Service(journal, credentials)).toThrow("distinct 32-byte credentials required");
    }
  });

  it("serves holders only without an admin credential: an onion service's listener (M12a)", async () => {
    const f = await fixture({ walletToken: TOKEN }), submission = command({ kind: "submit", record: bytesToHex(record()) });
    expect((await raw(f.url, submission)).status).toBe(200);
    expect(await raw(f.url, command({ kind: "commit", id: "checkpoint" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect(await raw(f.url, command({ kind: "publish" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    // No admin credential opens it: the operator's admin token is a stranger's here.
    expect(await raw(f.url, command({ kind: "publish" }), ADMIN)).toEqual({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect(f.journal.commit).not.toHaveBeenCalled(); expect(f.journal.publish).not.toHaveBeenCalled();
    const response = await fetch(new URL(`/evidence?backing=${"0b".repeat(32)}&after=0`, f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200); await response.arrayBuffer();
  });

  it("authorizes wallet submit/evidence and reserves commit/publish for the admin credential", async () => {
    const f = await fixture(), submission = command({ kind: "submit", record: bytesToHex(record()) });
    expect((await raw(f.url, submission)).status).toBe(200);
    expect(f.journal.submit).toHaveBeenCalledExactlyOnceWith(record());
    expect(await raw(f.url, command({ kind: "commit", id: "checkpoint" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect(await raw(f.url, command({ kind: "publish" }))).toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect(f.journal.commit).not.toHaveBeenCalled(); expect(f.journal.publish).not.toHaveBeenCalled();
    expect((await raw(f.url, command({ kind: "commit", id: "checkpoint" }), ADMIN)).status).toBe(200);
    expect((await raw(f.url, command({ kind: "publish" }), ADMIN)).status).toBe(200);
    // Evidence is a byte stream of the journal's parts, for the backing and after the sequence the reader names.
    const evidence = (query: string, token = TOKEN) => fetch(new URL(`/evidence${query}`, f.url), { headers: { authorization: `Bearer ${token}` } });
    const response = await evidence(`?backing=${"0b".repeat(32)}&after=18446744073709551615`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    const read = await readServed(response.body as unknown as AsyncIterable<Uint8Array>, async (_, parts) => {
      const sizes: number[] = [];
      for await (const part of parts) {
        if ("package" in part) { sizes.push(part.package.length); continue; }
        let size = 0; for await (const chunk of part.trail.chunks) size += chunk.length;
        sizes.push(size);
      }
      return sizes;
    });
    expect(read.served).toEqual({ selection: { domain, operator, venue: b(10), backing: b(11), root: b(9), sequence: 2n }, package: b(12) });
    expect(read.taken).toEqual([32, 200_000]);
    expect(f.journal.serve).toHaveBeenCalledExactlyOnceWith(b(11), 18446744073709551615n);
    // Any other query is not a route; a sequence past u64 is invalid.
    for (const query of ["", "?backing=0B&after=0", `?backing=${"0b".repeat(31)}&after=0`, `?backing=${"0b".repeat(32)}`,
      `?backing=${"0b".repeat(32)}&after=01`, `?backing=${"0b".repeat(32)}&after=0&x=1`, `?after=0&backing=${"0b".repeat(32)}`]) {
      const refused = await evidence(query);
      expect(refused.status, query).toBe(404); await refused.arrayBuffer();
    }
    const past = await evidence(`?backing=${"0b".repeat(32)}&after=18446744073709551616`);
    expect([past.status, await past.json()]).toEqual([400, { code: "INVALID" }]);
    const old = await fetch(new URL("/package", f.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(old.status).toBe(404); await old.arrayBuffer();
    expect(f.journal.serve).toHaveBeenCalledTimes(1);
    // A refusal before the stream is a JSON reply; a failure within it ends the connection short of the end mark.
    f.journal.serve.mockRejectedValueOnce(new V3StoreError("STALE", "nothing published"));
    const stale = await evidence(`?backing=${"0b".repeat(32)}&after=0`);
    expect([stale.status, await stale.json()]).toEqual([409, { code: "STALE" }]);
    f.journal.serve.mockResolvedValueOnce({ selection: { domain, operator, venue: b(10), backing: b(11), root: b(9), sequence: 2n }, package: b(12),
      parts: (function* () { yield { package: b(13) }; throw new V3StoreError("STORAGE", "rows do not read back"); })() });
    // The peer sees no complete stream: the connection fails, or the parts end before the end mark. The owner is told why.
    const told: unknown[] = []; f.server.on("evidenceError", error => told.push(error));
    await expect((async () => {
      const broken = await evidence(`?backing=${"0b".repeat(32)}&after=0`);
      await readServed(broken.body as unknown as AsyncIterable<Uint8Array>, async (_, parts) => { for await (const _part of parts); });
    })()).rejects.toThrow(/truncated served evidence|fetch failed|terminated/);
    expect(told).toEqual([new V3StoreError("STORAGE", "rows do not read back")]);
    // Eight streams at once leave the other connections for commands: a ninth is refused while they last.
    const release: (() => void)[] = [];
    f.journal.serve.mockImplementation(() => new Promise((_, refuse) => { release.push(() => refuse(new V3StoreError("UNAVAILABLE", "released"))); }));
    const held = Array.from({ length: 8 }, () => evidence(`?backing=${"0b".repeat(32)}&after=0`));
    await vi.waitFor(() => expect(release).toHaveLength(8));
    const ninth = await evidence(`?backing=${"0b".repeat(32)}&after=0`);
    expect([ninth.status, await ninth.json()]).toEqual([409, { code: "BUSY" }]);
    expect((await raw(f.url, command({ kind: "publish" }), ADMIN)).status).toBe(200);
    for (const free of release) free();
    for (const response of await Promise.all(held)) expect([response.status, await response.json()]).toEqual([503, { code: "UNAVAILABLE" }]);
    f.journal.serve.mockRejectedValueOnce(new V3StoreError("STALE", "nothing published"));
    expect((await evidence(`?backing=${"0b".repeat(32)}&after=0`)).status).toBe(409);
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

describe("relay HTTP trust boundary (slice 12 M12c)", () => {
  let createRelayService: typeof import("../src/pool/v3/service-http.js").createRelayService;
  let sendToRelay: typeof import("../src/pool/v3/service-client.js").sendToRelay;
  const servers: Server[] = [];
  beforeAll(async () => {
    ({ createRelayService } = await import("../src/pool/v3/service-http.js"));
    ({ sendToRelay } = await import("../src/pool/v3/service-client.js"));
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
      server.closeAllConnections(); server.close(() => resolve());
    })));
  });
  class Refusal extends Error { constructor(readonly code: string) { super(code); } }
  const FILE = { schema: "moe-publication-1", record: "01" };
  async function relay() {
    const take = vi.fn(async (file: unknown, gone: () => boolean) => ({ status: "pending", file, gone: gone() }));
    const server = createRelayService(TOKEN, take, error => error instanceof Refusal ?
      { status: error.code === "EARLY" ? 409 : 400, code: error.code } : undefined);
    const failures: unknown[] = [];
    server.on("relayError", error => failures.push(error));
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return { take, failures, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  }
  async function post(url: string, path: string, body: unknown, token = TOKEN) {
    const response = await fetch(new URL(path, url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }

  it("starts only with a 32-byte credential", () => {
    for (const token of ["bad", "AA".repeat(32), TOKEN.slice(2)]) {
      expect(() => createRelayService(token, async () => ({}), () => undefined)).toThrow("a 32-byte credential required");
    }
  });

  it("takes a publication file on its one route under its one credential, and nothing else reaches take", async () => {
    const r = await relay();
    expect(await post(r.url, "/publications", FILE)).toEqual({ status: 200, body: { status: "pending", file: FILE, gone: false } });
    expect(await post(r.url, "/publications", FILE, "33".repeat(32))).toEqual({ status: 401, body: { code: "UNAUTHORIZED" } });
    expect(await post(r.url, "/commands", FILE)).toEqual({ status: 404, body: { code: "NOT_FOUND" } });
    const get = await fetch(new URL("/publications", r.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect([get.status, await get.json()]).toEqual([404, { code: "NOT_FOUND" }]);
    for (const body of ["{", " ".repeat(300_001)]) expect(await post(r.url, "/publications", body)).toEqual({ status: 400, body: { code: "INVALID" } });
    expect(r.take).toHaveBeenCalledTimes(1);
    // Once answered, the request reads as gone: work queued behind it for nobody would spend nothing.
    expect(r.take.mock.calls[0]![1]()).toBe(true);
  });

  it("answers a named refusal by its code and anything else as UNAVAILABLE, told to the owner", async () => {
    const r = await relay();
    r.take.mockRejectedValueOnce(new Refusal("EARLY"));
    expect(await post(r.url, "/publications", FILE)).toEqual({ status: 409, body: { code: "EARLY" } });
    r.take.mockRejectedValueOnce(new Error(`node failure ${TOKEN}`));
    expect(await post(r.url, "/publications", FILE)).toEqual({ status: 503, body: { code: "UNAVAILABLE" } });
    expect(r.failures.map(error => (error as Error).message)).toEqual([`node failure ${TOKEN}`]);
  });

  it("a send reaches only a loopback or onion URL with a credential, and carries the relay's refusal code", async () => {
    const r = await relay();
    expect(await sendToRelay(r.url, TOKEN, FILE)).toEqual({ status: "pending", file: FILE, gone: false });
    await expect(sendToRelay(r.url, "33".repeat(32), FILE)).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    for (const url of [r.url.replace("127.0.0.1", "localhost"), `${r.url}publications`, "https://127.0.0.1:1/", "http://user:x@127.0.0.1:1/"]) {
      await expect(sendToRelay(url, TOKEN, FILE)).rejects.toThrow("a local or onion relay URL and a 32-byte credential required");
    }
    await expect(sendToRelay(r.url, "bad", FILE)).rejects.toThrow("a local or onion relay URL and a 32-byte credential required");
    expect(r.take).toHaveBeenCalledTimes(1);
  });
});
