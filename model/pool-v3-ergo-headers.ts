// The Ergo venue profile's header source, run by the reader itself.
//
// The profile's range verifier reads a header chain it does not authenticate:
// proof of work and chain selection are the header source's. This module is
// that source, for mainnet headers above the profile's pinned anchor. It reads
// each header from its canonical bytes and derives the id from them, then
// applies the pinned node's (v6.0.6) header rules for a child header: height
// one above the parent, timestamp above the parent's, the EIP-37 required
// difficulty and the Autolykos v2 proof of work. It keeps every header it has
// accepted as a tree rooted at the anchor and names the heaviest chain by the
// node's score (the sum of required difficulties). Headers may therefore come
// from any supplier: a supplier can withhold a heavier chain, but it cannot
// make the reader accept a header without the work. The 1,024 headers below
// the anchor, which the difficulty rule reads, are authenticated by linkage to
// the anchor id rather than by work.
//
// Not applied, and recorded as limits: the node's local-clock rule (a
// timestamp at most 20 minutes ahead of the node's clock), its bound on fork
// depth (a local setting) and its marking of headers whose block failed full
// validation, which a header-only reader cannot see. Without the clock rule a
// supplier can lower the required difficulty on a side branch by stating
// future timestamps (halving each epoch after about 256 blocks of work at the
// starting difficulty); such a branch cannot outscore the work of the best
// chain, but its headers are accepted and kept, so bounding what a supplier
// may add is the runtime's supplier policy. Only canonical bytes are read,
// though the node also re-serializes some non-canonical spellings to the same
// id. No specification selects this source and no runtime path reads it.
import { blake2b } from "@noble/hashes/blake2b.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes } from "../src/bytes.js";
import type { ErgoHeaderView } from "./pool-v3-ergo-profile.js";

/** Mainnet's EIP-37 rule applies to every header at or above this height. */
export const EIP37_ACTIVATION_HEIGHT = 844_673n;
export const DIFFICULTY_EPOCH = 128n;
const USE_LAST_EPOCHS = 8n, BLOCK_INTERVAL_MS = 120_000n, PRECISION = 1_000_000_000n;
/** Mainnet's `initialDifficultyHex`, the floor of the predictive estimate. */
const INITIAL_DIFFICULTY = 0x0117_6500_0000n;
/** Headers below the anchor the difficulty rule can read: eight epochs. */
export const ANCHOR_CONTEXT = Number(USE_LAST_EPOCHS * DIFFICULTY_EPOCH);
/** Header versions whose rules this module applies (hardening, 5.0, 6.0). */
export const MIN_HEADER_VERSION = 2, MAX_HEADER_VERSION = 4;
/** The secp256k1 group order, Autolykos' `q`. */
const Q = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_fffe_baae_dce6_af48_a03b_bfd2_5e8c_d036_4141n;
const K = 32, N_BASE = 1n << 26n, N_INCREASE_START = 600n * 1024n, N_INCREASE_PERIOD = 50n * 1024n, N_INCREASE_MAX = 4_198_400n;
const MAX_TIMESTAMP = (1n << 63n) - 1n, MAX_HEIGHT = (1n << 31n) - 1n;
/** Autolykos' constant `M`: the 8-byte big-endian integers 0 to 1023. */
const M = new Uint8Array(8192);
for (let i = 0; i < 1024; i++) { M[i * 8 + 6] = i >> 8; M[i * 8 + 7] = i & 0xff; }

const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
/** A real byte array: `ArrayBuffer.isView` is read first, so an object that
 * only inherits from `Uint8Array` or a proxy is refused before any getter
 * runs. */
const isBytes = (v: unknown): v is Uint8Array =>
  ArrayBuffer.isView(v) && v instanceof Uint8Array && !(v.buffer instanceof SharedArrayBuffer);
const unsigned = (bytes: Uint8Array): bigint => bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
const u32be = (n: bigint): Uint8Array => Uint8Array.of(Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A header read from its canonical bytes, owned and frozen. */
export interface ErgoHeader {
  readonly bytes: Uint8Array;
  readonly id: Uint8Array;
  readonly version: number;
  readonly parentId: Uint8Array;
  readonly transactionsRoot: Uint8Array;
  readonly timestamp: bigint;
  readonly nBits: number;
  readonly height: bigint;
  /** The serialization without the solution, whose hash is the PoW message. */
  readonly withoutPow: Uint8Array;
  readonly nonce: Uint8Array;
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

/** A miner key as the node reads it: a leading zero byte is the group
 * identity (canonical only as 33 zero bytes); otherwise a compressed
 * secp256k1 point that decodes. */
function canonicalPoint(bytes: Uint8Array): boolean {
  if (bytes[0] === 0) return bytes.every(byte => byte === 0);
  if (bytes[0] !== 2 && bytes[0] !== 3) return false;
  try { secp256k1.ProjectivePoint.fromHex(bytes); return true; } catch { return false; }
}

/** One header from its bytes as the pinned node serializes it (versions 2–4:
 * version, parent id, AD-proofs root, transactions root, 33-byte state root,
 * VLQ timestamp, extension root, big-endian nBits, VLQ height, three vote
 * bytes, a zero new-fields length, then the Autolykos v2 solution: the
 * 33-byte miner key and the 8-byte nonce), ending exactly. Only the
 * canonical form is read, so the id is the hash of exactly these bytes, as
 * the node's id is the hash of its own serialization; any other input is
 * undefined. */
export function parseErgoHeader(input: Uint8Array): ErgoHeader | undefined {
  if (!isBytes(input)) return undefined;
  const bytes = copyBytes(input);
  const version = bytes[0];
  if (version === undefined || version < MIN_HEADER_VERSION || version > MAX_HEADER_VERSION) return undefined;
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
  const votes = take(3), newFields = take(1);
  // A version 2–4 node skips a nonzero new-fields length without reading the fields and writes it back as zero.
  if (votes === undefined || newFields === undefined || newFields[0] !== 0) return undefined;
  const withoutPow = bytes.slice(0, at);
  const minerKey = take(33), nonce = take(8);
  if (minerKey === undefined || nonce === undefined || at !== bytes.length || !canonicalPoint(minerKey)) return undefined;
  return Object.freeze({
    bytes, id: hash(bytes), version, parentId, transactionsRoot, timestamp: timestamp.value,
    nBits: Number(unsigned(nBitsBytes)), height: height.value, withoutPow, nonce,
  });
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

/** The Autolykos v2 hit of a header, which proof of work requires below `q / difficulty`. */
export function autolykosHit(header: ErgoHeader): bigint {
  const msg = hash(header.withoutPow), heightBytes = u32be(header.height), n = autolykosTableSize(header.height);
  const i = u32be(unsigned(hash(concat(msg, header.nonce)).slice(24)) % n);
  const f = hash(concat(i, heightBytes, M)).slice(1);
  const seed = hash(concat(f, msg, header.nonce));
  const extended = concat(seed, seed.slice(0, 3));
  let sum = 0n;
  for (let k = 0; k < K; k++) {
    const index = unsigned(extended.slice(k, k + 4)) % n;
    sum += unsigned(hash(concat(u32be(index), heightBytes, M)).slice(1));
  }
  return unsigned(hash(hexToBytes32(sum)));
}
/** Proof of work at the header's own difficulty: positive and at most `q`
 * (above it no hit qualifies; at zero or below the node's target is
 * undefined), with the hit below `q / difficulty`. */
export function autolykosPowValid(header: ErgoHeader): boolean {
  const difficulty = decodeCompactBits(header.nBits);
  return difficulty > 0n && difficulty <= Q && autolykosHit(header) < Q / difficulty;
}
function hexToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31, v = value; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

/** The difficulty a header must carry after `parent`, from the headers at
 * heights `parent − 128·i` for `i` = 8 down to 0 (ascending) at an epoch
 * boundary; elsewhere the parent's. This is the node's EIP-37 rule: the
 * average of the classic estimate over the last epoch and the
 * least-squares prediction over eight epochs (itself held within ×1.5 and
 * ÷2 of the last difficulty), held within the same bounds and normalized. */
export function eip37Difficulty(previous: readonly ErgoHeader[]): bigint {
  const last = previous[previous.length - 1]!, lastDifficulty = decodeCompactBits(last.nBits);
  const perEpoch = (start: ErgoHeader, end: ErgoHeader): bigint =>
    decodeCompactBits(end.nBits) * BLOCK_INTERVAL_MS * DIFFICULTY_EPOCH / (end.timestamp - start.timestamp);
  const clamp = (value: bigint): bigint => value > lastDifficulty
    ? (value < lastDifficulty * 3n / 2n ? value : lastDifficulty * 3n / 2n)
    : (value > lastDifficulty / 2n ? value : lastDifficulty / 2n);
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
      interpolated = a + b * (data[data.length - 1]![0] + DIFFICULTY_EPOCH) / PRECISION;
    }
    predictive = interpolated >= 1n ? interpolated : INITIAL_DIFFICULTY;
  }
  predictive = normalizeDifficulty(predictive);
  const classic = perEpoch(previous[previous.length - 2]!, last);
  return normalizeDifficulty(clamp((classic + clamp(predictive)) / 2n));
}

export type ErgoHeaderRefusal = "malformed" | "unknown-parent" | "below-anchor" | "height" | "timestamp" | "difficulty" | "pow";
export interface ErgoHeaderChain {
  readonly tipId: Uint8Array;
  readonly height: bigint;
  /** Sum of required difficulties above the anchor. */
  readonly score: bigint;
  /** The best chain from the anchor's child to its tip, for the range verifier. */
  readonly headers: readonly ErgoHeaderView[];
}
export interface ErgoHeaderStore {
  /** Accept one header whose parent is the anchor or an accepted header. */
  add(bytes: Uint8Array): "added" | "known" | ErgoHeaderRefusal;
  /** The best chain, copied out: linear in its length, so call it after a batch of additions. */
  best(): ErgoHeaderChain;
}
interface Entry { readonly header: ErgoHeader; readonly parent: Entry | undefined; readonly score: bigint; readonly above: boolean }

/** A store rooted at the anchor. `context` is the chain, ascending, of at
 * least `ANCHOR_CONTEXT` headers below the anchor followed by the anchor
 * itself; it is authenticated by linkage alone, its last id must be
 * `anchorId`, and the anchor must sit where every header above it follows
 * the EIP-37 rule. Otherwise there is no store. */
export function ergoHeaderStore(anchorId: Uint8Array, context: readonly Uint8Array[]): ErgoHeaderStore | undefined {
  if (!isBytes(anchorId) || anchorId.length !== 32 || !Array.isArray(context) || context.length < ANCHOR_CONTEXT + 1) return undefined;
  const anchor = copyBytes(anchorId);
  const byId = new Map<string, Entry>();
  let previous: Entry | undefined;
  for (const bytes of context) {
    const header = parseErgoHeader(bytes);
    if (header === undefined || byId.has(bytesToHex(header.id))) return undefined;
    if (previous !== undefined && (header.height !== previous.header.height + 1n || compareBytes(header.parentId, previous.header.id) !== 0)) return undefined;
    previous = Object.freeze({ header, parent: previous, score: 0n, above: false });
    byId.set(bytesToHex(header.id), previous);
  }
  const root = previous!;
  if (compareBytes(root.header.id, anchor) !== 0 || root.header.height + 1n < EIP37_ACTIVATION_HEIGHT) return undefined;
  let best = root;

  const ancestorAt = (entry: Entry, height: bigint): Entry | undefined => {
    let at: Entry | undefined = entry;
    while (at !== undefined && at.header.height > height) at = at.parent;
    return at?.header.height === height ? at : undefined;
  };
  const required = (parent: Entry): bigint | undefined => {
    if (parent.header.height % DIFFICULTY_EPOCH !== 0n) return decodeCompactBits(parent.header.nBits);
    const previousHeaders: ErgoHeader[] = [];
    for (let i = USE_LAST_EPOCHS; i >= 0n; i--) {
      const ancestor = ancestorAt(parent, parent.header.height - i * DIFFICULTY_EPOCH);
      // The context covers eight epochs below the anchor, so an ancestor is missing only if the store is misbuilt.
      if (ancestor === undefined) return undefined;
      previousHeaders.push(ancestor.header);
    }
    return eip37Difficulty(previousHeaders);
  };

  return Object.freeze({
    add(input: Uint8Array): "added" | "known" | ErgoHeaderRefusal {
      const header = parseErgoHeader(input);
      if (header === undefined) return "malformed";
      if (byId.has(bytesToHex(header.id))) return "known";
      const parent = byId.get(bytesToHex(header.parentId));
      if (parent === undefined) return "unknown-parent";
      if (!parent.above && parent !== root) return "below-anchor";
      if (header.height !== parent.header.height + 1n) return "height";
      if (header.timestamp <= parent.header.timestamp) return "timestamp";
      const difficulty = required(parent);
      if (difficulty === undefined) throw new Error("anchor context misses a difficulty ancestor");
      // A difficulty above q admits no hit; the node compares decoded values, so any encoding of the value is accepted.
      if (difficulty <= 0n || difficulty > Q || decodeCompactBits(header.nBits) !== difficulty) return "difficulty";
      if (!autolykosPowValid(header)) return "pow";
      const entry = Object.freeze({ header, parent, score: parent.score + difficulty, above: true });
      byId.set(bytesToHex(header.id), entry);
      // The node keeps its best chain unless a new one has strictly more score.
      if (entry.score > best.score) best = entry;
      return "added";
    },
    best(): ErgoHeaderChain {
      const headers: ErgoHeaderView[] = [];
      for (let at: Entry | undefined = best; at !== undefined && at !== root; at = at.parent) {
        const { id, parentId, height, version, transactionsRoot } = at.header;
        headers.push(Object.freeze({ id: copyBytes(id), parentId: copyBytes(parentId), height, version: BigInt(version), transactionsRoot: copyBytes(transactionsRoot) }));
      }
      headers.reverse();
      return Object.freeze({ tipId: copyBytes(best.header.id), height: best.header.height, score: best.score, headers: Object.freeze(headers) });
    },
  });
}
