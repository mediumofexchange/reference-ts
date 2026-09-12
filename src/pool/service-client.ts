import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../bytes.js";
import { decodeCommitment, type Commitment } from "../commitment.js";
import type { PoolReceipt } from "./receipt.js";
import { decodeStatement, encodeStatement, statementHash, type Statement } from "./statement.js";
import {
  decodePoolServiceReply, decodePoolServiceView, parsePoolServiceCommand, replyReceipt,
  POOL_SERVICE_PROFILE, MAX_POOL_SERVICE_REQUEST_BYTES, MAX_POOL_SERVICE_RESPONSE_BYTES,
  type PoolServiceView, type PoolServiceCommand,
} from "./service-wire.js";

export class PoolServiceClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "PoolServiceClientError"; }
}
/** Framing client for a trusted local service. Callers still verify receipts
 * against their own authority and obtain independently witnessed finality. */
export class PoolServiceClient {
  get baseUrl(): string { return this.#baseUrl; }
  readonly #baseUrl: string;
  readonly #walletToken: string;
  readonly #adminToken: string | undefined;
  constructor(baseUrl: string, walletToken: string, adminToken?: string) {
    let url: URL; try { url = new URL(baseUrl); } catch { throw new EncodingError("invalid service URL"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        !/^[0-9a-f]{64}$/.test(walletToken) || (adminToken !== undefined && (!/^[0-9a-f]{64}$/.test(adminToken) || adminToken === walletToken))) {
      throw new EncodingError("local URL and distinct 32-byte credentials required");
    }
    this.#baseUrl = url.href; this.#walletToken = walletToken; this.#adminToken = adminToken;
  }
  private async request(path: string, command?: PoolServiceCommand, admin = false): Promise<unknown> {
    const token = admin ? this.#adminToken : this.#walletToken;
    if (token === undefined) throw new PoolServiceClientError(403, "ADMIN_REQUIRED", "admin credential required");
    const body = command === undefined ? undefined : JSON.stringify(parsePoolServiceCommand(command));
    if (body !== undefined && Buffer.byteLength(body) > MAX_POOL_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
    const abort = new AbortController(); const deadline = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(new URL(path, this.#baseUrl), { method: command === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-encoding": "identity" } });
      if (response.status >= 300 && response.status < 400 || response.headers.get("content-type") !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new EncodingError("unexpected service response");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_POOL_SERVICE_RESPONSE_BYTES)) throw new EncodingError("response too large");
      if (response.body === null) throw new EncodingError("missing service response");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > MAX_POOL_SERVICE_RESPONSE_BYTES) throw new EncodingError("response too large");
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
      catch { throw new EncodingError("invalid service JSON or UTF-8"); }
      if (!response.ok) {
        const code = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["code"] : undefined;
        throw new PoolServiceClientError(response.status, typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "UNAVAILABLE", "service request failed");
      }
      return value;
    } finally { clearTimeout(deadline); abort.abort(); }
  }
  async submit(input: { readonly domain: Uint8Array; readonly statement: Statement }): Promise<PoolReceipt> {
    const frame = encodeStatement(input.domain, input.statement), own = decodeStatement(frame);
    const reply = decodePoolServiceReply(await this.request("/commands", { version: 1, profile: POOL_SERVICE_PROFILE,
      kind: "submit", statement: bytesToHex(frame) }));
    if (reply.kind !== "accepted") throw new EncodingError("unexpected service reply");
    const receipt = replyReceipt(reply);
    if (compareBytes(receipt.domain, own.domain) !== 0 ||
        compareBytes(receipt.statementHash, statementHash(own.domain, own.statement.kind, own.statement.publicInputs)) !== 0) {
      throw new EncodingError("receipt does not name the submitted statement");
    }
    return receipt;
  }
  async commit(id: string): Promise<Commitment> {
    const reply = decodePoolServiceReply(await this.request("/commands", { version: 1, profile: POOL_SERVICE_PROFILE, kind: "commit", id }, true));
    if (reply.kind !== "committed") throw new EncodingError("unexpected service reply");
    return decodeCommitment(hexToBytes(reply.commitment));
  }
  async publish(): Promise<Commitment> {
    const reply = decodePoolServiceReply(await this.request("/commands", { version: 1, profile: POOL_SERVICE_PROFILE, kind: "publish" }, true));
    if (reply.kind !== "published") throw new EncodingError("unexpected service reply");
    return decodeCommitment(hexToBytes(reply.commitment));
  }
  async view(): Promise<PoolServiceView> { return decodePoolServiceView(await this.request("/view")); }
}
