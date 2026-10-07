import { bytesToHex as hex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { decodeCommitment, verifyCommitment, type Commitment } from "../../venue-records.js";
import { POOL_V3, type Construction, type OperatorReceipt } from "./construction.js";
import { EVIDENCE_QUOTA, wholePackage, type EvidenceStore } from "./evidence-store.js";
import { referenceVenue, type VenueReference } from "./guard.js";
import { PackageLimitError } from "./package.js";
import { decodeV3ServiceReply, parseV3ServiceCommand, readServed, servedTooSlow, V3_SERVICE_PROFILE,
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
/** A v3 onion service's host: 56 base32 characters, the last its version byte's (3). Tor checks the checksum. */
const ONION_HOST = /^[a-z2-7]{55}d\.onion$/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const proxyRefusal = (message: string) => new V3ServiceClientError(0, "PROXY", message);
const PROXY_UNREACHABLE: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH", "EHOSTUNREACH"]);
/** Whether `NO_PROXY` exempts `url`, as Node 24's bundled undici (`EnvHttpProxyAgent`, 7.29.1) matches it: entries split
 * on commas and whitespace, a lone `*` exempts every host, `.x` and `*.x` read as `x`, which matches the host and its
 * subdomains, and an entry's `:port` limits it to that port. */
export function proxyExempts(url: URL, noProxy: string): boolean {
  const entries = noProxy.split(/[,\s]/).filter(entry => entry !== "").map(entry => {
    const parsed = /^(.+):(\d+)$/.exec(entry);
    return { host: (parsed ? parsed[1]! : entry).replace(/^\*?\./, "").toLowerCase(), port: parsed ? Number.parseInt(parsed[2]!, 10) : 0 };
  });
  if (entries.length === 0) return false;
  if (noProxy === "*") return true;
  const host = url.hostname.toLowerCase(), port = Number.parseInt(url.port, 10) || 80;
  return entries.some(entry => (entry.port === 0 || entry.port === port) && (host === entry.host || host.endsWith(`.${entry.host}`)));
}
/** The proxy `fetch` tunnels an onion URL through, or a PROXY refusal before any connection, so an onion name never
 * reaches a resolver: Node's environment proxy is on (`NODE_USE_ENV_PROXY=1` or `--use-env-proxy` installed undici's
 * `EnvHttpProxyAgent` as the global dispatcher), the proxy for `http:` (`http_proxy`, else `HTTP_PROXY`, as undici
 * reads them) is a loopback `http:` proxy such as Tor's `HTTPTunnelPort`, and `NO_PROXY` does not exempt the host. A
 * remote proxy could answer for the onion and take the bearer credential. */
export function onionProxy(url: URL, env: NodeJS.ProcessEnv = process.env): URL {
  const dispatcher = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")];
  if ((dispatcher as { constructor?: { name?: unknown } } | undefined)?.constructor?.name !== "EnvHttpProxyAgent") {
    throw proxyRefusal("an onion service needs Node's environment proxy: NODE_USE_ENV_PROXY=1 and HTTP_PROXY");
  }
  const configured = env.http_proxy ?? env.HTTP_PROXY;
  if (!configured) throw proxyRefusal("an onion service needs a proxy for http: URLs (http_proxy, else HTTP_PROXY)");
  let proxy: URL;
  try { proxy = new URL(configured); } catch { throw proxyRefusal("the http: proxy is not a URL"); }
  if (proxy.protocol !== "http:" || !LOOPBACK_HOSTS.includes(proxy.hostname)) {
    throw proxyRefusal("an onion service needs a loopback http: proxy, such as Tor's HTTPTunnelPort");
  }
  if (proxyExempts(url, env.no_proxy ?? env.NO_PROXY ?? "")) throw proxyRefusal("NO_PROXY exempts the onion service from the proxy");
  return proxy;
}
function refusal(status: number, value: unknown): V3ServiceClientError {
  const code = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)["code"] : undefined;
  return new V3ServiceClientError(status, typeof code === "string" && /^[A-Z_]{1,32}$/.test(code) ? code : "UNAVAILABLE", "service request failed");
}

/** One exchange with a loopback or onion listener at `baseUrl`. `read` is given the response while the connection is
 * held, and a call that restarts the bound (ten seconds by default): a command's reply is bounded whole, a stream between
 * its chunks. */
async function exchangeWith<T>(baseUrl: string, onion: boolean, path: string, token: string | undefined, body: string | undefined, type: string,
  read: (response: Response, progress: () => void) => Promise<T>, bound = 10_000): Promise<T> {
  const url = new URL(path, baseUrl), proxy = onion ? onionProxy(url) : undefined;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), bound);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal,
        headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json", "accept-encoding": "identity" } });
    } catch (error) {
      // An onion request opens a connection to the proxy alone, and Tor answers an onion's failure with a status: a
      // connection that fails is the proxy's, named rather than read as an operator that did not answer (a name with
      // several addresses fails as an AggregateError).
      const cause = (error as { cause?: unknown }).cause;
      if (proxy !== undefined && error instanceof TypeError && (cause instanceof AggregateError ||
          PROXY_UNREACHABLE.has((cause as { code?: unknown } | undefined)?.code))) throw proxyRefusal("the proxy did not answer");
      throw error;
    }
    // A refusal is a bounded JSON reply on every route.
    if ((response.status >= 300 && response.status < 400) || response.headers.get("content-type") !== (response.ok ? type : "application/json") ||
        ![null, "identity"].includes(response.headers.get("content-encoding"))) throw new EncodingError("unexpected service response");
    if (!response.ok) throw refusal(response.status, await json(response, MAX_V3_SERVICE_REPLY_BYTES));
    return await read(response, () => { timer.refresh(); });
  } finally { clearTimeout(timer); abort.abort(); }
}

/**
 * Hand a publication file to a relay (slice 12 M12c): `POST /publications` at a loopback or v3 onion URL under the
 * relay's one credential, answering its bounded JSON reply. An onion URL is reached only through the holder's loopback
 * proxy, refused `PROXY` before any connection otherwise (M12a). The bound passes the relay listener's own fifteen
 * seconds, so a publication still in flight there usually ends as a reply that did not come (an onion circuit's setup
 * counts against this bound alone); either way the file is sent again, and the relay answers a resend as the same. The
 * reply is the relay's word: the holder reads its act at the venue by its own read.
 */
export async function sendToRelay(baseUrl: string, token: string, file: unknown): Promise<unknown> {
  let url: URL; try { url = new URL(baseUrl); } catch { throw new EncodingError("invalid relay URL"); }
  const onion = ONION_HOST.test(url.hostname);
  if (url.protocol !== "http:" || !(url.hostname === "127.0.0.1" || onion) || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new EncodingError("a local or onion relay URL and a 32-byte credential required");
  }
  if (onion) onionProxy(url);
  const body = JSON.stringify(file);
  if (Buffer.byteLength(body) > MAX_V3_SERVICE_REQUEST_BYTES) throw new EncodingError("request too large");
  return exchangeWith(url.href, onion, "/publications", token, body, "application/json", response => json(response, MAX_V3_SERVICE_REPLY_BYTES), 20_000);
}

/** Whether `evidence` holds what a source serving the selection whose directory is `root` sends by then (§12.1, §14):
 * that directory, each snapshot it names, and each snapshot's trail. A source's mark moves only past such an answer, so
 * one that states a sequence and leaves its evidence out (an empty answer included) moves no mark, and a quiet or
 * closed backing is never left with evidence no later checkpoint sends again. Each lookup is one row and one chain step. */
function holdsSelection(evidence: EvidenceStore, root: Uint8Array): boolean {
  const kept = evidence.retained();
  try {
    const directory = kept.directory(root);
    return directory !== undefined && directory.every(entry => {
      const payload = kept.snapshot(entry.digest);
      if (payload === undefined) return false;
      const snapshot = evidence.construction.reader.snapshot.decode(payload);
      return kept.trail(snapshot.segment, snapshot.evidenceHash) !== undefined;
    });
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  } finally { kept.release(); }
}

/** Local operation credentials do not select protocol authority. The caller
 * independently holds the expected operator, reference venue and construction; the
 * domain is that construction's configuration (pool-v3 §11.4's adopted one, or
 * lit-v1's), never the service's. Records, receipts and packages are read through
 * that construction. Finality still requires the existing reader and independent venue. */
export class V3ServiceClient {
  readonly #baseUrl: string;
  /** Undefined for a replica's evidence-only listener, which takes no credential (M12b). */
  readonly #walletToken: string | undefined;
  readonly #adminToken: string | undefined;
  readonly #onion: boolean;
  readonly #construction: Construction;
  readonly #domain: Uint8Array;
  readonly #operator: Uint8Array;
  readonly #venue: Uint8Array;
  constructor(baseUrl: string, walletToken: string | undefined, expected: ServiceIdentity, adminToken?: string) {
    let url: URL; try { url = new URL(baseUrl); } catch { throw new EncodingError("invalid service URL"); }
    const onion = ONION_HOST.test(url.hostname);
    // An onion service is a holder's: its admin credential never leaves the operator's loopback (M12a).
    if (url.protocol !== "http:" || !(url.hostname === "127.0.0.1" || onion) || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash || (walletToken !== undefined && !/^[0-9a-f]{64}$/.test(walletToken)) ||
        (adminToken !== undefined && (onion || walletToken === undefined || !/^[0-9a-f]{64}$/.test(adminToken) || adminToken === walletToken))) {
      throw new EncodingError("a local or onion URL and distinct 32-byte credentials required");
    }
    if (onion) onionProxy(url);
    this.#onion = onion;
    this.#baseUrl = url.href; this.#walletToken = walletToken; this.#adminToken = adminToken;
    this.#construction = expected.construction ?? POOL_V3 as Construction;
    this.#domain = this.#construction.reader.domain(); this.#operator = identifier(expected.operator);
    this.#venue = referenceVenue(structuredClone(expected.reference)).id;
  }
  get baseUrl(): string { return this.#baseUrl; }
  private exchange<T>(path: string, token: string | undefined, body: string | undefined, type: string,
    read: (response: Response, progress: () => void) => Promise<T>): Promise<T> {
    return exchangeWith(this.#baseUrl, this.#onion, path, token, body, type, read);
  }
  private async request(path: string, command: V3ServiceCommand, admin = false): Promise<unknown> {
    const token = admin ? this.#adminToken : this.#walletToken;
    if (token === undefined) throw new V3ServiceClientError(403, admin ? "ADMIN_REQUIRED" : "UNAUTHORIZED", admin ? "admin credential required" :
      "a replica serves evidence only");
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
      // Each chunk restarts the bound on a stall; the time spent waiting for chunks bounds a drip, as the server bounds
      // its peers. A source slower than that did not answer.
      const bounded = async function* (): AsyncIterable<Uint8Array> {
        let total = 0n, waited = 0, asked = Date.now();
        for await (const chunk of chunksOf(response)) {
          waited += Date.now() - asked;
          progress(); total += BigInt(chunk.length);
          if (total > maxBytes) throw new PackageLimitError("served evidence exceeds the reader's budget");
          if (servedTooSlow(waited, Number(total))) throw new DOMException("the source served evidence below the minimum rate", "TimeoutError");
          yield chunk;
          asked = Date.now();
        }
      };
      return readServed(bounded(), (served, parts) => {
        const s = served.selection;
        if (!same(s.domain, this.#domain) || !same(s.operator, this.#operator) || !same(s.venue, this.#venue) || !same(s.backing, backing)) {
          throw new EncodingError("wrong service package context");
        }
        // The read's own package is the configuration and the commitment alone: whatever else a source put in it would be
        // read once and never kept, so a replica serving it on would leave its own readers short (M12b).
        const own = this.#construction.reader.package.decodeEvidencePackage(served.package);
        if (!own.every(item => item.kind === 1 || item.kind === 2)) throw new EncodingError("the read's own package carries more than its configuration and commitment");
        const signed = own.filter(item => item.kind === 2).map(item => decodeCommitment(item.payload));
        if (signed.length !== 1 || !verifyCommitment(signed[0]!) || !same(signed[0]!.operator, s.operator) || signed[0]!.sequence !== s.sequence ||
            !same(signed[0]!.root, s.root) || s.sequence >= 1n << 63n) throw new EncodingError("wrong commitment authority");
        return take(served, parts);
      });
    });
  }

  /**
   * Bring `evidence`, the party's own evidence store, up to the service's latest served commitment for
   * `backing` (pool-v3 §14, incremental retrieval). The store records the sequence this source was kept through,
   * and the request names it, so the source sends only later objects and, for each trail, its head and the records
   * after what the store holds. The source is the expected operator's service, at whatever URL, or a replica (a client
   * with no credential) at this URL: a replica serves after a sequence it served before what it kept since (M12b), so
   * its mark is its own. Where those parts do not assemble over what the store holds, or leave out the selection's
   * directory, a snapshot it names or that snapshot's trail (`holdsSelection`), everything is fetched once more from
   * nothing, and a source whose answer from nothing still leaves them out is refused as one that does not assemble, its
   * mark unmoved; `full` asks for that outright, which also replaces retained evidence that storage damaged. A source
   * whose selection is below the mark sends nothing new, and the mark stays. Returns the selection and the read's own
   * package (the configuration and the selected commitment) to read with that store.
   *
   * Evidence transport only. Metadata never selects the reader's authority, judging index, finality,
   * current balance or spendability; what is kept is authenticated when a read uses it. `maxBytes` bounds
   * one response (by default the store's file quota).
   */
  async sync(backing: Uint8Array, evidence: EvidenceStore, options: { readonly full?: boolean; readonly maxBytes?: bigint } = {}): Promise<ServedPackage> {
    if (evidence.construction.namespace.name !== this.#construction.namespace.name) throw new TypeError("an evidence store of another construction");
    const ownBacking = identifier(backing), operator = concatBytes(this.#domain, this.#venue, this.#operator);
    const source = this.#walletToken === undefined ? concatBytes(operator, new TextEncoder().encode(this.#baseUrl)) : operator;
    const receive = (after: bigint) => this.served(ownBacking, after, options.maxBytes ?? EVIDENCE_QUOTA.file,
      (served, parts) => evidence.take(parts, served.selection.operator));
    let after = options.full === true ? 0n : evidence.suppliedThrough(source);
    let result = await receive(after);
    if (!(result.taken && holdsSelection(evidence, result.served.selection.root)) && after > 0n) result = await receive(after = 0n);
    if (!result.taken || !holdsSelection(evidence, result.served.selection.root)) throw new EncodingError("served evidence does not assemble");
    const sequence = result.served.selection.sequence;
    evidence.supplied(source, sequence > after ? sequence : after);
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
