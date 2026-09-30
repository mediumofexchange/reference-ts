import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { compareBytes, EncodingError } from "../src/bytes.js";
import { limbsOf } from "../src/pool/field.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, type Snapshot } from "../src/pool/v3/commitments.js";
import { EvidenceStore, MAX_ITEM_BYTES } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidencePackage, encodeEvidenceDirectory, encodeEvidencePackage, PackageLimitError, type EvidenceItem } from "../src/pool/v3/package.js";
import { directoryRoot } from "../src/venue-records.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { authenticatedScope } from "../src/pool/v3/scope-evidence.js";
import { encodeRootTerms, MAX_ROOT_TERMS_BYTES, rootTermsName, rootTermsSignatureMessage } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail, MAX_TRAIL_RECORD_BYTES, type ServedTrail } from "../src/pool/v3/trail.js";

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
      // A snapshot is retained evidence, found by its digest; only per-read kinds are the package's own payloads.
      expect([batch.snapshot(sha256(Uint8Array.of(1))), batch.payloads(4)]).toEqual([Uint8Array.of(1), []]);
      // Two trails with one header and terms are one head, and their records one line.
      expect([...batch.heads(segment)].map(head => [...head.header])).toEqual([[...headerBytes]]);
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
    expect([...batch.heads(segment)]).toHaveLength(1);
    expect(recordsOf(batch.served(expectedAt(2), snapshotAt(2)))).toEqual(records.slice(0, 2).map(r => [...r]));
    // Past the undecodable record no position reproduces an evidence hash (§12.1).
    expect(batch.served(expectedAt(3), snapshotAt(3))).toBeUndefined();
    // The same frames as bare trails, as a harness supplies them.
    const bare = store.importTrails([truncated, trail(4)]);
    expect(bare.count(6)).toBe(2);
    expect([...bare.heads(segment)]).toHaveLength(1);
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

  it("bounds each whole item, not a trail, and refuses a kind a reader does not read at its header, keeping nothing", async () => {
    const store = new EvidenceStore(), big = new Uint8Array(Number(MAX_ITEM_BYTES) + 1);
    expect(() => store.importBytes(pack([{ kind: 4, payload: big }]))).toThrow(PackageLimitError);
    for (const kind of [5, 8, 9, 11]) {
      // Refused before its payload is read or budgeted, and before any later item.
      for (const payload of [big, Uint8Array.of(9)]) {
        const bytes = pack([{ kind: 3, payload: Uint8Array.of(2) }, { kind, payload }, { kind: 6, payload: trail(2) }]);
        expect(() => store.importBytes(bytes)).toThrow(expect.objectContaining({ status: "unsupported-scope" }));
        await expect(store.importStream(chunks(bytes, 5))).rejects.toMatchObject({ status: "unsupported-scope" });
      }
    }
    // The refused packages' trail was not kept.
    const batch = store.importBytes(pack([{ kind: 3, payload: Uint8Array.of(2) }]));
    expect([batch.count(3), batch.served(expectedAt(2), snapshotAt(2))]).toEqual([1, undefined]);
    store.close();
  });

  it("charges every item's own row against the quota, so the quota bounds the item count", async () => {
    const items = (n: number) => pack(Array.from({ length: n }, (_, i) => ({ kind: 4, payload: Uint8Array.of(i) })));
    // Each one-byte item costs its byte and a 128-byte row; payload bytes alone would admit 257 of them.
    const store = new EvidenceStore(":memory:", { maxBatchBytes: 2n * 129n });
    expect(store.importBytes(items(2)).count(4)).toBe(2);
    expect(() => store.importBytes(items(3))).toThrow(PackageLimitError);
    await expect(store.importStream(chunks(items(3), 3))).rejects.toThrow(PackageLimitError);
    // A trail's item row counts beside its bytes.
    const one = pack([{ kind: 6, payload: trail(0) }]), exact = new EvidenceStore(":memory:", { maxBatchBytes: 128n + BigInt(trail(0).length) });
    expect(exact.importBytes(one).count(6)).toBe(1);
    expect(() => new EvidenceStore(":memory:", { maxBatchBytes: 127n + BigInt(trail(0).length) }).importBytes(one)).toThrow(PackageLimitError);
    // Each kept record position costs 192 bytes of rows beside its record's bytes.
    const two = pack([{ kind: 6, payload: trail(2) }]), cost = 128n + BigInt(trail(2).length) + 2n * 192n;
    expect(new EvidenceStore(":memory:", { maxBatchBytes: cost }).importBytes(two).count(6)).toBe(1);
    expect(() => new EvidenceStore(":memory:", { maxBatchBytes: cost - 1n }).importBytes(two)).toThrow(PackageLimitError);
    // Bare trails, as a harness supplies them, are charged the same.
    expect(() => new EvidenceStore(":memory:", { maxBatchBytes: cost - 1n }).importTrails([trail(2)])).toThrow(PackageLimitError);
    store.close(); exact.close();
  });

  it("skips a terms field too long to verify, which decodeTrail keeps", () => {
    const long = [{ terms: new Uint8Array(MAX_ROOT_TERMS_BYTES + 1).fill(4), signature: new Uint8Array(64) }];
    const bytes = trail(1, { terms: long }), store = new EvidenceStore();
    expect(decodeTrail(bytes).terms[0]!.terms).toHaveLength(MAX_ROOT_TERMS_BYTES + 1);
    const batch = store.importBytes(pack([{ kind: 6, payload: bytes }, { kind: 6, payload: trail(1) }]));
    expect([...batch.heads(segment)].map(head => head.term(0)?.terms.length)).toEqual(
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

  it("refuses a length past the known end as malformed, as the in-memory decoder does", () => {
    const bytes = Buffer.from(pack([{ kind: 4, payload: Uint8Array.of(1, 2, 3) }]));
    bytes.writeBigUInt64BE(2n * MAX_ITEM_BYTES, 24);
    expect(() => decodeEvidencePackage(bytes)).toThrow(EncodingError);
    expect(() => new EvidenceStore().importBytes(bytes)).toThrow(EncodingError);
  });

  it("takes a stream of one-byte chunks at the record bound in time linear in its bytes", async () => {
    const record = new Uint8Array(MAX_TRAIL_RECORD_BYTES).fill(3), bytes = pack([{ kind: 6, payload: trail(0, { records: [record] }) }]);
    const store = new EvidenceStore(), batch = await store.importStream(chunks(bytes, 1));
    expect(batch.count(6)).toBe(1);
    expect([...batch.heads(segment)]).toHaveLength(1);
    store.close();
  });

  it("finds directories by root and snapshots by digest; a directory that does not decode has no root", () => {
    const directory = [{ name: backing, digest: b(8) }], snapshot = snapshotBytes(snapshotAt(2)), store = new EvidenceStore();
    const malformed = Uint8Array.of(1, 2, 3), unordered = Uint8Array.of(...encodeEvidenceDirectory([{ name: b(1), digest: b(8) }, { name: b(2), digest: b(8) }]));
    unordered.set(b(3), 9);
    const batch = store.importBytes(pack([{ kind: 3, payload: encodeEvidenceDirectory(directory) }, { kind: 4, payload: snapshot },
      { kind: 3, payload: malformed }, { kind: 3, payload: unordered }]));
    expect(batch.directory(directoryRoot(directory))).toEqual(directory);
    expect(batch.directory(b(1))).toBeUndefined();
    // A payload that is no directory is found by no root, not even its own hash, and refuses nothing else.
    expect([batch.directory(sha256(malformed)), batch.directory(sha256(unordered))]).toEqual([undefined, undefined]);
    expect(batch.count(3)).toBe(3);
    expect(batch.snapshot(sha256(snapshot))).toEqual(snapshot);
    expect(batch.snapshot(b(1))).toBeUndefined();
    store.close();
    // A directory's bytes under another kind are no directory.
    const other = new EvidenceStore();
    expect(other.importBytes(pack([{ kind: 4, payload: encodeEvidenceDirectory(directory) }])).directory(directoryRoot(directory))).toBeUndefined();
    other.close();
  });

  it("authenticates a segment's scope once per batch, from the first field that names its backing and verifies", () => {
    const issuerSecret = b(12), terms = encodeRootTerms({ obligor: ed25519.getPublicKey(issuerSecret), payout: { thing: "t", quantumExponent: 0, perUnit: 1n },
      operator: header.operator, configuration: domain, venue: header.venue, interval: 1n });
    const named = { ...header, entries: [{ backing: rootTermsName(terms), link: b(6) }] }, id = segmentIdentity(named);
    const signed = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), issuerSecret) };
    const forged = { terms, signature: ed25519.sign(rootTermsSignatureMessage(terms), b(13)) };
    const trailOf = (field: typeof signed) => encodeTrail({ header: segmentBytes(named), terms: [field], records: [] });
    const store = new EvidenceStore(), batch = store.importBytes(pack([{ kind: 6, payload: trailOf(forged) },
      { kind: 6, payload: trailOf({ terms: Uint8Array.of(1), signature: signed.signature }) }, { kind: 6, payload: trailOf(signed) }]));
    const scope = authenticatedScope(batch, id);
    expect(scope.terms).toEqual([signed]);
    expect(authenticatedScope(batch, id)).toBe(scope);
    // Another batch of the same bytes authenticates its own.
    const other = store.importBytes(pack([{ kind: 6, payload: trailOf(signed) }]));
    expect(authenticatedScope(other, id)).not.toBe(scope);
    expect(authenticatedScope(other, id)).toEqual(scope);
    store.close();
    // Without a verifying field the scope stays unresolved, and is not kept.
    const fresh = new EvidenceStore(), bare = fresh.importBytes(pack([{ kind: 6, payload: trailOf(forged) }]));
    for (let i = 0; i < 2; i++) expect(() => authenticatedScope(bare, id)).toThrow(expect.objectContaining({ status: "unresolved-evidence" }));
    fresh.close();
  });

  it("refuses a batch past the party's quota, keeping nothing, and a venue answer past it as a resource refusal", async () => {
    const bytes = pack([{ kind: 6, payload: trail(6) }]), store = new EvidenceStore(":memory:", { maxBatchBytes: BigInt(trail(6).length) - 1n });
    expect(() => store.importBytes(bytes)).toThrow(PackageLimitError);
    await expect(store.importStream(chunks(bytes, 64))).rejects.toThrow(PackageLimitError);
    const batch = store.importBytes(pack([{ kind: 6, payload: trail(2) }]));
    expect([...batch.heads(segment)]).toHaveLength(1);
    expect(() => batch.chargeAnswer(BigInt(trail(6).length))).toThrow(expect.objectContaining({ status: "resource-refusal" }));
    expect(() => new EvidenceStore(":memory:", { maxBatchBytes: -1n })).toThrow(TypeError);
    store.close();
  });

});
