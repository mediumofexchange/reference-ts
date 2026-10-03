// Record-range answers, pool-v3 §13. Source-neutral transport between a
// reader's independently selected venue-evidence verifier and its replay.
// A decoded answer is that verifier's output, never supplied evidence, and it
// establishes no directory, trail, classification, force or verdict.
import { bytesToHex } from "@noble/hashes/utils.js";
import { arrayLength, byteLength, compareBytes, copyArray, copyBytes, copyUnshared, EncodingError } from "./bytes.js";
import { V3_RANGE_CONTEXT as CONTEXT } from "./contexts.js";
import {
  decodeCommitment, decodeReplacement, decodeRevocation, isSignedRevocation, replacementHash, verifyCommitment, verifyReplacement,
  type Commitment, type Replacement,
} from "./venue-records.js";

const FIXED_BYTES = 102, ENTRY_BYTES = 20, MAX_U32 = 0xffff_ffff, MAX_U64 = (1n << 64n) - 1n;
/** An answer's bytes before its entries: context and request, then the count. */
export const RANGE_FRAME_BYTES = FIXED_BYTES;
export type RecordKind = 1 | 2 | 3 | 4;
export const COMMITMENT_RANGE = 1 as const, REPLACEMENT_RANGE = 2 as const;
export const REVOCATION_RANGE = 3 as const, PUBLICATION_RANGE = 4 as const;
/** Exact record lengths for kinds 1–3; kind 4 is §6's 92 framing bytes over
 * its largest body, a 131822-byte kind-6 record, and is a maximum. */
export const MAX_RANGE_RECORD_BYTES: Readonly<Record<RecordKind, number>> = Object.freeze({ 1: 136, 2: 233, 3: 96, 4: 131914 });
const recordLengthFits = (kind: RecordKind, length: number): boolean =>
  kind === PUBLICATION_RANGE ? length <= MAX_RANGE_RECORD_BYTES[4] : length === MAX_RANGE_RECORD_BYTES[kind];

/** Explicit local refusal, never malformed evidence or operator fault. */
export class RangeLimitError extends Error {}
export interface RangeLimits { readonly maxBytes: bigint; readonly maxEntries: bigint }
export interface RangeRequest {
  readonly venue: Uint8Array;
  readonly kind: RecordKind;
  readonly subject: Uint8Array;
  readonly fromIndex: bigint;
  readonly toIndex: bigint;
}
/** For kind 4 the ordinal is the venue's order within the index, comparable
 * across every object the venue witnessed there; zero for kinds 1–3 (§13.1). */
export interface RangeEntry { readonly index: bigint; readonly ordinal: bigint; readonly record: Uint8Array }
export interface RangeAnswer { readonly request: RangeRequest; readonly entries: readonly RangeEntry[] }

const u64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= MAX_U64;
const isKind = (v: unknown): v is RecordKind => v === 1 || v === 2 || v === 3 || v === 4;
/** The caller's bytes as an owned copy, never over shared memory: nothing
 * below reads the caller again. */
function bytes(value: unknown, width?: number): Uint8Array {
  const own = copyUnshared(value as Uint8Array);
  if (width !== undefined && own.length !== width) throw new EncodingError("invalid range bytes");
  return own;
}
/** The caller's budget, read once. */
/** An owned copy of a range budget; `EncodingError` for one that is not two 64-bit counts. */
export function copyLimits(value: RangeLimits): RangeLimits {
  if (value === null || typeof value !== "object") throw new EncodingError("invalid range budget");
  const { maxBytes, maxEntries } = value;
  if (!u64(maxBytes) || !u64(maxEntries)) throw new EncodingError("invalid range budget");
  return { maxBytes, maxEntries };
}
function budget(size: bigint, count: bigint, bound: RangeLimits): void {
  if (size > bound.maxBytes || count > bound.maxEntries) throw new RangeLimitError("range reader budget exceeded");
}
interface Position { readonly index: bigint; readonly ordinal: bigint; readonly record: Uint8Array }
/** Kind-4 entries strictly increase by (index, ordinal); kinds 1–3 carry a
 * zero ordinal, since no rule reads their order within an index, and stand
 * at one index in ascending record-byte order so the answer is canonical (§13.1). */
function inOrder(kind: RecordKind, entry: Position, previous: Position | undefined): boolean {
  if (previous === undefined || entry.index > previous.index) return kind === PUBLICATION_RANGE || entry.ordinal === 0n;
  if (entry.index < previous.index) return false;
  if (kind === PUBLICATION_RANGE) return entry.ordinal > previous.ordinal;
  return entry.ordinal === 0n && compareBytes(previous.record, entry.record) <= 0;
}

export function isWellFormedRequest(r: unknown): r is RangeRequest {
  if (r === null || typeof r !== "object") return false;
  const { venue, kind, subject, fromIndex, toIndex } = r as Record<string, unknown>;
  return venue instanceof Uint8Array && venue.length === 32 && !(venue.buffer instanceof SharedArrayBuffer) &&
    subject instanceof Uint8Array && subject.length === 32 && !(subject.buffer instanceof SharedArrayBuffer) &&
    isKind(kind) && u64(fromIndex) && u64(toIndex) && fromIndex <= toIndex;
}
export function sameRequest(a: RangeRequest, b: RangeRequest): boolean {
  return a.kind === b.kind && a.fromIndex === b.fromIndex && a.toIndex === b.toIndex &&
    compareBytes(a.venue, b.venue) === 0 && compareBytes(a.subject, b.subject) === 0;
}
/** Each field is read once and its bytes copied, then the copy is judged, so
 * a caller's accessor or reported length cannot pass one value to the check
 * and another to the copy. */
export function copyRequest(r: RangeRequest): RangeRequest {
  if (r === null || typeof r !== "object") throw new EncodingError("malformed range request");
  const { venue, kind, subject, fromIndex, toIndex } = r;
  const own = { venue: copyUnshared(venue), kind, subject: copyUnshared(subject), fromIndex, toIndex };
  if (!isWellFormedRequest(own)) throw new EncodingError("malformed range request");
  return Object.freeze(own);
}

/** §13.1's structure over caller objects, read once: every entry's fields
 * are captured here so a later read cannot present other values. Budgets are
 * the caller's; an in-memory answer that breaks the frame's order, range or
 * length rules is refused before any rule reads it. */
function validEntries(answer: RangeAnswer, bound?: RangeLimits): { request: RangeRequest; entries: readonly Position[]; size: bigint } {
  if (answer === null || typeof answer !== "object") throw new EncodingError("invalid range answer");
  const request = copyRequest(answer.request), entryField = answer.entries;
  if (!Array.isArray(entryField)) throw new EncodingError("invalid range answer");
  // A budget applies to the count before any entry is read; each entry is
  // then read and judged once inside the copy, so a long sparse array stops
  // at its first hole.
  const count = arrayLength(entryField);
  if (count > MAX_U32) throw new EncodingError("range entry count exceeds u32");
  let size = BigInt(FIXED_BYTES) + BigInt(ENTRY_BYTES) * BigInt(count);
  if (bound !== undefined) budget(size, BigInt(count), bound);
  let previous: Position | undefined;
  const entries = copyArray(entryField, (entry: RangeEntry): Position => {
    if (entry === null || typeof entry !== "object") throw new EncodingError("invalid range entry");
    const { index, ordinal, record: recordField } = entry;
    if (!u64(index) || !u64(ordinal)) throw new EncodingError("invalid range entry");
    const record = bytes(recordField);
    const position = { index, ordinal, record };
    if (index < request.fromIndex || index > request.toIndex || !inOrder(request.kind, position, previous)) {
      throw new EncodingError("range entry out of order, ordinal or range");
    }
    if (!recordLengthFits(request.kind, record.length)) throw new EncodingError("range record length does not fit its kind");
    size += BigInt(record.length);
    if (bound !== undefined) budget(size, BigInt(count), bound);
    previous = position;
    return position;
  }, count);
  // Only a Proxy or an entry's getter can change the length between reads.
  if (entries.length !== count) throw new EncodingError("range entries changed while read");
  return { request, entries, size };
}

/** Shape, order and budgets before any output allocation. */
function requireAnswer(answer: RangeAnswer, bound: RangeLimits): { size: bigint; request: RangeRequest; entries: readonly Position[] } {
  const { request, entries, size } = validEntries(answer, copyLimits(bound));
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeLimitError("range allocation range exceeded");
  return { size, request, entries };
}

export function encodeRangeAnswer(answer: RangeAnswer, bound: RangeLimits): Uint8Array {
  // The request and every entry were read once into owned values.
  const { size, request, entries } = requireAnswer(answer, bound);
  const out = new Uint8Array(Number(size)), view = new DataView(out.buffer);
  out.set(CONTEXT); out.set(request.venue, 17); out[49] = request.kind; out.set(request.subject, 50);
  view.setBigUint64(82, request.fromIndex, false); view.setBigUint64(90, request.toIndex, false);
  view.setUint32(98, entries.length, false);
  let offset = FIXED_BYTES;
  for (const entry of entries) {
    view.setBigUint64(offset, entry.index, false); view.setBigUint64(offset + 8, entry.ordinal, false);
    view.setUint32(offset + 16, entry.record.length, false);
    out.set(entry.record, offset + ENTRY_BYTES); offset += ENTRY_BYTES + entry.record.length;
  }
  return out;
}

/** The request is the reader's own input: bytes answering another request are
 * refused before any entry is read. Two passes bound and scan the whole frame
 * before copying records; exact inner bytes are owned, never decoded here. */
export function decodeRangeAnswer(bytesIn: Uint8Array, expectedIn: RangeRequest, boundIn: RangeLimits): RangeAnswer {
  const bound = copyLimits(boundIn);
  budget(BigInt(byteLength(bytesIn)), 0n, bound);
  const input = bytes(bytesIn), expected = copyRequest(expectedIn);
  if (input.length < FIXED_BYTES) throw new EncodingError("truncated range answer");
  if (compareBytes(input.subarray(0, 17), CONTEXT) !== 0) throw new EncodingError("wrong range context");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const kind = input[49];
  if (!isKind(kind)) throw new EncodingError("unsupported range record kind");
  const carried: RangeRequest = { venue: input.subarray(17, 49), kind, subject: input.subarray(50, 82),
    fromIndex: view.getBigUint64(82, false), toIndex: view.getBigUint64(90, false) };
  if (!sameRequest(carried, expected)) throw new EncodingError("answer to another request");
  const count = view.getUint32(98, false);
  budget(BigInt(input.length), BigInt(count), bound);
  if (BigInt(ENTRY_BYTES) * BigInt(count) > BigInt(input.length - FIXED_BYTES)) throw new EncodingError("impossible range entry count");
  const starts: number[] = [], lengths: number[] = [];
  let offset = FIXED_BYTES, previous: Position | undefined;
  for (let i = 0; i < count; i++) {
    if (offset + ENTRY_BYTES > input.length) throw new EncodingError("truncated range entry");
    const index = view.getBigUint64(offset, false), ordinal = view.getBigUint64(offset + 8, false);
    const length = view.getUint32(offset + 16, false);
    if (!recordLengthFits(kind, length) || length > input.length - offset - ENTRY_BYTES) {
      throw new EncodingError("range record length does not fit its kind");
    }
    // A view for the order check only; records are copied after the scan.
    const entry = { index, ordinal, record: input.subarray(offset + ENTRY_BYTES, offset + ENTRY_BYTES + length) };
    if (index < expected.fromIndex || index > expected.toIndex || !inOrder(kind, entry, previous)) {
      throw new EncodingError("range entry out of order, ordinal or range");
    }
    previous = entry; starts.push(offset + ENTRY_BYTES); lengths.push(length); offset += ENTRY_BYTES + length;
  }
  if (offset !== input.length) throw new EncodingError("trailing range bytes");
  const entries = starts.map((start, i) => Object.freeze({
    index: view.getBigUint64(start - ENTRY_BYTES, false), ordinal: view.getBigUint64(start - 12, false),
    record: copyBytes(input.subarray(start, start + lengths[i]!)),
  }));
  return Object.freeze({ request: expected, entries: Object.freeze(entries) });
}

export interface HeldCommitment { readonly index: bigint; readonly commitment: Commitment }
/** The reader's own derived state: the highest sequence it established as
 * held before the entries at `fromIndex`, through the adjacent earlier answer
 * (`next` of that answer's derivation) or as a commitment it holds at that
 * index. Supplied by anyone else it is not evidence (§13.3). */
export interface HeldPrior { readonly fromIndex: bigint; readonly highest: bigint }
export interface HeldCommitments { readonly held: readonly HeldCommitment[]; readonly next: HeldPrior }

/** The frame's own invariants hold for in-memory answers too (§13.1), so a
 * derivation never reads an order or range the frame forbids. */
function requireKind(answer: RangeAnswer, kind: RecordKind): { request: RangeRequest; entries: readonly Position[] } {
  if (answer === null || typeof answer !== "object") throw new EncodingError("wrong range kind");
  const request = copyRequest(answer.request);
  if (request.kind !== kind) throw new EncodingError("wrong range kind");
  return validEntries({ request, entries: answer.entries });
}
function decodeOrSkip<T>(decode: () => T): T | undefined {
  try { return decode(); } catch (error) {
    if (error instanceof EncodingError) return undefined;
    throw error;
  }
}

/** C2.3.3 index by index from the records alone (§13.3): at one index, every
 * verifying commitment of the subject whose sequence exceeds all held at
 * earlier indices is held, in ascending sequence order; one sequence twice at
 * one index is one held sequence, the lesser record bytes standing for it.
 * Records that are not held supply nothing to the record; whether two roots
 * at one sequence are provable fault is invariant 22's question, not this. */
export function heldCommitments(answer: RangeAnswer, prior?: HeldPrior): HeldCommitments {
  const { request, entries } = requireKind(answer, COMMITMENT_RANGE);
  let highest: bigint;
  if (request.fromIndex === 0n) {
    if (prior !== undefined) throw new EncodingError("a range from index zero has no prior held state");
    highest = 0n;
  } else {
    const { fromIndex, highest: priorHighest } = prior === null || typeof prior !== "object" ? {} as Partial<HeldPrior> : prior;
    if (!u64(fromIndex) || !u64(priorHighest) || fromIndex !== request.fromIndex) {
      throw new EncodingError("held prior must be established for the range's first index");
    }
    highest = priorHighest;
  }
  const held: HeldCommitment[] = [];
  for (let at = 0; at < entries.length;) {
    const index = entries[at]!.index, candidates = new Map<bigint, { commitment: Commitment; record: Uint8Array }>();
    for (; at < entries.length && entries[at]!.index === index; at++) {
      const record = entries[at]!.record, commitment = decodeOrSkip(() => decodeCommitment(record));
      if (commitment === undefined || compareBytes(commitment.operator, request.subject) !== 0 ||
          commitment.sequence <= highest || !verifyCommitment(commitment)) continue;
      const twin = candidates.get(commitment.sequence);
      if (twin === undefined || compareBytes(record, twin.record) < 0) candidates.set(commitment.sequence, { commitment, record });
    }
    for (const sequence of [...candidates.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const { commitment } = candidates.get(sequence)!;
      held.push(Object.freeze({ index, commitment: Object.freeze({ sequence, root: copyBytes(commitment.root),
        operator: copyBytes(commitment.operator), signature: copyBytes(commitment.signature) }) }));
      highest = sequence;
    }
  }
  // The adjacent answer's prior; a range through 2^64 - 1 has no successor.
  return Object.freeze({ held: Object.freeze(held), next: Object.freeze({ fromIndex: request.toIndex + 1n, highest }) });
}

/** C2b.1 on this venue: the first entry that decodes, names the subject and
 * verifies. Undefined over [0, t] means not revoked at t; over a shorter range
 * it establishes that for the range only. */
export function revocationIndex(answer: RangeAnswer): bigint | undefined {
  const { request, entries } = requireKind(answer, REVOCATION_RANGE);
  for (const entry of entries) {
    const revocation = decodeOrSkip(() => decodeRevocation(entry.record));
    if (revocation !== undefined && compareBytes(revocation.obligor, request.subject) === 0 &&
        isSignedRevocation(revocation)) return entry.index;
  }
  return undefined;
}

export interface AdmittedReplacement { readonly index: bigint; readonly identity: Uint8Array; readonly replacement: Replacement }
/** Records that count for C2.5's walk: decode, name the subject, role 1, and
 * verify under the declared rule key and the successor. A record's identity
 * is its signed-message hash, the value its successor names; one identity
 * counts once, at its first witnessing. Without a declared rule no record
 * counts. The walk itself (lead floor, supersession, lesser identity at one
 * index) is not applied here. */
export function admittedReplacements(answer: RangeAnswer, ruleKey: Uint8Array | undefined): readonly AdmittedReplacement[] {
  const { request, entries } = requireKind(answer, REPLACEMENT_RANGE);
  if (ruleKey === undefined) return Object.freeze([]);
  const rule = bytes(ruleKey, 32);
  const admitted: AdmittedReplacement[] = [];
  for (const entry of entries) {
    const decoded = decodeOrSkip(() => decodeReplacement(entry.record));
    if (decoded === undefined) continue;
    const { backingName, replacement } = decoded;
    if (compareBytes(backingName, request.subject) !== 0 || !verifyReplacement(backingName, replacement, rule)) continue;
    const identity = replacementHash(backingName, replacement);
    if (admitted.some(earlier => compareBytes(earlier.identity, identity) === 0)) continue;
    admitted.push(Object.freeze({ index: entry.index, identity,
      replacement: Object.freeze({ role: replacement.role, successor: copyBytes(replacement.successor),
        predecessor: copyBytes(replacement.predecessor), effective: replacement.effective,
        signature: copyBytes(replacement.signature), successorSignature: copyBytes(replacement.successorSignature) }) }));
  }
  return Object.freeze(admitted);
}

export interface ChainLink { readonly operator: Uint8Array; readonly from: bigint; readonly link: Uint8Array }
export interface ReplacementChain { readonly chain: readonly ChainLink[]; readonly pending?: ChainLink }
export interface ChainContext {
  readonly backing: Uint8Array;
  /** The operator the backing's terms name: the genesis link's key. */
  readonly original: Uint8Array;
  /** The venue's lag (C2.3.5), a constant of the venue profile (§13.2). */
  readonly lag: bigint;
  /** The index the chain is read at; a link effective later is pending. */
  readonly now: bigint;
}
/** C2.5's walk over admitted records (§13.3), the rules of
 * the retired transparent walk read from range entries: a record whose
 * effective index is below its witnessing plus twice the lag plus one is no
 * replacement (C2.5.3); a candidate names the current link and is strictly
 * later than the incumbent's force, or names the incumbent and revokes
 * (C2.5.4); candidates are read by witnessed index, one per index by the
 * lesser identity, and a later one supersedes the standing candidate only
 * where witnessed strictly before its effective index (C2.5.5). A link whose
 * effective index is past `now` is pending, not in force. One identity
 * counts at its first entry and records witnessed after `now` are not read,
 * so over records `admittedReplacements` returned, the chain is the chain at
 * `now` whichever answers they came from. */
export function replacementChain(admittedIn: readonly AdmittedReplacement[], context: ChainContext): ReplacementChain {
  if (context === null || typeof context !== "object" || !Array.isArray(admittedIn)) throw new EncodingError("invalid chain context");
  const { lag, now } = context, backing = bytes(context.backing, 32), original = bytes(context.original, 32);
  if (!u64(lag) || !u64(now)) throw new EncodingError("invalid chain context");
  // The walk reads each record many times, so it reads owned copies.
  const admitted = copyArray(admittedIn, (a: AdmittedReplacement) => {
    if (a === null || typeof a !== "object" || a.replacement === null || typeof a.replacement !== "object") {
      throw new EncodingError("invalid admitted replacement");
    }
    const { index, identity, replacement: { predecessor, successor, effective } } = a;
    if (!u64(index) || !u64(effective)) throw new EncodingError("invalid admitted replacement");
    return { index, identity: bytes(identity, 32),
      replacement: { predecessor: bytes(predecessor, 32), successor: bytes(successor, 32), effective } };
  });
  // One identity is one record, witnessed at its first entry (§13.3), however
  // the caller gathered the admitted records: a later copy supersedes nothing.
  const first = new Map<string, (typeof admitted)[number]>();
  for (const a of admitted) {
    if (a.index > now) continue;
    const key = bytesToHex(a.identity), earlier = first.get(key);
    if (earlier === undefined || a.index < earlier.index) first.set(key, a);
  }
  const floored = [...first.values()].filter(a => a.replacement.effective >= a.index + 2n * lag + 1n);
  const chain: ChainLink[] = [Object.freeze({ operator: copyBytes(original), from: 0n, link: copyBytes(backing) })];
  const seen: Uint8Array[] = [backing];
  let link = backing;
  for (;;) {
    const incumbent = chain[chain.length - 1]!;
    const candidates = floored
      .filter(a => compareBytes(a.replacement.predecessor, link) === 0 &&
        (a.replacement.effective > incumbent.from || compareBytes(a.replacement.successor, incumbent.operator) === 0))
      .sort((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : compareBytes(x.identity, y.identity)));
    let chosen: (typeof admitted)[number] | undefined, consideredAt: bigint | undefined;
    for (const candidate of candidates) {
      if (consideredAt !== undefined && candidate.index === consideredAt) continue;
      if (chosen !== undefined && candidate.index >= chosen.replacement.effective) break;
      consideredAt = candidate.index;
      chosen = compareBytes(candidate.replacement.successor, incumbent.operator) === 0 ? undefined : candidate;
    }
    if (chosen === undefined) return Object.freeze({ chain: Object.freeze(chain) });
    const next = Object.freeze({ operator: copyBytes(chosen.replacement.successor), from: chosen.replacement.effective,
      link: copyBytes(chosen.identity) });
    if (next.from > now) return Object.freeze({ chain: Object.freeze(chain), pending: next });
    // A hash cycle cannot be built; this bounds the walk on any input.
    if (seen.some(earlier => compareBytes(earlier, chosen.identity) === 0)) return Object.freeze({ chain: Object.freeze(chain) });
    seen.push(chosen.identity);
    chain.push(next); link = chosen.identity;
  }
}

/** The link in force at `index`: the last whose effective index has arrived. */
export function linkInForce(chain: readonly ChainLink[], index: bigint): ChainLink {
  if (!Array.isArray(chain) || chain.length === 0 || !u64(index)) throw new EncodingError("invalid chain");
  let inForce = chain[0]!;
  for (const link of chain) if (link.from <= index) inForce = link;
  return inForce;
}
