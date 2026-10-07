// Node 24 loopback transport for an already locally activated reference journal.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { V3OperatorJournal, V3StoreError, type ServedEvidence } from "./store.js";
import { MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_REPLY_BYTES,
  parseV3ServiceCommand, replyFromReceipt, replyFromCommitment, servedFrames, servedTooSlow } from "./service-wire.js";

/** Without an admin credential the service is a holders' listener (M12a): submission and evidence only, for an onion
 * service's port, so the operator's own commands never face the network that reaches it. */
export interface V3ServiceCredentials { readonly walletToken: string; readonly adminToken?: string | undefined }
/** Whether the request carries `token` as its one Authorization header: Node keeps only the first of several. */
function bearer(request: IncomingMessage, token: string): boolean {
  if (request.rawHeaders.filter((header, i) => i % 2 === 0 && header.toLowerCase() === "authorization").length !== 1) return false;
  const actual = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
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

/** Evidence streams served at once, of the sixteen connections. */
const MAX_EVIDENCE_STREAMS = 8;

/** What serves evidence by the one wire: an operator's journal, or a replica's kept evidence (M12b). `after` is a
 * sequence of the operator's; a source that holds no selection for the backing refuses as the journal does. */
export interface V3EvidenceSource { serve(backing: Uint8Array, after: bigint): Promise<ServedEvidence> }

/** Every loopback peer: behind an onion service, the Tor daemon. */
const LOOPBACK: readonly string[] = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
/** A listener's lifetime bounds on a request and its reply, shared by the operator's and a replica's. */
function bounded(server: Server): Server {
  server.headersTimeout = 10_000; server.requestTimeout = 15_000;
  server.maxHeadersCount = 32; server.maxConnections = 16;
  return server;
}
/** The reply helpers both listeners use: JSON headers, one exchange per connection and the bound on its lifetime. A
 * caller's verification blocks its event loop between requests, so an idle connection the server has timed out
 * meanwhile would be reused before the caller sees it closed. Journal work keeps its owner and can finish after the
 * caller loses the reply; served evidence has no size to bound its time by: a write restarts the bound. */
function exchange(response: ServerResponse) {
  response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
  response.setHeader("connection", "close");
  const send = (status: number, value: unknown, maximum = MAX_V3_SERVICE_REPLY_BYTES) => {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maximum) throw new EncodingError("response too large");
    if (!response.destroyed && !response.writableEnded) { response.writeHead(status); response.end(body); }
  };
  const timer = setTimeout(() => response.destroy(), 15_000);
  response.once("close", () => clearTimeout(timer));
  return { send, timer };
}
/** The one evidence route, `GET /evidence?backing=<hex>&after=<n>`: undefined where the request is another, else
 * once the stream has ended or been cut off. A multi-backing scope serves each holder's backing by name (C2.10.3);
 * `after` is the sequence the reader's evidence was served through, and only what came after it is served. */
function evidenceRoute(server: Server, source: V3EvidenceSource, streams: { count: number }, request: IncomingMessage, response: ServerResponse,
  send: (status: number, value: unknown) => void, timer: NodeJS.Timeout): Promise<void> | undefined {
  const asked = request.method === "GET" ? /^\/evidence\?backing=([0-9a-f]{64})&after=(0|[1-9][0-9]{0,19})$/.exec(request.url ?? "") : null;
  if (asked === null) return undefined;
  return (async () => {
    const after = BigInt(asked[2]!);
    if (after >= 1n << 64n) throw new EncodingError("invalid served sequence");
    // Streams leave connections for commands: a slow reader cannot take them all.
    if (streams.count >= MAX_EVIDENCE_STREAMS) { request.resume(); send(409, { code: "BUSY" }); return; }
    streams.count++;
    try {
      const served = await source.serve(hexToBytes(asked[1]!), after);
      request.resume();
      if (response.destroyed) return;
      response.setHeader("content-type", "application/octet-stream"); response.writeHead(200);
      // The parts are read from rows as the peer takes them. A failure after the headers ends the
      // connection short of the stream's end mark, which a receiver refuses; the server's owner is told
      // by an "evidenceError" event. A peer slower than the minimum rate is cut off: only the time its writes wait for
      // the peer counts, never the time the source takes to read its rows.
      let sent = 0, waited = 0;
      try {
        for await (const chunk of servedFrames(served)) {
          if (response.destroyed) return;
          if (!response.write(chunk)) {
            const asked = Date.now();
            await new Promise<void>(resolve => {
              const done = (): void => { response.off("drain", done); response.off("close", done); resolve(); };
              response.once("drain", done); response.once("close", done);
            });
            waited += Date.now() - asked;
          }
          sent += chunk.length;
          if (servedTooSlow(waited, sent)) { response.destroy(); return; }
          timer.refresh();
        }
        response.end();
      } catch (error) { response.destroy(); server.emit("evidenceError", error); }
    } finally { streams.count--; }
  })();
}

/** Bind to 127.0.0.1. The server also refuses non-loopback connections. Behind an onion service every peer is the
 * loopback Tor daemon, so that listener takes no admin credential and has its own sixteen connections.
 * Credentials permit operations; protocol proofs/signatures remain authoritative.
 * Connection timeouts never cancel or roll back accepted journal operations. */
export function createV3Service(journal: V3OperatorJournal, credentials: V3ServiceCredentials): Server {
  const { walletToken, adminToken } = credentials;
  if (![walletToken, ...(adminToken === undefined ? [] : [adminToken])].every(token => typeof token === "string" && /^[0-9a-f]{64}$/.test(token)) ||
      walletToken === adminToken) {
    throw new EncodingError("distinct 32-byte credentials required");
  }
  // The journal's construction reads every command and reply (slice 14 M14g3).
  const domain = journal.configurationDomain, construction = journal.construction;
  const streams = { count: 0 };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const { send, timer } = exchange(response);
    if (!LOOPBACK.includes(request.socket.remoteAddress ?? "")) {
      request.resume(); send(403, { code: "LOCAL_ONLY" }); return;
    }
    const admin = adminToken !== undefined && bearer(request, adminToken);
    if (!admin && !bearer(request, walletToken)) {
      request.resume(); send(401, { code: "UNAUTHORIZED" }); return;
    }
    try {
      const streamed = evidenceRoute(server, journal, streams, request, response, send, timer);
      if (streamed !== undefined) { await streamed; return; }
      if (request.method === "POST" && request.url === "/commands") {
        const command = parseV3ServiceCommand(await readBody(request), construction);
        if (command.kind !== "submit" && !admin) { send(403, { code: "ADMIN_REQUIRED" }); return; }
        let reply;
        if (command.kind === "submit") {
          const bytes = hexToBytes(command.record);
          if (compareBytes(construction.view(construction.decode(bytes), () => undefined).domain, domain) !== 0) {
            throw new EncodingError("wrong construction domain");
          }
          reply = replyFromReceipt(await journal.submit(bytes), construction);
        } else if (command.kind === "commit") reply = replyFromCommitment("committed", await journal.commit(command.id));
        else reply = replyFromCommitment("published", await journal.publish());
        send(200, reply); return;
      }
      request.resume(); send(404, { code: "NOT_FOUND" });
    } catch (error) {
      request.resume(); const rejected = failure(error); send(rejected.status, { code: rejected.code });
    }
  });
  return bounded(server);
}

/**
 * A replica's listener (slice 12 M12b): the evidence route alone, on a loopback port, with no credential. Published
 * evidence is retrievable by a stranger (Construction), so it gates nothing and identifies nobody; every other request
 * is `NOT_FOUND`. Behind an onion service every peer is the loopback Tor daemon. The listener's bounds are the
 * operator's: sixteen connections, eight streams, a minimum rate.
 */
export function createV3EvidenceService(source: V3EvidenceSource): Server {
  const streams = { count: 0 };
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const { send, timer } = exchange(response);
    if (!LOOPBACK.includes(request.socket.remoteAddress ?? "")) { request.resume(); send(403, { code: "LOCAL_ONLY" }); return; }
    try {
      const streamed = evidenceRoute(server, source, streams, request, response, send, timer);
      if (streamed !== undefined) { await streamed; return; }
      request.resume(); send(404, { code: "NOT_FOUND" });
    } catch (error) {
      request.resume(); const rejected = failure(error); send(rejected.status, { code: rejected.code });
    }
  });
  return bounded(server);
}

/** A relay's refusal of a publication file: the status and code its listener answers. */
export interface RelayRefusal { readonly status: number; readonly code: string }
/**
 * A relay's listener (slice 12 M12c): `POST /publications` alone, on a loopback port, under the relay's one credential
 * (never per holder: one per holder would link that holder's acts, which a third party's relay exists to part from
 * its funding). `take` judges the publication file and publishes it, answering its reply; it is told whether the
 * request is gone (its connection closed or timed out), so work queued for nobody spends nothing. `refused` names a thrown
 * refusal's status and code, and anything else is `UNAVAILABLE`, told to the owner by a "relayError" event. Behind an
 * onion service every peer is the loopback Tor daemon. The listener's bounds are the operator's and the replica's.
 */
export function createRelayService(token: string, take: (file: unknown, gone: () => boolean) => Promise<object>,
  refused: (error: unknown) => RelayRefusal | undefined): Server {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw new EncodingError("a 32-byte credential required");
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const { send } = exchange(response);
    if (!LOOPBACK.includes(request.socket.remoteAddress ?? "")) { request.resume(); send(403, { code: "LOCAL_ONLY" }); return; }
    if (!bearer(request, token)) { request.resume(); send(401, { code: "UNAUTHORIZED" }); return; }
    try {
      if (request.method !== "POST" || request.url !== "/publications") { request.resume(); send(404, { code: "NOT_FOUND" }); return; }
      send(200, await take(await readBody(request), () => response.destroyed || response.writableEnded));
    } catch (error) {
      request.resume();
      const known = error instanceof EncodingError ? { status: 400, code: "INVALID" } : refused(error);
      if (known === undefined) server.emit("relayError", error);
      const rejected = known ?? { status: 503, code: "UNAVAILABLE" };
      send(rejected.status, { code: rejected.code });
    }
  });
  return bounded(server);
}
