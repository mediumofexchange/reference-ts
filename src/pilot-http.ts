// Loopback transport. Wallet credentials cannot register roots or advance time.
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { PilotStore, PilotError } from "./pilot-store.js";
import { hex, parsePilotCommand } from "./pilot-wire.js";

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json") throw new PilotError("INVALID", "expected application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > 32_768) throw new PilotError("LIMIT", "request exceeds 32 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Caller binds the returned server to loopback. Use an authenticated encrypted
 * deployment transport before exposing the pilot beyond one trusted machine. */
export function createPilotServer(store: PilotStore, credentials: { walletToken: string; adminToken: string }) {
  if (!/^[0-9a-f]{64}$/.test(credentials.walletToken) || !/^[0-9a-f]{64}$/.test(credentials.adminToken) ||
      credentials.walletToken === credentials.adminToken) throw new PilotError("INVALID", "distinct 32-byte credentials required");
  // Copy primitive credentials; subsequent caller mutation cannot change authority.
  const { walletToken, adminToken } = credentials;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
    const admin = tokenMatches(request.headers.authorization, adminToken);
    if (!admin && !tokenMatches(request.headers.authorization, walletToken)) {
      request.resume(); send(401, { code: "UNAUTHORIZED" }); return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/view") {
        const name = url.searchParams.get("backing");
        send(200, store.view(name === null ? undefined : [hex(name, 32, 32)])); return;
      }
      if (request.method === "GET" && url.pathname === "/nonce") {
        send(200, { nonce: store.nextNonce(hex(url.searchParams.get("backing"), 32, 32),
          hex(url.searchParams.get("signer"), 32, 32)).toString() }); return;
      }
      if (request.method === "POST" && url.pathname === "/commands") {
        const command = parsePilotCommand(await body(request));
        if (command.kind !== "submit" && !admin) { send(403, { code: "ADMIN_REQUIRED" }); return; }
        send(200, store.execute(command)); return;
      }
      request.resume(); send(404, { code: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof PilotError) {
        send(error.code === "CONFLICT" ? 409 : error.code === "STORAGE" ? 503 : 400,
          { code: error.code, message: error.message });
      } else if (error instanceof SyntaxError || (error instanceof Error &&
          ["EncodingError", "LedgerError", "NonceError", "SequencerError"].includes(error.constructor.name))) {
        send(400, { code: "INVALID", message: error.message });
      } else {
        // Storage/programming errors are not reported as accepted operations.
        send(503, { code: "UNAVAILABLE" });
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 32;
  return server;
}
