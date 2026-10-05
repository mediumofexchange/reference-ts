// Served-trail transport, pool-v3 §10 at 7ea0ee8: the frame and its one reader.
// lit-v1 §6 reads the same frame under its own contexts and bounds (`trailCodec`).
// Which records are a snapshot's evidence is the evidence store's (`served`).
import { arrayLength, byteLength, compareBytes, copyArray, copyBytes, EncodingError, FrameFeed, type FrameReader } from "../../bytes.js";
import { V3_SEGMENT_CONTEXT as HEADER_CONTEXT, V3_TRAIL_CONTEXT as CONTEXT } from "../../contexts.js";
import { isValue } from "../field.js";
import { segmentHeaderCodec, type SegmentHeader } from "./headers.js";
import { MAX_ROOT_TERMS_BYTES } from "./terms.js";

export const MAX_TRAIL_RECORD_BYTES = 131978;
/** A construction's trail: its context, its segment header's context and its largest record and root terms. */
export interface TrailProfile {
  readonly context: Uint8Array;
  readonly headerContext: Uint8Array;
  readonly maxRecordBytes: number;
  readonly maxTermsBytes: number;
}
/** The profile with the derived sizes: the fixed bytes, the header prefix and the header codec. */
interface Frame extends TrailProfile {
  readonly fixed: number;
  readonly prefix: number;
  readonly header: ReturnType<typeof segmentHeaderCodec>;
}
function frameOf(profile: TrailProfile): Frame {
  const { context, headerContext, maxRecordBytes, maxTermsBytes } = profile;
  const own = { context: copyBytes(context), headerContext: copyBytes(headerContext), maxRecordBytes, maxTermsBytes };
  return Object.freeze({ ...own, fixed: own.context.length + 12, prefix: own.headerContext.length + 108,
    header: segmentHeaderCodec(own.headerContext) });
}
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
export interface TrailReading {
  readonly keepLongTerms?: boolean;
  readonly budget?: TrailLimits | undefined;
  readonly retained?: { readonly events: bigint; readonly bytes: bigint } | undefined;
}
function* readTrail(f: Frame, sink: TrailSink, total: bigint, options: TrailReading): FrameReader<void> {
  if (total < BigInt(f.fixed + f.header.minHeaderBytes + 68)) throw new EncodingError("truncated trail");
  const head = yield f.context.length + 4;
  contextAt(head, 0, f.context);
  const headerLength = u32(head, f.context.length);
  let consumed = BigInt(head.length);
  if (headerLength < f.header.minHeaderBytes || headerLength > f.header.maxHeaderBytes || consumed + BigInt(headerLength) > total) {
    throw new EncodingError("trail header byte bound");
  }
  const headerBytes = yield headerLength;
  consumed += BigInt(headerLength);
  contextAt(headerBytes, 0, f.headerContext);
  const count = u32(headerBytes, f.prefix - 4);
  if (count < 1 || count > 65536 || headerLength !== f.prefix + 136 * count) throw new EncodingError("trail header count or size");
  // A term requires at least its length and signature. Include the event count.
  if (total - consumed < 68n * BigInt(count) + 8n) throw new EncodingError("truncated scoped terms");
  sink.header(headerBytes);
  for (let i = 0; i < count; i++) {
    const length = u32(yield 4);
    consumed += 4n;
    if (consumed + BigInt(length) + 64n > total) throw new EncodingError("trail field byte bound");
    let terms: Uint8Array | undefined;
    if (options.keepLongTerms === true || length <= f.maxTermsBytes) terms = yield length;
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
    if (length > f.maxRecordBytes || consumed + BigInt(length) > total) throw new EncodingError("trail field byte bound");
    const record = yield length;
    consumed += BigInt(length);
    sink.record(i, record);
  }
  if (consumed !== total) throw new EncodingError("trailing trail bytes");
  f.header.decodeSegmentHeader(headerBytes);
}

/** Shape and budgets precede header decoding and all payload hashing.
 * Each caller field is read once into the owned trail returned, the only one
 * the encoder then reads. */
function requireTrail(f: Frame, input: ServedTrail, budgetIn?: TrailLimits): { size: number; header: SegmentHeader; trail: ServedTrail } {
  const budget = budgetIn === undefined ? undefined : limits(budgetIn); object(input);
  const termField = input.terms, recordField = input.records;
  if (!Array.isArray(recordField) || !Array.isArray(termField)) throw new EncodingError("invalid trail arrays");
  // Counts are budgeted before any element is read; elements are then read
  // and judged once each, so a long sparse array stops at its first hole.
  const recordCount = arrayLength(recordField), termCount = arrayLength(termField);
  eventBudget(BigInt(recordCount), budget);
  const header = bytes(input.header);
  let size = BigInt(f.fixed + header.length) + 68n * BigInt(termCount) + 4n * BigInt(recordCount);
  byteBudget(size, budget);
  if (header.length < f.header.minHeaderBytes || header.length > f.header.maxHeaderBytes) throw new EncodingError("trail header byte bound");
  contextAt(header, 0, f.headerContext);
  const count = u32(header, f.prefix - 4);
  if (count < 1 || count > 65536 || header.length !== f.prefix + 136 * count) throw new EncodingError("trail header count or size");
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
    if (record.length > f.maxRecordBytes) throw new EncodingError("trail record too long");
    size += BigInt(record.length); byteBudget(size, budget);
    return record;
  }, recordCount);
  // Only a Proxy or an element's getter can change a length between reads.
  if (terms.length !== count || records.length !== recordCount) throw new EncodingError("trail arrays changed while read");
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new TrailLimitError("trail exceeds implementation allocation range");
  return { size: Number(size), header: f.header.decodeSegmentHeader(header),
    trail: Object.freeze({ header, terms: Object.freeze(terms), records: Object.freeze(records) }) };
}

/** A §10 frame's head: the context, the header, each scoped terms field and the event count. The records
 * follow it, each behind its u32 length. Its fields are the caller's own, already checked. */
function headOf(f: Frame, header: Uint8Array, terms: ServedTrail["terms"], events: bigint): Uint8Array {
  const size = f.context.length + 4 + header.length + terms.reduce((sum, term) => sum + 68 + term.terms.length, 0) + 8;
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  let offset = 0;
  const put = (value: Uint8Array): void => { out.set(value, offset); offset += value.length; };
  const field = (value: Uint8Array): void => { view.setUint32(offset, value.length, false); offset += 4; put(value); };
  put(f.context); field(header);
  for (const term of terms) { field(term.terms); put(term.signature); }
  view.setBigUint64(offset, events, false);
  return out;
}

function encode(f: Frame, input: ServedTrail, budget?: TrailLimits): Uint8Array {
  const { size, trail } = requireTrail(f, input, budget);
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  const head = headOf(f, trail.header, trail.terms, BigInt(trail.records.length));
  out.set(head);
  let offset = head.length;
  for (const record of trail.records) { view.setUint32(offset, record.length, false); out.set(record, offset + 4); offset += 4 + record.length; }
  return out;
}

/** A trail held in memory, read by the one trail reader under the caller's
 * optional budget. Exact inner bytes, including Buffer, are owned. */
function decode(f: Frame, bytesIn: Uint8Array, budgetIn?: TrailLimits): ServedTrail {
  const budget = budgetIn === undefined ? undefined : limits(budgetIn);
  byteBudget(BigInt(byteLength(bytesIn)), budget);
  // Checked again on the copy: shared memory may have grown in between.
  const input = bytes(bytesIn); byteBudget(BigInt(input.length), budget);
  let header: Uint8Array | undefined;
  const terms: { terms: Uint8Array; signature: Uint8Array }[] = [], records: Uint8Array[] = [];
  const feed = new FrameFeed(readTrail(f, {
    header: value => { header = value; },
    terms: (_, value, signature) => { terms.push(Object.freeze({ terms: value!, signature })); },
    count: () => {},
    record: (_, value) => { records.push(value); },
  }, BigInt(input.length), { keepLongTerms: true, budget }));
  feed.feed(input); feed.end();
  return Object.freeze({ header: header!, terms: Object.freeze(terms), records: Object.freeze(records) });
}

/** A construction's §10 trail codec: the frame and its one reader under the profile's contexts and bounds. */
export interface TrailCodec {
  trailReader(sink: TrailSink, total: bigint, options?: TrailReading): FrameReader<void>;
  /** A frame's head: the context, the header, each scoped terms field and the event count; the records follow it,
   * each behind its u32 length. Its fields are the caller's own, already checked. */
  trailHead(header: Uint8Array, terms: ServedTrail["terms"], events: bigint): Uint8Array;
  encodeTrail(input: ServedTrail, budget?: TrailLimits): Uint8Array;
  /** A trail held in memory, read by the one trail reader under the caller's optional budget. */
  decodeTrail(bytes: Uint8Array, budget?: TrailLimits): ServedTrail;
}
export function trailCodec(profile: TrailProfile): TrailCodec {
  const f = frameOf(profile);
  return Object.freeze({
    trailReader: (sink: TrailSink, total: bigint, options: TrailReading = {}) => readTrail(f, sink, total, options),
    trailHead: (header: Uint8Array, terms: ServedTrail["terms"], events: bigint) => headOf(f, header, terms, events),
    encodeTrail: (input: ServedTrail, budget?: TrailLimits) => encode(f, input, budget),
    decodeTrail: (bytes: Uint8Array, budget?: TrailLimits) => decode(f, bytes, budget),
  });
}
const V3 = trailCodec({ context: CONTEXT, headerContext: HEADER_CONTEXT, maxRecordBytes: MAX_TRAIL_RECORD_BYTES,
  maxTermsBytes: MAX_ROOT_TERMS_BYTES });
export const trailReader = V3.trailReader, trailHead = V3.trailHead, encodeTrail = V3.encodeTrail, decodeTrail = V3.decodeTrail;
