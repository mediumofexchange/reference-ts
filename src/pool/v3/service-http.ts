// Node 24 loopback transport for an already locally activated reference journal.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { decodeRecord } from "./records.js";
import { V3OperatorJournal, V3StoreError } from "./store.js";
import { MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_REPLY_BYTES,
  parseV3ServiceCommand, replyFromReceipt, replyFromCommitment, servedFrames } from "./service-wire.js";

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

/** Evidence streams served at once, of the sixteen connections; and the slowest peer a stream waits for. */
const MAX_EVIDENCE_STREAMS = 8, MIN_EVIDENCE_BYTES_PER_MS = 64;

/** Bind to 127.0.0.1. The server also refuses non-loopback connections.
 * Credentials permit operations; protocol proofs/signatures remain authoritative.
 * Connection timeouts never cancel or roll back accepted journal operations. */
export function createV3Service(journal: V3OperatorJournal, credentials: V3ServiceCredentials): Server {
  const { walletToken, adminToken } = credentials;
  if (![walletToken, adminToken].every(token => typeof token === "string" && /^[0-9a-f]{64}$/.test(token)) || walletToken === adminToken) {
    throw new EncodingError("distinct 32-byte credentials required");
  }
  const domain = journal.configurationDomain;
  let streams = 0;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
    // One exchange per connection. A caller's verification blocks its event loop between requests, so an idle
    // connection this server has timed out meanwhile would be reused before the caller sees it closed.
    response.setHeader("connection", "close");
    const send = (status: number, value: unknown, maximum = MAX_V3_SERVICE_REPLY_BYTES) => {
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > maximum) throw new EncodingError("response too large");
      if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(body); }
    };
    // Bound request/response lifetime after headers, even while work is pending.
    // Journal work keeps its owner and can finish after the caller loses the reply.
    // Served evidence has no size to bound its time by: a write restarts the bound, within a minimum rate.
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
      // A multi-backing scope serves each holder's backing by name (C2.10.3). `after` is the sequence the
      // reader's evidence was served through; the journal then serves only what came after it.
      const asked = request.method === "GET" ? /^\/evidence\?backing=([0-9a-f]{64})&after=(0|[1-9][0-9]{0,19})$/.exec(request.url ?? "") : null;
      if (asked !== null) {
        const after = BigInt(asked[2]!);
        if (after >= 1n << 64n) throw new EncodingError("invalid served sequence");
        // Streams leave connections for commands: a slow reader cannot take them all.
        if (streams >= MAX_EVIDENCE_STREAMS) { request.resume(); send(409, { code: "BUSY" }); return; }
        streams++;
        try {
          const served = await journal.serve(hexToBytes(asked[1]!), after);
          request.resume();
          if (response.destroyed) return;
          response.setHeader("content-type", "application/octet-stream"); response.writeHead(200);
          // The parts are read from rows as the peer takes them. A failure after the headers ends the
          // connection short of the stream's end mark, which a receiver refuses; the server's owner is told
          // by an "evidenceError" event. A peer slower than the minimum rate is cut off.
          const started = Date.now(); let sent = 0;
          try {
            for await (const chunk of servedFrames(served)) {
              if (response.destroyed) return;
              if (!response.write(chunk)) await new Promise<void>(resolve => {
                const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
                response.once("drain", done); response.once("close", done);
              });
              sent += chunk.length;
              if (Date.now() - started > 15_000 + sent / MIN_EVIDENCE_BYTES_PER_MS) { response.destroy(); return; }
              timer.refresh();
            }
            response.end();
          } catch (error) { response.destroy(); server.emit("evidenceError", error); }
        } finally { streams--; }
        return;
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
