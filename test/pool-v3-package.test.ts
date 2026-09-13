import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 as packageSha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import * as p from "../model/pool-v3-package.js";
import { EncodingError } from "../src/bytes.js";
import { directoryRoot, signCommitment, verifyCommitment, type SnapshotDigest } from "../src/commitment.js";

vi.mock("@noble/hashes/sha2.js", async importOriginal => {
  const actual = await importOriginal<typeof import("@noble/hashes/sha2.js")>();
  return { ...actual, sha256: vi.fn(actual.sha256) };
});

const context = Buffer.from("moe/pool/v3/package", "ascii");
const directoryContext = Buffer.from([0x4d, 0x4f, 0x45, 0x44, 1]);
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const integer = (value: bigint, width: number): Buffer =>
  Buffer.from(value.toString(16).padStart(width * 2, "0"), "hex");
const u32 = (value: number | bigint): Buffer => integer(BigInt(value), 4);
const sha = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const b = (fill: number): Buffer => Buffer.alloc(32, fill);
const generous = { maxBytes: 1_000_000n, maxItems: 1_000n };

function rawPackage(items: readonly p.EvidenceItem[]): Buffer {
  return cat(context, u32(items.length), ...items.map(item =>
    cat(Uint8Array.of(item.kind), u32(item.payload.length), item.payload)));
}

function rawDirectory(entries: readonly SnapshotDigest[]): Buffer {
  return cat(directoryContext, u32(entries.length),
    ...entries.map(entry => cat(entry.name, entry.digest)));
}

function independentOrder(items: readonly p.EvidenceItem[]): p.EvidenceItem[] {
  return [...items].sort((left, right) => left.kind - right.kind || Buffer.compare(sha(left.payload), sha(right.payload)));
}

function values(items: readonly p.EvidenceItem[]): Array<{ kind: number; payload: number[] }> {
  return items.map(item => ({ kind: item.kind, payload: [...item.payload] }));
}

describe("v3 evidence package", () => {
  it("matches independent framing and SHA256 ordering across all eleven opaque kinds", () => {
    const items = independentOrder(Array.from({ length: 11 }, (_, index) => ({
      kind: index + 1,
      payload: index % 3 === 0 ? new Uint8Array(0) : Uint8Array.of(255 - index, index, index * 3),
    })));
    const expected = rawPackage(items);
    const limits = { maxBytes: BigInt(expected.length), maxItems: 11n };

    expect(Buffer.from(p.encodeEvidencePackage(items, limits))).toEqual(expected);
    expect(values(p.decodeEvidencePackage(expected, limits))).toEqual(values(items));
    expect(Buffer.from(p.encodeEvidencePackage(p.decodeEvidencePackage(expected, limits), limits))).toEqual(expected);
  });

  it("orders same-kind items by payload hash, not by their raw bytes", () => {
    let pair: [Uint8Array, Uint8Array] | undefined;
    for (let left = 0; left < 256 && pair === undefined; left++) {
      for (let right = left + 1; right < 256; right++) {
        const a = Uint8Array.of(left), z = Uint8Array.of(right);
        if (Buffer.compare(sha(a), sha(z)) > 0) { pair = [a, z]; break; }
      }
    }
    expect(pair).toBeDefined();
    const [rawFirst, hashFirst] = pair!;
    expect(Buffer.compare(rawFirst, hashFirst)).toBeLessThan(0);
    expect(Buffer.compare(sha(rawFirst), sha(hashFirst))).toBeGreaterThan(0);
    const canonical = [{ kind: 6, payload: hashFirst }, { kind: 6, payload: rawFirst }];
    const rawOrdered = [...canonical].reverse();

    expect(Buffer.from(p.encodeEvidencePackage(canonical, generous))).toEqual(rawPackage(canonical));
    expect(() => p.encodeEvidencePackage(rawOrdered, generous)).toThrow(/strictly ordered/);
    expect(() => p.decodeEvidencePackage(rawPackage(rawOrdered), generous)).toThrow(/strictly ordered/);
  });

  it("refuses repeated inventory keys but permits the same opaque bytes under different kinds", () => {
    const payload = Uint8Array.of(7, 11, 13);
    const crossKind = [{ kind: 2, payload }, { kind: 9, payload }];
    expect(values(p.decodeEvidencePackage(p.encodeEvidencePackage(crossKind, generous), generous)))
      .toEqual(values(crossKind));
    const repeated = [{ kind: 4, payload }, { kind: 4, payload: Uint8Array.from(payload) }];
    expect(() => p.encodeEvidencePackage(repeated, generous)).toThrow(/strictly ordered/);
    expect(() => p.decodeEvidencePackage(rawPackage(repeated), generous)).toThrow(/strictly ordered/);
  });

  it("preserves empty and malformed inner payloads without interpreting them", () => {
    const malformed = independentOrder(Array.from({ length: 11 }, (_, index) => ({
      kind: index + 1, payload: index === 0 ? new Uint8Array(0) : Uint8Array.of(0xff, index, 0),
    })));
    const decoded = p.decodeEvidencePackage(rawPackage(malformed), generous);
    expect(values(decoded)).toEqual(values(malformed));
    expect(Object.isFrozen(decoded)).toBe(true);
    decoded.forEach(item => expect(Object.isFrozen(item)).toBe(true));
  });

  it("rejects every truncation, trailing data, wrong kinds and impossible count or length fields", () => {
    const items = [{ kind: 1, payload: Uint8Array.of(2, 3) }, { kind: 11, payload: Uint8Array.of(5) }];
    const encoded = rawPackage(items);
    for (let end = 0; end < encoded.length; end++) {
      expect(() => p.decodeEvidencePackage(encoded.subarray(0, end), generous)).toThrow();
    }
    expect(() => p.decodeEvidencePackage(cat(encoded, Uint8Array.of(0)), generous)).toThrow(/trailing/);
    for (const tag of [0, 12, 255]) {
      const changed = Buffer.from(encoded); changed[23] = tag;
      expect(() => p.decodeEvidencePackage(changed, generous)).toThrow(/unsupported evidence kind/);
      expect(() => p.encodeEvidencePackage([{ kind: tag, payload: new Uint8Array(0) }], generous))
        .toThrow(/unsupported evidence kind/);
    }
    const hugeCount = Buffer.from(encoded); hugeCount.set(u32(0xffff_ffff), 19);
    expect(() => p.decodeEvidencePackage(hugeCount, generous)).toThrow(/budget|count/);
    const hugeLength = Buffer.from(encoded); hugeLength.set(u32(0xffff_ffff), 24);
    expect(() => p.decodeEvidencePackage(hugeLength, generous)).toThrow(/truncated evidence payload/);
    const wrongContext = Buffer.from(encoded); wrongContext[0] = wrongContext[0]! ^ 1;
    expect(() => p.decodeEvidencePackage(wrongContext, generous)).toThrow(/context/);
  });

  it("applies exact byte and item budgets, including empty packages and zero limits", () => {
    const empty = rawPackage([]);
    expect(p.decodeEvidencePackage(empty, { maxBytes: 23n, maxItems: 0n })).toEqual([]);
    expect(Buffer.from(p.encodeEvidencePackage([], { maxBytes: 23n, maxItems: 0n }))).toEqual(empty);
    for (const action of [
      () => p.encodeEvidencePackage([], { maxBytes: 22n, maxItems: 0n }),
      () => p.decodeEvidencePackage(empty, { maxBytes: 22n, maxItems: 0n }),
    ]) expect(action).toThrow(p.PackageLimitError);

    const one = [{ kind: 1, payload: new Uint8Array(0) }], encoded = rawPackage(one);
    expect(p.decodeEvidencePackage(encoded, { maxBytes: 28n, maxItems: 1n })).toHaveLength(1);
    for (const limits of [{ maxBytes: 27n, maxItems: 1n }, { maxBytes: 28n, maxItems: 0n }]) {
      expect(() => p.encodeEvidencePackage(one, limits)).toThrow(p.PackageLimitError);
      expect(() => p.decodeEvidencePackage(encoded, limits)).toThrow(p.PackageLimitError);
    }
    for (const bad of [-1n, 1n << 64n, 1 as unknown as bigint]) {
      expect(() => p.encodeEvidencePackage([], { maxBytes: bad, maxItems: 0n })).toThrow(EncodingError);
      expect(() => p.decodeEvidencePackage(empty, { maxBytes: 23n, maxItems: bad })).toThrow(EncodingError);
    }
  });

  it("does not hash payloads before outer shape, boundary and budget checks finish", () => {
    const mocked = vi.mocked(packageSha256);
    mocked.mockClear();
    expect(() => p.encodeEvidencePackage([{ kind: 1, payload: Uint8Array.of(1) }],
      { maxBytes: 28n, maxItems: 1n })).toThrow(p.PackageLimitError);
    expect(mocked).not.toHaveBeenCalled();

    for (const malformed of [
      cat(context, u32(1), Uint8Array.of(0), u32(0)),
      cat(context, u32(1), Uint8Array.of(1), u32(2), Uint8Array.of(7)),
      cat(context, u32(0), Uint8Array.of(9)),
      cat(context, u32(2), Uint8Array.of(1), u32(1), Uint8Array.of(42),
        Uint8Array.of(2), u32(2), Uint8Array.of(7)),
      cat(rawPackage([{ kind: 1, payload: Uint8Array.of(42) }]), Uint8Array.of(9)),
    ]) {
      mocked.mockClear();
      expect(() => p.decodeEvidencePackage(malformed, generous)).toThrow(EncodingError);
      expect(mocked).not.toHaveBeenCalled();
    }
  });

  it("owns Buffer and offset inputs and rejects shared mutable storage", () => {
    const payload = Buffer.from([2, 4, 8]), items = [{ kind: 3, payload }];
    const encoded = p.encodeEvidencePackage(items, generous), baseline = Buffer.from(encoded);
    payload.fill(0);
    expect(Buffer.from(encoded)).toEqual(baseline);

    const padded = cat(Buffer.alloc(7, 0xaa), baseline, Buffer.alloc(5, 0xbb));
    const input = padded.subarray(7, 7 + baseline.length), decoded = p.decodeEvidencePackage(input, generous);
    expect(input.byteOffset).toBeGreaterThan(0);
    padded.fill(0);
    expect(Buffer.from(p.encodeEvidencePackage(decoded, generous))).toEqual(baseline);
    const independent = p.decodeEvidencePackage(baseline, generous);
    decoded[0]!.payload.fill(19);
    expect(Buffer.from(p.encodeEvidencePackage(independent, generous))).toEqual(baseline);

    const sharedPayload = new Uint8Array(new SharedArrayBuffer(1));
    expect(() => p.encodeEvidencePackage([{ kind: 1, payload: sharedPayload }], generous)).toThrow(EncodingError);
    const sharedInput = new Uint8Array(new SharedArrayBuffer(baseline.length)); sharedInput.set(baseline);
    expect(() => p.decodeEvidencePackage(sharedInput, generous)).toThrow(EncodingError);
  });
});

describe("v3 evidence directory preimage", () => {
  const entries = [
    { name: b(3), digest: b(101) },
    { name: b(7), digest: b(103) },
    { name: b(11), digest: b(107) },
  ];

  it("matches the existing directory root and signed commitment for empty and multi-entry directories", () => {
    for (const directory of [[], entries] as readonly (readonly SnapshotDigest[])[]) {
      const expected = rawDirectory(directory), limits = { maxBytes: BigInt(expected.length), maxItems: BigInt(directory.length) };
      expect(Buffer.from(p.encodeEvidenceDirectory(directory, limits))).toEqual(expected);
      expect(sha(expected)).toEqual(Buffer.from(directoryRoot(directory)));
      const commitment = signCommitment(b(29), 17n, sha(expected));
      expect(verifyCommitment(commitment)).toBe(true);
      expect(Buffer.from(commitment.root)).toEqual(Buffer.from(directoryRoot(directory)));
      expect(p.decodeEvidenceDirectory(expected, limits).map(entry => ({ name: [...entry.name], digest: [...entry.digest] })))
        .toEqual(directory.map(entry => ({ name: [...entry.name], digest: [...entry.digest] })));
    }
  });

  it("rejects unordered, duplicate, malformed-width, truncated and trailing directory evidence", () => {
    for (const bad of [[entries[1]!, entries[0]!], [entries[0]!, { ...entries[0]! }]]) {
      expect(() => p.encodeEvidenceDirectory(bad, generous)).toThrow(/unordered/);
      expect(() => p.decodeEvidenceDirectory(rawDirectory(bad), generous)).toThrow(/unordered/);
    }
    for (const bad of [
      [{ name: new Uint8Array(31), digest: b(1) }],
      [{ name: b(1), digest: new Uint8Array(33) }],
    ]) expect(() => p.encodeEvidenceDirectory(bad, generous)).toThrow(EncodingError);

    const encoded = rawDirectory(entries);
    for (let end = 0; end < encoded.length; end++) {
      expect(() => p.decodeEvidenceDirectory(encoded.subarray(0, end), generous)).toThrow();
    }
    expect(() => p.decodeEvidenceDirectory(cat(encoded, Uint8Array.of(0)), generous)).toThrow(/length/);
    const wrongVersion = Buffer.from(encoded); wrongVersion[4] = 2;
    expect(() => p.decodeEvidenceDirectory(wrongVersion, generous)).toThrow(/context/);
    const hugeCount = Buffer.from(encoded); hugeCount.set(u32(0xffff_ffff), 5);
    expect(() => p.decodeEvidenceDirectory(hugeCount, generous)).toThrow(/budget|length/);
  });

  it("applies exact directory byte and entry budgets before reading entries", () => {
    const encoded = rawDirectory(entries), exact = { maxBytes: BigInt(encoded.length), maxItems: 3n };
    expect(p.decodeEvidenceDirectory(encoded, exact)).toHaveLength(3);
    expect(Buffer.from(p.encodeEvidenceDirectory(entries, exact))).toEqual(encoded);
    for (const limits of [
      { maxBytes: BigInt(encoded.length - 1), maxItems: 3n },
      { maxBytes: BigInt(encoded.length), maxItems: 2n },
    ]) {
      expect(() => p.encodeEvidenceDirectory(entries, limits)).toThrow(p.PackageLimitError);
      expect(() => p.decodeEvidenceDirectory(encoded, limits)).toThrow(p.PackageLimitError);
    }
    const empty = rawDirectory([]);
    expect(p.decodeEvidenceDirectory(empty, { maxBytes: 9n, maxItems: 0n })).toEqual([]);
    expect(() => p.decodeEvidenceDirectory(empty, { maxBytes: 8n, maxItems: 0n })).toThrow(p.PackageLimitError);
  });

  it("owns directory inputs and decoded entries and rejects shared storage", () => {
    const source = entries.map(entry => ({ name: Buffer.from(entry.name), digest: Buffer.from(entry.digest) }));
    const encoded = p.encodeEvidenceDirectory(source, generous), baseline = Buffer.from(encoded);
    source[0]!.name.fill(0); source[0]!.digest.fill(0);
    expect(Buffer.from(encoded)).toEqual(baseline);

    const padded = cat(Buffer.alloc(3), baseline, Buffer.alloc(4)), input = padded.subarray(3, 3 + baseline.length);
    const decoded = p.decodeEvidenceDirectory(input, generous), independent = p.decodeEvidenceDirectory(baseline, generous);
    padded.fill(0); decoded[0]!.name.fill(19); decoded[0]!.digest.fill(23);
    expect(Buffer.from(p.encodeEvidenceDirectory(independent, generous))).toEqual(baseline);
    expect(Object.isFrozen(independent)).toBe(true);
    independent.forEach(entry => expect(Object.isFrozen(entry)).toBe(true));

    const sharedName = new Uint8Array(new SharedArrayBuffer(32));
    expect(() => p.encodeEvidenceDirectory([{ name: sharedName, digest: b(1) }], generous)).toThrow(EncodingError);
    const sharedInput = new Uint8Array(new SharedArrayBuffer(baseline.length)); sharedInput.set(baseline);
    expect(() => p.decodeEvidenceDirectory(sharedInput, generous)).toThrow(EncodingError);
  });
});
