// The Ergo venue profile's header source, run by the reader itself.
//
// The profile reads each block's section against its header's transaction
// root; proof of work and chain selection are the header source's. This module
// is that source, for headers above the profile's pinned anchor. It reads
// each header from its canonical bytes and derives the id from them, then
// applies the pinned node's (v6.0.6) header rules for a child header: height
// one above the parent, timestamp above the parent's, the context's required
// difficulty and the Autolykos proof of work. It keeps every header it has
// accepted as a tree rooted at the anchor and names the heaviest chain by the
// node's score (the sum of required difficulties). Headers may therefore come
// from any supplier: a supplier can withhold a heavier chain, but it cannot
// make the reader accept a header without the work. The 1,024 headers below
// the anchor, which the difficulty rule reads, are authenticated by linkage to
// the anchor id rather than by work.
//
// The node's header rules do not read the version: it checks a block's
// version against the voted parameters only at a voting epoch's first block,
// so any miner can carry any version byte mid-epoch. Every version is therefore
// read here in the layout the node reads it (the version is a signed byte: a
// new-fields length for 2–127, read above 4; an Autolykos v1 solution for
// version 1, v2 otherwise), so no version can leave the reader on a branch the
// network has left.
//
// Not applied, and recorded as limits: the node's local-clock rule (a
// timestamp at most 20 minutes ahead of the node's clock), its bound on fork
// depth and its checkpoint (local settings) and its marking of headers whose
// block failed full validation, which a header-only reader cannot see. Without
// the clock rule a supplier can lower the required difficulty on a side branch
// by stating future timestamps (halving each epoch after about 256 blocks of
// work at the starting difficulty); such a branch cannot outscore the work of
// the best chain, but its headers are accepted and kept, so bounding what a
// supplier may add is the runtime's supplier policy. Only canonical bytes are
// read, though the node also re-serializes some non-canonical spellings to the
// same id. The Ergo venue profile (venue-ergo.md §3) specifies these rules;
// `ErgoVenue` (src/ergo.ts) reads the chain through this store.
import { blake2b } from "@noble/hashes/blake2b.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, copyUnshared, EncodingError } from "./bytes.js";

/** Mainnet's EIP-37 rule applies to every header at or above this height. */
export const EIP37_ACTIVATION_HEIGHT = 844_673n;
export const DIFFICULTY_EPOCH = 128n;
const USE_LAST_EPOCHS = 8n, BLOCK_INTERVAL_MS = 120_000n, PRECISION = 1_000_000_000n;
/** Mainnet's `initialDifficultyHex`, the floor of the predictive estimate and
 * the bound below which `ErgoVenue` requires a testnet reference anchor. */
export const INITIAL_DIFFICULTY = 0x0117_6500_0000n;
/** Pinned v6.0.6 reference-testnet rules, not caller-selected parameters. */
const TESTNET_INTERVAL_MS = 45_000n, TESTNET_INITIAL_DIFFICULTY = 1n;
const TESTNET_V2_ACTIVATION_HEIGHT = 2_147_483_647n;
export type ErgoHeaderRules = "mainnet" | "testnet";
/** Headers below the anchor the difficulty rule can read: eight epochs. */
export const ANCHOR_CONTEXT = Number(USE_LAST_EPOCHS * DIFFICULTY_EPOCH);
/** Version 1 carries an Autolykos v1 solution and no new-fields length. */
const INITIAL_VERSION = 1;
/** The last version whose new-fields length the node skips rather than reads. */
const LAST_FIXED_LAYOUT_VERSION = 4;
/** The secp256k1 group order, Autolykos' `q`. */
const Q = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;
const K = 32, N_BASE = 1n << 26n, N_INCREASE_START = 600n * 1024n, N_INCREASE_PERIOD = 50n * 1024n, N_INCREASE_MAX = 4_198_400n;
const MAX_TIMESTAMP = (1n << 63n) - 1n, MAX_HEIGHT = (1n << 31n) - 1n;
/** Autolykos' constant `M`: the 8-byte big-endian integers 0 to 1023. */
const M = new Uint8Array(8192);
for (let i = 0; i < 1024; i++) { M[i * 8 + 6] = i >> 8; M[i * 8 + 7] = i & 0xff; }
/** The largest multiple of `q` not above 2^256: Autolykos v1's hash to `[0, q)` rehashes above it. */
const MOD_Q_RANGE = ((1n << 256n) / Q) * Q;

const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
/** Read through the common byte intake; inspect only the owned copy. */
function ownBytes(value: Uint8Array): Uint8Array | undefined {
  try { return copyUnshared(value); }
  catch (error) { if (error instanceof EncodingError) return undefined; throw error; }
}
const unsigned = (bytes: Uint8Array): bigint => bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
const u32be = (n: bigint): Uint8Array => Uint8Array.of(Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
/** The version byte as the node reads it, a signed byte. */
const signedVersion = (version: number): number => version < 128 ? version : version - 256;

/** A header read from its canonical bytes, owned and frozen. */
export interface ErgoHeader {
  readonly bytes: Uint8Array;
  readonly id: Uint8Array;
  /** The version byte, 0–255. */
  readonly version: number;
  readonly parentId: Uint8Array;
  readonly transactionsRoot: Uint8Array;
  readonly timestamp: bigint;
  readonly nBits: number;
  readonly height: bigint;
  /** The serialization without the solution, whose hash is the PoW message. */
  readonly withoutPow: Uint8Array;
  readonly minerKey: Uint8Array;
  readonly nonce: Uint8Array;
  /** Autolykos v1's one-time key `w` and its `d`, for version 1 only. */
  readonly v1?: { readonly w: Uint8Array; readonly d: bigint };
}

/** A minimal unsigned VLQ at `at`, or undefined when absent, non-minimal or above `max`. */
function readVlq(bytes: Uint8Array, at: number, max: bigint): { value: bigint; next: number } | undefined {
  let value = 0n, shift = 0n, i = at;
  for (;;) {
    if (i >= bytes.length || shift > 63n) return undefined;
    const byte = bytes[i++]!;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      // Minimal: a final zero byte adds nothing unless it is the only byte.
      if (byte === 0 && i - at > 1) return undefined;
      return value <= max ? { value, next: i } : undefined;
    }
  }
}

/** A group element as the node writes it: 33 zero bytes for the identity,
 * otherwise a compressed secp256k1 point that decodes. */
function canonicalPoint(bytes: Uint8Array): boolean {
  if (bytes[0] === 0) return bytes.every(byte => byte === 0);
  if (bytes[0] !== 2 && bytes[0] !== 3) return false;
  try { secp256k1.ProjectivePoint.fromHex(bytes); return true; } catch { return false; }
}
const isIdentity = (bytes: Uint8Array): boolean => bytes[0] === 0;

/** One header from its bytes as the pinned node serializes it: version,
 * parent id, AD-proofs root, transactions root, 33-byte state root, VLQ
 * timestamp, extension root, big-endian nBits, VLQ height, three vote bytes;
 * for versions 2–127 a new-fields length, zero through version 4 and followed
 * by that many bytes above it; then the Autolykos solution: for version 1 the
 * 33-byte miner key, the 33-byte `w`, the 8-byte nonce and `d` as a length
 * byte and its minimal unsigned bytes (a single zero byte for zero), for every
 * other version the miner key and the nonce. The bytes end exactly. Only the
 * canonical form is read, so the id is the hash of exactly these bytes, as the
 * node's id is the hash of its own serialization; any other input is
 * undefined. */
export function parseErgoHeader(input: Uint8Array): ErgoHeader | undefined {
  const owned = ownBytes(input);
  if (owned === undefined) return undefined;
  const bytes: Uint8Array = owned;
  const version = bytes[0];
  if (version === undefined) return undefined;
  let at = 1;
  const take = (length: number): Uint8Array | undefined => {
    if (at + length > bytes.length) return undefined;
    const part = bytes.slice(at, at + length);
    at += length;
    return part;
  };
  const parentId = take(32), adProofsRoot = take(32), transactionsRoot = take(32), stateRoot = take(33);
  if (parentId === undefined || adProofsRoot === undefined || transactionsRoot === undefined || stateRoot === undefined) return undefined;
  const timestamp = readVlq(bytes, at, MAX_TIMESTAMP);
  if (timestamp === undefined) return undefined;
  at = timestamp.next;
  const extensionRoot = take(32), nBitsBytes = take(4);
  if (extensionRoot === undefined || nBitsBytes === undefined) return undefined;
  const height = readVlq(bytes, at, MAX_HEIGHT);
  if (height === undefined) return undefined;
  at = height.next;
  if (take(3) === undefined) return undefined;
  const signed = signedVersion(version);
  if (signed > INITIAL_VERSION) {
    const length = take(1);
    if (length === undefined) return undefined;
    // Through version 4 the node skips a nonzero new-fields length without reading the fields and writes it back as
    // zero; above it the node reads the fields and keeps them, so they are part of the id and the work message.
    if (signed <= LAST_FIXED_LAYOUT_VERSION ? length[0] !== 0 : take(length[0]!) === undefined) return undefined;
  }
  const withoutPow = bytes.slice(0, at);
  const minerKey = take(33);
  if (minerKey === undefined || !canonicalPoint(minerKey)) return undefined;
  let v1: { w: Uint8Array; d: bigint } | undefined;
  if (version === INITIAL_VERSION) {
    const w = take(33);
    if (w === undefined || !canonicalPoint(w)) return undefined;
    const nonce = take(8), dLength = take(1);
    if (nonce === undefined || dLength === undefined) return undefined;
    const dBytes = take(dLength[0]!);
    // The node writes d minimally, and zero as one zero byte.
    if (dBytes === undefined || dBytes.length === 0 || (dBytes.length > 1 && dBytes[0] === 0) || at !== bytes.length) return undefined;
    v1 = Object.freeze({ w, d: unsigned(dBytes) });
    return freeze(nonce);
  }
  const nonce = take(8);
  if (nonce === undefined || at !== bytes.length) return undefined;
  return freeze(nonce);

  function freeze(nonce: Uint8Array): ErgoHeader {
    return Object.freeze({
      bytes, id: hash(bytes), version: version!, parentId: parentId!, transactionsRoot: transactionsRoot!, timestamp: timestamp!.value,
      nBits: Number(unsigned(nBitsBytes!)), height: height!.value, withoutPow, minerKey: minerKey!, nonce, ...(v1 === undefined ? {} : { v1 }),
    });
  }
}

/** Bitcoin's compact encoding as the node decodes it (sign bit honoured). */
export function decodeCompactBits(nBits: number): bigint {
  const size = (nBits >>> 24) & 0xff;
  if (size === 0) return 0n;
  const mantissa = [(nBits >>> 16) & 0xff, (nBits >>> 8) & 0xff, nBits & 0xff].slice(0, Math.min(size, 3));
  while (mantissa.length < size) mantissa.push(0);
  const negative = (mantissa[0]! & 0x80) !== 0;
  if (negative) mantissa[0]! &= 0x7f;
  const value = unsigned(Uint8Array.from(mantissa));
  return negative ? -value : value;
}
/** decode(encode(value)) for a non-negative value, the node's normalization:
 * the value keeps its top three bytes of a two's-complement encoding whose
 * length includes a sign byte, so the sign bit of the mantissa is never set. */
export function normalizeDifficulty(value: bigint): bigint {
  if (value < 0n) throw new RangeError("difficulty is non-negative");
  const size = BigInt(value.toString(2).length >> 3) + 1n;
  return size <= 3n ? value : (value >> (8n * (size - 3n))) << (8n * (size - 3n));
}

/** Autolykos v2's table size `N` at a height. */
export function autolykosTableSize(height: bigint): bigint {
  const h = height < N_INCREASE_MAX ? height : N_INCREASE_MAX;
  if (h < N_INCREASE_START) return N_BASE;
  let n = N_BASE;
  for (let i = 0n; i < (h - N_INCREASE_START) / N_INCREASE_PERIOD + 1n; i++) n = n / 100n * 105n;
  return n;
}
/** Autolykos' `k` indices in `[0, N)` from a seed. */
function indexes(seed: Uint8Array, n: bigint): bigint[] {
  const digest = hash(seed), extended = concat(digest, digest.slice(0, 3));
  return Array.from({ length: K }, (_, k) => unsigned(extended.slice(k, k + 4)) % n);
}

/** The Autolykos v2 hit of a header, which proof of work requires below `q / difficulty`. */
export function autolykosHit(header: ErgoHeader): bigint {
  const msg = hash(header.withoutPow), heightBytes = u32be(header.height), n = autolykosTableSize(header.height);
  const i = u32be(unsigned(hash(concat(msg, header.nonce)).slice(24)) % n);
  const f = hash(concat(i, heightBytes, M)).slice(1);
  let sum = 0n;
  for (const index of indexes(concat(f, msg, header.nonce), n)) sum += unsigned(hash(concat(u32be(index), heightBytes, M)).slice(1));
  return unsigned(hash(hexToBytes32(sum)));
}
/** Autolykos v1's hash to `[0, q)`: Blake2b-256, rehashed until below the largest multiple of `q`, then reduced. */
function hashModQ(input: Uint8Array): bigint {
  for (let digest = hash(input); ; digest = hash(digest)) {
    const value = unsigned(digest);
    if (value < MOD_Q_RANGE) return value % Q;
  }
}
/** Autolykos v1's `f` mod `q`: the sum of `k` elements `H(j | M | pk | m | w)`
 * over the indices from `m | nonce` in a table of the fixed size `N`, where
 * `m` hashes the header without its solution. It does not read `d`. */
export function autolykosV1Exponent(withoutPow: Uint8Array, nonce: Uint8Array, minerKey: Uint8Array, w: Uint8Array): bigint {
  const msg = hash(withoutPow);
  let f = 0n;
  for (const index of indexes(concat(msg, nonce), N_BASE)) f += hashModQ(concat(u32be(index), M, minerKey, msg, w));
  return f % Q;
}
/** Autolykos v1's equation for a version 1 header: `d` below the target, the
 * miner key and `w` not the identity, and `w^f = g^d · pk`. */
function autolykosV1Valid(header: ErgoHeader, target: bigint): boolean {
  const { v1 } = header;
  if (v1 === undefined || v1.d >= target || isIdentity(header.minerKey) || isIdentity(v1.w)) return false;
  const Point = secp256k1.ProjectivePoint;
  const left = Point.fromHex(v1.w).multiplyUnsafe(autolykosV1Exponent(header.withoutPow, header.nonce, header.minerKey, v1.w));
  const right = Point.BASE.multiplyUnsafe(v1.d % Q).add(Point.fromHex(header.minerKey));
  return left.equals(right);
}
/** Proof of work at the header's own difficulty: positive and at most `q`
 * (above it no hit qualifies; at zero or below the node's target is
 * undefined), then Autolykos v1 for version 1 and the v2 hit below
 * `q / difficulty` for every other version, as the node dispatches. */
export function autolykosPowValid(header: ErgoHeader): boolean {
  const difficulty = decodeCompactBits(header.nBits);
  if (difficulty <= 0n || difficulty > Q) return false;
  return header.version === INITIAL_VERSION ? autolykosV1Valid(header, Q / difficulty) : autolykosHit(header) < Q / difficulty;
}
function hexToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31, v = value; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/** The node's least-squares prediction over successive epoch estimates,
 * compact-normalized. Mainnet EIP-37 also clamps and averages this result;
 * reference testnet uses it directly. Inputs are linked internal ancestors. */
function predictiveDifficulty(previous: readonly ErgoHeader[], interval: bigint, initial: bigint): bigint {
  const last = previous[previous.length - 1]!;
  const perEpoch = (start: ErgoHeader, end: ErgoHeader): bigint =>
    decodeCompactBits(end.nBits) * interval * DIFFICULTY_EPOCH / (end.timestamp - start.timestamp);
  let predictive: bigint;
  if (previous.length === 1 || previous[0]!.timestamp >= last.timestamp) predictive = decodeCompactBits(previous[0]!.nBits);
  else {
    const data = previous.slice(1).map((end, i) => [end.height, perEpoch(previous[i]!, end)] as const);
    const size = BigInt(data.length);
    let interpolated: bigint;
    if (data.length === 1) interpolated = data[0]![1];
    else {
      let xy = 0n, x = 0n, x2 = 0n, y = 0n;
      for (const [height, difficulty] of data) { xy += height * difficulty; x += height; x2 += height * height; y += difficulty; }
      const b = (xy * size - x * y) * PRECISION / (x2 * size - x * x);
      const a = (y * PRECISION - b * x) / size / PRECISION;
      // DifficultyAdjustment.interpolate computes this addition as Scala Int.
      // Preserve its wrap in the final epoch, even though all other arithmetic is bigint.
      const point = BigInt.asIntN(32, data[data.length - 1]![0] + DIFFICULTY_EPOCH);
      interpolated = a + b * point / PRECISION;
    }
    predictive = interpolated >= 1n ? interpolated : initial;
  }
  return normalizeDifficulty(predictive);
}

/** Testnet's pinned legacy predictor: no EIP-37 average or clamps. */
export function testnetDifficulty(previous: readonly ErgoHeader[]): bigint {
  return predictiveDifficulty(previous, TESTNET_INTERVAL_MS, TESTNET_INITIAL_DIFFICULTY);
}

/** Mainnet EIP-37: average the classic estimate and clamped prediction, then clamp and normalize. */
export function eip37Difficulty(previous: readonly ErgoHeader[]): bigint {
  const last = previous[previous.length - 1]!, lastDifficulty = decodeCompactBits(last.nBits);
  const perEpoch = (start: ErgoHeader, end: ErgoHeader): bigint =>
    decodeCompactBits(end.nBits) * BLOCK_INTERVAL_MS * DIFFICULTY_EPOCH / (end.timestamp - start.timestamp);
  const clamp = (value: bigint): bigint => value > lastDifficulty
    ? (value < lastDifficulty * 3n / 2n ? value : lastDifficulty * 3n / 2n)
    : (value > lastDifficulty / 2n ? value : lastDifficulty / 2n);
  const predictive = predictiveDifficulty(previous, BLOCK_INTERVAL_MS, INITIAL_DIFFICULTY);
  const classic = perEpoch(previous[previous.length - 2]!, last);
  return normalizeDifficulty(clamp((classic + clamp(predictive)) / 2n));
}

export type ErgoHeaderRefusal = "malformed" | "unknown-parent" | "below-anchor" | "height" | "timestamp" | "difficulty" | "pow";
/** The fields of an accepted header a reader reads its block's section by. */
export interface ErgoHeaderView {
  readonly id: Uint8Array;
  readonly parentId: Uint8Array;
  readonly height: bigint;
  readonly version: bigint;
  readonly transactionsRoot: Uint8Array;
}
export interface ErgoHeaderChain {
  readonly tipId: Uint8Array;
  readonly height: bigint;
  /** Sum of required difficulties above the anchor. */
  readonly score: bigint;
  /** The best chain from the anchor's child to its tip. */
  readonly headers: readonly ErgoHeaderView[];
}
export interface ErgoHeaderStore {
  /** Accept one header whose parent is the anchor or an accepted header. */
  add(bytes: Uint8Array): "added" | "known" | ErgoHeaderRefusal;
  /** The best chain, copied out: linear in its length, for callers that want all of it. */
  best(): ErgoHeaderChain;
  /** The best chain's header at a height above the anchor, undefined above its tip. */
  bestAt(height: bigint): ErgoHeaderView | undefined;
  /** Whether an accepted header above the anchor is on the best chain. */
  isBest(id: Uint8Array): boolean;
  /** The best chain's tip and the anchor's height, in constant time. */
  tip(): { readonly id: Uint8Array; readonly height: bigint; readonly score: bigint; readonly anchorHeight: bigint };
  /** The height of the highest header that is both an ancestor of (or equal
   * to) the accepted header `id` and on the best chain; the anchor's height
   * where they share nothing above it, undefined for an id the store has not
   * accepted above the anchor. Linear in the distance to that ancestor. */
  forkHeight(id: Uint8Array): bigint | undefined;
  /** The height of an accepted header; undefined for one the store has not accepted. */
  heightOf(id: Uint8Array): bigint | undefined;
  /** Drop complete inferior side subtrees below a final header, except
   * those containing a protected incomplete supplier pass. */
  prune(witnessed: Uint8Array, protectedIds: readonly Uint8Array[]): void;
  /** Check every header the rows hold, best and side, as `add` accepted it: parsed from its bytes, linked to its
   * parent one height below, a later timestamp, the required difficulty and the score it adds; the work too where
   * `work` is set. The best chain must link from the anchor to the tip. Throws on the first header that does not;
   * answers how many were checked. Linear in the rows, so it is for audits, never a sync. */
  audit(work: boolean): number;
}

/** One accepted header above the anchor as its rows keep it. */
export interface ErgoHeaderRow { readonly height: bigint; readonly parentId: Uint8Array; readonly score: bigint; readonly bytes: Uint8Array }
/**
 * Where a store keeps what it accepted above the anchor: every header with its
 * chain's score, the best chain by height and the headers off it. The store
 * reads ancestry from here, so what it holds in memory does not grow with the
 * chain; a durable view's rows are its journal's (`ergo-store.ts`). Ids and
 * bytes passed in are the store's own; rows return bytes the store may keep.
 */
export interface ErgoHeaderRows {
  get(id: Uint8Array): ErgoHeaderRow | undefined;
  put(id: Uint8Array, row: ErgoHeaderRow): void;
  delete(id: Uint8Array): void;
  /** The best chain's id at a height above the anchor, undefined above its tip. */
  bestAt(height: bigint): Uint8Array | undefined;
  /** The best chain's tip height; undefined while it is the anchor. */
  bestHeight(): bigint | undefined;
  /** Make `ids` the best chain from `fromHeight` upward, dropping every height above the last. */
  setBest(fromHeight: bigint, ids: readonly Uint8Array[]): void;
  /** Accepted headers off the best chain. */
  sides(): readonly Uint8Array[];
  addSide(id: Uint8Array): void;
  removeSide(id: Uint8Array): void;
}

/** Rows in memory: for a store used on its own, whose memory then grows with the chain it accepts. */
export function memoryHeaderRows(): ErgoHeaderRows {
  const headers = new Map<string, ErgoHeaderRow>(), best: Uint8Array[] = [], side = new Map<string, Uint8Array>();
  let base: bigint | undefined;
  return {
    get: id => headers.get(bytesToHex(id)),
    put: (id, row) => { headers.set(bytesToHex(id), row); },
    delete: id => { headers.delete(bytesToHex(id)); },
    bestAt: height => base === undefined || height < base ? undefined : best[Number(height - base)],
    bestHeight: () => base === undefined || best.length === 0 ? undefined : base + BigInt(best.length) - 1n,
    setBest(fromHeight, ids) {
      if (base === undefined) base = fromHeight;
      if (fromHeight < base || fromHeight > base + BigInt(best.length)) throw new Error("best chain rows must stay contiguous");
      best.length = Number(fromHeight - base);
      best.push(...ids);
    },
    sides: () => [...side.values()],
    addSide: id => { side.set(bytesToHex(id), id); },
    removeSide: id => { side.delete(bytesToHex(id)); },
  };
}

/** Stored entries a store keeps parsed at most, cleared when full. */
const ENTRY_CACHE = 4096;
/** An accepted header as the store walks it: its links, height and score at hand, its bytes parsed only when a rule
 * reads them (a stored row's work was checked when it was accepted). */
interface Entry { readonly id: Uint8Array; readonly parentId: Uint8Array; readonly height: bigint; readonly score: bigint; readonly above: boolean; readonly header: ErgoHeader }
const parsed = (header: ErgoHeader, score: bigint, above: boolean): Entry =>
  Object.freeze({ id: header.id, parentId: header.parentId, height: header.height, score, above, header });
const view = (header: ErgoHeader): ErgoHeaderView => Object.freeze({ id: copyBytes(header.id), parentId: copyBytes(header.parentId),
  height: header.height, version: BigInt(header.version), transactionsRoot: copyBytes(header.transactionsRoot) });

/** A store rooted at the anchor. `context` is the chain, ascending, of at
 * least `ANCHOR_CONTEXT` headers below the anchor followed by the anchor
 * itself; it is authenticated by linkage alone, its last id must be
 * `anchorId`. Mainnet anchors must precede only EIP-37 headers; testnet anchors
 * are at least 1,025, giving the full lookback above genesis height 1.
 * The closed rule selector is chosen by ErgoVenue from its owned profile.
 * `rows` holds everything above the anchor and may already hold a chain this
 * store's rules accepted before (a durable view's); the context stays in memory. */
export function ergoHeaderStore(anchorId: Uint8Array, context: readonly Uint8Array[], rules: ErgoHeaderRules = "mainnet",
  rows: ErgoHeaderRows = memoryHeaderRows()): ErgoHeaderStore | undefined {
  const anchor = ownBytes(anchorId);
  if (anchor === undefined || anchor.length !== 32 || !Array.isArray(context) || context.length < ANCHOR_CONTEXT + 1 ||
      (rules !== "mainnet" && rules !== "testnet")) return undefined;
  const below = new Map<string, Entry>(), byHeight: Entry[] = [];
  let previous: Entry | undefined;
  for (const bytes of context) {
    const header = parseErgoHeader(bytes);
    if (header === undefined || below.has(bytesToHex(header.id))) return undefined;
    if (previous !== undefined && (header.height !== previous.height + 1n || compareBytes(header.parentId, previous.id) !== 0)) return undefined;
    previous = parsed(header, 0n, false);
    below.set(bytesToHex(header.id), previous); byHeight.push(previous);
  }
  const root = previous!, anchorHeight = root.height, lowest = byHeight[0]!.height;
  const minimum = rules === "testnet" ? BigInt(ANCHOR_CONTEXT) + 1n : EIP37_ACTIVATION_HEIGHT - 1n;
  if (compareBytes(root.id, anchor) !== 0 || anchorHeight < minimum) return undefined;

  /** Entries read from the rows, kept for repeated walks until they are many; a pruned id leaves at once. */
  const cache = new Map<string, Entry>();
  /** An accepted header above the anchor from the rows. Its bytes are parsed, and their id, parent and height
   * checked against the row, the first time a rule reads them. */
  const stored = (id: Uint8Array): Entry | undefined => {
    const key = bytesToHex(id), kept = cache.get(key);
    if (kept !== undefined) return kept;
    const row = rows.get(id);
    if (row === undefined) return undefined;
    if (row.height <= anchorHeight || row.parentId.length !== 32) throw new Error("a stored header row is malformed");
    let header: ErgoHeader | undefined;
    const at: Entry = Object.freeze({ id: copyBytes(id), parentId: row.parentId, height: row.height, score: row.score, above: true,
      get header(): ErgoHeader {
        if (header !== undefined) return header;
        const read = parseErgoHeader(row.bytes);
        if (read === undefined || compareBytes(read.id, id) !== 0 || read.height !== row.height || compareBytes(read.parentId, row.parentId) !== 0) {
          throw new Error("a stored header row does not reproduce its id, parent and height");
        }
        return header = read;
      } });
    if (cache.size >= ENTRY_CACHE) cache.clear();
    cache.set(key, at);
    return at;
  };
  const entry = (id: Uint8Array): Entry | undefined => below.get(bytesToHex(id)) ?? stored(id);
  const tipOf = (): Entry => {
    const height = rows.bestHeight();
    if (height === undefined) return root;
    const at = stored(rows.bestAt(height)!);
    if (at === undefined || at.height !== height) throw new Error("the best chain's rows do not reach its tip");
    return at;
  };
  let best = tipOf();
  /** The best chain's header at a height above the anchor and at most its tip. */
  const bestEntry = (height: bigint): Entry => {
    const id = rows.bestAt(height), at = id === undefined ? undefined : stored(id);
    if (at === undefined) throw new Error("the best chain's rows are incomplete");
    return at;
  };
  const onBest = (at: Entry): boolean => !at.above || compareBytes(rows.bestAt(at.height) ?? new Uint8Array(0), at.id) === 0;
  const parentOf = (at: Entry): Entry | undefined => at.above ? entry(at.parentId) : byHeight[Number(at.height - lowest) - 1];
  /** The ancestor of `at` at `height`: by height once the walk reaches the best chain or the context. */
  const ancestorAt = (at: Entry | undefined, height: bigint): Entry | undefined => {
    while (at !== undefined && at.height > height) {
      if (onBest(at)) {
        if (height <= anchorHeight) return height < lowest ? undefined : byHeight[Number(height - lowest)];
        return height > best.height ? undefined : bestEntry(height);
      }
      at = parentOf(at);
    }
    return at?.height === height ? at : undefined;
  };
  /** The highest header on the best chain (the anchor included) that `at` descends from or is. */
  const fork = (at: Entry): Entry => {
    let walk: Entry | undefined = at;
    while (walk !== undefined && !onBest(walk)) walk = parentOf(walk);
    if (walk === undefined) throw new Error("an accepted header does not descend from the anchor");
    return walk;
  };
  const required = (parent: Entry): bigint | undefined => {
    // HeadersProcessor.requiredDifficultyAfter applies this before the legacy
    // epoch calculation. The parser's maximum height makes only the child case reachable.
    if (rules === "testnet" && (parent.height === TESTNET_V2_ACTIVATION_HEIGHT || parent.height + 1n === TESTNET_V2_ACTIVATION_HEIGHT)) return 32n;
    if (parent.height % DIFFICULTY_EPOCH !== 0n) return decodeCompactBits(parent.header.nBits);
    const previousHeaders: ErgoHeader[] = [];
    for (let i = USE_LAST_EPOCHS; i >= 0n; i--) {
      const ancestor = ancestorAt(parent, parent.height - i * DIFFICULTY_EPOCH);
      // The context covers eight epochs below the anchor, so an ancestor is missing only if the store is misbuilt.
      if (ancestor === undefined) return undefined;
      previousHeaders.push(ancestor.header);
    }
    return rules === "testnet" ? testnetDifficulty(previousHeaders) : eip37Difficulty(previousHeaders);
  };
  /** Make `tip` the best chain's tip: its headers above where it meets the old best chain replace the old ones,
   * which become side headers. */
  const promote = (tip: Entry): void => {
    const path: Entry[] = [];
    let at: Entry | undefined = tip;
    while (at !== undefined && !onBest(at)) { path.push(at); at = parentOf(at); }
    if (at === undefined) throw new Error("an accepted header does not descend from the anchor");
    for (let height = at.height + 1n; height <= best.height; height++) rows.addSide(bestEntry(height).id);
    path.reverse();
    for (const step of path) rows.removeSide(step.id);
    rows.setBest(at.height + 1n, path.map(step => step.id));
    best = tip;
  };

  /** Why an accepted header no longer meets the rules it was accepted under, or undefined. */
  const fault = (at: Entry, work: boolean): string | undefined => {
    const parent = parentOf(at), header = at.header;
    if (parent === undefined) return "its parent is missing";
    if (header.height !== parent.height + 1n || header.timestamp <= parent.header.timestamp) return "it does not follow its parent";
    const difficulty = required(parent);
    if (difficulty === undefined || decodeCompactBits(header.nBits) !== difficulty || at.score !== parent.score + difficulty) return "its difficulty or score is wrong";
    if (work && !autolykosPowValid(header)) return "its work does not hold";
    return undefined;
  };

  return Object.freeze({
    audit(work: boolean): number {
      let checked = 0, parent: Entry = root;
      for (let height = anchorHeight + 1n; height <= best.height; height++, checked++) {
        const at = bestEntry(height), why = compareBytes(at.parentId, parent.id) !== 0 ? "it does not link to the best chain below it" : fault(at, work);
        if (why !== undefined) throw new Error(`best-chain header at height ${height}: ${why}`);
        parent = at;
      }
      for (const id of rows.sides()) {
        const at = stored(id), why = at === undefined ? "its row is missing" : at.above && onBest(at) ? "it is on the best chain" : fault(at, work);
        if (why !== undefined) throw new Error(`side header ${bytesToHex(id)}: ${why}`);
        checked++;
      }
      return checked;
    },
    add(input: Uint8Array): "added" | "known" | ErgoHeaderRefusal {
      const header = parseErgoHeader(input);
      if (header === undefined) return "malformed";
      if (entry(header.id) !== undefined) return "known";
      const parent = entry(header.parentId);
      if (parent === undefined) return "unknown-parent";
      if (!parent.above && parent !== root) return "below-anchor";
      if (header.height !== parent.height + 1n) return "height";
      if (header.timestamp <= parent.header.timestamp) return "timestamp";
      const difficulty = required(parent);
      if (difficulty === undefined) throw new Error("anchor context misses a difficulty ancestor");
      // A difficulty above q admits no hit; the node compares decoded values, so any encoding of the value is accepted.
      if (difficulty <= 0n || difficulty > Q || decodeCompactBits(header.nBits) !== difficulty) return "difficulty";
      if (!autolykosPowValid(header)) return "pow";
      const added = parsed(header, parent.score + difficulty, true);
      rows.put(header.id, { height: header.height, parentId: header.parentId, score: added.score, bytes: header.bytes });
      // The node keeps its best chain unless a new one has strictly more score.
      if (added.score > best.score) promote(added);
      else rows.addSide(header.id);
      return "added";
    },
    best(): ErgoHeaderChain {
      const headers: ErgoHeaderView[] = [];
      for (let height = anchorHeight + 1n; height <= best.height; height++) headers.push(view(bestEntry(height).header));
      return Object.freeze({ tipId: copyBytes(best.id), height: best.height, score: best.score, headers: Object.freeze(headers) });
    },
    bestAt(height: bigint): ErgoHeaderView | undefined {
      if (typeof height !== "bigint" || height <= anchorHeight || height > best.height) return undefined;
      return view(bestEntry(height).header);
    },
    isBest(id: Uint8Array): boolean {
      const owned = ownBytes(id), at = owned === undefined || owned.length !== 32 ? undefined : stored(owned);
      return at !== undefined && onBest(at);
    },
    tip() {
      return Object.freeze({ id: copyBytes(best.id), height: best.height, score: best.score, anchorHeight });
    },
    forkHeight(id: Uint8Array): bigint | undefined {
      const owned = ownBytes(id), at = owned === undefined || owned.length !== 32 ? undefined : stored(owned);
      return at === undefined ? undefined : fork(at).height;
    },
    heightOf(id: Uint8Array): bigint | undefined {
      const owned = ownBytes(id);
      if (owned === undefined || owned.length !== 32) return undefined;
      return below.get(bytesToHex(owned))?.height ?? rows.get(owned)?.height;
    },
    prune(witnessed: Uint8Array, protectedIds: readonly Uint8Array[]): void {
      const final = stored(witnessed);
      if (final === undefined || !onBest(final)) throw new Error("pruning requires a best-chain final header");
      const keep = new Set<string>();
      for (const id of protectedIds) {
        let at = entry(id);
        if (at === undefined) throw new Error("unknown protected header");
        while (at !== undefined && !onBest(at) && !keep.has(bytesToHex(at.id))) { keep.add(bytesToHex(at.id)); at = parentOf(at); }
      }
      // A side header is kept while it descends from the final header (it meets the best chain at or above it) or
      // lies on a protected path. Keeping an ancestor alone does not protect its divergent children; only whole
      // protected paths and descendants of the final header are required for continuation. Each side header's
      // meeting height is walked once.
      const meets = new Map<string, bigint>();
      const meeting = (at: Entry): bigint => {
        const walked: string[] = [];
        let walk: Entry | undefined = at, height: bigint | undefined;
        while (walk !== undefined && !onBest(walk)) {
          const known = meets.get(bytesToHex(walk.id));
          if (known !== undefined) { height = known; break; }
          walked.push(bytesToHex(walk.id)); walk = parentOf(walk);
        }
        if (height === undefined) {
          if (walk === undefined) throw new Error("an accepted header does not descend from the anchor");
          height = walk.height;
        }
        for (const key of walked) meets.set(key, height);
        return height;
      };
      const doomed: Uint8Array[] = [];
      for (const id of rows.sides()) {
        if (keep.has(bytesToHex(id))) continue;
        const at = stored(id);
        if (at === undefined) throw new Error("a side header row is missing");
        if (meeting(at) < final.height) doomed.push(id);
      }
      // Deleted only once every side header is judged, so no walk meets a deleted parent.
      for (const id of doomed) { rows.delete(id); rows.removeSide(id); cache.delete(bytesToHex(id)); }
    },
  });
}
