import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import * as range from "../model/pool-v3-range.js";
import { EncodingError } from "../src/bytes.js";
import { encodeCommitment, signCommitment } from "../src/commitment.js";
import { encodeReplacement, replacementMessage, ROLE_OPERATOR, type Replacement } from "../src/replacement.js";
import { encodeRevocation, signRevocation } from "../src/revocation.js";

// Independent Buffer framing and hash oracle. Commitments, replacements and
// revocations are genuinely signed; nothing here is a venue, a verdict or a
// venue profile.
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const u32 = (n: number): Buffer => integer(BigInt(n), 4);
const b = (n: number): Buffer => Buffer.alloc(32, n);
const sha = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const venue = b(12), backing = b(17);
const operatorSecret = b(29), operator = ed25519.getPublicKey(operatorSecret);
const otherSecret = b(31), other = ed25519.getPublicKey(otherSecret);
const ruleSecret = b(37), rule = ed25519.getPublicKey(ruleSecret);
const obligorSecret = b(41), obligor = ed25519.getPublicKey(obligorSecret);
const wide = { maxBytes: 1n << 40n, maxEntries: 1n << 20n };

function rawAnswer(answer: range.RangeAnswer): Buffer {
  const r = answer.request;
  return cat(Buffer.from("moe/pool/v3/range", "ascii"), r.venue, Uint8Array.of(r.kind), r.subject,
    integer(r.fromIndex, 8), integer(r.toIndex, 8), u32(answer.entries.length),
    ...answer.entries.map(entry => cat(integer(entry.index, 8), integer(entry.ordinal, 8), u32(entry.record.length), entry.record)));
}
function request(kind: range.RecordKind, subject: Uint8Array, fromIndex = 0n, toIndex = 20n): range.RangeRequest {
  return { venue, kind, subject, fromIndex, toIndex };
}
function commitment(sequence: bigint, secret = operatorSecret, root = b(Number(sequence) + 60)): Uint8Array {
  return encodeCommitment(signCommitment(secret, sequence, root));
}
function entry(index: bigint, record: Uint8Array, ordinal = 0n): range.RangeEntry {
  return { index, ordinal, record };
}
/** Canonical entries (§13.1): kind-4 ordinals follow insertion order within each index, as a
 * venue's would; kinds 1-3 carry zero and stand in ascending record-byte order within an index. */
function ordered(entries: { index: bigint; record: Uint8Array }[], kind: range.RecordKind = 1): range.RangeEntry[] {
  const counters = new Map<bigint, bigint>();
  if (kind === 4) {
    return entries.map(e => {
      const ordinal = counters.get(e.index) ?? 0n; counters.set(e.index, ordinal + 1n);
      return { index: e.index, ordinal, record: e.record };
    });
  }
  return entries.map(e => ({ index: e.index, ordinal: 0n, record: e.record }))
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : Buffer.compare(a.record, b.record)));
}
function values(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(values);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, values(item)]));
  }
  return value;
}
function replacement(effective: bigint, successorSecret = otherSecret, signer = ruleSecret): { record: Uint8Array; replacement: Replacement } {
  const successor = ed25519.getPublicKey(successorSecret);
  const fields = { role: ROLE_OPERATOR, successor, predecessor: backing, effective };
  const message = replacementMessage(backing, { ...fields, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) });
  const signed = { ...fields, signature: ed25519.sign(message, signer), successorSignature: ed25519.sign(message, successorSecret) };
  return { record: encodeReplacement(backing, signed), replacement: signed };
}

describe("v3 record-range answers", () => {
  it("matches independent framing for every kind, including an authenticated empty answer", () => {
    const answers: range.RangeAnswer[] = [
      { request: request(1, operator), entries: [entry(3n, commitment(1n)), entry(3n, commitment(2n)), entry(9n, commitment(3n))] },
      { request: request(2, backing, 4n, 4n), entries: [entry(4n, replacement(30n).record)] },
      { request: request(3, obligor), entries: [entry(20n, encodeRevocation(signRevocation(obligorSecret)))] },
      { request: request(4, backing, 5n, 7n), entries: [entry(5n, new Uint8Array(0), 3n), entry(5n, Uint8Array.of(9, 8), 1n << 40n)] },
      { request: request(1, operator, 0n, 0n), entries: [] },
    ];
    for (const answer of answers) {
      const expected = rawAnswer(answer);
      expect(expected.length).toBe(102 + answer.entries.reduce((sum, e) => sum + 20 + e.record.length, 0));
      expect(Buffer.from(range.encodeRangeAnswer(answer, wide))).toEqual(expected);
      const decoded = range.decodeRangeAnswer(expected, answer.request, wide);
      expect(values(decoded)).toEqual(values(answer));
      expect(Buffer.from(range.encodeRangeAnswer(decoded, wide))).toEqual(expected);
    }
    expect(Buffer.from("moe/pool/v3/range", "ascii")).toHaveLength(17);
  });

  it("carries exact-length records for kinds 1-3 and bounded publications without decoding them", () => {
    expect(range.MAX_RANGE_RECORD_BYTES).toEqual({ 1: 136, 2: 233, 3: 96, 4: 92 + 131822 });
    for (const [kind, bound] of Object.entries(range.MAX_RANGE_RECORD_BYTES)) {
      const k = Number(kind) as range.RecordKind, subject = k === 1 ? operator : k === 3 ? obligor : backing;
      const atBound: range.RangeAnswer = { request: request(k, subject), entries: [entry(1n, new Uint8Array(bound).fill(7))] };
      const encoded = range.encodeRangeAnswer(atBound, wide);
      expect(range.decodeRangeAnswer(encoded, atBound.request, wide).entries[0]!.record).toHaveLength(bound);
      for (const length of k === 4 ? [bound + 1] : [bound + 1, bound - 1, 0]) {
        const wrong = { ...atBound, entries: [entry(1n, new Uint8Array(length))] };
        expect(() => range.encodeRangeAnswer(wrong, wide)).toThrow(/length does not fit/);
        const forged = Buffer.from(encoded); forged.writeUInt32BE(length, 102 + 16);
        const input = length > bound ? cat(forged, Uint8Array.of(0)) : forged.subarray(0, 102 + 20 + length);
        expect(() => range.decodeRangeAnswer(input, atBound.request, wide)).toThrow(EncodingError);
      }
    }
    const shorter: range.RangeAnswer = { request: request(4, backing), entries: [entry(1n, new Uint8Array(0)), entry(1n, Uint8Array.of(1), 1n)] };
    expect(range.decodeRangeAnswer(range.encodeRangeAnswer(shorter, wide), shorter.request, wide).entries).toHaveLength(2);
  });

  it("refuses answers to another request before reading any entry", () => {
    const answer: range.RangeAnswer = { request: request(1, operator, 2n, 8n), entries: [entry(4n, commitment(1n))] };
    const encoded = range.encodeRangeAnswer(answer, wide);
    const others: range.RangeRequest[] = [
      { ...answer.request, venue: b(13) }, { ...answer.request, kind: 2 }, { ...answer.request, subject: other },
      { ...answer.request, fromIndex: 1n }, { ...answer.request, toIndex: 9n },
    ];
    for (const expected of others) expect(() => range.decodeRangeAnswer(encoded, expected, wide)).toThrow(/another request/);
    expect(() => range.decodeRangeAnswer(encoded, { ...answer.request, fromIndex: 9n, toIndex: 8n }, wide)).toThrow(/malformed range request/);
    const reversed = Buffer.from(encoded); reversed.writeBigUInt64BE(9n, 82);
    expect(() => range.decodeRangeAnswer(reversed, { ...answer.request, fromIndex: 9n }, wide)).toThrow(EncodingError);
  });

  it("orders kind-4 entries strictly by (index, ordinal) and kinds 1-3 canonically by record bytes with a zero ordinal", () => {
    const publications: range.RangeAnswer = { request: request(4, backing, 2n, 8n),
      entries: ordered([{ index: 3n, record: Uint8Array.of(1) }, { index: 3n, record: Uint8Array.of(2) }, { index: 8n, record: Uint8Array.of(3) }], 4) };
    const encoded = Buffer.from(range.encodeRangeAnswer(publications, wide));
    const decode = (input: Uint8Array): range.RangeAnswer => range.decodeRangeAnswer(input, publications.request, wide);
    expect(decode(encoded).entries.map(e => [e.index, e.ordinal])).toEqual([[3n, 0n], [3n, 1n], [8n, 0n]]);
    for (const bad of [
      [publications.entries[2]!, publications.entries[0]!, publications.entries[1]!],
      [publications.entries[1]!, publications.entries[0]!, publications.entries[2]!],
      [publications.entries[0]!, publications.entries[0]!],
      [entry(1n, Uint8Array.of(1))], [entry(9n, Uint8Array.of(1))],
    ]) expect(() => range.encodeRangeAnswer({ ...publications, entries: bad }, wide)).toThrow(/out of order/);
    const swapped = Buffer.from(encoded); swapped.writeBigUInt64BE(2n, 102 + 20 + 1);
    expect(() => decode(swapped)).toThrow(/out of order/);
    const sameOrdinal = Buffer.from(encoded); sameOrdinal.writeBigUInt64BE(0n, 102 + 20 + 1 + 8);
    expect(() => decode(sameOrdinal)).toThrow(/out of order/);
    const outside = Buffer.from(encoded); outside.writeBigUInt64BE(9n, encoded.length - 20 - 1);
    expect(() => decode(outside)).toThrow(/out of order, ordinal or range/);
    const below = Buffer.from(encoded); below.writeBigUInt64BE(1n, 102);
    expect(() => decode(below)).toThrow(/out of order, ordinal or range/);
    // A commitment's sequence leads its bytes, so byte order at one index is sequence order; twins sit adjacent.
    const commitments: range.RangeAnswer = { request: request(1, operator, 2n, 8n),
      entries: [entry(3n, commitment(1n)), entry(3n, commitment(1n)), entry(3n, commitment(2n)), entry(8n, commitment(3n))] };
    const canonical = Buffer.from(range.encodeRangeAnswer(commitments, wide));
    expect(range.decodeRangeAnswer(canonical, commitments.request, wide).entries).toHaveLength(4);
    const reordered = { ...commitments, entries: [commitments.entries[2]!, commitments.entries[0]!, commitments.entries[1]!, commitments.entries[3]!] };
    expect(() => range.encodeRangeAnswer(reordered, wide)).toThrow(/out of order/);
    const swappedRecords = Buffer.from(canonical);
    swappedRecords.set(commitment(2n), 102 + 20); swappedRecords.set(commitment(1n), 102 + 20 + 136 + 20 + 136 + 20);
    expect(() => range.decodeRangeAnswer(swappedRecords, commitments.request, wide)).toThrow(/out of order/);
    for (const kind of [1, 2, 3] as const) {
      const subject = kind === 1 ? operator : kind === 3 ? obligor : backing, record = new Uint8Array(range.MAX_RANGE_RECORD_BYTES[kind]);
      expect(() => range.encodeRangeAnswer({ request: request(kind, subject), entries: [entry(3n, record, 1n)] }, wide)).toThrow(/ordinal/);
      const zero = Buffer.from(range.encodeRangeAnswer({ request: request(kind, subject), entries: [entry(3n, record)] }, wide));
      zero.writeBigUInt64BE(1n, 102 + 8);
      expect(() => range.decodeRangeAnswer(zero, request(kind, subject), wide)).toThrow(/ordinal/);
    }
  });

  it("rejects truncated, trailing, impossible-count, wrong-kind, wrong-context and shared frames", () => {
    const answer: range.RangeAnswer = { request: request(1, operator, 2n, 8n),
      entries: [entry(3n, commitment(1n)), entry(3n, commitment(2n)), entry(8n, commitment(3n))] };
    const encoded = Buffer.from(range.encodeRangeAnswer(answer, wide));
    const decode = (input: Uint8Array): range.RangeAnswer => range.decodeRangeAnswer(input, answer.request, wide);
    expect(decode(encoded).entries).toHaveLength(3);
    expect(() => range.encodeRangeAnswer({ ...answer, entries: [entry(3n, new Uint8Array(new SharedArrayBuffer(136)))] }, wide)).toThrow(/shared/);
    for (let cut = 1; cut <= encoded.length; cut += 37) expect(() => decode(encoded.subarray(0, encoded.length - cut))).toThrow(EncodingError);
    expect(() => decode(cat(encoded, Uint8Array.of(0)))).toThrow(/trailing/);
    const count = Buffer.from(encoded); count.writeUInt32BE(4, 98);
    expect(() => decode(count)).toThrow(EncodingError);
    const huge = Buffer.from(encoded); huge.writeUInt32BE(0xffffffff, 98);
    expect(() => decode(huge)).toThrow(range.RangeLimitError);
    const impossible = Buffer.from(encoded); impossible.writeUInt32BE(24, 98);
    expect(() => decode(impossible)).toThrow(/impossible/);
    const kind = Buffer.from(encoded); kind[49] = 5;
    expect(() => decode(kind)).toThrow(/unsupported/);
    const context = Buffer.from(encoded); context[0] = context[0]! ^ 1;
    expect(() => decode(context)).toThrow(/context/);
    expect(() => decode(new Uint8Array(new SharedArrayBuffer(encoded.length)))).toThrow(/shared/);
    expect(() => range.decodeRangeAnswer(encoded, { ...answer.request, venue: new Uint8Array(new SharedArrayBuffer(32)) }, wide)).toThrow(EncodingError);
  });

  it("applies exact byte and entry budgets before allocating or copying records", () => {
    const answer: range.RangeAnswer = { request: request(4, backing), entries: [entry(1n, new Uint8Array(500)), entry(2n, new Uint8Array(0))] };
    const size = BigInt(102 + 20 + 500 + 20);
    const encoded = range.encodeRangeAnswer(answer, { maxBytes: size, maxEntries: 2n });
    expect(BigInt(encoded.length)).toBe(size);
    expect(() => range.encodeRangeAnswer(answer, { maxBytes: size - 1n, maxEntries: 2n })).toThrow(range.RangeLimitError);
    expect(() => range.encodeRangeAnswer(answer, { maxBytes: size, maxEntries: 1n })).toThrow(range.RangeLimitError);
    expect(() => range.decodeRangeAnswer(encoded, answer.request, { maxBytes: size - 1n, maxEntries: 2n })).toThrow(range.RangeLimitError);
    expect(() => range.decodeRangeAnswer(encoded, answer.request, { maxBytes: size, maxEntries: 1n })).toThrow(range.RangeLimitError);
    const original = Uint8Array.prototype.slice;
    let copies = 0;
    Uint8Array.prototype.slice = function (this: Uint8Array, ...args: [number?, number?]) { copies += 1; return original.apply(this, args); };
    try {
      expect(() => range.decodeRangeAnswer(encoded, answer.request, { maxBytes: size, maxEntries: 1n })).toThrow(range.RangeLimitError);
      const count = Buffer.from(encoded); count.writeUInt32BE(3, 98);
      expect(() => range.decodeRangeAnswer(count, answer.request, { maxBytes: size, maxEntries: 3n })).toThrow(EncodingError);
      expect(copies).toBe(0);
    } finally { Uint8Array.prototype.slice = original; }
    const empty: range.RangeAnswer = { request: request(3, obligor), entries: [] };
    expect(range.decodeRangeAnswer(range.encodeRangeAnswer(empty, { maxBytes: 102n, maxEntries: 0n }), empty.request,
      { maxBytes: 102n, maxEntries: 0n }).entries).toEqual([]);
    expect(() => range.encodeRangeAnswer(empty, { maxBytes: 101n, maxEntries: 0n })).toThrow(range.RangeLimitError);
  });

  it("owns decoded records and requests: later mutation of the input changes nothing", () => {
    const answer: range.RangeAnswer = { request: request(1, operator), entries: [entry(2n, commitment(1n))] };
    const storage = new Uint8Array(4096), encoded = range.encodeRangeAnswer(answer, wide);
    storage.set(encoded, 100);
    const viewed = storage.subarray(100, 100 + encoded.length), expected = { ...answer.request, venue: Buffer.from(venue) };
    const decoded = range.decodeRangeAnswer(viewed, expected, wide);
    storage.fill(0); expected.venue.fill(0);
    expect(values(decoded)).toEqual(values(answer));
    expect(decoded.entries[0]!.record.buffer.byteLength).toBe(136);
    expect(decoded.request.venue.buffer.byteLength).toBe(32);
    expect(Object.isFrozen(decoded) && Object.isFrozen(decoded.entries) && Object.isFrozen(decoded.entries[0])).toBe(true);
  });

  it("merges several backings' publication answers into the venue's order and refuses mixed ranges or shared positions", () => {
    const a: range.RangeAnswer = { request: request(4, backing, 0n, 9n), entries: [entry(2n, Uint8Array.of(1), 4n), entry(5n, Uint8Array.of(2), 0n)] };
    const c: range.RangeAnswer = { request: request(4, b(18), 0n, 9n), entries: [entry(2n, Uint8Array.of(3), 1n), entry(2n, Uint8Array.of(4), 9n), entry(5n, Uint8Array.of(5), 2n)] };
    const merged = range.mergeVenueOrder([a, c]);
    expect(merged.map(e => [e.index, e.ordinal, e.record[0], e.subject[0]])).toEqual([[2n, 1n, 3, 18], [2n, 4n, 1, 17], [2n, 9n, 4, 18], [5n, 0n, 2, 17], [5n, 2n, 5, 18]]);
    expect(Object.isFrozen(merged) && Object.isFrozen(merged[0])).toBe(true);
    const shared: range.RangeAnswer = { request: request(4, b(19), 0n, 9n), entries: [entry(2n, Uint8Array.of(6), 4n)] };
    expect(() => range.mergeVenueOrder([a, shared])).toThrow(/one venue position/);
    expect(() => range.mergeVenueOrder([a, { ...c, request: { ...c.request, toIndex: 8n } }])).toThrow(/different venues or ranges/);
    expect(() => range.mergeVenueOrder([a, { ...c, request: { ...c.request, venue: b(13) } }])).toThrow(/different venues or ranges/);
    expect(() => range.mergeVenueOrder([a, { request: request(1, operator, 0n, 9n), entries: [] }])).toThrow(/wrong range kind/);
    const commitments: range.RangeAnswer = { request: request(1, operator, 0n, 9n), entries: [entry(3n, commitment(1n)), entry(3n, commitment(2n))] };
    expect(() => range.mergeVenueOrder([commitments])).toThrow(/wrong range kind/);
    expect(() => range.mergeVenueOrder([])).toThrow(/no range answers/);
  });
});

describe("v3 held commitments from record ranges", () => {
  const answerFor = (entries: { index: bigint; record: Uint8Array }[], fromIndex = 0n, toIndex = 20n): range.RangeAnswer => {
    const answer = { request: request(1, operator, fromIndex, toIndex), entries: ordered(entries) };
    // Every derivation input here is a frame-canonical answer.
    expect(() => range.encodeRangeAnswer(answer, wide)).not.toThrow();
    return answer;
  };
  const sequences = (result: range.HeldCommitments): [bigint, bigint][] => result.held.map(x => [x.index, x.commitment.sequence]);

  it("holds every verifying sequence above the earlier indices' highest, in ascending order within an index", () => {
    const result = range.heldCommitments(answerFor([
      { index: 1n, record: commitment(3n) },
      { index: 4n, record: commitment(7n) }, { index: 4n, record: commitment(5n) },
      { index: 4n, record: commitment(6n) }, { index: 4n, record: commitment(2n) },
      { index: 9n, record: commitment(7n) },
      { index: 12n, record: commitment(9n) },
    ]));
    expect(sequences(result)).toEqual([[1n, 3n], [4n, 5n], [4n, 6n], [4n, 7n], [12n, 9n]]);
    expect(result.next).toEqual({ fromIndex: 21n, highest: 9n });
    expect(Buffer.from(result.held[0]!.commitment.root)).toEqual(b(63));
    expect(Object.isFrozen(result.held[0]!.commitment)).toBe(true);
  });

  it("disregards records that do not decode, do not verify or name another operator, without treating them as holes", () => {
    const forged = Buffer.from(commitment(4n)); forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
    const result = range.heldCommitments(answerFor([
      { index: 2n, record: commitment(2n) },
      { index: 3n, record: new Uint8Array(136).fill(9) },
      { index: 3n, record: new Uint8Array(136) },
      { index: 3n, record: forged },
      { index: 3n, record: commitment(5n, otherSecret) },
      { index: 5n, record: commitment(4n) },
      { index: 5n, record: commitment(4n) },
    ]));
    expect(sequences(result)).toEqual([[2n, 2n], [5n, 4n]]);
  });

  it("stands one record for one sequence at one index by the lesser record bytes and refuses non-canonical answers", () => {
    const first = commitment(3n, operatorSecret, b(70)), second = commitment(3n, operatorSecret, b(71));
    expect(Buffer.compare(first, second)).toBe(-1);
    const result = range.heldCommitments(answerFor([{ index: 6n, record: second }, { index: 6n, record: first }]));
    expect(sequences(result)).toEqual([[6n, 3n]]);
    expect(Buffer.from(encodeCommitment(result.held[0]!.commitment))).toEqual(Buffer.from(first));
    // An in-memory answer that breaks the frame's order or range is refused before any rule reads it.
    const req = request(1, operator);
    expect(() => range.heldCommitments({ request: req, entries: [entry(6n, second), entry(6n, first)] })).toThrow(/out of order/);
    expect(() => range.heldCommitments({ request: req, entries: [entry(9n, commitment(5n)), entry(3n, commitment(2n))] })).toThrow(/out of order/);
    expect(() => range.heldCommitments({ request: request(1, operator, 10n, 20n), entries: [entry(3n, commitment(2n))] }, { fromIndex: 10n, highest: 1n })).toThrow(/range/);
    expect(() => range.heldCommitments({ request: req, entries: [{ index: 3n, ordinal: 0n, record: [1, 2] as unknown as Uint8Array }] })).toThrow(EncodingError);
    expect(() => range.revocationIndex({ request: request(3, obligor, 10n, 20n), entries: [entry(0n, encodeRevocation(signRevocation(obligorSecret)))] })).toThrow(/range/);
  });

  it("anchors later answers on the reader's own prior: the adjacent answer's highest or a held commitment at the start index", () => {
    const first = range.heldCommitments(answerFor([{ index: 3n, record: commitment(2n) }, { index: 10n, record: commitment(4n) }], 0n, 10n));
    expect(first.next).toEqual({ fromIndex: 11n, highest: 4n });
    const adjacent = range.heldCommitments(answerFor([
      { index: 11n, record: commitment(1n) }, { index: 11n, record: commitment(4n) }, { index: 15n, record: commitment(5n) },
    ], 11n, 20n), first.next);
    expect(sequences(adjacent)).toEqual([[15n, 5n]]);
    // Anchored on the held commitment 4 at index 10: lower sequences at 10 are its own prefix.
    const anchored = range.heldCommitments(answerFor([
      { index: 10n, record: commitment(3n) }, { index: 10n, record: commitment(4n) }, { index: 10n, record: commitment(6n) },
      { index: 15n, record: commitment(5n) }, { index: 15n, record: commitment(7n) },
    ], 10n, 20n), { fromIndex: 10n, highest: 4n });
    expect(sequences(anchored)).toEqual([[10n, 6n], [15n, 7n]]);
    expect(anchored.next).toEqual({ fromIndex: 21n, highest: 7n });
    const later = answerFor([{ index: 12n, record: commitment(1n) }], 11n, 20n);
    expect(() => range.heldCommitments(later)).toThrow(/held prior/);
    expect(() => range.heldCommitments(later, { fromIndex: 10n, highest: 2n })).toThrow(/held prior/);
    expect(() => range.heldCommitments(later, { fromIndex: 12n, highest: 2n })).toThrow(/held prior/);
    expect(() => range.heldCommitments(answerFor([], 0n, 5n), { fromIndex: 0n, highest: 0n })).toThrow(/index zero/);
    expect(range.heldCommitments(answerFor([], 0n, 5n)).next).toEqual({ fromIndex: 6n, highest: 0n });
    expect(() => range.heldCommitments({ request: request(2, backing), entries: [] })).toThrow(/wrong range kind/);
  });
});

describe("v3 revocation and replacement records from ranges", () => {
  it("reads a revocation at its first verifying entry and none from junk or another key", () => {
    const record = encodeRevocation(signRevocation(obligorSecret));
    const forged = Buffer.from(record); forged[40] = forged[40]! ^ 1;
    const answer: range.RangeAnswer = { request: request(3, obligor), entries: ordered([
      { index: 2n, record: forged }, { index: 2n, record: encodeRevocation(signRevocation(otherSecret)) },
      { index: 6n, record: record }, { index: 9n, record: record },
    ]) };
    expect(range.revocationIndex(answer)).toBe(6n);
    expect(range.revocationIndex({ ...answer, entries: answer.entries.slice(0, 2) })).toBeUndefined();
    expect(range.revocationIndex({ request: request(3, obligor), entries: [] })).toBeUndefined();
    expect(() => range.revocationIndex({ request: request(1, operator), entries: [] })).toThrow(/wrong range kind/);
  });

  it("admits replacements only under the declared rule key and successor, one identity at its first entry", () => {
    const good = replacement(30n), unsigned = replacement(31n, otherSecret, b(43)), wrongBacking = replacement(32n);
    const otherName = Buffer.from(wrongBacking.record); otherName.set(b(18), 0);
    const roleless = Buffer.from(good.record); roleless[32] = 2;
    // Ed25519 signatures are deterministic, so one identity recurs as identical bytes; it counts once.
    const twinFirst = Buffer.from(good.record); twinFirst.set(ed25519.sign(replacementMessage(backing, good.replacement), b(44)), 169);
    const answer: range.RangeAnswer = { request: request(2, backing), entries: ordered([
      { index: 1n, record: unsigned.record }, { index: 2n, record: otherName }, { index: 2n, record: roleless },
      { index: 2n, record: twinFirst },
      { index: 3n, record: good.record }, { index: 3n, record: new Uint8Array(233) }, { index: 7n, record: good.record },
    ]) };
    const admitted = range.admittedReplacements(answer, rule);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.index).toBe(3n);
    expect(Buffer.from(admitted[0]!.identity)).toEqual(sha(replacementMessage(backing, good.replacement)));
    expect(values(admitted[0]!.replacement)).toEqual(values(good.replacement));
    expect(range.admittedReplacements(answer, undefined)).toEqual([]);
    expect(range.admittedReplacements(answer, otherName.subarray(0, 32))).toEqual([]);
    expect(range.firstWitnessed(answer).map(e => e.index)).toEqual([1n, 2n, 2n, 2n, 3n, 3n]);
    expect(() => range.admittedReplacements({ request: request(4, backing), entries: [] }, rule)).toThrow(/wrong range kind/);
  });
});
