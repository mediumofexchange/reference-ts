import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { fieldToBytes } from "../field.js";
import { compareBytes, copyUnshared, EncodingError } from "../../bytes.js";
import type { ExhaustionSupplier, Fold, IncludedTransaction, KeyAnswer } from "../../ergo-exhaustion.js";
import { decodeFold, decodeIncluded, decodeKeyAnswer, MAX_FOLD_PROOF_BYTES, MAX_KEY_ANSWER_BYTES, MAX_TRANSACTION_BYTES } from "../../ergo-exhaustion-wire.js";
import { decodeCommitment, verifyCommitment, type Commitment } from "../../venue-records.js";
import { POOL_V3, type Construction, type OperatorReceipt } from "./construction.js";
import { EVIDENCE_QUOTA, evidenceName, wholePackage, type EvidenceStore } from "./evidence-store.js";
import { FAULT_LIMITS } from "./fault-observer.js";
import { referenceVenue, type VenueReference } from "./guard.js";
import { PackageLimitError } from "./package.js";
import { MAX_PROOF } from "./records.js";
import { decodeV3ServiceReply, parseV3ServiceCommand, readServed, servedTooSlow, V3_SERVICE_PROFILE,
  MAX_V3_SERVICE_REQUEST_BYTES, MAX_V3_SERVICE_REPLY_BYTES, type V3ServiceCommand } from "./service-wire.js";
import type { ServedPackage } from "./store.js";
import type { CheckSupply, RecordAt } from "./succinct.js";

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
/** A whole binary body of at most `maximum` bytes: a longer answer is stopped unread, a malformed answer. */
async function body(response: Response, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of chunksOf(response)) {
    size += chunk.length; if (size > maximum) throw new EncodingError("an answer past its bound");
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
/** Whether a service call failed because the service did not answer (nothing listening, a dropped connection). */
export const unanswered = (error: unknown): boolean =>
  (error instanceof TypeError && (error.message === "fetch failed" || error.message === "terminated")) ||
  (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));

/** A v3 onion service's host: 56 base32 characters, the last its version byte's (3). Tor checks the checksum. */
export const ONION_HOST = /^[a-z2-7]{55}d\.onion$/;
/** A listener's base URL as a client takes it: `http:` at 127.0.0.1 or a v3 onion host, nothing past the root `/`. */
function listenerUrl(baseUrl: string): { url: URL; onion: boolean } | undefined {
  let url: URL; try { url = new URL(baseUrl); } catch { return undefined; }
  const onion = ONION_HOST.test(url.hostname);
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || onion) && !url.username && !url.password && url.pathname === "/" &&
    !url.search && !url.hash ? { url, onion } : undefined;
}
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const proxyRefusal = (message: string) => new V3ServiceClientError(0, "PROXY", message);
const PROXY_UNREACHABLE: ReadonlySet<unknown> = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH", "EHOSTUNREACH"]);
/** How much longer an onion exchange waits for its response to begin: the circuit to the service is built first. On the
 * live Tor network that took up to 25 s from a fresh client (Next 4 (bj)); Tor's own gateway gives up at 120 s. */
export const ONION_CIRCUIT_MS = 50_000;
/** The status a proxy answered a tunnel with, where it refused one: Node's `fetch` (undici 7.29.1) keeps it only in its
 * abort's message, two causes down. */
export function tunnelStatus(error: unknown): number | undefined {
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    const refused = /^Proxy response \(([0-9]{3})\) !== 200 when HTTP Tunneling$/.exec(cause.message);
    if (refused !== null && (cause as { code?: unknown }).code === "UND_ERR_ABORTED") return Number(refused[1]);
  }
  return undefined;
}
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

/** One exchange with a loopback or onion listener at `baseUrl`. The response must begin within the bound (ten seconds by
 * default), an onion's within `ONION_CIRCUIT_MS` more; `read` is then given it while the connection is held, and a call
 * that restarts the bound: a command's reply is bounded whole, a stream between its chunks. */
async function exchangeWith<T>(baseUrl: string, onion: boolean, path: string, token: string | undefined, body: string | undefined, type: string,
  read: (response: Response, progress: () => void) => Promise<T>, bound = 10_000): Promise<T> {
  const url = new URL(path, baseUrl), proxy = onion ? onionProxy(url) : undefined;
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(), onion ? bound + ONION_CIRCUIT_MS : bound);
  try {
    let response: Response;
    try {
      response = await fetch(url, { method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { body }), redirect: "manual", signal: abort.signal,
        headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json", "accept-encoding": "identity" } });
    } catch (error) {
      // A proxy that refused to tunnel a URL that is no onion (Tor refuses an internal address 403) is the holder's own
      // route, named with its status. An onion's refusal stays a service that did not answer, whatever its status: Tor
      // also answers 403 for the service's own END reasons (connection refused or reset), so a source could otherwise
      // stop a holder's read instead of being passed over.
      const refused = tunnelStatus(error);
      if (refused !== undefined && proxy === undefined && refused < 500) throw proxyRefusal(`the proxy refused the tunnel (${refused})`);
      // An onion request opens a connection to the proxy alone: a connection that fails is the proxy's, named rather than
      // read as an operator that did not answer (a name with several addresses fails as an AggregateError).
      const cause = (error as { cause?: unknown }).cause;
      if (proxy !== undefined && error instanceof TypeError && (cause instanceof AggregateError ||
          PROXY_UNREACHABLE.has((cause as { code?: unknown } | undefined)?.code))) throw proxyRefusal("the proxy did not answer");
      throw error;
    }
    // The response began, over a circuit that stands: the bound counts from here.
    clearTimeout(timer); timer = setTimeout(() => abort.abort(), bound);
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
 * has `ONION_CIRCUIT_MS` of its own); either way the file is sent again, and the relay answers a resend as the same. The
 * reply is the relay's word: the holder reads its act at the venue by its own read.
 */
export async function sendToRelay(baseUrl: string, token: string, file: unknown): Promise<unknown> {
  const listener = listenerUrl(baseUrl);
  if (listener === undefined || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
    throw new EncodingError("a local or onion relay URL and a 32-byte credential required");
  }
  const { url, onion } = listener;
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
    const listener = listenerUrl(baseUrl);
    // An onion service is a holder's: its admin credential never leaves the operator's loopback (M12a).
    if (listener === undefined || (walletToken !== undefined && !/^[0-9a-f]{64}$/.test(walletToken)) || (adminToken !== undefined &&
        (listener.onion || walletToken === undefined || !/^[0-9a-f]{64}$/.test(adminToken) || adminToken === walletToken))) {
      throw new EncodingError("a local or onion URL and distinct 32-byte credentials required");
    }
    const { url, onion } = listener;
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
    // A construction whose trails are proof-free (a succinct read) asks for them in that form (succinct-read §3.3).
    const form = this.#construction.trailChecks === undefined ? "" : "&form=proof-free";
    return this.exchange(`/evidence?backing=${hex(backing)}&after=${after}${form}`, this.#walletToken, undefined, "application/octet-stream", (response, progress) => {
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
        // The read's own package is the configuration, the commitment and the §9 faults the read takes (§9.1: a read takes
        // them from its own package alone), within one read's fault budget: whatever else a source put in it would be read
        // once and never kept, so a replica serving it on would leave its own readers short (M12b, Next 4 (bk)).
        // Its one configuration is the construction's: another (or two) would refuse the read itself, which no other source
        // could then repair, so it is the source's malformed answer here, passed over like any other (audit 32).
        const own = this.#construction.reader.package.decodeEvidencePackage(served.package);
        if (!own.every(item => item.kind === 1 || item.kind === 2 || item.kind === 7)) {
          throw new EncodingError("the read's own package carries more than its configuration, commitment and faults");
        }
        const faults = own.filter(item => item.kind === 7);
        if (BigInt(faults.length) > FAULT_LIMITS.maxItems || faults.reduce((n, item) => n + BigInt(item.payload.length), 0n) > FAULT_LIMITS.maxBytes) {
          throw new EncodingError("the read's own package carries more faults than a read takes");
        }
        const configurations = own.filter(item => item.kind === 1);
        if (configurations.length !== 1 || !this.#construction.reader.verifyConfiguration(configurations[0]!.payload)) {
          throw new EncodingError("the read's own package names another configuration");
        }
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
   * package (the configuration, the selected commitment and any faults) to read with that store.
   *
   * Evidence transport only. Metadata never selects the reader's authority, judging index, finality,
   * current balance or spendability; what is kept is authenticated when a read uses it. `maxBytes` bounds
   * one response (by default the store's file quota).
   */
  async sync(backing: Uint8Array, evidence: EvidenceStore, options: { readonly full?: boolean; readonly maxBytes?: bigint } = {}): Promise<ServedPackage> {
    if (evidenceName(evidence.construction) !== evidenceName(this.#construction)) throw new TypeError("an evidence store of another construction");
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

  /** A succinct reader's fetch of a record's proof by its hash and place (succinct-read §3.5): the source's bytes, which
   * the reader hashes, or undefined where it has none; an answer past pool-v3 §5's bound is malformed (`EncodingError`). */
  async proof(proofHash: Uint8Array, at: RecordAt): Promise<Uint8Array | undefined> {
    const hash = identifier(proofHash), segment = identifier(at.segment), evidence = identifier(at.evidence);
    if (typeof at.position !== "bigint" || at.position < 1n || at.position >= 1n << 63n) throw new TypeError("a record's position is a positive u63");
    return this.fetched(`/proofs/${hex(hash)}?segment=${hex(segment)}&position=${at.position}&evidence=${hex(evidence)}`);
  }
  /** A check proof the source keeps for `digest` under set `set` (succinct-read §3.2), which the reader verifies under
   * its own pinned keys, or undefined. */
  async cover(set: Uint8Array, digest: bigint): Promise<Uint8Array | undefined> {
    return this.fetched(`/covers/${hex(identifier(set))}/${hex(fieldToBytes(digest))}`);
  }
  /** A fetch whose answer is at most pool-v3 §5's bound on a proof field (past it, `EncodingError`), or undefined where the
   * source has none. */
  private fetched(path: string): Promise<Uint8Array | undefined> {
    return this.exchange(path, this.#walletToken, undefined, "application/octet-stream", response => body(response, MAX_PROOF))
      .catch((error: unknown) => {
        if (error instanceof V3ServiceClientError && error.code === "NOT_FOUND") return undefined;
        throw error;
      });
  }

  /** `sync` from nothing into one §12 package held in memory, for a caller that reads a whole package. The
   * response is bounded by `maxBytes` (by default an in-memory store's quota), so it does not serve a long history;
   * assembling it holds about three times what was received at its peak (`wholePackage`). */
  async package(backing: Uint8Array, maxBytes: bigint = EVIDENCE_QUOTA.memory): Promise<ServedPackage> {
    const result = await this.served(identifier(backing), 0n, maxBytes, (served, parts) => wholePackage(served.package, parts, this.#construction));
    return { selection: result.served.selection, package: result.taken };
  }
}

/**
 * A replica's exhaustion (succinct-read §4.7) under the set whose identity is `set`, over its listener at `baseUrl`
 * (loopback or v3 onion, with no credential): `NOT_FOUND` is no answer (undefined); a frame that does not decode, a
 * refusal or no answer at all rejects, which a succinct view reads as a supplier that did not supply. An onion
 * replica's proxy is read when first asked.
 */
export function exhaustionClient(baseUrl: string, set: Uint8Array): ExhaustionSupplier {
  const listener = listenerUrl(baseUrl), own = identifier(set);
  if (listener === undefined) throw new EncodingError("a local or onion URL required");
  const url = listener.url.href, onion = listener.onion, prefix = `/exhaustion/${hex(own)}/`;
  const fetched = <T>(path: string, maximum: number, decode: (bytes: Uint8Array) => T): Promise<T | undefined> =>
    exchangeWith(url, onion, `${prefix}${path}`, undefined, undefined, "application/octet-stream", response => body(response, maximum))
      .then(decode, (error: unknown) => {
        if (error instanceof V3ServiceClientError && error.code === "NOT_FOUND") return undefined;
        throw error;
      });
  const height = (value: bigint): string => { if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n) throw new TypeError("a height is a u64"); return value.toString(); };
  const u32 = (value: bigint): string => { if (typeof value !== "bigint" || value < 0n || value >= 1n << 32n) throw new TypeError("a key or position is a u32"); return value.toString(); };
  return {
    name: url,
    fold: (maxHeight: bigint): Promise<Fold | undefined> => fetched(`fold?max=${height(maxHeight)}`, MAX_FOLD_PROOF_BYTES + 256, decodeFold),
    key: (endHeight: bigint, key: bigint, from: bigint): Promise<KeyAnswer | undefined> =>
      fetched(`key/${height(endHeight)}/${u32(key)}?from=${height(from)}`, MAX_KEY_ANSWER_BYTES, decodeKeyAnswer),
    transaction: (at: bigint, position: bigint): Promise<IncludedTransaction | undefined> =>
      fetched(`transaction/${height(at)}/${u32(position)}`, MAX_TRANSACTION_BYTES + 4 + 1 + 33 * 32, decodeIncluded),
  };
}

/** What a supply asks of a source: a client, or one made when first asked (an onion source needs the holder's proxy). */
export type CheckSource = Pick<V3ServiceClient, "cover" | "proof">;
/**
 * A succinct reader's supply over `sources` (succinct-read §2 rule 6): each fetch asks them in turn until one answers,
 * covers under the set whose identity is `set`, the source that answered last first. A source that refuses or has
 * none is passed over for that fetch, so an honest source behind it is still asked. A source that does not answer, or
 * answers malformed bytes, a proof whose bytes do not hash to the asked `proofHash` or a cover the reader's own check
 * (`accept`) refuses, is not asked again by this supply (a reader makes one per read; a wrong answer is the supplier's
 * failure, §2 rule 5), so a dead, dripping or lying source costs one wait, and one that refuses or answers "none"
 * slowly costs a wait only where the source that answered last has none either. The holder's own proxy
 * refusing the route is the holder's to fix, not a source's answer: it ends the read, as it ends a sync.
 */
export function serviceSupply(set: Uint8Array, sources: readonly CheckSource[]): CheckSupply {
  const own = identifier(set), list = [...sources], silent = new Set<CheckSource>();
  const ask = async (fetch: (source: CheckSource) => Promise<Uint8Array | undefined>, holds: (answer: Uint8Array) => Promise<boolean> | boolean) => {
    for (const source of [...list]) {
      if (silent.has(source)) continue;
      try {
        const answer = await fetch(source);
        if (answer === undefined) continue;
        if (!await holds(answer)) { silent.add(source); continue; }
        list.splice(list.indexOf(source), 1); list.unshift(source);
        return answer;
      } catch (error) {
        if (unanswered(error)) { silent.add(source); continue; }
        if (error instanceof V3ServiceClientError && !(error.code === "PROXY" && error.status === 0)) continue;
        // A malformed answer is a wrong one.
        if (error instanceof EncodingError) { silent.add(source); continue; }
        throw error;
      }
    }
    return undefined;
  };
  return Object.freeze({
    cover: (digest: bigint, accept?: (proof: Uint8Array) => Promise<boolean>) => ask(source => source.cover(own, digest), accept ?? (() => true)),
    // A proof is fetched by its place; a publication's is never fetched (§3.6).
    proof: (proofHash: Uint8Array, at?: RecordAt) => at === undefined ? undefined :
      ask(source => source.proof(proofHash, at), answer => same(sha256(answer), proofHash)),
  });
}
