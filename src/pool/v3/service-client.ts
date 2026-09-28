import { bytesToHex as hex, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { decodeCommitment, verifyCommitment, type Commitment } from "../../venue-records.js";
import { identifierOf } from "../field.js";
import { decodeReceipt, verifyReceipt, type Receipt } from "./commitments.js";
import { referenceVenue, type VenueReference } from "./guard.js";
import { decodeRecord, statementHash } from "./records.js";
import { decodeV3ServicePackage, decodeV3ServiceReply, parseV3ServiceCommand, V3_SERVICE_PROFILE,
  MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_RESPONSE_BYTES, MAX_V3_SERVICE_REPLY_BYTES, type V3ServiceCommand } from "./service-wire.js";
import type { ServedPackage } from "./store.js";

const same = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;
function identifier(bytes: Uint8Array): Uint8Array {
  const own = copyUnshared(bytes); if (own.length !== 32) throw new EncodingError("expected a 32-byte service identity"); return own;
}
export interface ServiceIdentity { readonly domain: Uint8Array; readonly operator: Uint8Array; readonly reference: VenueReference }
export class V3ServiceClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "V3ServiceClientError"; }
}

/** Local operation credentials do not select protocol authority. The caller
 * independently holds the expected configuration domain, operator and reference
 * venue; finality still requires the existing reader and independent venue. */
export class V3ServiceClient {
  readonly #baseUrl: string;
  readonly #walletToken: string;
  readonly #adminToken: string | undefined;
  readonly #domain: Uint8Array;
  readonly #operator: Uint8Array;
  readonly #venue: Uint8Array;
  constructor(baseUrl: string, walletToken: string, expected: ServiceIdentity, adminToken?: string) {
    let url: URL; try { url = new URL(baseUrl); } catch { throw new EncodingError("invalid service URL"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || !/^[0-9a-f]{64}$/.test(walletToken) ||
        (adminToken !== undefined && (!/^[0-9a-f]{64}$/.test(adminToken) || adminToken === walletToken))) {
      throw new EncodingError("local URL and distinct 32-byte credentials required");
    }
    this.#baseUrl = url.href; this.#walletToken = walletToken; this.#adminToken = adminToken;
    this.#domain = identifier(expected.domain); this.#operator = identifier(expected.operator);
    this.#venue = referenceVenue(structuredClone(expected.reference)).id;
  }
  get baseUrl(): string { return this.#baseUrl; }
  private async request(path: string, command?: V3ServiceCommand, admin = false): Promise<unknown> {
    const token = admin ? this.#adminToken : this.#walletToken;
    if (token === undefined) throw new V3ServiceClientError(403, "ADMIN_REQUIRED", "admin credential required");
    const body = command === undefined ? undefined : JSON.stringify(parseV3ServiceCommand(command));
    if (body !== undefined && Buffer.byteLength(body) > MAX_V3_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
    const maximum = command === undefined ? MAX_V3_SERVICE_RESPONSE_BYTES : MAX_V3_SERVICE_REPLY_BYTES;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(new URL(path, this.#baseUrl), { method: command === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-encoding": "identity" } });
      if ((response.status >= 300 && response.status < 400) || response.headers.get("content-type") !== "application/json" ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new EncodingError("unexpected service response");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) throw new EncodingError("response too large");
      if (response.body === null) throw new EncodingError("missing service response");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length; if (size > maximum) throw new EncodingError("response too large");
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
      catch { throw new EncodingError("invalid service JSON or UTF-8"); }
      if (!response.ok) {
        const code = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["code"] : undefined;
        throw new V3ServiceClientError(response.status, typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "UNAVAILABLE", "service request failed");
      }
      return value;
    } finally { clearTimeout(timer); abort.abort(); }
  }
  /** Authenticates ordinary acceptance in the record's source segment, not
   * adoption into another segment. Exact retries can attest different original
   * proof bytes; this method binds statement identity, not the retry's proof. */
  async submit(recordBytes: Uint8Array): Promise<Receipt> {
    const bytes = copyUnshared(recordBytes), record = decodeRecord(bytes);
    if (record.kind === 7 || !same(record.domain, this.#domain)) throw new EncodingError("wrong submission domain or kind");
    const p = record.publicInputs, authority = { domain: this.#domain, operator: this.#operator,
      segment: identifierOf(p[2]!, p[3]!), scopeRoot: p[4]! };
    const reply = decodeV3ServiceReply(await this.request("/commands", {
      version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: hex(bytes) }));
    if (reply.kind !== "accepted") throw new EncodingError("unexpected service reply");
    const receipt = decodeReceipt(hexToBytes(reply.receipt));
    if (!verifyReceipt(authority, receipt) || !same(receipt.statementHash, statementHash(record))) {
      throw new EncodingError("receipt does not authenticate the submitted statement");
    }
    return receipt;
  }
  private commitment(value: unknown, kind: "committed" | "published"): Commitment {
    const reply = decodeV3ServiceReply(value);
    if (reply.kind !== kind) throw new EncodingError("unexpected service reply");
    const result = decodeCommitment(hexToBytes(reply.commitment));
    if (!verifyCommitment(result) || !same(result.operator, this.#operator)) throw new EncodingError("wrong commitment authority");
    return result;
  }
  async commit(id: string): Promise<Commitment> {
    return this.commitment(await this.request("/commands", { version: 1, profile: V3_SERVICE_PROFILE, kind: "commit", id }, true), "committed");
  }
  /** Publishes the latest outbox. An intervening commit can change that target. */
  async publish(): Promise<Commitment> {
    return this.commitment(await this.request("/commands", { version: 1, profile: V3_SERVICE_PROFILE, kind: "publish" }, true), "published");
  }
  /** Bounded evidence transport only. Metadata never selects the reader's
   * authority, judging index, finality, current balance or spendability. */
  async package(backing: Uint8Array): Promise<ServedPackage> {
    const ownBacking = identifier(backing), result = decodeV3ServicePackage(await this.request(`/package?backing=${hex(ownBacking)}`));
    const s = result.selection;
    if (!same(s.domain, this.#domain) || !same(s.operator, this.#operator) || !same(s.venue, this.#venue) || !same(s.backing, ownBacking)) {
      throw new EncodingError("wrong service package context");
    }
    return result;
  }
}
