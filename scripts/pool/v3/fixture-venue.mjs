// Fixture venue record for the local replay experiment. It is a harness-owned
// trust input beside the candidate manifest and selection: the reader's
// independently selected venue-evidence verifier (pool-v3 §13.2), answering
// §13 requests from records the harness itself witnessed. It is not a venue
// profile, a source of authenticated chain evidence or a production reader.
import { compareBytes, copyBytes } from "../../../dist/bytes.js";

const same = (a, b) => compareBytes(a, b) === 0;
const key32 = value => value instanceof Uint8Array && value.length === 32 && !(value.buffer instanceof SharedArrayBuffer);
const index = value => typeof value === "bigint" && value >= 0n && value < (1n << 64n);

export class FixtureVenue {
  #id; #witnessed = 0n; #lag = 0n; #records = [];
  /** The lag (C2.3.5) is a constant of the venue, read by the chain walk. */
  constructor(id, witnessedIndex = 0n, lag = 0n) {
    if (!key32(id) || !index(witnessedIndex) || !index(lag)) throw new Error("fixture venue identity");
    this.#id = copyBytes(id); this.#witnessed = witnessedIndex; this.#lag = lag;
  }
  get id() { return copyBytes(this.#id); }
  get witnessedIndex() { return this.#witnessed; }
  get lag() { return this.#lag; }
  /** The clock only moves forward; a record is witnessed at or below it. */
  advance(to) {
    if (!index(to) || to < this.#witnessed) throw new Error("fixture venue clock");
    this.#witnessed = to;
  }
  /** Venue order within an index is insertion order across every kind and
   * subject; kind-4 ordinals take that position and compare across answers,
   * kinds 1–3 carry zero (§13.1). Bytes are copied on the way in; nothing is
   * decoded, filtered or judged here. */
  witness(kind, subject, at, record) {
    if (![1, 2, 3, 4].includes(kind) || !key32(subject) || !index(at) || at > this.#witnessed ||
        !(record instanceof Uint8Array) || record.buffer instanceof SharedArrayBuffer) throw new Error("fixture venue record");
    const ordinal = kind === 4 ? BigInt(this.#records.filter(r => r.index === at).length) : 0n;
    this.#records.push({ kind, subject: copyBytes(subject), index: at, ordinal, record: copyBytes(record) });
  }
  /** §13.2: no answer for another venue, an unsupported request or an
   * unwitnessed toIndex. Otherwise exactly the attributed records in range. */
  answer(request, codec, limits) {
    if (!codec.isWellFormedRequest(request) || !same(request.venue, this.#id) || request.toIndex > this.#witnessed) return undefined;
    const entries = this.#records
      .filter(r => r.kind === request.kind && same(r.subject, request.subject) && r.index >= request.fromIndex && r.index <= request.toIndex)
      .map(r => ({ index: r.index, ordinal: r.ordinal, record: r.record }));
    // Kind 4 keeps the venue's order within an index; kinds 1–3 are canonical by record bytes (§13.1).
    entries.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1
      : request.kind === 4 ? (a.ordinal < b.ordinal ? -1 : 1) : compareBytes(a.record, b.record)));
    return codec.encodeRangeAnswer({ request, entries }, limits);
  }
  /** Plain data for the fixture IPC; the fresh process rebuilds its own record
   * in the same order, so it derives the same ordinals. */
  export() {
    return { id: copyBytes(this.#id), witnessedIndex: this.#witnessed, lag: this.#lag,
      records: this.#records.map(r => ({ kind: r.kind, subject: copyBytes(r.subject), index: r.index, record: copyBytes(r.record) })) };
  }
  static from(data) {
    if (data === null || typeof data !== "object" || !Array.isArray(data.records)) throw new Error("fixture venue data");
    const venue = new FixtureVenue(data.id, data.witnessedIndex, data.lag);
    for (const r of data.records) venue.witness(r.kind, r.subject, r.index, r.record);
    return venue;
  }
}
