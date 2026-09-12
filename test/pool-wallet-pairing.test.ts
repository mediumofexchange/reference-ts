import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpsServer } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Server } from "node:net";
import { once } from "node:events";
import { join, resolve, sep } from "node:path";
import { commitmentOf } from "../src/pool/notes.js";
import { signPoolReceipt } from "../src/pool/receipt.js";
import type { SegmentAuthority } from "../src/pool/statement.js";
import type { PoolWalletStore as Wallet, WalletDelivery, WalletRequest } from "../src/pool/wallet-store.js";
import {
  decodeWalletPairing,
  encodeWalletPairing,
  MAX_WALLET_PAIRING_BYTES,
  WALLET_PAIRING_PROFILE,
  walletCertificateDigest,
  walletPairingDigest,
  type WalletPairing,
  type WalletTlsCredentials,
} from "../src/pool/wallet-pairing.js";
import { createWalletDeliveryServer, WalletDeliveryClient } from "../src/pool/wallet-delivery-http.js";
import { encodeWalletDelivery, walletDeliveryHash } from "../src/pool/wallet-delivery-wire.js";
import { createWalletBackupKey, openWalletBackup, sealWalletBackup, walletBackupDigest } from "../src/pool/wallet-backup.js";
import { LocalVenue } from "../src/venue.js";
import { DOMAIN, issueStatement, Oracle, VENUE } from "./pool-support.js";
import { open, terms } from "./pool-record-support.js";
import { SECRETS } from "./support.js";

const nodeHasSqlite = Number(process.versions.node.split(".")[0]) >= 24;
const scratch = resolve("scratch"), wallets: Wallet[] = [], servers: Server[] = [], directories: string[] = [];
let PoolWalletStore: typeof import("../src/pool/wallet-store.js").PoolWalletStore;
let tlsA: WalletTlsCredentials, tlsB: WalletTlsCredentials;
// The leaf is signed by this trusted localhost CA with the same public key as
// the CA. Ordinary TLS authorization therefore succeeds; only exact leaf
// pinning distinguishes them. The matching public fixture key is non-secret.
const pinCa = readFileSync(new URL("./fixtures/wallet-tls/pin-ca-cert.pem", import.meta.url), "utf8");
const alternateLeaf = readFileSync(new URL("./fixtures/wallet-tls/pin-leaf-cert.pem", import.meta.url), "utf8");

beforeAll(async () => {
  if (nodeHasSqlite) ({ PoolWalletStore } = await import("../src/pool/wallet-store.js"));
  // @ts-expect-error The bounded provisioning helper is intentionally plain JavaScript.
  const { generateWalletTls } = await import("../scripts/pool/wallet/tls.mjs") as { generateWalletTls(): Promise<WalletTlsCredentials> };
  tlsA = await generateWalletTls();
  tlsB = await generateWalletTls();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const wallet of wallets.splice(0)) try { wallet.close(); } catch { /* already closed */ }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const path of directories.splice(0)) {
    if (!resolve(path).startsWith(scratch + sep)) throw new Error("invalid cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});

function directory(): string {
  mkdirSync(scratch, { recursive: true });
  const path = mkdtempSync(join(scratch, "pool-wallet-pairing-")); directories.push(path); return path;
}
function track(wallet: Wallet): Wallet { wallets.push(wallet); return wallet; }
function close(wallet: Wallet): void { wallet.close(); wallets.splice(wallets.indexOf(wallet), 1); }
async function listen(server: Server): Promise<number> {
  servers.push(server); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
const endpoint = (port: number, id = "invoice") => `https://localhost:${port}/delivery/${id}`;

async function fixture() {
  const dir = directory(), venue = new LocalVenue(VENUE), oracle = new Oracle(), backing = terms("EUR");
  const segment = open(venue, [backing], oracle), authority = segment.authority();
  const receiver = track(new PoolWalletStore(join(dir, "receiver.db"), authority));
  const payer = track(new PoolWalletStore(join(dir, "payer.db"), authority));
  const request = receiver.request("invoice", backing.backing.name, 7n);
  const opening = { backing: request.backing, value: request.value, owner: request.owner,
    rho: receiver.derive("output-rho", [1n]) };
  const statement = oracle.accept(issueStatement(authority, request.backing, request.value,
    commitmentOf(DOMAIN, opening), SECRETS.backer));
  const receipt = signPoolReceipt(SECRETS.operator, authority, await segment.admit(statement), 0n);
  return { dir, authority, receiver, payer, request, delivery: { opening, statement, receipt } satisfies WalletDelivery };
}

function changedRequest(request: WalletRequest, change: Partial<WalletRequest>): WalletRequest {
  return { id: request.id, backing: request.backing.slice(), value: request.value, owner: request.owner, ...change };
}
function changedPair(pair: WalletPairing, change: Partial<WalletPairing>): WalletPairing {
  return { ...pair, request: { ...pair.request }, ...change };
}
function rawTls(port: number, ca: string, request: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: "localhost", port, ca, minVersion: "TLSv1.3" });
    const chunks: Buffer[] = [];
    socket.on("error", reject); socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      const split = text.indexOf("\r\n\r\n"), first = text.slice(0, split).split("\r\n")[0] ?? "";
      resolve({ status: Number(first.split(" ")[1]), text: text.slice(split + 4) });
    });
    socket.once("secureConnect", () => socket.end(request));
  });
}
function httpRequest(port: number, token: string, frame: string): string {
  return `POST /delivery/invoice HTTP/1.1\r\nHost: localhost:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(frame)}\r\nConnection: close\r\n\r\n${frame}`;
}

describe.skipIf(!nodeHasSqlite)("wallet credential lifecycle", () => {
  it("reconciles an exact lost install reply across restart and requires CAS plus a fresh key for rotation", async () => {
    const f = await fixture();
    expect(f.receiver.installDeliveryCredentials(tlsA, 0n)).toBe(1n);
    expect(f.receiver.installDeliveryCredentials(tlsA, 0n)).toBe(1n);
    expect(() => f.receiver.installDeliveryCredentials(tlsB, 0n)).toThrow(/generation changed/);
    expect(() => f.receiver.installDeliveryCredentials(tlsA, 1n)).toThrow(/fresh TLS key/);

    close(f.receiver);
    const restarted = track(new PoolWalletStore(join(f.dir, "receiver.db"), f.authority));
    expect(restarted.deliveryCredentials()).toEqual({ ...tlsA, generation: 1n });
    expect(restarted.installDeliveryCredentials(tlsA, 0n)).toBe(1n);
    expect(restarted.installDeliveryCredentials(tlsB, 1n)).toBe(2n);
    expect(restarted.installDeliveryCredentials(tlsB, 1n)).toBe(2n);
    expect(() => restarted.installDeliveryCredentials(tlsB, 2n)).toThrow(/fresh TLS key/);
  });

  it("revokes capabilities atomically and binds authorization to generation and the actual server certificate", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const first = decodeWalletPairing(f.receiver.deliveryInvitation("invoice", endpoint(4443)));
    const boundA = { generation: 1n, certificateDigest: walletCertificateDigest(tlsA.cert) };
    expect(f.receiver.authorizesDelivery("invoice", first.token, boundA)).toBe(true);
    expect(f.receiver.authorizesDelivery("invoice", first.token, { ...boundA, certificateDigest: walletCertificateDigest(tlsB.cert) })).toBe(false);
    expect(f.receiver.authorizesDelivery("invoice", first.token, { ...boundA, generation: 2n })).toBe(false);

    const mismatched = createWalletDeliveryServer(f.receiver, { ...tlsB, generation: 1n });
    const mismatchedPort = await listen(mismatched), body = encodeWalletDelivery("invoice", DOMAIN, f.delivery);
    expect((await rawTls(mismatchedPort, tlsB.cert, httpRequest(mismatchedPort, first.token, body))).status).toBe(401);
    expect(f.receiver.inbox("invoice")).toBeUndefined();

    expect(f.receiver.installDeliveryCredentials(tlsB, 1n)).toBe(2n);
    expect(f.receiver.authorizesDelivery("invoice", first.token, boundA)).toBe(false);
    const second = decodeWalletPairing(f.receiver.deliveryInvitation("invoice", endpoint(4443)));
    expect(second.token).not.toBe(first.token);
    expect(f.receiver.authorizesDelivery("invoice", second.token,
      { generation: 2n, certificateDigest: walletCertificateDigest(tlsB.cert) })).toBe(true);
  });
});

describe.skipIf(!nodeHasSqlite)("authenticated wallet pairing", () => {
  it("uses one bounded canonical frame and rejects malformed fields and endpoint rebinding", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const frame = f.receiver.deliveryInvitation("invoice", endpoint(4443)), pair = JSON.parse(frame) as WalletPairing;
    expect(encodeWalletPairing(decodeWalletPairing(frame))).toBe(frame);
    expect(walletPairingDigest(frame)).toMatch(/^[0-9a-f]{64}$/);
    const variants = [
      " " + frame,
      frame.replace('"profile":"moe/wallet-pairing/v1"', '"profile":"moe/wallet-pairing/v1","profile":"moe/wallet-pairing/v1"'),
      JSON.stringify({ ...pair, extra: true }),
      JSON.stringify({ ...pair, profile: "moe/wallet-pairing/v2" }),
      JSON.stringify({ ...pair, domain: pair.domain.toUpperCase() }),
      JSON.stringify({ ...pair, request: { ...pair.request, id: "../invoice" } }),
      JSON.stringify({ ...pair, request: { ...pair.request, id: 7 }, endpoint: pair.endpoint.replace("/invoice", "/7") }),
      JSON.stringify({ ...pair, request: { ...pair.request, id: true }, endpoint: pair.endpoint.replace("/invoice", "/true") }),
      JSON.stringify({ ...pair, request: { ...pair.request, backing: "0".repeat(64) } }).replace('"backing":"' + "0".repeat(64), '"backing":"' + "0".repeat(63)),
      JSON.stringify({ ...pair, request: { ...pair.request, value: "0" } }),
      JSON.stringify({ ...pair, request: { ...pair.request, value: "07" } }),
      JSON.stringify({ ...pair, request: { ...pair.request, owner: "0" } }),
      JSON.stringify({ ...pair, request: { ...pair.request, owner: "01" } }),
      JSON.stringify({ ...pair, generation: "0" }),
      JSON.stringify({ ...pair, generation: "01" }),
      JSON.stringify({ ...pair, generation: (1n << 64n).toString() }),
      JSON.stringify({ ...pair, token: pair.token.toUpperCase() }),
      JSON.stringify({ ...pair, endpoint: pair.endpoint.replace("https:", "http:") }),
      JSON.stringify({ ...pair, endpoint: pair.endpoint + "?cap=x" }),
      JSON.stringify({ ...pair, endpoint: pair.endpoint.replace("localhost", "user@localhost") }),
      JSON.stringify({ ...pair, endpoint: pair.endpoint.replace("/invoice", "/other") }),
      frame.replace('"invoice"', '"\\u0069nvoice"'),
      "null", "[]", "{}", "x".repeat(MAX_WALLET_PAIRING_BYTES + 1),
    ];
    for (const variant of variants) expect(() => decodeWalletPairing(variant)).toThrow(/invalid wallet pairing/);
  });

  it("requires an independent exact digest, the wallet domain, and every immutable invoice term", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const frame = f.receiver.deliveryInvitation("invoice", endpoint(4443)), digest = walletPairingDigest(frame);
    expect(() => f.payer.acceptPairing("merchant", frame, "0".repeat(64), f.request)).toThrow(/digest differs/);

    const parsed = decodeWalletPairing(frame);
    const wrongDomain = encodeWalletPairing(changedPair(parsed, { domain: "00".repeat(32) }));
    expect(() => f.payer.acceptPairing("merchant", wrongDomain, walletPairingDigest(wrongDomain), f.request)).toThrow(/differs/);
    for (const expected of [
      changedRequest(f.request, { id: "other" }),
      changedRequest(f.request, { backing: new Uint8Array(32).fill(9) }),
      changedRequest(f.request, { value: f.request.value + 1n }),
      changedRequest(f.request, { owner: f.request.owner + 1n }),
    ]) expect(() => f.payer.acceptPairing("merchant", frame, digest, expected)).toThrow(/request or digest differs/);

    expect(f.payer.acceptPairing("merchant", frame, digest, f.request)).toBe(digest);
    expect(f.payer.acceptPairing("merchant", frame, digest, f.request, "0".repeat(64))).toBe(digest);
  });

  it("rejects stale and same-generation changes and compare-and-swap update races", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const firstFrame = f.receiver.deliveryInvitation("invoice", endpoint(4443));
    const first = decodeWalletPairing(firstFrame), firstDigest = walletPairingDigest(firstFrame);
    f.payer.acceptPairing("merchant", firstFrame, firstDigest, f.request);

    const sameGeneration = encodeWalletPairing(changedPair(first, { token: "ab".repeat(32) }));
    expect(() => f.payer.acceptPairing("merchant", sameGeneration, walletPairingDigest(sameGeneration), f.request, firstDigest)).toThrow(/stale/);
    const nextFrame = encodeWalletPairing(changedPair(first, { generation: "2", token: "cd".repeat(32) }));
    const nextDigest = walletPairingDigest(nextFrame);
    expect(() => f.payer.acceptPairing("merchant", nextFrame, nextDigest, f.request)).toThrow(/stale/);
    expect(() => f.payer.acceptPairing("merchant", nextFrame, nextDigest, f.request, "0".repeat(64))).toThrow(/stale/);
    expect(f.payer.acceptPairing("merchant", nextFrame, nextDigest, f.request, firstDigest)).toBe(nextDigest);
    expect(() => f.payer.acceptPairing("merchant", firstFrame, firstDigest, f.request, nextDigest)).toThrow(/stale/);

    const changedInvoice = encodeWalletPairing({ ...decodeWalletPairing(nextFrame), generation: "3",
      request: { ...first.request, value: "8" } });
    expect(() => f.payer.acceptPairing("merchant", changedInvoice, walletPairingDigest(changedInvoice),
      changedRequest(f.request, { value: 8n }), nextDigest)).toThrow(/changes invoice/);
  });
});

describe.skipIf(!nodeHasSqlite)("persisted paired delivery", () => {
  it("pins the exact leaf even when ordinary TLS accepts a different certificate with the same key", async () => {
    const f = await fixture(), token = "ac".repeat(32), calls: WalletDelivery[] = [];
    const publicKey = readFileSync(new URL("./fixtures/wallet-tls/localhost-key.pem", import.meta.url), "utf8");
    const store = {
      authorizesDelivery: (requestId: string, candidate: string) => requestId === "invoice" && candidate === token,
      receiveAuthorizedDelivery: (requestId: string, _token: string, delivery: WalletDelivery) => {
        calls.push(delivery); return walletDeliveryHash(encodeWalletDelivery(requestId, DOMAIN, delivery));
      },
    };
    const port = await listen(createWalletDeliveryServer(store, { key: publicKey, cert: alternateLeaf }));
    await expect(new WalletDeliveryClient(endpoint(port), token, pinCa).deliver(DOMAIN, f.delivery)).resolves.toMatch(/^[0-9a-f]{64}$/);

    const pair = encodeWalletPairing({ profile: WALLET_PAIRING_PROFILE, domain: Buffer.from(DOMAIN).toString("hex"),
      request: { id: f.request.id, backing: Buffer.from(f.request.backing).toString("hex"), value: f.request.value.toString(), owner: f.request.owner.toString() },
      generation: "1", endpoint: endpoint(port), token, cert: pinCa });
    f.payer.acceptPairing("merchant", pair, walletPairingDigest(pair), f.request);
    await expect(f.payer.pairedDeliveryClient("merchant").deliver(DOMAIN, f.delivery)).rejects.toThrow(/wallet delivery failed/);
    expect(calls).toEqual([f.delivery]);
  });

  it("rejects every invoice mismatch before connecting and rejects a stale client after pairing update", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    let connections = 0;
    const port = await listen(httpsServer({ ...tlsA, minVersion: "TLSv1.3" }, request => { connections++; request.destroy(); }));
    const frame = f.receiver.deliveryInvitation("invoice", endpoint(port)), digest = walletPairingDigest(frame);
    f.payer.acceptPairing("merchant", frame, digest, f.request);
    close(f.payer);
    const payer = track(new PoolWalletStore(join(f.dir, "payer.db"), f.authority)), client = payer.pairedDeliveryClient("merchant");
    const variants: Array<[Uint8Array, WalletDelivery]> = [
      [new Uint8Array(32), f.delivery],
      [DOMAIN, { ...f.delivery, opening: { ...f.delivery.opening, backing: new Uint8Array(32).fill(9) } }],
      [DOMAIN, { ...f.delivery, opening: { ...f.delivery.opening, value: 8n } }],
      [DOMAIN, { ...f.delivery, opening: { ...f.delivery.opening, owner: f.delivery.opening.owner + 1n } }],
    ];
    for (const [domain, delivery] of variants) await expect(client.deliver(domain, delivery)).rejects.toThrow(/wallet delivery failed/);
    expect(connections).toBe(0);

    const pair = decodeWalletPairing(frame), replacement = encodeWalletPairing(changedPair(pair, { generation: "2", token: "ef".repeat(32) }));
    payer.acceptPairing("merchant", replacement, walletPairingDigest(replacement), f.request, digest);
    await expect(client.deliver(DOMAIN, f.delivery)).rejects.toThrow(/wallet delivery failed/);
    expect(connections).toBe(0);
  });

  it("rechecks active custody after TLS before releasing capability or private payment bytes", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    let connections = 0, requests = 0;
    const backupKey = createWalletBackupKey();
    const server = createWalletDeliveryServer(f.receiver, { ...tlsA, generation: 1n });
    server.on("connection", () => { connections++; f.payer.exportBackup(backupKey); });
    server.on("request", () => { requests++; });
    const port = await listen(server), frame = f.receiver.deliveryInvitation("invoice", endpoint(port));
    f.payer.acceptPairing("merchant", frame, walletPairingDigest(frame), f.request);
    await expect(f.payer.pairedDeliveryClient("merchant").deliver(DOMAIN, f.delivery)).rejects.toThrow(/wallet delivery failed/);
    expect(connections).toBe(1); expect(requests).toBe(0); expect(f.receiver.inbox("invoice")).toBeUndefined();
    expect(f.payer.custody()).toEqual({ frozen: true });
  });

  it("fences a streamed old-generation request at commit and rejects a new token on the old server", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const first = decodeWalletPairing(f.receiver.deliveryInvitation("invoice", endpoint(4443)));
    let authorized!: () => void;
    const reached = new Promise<void>(resolve => { authorized = resolve; });
    const guarded = {
      authorizesDelivery: (...args: Parameters<Wallet["authorizesDelivery"]>) => {
        const allowed = f.receiver.authorizesDelivery(...args); if (allowed) authorized(); return allowed;
      },
      receiveAuthorizedDelivery: (...args: Parameters<Wallet["receiveAuthorizedDelivery"]>) => f.receiver.receiveAuthorizedDelivery(...args),
    };
    const server = createWalletDeliveryServer(guarded, { ...tlsA, generation: 1n }), port = await listen(server);
    const frame = encodeWalletDelivery("invoice", DOMAIN, f.delivery), split = Math.floor(frame.length / 2);
    const socket = tlsConnect({ host: "localhost", port, ca: tlsA.cert, minVersion: "TLSv1.3" });
    const response: Buffer[] = []; socket.on("data", chunk => response.push(Buffer.from(chunk)));
    await once(socket, "secureConnect");
    socket.write(`POST /delivery/invoice HTTP/1.1\r\nHost: localhost:${port}\r\nAuthorization: Bearer ${first.token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(frame)}\r\nConnection: close\r\n\r\n${frame.slice(0, split)}`);
    await reached;
    f.receiver.installDeliveryCredentials(tlsB, 1n);
    const second = decodeWalletPairing(f.receiver.deliveryInvitation("invoice", endpoint(port)));
    socket.end(frame.slice(split)); await once(socket, "end");
    expect(Buffer.concat(response).toString()).toMatch(/^HTTP\/1\.1 400/);
    expect(f.receiver.inbox("invoice")).toBeUndefined();

    expect((await rawTls(port, tlsA.cert, httpRequest(port, second.token, frame))).status).toBe(401);
    const currentServer = createWalletDeliveryServer(f.receiver, { ...tlsB, generation: 2n }), currentPort = await listen(currentServer);
    expect((await rawTls(currentPort, tlsB.cert, httpRequest(currentPort, second.token, frame))).status).toBe(200);
    expect(f.receiver.inbox("invoice")).toEqual(f.delivery);
  });
});

describe.skipIf(!nodeHasSqlite)("wallet backup pairing compatibility", () => {
  it("preserves credentials, capabilities, and accepted pairings in one encrypted restore", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const frame = f.receiver.deliveryInvitation("invoice", endpoint(4443)), digest = walletPairingDigest(frame);
    f.receiver.acceptPairing("self", frame, digest, f.request);
    const token = decodeWalletPairing(frame).token, key = createWalletBackupKey(), backup = f.receiver.exportBackup(key), backupDigest = walletBackupDigest(backup);
    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "restored.db"), f.authority, backup, key, backupDigest));
    expect(restored.deliveryCredentials()).toEqual({ ...tlsA, generation: 1n });
    expect(restored.pairing("self")).toBe(frame);
    expect(restored.deliveryToken("invoice")).toBe(token);
    expect(restored.authorizesDelivery("invoice", token,
      { generation: 1n, certificateDigest: walletCertificateDigest(tlsA.cert) })).toBe(true);
  });

  it("restores historical seven-table snapshots with empty transport state", async () => {
    const f = await fixture(), key = createWalletBackupKey(), current = f.receiver.exportBackup(key);
    const plaintext = openWalletBackup(current, key, f.authority, walletBackupDigest(current));
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as unknown[][][]; plaintext.fill(0);
    expect(state).toHaveLength(9); state.splice(7, 2);
    const legacy = sealWalletBackup(new TextEncoder().encode(JSON.stringify(state)), key, f.authority);
    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "legacy.db"), f.authority, legacy, key, walletBackupDigest(legacy)));
    expect(restored.deliveryCredentials()).toBeUndefined();
    expect(() => restored.pairing("missing")).toThrow(/unknown pairing/);
    expect(restored.request("invoice", f.request.backing, f.request.value)).toEqual(f.request);
  });

  it("restores an expired credential structurally so it can be inspected and rotated", async () => {
    const f = await fixture(); f.receiver.installDeliveryCredentials(tlsA, 0n);
    const key = createWalletBackupKey(), backup = f.receiver.exportBackup(key), digest = walletBackupDigest(backup);
    const validTo = Date.parse(new (await import("node:crypto")).X509Certificate(tlsA.cert).validTo);
    vi.spyOn(Date, "now").mockReturnValue(validTo + 1);
    const restored = track(PoolWalletStore.restoreBackup(join(f.dir, "expired.db"), f.authority, backup, key, digest));
    expect(restored.deliveryCredentials()).toEqual({ ...tlsA, generation: 1n });
    expect(() => restored.deliveryInvitation("invoice", endpoint(4443))).toThrow(/invalid wallet pairing or credentials/);
    vi.restoreAllMocks();
    expect(restored.installDeliveryCredentials(tlsB, 1n)).toBe(2n);
  });
});
