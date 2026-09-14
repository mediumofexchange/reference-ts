// Record-range answers, pool-v3 §13. Source-neutral transport between a
// reader's independently selected venue-evidence verifier and its replay.
// A decoded answer is that verifier's output, never supplied evidence, and it
// establishes no directory, trail, classification, force or verdict.
import { compareBytes, copyBytes, EncodingError } from "../src/bytes.js";
import { decodeCommitment, verifyCommitment, type Commitment } from "../src/commitment.js";
import { verifySignatureStrict } from "../src/keys.js";
import { decodeReplacement, replacementHash, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { decodeRevocation, isSignedRevocation } from "../src/revocation.js";

const CONTEXT = new TextEncoder().encode("moe/pool/v3/range");
const FIXED_BYTES = 102, ENTRY_BYTES = 20, MAX_U32 = 0xffff_ffff, MAX_U64 = (1n << 64n) - 1n;
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
function bytes(value: unknown, width?: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.buffer instanceof SharedArrayBuffer ||
      (width !== undefined && value.length !== width)) throw new EncodingError("invalid or shared range bytes");
}
function limits(value: RangeLimits): void {
  if (value === null || typeof value !== "object" || !u64(value.maxBytes) || !u64(value.maxEntries)) {
    throw new EncodingError("invalid range budget");
  }
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
export function copyRequest(r: RangeRequest): RangeRequest {
  if (!isWellFormedRequest(r)) throw new EncodingError("malformed range request");
  return Object.freeze({ venue: copyBytes(r.venue), kind: r.kind, subject: copyBytes(r.subject),
    fromIndex: r.fromIndex, toIndex: r.toIndex });
}

/** §13.1's structure over caller objects, read once: every entry's fields
 * are captured here so a later read cannot present other values. Budgets are
 * the caller's; an in-memory answer that breaks the frame's order, range or
 * length rules is refused before any rule reads it. */
function validEntries(answer: RangeAnswer): readonly Position[] {
  if (answer === null || typeof answer !== "object" || !isWellFormedRequest(answer.request) ||
      !Array.isArray(answer.entries)) throw new EncodingError("invalid range answer");
  const { request, entries } = answer;
  if (entries.length > MAX_U32) throw new EncodingError("range entry count exceeds u32");
  const captured: Position[] = [];
  let previous: Position | undefined;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") throw new EncodingError("invalid range entry");
    const { index, ordinal, record } = entry;
    if (!u64(index) || !u64(ordinal)) throw new EncodingError("invalid range entry");
    bytes(record);
    const position = { index, ordinal, record };
    if (index < request.fromIndex || index > request.toIndex || !inOrder(request.kind, position, previous)) {
      throw new EncodingError("range entry out of order, ordinal or range");
    }
    if (!recordLengthFits(request.kind, record.length)) throw new EncodingError("range record length does not fit its kind");
    previous = position; captured.push(position);
  }
  return captured;
}

/** Shape, order and budgets before any output allocation. */
function requireAnswer(answer: RangeAnswer, bound: RangeLimits): { size: bigint; entries: readonly Position[] } {
  limits(bound);
  const entries = validEntries(answer), count = BigInt(entries.length);
  let size = BigInt(FIXED_BYTES) + BigInt(ENTRY_BYTES) * count;
  budget(size, count, bound);
  for (const entry of entries) { size += BigInt(entry.record.length); budget(size, count, bound); }
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeLimitError("range allocation range exceeded");
  return { size, entries };
}

export function encodeRangeAnswer(answer: RangeAnswer, bound: RangeLimits): Uint8Array {
  // The request is copied once as well, so no field is re-read from the caller's object.
  const { size, entries } = requireAnswer(answer, bound), request = copyRequest(answer.request);
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
export function decodeRangeAnswer(input: Uint8Array, expected: RangeRequest, bound: RangeLimits): RangeAnswer {
  limits(bound); bytes(input);
  if (!isWellFormedRequest(expected)) throw new EncodingError("malformed range request");
  budget(BigInt(input.length), 0n, bound);
  if (input.length < FIXED_BYTES) throw new EncodingError("truncated range answer");
  if (compareBytes(input.subarray(0, 17), CONTEXT) !== 0) throw new EncodingError("wrong range context");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const kind = input[49];
  if (!isKind(kind)) throw new EncodingError("unsupported range record kind");
  const carried: RangeRequest = { venue: input.subarray(17, 49), kind, subject: input.subarray(50, 82),
    fromIndex: view.getBigUint64(82, false), toIndex: view.getBigUint64(90, false) };
  if (carried.fromIndex > carried.toIndex || !sameRequest(carried, expected)) throw new EncodingError("answer to another request");
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
  return Object.freeze({ request: copyRequest(expected), entries: Object.freeze(entries) });
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
function requireKind(answer: RangeAnswer, kind: RecordKind): readonly Position[] {
  if (answer === null || typeof answer !== "object" || !isWellFormedRequest(answer.request) ||
      answer.request.kind !== kind) throw new EncodingError("wrong range kind");
  return validEntries(answer);
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
  const entries = requireKind(answer, COMMITMENT_RANGE), { request } = answer;
  let highest: bigint;
  if (request.fromIndex === 0n) {
    if (prior !== undefined) throw new EncodingError("a range from index zero has no prior held state");
    highest = 0n;
  } else {
    if (prior === null || typeof prior !== "object" || !u64(prior.fromIndex) || !u64(prior.highest) ||
        prior.fromIndex !== request.fromIndex) throw new EncodingError("held prior must be established for the range's first index");
    highest = prior.highest;
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

/** Identical bytes at two positions are one object, witnessed at the first
 * (kinds 3 and 4, §13.1). Returns owned copies in answer order. */
export function firstWitnessed(answer: RangeAnswer): readonly RangeEntry[] {
  const seen: RangeEntry[] = [];
  for (const entry of validEntries(answer)) {
    if (seen.some(earlier => compareBytes(earlier.record, entry.record) === 0)) continue;
    seen.push(Object.freeze({ index: entry.index, ordinal: entry.ordinal, record: copyBytes(entry.record) }));
  }
  return Object.freeze(seen);
}

/** C2b.1 on this venue: the first entry that decodes, names the subject and
 * verifies. Undefined over [0, t] means not revoked at t; over a shorter range
 * it establishes that for the range only. */
export function revocationIndex(answer: RangeAnswer): bigint | undefined {
  for (const entry of requireKind(answer, REVOCATION_RANGE)) {
    const revocation = decodeOrSkip(() => decodeRevocation(entry.record));
    if (revocation !== undefined && compareBytes(revocation.obligor, answer.request.subject) === 0 &&
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
  const entries = requireKind(answer, REPLACEMENT_RANGE);
  if (ruleKey === undefined) return Object.freeze([]);
  bytes(ruleKey, 32);
  const admitted: AdmittedReplacement[] = [];
  for (const entry of entries) {
    const decoded = decodeOrSkip(() => decodeReplacement(entry.record));
    if (decoded === undefined) continue;
    const { backingName, replacement } = decoded;
    if (compareBytes(backingName, answer.request.subject) !== 0 || replacement.role !== ROLE_OPERATOR) continue;
    const message = replacementMessage(backingName, replacement);
    if (!verifySignatureStrict(replacement.signature, message, ruleKey) ||
        !verifySignatureStrict(replacement.successorSignature, message, replacement.successor)) continue;
    const identity = replacementHash(backingName, replacement);
    if (admitted.some(earlier => compareBytes(earlier.identity, identity) === 0)) continue;
    admitted.push(Object.freeze({ index: entry.index, identity,
      replacement: Object.freeze({ role: replacement.role, successor: copyBytes(replacement.successor),
        predecessor: copyBytes(replacement.predecessor), effective: replacement.effective,
        signature: copyBytes(replacement.signature), successorSignature: copyBytes(replacement.successorSignature) }) }));
  }
  return Object.freeze(admitted);
}

export interface OrderedEntry extends RangeEntry { readonly subject: Uint8Array }
/** The venue's order across several backings' publication answers for one
 * venue and range, by index then ordinal (§13.1; C2b.4.2's adopted block).
 * Only kind 4 carries that order; two objects at one (index, ordinal) are the
 * verifier's contradiction. */
export function mergeVenueOrder(answers: readonly RangeAnswer[]): readonly OrderedEntry[] {
  if (!Array.isArray(answers) || answers.length === 0) throw new EncodingError("no range answers to merge");
  const first = answers[0]!.request;
  const merged: OrderedEntry[] = [];
  for (const answer of answers) {
    const entries = requireKind(answer, PUBLICATION_RANGE);
    const r = answer.request;
    if (compareBytes(r.venue, first.venue) !== 0 || r.fromIndex !== first.fromIndex || r.toIndex !== first.toIndex) {
      throw new EncodingError("range answers of different venues or ranges cannot be merged");
    }
    for (const entry of entries) merged.push({ ...entry, subject: r.subject });
  }
  merged.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0));
  for (let i = 1; i < merged.length; i++) {
    if (merged[i]!.index === merged[i - 1]!.index && merged[i]!.ordinal === merged[i - 1]!.ordinal) {
      throw new EncodingError("two objects at one venue position");
    }
  }
  return Object.freeze(merged.map(entry => Object.freeze({ index: entry.index, ordinal: entry.ordinal,
    record: copyBytes(entry.record), subject: copyBytes(entry.subject) })));
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
/** C2.5's walk over the admitted records of one answer (§13.3), the rules of
 * `src/replacement.ts`'s walk read from range entries: a record whose
 * effective index is below its witnessing plus twice the lag plus one is no
 * replacement (C2.5.3); a candidate names the current link and is strictly
 * later than the incumbent's force, or names the incumbent and revokes
 * (C2.5.4); candidates are read by witnessed index, one per index by the
 * lesser identity, and a later one supersedes the standing candidate only
 * where witnessed strictly before its effective index (C2.5.5). A link whose
 * effective index is past `now` is pending, not in force. Records after
 * `now` are not in the answer, so the chain is the chain at `now`. */
export function replacementChain(admitted: readonly AdmittedReplacement[], context: ChainContext): ReplacementChain {
  if (context === null || typeof context !== "object" || !Array.isArray(admitted)) throw new EncodingError("invalid chain context");
  const { backing, original, lag, now } = context;
  bytes(backing, 32); bytes(original, 32);
  if (!u64(lag) || !u64(now)) throw new EncodingError("invalid chain context");
  const floored = admitted.filter(a => a.replacement.effective >= a.index + 2n * lag + 1n);
  const chain: ChainLink[] = [Object.freeze({ operator: copyBytes(original), from: 0n, link: copyBytes(backing) })];
  const seen: Uint8Array[] = [backing];
  let link = backing;
  for (;;) {
    const incumbent = chain[chain.length - 1]!;
    const candidates = floored
      .filter(a => compareBytes(a.replacement.predecessor, link) === 0 &&
        (a.replacement.effective > incumbent.from || compareBytes(a.replacement.successor, incumbent.operator) === 0))
      .sort((x, y) => (x.index < y.index ? -1 : x.index > y.index ? 1 : compareBytes(x.identity, y.identity)));
    let chosen: AdmittedReplacement | undefined, consideredAt: bigint | undefined;
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
