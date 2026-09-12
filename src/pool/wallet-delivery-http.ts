import { createServer, request as httpsRequest, type Server } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";
import { EncodingError } from "../bytes.js";
import { decodeWalletDelivery, encodeWalletDelivery, MAX_WALLET_DELIVERY_BYTES, WALLET_DELIVERY_PROFILE, walletDeliveryHash } from "./wallet-delivery-wire.js";
import type { WalletDelivery } from "./wallet-store.js";

const DEADLINE_MS = 15_000, MAX_REPLY_BYTES = 1_024;
const route = /^\/delivery\/([A-Za-z0-9_-]{1,80})$/;
const tokenPattern = /^[0-9a-f]{64}$/;
interface DeliveryStore {
  authorizesDelivery(id: string, token: string): boolean;
  receiveDelivery(id: string, delivery: WalletDelivery): string;
}
const failure = (): Error => new Error("wallet delivery failed");
function headerCount(message: IncomingMessage, name: string): number {
  return message.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
}
function jsonHeaders(message: IncomingMessage, limit: number): void {
  if (message.rawHeaders.length > 64 || headerCount(message, "content-type") !== 1 || message.headers["content-type"] !== "application/json" ||
      message.headers["content-encoding"] !== undefined || headerCount(message, "content-length") > 1 ||
      (message.headers["content-length"] !== undefined && (!/^(0|[1-9][0-9]*)$/.test(message.headers["content-length"]) || BigInt(message.headers["content-length"]) > BigInt(limit)))) throw failure();
}
async function body(message: IncomingMessage, limit: number): Promise<string> {
  jsonHeaders(message, limit);
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of message) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > limit) throw failure();
    chunks.push(chunk);
  }
  // Preserve BOM so canonical JSON/ack comparison rejects those extra bytes.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
}
function acknowledgement(requestId: string, deliveryHash: string): string {
  return JSON.stringify({ version: 1, profile: WALLET_DELIVERY_PROFILE, kind: "stored", requestId, deliveryHash });
}

/** The supplied certificate authenticates the receiver. The per-request
 * bearer capability admits an inbox write; it never authorizes fulfillment. */
export function createWalletDeliveryServer(store: DeliveryStore, tls: { key: string; cert: string }): Server {
  const server = createServer({ ...tls, minVersion: "TLSv1.3", maxHeaderSize: 8_192, handshakeTimeout: DEADLINE_MS }, async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "close");
    const send = (status: number, text: string) => {
      if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(text); }
    };
    try {
      if (request.rawHeaders.length > 64) throw failure();
      const match = route.exec(request.url ?? "");
      if (request.method !== "POST" || !match) { send(404, '{"code":"REJECTED"}'); request.resume(); return; }
      const requestId = match[1]!, auth = request.headers.authorization;
      if (headerCount(request, "authorization") !== 1 || typeof auth !== "string" || !auth.startsWith("Bearer ") ||
          !tokenPattern.test(auth.slice(7)) || !store.authorizesDelivery(requestId, auth.slice(7))) {
        send(401, '{"code":"REJECTED"}'); request.resume(); return;
      }
      const frame = await body(request, MAX_WALLET_DELIVERY_BYTES), decoded = decodeWalletDelivery(frame);
      if (decoded.requestId !== requestId) throw failure();
      const expected = walletDeliveryHash(frame);
      // Synchronous durable storage commits before the reply can be emitted.
      if (store.receiveDelivery(requestId, decoded.delivery) !== expected) throw failure();
      send(200, acknowledgement(requestId, expected));
    } catch {
      // Do not expose storage errors, request data, receipts, or capabilities.
      send(400, '{"code":"REJECTED"}'); request.resume();
    }
  });
  // Absolute connection lifetime includes TLS, headers and streamed body;
  // progress cannot extend the deadline. One request per connection.
  server.on("connection", socket => {
    const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS); deadline.unref();
    socket.once("close", () => clearTimeout(deadline));
  });
  server.headersTimeout = DEADLINE_MS; server.requestTimeout = DEADLINE_MS;
  // Retain one excess header so overflow is rejected, not silently truncated.
  server.maxHeadersCount = 33; server.maxConnections = 16; server.maxRequestsPerSocket = 1;
  return server;
}

/** Endpoint and capability must arrive through an authenticated private
 * request channel. TLS proves the endpoint name, not a person's identity. */
export class WalletDeliveryClient {
  private readonly endpoint: URL;
  private readonly requestId: string;
  private readonly token: string;
  private readonly ca: string | undefined;
  constructor(endpoint: string, token: string, ca?: string) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new EncodingError("invalid wallet delivery endpoint"); }
    const match = route.exec(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !match ||
        url.href !== endpoint || !tokenPattern.test(token)) throw new EncodingError("invalid wallet delivery endpoint or capability");
    this.endpoint = url; this.requestId = match[1]!; this.token = token; this.ca = ca;
  }
  async deliver(domain: Uint8Array, delivery: WalletDelivery): Promise<string> {
    const frame = encodeWalletDelivery(this.requestId, domain, delivery), expected = walletDeliveryHash(frame);
    return new Promise<string>((resolve, reject) => {
      const request = httpsRequest(this.endpoint, { method: "POST", agent: false, rejectUnauthorized: true,
        minVersion: "TLSv1.3", ...(this.ca === undefined ? {} : { ca: this.ca }), maxHeaderSize: 8_192,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(frame), connection: "close" } });
      request.maxHeadersCount = 33;
      const deadline = setTimeout(() => request.destroy(failure()), DEADLINE_MS); deadline.unref();
      const done = () => clearTimeout(deadline);
      request.once("error", () => { done(); reject(failure()); });
      request.once("response", async response => {
        try {
          if (response.statusCode !== 200) throw failure();
          const text = await body(response, MAX_REPLY_BYTES);
          if (text !== acknowledgement(this.requestId, expected)) throw failure();
          done(); resolve(expected);
        } catch { done(); response.destroy(); request.destroy(); reject(failure()); }
      });
      request.once("socket", socket => {
        socket.once("secureConnect", () => {
          if (!(socket as TLSSocket).authorized) { request.destroy(failure()); return; }
          request.end(frame);
        });
      });
    });
  }
}
