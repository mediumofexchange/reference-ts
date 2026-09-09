import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import * as trailCodec from "../model/pool-v3-trail.js";
import type { Snapshot } from "../model/pool-v3-commitments.js";
import type { SegmentEntry, SegmentHeader } from "../model/pool-v3-headers.js";
import type { Record as PoolRecord } from "../model/pool-v3-records.js";
import { ByteReader, EncodingError } from "../src/bytes.js";
import { directoryRoot, signCommitment, verifyCommitment } from "../src/commitment.js";

// Independent Buffer/node:crypto framing and hash oracle. The directory is
// genuinely signed; synthetic proofs, terms and roots make no replay claim.
const ascii = (name: string): Buffer => Buffer.from(`moe/pool/v3/${name}`, "ascii");
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const u32 = (n: number): Buffer => integer(BigInt(n), 4);
const sha = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const b = (n: number): Buffer => Buffer.alloc(32, n);
const zero = (): Buffer => Buffer.alloc(32);
const maxU64 = (1n << 64n) - 1n;
const domain = b(11), venue = b(13), backing = b(17), otherBacking = b(23);
const operatorSecret = b(29), operator = ed25519.getPublicKey(operatorSecret), otherOperator = ed25519.getPublicKey(b(31));
const backerSecret = b(37), sourceSegment = b(41), demand = b(43);

function values(value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(values);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, values(item)]));
  }
  return value;
}
function limbs(bytes: Uint8Array): [bigint, bigint] {
  return [0, 16].map(start => BigInt(`0x${Buffer.from(bytes.subarray(start, start + 16)).toString("hex")}`)) as [bigint, bigint];
}
function rawHeader(entries?: readonly SegmentEntry[]): Buffer {
  const scope = entries ?? [
    { backing, link: b(47) },
    { backing: otherBacking, link: b(53), opening: { sequence: maxU64, operator: otherOperator, root: b(59) } },
  ];
  return cat(ascii("segment"), domain, venue, operator, integer(7n, 8), u32(scope.length),
    ...scope.map(entry => cat(entry.backing, entry.link, entry.opening
      ? cat(integer(entry.opening.sequence, 8), entry.opening.operator, entry.opening.root)
      : Buffer.alloc(72))));
}
interface RawRecord {
  readonly bytes: Buffer;
  readonly statement: Buffer;
  readonly proof: Uint8Array;
  readonly authorization: Uint8Array;
}
function rawStatement(kind: number, inputs: readonly bigint[]): Buffer {
  return cat(ascii("statement"), domain, Uint8Array.of(kind), u32(inputs.length), ...inputs.map(value => integer(value, 32)));
}
function rawRecord(kind: number, inputs: readonly bigint[], proof: Uint8Array,
  authorization: Uint8Array, capsules: readonly Uint8Array[]): RawRecord {
  const statement = rawStatement(kind, inputs);
  return { statement, proof, authorization,
    bytes: cat(statement, u32(proof.length), proof, u32(authorization.length), authorization,
      u32(capsules.length), ...capsules) };
}
function issueRecord(source = sourceSegment, capsuleFill = 61): RawRecord {
  const capsule = Uint8Array.from([1, ...Array(88).fill(capsuleFill)]);
  const delivery = sha(cat(ascii("delivery"), domain, u32(1), integer(67n, 32), capsule));
  const inputs = [...limbs(domain), ...limbs(source), 71n, ...limbs(backing), 5n, 67n, ...limbs(delivery)];
  const statement = rawStatement(1, inputs);
  return rawRecord(1, inputs, b(73), ed25519.sign(statement, backerSecret), [capsule]);
}
function withdrawalRecord(source = sourceSegment): RawRecord {
  return rawRecord(5, [...limbs(domain), ...limbs(source), 79n, ...limbs(demand)],
    new Uint8Array(0), Buffer.alloc(64, 83), []);
}
function kindSevenRecord(): RawRecord {
  return rawRecord(7, [...limbs(domain), ...limbs(backing), 89n, 97n, 0n], b(101), new Uint8Array(0), []);
}
function evidenceTriple(record: RawRecord): { statementHash: Buffer; proofHash: Buffer; signatureHash: Buffer } {
  return { statementHash: sha(record.statement), proofHash: record.proof.length ? sha(record.proof) : zero(),
    signatureHash: record.authorization.length ? sha(record.authorization) : zero() };
}
function evidenceLink(previous: Uint8Array, record: RawRecord, position: bigint): Buffer {
  const triple = evidenceTriple(record);
  return sha(cat(ascii("evidence-link"), previous, triple.statementHash, triple.proofHash,
    triple.signatureHash, integer(position, 8)));
}
function rawSnapshot(snapshot: Snapshot): Buffer {
  return cat(ascii("snapshot"), snapshot.backing, snapshot.segment, snapshot.historyHash,
    snapshot.evidenceHash, integer(snapshot.issued, 8), integer(snapshot.burned, 8));
}
function rawTrail(served: trailCodec.ServedTrail): Buffer {
  return cat(ascii("trail"), u32(served.header.length), served.header,
    ...served.terms.map(term => cat(u32(term.terms.length), term.terms, term.signature)),
    integer(BigInt(served.records.length), 8), ...served.records.map(record => cat(u32(record.length), record)));
}
function offsets(served: trailCodec.ServedTrail): { termLengths: number[]; eventCount: number; recordLengths: number[] } {
  let offset = ascii("trail").length + 4 + served.header.length;
  const termLengths: number[] = [];
  for (const term of served.terms) { termLengths.push(offset); offset += 4 + term.terms.length + 64; }
  const eventCount = offset; offset += 8;
  const recordLengths: number[] = [];
  for (const record of served.records) { recordLengths.push(offset); offset += 4 + record.length; }
  return { termLengths, eventCount, recordLengths };
}
function fixture(records: readonly RawRecord[] = [issueRecord(), withdrawalRecord()], header = rawHeader()) {
  const segment = sha(header);
  let evidence = sha(cat(ascii("evidence-seed"), segment));
  records.forEach((record, index) => { evidence = evidenceLink(evidence, record, BigInt(index + 1)); });
  // These totals are deliberately invalid state. Evidence authentication does
  // not replay them or turn the result into a valid checkpoint.
  const snapshot: Snapshot = { backing, segment, historyHash: b(103), evidenceHash: evidence, issued: 3n, burned: 5n };
  const directory = [{ name: backing, digest: sha(rawSnapshot(snapshot)) }];
  const commitment = signCommitment(operatorSecret, 7n, directoryRoot(directory));
  const served: trailCodec.ServedTrail = {
    header: Uint8Array.from(header),
    terms: Array.from({ length: header.readUInt32BE(123) }, (_, index) => ({
      terms: index === 0 ? Uint8Array.of(107, 109, 113) : new Uint8Array(0),
      signature: index === 0 ? ed25519.sign(Uint8Array.of(107, 109, 113), backerSecret) : Buffer.alloc(64, 127),
    })),
    records: records.map(record => Uint8Array.from(record.bytes)),
  };
  return { records, snapshot, directory, commitment, served,
    expected: { backing: directory[0]!.name, segment, digest: directory[0]!.digest },
    limits: { maxBytes: BigInt(rawTrail(served).length), maxEvents: BigInt(records.length) } };
}

describe("v3 served-trail transport", () => {
  it("matches independent bytes and authenticates ordered evidence from a real signed directory", () => {
    const x = fixture(), expectedBytes = rawTrail(x.served);
    expect(expectedBytes.length).toBe(29 + x.served.header.length
      + x.served.terms.reduce((sum, term) => sum + 68 + term.terms.length, 0)
      + x.served.records.reduce((sum, record) => sum + 4 + record.length, 0));
    expect(Buffer.from(trailCodec.encodeTrail(x.served, x.limits))).toEqual(expectedBytes);
    expect(values(trailCodec.decodeTrail(expectedBytes, x.limits))).toEqual(values(x.served));
    expect(Buffer.from(trailCodec.encodeTrail(trailCodec.decodeTrail(expectedBytes, x.limits), x.limits))).toEqual(expectedBytes);
    expect(verifyCommitment(x.commitment)).toBe(true);
    expect(x.commitment.operator).toEqual(operator);
    expect(x.commitment.root).toEqual(directoryRoot(x.directory));
    expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, x.served, x.limits)).toBe(true);
  });

  it("binds record order, proof, authorization and capsules but grants no authority to terms", () => {
    const x = fixture(), [first, second] = x.served.records;
    expect(first).toBeDefined(); expect(second).toBeDefined();
    const variants: trailCodec.ServedTrail[] = [
      { ...x.served, records: [first!] },
      { ...x.served, records: [second!, first!] },
      { ...x.served, records: [Uint8Array.from(first!, (value, index) => index === x.records[0]!.statement.length + 4 ? value ^ 1 : value), second!] },
      { ...x.served, records: [first!, Uint8Array.from(second!, (value, index) => index === x.records[1]!.statement.length + 8 ? value ^ 1 : value)] },
      { ...x.served, records: [Uint8Array.from(first!, (value, index) => index === first!.length - 1 ? value ^ 1 : value), second!] },
      { ...x.served, records: [issueRecord(sourceSegment, 62).bytes, second!] },
    ];
    for (const changed of variants) {
      expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, changed, x.limits)).toBe(false);
    }
    const changedTerms = x.served.terms.map(term => ({ terms: Uint8Array.from(term.terms, value => value ^ 0xff),
      signature: Uint8Array.from(term.signature, value => value ^ 0xff) }));
    expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, { ...x.served, terms: changedTerms }, x.limits)).toBe(true);
  });

  it("returns false for malformed inner records while preserving their opaque outer bytes", () => {
    const x = fixture(), malformed = Uint8Array.of(0xff, 0, 7);
    const carried = { ...x.served, records: [malformed] };
    const limits = { maxBytes: BigInt(rawTrail(carried).length), maxEvents: 1n };
    const decoded = trailCodec.decodeTrail(rawTrail(carried), limits);
    expect(Buffer.from(decoded.records[0]!)).toEqual(Buffer.from(malformed));
    expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, carried, limits)).toBe(false);
    const maximum = new Uint8Array(trailCodec.MAX_TRAIL_RECORD_BYTES);
    const atLimit = { ...x.served, records: [maximum] };
    const maxLimits = { maxBytes: BigInt(rawTrail(atLimit).length), maxEvents: 1n };
    expect(trailCodec.decodeTrail(trailCodec.encodeTrail(atLimit, maxLimits), maxLimits).records[0]!.length)
      .toBe(trailCodec.MAX_TRAIL_RECORD_BYTES);
    expect(() => trailCodec.encodeTrail({ ...atLimit, records: [new Uint8Array(trailCodec.MAX_TRAIL_RECORD_BYTES + 1)] },
      { ...maxLimits, maxBytes: maxLimits.maxBytes + 1n })).toThrow(EncodingError);
  });

  it("authenticates zero events without treating nonempty imports or invalid totals as empty state", () => {
    const imported: SegmentEntry = { backing, link: b(47),
      opening: { sequence: maxU64, operator: otherOperator, root: b(131) } };
    const x = fixture([], rawHeader([imported]));
    expect(x.snapshot.evidenceHash).toEqual(sha(cat(ascii("evidence-seed"), x.expected.segment)));
    expect(x.served.records).toHaveLength(0);
    expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, x.served, x.limits)).toBe(true);
    expect(trailCodec.verifyTrailEvidence(x.expected, { ...x.snapshot, evidenceHash: b(137) }, x.served, x.limits)).toBe(false);
    const absent = fixture([], rawHeader([{ backing: otherBacking, link: b(139) }]));
    expect(trailCodec.verifyTrailEvidence(absent.expected, absent.snapshot, absent.served, absent.limits)).toBe(false);
    for (const expected of [{ ...x.expected, backing: otherBacking }, { ...x.expected, segment: b(149) },
      { ...x.expected, digest: b(151) }]) {
      expect(trailCodec.verifyTrailEvidence(expected, x.snapshot, x.served, x.limits)).toBe(false);
    }
    for (const snapshot of [{ ...x.snapshot, backing: otherBacking }, { ...x.snapshot, segment: b(157) }]) {
      expect(trailCodec.verifyTrailEvidence(x.expected, snapshot, x.served, x.limits)).toBe(false);
    }
  });

  it("retains adopted source binding and can authenticate kind 7 without declaring valid replay", () => {
    const adopted = fixture([issueRecord(sourceSegment)]);
    expect(sourceSegment).not.toEqual(adopted.expected.segment);
    expect(trailCodec.verifyTrailEvidence(adopted.expected, adopted.snapshot, adopted.served, adopted.limits)).toBe(true);
    const substituted = fixture([issueRecord(b(149))]);
    expect(trailCodec.verifyTrailEvidence(adopted.expected, adopted.snapshot, substituted.served, substituted.limits)).toBe(false);

    const kindSeven = fixture([kindSevenRecord()]);
    expect(trailCodec.verifyTrailEvidence(kindSeven.expected, kindSeven.snapshot, kindSeven.served, kindSeven.limits)).toBe(true);
    // True here authenticates committed bytes only; kind 7, adoption authority,
    // source domain, force and state remain replay checks outside this API.
  });

  it("rejects every truncation, trailing byte and outer context substitution", () => {
    const x = fixture(), encoded = rawTrail(x.served);
    for (let length = 0; length < encoded.length; length++) {
      expect(() => trailCodec.decodeTrail(encoded.subarray(0, length), x.limits)).toThrow(EncodingError);
    }
    expect(() => trailCodec.decodeTrail(cat(encoded, Uint8Array.of(0)),
      { ...x.limits, maxBytes: x.limits.maxBytes + 1n })).toThrow(EncodingError);
    const wrong = Buffer.from(encoded); wrong[0] = wrong[0]! ^ 1;
    expect(() => trailCodec.decodeTrail(wrong, x.limits)).toThrow(EncodingError);
  });

  it("scans budgets and every raw boundary before decoding the header", () => {
    const x = fixture(), encoded = rawTrail(x.served), at = offsets(x.served);
    const reads = vi.spyOn(ByteReader.prototype, "raw");
    try {
      expect(() => trailCodec.decodeTrail(encoded, { ...x.limits, maxBytes: x.limits.maxBytes - 1n }))
        .toThrow(trailCodec.TrailLimitError);
      expect(reads).not.toHaveBeenCalled();
      const malformed: Buffer[] = [];
      const headerLength = Buffer.from(encoded); headerLength.set(u32(0xffffffff), ascii("trail").length); malformed.push(headerLength);
      for (const offset of at.termLengths) { const bytes = Buffer.from(encoded); bytes.set(u32(0xffffffff), offset); malformed.push(bytes); }
      const count = Buffer.from(encoded); count.set(integer(maxU64, 8), at.eventCount); malformed.push(count);
      for (const offset of at.recordLengths) { const bytes = Buffer.from(encoded); bytes.set(u32(0xffffffff), offset); malformed.push(bytes); }
      for (const bytes of malformed) {
        reads.mockClear();
        expect(() => trailCodec.decodeTrail(bytes, { maxBytes: BigInt(bytes.length), maxEvents: maxU64 })).toThrow(EncodingError);
        expect(reads).not.toHaveBeenCalled();
      }
    } finally { reads.mockRestore(); }
  });

  it("keeps event counts as u64 and propagates local resource refusal", () => {
    const x = fixture(), encoded = rawTrail(x.served), at = offsets(x.served);
    for (const action of [
      () => trailCodec.encodeTrail(x.served, { ...x.limits, maxBytes: x.limits.maxBytes - 1n }),
      () => trailCodec.decodeTrail(encoded, { ...x.limits, maxBytes: x.limits.maxBytes - 1n }),
      () => trailCodec.verifyTrailEvidence(x.expected, x.snapshot, x.served, { ...x.limits, maxBytes: x.limits.maxBytes - 1n }),
      () => trailCodec.encodeTrail(x.served, { ...x.limits, maxEvents: 1n }),
      () => trailCodec.decodeTrail(encoded, { ...x.limits, maxEvents: 1n }),
      () => trailCodec.verifyTrailEvidence(x.expected, x.snapshot, x.served, { ...x.limits, maxEvents: 1n }),
    ]) expect(action).toThrow(trailCodec.TrailLimitError);
    const hugeCount = Buffer.from(encoded); hugeCount.set(integer(maxU64, 8), at.eventCount);
    expect(() => trailCodec.decodeTrail(hugeCount, { maxBytes: BigInt(hugeCount.length), maxEvents: maxU64 })).toThrow(EncodingError);
    for (const bad of [-1n, maxU64 + 1n, 2 as unknown as bigint]) {
      const limits = { maxBytes: bad, maxEvents: 2n };
      expect(() => trailCodec.encodeTrail(x.served, limits)).toThrow(EncodingError);
      expect(() => trailCodec.decodeTrail(encoded, limits)).toThrow(EncodingError);
      expect(trailCodec.verifyTrailEvidence(x.expected, x.snapshot, x.served, limits)).toBe(false);
    }
    const failure = new Error("programming failure");
    expect(() => trailCodec.verifyTrailEvidence(x.expected, x.snapshot,
      { ...x.served, get records(): readonly Uint8Array[] { throw failure; } }, x.limits)).toThrow(failure);
  });

  it("has no header-scope event cap and applies the exact caller-selected boundary", () => {
    const base = fixture([], rawHeader([{ backing, link: b(163) }])), count = 65_537;
    const served = { ...base.served, terms: [{ terms: new Uint8Array(0), signature: Buffer.alloc(64) }],
      records: Array.from({ length: count }, () => new Uint8Array(0)) };
    const limits = { maxBytes: BigInt(rawTrail(served).length), maxEvents: BigInt(count) };
    expect(() => trailCodec.encodeTrail(served, { ...limits, maxEvents: BigInt(count - 1) }))
      .toThrow(trailCodec.TrailLimitError);
    const encoded = trailCodec.encodeTrail(served, limits);
    expect(encoded.length).toBe(262_508);
    expect(trailCodec.decodeTrail(encoded, limits).records).toHaveLength(count);
  });

  it("owns offset Buffer input and rejects sparse or malformed JS shapes", () => {
    const x = fixture(), encoded = trailCodec.encodeTrail(x.served, x.limits);
    const padded = cat(Buffer.alloc(7, 0xaa), encoded, Buffer.alloc(5, 0xbb));
    const input = padded.subarray(7, 7 + encoded.length), decoded = trailCodec.decodeTrail(input, x.limits);
    const baseline = trailCodec.encodeTrail(decoded, x.limits), independent = trailCodec.decodeTrail(baseline, x.limits);
    padded.fill(0); x.served.header.fill(1); x.served.terms[0]!.terms.fill(2); x.served.records[0]!.fill(3);
    expect(trailCodec.encodeTrail(decoded, x.limits)).toEqual(baseline);
    decoded.header.fill(5); decoded.terms[0]!.terms.fill(7); decoded.terms[0]!.signature.fill(11); decoded.records[0]!.fill(13);
    expect(trailCodec.encodeTrail(independent, x.limits)).toEqual(baseline);
    expect(Object.isFrozen(independent.terms)).toBe(true);
    expect(Object.isFrozen(independent.records)).toBe(true);

    const fresh = fixture(), invalid: unknown[] = [undefined, null, {}, "trail",
      { ...fresh.served, records: new Array(1) }, { ...fresh.served, records: [fresh.served.records[0], ,] },
      { ...fresh.served, terms: new Array(2) }, { ...fresh.served, terms: [null, fresh.served.terms[1]] },
      { ...fresh.served, terms: [{ ...fresh.served.terms[0], signature: new Uint8Array(63) }, fresh.served.terms[1]] },
      { ...fresh.served, header: new Uint8ClampedArray(fresh.served.header.length) },
      { ...fresh.served, records: new Uint8Array(0) }, { ...fresh.served, terms: fresh.served.terms.slice(1) }];
    for (const value of invalid) {
      expect(() => trailCodec.encodeTrail(value as trailCodec.ServedTrail, fresh.limits)).toThrow(EncodingError);
      expect(trailCodec.verifyTrailEvidence(fresh.expected, fresh.snapshot, value as trailCodec.ServedTrail, fresh.limits)).toBe(false);
    }
    for (const value of [undefined, null, {}, "bytes", new Uint8ClampedArray(encoded.length)]) {
      expect(() => trailCodec.decodeTrail(value as Uint8Array, fresh.limits)).toThrow(EncodingError);
    }
  });
});
