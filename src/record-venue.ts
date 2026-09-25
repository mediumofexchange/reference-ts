// pool-v3 §13's read side of a witness venue, and a local venue that answers
// it from records its owner witnessed.
//
// A reader asks a venue for exact range answers (§13.1) over indices it has
// witnessed, under the venue's lag (C2.3.5). `ErgoVenue` answers from the
// sections it verified itself; `FixtureVenue` answers from the records handed
// to it, so it is a local reference venue for tests and local operation, never
// a source of chain evidence.
import { compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { copyRequest, encodeRangeAnswer, type RangeLimits, type RangeRequest, type RecordKind } from "./record-range.js";

/**
 * The narrow venue a v3 reader reads. `range` returns the exact §13.1 answer,
 * or undefined where this venue cannot answer: another venue's identity, a
 * range past the witnessed index, or evidence it does not hold. An answer over
 * the caller's `limits` throws `RangeLimitError`: the evidence exists and the
 * reader's own budget refuses it. A venue with no answer at all (an unsynced or
 * failed view) throws `VenueError` from every read; invalid `limits` are the
 * caller's error (`EncodingError`). Every read answers synchronously.
 */
export interface RecordVenue {
  readonly id: Uint8Array;
  /** The venue's lag (C2.3.5), a constant of its identity. */
  lag(): bigint;
  /** The last index this venue has witnessed; answers reach no further. */
  witnessedIndex(): bigint;
  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined;
}

/** A fixture venue's records as plain data, for a fresh process to rebuild it in the same order. */
export interface FixtureVenueData {
  readonly id: Uint8Array;
  readonly witnessedIndex: bigint;
  readonly lag: bigint;
  readonly records: readonly { readonly kind: RecordKind; readonly subject: Uint8Array; readonly index: bigint; readonly record: Uint8Array }[];
}

interface Witnessed { readonly kind: RecordKind; readonly subject: Uint8Array; readonly index: bigint; readonly ordinal: bigint; readonly record: Uint8Array }

const MAX_U64 = (1n << 64n) - 1n;
const isIndex = (value: unknown): value is bigint => typeof value === "bigint" && value >= 0n && value <= MAX_U64;
const isKey = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length === 32 && !(value.buffer instanceof SharedArrayBuffer);
const isKind = (value: unknown): value is RecordKind => value === 1 || value === 2 || value === 3 || value === 4;

/**
 * A local venue: its owner witnesses each record at an index at or below a
 * clock that only moves forward. Venue order within an index is insertion
 * order across every kind and subject; a kind-4 ordinal is that position,
 * comparable across answers, and kinds 1–3 carry zero (§13.1). Bytes are
 * copied in and out; nothing is decoded, filtered or judged here. Its owner's
 * misuse throws TypeError, never a refusal a reader could take for evidence.
 */
export class FixtureVenue implements RecordVenue {
  readonly #id: Uint8Array;
  readonly #lag: bigint;
  #witnessed: bigint;
  readonly #records: Witnessed[] = [];

  constructor(id: Uint8Array, witnessedIndex = 0n, lag = 0n) {
    if (!isKey(id) || !isIndex(witnessedIndex) || !isIndex(lag)) throw new TypeError("invalid fixture venue");
    this.#id = copyBytes(id);
    this.#witnessed = witnessedIndex;
    this.#lag = lag;
  }

  get id(): Uint8Array {
    return copyBytes(this.#id);
  }

  lag(): bigint {
    return this.#lag;
  }

  witnessedIndex(): bigint {
    return this.#witnessed;
  }

  /** Move the clock forward to `to`. */
  advance(to: bigint): void {
    if (!isIndex(to) || to < this.#witnessed) throw new TypeError("a fixture venue's clock only moves forward");
    this.#witnessed = to;
  }

  /** Witness `record` of `kind`, filed under `subject`, at index `at`. */
  witness(kind: RecordKind, subject: Uint8Array, at: bigint, record: Uint8Array): void {
    if (!isKind(kind) || !isKey(subject) || !isIndex(at) || at > this.#witnessed ||
        !(record instanceof Uint8Array) || record.buffer instanceof SharedArrayBuffer) throw new TypeError("invalid fixture venue record");
    const ordinal = kind === 4 ? BigInt(this.#records.filter(r => r.index === at).length) : 0n;
    this.#records.push({ kind, subject: copyBytes(subject), index: at, ordinal, record: copyBytes(record) });
  }

  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined {
    let own: RangeRequest;
    try { own = copyRequest(request); } catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
    if (compareBytes(own.venue, this.#id) !== 0 || own.toIndex > this.#witnessed) return undefined;
    const entries = this.#records
      .filter(r => r.kind === own.kind && compareBytes(r.subject, own.subject) === 0 && r.index >= own.fromIndex && r.index <= own.toIndex)
      .map(r => ({ index: r.index, ordinal: r.ordinal, record: copyBytes(r.record) }));
    // Kind 4 keeps the venue's order within an index; kinds 1–3 are canonical by record bytes (§13.1).
    entries.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1
      : own.kind === 4 ? (a.ordinal < b.ordinal ? -1 : 1) : compareBytes(a.record, b.record)));
    return encodeRangeAnswer({ request: own, entries }, limits);
  }

  export(): FixtureVenueData {
    return { id: copyBytes(this.#id), witnessedIndex: this.#witnessed, lag: this.#lag,
      records: this.#records.map(r => ({ kind: r.kind, subject: copyBytes(r.subject), index: r.index, record: copyBytes(r.record) })) };
  }

  /** The venue `data` describes, its records witnessed again in their order, so ordinals come out the same. */
  static from(data: FixtureVenueData): FixtureVenue {
    if (data === null || typeof data !== "object" || !Array.isArray(data.records)) throw new TypeError("invalid fixture venue data");
    const venue = new FixtureVenue(data.id, data.witnessedIndex, data.lag);
    for (const r of data.records) venue.witness(r.kind, r.subject, r.index, r.record);
    return venue;
  }
}
