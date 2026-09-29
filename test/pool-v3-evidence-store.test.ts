import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { compareBytes, EncodingError } from "../src/bytes.js";
import { limbsOf } from "../src/pool/field.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotDigest, type Snapshot } from "../src/pool/v3/commitments.js";
import { EvidenceStore, MAX_ITEM_BYTES } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { encodeEvidencePackage, PackageLimitError, type EvidenceItem } from "../src/pool/v3/package.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { MAX_ROOT_TERMS_BYTES } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail, type ServedTrail } from "../src/pool/v3/trail.js";

// The store's own contract: one copy of the supplied bytes, each trail's
// decodable prefix by evidence position, and nothing kept of what does not frame.
const b = (n: number) => new Uint8Array(32).fill(n);
const secret = b(3), backing = b(5), domain = b(1);
const header: SegmentHeader = { domain, venue: b(2), operator: ed25519.getPublicKey(b(4)), sequence: 1n, entries: [{ backing, link: backing }] };
const segment = segmentIdentity(header), headerBytes = segmentBytes(header);
const terms = [{ terms: Uint8Array.of(7, 8, 9), signature: new Uint8Array(64).fill(6) }];

function issue(i: number): Uint8Array {
  const capsules = [new Uint8Array(89).fill(1)], outputs = [BigInt(1000 + i)];
  const record: Record = { domain, kind: 1, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 9n, ...limbsOf(backing), 5n, ...outputs,
    ...limbsOf(deliveryHash(domain, outputs, capsules))], proof: b(7), authorization: new Uint8Array(64), capsules };
  return encodeRecord({ ...record, authorization: ed25519.sign(statementBytes(record), secret) });
}
const records = Array.from({ length: 6 }, (_, i) => issue(i));
const chain = [genesisEvidenceHash(segment)];
for (const [i, record] of records.entries()) {
  chain.push(nextEvidenceHash(chain[i]!, evidenceHashes(decodeRecord(record)), BigInt(i + 1)));
}
const trail = (n: number, extra: Partial<ServedTrail> = {}): Uint8Array => encodeTrail({ header: headerBytes, terms, records: records.slice(0, n), ...extra });
const snapshotAt = (n: number): Snapshot => ({ backing, segment, historyHash: b(9), evidenceHash: chain[n]!, issued: 0n, burned: 0n });
const expectedAt = (n: number) => ({ backing, segment, digest: snapshotDigest(snapshotAt(n)) });
const pack = (items: readonly EvidenceItem[]) => encodeEvidencePackage([...items].sort((a, z) =>
  a.kind - z.kind || compareBytes(sha256(a.payload), sha256(z.payload))));
async function* chunks(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
const recordsOf = (served: { records(after?: bigint): Iterable<Uint8Array> } | undefined, after = 0n) => [...served!.records(after)].map(r => [...r]);

describe("v3 evidence store", () => {
  it("serves each checkpoint's prefix of a stored trail, the same from bytes and from any chunking", async () => {
    const bytes = pack([{ kind: 4, payload: Uint8Array.of(1) }, { kind: 6, payload: trail(6) }, { kind: 6, payload: trail(3) }]);
    for (const load of [(s: EvidenceStore) => s.importBytes(bytes), (s: EvidenceStore) => s.importStream(chunks(bytes, 1)),
      (s: EvidenceStore) => s.importStream(chunks(bytes, 7)), (s: EvidenceStore) => s.importStream(chunks(bytes, 1 << 20))]) {
      const store = new EvidenceStore(), batch = await load(store);
      expect(batch.count(6)).toBe(2);
      expect(batch.payloads(4)).toEqual([Uint8Array.of(1)]);
      expect(batch.heads(segment).map(head => [...head.header])).toEqual([[...headerBytes], [...headerBytes]]);
      for (let n = 0; n <= 6; n++) {
        const served = batch.served(expectedAt(n), snapshotAt(n))!;
        expect(served.length).toBe(BigInt(n));
        expect(recordsOf(served)).toEqual(records.slice(0, n).map(r => [...r]));
        expect(recordsOf(served, 2n)).toEqual(records.slice(2, n).map(r => [...r]));
        for (let p = 0; p <= n; p++) expect(served.evidence(BigInt(p))).toEqual(chain[p]);
        expect(served.evidence(BigInt(n + 1))).toBeUndefined();
      }
      // A snapshot whose digest is not the expected one, or of another backing, is not served.
      expect(batch.served({ ...expectedAt(2), digest: b(0) }, snapshotAt(2))).toBeUndefined();
      expect(batch.served({ ...expectedAt(2), backing: b(8) }, { ...snapshotAt(2), backing: b(8) })).toBeUndefined();
      store.close();
    }
  });

  it("keeps a trail's decodable prefix only, and nothing of a trail that does not frame", () => {
    const broken = [...records.slice(0, 2), Uint8Array.of(1, 2, 3), ...records.slice(2, 4)];
    const truncated = trail(4).subarray(0, trail(4).length - 1);
    const store = new EvidenceStore();
    const batch = store.importBytes(pack([{ kind: 6, payload: trail(0, { records: broken }) }, { kind: 6, payload: truncated },
      { kind: 6, payload: Uint8Array.of(9) }]));
    expect(batch.count(6)).toBe(3);
    expect(batch.heads(segment)).toHaveLength(1);
    expect(recordsOf(batch.served(expectedAt(2), snapshotAt(2)))).toEqual(records.slice(0, 2).map(r => [...r]));
    // Past the undecodable record no position reproduces an evidence hash (§12.1).
    expect(batch.served(expectedAt(3), snapshotAt(3))).toBeUndefined();
    // The same frames as bare trails, as a harness supplies them.
    const bare = store.importTrails([truncated, trail(4)]);
    expect(bare.count(6)).toBe(2);
    expect(bare.heads(segment)).toHaveLength(1);
    expect(recordsOf(bare.served(expectedAt(4), snapshotAt(4)))).toEqual(records.slice(0, 4).map(r => [...r]));
    store.close();
  });

  it("keeps nothing of a malformed package and stays usable", async () => {
    const good = pack([{ kind: 6, payload: trail(2) }]);
    const store = new EvidenceStore();
    // Items out of order are found only after the trail was streamed into storage.
    const unordered = Uint8Array.of(...good.subarray(0, 19), 0, 0, 0, 2, ...good.subarray(23), 4, ...new Uint8Array(7), 1, 1);
    for (const bad of [unordered, good.subarray(0, good.length - 1), Uint8Array.of(...good, 0)]) {
      expect(() => store.importBytes(bad)).toThrow(EncodingError);
      await expect(store.importStream(chunks(bad, 5))).rejects.toThrow(EncodingError);
    }
    const batch = store.importBytes(good);
    expect(batch.served(expectedAt(2), snapshotAt(2))!.length).toBe(2n);
    store.close();
  });

  it("bounds each whole item, not a trail, and passes over kinds a reader does not read", () => {
    const store = new EvidenceStore(), big = new Uint8Array(Number(MAX_ITEM_BYTES) + 1);
    expect(() => store.importBytes(pack([{ kind: 4, payload: big }]))).toThrow(PackageLimitError);
    const batch = store.importBytes(pack([{ kind: 11, payload: big }, { kind: 5, payload: Uint8Array.of(1) }, { kind: 3, payload: Uint8Array.of(2) }]));
    expect(batch.kinds().sort((a, z) => a - z)).toEqual([3, 5, 11]);
    expect(batch.count(11)).toBe(1);
    expect(batch.payloads(11)).toEqual([]);
    expect(batch.payloads(3)).toEqual([Uint8Array.of(2)]);
    store.close();
  });

  it("skips a terms field too long to verify, which decodeTrail keeps", () => {
    const long = [{ terms: new Uint8Array(MAX_ROOT_TERMS_BYTES + 1).fill(4), signature: new Uint8Array(64) }];
    const bytes = trail(1, { terms: long }), store = new EvidenceStore();
    expect(decodeTrail(bytes).terms[0]!.terms).toHaveLength(MAX_ROOT_TERMS_BYTES + 1);
    const batch = store.importBytes(pack([{ kind: 6, payload: bytes }, { kind: 6, payload: trail(1) }]));
    expect(batch.heads(segment).map(head => head.terms[0]?.terms.length)).toEqual(
      compareBytes(sha256(bytes), sha256(trail(1))) < 0 ? [undefined, 3] : [3, undefined]);
    store.close();
  });

  it("owns streamed chunks as they arrive", async () => {
    const bytes = pack([{ kind: 6, payload: trail(3) }]), store = new EvidenceStore();
    async function* reused(): AsyncGenerator<Uint8Array> {
      const buffer = new Uint8Array(64);
      for (let at = 0; at < bytes.length; at += 64) {
        const part = bytes.subarray(at, at + 64);
        buffer.set(part); yield buffer.subarray(0, part.length);
        buffer.fill(0xee);
      }
    }
    const batch = await store.importStream(reused());
    expect(recordsOf(batch.served(expectedAt(3), snapshotAt(3)))).toEqual(records.slice(0, 3).map(r => [...r]));
    store.close();
  });
});
