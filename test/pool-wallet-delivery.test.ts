import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { createServer as tcpServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Server } from "node:net";
import { once } from "node:events";
import { createWalletDeliveryServer, WalletDeliveryClient } from "../src/pool/wallet-delivery-http.js";
import { decodeWalletDelivery, encodeWalletDelivery, MAX_WALLET_DELIVERY_BYTES, WALLET_DELIVERY_PROFILE, walletDeliveryHash } from "../src/pool/wallet-delivery-wire.js";
import type { WalletDelivery } from "../src/pool/wallet-store.js";
import { commitmentOf } from "../src/pool/notes.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import { DOMAIN, issueStatement, Oracle, VENUE, walletNote } from "./pool-support.js";
import { open, terms } from "./pool-record-support.js";
import { LocalVenue } from "../src/venue.js";
import { SECRETS } from "./support.js";

const cert = readFileSync(new URL("./fixtures/wallet-tls/localhost-cert.pem", import.meta.url), "utf8");
const key = readFileSync(new URL("./fixtures/wallet-tls/localhost-key.pem", import.meta.url), "utf8");
const token = "ab".repeat(32), id = "invoice", servers: Server[] = [];
let delivery: WalletDelivery, frame: string;
beforeAll(async () => {
  const backing = terms("EUR"), oracle = new Oracle(), segment = open(new LocalVenue(VENUE), [backing], oracle);
  const opening = walletNote(backing.backing.name, 7n, 123n).opening;
  const statement = oracle.accept(issueStatement(segment.authority(), backing.backing.name, 7n, commitmentOf(DOMAIN, opening), SECRETS.backer));
  const receipt = signPoolReceipt(SECRETS.operator, segment.authority(), await segment.admit(statement), 0n);
  delivery = { opening, statement, receipt }; frame = encodeWalletDelivery(id, DOMAIN, delivery);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function listen(server: Server): Promise<number> {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
const endpoint = (port: number) => `https://localhost:${port}/delivery/${id}`;
function store() {
  const calls: WalletDelivery[] = [];
  return { calls, authorizesDelivery: (requestId: string, candidate: string) => requestId === id && candidate === token,
    receiveAuthorizedDelivery: (requestId: string, _token: string, value: WalletDelivery) => { calls.push(value); return walletDeliveryHash(encodeWalletDelivery(requestId, DOMAIN, value)); } };
}
function raw(port: number, text: string | Buffer, options: { path?: string; headers?: string[]; chunked?: boolean } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers = [...(options.headers ?? ["Authorization", `Bearer ${token}`, "Content-Type", "application/json"]), "Host", `localhost:${port}`, "Connection", "close"];
    if (!options.chunked) headers.push("Content-Length", String(Buffer.byteLength(text)));
    else headers.push("Transfer-Encoding", "chunked");
    const request = httpsRequest({ host: "localhost", port, path: options.path ?? `/delivery/${id}`, method: "POST", ca: cert, agent: false, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString() })); response.on("error", reject);
    });
    request.on("error", reject);
    if (options.chunked) { request.write(text); request.end(); } else request.end(text);
  });
}

describe("canonical private wallet delivery envelope", () => {
  it("round-trips owned canonical protocol frames and binds all private evidence", () => {
    const decoded = decodeWalletDelivery(frame);
    expect(decoded).toEqual({ requestId: id, domain: DOMAIN, delivery });
    expect(walletDeliveryHash(frame)).toMatch(/^[0-9a-f]{64}$/);
    decoded.delivery.statement.proof[0] = decoded.delivery.statement.proof[0]! ^ 1;
    expect(decodeWalletDelivery(frame).delivery).toEqual(delivery);
    expect(walletDeliveryHash(encodeWalletDelivery(id, DOMAIN, { ...delivery, opening: { ...delivery.opening, rho: 9n } }))).not.toBe(walletDeliveryHash(frame));
  });
  it("rejects duplicate/extra fields, alternate representations, malformed frames and domain mismatch", () => {
    const value = JSON.parse(frame);
    const variants = [" " + frame, frame.replace('"version":1', '"version":1,"version":1'),
      JSON.stringify({ ...value, extra: true }), JSON.stringify({ ...value, version: 2 }),
      JSON.stringify({ ...value, requestId: "../invoice" }), JSON.stringify({ ...value, domain: "00".repeat(32) }),
      JSON.stringify({ ...value, statement: value.statement.toUpperCase() }),
      JSON.stringify({ ...value, opening: { ...value.opening, extra: "secret" } }),
      JSON.stringify({ ...value, opening: { ...value.opening, value: "07" } }),
      JSON.stringify({ ...value, opening: { ...value.opening, owner: "0" } }),
      JSON.stringify({ ...value, opening: { ...value.opening, rho: "1".repeat(79) } }),
      JSON.stringify({ ...value, receipt: " " + value.receipt }), frame.replace('"invoice"', '"\\u0069nvoice"'),
      "null", "[]", '{"version":1}', "x".repeat(MAX_WALLET_DELIVERY_BYTES + 1)];
    for (const variant of variants) expect(() => decodeWalletDelivery(variant)).toThrow("invalid wallet delivery");
    expect(() => encodeWalletDelivery(id, new Uint8Array(32), delivery)).toThrow();
  });
});

describe("authenticated HTTPS inbox transport", () => {
  it("acknowledges only the committed exact frame, without openings or receipts", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    const client = new WalletDeliveryClient(endpoint(port), token, cert);
    expect(await client.deliver(DOMAIN, delivery)).toBe(walletDeliveryHash(frame));
    expect(await client.deliver(DOMAIN, delivery)).toBe(walletDeliveryHash(frame));
    expect(inbox.calls).toEqual([delivery, delivery]);
    const reply = await raw(port, frame, { chunked: true });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ version: 1, profile: WALLET_DELIVERY_PROFILE, kind: "stored", requestId: id, deliveryHash: walletDeliveryHash(frame) });
  });
  it("rejects absent trust and a wrong hostname before sending private application data", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    await expect(new WalletDeliveryClient(endpoint(port), token).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
    await expect(new WalletDeliveryClient(endpoint(port).replace("localhost", "127.0.0.1"), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
    expect(inbox.calls).toHaveLength(0);
  });
  it("refuses TLS 1.2 in either direction", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    await expect(new Promise((resolve, reject) => {
      const socket = tlsConnect({ host: "localhost", port, ca: cert, maxVersion: "TLSv1.2" });
      socket.once("error", reject); socket.once("secureConnect", () => { socket.destroy(); resolve(true); });
    })).rejects.toThrow();
    const legacy = await listen(httpsServer({ cert, key, maxVersion: "TLSv1.2" }));
    await expect(new WalletDeliveryClient(endpoint(legacy), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow();
    expect(inbox.calls).toHaveLength(0);
  });
  it("rejects unsafe endpoint syntax and plaintext before connecting", () => {
    for (const endpoint of ["http://localhost/delivery/invoice", "https://u:p@localhost/delivery/invoice", "https://localhost/delivery/invoice?token=x", "https://localhost/delivery/invoice#x", "https://localhost/delivery/%69nvoice", "https://localhost/delivery/../invoice", "https://localhost/delivery/" + "x".repeat(81)]) {
      expect(() => new WalletDeliveryClient(endpoint, token, cert)).toThrow();
    }
    expect(() => new WalletDeliveryClient("https://localhost/delivery/invoice", "secret", cert)).toThrow();
  });
  it("sends no capability or opening to a plaintext listener masquerading as HTTPS", async () => {
    const observed: Buffer[] = [];
    const port = await listen(tcpServer(socket => { socket.on("error", () => {}); socket.once("data", chunk => { observed.push(chunk); socket.end("HTTP/1.1 200 OK\r\n\r\n"); }); }));
    await expect(new WalletDeliveryClient(endpoint(port), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
    const bytes = Buffer.concat(observed).toString();
    expect(bytes).not.toContain(token); expect(bytes).not.toContain(delivery.opening.rho.toString()); expect(bytes).not.toContain("POST");
  });
  it("rejects duplicate/wrong/missing authorization and request-path rebinding without storing", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    const headerVariants = [["Content-Type", "application/json"], ["Content-Type", "application/json", "Authorization", `Bearer ${"00".repeat(32)}`],
      ["Content-Type", "application/json", "Authorization", `Bearer ${token}`, "Authorization", `Bearer ${token}`]];
    for (const headers of headerVariants) expect((await raw(port, frame, { headers })).status).toBe(401);
    expect((await raw(port, encodeWalletDelivery("other", DOMAIN, delivery))).status).toBe(400);
    for (const path of ["/delivery/invoice?x=1", "/delivery/%69nvoice", "/delivery/invoice/extra"]) expect((await raw(port, frame, { path })).status).toBe(404);
    expect(inbox.calls).toHaveLength(0);
  });
  it("bounds and rejects malformed, compressed and oversized private bodies", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    for (const text of [" " + frame, "\uFEFF" + frame, Buffer.from([0xff, 0xfe]), "x".repeat(MAX_WALLET_DELIVERY_BYTES + 1)]) {
      const result = await raw(port, text).catch(() => ({ status: 400, text: "" })); expect(result.status).toBe(400);
    }
    const compressed = await raw(port, frame, { headers: ["Authorization", `Bearer ${token}`, "Content-Type", "application/json", "Content-Encoding", "gzip"] });
    expect(compressed.status).toBe(400);
    await expect(raw(port, "x".repeat(MAX_WALLET_DELIVERY_BYTES + 1), { chunked: true }).then(r => r.status, () => 400)).resolves.toBe(400);
    expect(inbox.calls).toHaveLength(0);
  });
  it("never acknowledges a failed durable write or leaks its error", async () => {
    const inbox = store(); inbox.receiveAuthorizedDelivery = () => { throw new Error(token + frame); };
    const port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    const response = await raw(port, frame); expect(response).toEqual({ status: 400, text: '{"code":"REJECTED"}' });
    await expect(new WalletDeliveryClient(endpoint(port), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
  });
  it("rejects excess or ambiguous headers and malformed acknowledgement encodings", async () => {
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    const extra = Array.from({ length: 33 }, (_, i) => [`X-Extra-${i}`, "1"]).flat();
    for (const headers of [extra, ["X-Huge", "a".repeat(8_192)], ["Content-Type", "application/json"]]) {
      const response = await raw(port, frame, { headers: ["Authorization", `Bearer ${token}`, "Content-Type", "application/json", ...headers] });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(inbox.calls).toHaveLength(0);
    const ack = JSON.stringify({ version: 1, profile: WALLET_DELIVERY_PROFILE, kind: "stored", requestId: id, deliveryHash: walletDeliveryHash(frame) });
    for (const encoding of ["compressed", "utf8", "headers", "bom"]) {
      const bad = await listen(httpsServer({ cert, key }, (request, response) => {
        request.resume(); response.setHeader("content-type", "application/json");
        if (encoding === "compressed") response.setHeader("content-encoding", "gzip");
        if (encoding === "headers") for (let i = 0; i < 33; i++) response.setHeader(`X-Extra-${i}`, "1");
        response.end(encoding === "utf8" ? Buffer.from([0xff]) : encoding === "bom" ? "\uFEFF" + ack : ack);
      }));
      await expect(new WalletDeliveryClient(endpoint(bad), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
    }
  });
  it("rejects redirects and acknowledgements not bound to this exact frame", async () => {
    const valid = { version: 1, profile: WALLET_DELIVERY_PROFILE, kind: "stored", requestId: id, deliveryHash: walletDeliveryHash(frame) };
    for (const reply of [JSON.stringify({ ...valid, requestId: "other" }), JSON.stringify({ ...valid, deliveryHash: "00".repeat(32) }),
      JSON.stringify({ ...valid, receipt: "unexpected" }), " " + JSON.stringify(valid), JSON.stringify(valid).replace('"version":1', '"version":1,"version":1'), "x".repeat(1_025)]) {
      const port = await listen(httpsServer({ cert, key }, (request, response) => { request.resume(); response.setHeader("content-type", "application/json"); response.end(reply); }));
      await expect(new WalletDeliveryClient(endpoint(port), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow("wallet delivery failed");
    }
    let followed = false;
    const target = await listen(httpsServer({ cert, key }, (_, response) => { followed = true; response.end(); }));
    const source = await listen(httpsServer({ cert, key }, (request, response) => { request.resume(); response.writeHead(307, { location: endpoint(target) }); response.end(); }));
    await expect(new WalletDeliveryClient(endpoint(source), token, cert).deliver(DOMAIN, delivery)).rejects.toThrow(); expect(followed).toBe(false);
  });
  it("enforces absolute client and server deadlines for silent and slowly advancing peers", async () => {
    const sockets: import("node:net").Socket[] = [];
    const silent = await listen(tcpServer(socket => { sockets.push(socket); socket.on("data", () => {}); }));
    const client = new WalletDeliveryClient(endpoint(silent), token, cert).deliver(DOMAIN, delivery);
    const inbox = store(), port = await listen(createWalletDeliveryServer(inbox, { cert, key }));
    const slow = tlsConnect({ host: "localhost", port, ca: cert }); slow.on("error", () => {});
    await once(slow, "secureConnect"); slow.write("POST /delivery/invoice HTTP/1.1\r\n");
    const tick = setInterval(() => slow.write("X-Padding: a\r\n"), 1_000);
    const slowClosed = new Promise<void>(resolve => slow.once("close", () => { clearInterval(tick); resolve(); }));
    await expect(client).rejects.toThrow("wallet delivery failed"); await slowClosed;
    for (const socket of sockets) socket.destroy();
    expect(inbox.calls).toHaveLength(0);
  }, 22_000);
});
