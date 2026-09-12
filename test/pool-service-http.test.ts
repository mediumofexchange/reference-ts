import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { LocalVenue } from "../src/venue.js";
import { CONFIG, DOMAIN, Oracle, VENUE, issueStatement } from "./pool-support.js";
import { terms } from "./pool-record-support.js";
import { SECRETS } from "./support.js";
import { segmentAuthority } from "../src/pool/statement.js";
import { Segment } from "../src/pool/segment.js";
import { poolReceiptAttestsEvidence, verifyPoolReceipt } from "../src/pool/receipt.js";
import { POOL_SERVICE_PROFILE, replyFromReceipt } from "../src/pool/service-wire.js";
import type { PoolStore as Store } from "../src/pool/store.js";

// Node 20 must not load the optional SQLite server through an eager import.
const supported = Number(process.versions.node.split(".")[0]) >= 24;
const WALLET = "11".repeat(32), ADMIN = "22".repeat(32);
describe.skipIf(!supported)("pool service transport (Node 24)", () => {
  let PoolStore: typeof import("../src/pool/store.js").PoolStore;
  let createPoolService: typeof import("../src/pool/service-http.js").createPoolService;
  let PoolServiceClient: typeof import("../src/pool/service-client.js").PoolServiceClient;
  const stores: Store[] = [], servers: Server[] = [], dirs: string[] = [];
  beforeAll(async () => {
    ({ PoolStore } = await import("../src/pool/store.js"));
    ({ createPoolService } = await import("../src/pool/service-http.js"));
    ({ PoolServiceClient } = await import("../src/pool/service-client.js"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) await new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    });
    for (const store of stores.splice(0)) store.close();
    for (const dir of dirs.splice(0)) {
      expect(dirname(realpathSync(dir))).toBe(realpathSync("scratch"));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  async function serve(store: Store) {
    const server = createPoolService(store, { walletToken: WALLET, adminToken: ADMIN }); servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing TCP address");
    return { server, client: new PoolServiceClient(`http://127.0.0.1:${address.port}/`, WALLET, ADMIN) };
  }
  async function running() {
    mkdirSync("scratch", { recursive: true });
    const dir = mkdtempSync(join(resolve("scratch"), "pool-service-http-")); dirs.push(dir);
    const venue = new LocalVenue(VENUE), oracle = new Oracle(), eur = terms("EUR");
    const store = new PoolStore(join(dir, "state.sqlite"), CONFIG, SECRETS.operator, venue, oracle); stores.push(store);
    await store.activate("opening", [eur]); await store.publish();
    const authority = segmentAuthority((await store.view()).trail!.header);
    const statement = oracle.accept(issueStatement(authority, eur.backing.name, 10n, 101n, SECRETS.backer));
    return { dir, venue, oracle, eur, store, authority, statement, ...await serve(store) };
  }
  async function raw(baseUrl: string, body: unknown, token = WALLET) {
    const response = await fetch(new URL("/commands", baseUrl), { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { code?: string } };
  }
  const command = (fields: Record<string, unknown>) => ({ version: 1, profile: POOL_SERVICE_PROFILE, ...fields });

  it("submits caller-verifiable receipts, commits, publishes and exposes only a bounded summary", async () => {
    const f = await running();
    const view = await f.client.view();
    expect(Object.keys(view).sort()).toEqual(["evidence", "highestSignedSequence", "latest", "profile", "version"]);
    expect(view.evidence).toBe("omitted"); expect(view.highestSignedSequence).toBe("1");
    const receipt = await f.client.submit({ domain: DOMAIN, statement: f.statement });
    expect(receipt.position).toBe(1n);
    expect(verifyPoolReceipt(f.authority, receipt)).toBe(true);
    expect(poolReceiptAttestsEvidence(f.authority, f.statement, receipt)).toBe(true);
    expect(verifyPoolReceipt({ ...f.authority, segment: new Uint8Array(32) }, receipt)).toBe(false);
    expect(verifyPoolReceipt({ ...f.authority, operator: new Uint8Array(32) }, receipt)).toBe(false);
    await expect(f.client.commit("checkpoint")).resolves.toMatchObject({ sequence: 2n });
    await expect(f.client.publish()).resolves.toMatchObject({ sequence: 2n });
  });
  it("enforces admin credentials at the HTTP boundary and rejects malformed or wrong-domain requests without mutation", async () => {
    const f = await running(), before = await f.client.view();
    expect(await raw(f.client.baseUrl, command({ kind: "commit", id: "forbidden" })))
      .toEqual({ status: 403, body: { code: "ADMIN_REQUIRED" } });
    expect((await raw(f.client.baseUrl, command({ kind: "publish" }))).status).toBe(403);
    expect((await raw(f.client.baseUrl, command({ kind: "publish" }), "33".repeat(32))).status).toBe(401);
    expect((await raw(f.client.baseUrl, "{")).status).toBe(400);
    expect((await raw(f.client.baseUrl, command({ kind: "commit", id: "extra", extra: true }), ADMIN)).status).toBe(400);
    await expect(f.client.submit({ domain: new Uint8Array(32), statement: f.statement }))
      .rejects.toMatchObject({ status: 400, code: "INVALID" });
    await expect(f.client.commit("opening")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(await f.client.view()).toEqual(before);
  });
  it("serves loaded status without copying proof history and gives summary callers owned bytes", async () => {
    const f = await running();
    await f.client.submit({ domain: DOMAIN, statement: f.statement });
    const before = await f.client.view(), pristine = await f.store.summary();
    const copy = await f.store.summary();
    copy.latest!.root.fill(0);
    copy.latest!.operator.fill(0);
    copy.latest!.signature.fill(0);
    expect(await f.store.summary()).toEqual(pristine);
    // Copying proof history is deliberately unavailable after the journal has
    // loaded. A status read must not depend on that operation, even with a tail.
    const trail = vi.spyOn(Segment.prototype, "trail").mockImplementation(() => {
      throw new Error("proof history copying unavailable");
    });
    expect(await f.client.view()).toEqual(before);
    expect(trail).not.toHaveBeenCalled();
  });
  it("rejects an authentic receipt for a different submitted statement", async () => {
    const f = await running();
    const receipt = await f.client.submit({ domain: DOMAIN, statement: f.statement });
    expect(verifyPoolReceipt(f.authority, receipt)).toBe(true);
    const wrongReply = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(replyFromReceipt(receipt)));
    });
    servers.push(wrongReply);
    await new Promise<void>((resolve, reject) => wrongReply.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = wrongReply.address();
    if (address === null || typeof address === "string") throw new Error("missing TCP address");
    const client = new PoolServiceClient(`http://127.0.0.1:${address.port}/`, WALLET);
    const another = issueStatement(f.authority, f.eur.backing.name, 10n, 102n, SECRETS.backer);
    await expect(client.submit({ domain: DOMAIN, statement: another }))
      .rejects.toThrow("receipt does not name the submitted statement");
  });
  it("keeps original evidence on changed-proof retry and exact signed results after reopening", async () => {
    const f = await running();
    const first = await f.client.submit({ domain: DOMAIN, statement: f.statement });
    const changed = { ...f.statement, proof: new Uint8Array(32).fill(9) };
    const retry = await f.client.submit({ domain: DOMAIN, statement: changed });
    expect(retry).toEqual(first);
    expect(poolReceiptAttestsEvidence(f.authority, changed, retry)).toBe(false);
    const commit = await f.client.commit("same-id");
    const resumed = new PoolStore(join(f.dir, "state.sqlite"), CONFIG, SECRETS.operator, f.venue, f.oracle); stores.push(resumed);
    const next = await serve(resumed);
    await expect(f.client.commit("old-writer")).rejects.toMatchObject({ code: "FENCED" });
    await expect(f.client.publish()).rejects.toMatchObject({ code: "FENCED" });
    await expect(f.client.view()).rejects.toMatchObject({ code: "FENCED" });
    expect(await next.client.submit({ domain: DOMAIN, statement: f.statement })).toEqual(first);
    expect(await next.client.commit("same-id")).toEqual(commit);
    expect(await next.client.publish()).toEqual(commit);
    expect((await next.client.commit("next-id")).sequence).toBe(3n);
  });
});
