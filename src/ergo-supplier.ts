// Suppliers of Ergo venue evidence (venue-ergo.md §§3–4): header bytes and
// block transaction sections, from sources the reader does not trust.
//
// A supplier only carries bytes. The reader's header store parses every
// header, derives its id and checks its work; a section counts only where it
// reproduces the transaction root of a header the reader accepted. So a
// supplier can fail to supply, or withhold, but it cannot make the reader
// accept a header or a section it did not verify, and nothing here is part of
// what the reader establishes. A node the reader runs is one supplier like any
// other.
//
// The node supplier writes each header and transaction by copying the node's
// JSON statement of it, without a decoder: every field the bytes carry is in
// the statement as exact bytes (ids, roots, trees, register and extension
// constants, in hex) or as an integer (values, amounts, heights, timestamps),
// so nothing is parsed whose cost depends on a constant's type. Two properties
// of the text matter beyond its values: integers above 2^53, read from their
// source text, and each context extension's key order, which the node writes
// in its map's order and a JavaScript object would sort, so the text is read by
// the small order-keeping parser below. A copy that does not hash to the id the
// node states is unsupplied (undefined), never misread.
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { ErgoTransactionView } from "./ergo-profile.js";
import type { ErgoPublishingSupplier } from "./ergo-publisher.js";

/** One source of header bytes and sections. Every method may fail (throw or
 * reject), return fewer headers than asked or no section; the reader treats
 * all of that as this supplier not supplying. */
export interface ErgoSupplier {
  /** A label for sync reports; it identifies nothing the reader relies on. */
  readonly name: string;
  /** The height of the supplier's best header. */
  tipHeight(): Promise<bigint>;
  /** Header bytes of the supplier's best chain at heights `fromHeight` to
   * `toHeight` inclusive, ascending. */
  headers(fromHeight: bigint, toHeight: bigint): Promise<readonly Uint8Array[]>;
  /** One block's transaction section in block order, or undefined. */
  section(headerId: Uint8Array): Promise<readonly ErgoTransactionView[] | undefined>;
}

/** A value of the node's JSON: objects as Maps in text order, integers as bigint. */
export type NodeJson = Map<string, NodeJson> | NodeJson[] | string | bigint | boolean | null;

/** The node's JSON, strictly: objects as Maps in text order (a repeated key
 * is refused), integers as bigint, strings without escapes (the node's block
 * JSON has none). Anything else throws a SyntaxError. */
export function parseNodeJson(text: string): NodeJson {
  let at = 0;
  const fail = (what: string): never => { throw new SyntaxError(`node JSON: ${what} at ${at}`); };
  const space = (): void => {
    while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++;
  };
  const string = (): string => {
    if (text[at] !== '"') fail("expected a string");
    const end = text.indexOf('"', at + 1);
    if (end < 0) fail("unterminated string");
    const value = text.slice(at + 1, end);
    if (/[\\\u0000-\u001f]/.test(value)) fail("an escape or control character");
    at = end + 1;
    return value;
  };
  const integer = /-?(?:0|[1-9][0-9]*)/y;
  const value = (depth: number): NodeJson => {
    if (depth > 64) fail("nesting");
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const map = new Map<string, NodeJson>();
      space();
      if (text[at] === "}") { at++; return map; }
      for (;;) {
        space();
        const key = string();
        if (map.has(key)) fail(`repeated key ${key}`);
        space();
        if (text[at++] !== ":") fail("expected ':'");
        map.set(key, value(depth + 1));
        space();
        const next = text[at++];
        if (next === "}") return map;
        if (next !== ",") fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      at++;
      const items: NodeJson[] = [];
      space();
      if (text[at] === "]") { at++; return items; }
      for (;;) {
        items.push(value(depth + 1));
        space();
        const next = text[at++];
        if (next === "]") return items;
        if (next !== ",") fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    integer.lastIndex = at;
    const match = integer.exec(text);
    if (match !== null) {
      at += match[0].length;
      if (/[.eE]/.test(text[at] ?? "")) fail("a non-integer number");
      return BigInt(match[0]);
    }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, at)) { at += word.length; return literal; }
    }
    return fail("unexpected character");
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("trailing text");
  return result;
}

const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_U64 = (1n << 64n) - 1n, MAX_U32 = 0xffff_ffffn, MAX_U16 = 0xffff;
class Unsupplied extends Error {}
const refuse = (): never => { throw new Unsupplied(); };
const field = (value: NodeJson | undefined, key: string): NodeJson =>
  value instanceof Map && value.has(key) ? value.get(key)! : refuse();
const list = (value: NodeJson | undefined, key: string): NodeJson[] => {
  const items = field(value, key);
  return Array.isArray(items) && items.length <= MAX_U16 ? items : refuse();
};
const bytes = (value: NodeJson, width?: number): Uint8Array =>
  typeof value === "string" && HEX.test(value) && (width === undefined || value.length === 2 * width) ? hexToBytes(value) : refuse();
const integer = (value: NodeJson, max: bigint): bigint =>
  typeof value === "bigint" && value >= 0n && value <= max ? value : refuse();
const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const hash = (input: Uint8Array): Uint8Array => blake2b(input, { dkLen: 32 });

/** One header's bytes copied from the node's statement of it (as
 * `/blocks/chainSlice` lists them), or undefined where the statement is not
 * of the node's shape or the copy does not hash to the id it states. The
 * bytes are the node's serialization: fixed-width roots, VLQ timestamp and
 * height, big-endian nBits; for versions 2–127 (the node reads the version as
 * a signed byte) a new-fields length, zero through version 4 and followed by
 * `unparsedBytes` above it; then the Autolykos solution, for version 1 the
 * key, `w`, the nonce and `d` (a length byte and its minimal unsigned bytes),
 * otherwise the key and the nonce. Nodes before 6.0 omit `unparsedBytes`,
 * which then counts as empty. */
export function supplyHeader(statement: NodeJson): { readonly id: Uint8Array; readonly bytes: Uint8Array } | undefined {
  try {
    if (!(statement instanceof Map)) refuse();
    const header = statement as Map<string, NodeJson>;
    const version = integer(field(header, "version"), 255n), solution = field(header, "powSolutions");
    const signed = version < 128n ? version : version - 256n;
    const fields = header.has("unparsedBytes") ? bytes(header.get("unparsedBytes")!) : new Uint8Array(0);
    if (fields.length > 255 || (fields.length !== 0 && signed <= 4n)) refuse();
    const nBits = new Uint8Array(4);
    new DataView(nBits.buffer).setUint32(0, Number(integer(field(header, "nBits"), MAX_U32)), false);
    let pow = [bytes(field(solution, "pk"), 33), bytes(field(solution, "n"), 8)];
    if (version === 1n) {
      // The node writes d as BouncyCastle's unsigned bytes: minimal, and a single zero byte for zero.
      const d = integer(field(solution, "d"), (1n << 256n) - 1n), digits = d.toString(16);
      const dBytes = hexToBytes(digits.length % 2 === 1 ? `0${digits}` : digits);
      pow = [pow[0]!, bytes(field(solution, "w"), 33), pow[1]!, Uint8Array.of(dBytes.length), dBytes];
    }
    const out = concat([Uint8Array.of(Number(version)), bytes(field(header, "parentId"), 32),
      bytes(field(header, "adProofsRoot"), 32), bytes(field(header, "transactionsRoot"), 32), bytes(field(header, "stateRoot"), 33),
      vlq(integer(field(header, "timestamp"), (1n << 63n) - 1n)), bytes(field(header, "extensionHash"), 32), nBits,
      vlq(integer(field(header, "height"), (1n << 31n) - 1n)), bytes(field(header, "votes"), 3),
      ...(signed > 1n ? [Uint8Array.of(fields.length), fields] : []), ...pow]);
    const id = hash(out);
    if (field(header, "id") !== bytesToHex(id)) refuse();
    return Object.freeze({ id, bytes: out });
  } catch (error) {
    if (error instanceof Unsupplied) return undefined;
    throw error;
  }
}

/** A transaction copied from the node's statement of it (a Map from
 * `parseNodeJson`), or undefined where the statement is not of the node's
 * shape; its stated id is not consulted. The unsigned bytes are the node's
 * transaction serialization with every proof empty: inputs (box id, a zero
 * proof length, the extension's entry count, then each key byte and constant
 * in text order), data inputs, the distinct token ids in order of first
 * appearance, and outputs (value, tree, creation height, tokens as index and
 * amount, then registers R4 onward). `signedBytes` is the length of the same
 * transaction with its proofs, for measurement only. */
export function copyTransaction(statement: NodeJson):
  { readonly unsigned: Uint8Array; readonly proofs: readonly Uint8Array[]; readonly signedBytes: number } | undefined {
  try {
    const parts: Uint8Array[] = [], proofs: Uint8Array[] = [];
    const inputs = list(statement, "inputs"), dataInputs = list(statement, "dataInputs"), outputs = list(statement, "outputs");
    parts.push(vlq(BigInt(inputs.length)));
    let signedBytes = 0;
    for (const input of inputs) {
      const proof = field(input, "spendingProof"), proofBytes = bytes(field(proof, "proofBytes")), extension = field(proof, "extension");
      // The node writes at most 127 entries, each keyed by a nonnegative byte (ContextExtension's serializer).
      if (!(extension instanceof Map) || extension.size > 127) refuse();
      const entries = extension as Map<string, NodeJson>;
      parts.push(bytes(field(input, "boxId"), 32), Uint8Array.of(0), Uint8Array.of(entries.size));
      for (const [key, constant] of entries) {
        if (!/^(?:0|[1-9][0-9]{0,2})$/.test(key) || Number(key) > 127) refuse();
        parts.push(Uint8Array.of(Number(key)), bytes(constant));
      }
      proofs.push(proofBytes);
      signedBytes += vlq(BigInt(proofBytes.length)).length + proofBytes.length - 1;
    }
    parts.push(vlq(BigInt(dataInputs.length)));
    for (const dataInput of dataInputs) parts.push(bytes(field(dataInput, "boxId"), 32));
    // Distinct token ids in order of first appearance, each with its index: one map lookup per asset, so the copy
    // stays linear in the statement however many tokens it names.
    const tokenIndex = new Map<string, number>();
    for (const output of outputs) for (const asset of list(output, "assets")) {
      const tokenId = bytesToHex(bytes(field(asset, "tokenId"), 32));
      if (!tokenIndex.has(tokenId)) tokenIndex.set(tokenId, tokenIndex.size);
    }
    parts.push(vlq(BigInt(tokenIndex.size)));
    for (const tokenId of tokenIndex.keys()) parts.push(hexToBytes(tokenId));
    parts.push(vlq(BigInt(outputs.length)));
    for (const output of outputs) {
      parts.push(vlq(integer(field(output, "value"), MAX_U64)), bytes(field(output, "ergoTree")),
        vlq(integer(field(output, "creationHeight"), MAX_U32)));
      const assets = list(output, "assets"), registers = field(output, "additionalRegisters");
      if (assets.length > 255 || !(registers instanceof Map) || registers.size > 6) refuse();
      parts.push(Uint8Array.of(assets.length));
      for (const asset of assets) {
        parts.push(vlq(BigInt(tokenIndex.get(bytesToHex(bytes(field(asset, "tokenId"), 32)))!)),
          vlq(integer(field(asset, "amount"), MAX_U64)));
      }
      // Registers are written by name, R4 onward, whatever order the text lists them in; they must be contiguous.
      const named = registers as Map<string, NodeJson>;
      parts.push(Uint8Array.of(named.size));
      for (let register = 4; register < 4 + named.size; register++) parts.push(bytes(field(named, `R${register}`)));
    }
    const unsigned = concat(parts);
    return Object.freeze({ unsigned, proofs: Object.freeze(proofs), signedBytes: unsigned.length + signedBytes });
  } catch (error) {
    if (error instanceof Unsupplied) return undefined;
    throw error;
  }
}

/** A supplied transaction: its id, unsigned bytes and witness id. */
export interface SuppliedTransaction extends ErgoTransactionView {
  readonly id: Uint8Array;
  readonly signedBytes: number;
}
/** One transaction as the node states it, or undefined where the statement is
 * not of the node's shape or its copy does not hash to the id it states. The
 * witness id is the Blake2b-256 of the input proofs concatenated, first byte
 * dropped. */
export function supplyTransaction(statement: NodeJson): SuppliedTransaction | undefined {
  const copy = copyTransaction(statement);
  if (copy === undefined || !(statement instanceof Map)) return undefined;
  const id = hash(copy.unsigned);
  if (statement.get("id") !== bytesToHex(id)) return undefined;
  return Object.freeze({ id, unsigned: copy.unsigned, witnessId: hash(concat(copy.proofs)).subarray(1), signedBytes: copy.signedBytes });
}

/** A block's transactions as the node serves them (`/blocks/{id}/transactions`):
 * the header id, each transaction's statement, and what is supplied for it
 * (undefined where unsupplied). Text that is not the node's JSON of a block's
 * transactions throws a SyntaxError for the whole block. */
export function supplyBlock(text: string): {
  readonly headerId: string; readonly statements: readonly NodeJson[]; readonly supplied: readonly (SuppliedTransaction | undefined)[];
} {
  const block = parseNodeJson(text);
  if (!(block instanceof Map) || typeof block.get("headerId") !== "string" || !Array.isArray(block.get("transactions"))) {
    throw new SyntaxError("node JSON: not a block's transactions");
  }
  const statements = block.get("transactions") as NodeJson[];
  return { headerId: block.get("headerId") as string, statements, supplied: statements.map(supplyTransaction) };
}

export interface ErgoNodeSupplierOptions {
  /** A label for reports; defaults to the base URL. */
  readonly name?: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: (url: string, init: NodeRequestInit) => Promise<Response>;
  /** Per request. */
  readonly timeoutMs?: number;
  /** A response longer than this is not read: it supplies nothing. */
  readonly maxResponseBytes?: number;
  /** Headers asked of the node per request. */
  readonly batch?: bigint;
}
/** What the node supplier asks of `fetch`: a GET, or a POST of a JSON string. */
export interface NodeRequestInit {
  readonly signal: AbortSignal;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
/** Consensus caps a block near 8 MB; its JSON is at most a few times that. */
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_BATCH = 500n;
/** Unspent boxes asked of the node's index per request: plenty for a funding key. */
const BOXES_PER_REQUEST = 100;

/** A plain box (no tokens, no registers) copied from the node's statement of
 * it, as its index lists them: value, tree, creation height, the two empty
 * counts, the creating transaction's id and the output index. Undefined for
 * any other box, or one whose copy does not hash to the id stated. */
function copyPlainBox(statement: NodeJson): Uint8Array | undefined {
  try {
    if (list(statement, "assets").length !== 0) return undefined;
    const registers = field(statement, "additionalRegisters");
    if (!(registers instanceof Map) || registers.size !== 0) return undefined;
    const out = concat([vlq(integer(field(statement, "value"), MAX_U64)), bytes(field(statement, "ergoTree")),
      vlq(integer(field(statement, "creationHeight"), MAX_U32)), Uint8Array.of(0, 0), bytes(field(statement, "transactionId"), 32),
      vlq(integer(field(statement, "index"), BigInt(MAX_U16)))]);
    return field(statement, "boxId") === bytesToHex(hash(out)) ? out : undefined;
  } catch (error) {
    if (error instanceof Unsupplied) return undefined;
    throw error;
  }
}

/** A supplier over one node's REST API. Reading: `/info`,
 * `/blocks/chainSlice`, `/blocks/{id}/transactions`. Publishing: the node's
 * box index (`/blockchain/box/unspent/byErgoTree`, which needs its
 * `extraIndex`), `/utxo/withPool/byIdBinary/{id}` and `/transactions/bytes`.
 * The node is untrusted: what it serves is copied to bytes and the reader
 * verifies them, and a statement the copy cannot reproduce leaves the header,
 * section or box unsupplied. */
export function ergoNodeSupplier(baseUrl: string, options: ErgoNodeSupplierOptions = {}): ErgoSupplier & ErgoPublishingSupplier {
  const base = baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? ((url: string, init: NodeRequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 30_000, maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const batch = options.batch ?? DEFAULT_BATCH;
  if (batch < 1n) throw new RangeError("a header batch is positive");
  /** The body as text, or undefined where the node answers 404. A body is POSTed as a JSON string. */
  const get = async (path: string, body?: string): Promise<string | undefined> => {
    const response = await fetcher(`${base}${path}`, body === undefined ? { signal: AbortSignal.timeout(timeoutMs) } :
      { signal: AbortSignal.timeout(timeoutMs), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new Error(`${path}: response over ${maxBytes} bytes`);
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel(); throw new Error(`${path}: response over ${maxBytes} bytes`); }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(concat(chunks));
  };
  return Object.freeze({
    name: options.name ?? base,
    async tipHeight(): Promise<bigint> {
      const text = await get("/info");
      const info = text === undefined ? undefined : parseNodeJson(text);
      const height = info instanceof Map ? info.get("headersHeight") : undefined;
      if (typeof height !== "bigint" || height < 0n) throw new Error("/info: no headers height");
      return height;
    },
    async headers(fromHeight: bigint, toHeight: bigint): Promise<readonly Uint8Array[]> {
      const out: Uint8Array[] = [];
      // chainSlice answers the heights (fromHeight, toHeight] of the node's best chain.
      for (let low = fromHeight - 1n; low < toHeight; low += batch) {
        const high = low + batch < toHeight ? low + batch : toHeight;
        const text = await get(`/blocks/chainSlice?fromHeight=${low}&toHeight=${high}`);
        const statements = text === undefined ? undefined : parseNodeJson(text);
        if (!Array.isArray(statements)) break;
        let next = low + 1n;
        for (const statement of statements) {
          // A longer answer than asked is cut to it.
          if (next > high) break;
          const supplied = supplyHeader(statement);
          // A gap or a fallback header ends the batch; the reader asks again from where it stands.
          const height = statement instanceof Map ? statement.get("height") : undefined;
          if (supplied === undefined || height !== next) return out;
          out.push(supplied.bytes);
          next++;
        }
        if (next <= high) break;
      }
      return out;
    },
    async section(headerId: Uint8Array): Promise<readonly ErgoTransactionView[] | undefined> {
      const id = bytesToHex(headerId);
      const text = await get(`/blocks/${id}/transactions`);
      if (text === undefined) return undefined;
      const block = supplyBlock(text);
      if (block.headerId !== id) return undefined;
      const views: ErgoTransactionView[] = [];
      for (const supplied of block.supplied) {
        if (supplied === undefined) return undefined;
        views.push(Object.freeze({ unsigned: supplied.unsigned, witnessId: supplied.witnessId }));
      }
      return Object.freeze(views);
    },
    async unspentBoxes(tree: Uint8Array): Promise<readonly Uint8Array[]> {
      const text = await get(`/blockchain/box/unspent/byErgoTree?offset=0&limit=${BOXES_PER_REQUEST}&sortDirection=desc` +
        "&includeUnconfirmed=true&excludeMempoolSpent=true", bytesToHex(tree));
      const statements = text === undefined ? [] : parseNodeJson(text);
      if (!Array.isArray(statements)) throw new Error("unspent boxes: not a list");
      const out: Uint8Array[] = [];
      for (const statement of statements.slice(0, BOXES_PER_REQUEST)) {
        const box = copyPlainBox(statement);
        if (box !== undefined) out.push(box);
      }
      return out;
    },
    async hasBox(boxId: Uint8Array): Promise<boolean> {
      const id = bytesToHex(boxId);
      const text = await get(`/utxo/withPool/byIdBinary/${id}`);
      if (text === undefined) return false;
      const box = parseNodeJson(text);
      const stated = box instanceof Map ? box.get("bytes") : undefined;
      return typeof stated === "string" && HEX.test(stated) && bytesToHex(hash(hexToBytes(stated))) === id;
    },
    async submit(signed: Uint8Array, id: Uint8Array): Promise<void> {
      const text = await get("/transactions/bytes", bytesToHex(signed));
      if (text === undefined || parseNodeJson(text) !== bytesToHex(id)) throw new Error("/transactions/bytes: the node did not accept the transaction");
    },
  });
}
