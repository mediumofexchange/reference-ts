// pool-v3 §13's read side of a witness venue, its publishing side, and a
// local venue that answers from records its owner witnessed or was handed.
//
// A reader asks a venue for exact range answers (§13.1) over indices it has
// witnessed, under the venue's lag (C2.3.5). `ErgoVenue` answers from the
// sections it verified itself; `FixtureVenue` answers from the records handed
// to it, so it is a local reference venue for tests and local operation, never
// a source of chain evidence.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { utf8Encoder } from "./contexts.js";
import { copyRequest, encodeRangeAnswer, type RangeLimits, type RangeRequest, type RecordKind } from "./record-range.js";

/** The local reference context: a reference-only venue, never a deployment
 * profile. Its identity names a label and a lag under this context, so which
 * kind of venue an identity names is read from its preimage, never its bytes. */
export const LOCAL_REFERENCE = "moe/venue/local/reference";

/** A local reference venue's identity: the context, a 32-byte label and the lag, each framed. */
export function localVenueIdentity(label: Uint8Array, lag: bigint): Uint8Array {
  if (!isKey(label) || !isIndex(lag)) throw new EncodingError("invalid local venue preimage");
  const w = new ByteWriter();
  w.lengthPrefixed(utf8Encoder.encode(LOCAL_REFERENCE));
  w.fixed(label, 32, "local venue label");
  w.u64(lag);
  return sha256(w.finish());
}

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

/**
 * The publishing side (C2.3.1): submit one kind 1–4 record, filed under its
 * subject. It resolves once the venue took the record for witnessing, not once
 * witnessed; whether and where it was witnessed is read back through `range`.
 * Exact resubmission is harmless. A venue that cannot take it throws
 * `VenueError`; malformed arguments are the caller's error.
 */
export interface RecordPublisher {
  publishRecord(kind: RecordKind, subject: Uint8Array, record: Uint8Array): Promise<void>;
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
export class FixtureVenue implements RecordVenue, RecordPublisher {
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

  /** A venue of the local reference context (`LOCAL_REFERENCE`), its identity recomputed from its preimage. */
  static reference(label: Uint8Array, lag: bigint, witnessedIndex = 0n): FixtureVenue {
    if (!isKey(label) || !isIndex(lag)) throw new TypeError("invalid fixture venue");
    return new FixtureVenue(localVenueIdentity(label, lag), witnessedIndex, lag);
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

  /**
   * A local venue witnesses each published record at the next index, moving
   * its clock there. An exact record already witnessed under the same kind
   * and subject is not witnessed again.
   */
  async publishRecord(kind: RecordKind, subject: Uint8Array, record: Uint8Array): Promise<void> {
    if (!isKind(kind) || !isKey(subject) || !(record instanceof Uint8Array) || record.buffer instanceof SharedArrayBuffer) {
      throw new TypeError("invalid fixture venue record");
    }
    if (this.#records.some(r => r.kind === kind && compareBytes(r.subject, subject) === 0 && compareBytes(r.record, record) === 0)) return;
    if (this.#witnessed === MAX_U64) throw new TypeError("a fixture venue's clock is exhausted");
    this.advance(this.#witnessed + 1n);
    this.witness(kind, subject, this.#witnessed, record);
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
