import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import * as h from "../model/pool-v3-headers.js";
import { snapshotDigest, type Snapshot } from "../model/pool-v3-commitments.js";
import { ByteReader, EncodingError } from "../src/bytes.js";
import { directoryRoot, signCommitment, verifyCommitment } from "../src/commitment.js";
import { segmentBytes as v2Bytes, decodeSegmentHeader as decodeV2 } from "../src/pool/statement.js";

// Independent wire/hash oracle; domains, roots and links are synthetic.
// Real signatures authenticate assertions, not a replayed or finalized state.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const sha = (bytes: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha256").update(bytes).digest());
const secret = b(7), operator = ed25519.getPublicKey(secret), other = ed25519.getPublicKey(b(11));
const max = (1n << 64n) - 1n;
function header(): h.SegmentHeader {
  return { domain: b(1), venue: b(2), operator, sequence: 3n, entries: [
    { backing: b(3), link: b(4) },
    { backing: b(5), link: b(6), opening: { sequence: 2n, operator, root: b(8) } },
    { backing: b(9), link: b(10), opening: { sequence: max, operator: other, root: b(12) } },
  ] };
}
function raw(x: h.SegmentHeader): Buffer {
  return cat(Buffer.from("moe/pool/v3/segment"), x.domain, x.venue, x.operator, integer(x.sequence, 8),
    integer(BigInt(x.entries.length), 4), ...x.entries.map(e => cat(e.backing, e.link,
      e.opening ? cat(integer(e.opening.sequence, 8), e.opening.operator, e.opening.root) : new Uint8Array(72))));
}
function entryHeader(entry: h.SegmentEntry): h.SegmentHeader { return { ...header(), entries: [entry] }; }
const eq = (a: Uint8Array, c: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(c));

describe("v3 canonical segment headers", () => {
  it("matches independent bytes and SHA256 for empty, own and other-operator openings", () => {
    const x = header(), bytes = raw(x);
    expect(bytes.length).toBe(127 + 136 * 3);
    expect(Buffer.from(h.segmentBytes(x))).toEqual(bytes);
    expect(h.segmentIdentity(x)).toEqual(sha(bytes));
    expect(h.decodeSegmentHeader(Uint8Array.from(bytes))).toEqual(x);
    expect(h.segmentBytes(h.decodeSegmentHeader(bytes))).toEqual(h.segmentBytes(x));
    expect(h.segmentBytes(entryHeader(x.entries[0]!)).length).toBe(263);
  });

  it("binds every header and opening field and distinguishes v2", () => {
    const x = header(), original = h.segmentIdentity(x);
    const variants: h.SegmentHeader[] = [
      ...(["domain", "venue", "operator"] as const).map(key => ({ ...x, [key]: b(19) })),
      { ...x, sequence: 4n }, { ...x, entries: x.entries.slice(1) },
      ...(["backing", "link"] as const).map(key => ({ ...x, entries: [
        { ...x.entries[0]!, [key]: b(key === "backing" ? 2 : 21) }, ...x.entries.slice(1),
      ] })),
      ...[{ sequence: 1n }, { operator: other }, { root: b(23) }].map(change => ({ ...x, entries: [
        x.entries[0]!, { ...x.entries[1]!, opening: { ...x.entries[1]!.opening!, ...change } }, x.entries[2]!,
      ] })),
    ];
    for (const variant of variants) {
      expect(h.isWellFormedHeader(variant)).toBe(true);
      expect(h.segmentIdentity(variant)).not.toEqual(original);
    }
    const old = v2Bytes(x);
    expect(Buffer.from(old.subarray(19))).toEqual(raw(x).subarray(19));
    expect(sha(old)).not.toEqual(original);
    expect(() => h.decodeSegmentHeader(old)).toThrow(EncodingError);
    expect(() => decodeV2(h.segmentBytes(x))).toThrow(EncodingError);
  });

  it("rejects every truncated prefix, extra bytes and a mutated context", () => {
    const bytes = raw(header());
    for (let i = 0; i < bytes.length; i++) expect(() => h.decodeSegmentHeader(bytes.subarray(0, i))).toThrow(EncodingError);
    expect(() => h.decodeSegmentHeader(cat(bytes, new Uint8Array(1)))).toThrow(EncodingError);
    bytes[0] = bytes[0]! ^ 1;
    expect(() => h.decodeSegmentHeader(bytes)).toThrow(EncodingError);
  });

  it.each([0, 1, 2, 4, 65536, 65537, 0xffffffff])("rejects mismatched count %i before reading entries", count => {
    const bytes = raw(header()); bytes.writeUInt32BE(count, 123);
    const reads = vi.spyOn(ByteReader.prototype, "raw");
    try {
      expect(() => h.decodeSegmentHeader(bytes)).toThrow(EncodingError);
      expect(reads.mock.calls.map(call => call[0])).toEqual([19, 32, 32, 32]);
    } finally { reads.mockRestore(); }
  });

  it("accepts the maximum canonical scope and rejects one beyond the byte bound", () => {
    const entries = Array.from({ length: 65536 }, (_, i) => ({ backing: integer(BigInt(i), 32), link: b(1) }));
    const x = { ...header(), entries }, bytes = raw(x);
    expect(bytes.length).toBe(8913023);
    expect(h.MAX_HEADER_BYTES).toBe(bytes.length);
    expect(eq(h.segmentBytes(x), bytes)).toBe(true);
    const decoded = h.decodeSegmentHeader(bytes);
    expect(decoded.entries.length).toBe(65536);
    expect(eq(decoded.entries[65535]!.backing, entries[65535]!.backing)).toBe(true);
    expect(eq(decoded.entries[65535]!.link, entries[65535]!.link)).toBe(true);
    expect(eq(h.segmentBytes(decoded), bytes)).toBe(true);
    expect(() => h.decodeSegmentHeader(cat(bytes, new Uint8Array(1)))).toThrow(EncodingError);
    expect(h.isWellFormedHeader({ ...x, entries: [...entries, { backing: integer(65536n, 32), link: b(1) }] })).toBe(false);
  });

  it("rejects duplicate and descending scopes without sorting them", () => {
    const x = header();
    for (const entries of [[...x.entries].reverse(), [x.entries[0]!, { ...x.entries[1]!, backing: x.entries[0]!.backing }]]) {
      const invalid = { ...x, entries };
      expect(h.isWellFormedHeader(invalid)).toBe(false);
      expect(() => h.segmentBytes(invalid)).toThrow(EncodingError);
      expect(() => h.decodeSegmentHeader(raw(invalid))).toThrow(EncodingError);
    }
  });

  it("enforces the sole empty sentinel without treating positive zero references as empty", () => {
    const x = entryHeader(header().entries[0]!), canonical = raw(x);
    for (const offset of [127 + 72, 127 + 104]) {
      const changed = Buffer.from(canonical); changed[offset] = 1;
      expect(() => h.decodeSegmentHeader(changed)).toThrow(EncodingError);
    }
    const positive = { ...x.entries[0]!, opening: { sequence: 1n, operator: b(0), root: b(0) } };
    expect(h.decodeSegmentHeader(Uint8Array.from(raw(entryHeader(positive)))).entries[0]!.opening).toEqual(positive.opening);
    // Invalid key bytes remain parsed data; this does not authenticate a commitment.
    expect(h.isWellFormedHeader({ ...x, operator: b(0) })).toBe(true);
  });

  it("enforces own-operator ordering without comparing different operators' counters", () => {
    const e = header().entries[1]!;
    for (const sequence of [0n, 3n, 4n, max]) {
      const x = entryHeader({ ...e, opening: { ...e.opening!, sequence } });
      expect(() => h.segmentBytes(x)).toThrow(EncodingError);
      expect(() => h.decodeSegmentHeader(raw(x))).toThrow(EncodingError);
    }
    expect(h.isWellFormedHeader({ ...header(), sequence: max })).toBe(true);
    expect(h.isWellFormedHeader(entryHeader(header().entries[2]!))).toBe(true);
  });

  it("refuses malformed JS objects, sparse arrays, widths and bigint ranges", () => {
    const x = header(), e = x.entries[1]!;
    const invalid: unknown[] = [undefined, null, "header", {}, { ...x, entries: [] }, { ...x, entries: new Array(1) },
      { ...x, entries: [null] }, { ...x, entries: [e, , e] },
      ...[0n, -1n, max + 1n, 3, "3", undefined].map(sequence => ({ ...x, sequence })),
      ...(["domain", "venue", "operator"] as const).flatMap(key => [undefined, "x".repeat(32), b(1).subarray(1),
        new Uint8Array(33), new Uint8ClampedArray(32)].map(value => ({ ...x, [key]: value }))),
      ...(["backing", "link"] as const).map(key => entryHeader({ ...e, [key]: b(1).subarray(1) })),
      ...[null, {}, { ...e.opening, sequence: 2 }, { ...e.opening, sequence: max + 1n },
        { ...e.opening, operator: "x".repeat(32) }, { ...e.opening, root: new Uint8Array(33) }]
        .map(opening => ({ ...x, entries: [{ ...e, opening }] })),
    ];
    for (const value of invalid) {
      expect(h.isWellFormedHeader(value)).toBe(false);
      expect(() => h.segmentBytes(value as h.SegmentHeader)).toThrow(EncodingError);
      expect(() => h.segmentIdentity(value as h.SegmentHeader)).toThrow(EncodingError);
    }
    for (const value of [undefined, null, "x".repeat(263), new Uint8ClampedArray(263)]) {
      expect(() => h.decodeSegmentHeader(value as unknown as Uint8Array)).toThrow(EncodingError);
    }
  });

  it("owns all byte fields across encoding, Buffer decoding and repeated calls", () => {
    const x = header(), encoded = h.segmentBytes(x), input = Buffer.from(encoded);
    const decoded = h.decodeSegmentHeader(input), baseline = h.segmentBytes(decoded);
    input.fill(0); x.domain.fill(99); x.entries[1]!.opening!.root.fill(99);
    expect(h.segmentBytes(decoded)).toEqual(baseline);
    expect(encoded).toEqual(baseline);
    const another = h.decodeSegmentHeader(encoded);
    for (const field of [decoded.domain, decoded.venue, decoded.operator, ...decoded.entries.flatMap(e =>
      [e.backing, e.link, ...(e.opening ? [e.opening.operator, e.opening.root] : [])])]) field.fill(88);
    expect(h.segmentBytes(another)).toEqual(baseline);
    expect(Object.isFrozen(another.entries)).toBe(true);
  });

  it("authenticates the header through a signed directory and rejects substitutions", () => {
    const x = header();
    const snapshots: Snapshot[] = x.entries.map(e => ({ backing: e.backing, segment: sha(raw(x)),
      historyHash: b(31), evidenceHash: b(37), issued: 10n, burned: 0n }));
    const directory = snapshots.map(s => ({ name: s.backing, digest: snapshotDigest(s) }));
    const commitment = signCommitment(secret, x.sequence, directoryRoot(directory));
    expect(verifyCommitment(commitment)).toBe(true);
    expect(eq(commitment.operator, x.operator)).toBe(true);
    expect(eq(commitment.root, directoryRoot(directory))).toBe(true);
    expect(snapshots.every(s => eq(s.segment, h.segmentIdentity(h.decodeSegmentHeader(raw(x)))))).toBe(true);
    for (const changed of [{ ...x, venue: b(41) }, { ...x, entries: [x.entries[0]!] },
      { ...x, entries: [{ ...x.entries[0]!, link: b(43) }, ...x.entries.slice(1)] }]) {
      const supplied = h.decodeSegmentHeader(raw(changed));
      expect(snapshots.some(s => eq(s.segment, h.segmentIdentity(supplied)))).toBe(false);
      const substituted = snapshots.map(s => ({ name: s.backing, digest: snapshotDigest({ ...s, segment: h.segmentIdentity(supplied) }) }));
      expect(eq(directoryRoot(substituted), commitment.root)).toBe(false);
    }
    // Header references alone provide no imported trail, witnessed record or
    // complete opening verdict; no codec API grants one from these assertions.
  });
});
