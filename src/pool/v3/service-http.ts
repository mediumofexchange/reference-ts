// Node 24 loopback transport for an already locally activated reference journal.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { decodeRecord } from "./records.js";
import { V3OperatorJournal, V3StoreError } from "./store.js";
import { MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_RESPONSE_BYTES, MAX_V3_SERVICE_REPLY_BYTES,
  parseV3ServiceCommand, replyFromReceipt, replyFromCommitment, packageReply } from "./service-wire.js";

export interface V3ServiceCredentials { readonly walletToken: string; readonly adminToken: string }
function matches(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json" ||
      ![undefined, "identity"].includes(request.headers["content-encoding"])) throw new EncodingError("expected uncompressed JSON");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_V3_SERVICE_REQUEST_BYTES)) {
    throw new EncodingError("request too large");
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > MAX_V3_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new EncodingError("invalid JSON or UTF-8"); }
}
function failure(error: unknown): { status: number; code: string } {
  if (error instanceof EncodingError) return { status: 400, code: "INVALID" };
  if (error instanceof V3StoreError) return {
    status: ["CONFLICT", "BUSY", "STALE", "SCHEDULE", "FENCED"].includes(error.code) ? 409 :
      ["UNSUPPORTED", "REFUSED"].includes(error.code) ? 400 : 503, code: error.code,
  };
  return { status: 503, code: "UNAVAILABLE" };
}

/** Bind to 127.0.0.1. The server also refuses non-loopback connections.
 * Credentials permit operations; protocol proofs/signatures remain authoritative.
 * Connection timeouts never cancel or roll back accepted journal operations. */
export function createV3Service(journal: V3OperatorJournal, credentials: V3ServiceCredentials): Server {
  const { walletToken, adminToken } = credentials;
  if (![walletToken, adminToken].every(token => typeof token === "string" && /^[0-9a-f]{64}$/.test(token)) || walletToken === adminToken) {
    throw new EncodingError("distinct 32-byte credentials required");
  }
  const domain = journal.configurationDomain;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    const send = (status: number, value: unknown, maximum = MAX_V3_SERVICE_REPLY_BYTES) => {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > maximum) throw new EncodingError("response too large");
      if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(body); }
    };
    // Bound request/response lifetime after headers, even while work is pending.
    // Journal work keeps its owner and can finish after the caller loses the reply.
    const timer = setTimeout(() => response.destroy(), 15_000);
    response.once("close", () => clearTimeout(timer));
    const remote = request.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? "")) {
      request.resume(); send(403, { code: "LOCAL_ONLY" }); return;
    }
    const count = request.rawHeaders.filter((header, i) => i % 2 === 0 && header.toLowerCase() === "authorization").length;
    const admin = count === 1 && matches(request.headers.authorization, adminToken);
    if (!admin && !(count === 1 && matches(request.headers.authorization, walletToken))) {
      request.resume(); send(401, { code: "UNAUTHORIZED" }); return;
    }
    try {
      if (request.method === "GET" && request.url === "/package") {
        send(200, packageReply(await journal.package()), MAX_V3_SERVICE_RESPONSE_BYTES); return;
      }
      if (request.method === "POST" && request.url === "/commands") {
        const command = parseV3ServiceCommand(await readBody(request));
        if (command.kind !== "submit" && !admin) { send(403, { code: "ADMIN_REQUIRED" }); return; }
        let reply;
        if (command.kind === "submit") {
          const bytes = hexToBytes(command.record);
          if (compareBytes(decodeRecord(bytes).domain, domain) !== 0) throw new EncodingError("wrong construction domain");
          reply = replyFromReceipt(await journal.submit(bytes));
        } else if (command.kind === "commit") reply = replyFromCommitment("committed", await journal.commit(command.id));
        else reply = replyFromCommitment("published", await journal.publish());
        send(200, reply); return;
      }
      request.resume(); send(404, { code: "NOT_FOUND" });
    } catch (error) {
      request.resume(); const rejected = failure(error); send(rejected.status, { code: rejected.code });
    }
  });
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  server.maxHeadersCount = 32; server.maxConnections = 16;
  return server;
}
