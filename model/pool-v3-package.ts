// Source-neutral evidence transport, pool-v3 §12 at 10dcf67.
// Structural success is never a complete certificate or a verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, copyBytes, EncodingError } from "../src/bytes.js";
import type { SnapshotDigest } from "../src/commitment.js";
import { isValue } from "../src/pool/field.js";

const CONTEXT = new TextEncoder().encode("moe/pool/v3/package");
const DIRECTORY = Uint8Array.of(0x4d, 0x4f, 0x45, 0x44, 1);
const MAX_U32 = 0xffff_ffff;
export class PackageLimitError extends Error {}
export interface PackageLimits { readonly maxBytes: bigint; readonly maxItems: bigint }
/** 1 config, 2 commitment, 3 directory, 4 snapshot, 5 header, 6 trail,
 * 7 fault, 8 signed terms, 9 publication, 10 receipt record, 11 venue evidence. */
export interface EvidenceItem { readonly kind: number; readonly payload: Uint8Array }

function bytes(value: unknown, width?: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer ||
      (width !== undefined && value.length !== width)) throw new EncodingError("invalid or shared package bytes");
}
function limits(value: PackageLimits): void {
  if (value === null || typeof value !== "object" || !isValue(value.maxBytes) || !isValue(value.maxItems)) {
    throw new EncodingError("invalid package budget");
  }
}
function budget(size: bigint, count: bigint, bound: PackageLimits): void {
  if (size > bound.maxBytes || count > bound.maxItems) throw new PackageLimitError("package reader budget exceeded");
}
function kind(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 11) {
    throw new EncodingError("unsupported evidence kind");
  }
}
function context(input: Uint8Array, expected: Uint8Array): void {
  if (compareBytes(input.subarray(0, expected.length), expected) !== 0) throw new EncodingError("wrong package context");
}
/** Called only after every outer shape and budget check. No inner decoding. */
function ordered(items: readonly EvidenceItem[]): void {
  let previous: { kind: number; hash: Uint8Array } | undefined;
  for (const item of items) {
    const hash = sha256(item.payload);
    if (previous && (item.kind < previous.kind ||
        (item.kind === previous.kind && compareBytes(previous.hash, hash) >= 0))) {
      throw new EncodingError("evidence items must be strictly ordered");
    }
    previous = { kind: item.kind, hash };
  }
}

/** Accept canonical order, never repair or deduplicate caller evidence. */
export function encodeEvidencePackage(items: readonly EvidenceItem[], bound: PackageLimits): Uint8Array {
  limits(bound);
  if (!Array.isArray(items) || items.length > MAX_U32) throw new EncodingError("invalid evidence count");
  let size = 23n + 5n * BigInt(items.length);
  budget(size, BigInt(items.length), bound);
  for (const item of items) {
    if (item === null || typeof item !== "object") throw new EncodingError("invalid evidence item");
    kind(item.kind); bytes(item.payload);
    if (item.payload.length > MAX_U32) throw new EncodingError("evidence payload too long");
    size += BigInt(item.payload.length); budget(size, BigInt(items.length), bound);
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new PackageLimitError("package allocation range exceeded");
  ordered(items);
  const out = new Uint8Array(Number(size)), view = new DataView(out.buffer);
  out.set(CONTEXT); view.setUint32(19, items.length, false);
  let offset = 23;
  for (const item of items) {
    out[offset] = item.kind; view.setUint32(offset + 1, item.payload.length, false);
    out.set(item.payload, offset + 5); offset += 5 + item.payload.length;
  }
  return out;
}

export function decodeEvidencePackage(input: Uint8Array, bound: PackageLimits): readonly EvidenceItem[] {
  limits(bound); bytes(input); budget(BigInt(input.length), 0n, bound);
  if (input.length < 23) throw new EncodingError("truncated package");
  context(input, CONTEXT);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = view.getUint32(19, false);
  budget(BigInt(input.length), BigInt(count), bound);
  if (5n * BigInt(count) > BigInt(input.length - 23)) throw new EncodingError("impossible evidence count");
  const items: EvidenceItem[] = [];
  let offset = 23;
  for (let i = 0; i < count; i++) {
    if (offset + 5 > input.length) throw new EncodingError("truncated evidence item");
    const tag = input[offset]; kind(tag);
    const length = view.getUint32(offset + 1, false); offset += 5;
    if (length > input.length - offset) throw new EncodingError("truncated evidence payload");
    items.push({ kind: tag, payload: input.subarray(offset, offset + length) }); offset += length;
  }
  if (offset !== input.length) throw new EncodingError("trailing package bytes");
  ordered(items);
  return Object.freeze(items.map(item => Object.freeze({ kind: item.kind, payload: copyBytes(item.payload) })));
}

/** Existing MOED v1 root preimage. No new directory identity or root. */
export function encodeEvidenceDirectory(entries: readonly SnapshotDigest[], bound: PackageLimits): Uint8Array {
  limits(bound);
  if (!Array.isArray(entries) || entries.length > MAX_U32) throw new EncodingError("invalid directory count");
  const size = 9n + 64n * BigInt(entries.length);
  budget(size, BigInt(entries.length), bound);
  let previous: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") throw new EncodingError("invalid directory entry");
    bytes(entry.name, 32); bytes(entry.digest, 32);
    if (previous && compareBytes(previous, entry.name) >= 0) throw new EncodingError("unordered directory");
    previous = entry.name;
  }
  // u32 entry count bounds the fixed-size multiplication below 2^48.
  const out = new Uint8Array(Number(size)), view = new DataView(out.buffer);
  out.set(DIRECTORY); view.setUint32(5, entries.length, false);
  entries.forEach((entry, i) => { out.set(entry.name, 9 + 64 * i); out.set(entry.digest, 41 + 64 * i); });
  return out;
}

export function decodeEvidenceDirectory(input: Uint8Array, bound: PackageLimits): readonly SnapshotDigest[] {
  limits(bound); bytes(input); budget(BigInt(input.length), 0n, bound);
  if (input.length < 9) throw new EncodingError("truncated directory");
  context(input, DIRECTORY);
  const count = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(5, false);
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
