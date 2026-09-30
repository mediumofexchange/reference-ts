// Served-trail transport and LOCAL evidence authentication, pool-v3 §10 at
// 7ea0ee8. No terms validation, history replay, complete opening or verdict.
import { sha256 } from "@noble/hashes/sha2.js";
import { arrayLength, byteLength, compareBytes, copyArray, copyBytes, EncodingError, FrameFeed, type FrameReader } from "../../bytes.js";
import { V3_SEGMENT_CONTEXT as HEADER_CONTEXT, V3_TRAIL_CONTEXT as CONTEXT } from "../../contexts.js";
import { isValue } from "../field.js";
import { decodeSegmentHeader, MAX_HEADER_BYTES, type SegmentHeader } from "./headers.js";
import {
  decodeSnapshot, genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, type Snapshot,
} from "./commitments.js";
import { decodeRecord, hashEvidenceFields, statementBytes } from "./records.js";
import type { ExpectedSnapshot } from "./fault-evidence.js";
import { MAX_ROOT_TERMS_BYTES } from "./terms.js";

const FIXED_BYTES = 29, MIN_HEADER_BYTES = 263;
export const MAX_TRAIL_RECORD_BYTES = 131978;
/** Bytes of a skipped field handed over at a time. */
const PIECE = 65536;

/** Explicit local refusal, never malformed evidence or operator fault. */
export class TrailLimitError extends Error {}
/** A caller's budget for one trail held in memory; a streamed trail has only per-object bounds. */
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
/** Where the trail reader delivers a trail's fields, in frame order. */
export interface TrailSink {
  /** The header's exact bytes, before any terms; the frame is refused at its end if the header does not decode. */
  header(bytes: Uint8Array): void;
  /** Scoped terms field `i`; undefined where the reader skipped a field longer than any root terms. */
  terms(i: number, terms: Uint8Array | undefined, signature: Uint8Array): void;
  /** The event count, before any record. */
  count(events: bigint): void;
  /** The record at `position`, from 1. */
  record(position: bigint, bytes: Uint8Array): void;
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
/** The caller's budget, read once. */
function limits(value: TrailLimits): TrailLimits {
  object(value);
  const { maxBytes, maxEvents } = value;
  if (!isValue(maxBytes) || !isValue(maxEvents)) throw new EncodingError("invalid trail budget");
  return { maxBytes, maxEvents };
}
function byteBudget(size: bigint, budget: TrailLimits | undefined): void {
  if (budget !== undefined && size > budget.maxBytes) throw new TrailLimitError("trail exceeds reader byte budget");
}
function eventBudget(count: bigint, budget: TrailLimits | undefined): void {
  if (budget !== undefined && count > budget.maxEvents) throw new TrailLimitError("trail exceeds reader event budget");
}
function contextAt(input: Uint8Array, start: number, context: Uint8Array): void {
  for (let i = 0; i < context.length; i++) {
    if (input[start + i] !== context[i]) throw new EncodingError("wrong trail context");
  }
}
const u32 = (b: Uint8Array, at = 0): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at, false);

/**
 * The §10 frame of exactly `total` bytes as one reader: the header (its byte
 * bound, count and size checked), the scoped terms, the u64 event count and
 * each record, to the exact end, and only then the header's full decoding.
 * Every count must fit the bytes that remain before any element is read, and
 * each record meets §10's record bound, so a reader holds one field at a time.
 * A terms field longer than any root terms can never verify (§12.1); unless
 * `keepLongTerms`, it is skipped rather than held. A sink keeps nothing of a
 * frame that is refused.
 *
 * With `retained`, the frame is §14's assembled trail: the head, then the
 * reader's own first `events` records, `bytes` of frame already read and
 * bounded when they were kept, then the fetched records. Only the head and
 * the fetched records are fed; `total` counts all three.
 */
export function* trailReader(sink: TrailSink, total: bigint,
  options: { readonly keepLongTerms?: boolean; readonly budget?: TrailLimits | undefined;
    readonly retained?: { readonly events: bigint; readonly bytes: bigint } | undefined } = {}): FrameReader<void> {
  if (total < BigInt(FIXED_BYTES + MIN_HEADER_BYTES + 68)) throw new EncodingError("truncated trail");
  const head = yield CONTEXT.length + 4;
  contextAt(head, 0, CONTEXT);
  const headerLength = u32(head, CONTEXT.length);
  let consumed = BigInt(head.length);
  if (headerLength < MIN_HEADER_BYTES || headerLength > MAX_HEADER_BYTES || consumed + BigInt(headerLength) > total) {
    throw new EncodingError("trail header byte bound");
  }
  const headerBytes = yield headerLength;
  consumed += BigInt(headerLength);
  contextAt(headerBytes, 0, HEADER_CONTEXT);
  const count = u32(headerBytes, 123);
  if (count < 1 || count > 65536 || headerLength !== 127 + 136 * count) throw new EncodingError("trail header count or size");
  // A term requires at least its length and signature. Include the event count.
  if (total - consumed < 68n * BigInt(count) + 8n) throw new EncodingError("truncated scoped terms");
  sink.header(headerBytes);
  for (let i = 0; i < count; i++) {
    const length = u32(yield 4);
    consumed += 4n;
    if (consumed + BigInt(length) + 64n > total) throw new EncodingError("trail field byte bound");
    let terms: Uint8Array | undefined;
    if (options.keepLongTerms === true || length <= MAX_ROOT_TERMS_BYTES) terms = yield length;
    else for (let left = length; left > 0;) left -= (yield -Math.min(left, PIECE)).length;
    const signature = yield 64;
    consumed += BigInt(length) + 64n;
    sink.terms(i, terms, signature);
  }
  if (consumed + 8n > total) throw new EncodingError("missing trail event count");
  const countBytes = yield 8;
  const events = new DataView(countBytes.buffer, countBytes.byteOffset, 8).getBigUint64(0, false);
  consumed += 8n;
  eventBudget(events, options.budget);
  if (4n * events > total - consumed) throw new EncodingError("trail count exceeds remaining bytes");
  const retained = options.retained ?? { events: 0n, bytes: 0n };
  // Retained records past the count would be bytes after the frame's last event.
  if (retained.events > events || retained.bytes > total - consumed) throw new EncodingError("trailing trail bytes");
  sink.count(events);
  consumed += retained.bytes;
  for (let i = retained.events + 1n; i <= events; i++) {
    const length = u32(yield 4);
    consumed += 4n;
    if (length > MAX_TRAIL_RECORD_BYTES || consumed + BigInt(length) > total) throw new EncodingError("trail field byte bound");
    const record = yield length;
    consumed += BigInt(length);
    sink.record(i, record);
  }
  if (consumed !== total) throw new EncodingError("trailing trail bytes");
  decodeSegmentHeader(headerBytes);
}

/** Shape and budgets precede header decoding and all payload hashing.
 * Each caller field is read once into the owned trail returned, the only one
 * the encoder and the verifier then read. */
function requireTrail(input: ServedTrail, budgetIn?: TrailLimits): { size: number; header: SegmentHeader; trail: ServedTrail } {
  const budget = budgetIn === undefined ? undefined : limits(budgetIn); object(input);
  const termField = input.terms, recordField = input.records;
  if (!Array.isArray(recordField) || !Array.isArray(termField)) throw new EncodingError("invalid trail arrays");
  // Counts are budgeted before any element is read; elements are then read
  // and judged once each, so a long sparse array stops at its first hole.
  const recordCount = arrayLength(recordField), termCount = arrayLength(termField);
  eventBudget(BigInt(recordCount), budget);
  const header = bytes(input.header);
  let size = BigInt(FIXED_BYTES + header.length) + 68n * BigInt(termCount) + 4n * BigInt(recordCount);
  byteBudget(size, budget);
  if (header.length < MIN_HEADER_BYTES || header.length > MAX_HEADER_BYTES) throw new EncodingError("trail header byte bound");
  contextAt(header, 0, HEADER_CONTEXT);
  const count = u32(header, 123);
  if (count < 1 || count > 65536 || header.length !== 127 + 136 * count) throw new EncodingError("trail header count or size");
  if (termCount !== count) throw new EncodingError("wrong scoped terms count");
  const terms = copyArray(termField, (term: ServedTrail["terms"][number]) => {
    object(term);
    const own = Object.freeze({ terms: bytes(term.terms), signature: bytes(term.signature, 64) });
    if (own.terms.length > 0xffffffff) throw new EncodingError("terms exceed u32 length");
    size += BigInt(own.terms.length); byteBudget(size, budget);
    return own;
  }, count);
  const records = copyArray(recordField, (value: Uint8Array) => {
    const record = bytes(value);
    if (record.length > MAX_TRAIL_RECORD_BYTES) throw new EncodingError("trail record too long");
    size += BigInt(record.length); byteBudget(size, budget);
    return record;
  }, recordCount);
  // Only a Proxy or an element's getter can change a length between reads.
  if (terms.length !== count || records.length !== recordCount) throw new EncodingError("trail arrays changed while read");
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TrailLimitError("trail exceeds implementation allocation range");
  return { size: Number(size), header: decodeSegmentHeader(header),
    trail: Object.freeze({ header, terms: Object.freeze(terms), records: Object.freeze(records) }) };
}

export function encodeTrail(input: ServedTrail, budget?: TrailLimits): Uint8Array {
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

/** A trail held in memory, read by the one trail reader under the caller's
 * optional budget. Exact inner bytes, including Buffer, are owned. */
export function decodeTrail(bytesIn: Uint8Array, budgetIn?: TrailLimits): ServedTrail {
  const budget = budgetIn === undefined ? undefined : limits(budgetIn);
  byteBudget(BigInt(byteLength(bytesIn)), budget);
  // Checked again on the copy: shared memory may have grown in between.
  const input = bytes(bytesIn); byteBudget(BigInt(input.length), budget);
  let header: Uint8Array | undefined;
  const terms: { terms: Uint8Array; signature: Uint8Array }[] = [], records: Uint8Array[] = [];
  const feed = new FrameFeed(trailReader({
    header: value => { header = value; },
    terms: (_, value, signature) => { terms.push(Object.freeze({ terms: value!, signature })); },
    count: () => {},
    record: (_, value) => { records.push(value); },
  }, BigInt(input.length), { keepLongTerms: true, budget }));
  feed.feed(input); feed.end();
  return Object.freeze({ header: header!, terms: Object.freeze(terms), records: Object.freeze(records) });
}

/** True authenticates the header and ordered local event evidence only.
 * It does NOT authenticate terms/signatures, recompute history/state/totals,
 * resolve imports/adoption/record ranges or classify a checkpoint. Strict inner
 * record failure is inconclusive here; use §9 for raw target authentication.
 * The expected snapshot must come from the expected signed directory.
 * Resource and programming failures propagate, never becoming exclusion. */
export function verifyTrailEvidence(expectedIn: ExpectedSnapshot, snapshotIn: Snapshot,
  trailIn: ServedTrail, budget?: TrailLimits): boolean {
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
