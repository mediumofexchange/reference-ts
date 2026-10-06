// Source-neutral evidence transport, pool-v3 §12 at 97ff964: u64 item lengths.
// lit-v1 §6 reads the same frame under its own context (`packageCodec`).
// Structural success is never a complete certificate or a verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { arrayLength, byteLength, compareBytes, copyArray, copyBytes, copyUnshared, EncodingError, FrameFeed, type FrameReader } from "../../bytes.js";
import { DIRECTORY_MAGIC, V3_PACKAGE_CONTEXT as CONTEXT } from "../../contexts.js";
import type { SnapshotDigest } from "../../venue-records.js";
import { isValue } from "../field.js";

const DIRECTORY = Uint8Array.of(...DIRECTORY_MAGIC, 1);
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = (1n << 64n) - 1n;
/** Bytes handed to a streamed payload's receiver at a time. */
const PIECE = 65536;
export class PackageLimitError extends Error {}
/** A caller's budget for one package held in memory: its bytes and items. */
export interface PackageLimits { readonly maxBytes: bigint; readonly maxItems: bigint }
/** 1 config, 2 commitment, 3 directory, 4 snapshot, 6 trail, 7 fault, 10 receipt record; 5, 8, 9 and 11 are
 * unassigned within v3 (pool-v3 §12). */
export interface EvidenceItem { readonly kind: number; readonly payload: Uint8Array }

/** Where a package reader delivers its items, in frame order. */
export interface PackageSink {
  /** A payload of `kind` taken in pieces rather than whole: its receiver, or undefined to take it whole. */
  stream?(kind: number, length: bigint): PayloadSink | undefined;
  /** A whole payload and its SHA256, after its order is checked. */
  item(kind: number, payload: Uint8Array, hash: Uint8Array): void;
}
/** A streamed payload's receiver: its bytes in order, then the payload's SHA256 once its order is checked. */
export interface PayloadSink { data(bytes: Uint8Array): void; end(hash: Uint8Array): void }
export interface PackageReading {
  /** The exact package size when it is known in advance, for the early count and length checks. */
  readonly total?: bigint | undefined;
  /** A whole payload's local per-object budget (a streamed one is bounded by its own frame). */
  readonly maxItemBytes?: bigint | undefined;
  /** A local budget on the item count, checked once the count is read. */
  readonly maxItems?: bigint | undefined;
}

/** The caller's bytes as an owned copy, never over shared memory: nothing
 * below reads the caller again. */
function bytes(value: unknown, width?: number): Uint8Array {
  const own = copyUnshared(value as Uint8Array);
  if (width !== undefined && own.length !== width) throw new EncodingError("invalid package bytes");
  return own;
}
/** The caller's budget, read once. */
function limits(value: PackageLimits): PackageLimits {
  if (value === null || typeof value !== "object") throw new EncodingError("invalid package budget");
  const { maxBytes, maxItems } = value;
  if (!isValue(maxBytes) || !isValue(maxItems)) throw new EncodingError("invalid package budget");
  return { maxBytes, maxItems };
}
function budget(size: bigint, count: bigint, bound: PackageLimits | undefined): void {
  if (bound !== undefined && (size > bound.maxBytes || count > bound.maxItems)) throw new PackageLimitError("package reader budget exceeded");
}
function kind(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 11) {
    throw new EncodingError("unsupported evidence kind");
  }
}
const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, false);
const u64 = (b: Uint8Array, at: number): bigint => new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, false);

/**
 * The §12 frame as one reader: the context, the u32 count, then each item's
 * kind, u64 length and payload, in strictly increasing (kind, SHA256) order,
 * to the exact end. Whole payloads are copied and hashed once; a streamed
 * one is hashed piece by piece as its receiver takes it. With a known total,
 * the count and each length must fit the bytes that remain before any payload
 * is read. No inner payload is decoded.
 */
function* readPackage(context: Uint8Array, sink: PackageSink, reading: PackageReading): FrameReader<void> {
  const { total, maxItemBytes, maxItems } = reading, fixed = context.length + 4;
  if (total !== undefined && total < BigInt(fixed)) throw new EncodingError("truncated package");
  const head = yield fixed;
  if (compareBytes(head.subarray(0, context.length), context) !== 0) throw new EncodingError("wrong package context");
  const count = u32(head, context.length);
  if (maxItems !== undefined && BigInt(count) > maxItems) throw new PackageLimitError("package reader budget exceeded");
  let offset = BigInt(fixed);
  if (total !== undefined && 9n * BigInt(count) > total - offset) throw new EncodingError("impossible evidence count");
  let previous: { kind: number; hash: Uint8Array } | undefined;
  const ordered = (tag: number, hash: Uint8Array): void => {
    if (previous && (tag < previous.kind || (tag === previous.kind && compareBytes(previous.hash, hash) >= 0))) {
      throw new EncodingError("evidence items must be strictly ordered");
    }
    previous = { kind: tag, hash };
  };
  for (let i = 0; i < count; i++) {
    const itemHead = yield 9;
    const tag = itemHead[0]; kind(tag);
    const length = u64(itemHead, 1); offset += 9n;
    if (total !== undefined && length > total - offset) throw new EncodingError("truncated evidence payload");
    const receiver = sink.stream?.(tag, length);
    if (receiver === undefined) {
      if (maxItemBytes !== undefined && length > maxItemBytes) throw new PackageLimitError("package item exceeds the reader's budget");
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new PackageLimitError("package item exceeds the implementation's range");
      const payload = yield Number(length), hash = sha256(payload);
      ordered(tag, hash);
      sink.item(tag, payload, hash);
    } else {
      const hasher = sha256.create();
      for (let left = length; left > 0n;) {
        const piece = yield -Number(left < BigInt(PIECE) ? left : BigInt(PIECE));
        hasher.update(piece); receiver.data(piece); left -= BigInt(piece.length);
      }
      const hash = hasher.digest();
      ordered(tag, hash);
      receiver.end(hash);
    }
    offset += length;
  }
}

/** Accept canonical order, never repair or deduplicate caller evidence. */
function encodePackage(context: Uint8Array, input: readonly EvidenceItem[], boundIn?: PackageLimits): Uint8Array {
  const bound = boundIn === undefined ? undefined : limits(boundIn);
  if (!Array.isArray(input)) throw new EncodingError("invalid evidence count");
  // The count is budgeted before any item is read; each item is then read and
  // judged once, so a long sparse array stops at its first hole.
  const count = arrayLength(input);
  if (count > MAX_U32) throw new EncodingError("invalid evidence count");
  const fixed = context.length + 4;
  let size = BigInt(fixed) + 9n * BigInt(count);
  budget(size, BigInt(count), bound);
  const items = copyArray(input, (reference: EvidenceItem): EvidenceItem => {
    if (reference === null || typeof reference !== "object") throw new EncodingError("invalid evidence item");
    const tag: unknown = reference.kind; kind(tag);
    const item = { kind: tag, payload: bytes(reference.payload) };
    if (BigInt(item.payload.length) > MAX_U64) throw new EncodingError("evidence payload too long");
    size += BigInt(item.payload.length); budget(size, BigInt(count), bound);
    return item;
  }, count);
  if (items.length !== count) throw new EncodingError("invalid evidence count");
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PackageLimitError("package allocation range exceeded");
  let previous: { kind: number; hash: Uint8Array } | undefined;
  for (const item of items) {
    const hash = sha256(item.payload);
    if (previous && (item.kind < previous.kind || (item.kind === previous.kind && compareBytes(previous.hash, hash) >= 0))) {
      throw new EncodingError("evidence items must be strictly ordered");
    }
    previous = { kind: item.kind, hash };
  }
  const out = new Uint8Array(Number(size)), view = new DataView(out.buffer);
  out.set(context); view.setUint32(context.length, items.length, false);
  let offset = fixed;
  for (const item of items) {
    out[offset] = item.kind; view.setBigUint64(offset + 1, BigInt(item.payload.length), false);
    out.set(item.payload, offset + 9); offset += 9 + item.payload.length;
  }
  return out;
}

/** A package held in memory, read by the one package reader under the caller's optional budget. */
function decodePackage(context: Uint8Array, bytesIn: Uint8Array, boundIn?: PackageLimits): readonly EvidenceItem[] {
  const bound = boundIn === undefined ? undefined : limits(boundIn);
  budget(BigInt(byteLength(bytesIn)), 0n, bound);
  const input = bytes(bytesIn);
  budget(BigInt(input.length), 0n, bound);
  const items: EvidenceItem[] = [];
  const feed = new FrameFeed(readPackage(context, { item: (tag, payload) => { items.push(Object.freeze({ kind: tag, payload })); } },
    { total: BigInt(input.length), ...(bound === undefined ? {} : { maxItems: bound.maxItems }) }));
  feed.feed(input); feed.end();
  return Object.freeze(items);
}

/** A construction's §12 package codec under its context; the frame, kinds, order and budgets are pool-v3's. */
export interface PackageCodec {
  packageReader(sink: PackageSink, reading?: PackageReading): FrameReader<void>;
  encodeEvidencePackage(input: readonly EvidenceItem[], bound?: PackageLimits): Uint8Array;
  decodeEvidencePackage(bytes: Uint8Array, bound?: PackageLimits): readonly EvidenceItem[];
}
export function packageCodec(contextIn: Uint8Array): PackageCodec {
  const context = copyBytes(contextIn);
  return Object.freeze({
    packageReader: (sink: PackageSink, reading: PackageReading = {}) => readPackage(context, sink, reading),
    encodeEvidencePackage: (input: readonly EvidenceItem[], bound?: PackageLimits) => encodePackage(context, input, bound),
    decodeEvidencePackage: (bytes: Uint8Array, bound?: PackageLimits) => decodePackage(context, bytes, bound),
  });
}
export const V3_PACKAGES = packageCodec(CONTEXT);
const V3 = V3_PACKAGES;
export const packageReader = V3.packageReader, encodeEvidencePackage = V3.encodeEvidencePackage,
  decodeEvidencePackage = V3.decodeEvidencePackage;

/** Existing MOED v1 root preimage. No new directory identity or root. */
export function encodeEvidenceDirectory(input: readonly SnapshotDigest[], boundIn?: PackageLimits): Uint8Array {
  const bound = boundIn === undefined ? undefined : limits(boundIn);
  if (!Array.isArray(input)) throw new EncodingError("invalid directory count");
  // The count is budgeted before any entry is read; each entry is then read
  // and judged once, so a long sparse array stops at its first hole.
  const count = arrayLength(input);
  if (count > MAX_U32) throw new EncodingError("invalid directory count");
  const size = 9n + 64n * BigInt(count);
  budget(size, BigInt(count), bound);
  let previous: Uint8Array | undefined;
  const entries = copyArray(input, (reference: SnapshotDigest): SnapshotDigest => {
    if (reference === null || typeof reference !== "object") throw new EncodingError("invalid directory entry");
    const entry = { name: bytes(reference.name, 32), digest: bytes(reference.digest, 32) };
    if (previous && compareBytes(previous, entry.name) >= 0) throw new EncodingError("unordered directory");
    previous = entry.name;
    return entry;
  }, count);
  if (entries.length !== count) throw new EncodingError("invalid directory count");
  // u32 entry count bounds the fixed-size multiplication below 2^48.
  const out = new Uint8Array(Number(size)), view = new DataView(out.buffer);
  out.set(DIRECTORY); view.setUint32(5, entries.length, false);
  entries.forEach((entry, i) => { out.set(entry.name, 9 + 64 * i); out.set(entry.digest, 41 + 64 * i); });
  return out;
}

export function decodeEvidenceDirectory(bytesIn: Uint8Array, boundIn?: PackageLimits): readonly SnapshotDigest[] {
  const bound = boundIn === undefined ? undefined : limits(boundIn);
  budget(BigInt(byteLength(bytesIn)), 0n, bound);
  const input = bytes(bytesIn);
  if (input.length < 9) throw new EncodingError("truncated directory");
  if (compareBytes(input.subarray(0, DIRECTORY.length), DIRECTORY) !== 0) throw new EncodingError("wrong package context");
  const count = u32(input, 5);
  budget(BigInt(input.length), BigInt(count), bound);
  if (9n + 64n * BigInt(count) !== BigInt(input.length)) throw new EncodingError("wrong directory length");
  for (let i = 1; i < count; i++) {
    const offset = 9 + 64 * i;
    if (compareBytes(input.subarray(offset - 64, offset - 32), input.subarray(offset, offset + 32)) >= 0) {
      throw new EncodingError("unordered directory");
    }
  }
  return Object.freeze(Array.from({ length: count }, (_, i) => Object.freeze({
    name: copyBytes(input.subarray(9 + 64 * i, 41 + 64 * i)),
    digest: copyBytes(input.subarray(41 + 64 * i, 73 + 64 * i)),
  })));
}
