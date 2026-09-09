// Served-trail transport and LOCAL evidence authentication, pool-v3 §10 at
// 7ea0ee8. No terms validation, history replay, complete opening or verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, copyBytes, EncodingError } from "../src/bytes.js";
import { isValue } from "../src/pool/field.js";
import { decodeSegmentHeader, MAX_HEADER_BYTES, type SegmentHeader } from "./pool-v3-headers.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "./pool-v3-commitments.js";
import { decodeRecord, hashEvidenceFields, statementBytes } from "./pool-v3-records.js";
import type { ExpectedSnapshot } from "./pool-v3-fault-evidence.js";

const CONTEXT = new TextEncoder().encode("moe/pool/v3/trail");
const HEADER_CONTEXT = new TextEncoder().encode("moe/pool/v3/segment");
const FIXED_BYTES = 29, MIN_HEADER_BYTES = 263;
export const MAX_TRAIL_RECORD_BYTES = 131978;

/** Explicit local refusal, never malformed evidence or operator fault. */
export class TrailLimitError extends Error {}
export interface TrailLimits {
  readonly maxBytes: bigint;
  readonly maxEvents: bigint;
}
export interface ServedTrail {
  readonly header: Uint8Array;
  /** In header scope order; inner terms and signatures are NOT authenticated here. */
  readonly terms: readonly { readonly terms: Uint8Array; readonly signature: Uint8Array }[];
  /** Exact opaque §5 record bytes, including malformed inner fields. */
  readonly records: readonly Uint8Array[];
}

function object(value: unknown): void {
  if (value === null || typeof value !== "object") throw new EncodingError("not an object");
}
function bytes(value: unknown, width?: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || (width !== undefined && value.length !== width)) {
    throw new EncodingError("invalid trail bytes");
  }
}
function limits(value: TrailLimits): void {
  object(value);
  if (!isValue(value.maxBytes) || !isValue(value.maxEvents)) throw new EncodingError("invalid trail budget");
}
function byteBudget(size: bigint, budget: TrailLimits): void {
  if (size > budget.maxBytes) throw new TrailLimitError("trail exceeds reader byte budget");
}
function eventBudget(count: bigint, budget: TrailLimits): void {
  if (count > budget.maxEvents) throw new TrailLimitError("trail exceeds reader event budget");
}
function contextAt(input: Uint8Array, start: number, context: Uint8Array): void {
  for (let i = 0; i < context.length; i++) {
    if (input[start + i] !== context[i]) throw new EncodingError("wrong trail context");
  }
}

/** Only the header's fixed prefix is read; no payload is copied or decoded. */
function headerCount(input: Uint8Array, offset: number, length: number): number {
  if (length < MIN_HEADER_BYTES || length > MAX_HEADER_BYTES || offset + length > input.length) {
    throw new EncodingError("trail header byte bound");
  }
  contextAt(input, offset, HEADER_CONTEXT);
  const count = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(offset + 123, false);
  if (count < 1 || count > 65536 || length !== 127 + 136 * count) throw new EncodingError("trail header count or size");
  return count;
}

/** Shape and budgets precede full header decoding and all payload hashing. */
function requireTrail(trail: ServedTrail, budget: TrailLimits): { size: number; header: SegmentHeader } {
  limits(budget); object(trail);
  if (!Array.isArray(trail.records) || !Array.isArray(trail.terms)) throw new EncodingError("invalid trail arrays");
  eventBudget(BigInt(trail.records.length), budget);
  bytes(trail.header);
  let size = BigInt(FIXED_BYTES + trail.header.length) + 68n * BigInt(trail.terms.length) + 4n * BigInt(trail.records.length);
  byteBudget(size, budget);
  const count = headerCount(trail.header, 0, trail.header.length);
  if (trail.terms.length !== count) throw new EncodingError("wrong scoped terms count");
  for (let i = 0; i < count; i++) {
    const term = trail.terms[i]!; object(term); bytes(term.terms); bytes(term.signature, 64);
    if (term.terms.length > 0xffffffff) throw new EncodingError("terms exceed u32 length");
    size += BigInt(term.terms.length); byteBudget(size, budget);
  }
  for (let i = 0; i < trail.records.length; i++) {
    const record = trail.records[i]!; bytes(record);
    if (record.length > MAX_TRAIL_RECORD_BYTES) throw new EncodingError("trail record too long");
    size += BigInt(record.length); byteBudget(size, budget);
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TrailLimitError("trail exceeds implementation allocation range");
  return { size: Number(size), header: decodeSegmentHeader(trail.header) };
}

export function encodeTrail(trail: ServedTrail, budget: TrailLimits): Uint8Array {
  const { size } = requireTrail(trail, budget);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  const put = (value: Uint8Array): void => { out.set(value, offset); offset += value.length; };
  const field = (value: Uint8Array): void => { view.setUint32(offset, value.length, false); offset += 4; put(value); };
  put(CONTEXT); field(trail.header);
  for (const term of trail.terms) { field(term.terms); put(term.signature); }
  view.setBigUint64(offset, BigInt(trail.records.length), false); offset += 8;
  for (const record of trail.records) field(record);
  return out;
}

/** Two passes: bound and scan the entire transport before creating payload
 * arrays or decoding the header. Exact inner bytes, including Buffer, are owned. */
export function decodeTrail(input: Uint8Array, budget: TrailLimits): ServedTrail {
  limits(budget); bytes(input); byteBudget(BigInt(input.length), budget);
  if (input.length < FIXED_BYTES + MIN_HEADER_BYTES + 68) throw new EncodingError("truncated trail");
  contextAt(input, 0, CONTEXT);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const headerLength = view.getUint32(CONTEXT.length, false), headerStart = CONTEXT.length + 4;
  const count = headerCount(input, headerStart, headerLength);
  let offset = headerStart + headerLength;
  const skipField = (maximum: number, tail = 0): void => {
    if (offset + 4 > input.length) throw new EncodingError("truncated trail field length");
    const length = view.getUint32(offset, false); offset += 4;
    if (length > maximum || offset + length + tail > input.length) throw new EncodingError("trail field byte bound");
    offset += length + tail;
  };
  // A term requires at least its length and signature. Include the event count.
  if (BigInt(input.length - offset) < 68n * BigInt(count) + 8n) throw new EncodingError("truncated scoped terms");
  for (let i = 0; i < count; i++) skipField(0xffffffff, 64);
  if (offset + 8 > input.length) throw new EncodingError("missing trail event count");
  const eventCount = view.getBigUint64(offset, false); offset += 8;
  eventBudget(eventCount, budget);
  if (4n * eventCount > BigInt(input.length - offset)) throw new EncodingError("trail count exceeds remaining bytes");
  // Bounded by the allocated input's length before conversion/iteration.
  const events = Number(eventCount);
  for (let i = 0; i < events; i++) skipField(MAX_TRAIL_RECORD_BYTES);
  if (offset !== input.length) throw new EncodingError("trailing trail bytes");

  decodeSegmentHeader(input.subarray(headerStart, headerStart + headerLength));
  const take = (length: number): Uint8Array => {
    const result = copyBytes(input.subarray(offset, offset + length)); offset += length; return result;
  };
  const field = (): Uint8Array => { const length = view.getUint32(offset, false); offset += 4; return take(length); };
  offset = headerStart;
  const header = take(headerLength), terms: { terms: Uint8Array; signature: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) terms.push(Object.freeze({ terms: field(), signature: take(64) }));
  offset += 8;
  const records: Uint8Array[] = [];
  for (let i = 0; i < events; i++) records.push(field());
  return Object.freeze({ header, terms: Object.freeze(terms), records: Object.freeze(records) });
}

/** True authenticates the header and ordered local event evidence only.
 * It does NOT authenticate terms/signatures, recompute history/state/totals,
 * resolve imports/adoption/record ranges or classify a checkpoint. Strict inner
 * record failure is inconclusive here; use §9 for raw target authentication.
 * The expected snapshot must come from the expected signed directory.
 * Resource and programming failures propagate, never becoming exclusion. */
export function verifyTrailEvidence(expected: ExpectedSnapshot, snapshot: Snapshot,
  trail: ServedTrail, budget: TrailLimits): boolean {
  try {
    object(expected); bytes(expected.backing, 32); bytes(expected.segment, 32); bytes(expected.digest, 32);
    const { header } = requireTrail(trail, budget);
    const digest = snapshotDigest(snapshot);
    if (compareBytes(snapshot.backing, expected.backing) !== 0 || compareBytes(snapshot.segment, expected.segment) !== 0 ||
        compareBytes(digest, expected.digest) !== 0 || compareBytes(sha256(trail.header), expected.segment) !== 0 ||
        !header.entries.some(entry => compareBytes(entry.backing, expected.backing) === 0)) return false;
    let evidence = genesisEvidenceHash(expected.segment);
    for (let i = 0; i < trail.records.length; i++) {
      const record = decodeRecord(trail.records[i]!);
      const triple = hashEvidenceFields(sha256(statementBytes(record)), record.proof, record.authorization);
      evidence = nextEvidenceHash(evidence, triple, BigInt(i) + 1n);
    }
    return compareBytes(evidence, snapshot.evidenceHash) === 0;
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
