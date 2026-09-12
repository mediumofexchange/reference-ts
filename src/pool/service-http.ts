// Node 24 local service. The caller configures and activates PoolStore locally.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../bytes.js";
import { encodeCommitment } from "../commitment.js";
import { PoolError } from "./segment.js";
import { PoolStore, PoolStoreError } from "./store.js";
import {
  commandStatement, encodePoolServiceReply, parsePoolServiceCommand,
  replyFromCommitment, replyFromReceipt, encodePoolServiceView,
  POOL_SERVICE_PROFILE, MAX_POOL_SERVICE_REQUEST_BYTES, MAX_POOL_SERVICE_RESPONSE_BYTES,
} from "./service-wire.js";

export interface PoolServiceCredentials { walletToken: string; adminToken: string; }
function tokenMatches(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json" ||
      (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity")) {
    throw new EncodingError("expected uncompressed application/json");
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > MAX_POOL_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new EncodingError("invalid JSON or UTF-8"); }
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof EncodingError) return { status: 400, code: "INVALID" };
  if (error instanceof PoolError) return { status: 400, code: error.code };
  if (error instanceof PoolStoreError) {
    const status = ["CONFLICT", "BUSY", "STALE", "SCHEDULE", "FENCED"].includes(error.code) ? 409 :
      error.code === "UNSUPPORTED" ? 400 : 503;
    return { status, code: error.code };
  }
  return { status: 503, code: "UNAVAILABLE" };
}

/** Bind this returned server to 127.0.0.1. Remote clients are refused as well;
 * bearer credentials here authorize local operations, not protocol validity. */
export function createPoolService(store: PoolStore, credentials: PoolServiceCredentials): Server {
  const { walletToken, adminToken } = credentials;
  if (![walletToken, adminToken].every(value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) || walletToken === adminToken) {
    throw new EncodingError("distinct 32-byte credentials required");
  }
  const domain = store.configurationDomain;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const send = (status: number, value: unknown) => {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_POOL_SERVICE_RESPONSE_BYTES) throw new EncodingError("response too large");
      if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(json); }
    };
    const remote = request.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      request.resume(); send(403, { code: "LOCAL_ONLY" }); return;
    }
    const authCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === "authorization").length;
    const admin = authCount === 1 && tokenMatches(request.headers.authorization, adminToken);
    if (!admin && !(authCount === 1 && tokenMatches(request.headers.authorization, walletToken))) {
      request.resume(); send(401, { code: "UNAUTHORIZED" }); return;
    }
    try {
      if (request.method === "GET" && request.url === "/view") {
        const view = await store.summary();
        send(200, JSON.parse(encodePoolServiceView({ version: 1, profile: POOL_SERVICE_PROFILE,
          highestSignedSequence: view.highestSignedSequence.toString(),
          ...(view.latest === undefined ? {} : { latest: bytesToHex(encodeCommitment(view.latest)) }), evidence: "omitted" })));
        return;
      }
      if (request.method === "POST" && request.url === "/commands") {
        const command = parsePoolServiceCommand(await readBody(request));
        if (command.kind !== "submit" && !admin) { send(403, { code: "ADMIN_REQUIRED" }); return; }
        let reply;
        if (command.kind === "submit") {
          const decoded = commandStatement(command);
          if (compareBytes(decoded.domain, domain) !== 0) throw new EncodingError("wrong construction domain");
          reply = replyFromReceipt(await store.submit(decoded.statement));
        } else if (command.kind === "commit") reply = replyFromCommitment("committed", await store.commit(command.id));
        else reply = replyFromCommitment("published", await store.publish());
        send(200, JSON.parse(encodePoolServiceReply(reply))); return;
      }
      request.resume(); send(404, { code: "NOT_FOUND" });
    } catch (error) {
      request.resume(); const rejected = failure(error);
      // Never expose storage messages, credentials or arbitrary verifier errors.
      send(rejected.status, { code: rejected.code });
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  server.maxHeadersCount = 32; server.maxConnections = 16;
  return server;
}
