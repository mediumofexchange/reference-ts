// Served-trail transport and LOCAL evidence authentication, pool-v3 §10 at
// 7ea0ee8. No terms validation, history replay, complete opening or verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { compareBytes, copyArray, copyBytes, EncodingError } from "../../bytes.js";
import { V3_SEGMENT_CONTEXT as HEADER_CONTEXT, V3_TRAIL_CONTEXT as CONTEXT } from "../../contexts.js";
import { isValue } from "../field.js";
import { decodeSegmentHeader, MAX_HEADER_BYTES, type SegmentHeader } from "./headers.js";
import {
  decodeSnapshot, genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, type Snapshot,
} from "./commitments.js";
import { decodeRecord, hashEvidenceFields, statementBytes } from "./records.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";

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
/** The caller's bytes as an owned copy: nothing below reads the caller again. */
function bytes(value: unknown, width?: number): Uint8Array {
  const own = copyBytes(value as Uint8Array);
  if (width !== undefined && own.length !== width) throw new EncodingError("invalid trail bytes");
  return own;
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

/** Shape and budgets precede full header decoding and all payload hashing.
 * Each caller field is read once into the owned trail returned, the only one
 * the encoder and the verifier then read. */
function requireTrail(input: ServedTrail, budget: TrailLimits): { size: number; header: SegmentHeader; trail: ServedTrail } {
  limits(budget); object(input);
  const termField = input.terms, recordField = input.records;
  if (!Array.isArray(recordField) || !Array.isArray(termField)) throw new EncodingError("invalid trail arrays");
  // Element references only; each element is read and copied once below.
  const records = copyArray(recordField, value => value), terms = copyArray(termField, value => value);
  eventBudget(BigInt(records.length), budget);
  const header = bytes(input.header);
  let size = BigInt(FIXED_BYTES + header.length) + 68n * BigInt(terms.length) + 4n * BigInt(records.length);
  byteBudget(size, budget);
  const count = headerCount(header, 0, header.length);
  if (terms.length !== count) throw new EncodingError("wrong scoped terms count");
  const ownTerms: { terms: Uint8Array; signature: Uint8Array }[] = [], ownRecords: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const term = terms[i]!; object(term);
    const own = Object.freeze({ terms: bytes(term.terms), signature: bytes(term.signature, 64) });
    if (own.terms.length > 0xffffffff) throw new EncodingError("terms exceed u32 length");
    size += BigInt(own.terms.length); byteBudget(size, budget); ownTerms.push(own);
  }
  for (let i = 0; i < records.length; i++) {
    const record = bytes(records[i]);
    if (record.length > MAX_TRAIL_RECORD_BYTES) throw new EncodingError("trail record too long");
    size += BigInt(record.length); byteBudget(size, budget); ownRecords.push(record);
  }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TrailLimitError("trail exceeds implementation allocation range");
  return { size: Number(size), header: decodeSegmentHeader(header),
    trail: Object.freeze({ header, terms: Object.freeze(ownTerms), records: Object.freeze(ownRecords) }) };
}

export function encodeTrail(input: ServedTrail, budget: TrailLimits): Uint8Array {
  const { size, trail } = requireTrail(input, budget);
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
export function decodeTrail(bytesIn: Uint8Array, budget: TrailLimits): ServedTrail {
  limits(budget);
  const input = bytes(bytesIn); byteBudget(BigInt(input.length), budget);
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
export function verifyTrailEvidence(expectedIn: ExpectedSnapshot, snapshotIn: Snapshot,
  trailIn: ServedTrail, budget: TrailLimits): boolean {
  try {
    // Every argument is read once into owned values; the answer is about them.
    object(expectedIn);
    const expected = { backing: bytes(expectedIn.backing, 32), segment: bytes(expectedIn.segment, 32), digest: bytes(expectedIn.digest, 32) };
    const { header, trail } = requireTrail(trailIn, budget);
    const snapshot = decodeSnapshot(snapshotBytes(snapshotIn)), digest = snapshotDigest(snapshot);
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
