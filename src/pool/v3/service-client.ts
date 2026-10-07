import { bytesToHex as hex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { decodeCommitment, verifyCommitment, type Commitment } from "../../venue-records.js";
import { POOL_V3, type Construction, type OperatorReceipt } from "./construction.js";
import { EVIDENCE_QUOTA, wholePackage, type EvidenceStore } from "./evidence-store.js";
import { referenceVenue, type VenueReference } from "./guard.js";
import { PackageLimitError } from "./package.js";
import { decodeV3ServiceReply, parseV3ServiceCommand, readServed, V3_SERVICE_PROFILE,
  MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_REPLY_BYTES, type V3ServiceCommand } from "./service-wire.js";
import type { ServedPackage } from "./store.js";

const same = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;
function identifier(bytes: Uint8Array): Uint8Array {
  const own = copyUnshared(bytes); if (own.length !== 32) throw new EncodingError("expected a 32-byte service identity"); return own;
}
/** What the caller expects of the service: its operator, its reference venue and the construction its scope declares
 * (pool-v3's by default, or lit-v1's: slice 14 M14g3). */
export interface ServiceIdentity { readonly operator: Uint8Array; readonly reference: VenueReference; readonly construction?: Construction | undefined }
export class V3ServiceClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "V3ServiceClientError"; }
}
/** A response body's chunks, read while the connection is held. */
async function* chunksOf(response: Response): AsyncIterable<Uint8Array> {
  if (response.body === null) throw new EncodingError("missing service response");
  const reader = response.body.getReader();
  try {
    for (;;) { const part = await reader.read(); if (part.done) return; yield part.value; }
  } finally { reader.releaseLock(); }
}
/** A whole JSON body of at most `maximum` bytes. */
async function json(response: Response, maximum: number): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum)) throw new EncodingError("response too large");
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of chunksOf(response)) {
    size += chunk.length; if (size > maximum) throw new EncodingError("response too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new EncodingError("invalid service JSON or UTF-8"); }
}
function refusal(status: number, value: unknown): V3ServiceClientError {
  const code = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["code"] : undefined;
  return new V3ServiceClientError(status, typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "UNAVAILABLE", "service request failed");
}

/** Local operation credentials do not select protocol authority. The caller
 * independently holds the expected operator, reference venue and construction; the
 * domain is that construction's configuration (pool-v3 §11.4's adopted one, or
 * lit-v1's), never the service's. Records, receipts and packages are read through
 * that construction. Finality still requires the existing reader and independent venue. */
export class V3ServiceClient {
  readonly #baseUrl: string;
  readonly #walletToken: string;
  readonly #adminToken: string | undefined;
  readonly #construction: Construction;
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
    this.#construction = expected.construction ?? POOL_V3 as Construction;
    this.#domain = this.#construction.reader.domain(); this.#operator = identifier(expected.operator);
    this.#venue = referenceVenue(structuredClone(expected.reference)).id;
  }
  get baseUrl(): string { return this.#baseUrl; }
  /** One exchange. `read` is given the response while the connection is held, and a call that restarts the
   * ten-second bound: a command's reply is bounded whole, a stream between its chunks. */
  private async exchange<T>(path: string, token: string, body: string | undefined, type: string,
    read: (response: Response, progress: () => void) => Promise<T>): Promise<T> {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await fetch(new URL(path, this.#baseUrl), { method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "accept-encoding": "identity" } });
      // A refusal is a bounded JSON reply on every route.
      if ((response.status >= 300 && response.status < 400) || response.headers.get("content-type") !== (response.ok ? type : "application/json") ||
          ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new EncodingError("unexpected service response");
      if (!response.ok) throw refusal(response.status, await json(response, MAX_V3_SERVICE_REPLY_BYTES));
      return await read(response, () => { timer.refresh(); });
    } finally { clearTimeout(timer); abort.abort(); }
  }
  private async request(path: string, command: V3ServiceCommand, admin = false): Promise<unknown> {
    const token = admin ? this.#adminToken : this.#walletToken;
    if (token === undefined) throw new V3ServiceClientError(403, "ADMIN_REQUIRED", "admin credential required");
    const body = JSON.stringify(parseV3ServiceCommand(command, this.#construction));
    if (Buffer.byteLength(body) > MAX_V3_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
    return this.exchange(path, token, body, "application/json", response => json(response, MAX_V3_SERVICE_REPLY_BYTES));
  }
  /** Authenticates ordinary acceptance in the record's source segment, not
   * adoption into another segment. Exact retries can attest different original
   * proof bytes; this method binds statement identity, not the retry's proof. */
  async submit(recordBytes: Uint8Array): Promise<OperatorReceipt> {
    const c = this.#construction, bytes = copyUnshared(recordBytes), record = c.decode(bytes);
    // A request (kind 7) is no segment admission, and no view is built of one.
    const view = c.kind(record) === 7 ? undefined : c.view(record, () => undefined);
    if (view === undefined || !same(view.domain, this.#domain)) throw new EncodingError("wrong submission domain or kind");
    const authority = { domain: this.#domain, operator: this.#operator, segment: view.segment, scopeRoot: view.scope };
    const reply = decodeV3ServiceReply(await this.request("/commands", {
      version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: hex(bytes) }), c);
    if (reply.kind !== "accepted") throw new EncodingError("unexpected service reply");
    const codec = c.journal.receipts, receipt = codec.decode(hexToBytes(reply.receipt));
    if (!codec.verify(authority, receipt) || !same(receipt.statementHash, view.identity)) {
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

  /** The served stream for `backing` after sequence `after`, read by `take` while the connection is held, within
   * `maxBytes` of response. The selection must name the pinned context, and the read's own package must
   * carry the commitment it names, signed by the expected operator: so a sequence this client records as
   * served is one that operator signed. */
  private async served<T>(backing: Uint8Array, after: bigint, maxBytes: bigint,
    take: Parameters<typeof readServed<T>>[1]): Promise<{ readonly served: ServedPackage; readonly taken: T }> {
    if (typeof maxBytes !== "bigint" || maxBytes < 0n) throw new TypeError("invalid evidence budget");
    return this.exchange(`/evidence?backing=${hex(backing)}&after=${after}`, this.#walletToken, undefined, "application/octet-stream", (response, progress) => {
      const bounded = async function* (): AsyncIterable<Uint8Array> {
        let total = 0n;
        for await (const chunk of chunksOf(response)) {
          progress(); total += BigInt(chunk.length);
          if (total > maxBytes) throw new PackageLimitError("served evidence exceeds the reader's budget");
          yield chunk;
        }
      };
      return readServed(bounded(), (served, parts) => {
        const s = served.selection;
        if (!same(s.domain, this.#domain) || !same(s.operator, this.#operator) || !same(s.venue, this.#venue) || !same(s.backing, backing)) {
          throw new EncodingError("wrong service package context");
        }
        const signed = this.#construction.reader.package.decodeEvidencePackage(served.package).filter(item => item.kind === 2).map(item => decodeCommitment(item.payload));
        if (signed.length !== 1 || !verifyCommitment(signed[0]!) || !same(signed[0]!.operator, s.operator) || signed[0]!.sequence !== s.sequence ||
            !same(signed[0]!.root, s.root) || s.sequence >= 1n << 63n) throw new EncodingError("wrong commitment authority");
        return take(served, parts);
      });
    });
  }

  /**
   * Bring `evidence`, the party's own evidence store, up to the service's latest served commitment for
   * `backing` (pool-v3 §14, incremental retrieval). The store records the sequence this service's evidence
   * was kept through, and the request names it, so the service sends only later objects and, for each trail,
   * its head and the records after what the store holds. Where those parts do not assemble over what the
   * store holds, everything is fetched once more from nothing; `full` asks for that outright, which also
   * replaces retained evidence that storage damaged. Returns the selection and the read's own package (the
   * configuration and the selected commitment) to read with that store.
   *
   * Evidence transport only. Metadata never selects the reader's authority, judging index, finality,
   * current balance or spendability; what is kept is authenticated when a read uses it. `maxBytes` bounds
   * one response (by default the store's file quota).
   */
  async sync(backing: Uint8Array, evidence: EvidenceStore, options: { readonly full?: boolean; readonly maxBytes?: bigint } = {}): Promise<ServedPackage> {
    if (evidence.construction.namespace.name !== this.#construction.namespace.name) throw new TypeError("an evidence store of another construction");
    const ownBacking = identifier(backing), source = concatBytes(this.#domain, this.#venue, this.#operator);
    const receive = (after: bigint) => this.served(ownBacking, after, options.maxBytes ?? EVIDENCE_QUOTA.file, (_, parts) => evidence.take(parts));
    const after = options.full === true ? 0n : evidence.suppliedThrough(source);
    let result = await receive(after);
    if (!result.taken && after > 0n) result = await receive(0n);
    if (!result.taken) throw new EncodingError("served evidence does not assemble");
    evidence.supplied(source, result.served.selection.sequence);
    return result.served;
  }

  /** `sync` from nothing into one §12 package held in memory, for a caller that reads a whole package. The
   * response is bounded by `maxBytes` (by default an in-memory store's quota), so it does not serve a long history;
   * assembling it holds about three times what was received at its peak (`wholePackage`). */
  async package(backing: Uint8Array, maxBytes: bigint = EVIDENCE_QUOTA.memory): Promise<ServedPackage> {
    const result = await this.served(identifier(backing), 0n, maxBytes, (served, parts) => wholePackage(served.package, parts, this.#construction));
    return { selection: result.served.selection, package: result.taken };
  }
}
