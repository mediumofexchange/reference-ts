import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compareBytes, EncodingError } from "../src/bytes.js";
import { limbsOf } from "../src/pool/field.js";
import { genesisEvidenceHash, nextEvidenceHash, snapshotBytes, snapshotDigest, type Snapshot } from "../src/pool/v3/commitments.js";
import { EvidenceStore, MAX_ITEM_BYTES, trailPart, wholePackage, type EvidencePart } from "../src/pool/v3/evidence-store.js";
import { segmentBytes, segmentIdentity, type SegmentHeader } from "../src/pool/v3/headers.js";
import { decodeEvidencePackage, encodeEvidenceDirectory, encodeEvidencePackage, PackageLimitError, type EvidenceItem } from "../src/pool/v3/package.js";
import { directoryRoot } from "../src/venue-records.js";
import { decodeRecord, deliveryHash, encodeRecord, evidenceHashes, statementBytes, type Record } from "../src/pool/v3/records.js";
import { authenticatedScope } from "../src/pool/v3/scope-evidence.js";
import { encodeRootTerms, MAX_ROOT_TERMS_BYTES, rootTermsName, rootTermsSignatureMessage, verifyRootTermsSignature } from "../src/pool/v3/terms.js";
import { decodeTrail, encodeTrail, MAX_TRAIL_RECORD_BYTES, type ServedTrail } from "../src/pool/v3/trail.js";
import { collected } from "./support.js";

// The terms signature check, counted where it runs and otherwise unchanged.
vi.mock("../src/pool/v3/terms.js", async original => {
  const actual = await original<typeof import("../src/pool/v3/terms.js")>();
  return { ...actual, verifyRootTermsSignature: vi.fn(actual.verifyRootTermsSignature) };
});

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
const concat = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
/** A later trail as §14 fetches it: its head, count included, and its records after position `after`. */
function fetched(full: Uint8Array, after: number, kept = records): Uint8Array {
  const head = encodeTrail({ header: headerBytes, terms, records: [] }).length;
  return concat(full.subarray(0, head), full.subarray(head + kept.slice(0, after).reduce((n, r) => n + 4 + r.length, 0)));
}
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** A party's evidence file, and a way to look at or damage its rows while no store holds it. */
function evidenceFile() {
  const dir = mkdtempSync(join(tmpdir(), "moe-evidence-")); directories.push(dir);
  const path = join(dir, "evidence.sqlite");
  const sql = (query: string, ...values: (Uint8Array | number)[]): void => {
    const db = new DatabaseSync(path); try { db.prepare(query).run(...values); } finally { db.close(); }
  };
  const count = (table: string): number => {
    const db = new DatabaseSync(path, { readBigInts: true });
    try { return Number((db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: bigint }).c); } finally { db.close(); }
  };
  return { path, sql, count };
}


describe("v3 evidence store", () => {
  it("keeps a party's own evidence in a host's transaction and serves it as supplied evidence is served", () => {
    const db = new DatabaseSync(":memory:", { readBigInts: true }), store = new EvidenceStore(db);
    const issuer = ed25519.getPublicKey(secret), termsBytes = encodeRootTerms({ obligor: issuer, payout: { thing: "units", quantumExponent: 0, perUnit: 1n },
      operator: header.operator, configuration: domain, venue: b(2), interval: 10n });
    const name = rootTermsName(termsBytes), own: SegmentHeader = { ...header, entries: [{ backing: name, link: name }] };
    const ownSegment = segmentIdentity(own), seed = genesisEvidenceHash(ownSegment);
    const signed = { terms: termsBytes, signature: ed25519.sign(rootTermsSignatureMessage(termsBytes), secret) };
    const directory = encodeEvidenceDirectory([{ name, digest: b(8) }]);
    // A rolled-back host transaction keeps nothing.
    db.exec("BEGIN"); store.keepHead(segmentBytes(own), [signed]); store.keep(3, directory); db.exec("ROLLBACK");
    expect([...store.retained().heads(ownSegment)]).toEqual([]);
    db.exec("BEGIN");
    // A terms field that does not name its entry's backing or verify is not kept (§12.1).
    store.keepHead(segmentBytes(own), [{ terms: termsBytes, signature: new Uint8Array(64) }]);
    expect([...store.retained().heads(ownSegment)][0]!.term(0)).toBeUndefined();
    store.keepHead(segmentBytes(own), [signed]); store.keep(3, directory); store.keep(4, Uint8Array.of(1, 2, 3));
    expect(() => store.keep(3, Uint8Array.of(1))).toThrow(EncodingError);
    // Records append under the evidence recurrence, only after a kept position of that segment.
    let tip = { segment: ownSegment, position: 0n, evidence: seed };
    expect(() => store.append({ ...tip, evidence: b(9) }, records[0]!)).toThrow(/no kept trail position/);
    expect(() => store.append(tip, Uint8Array.of(1, 2, 3))).toThrow(EncodingError);
    const values = [seed];
    for (const record of records.slice(0, 3)) { tip = store.append(tip, record); values.push(tip.evidence); }
    expect(() => store.append({ segment: ownSegment, position: 5n, evidence: tip.evidence }, records[3]!)).toThrow(/no kept trail position/);
    db.exec("COMMIT");
    expect(tip.evidence).toEqual(nextEvidenceHash(values[2]!, evidenceHashes(decodeRecord(records[2]!)), 3n));
    const batch = store.retained();
    expect(batch.object(3, sha256(directory))).toEqual(directory);
    expect(batch.directory(sha256(directory))).toEqual([{ name, digest: b(8) }]);
    expect(batch.snapshot(sha256(Uint8Array.of(1, 2, 3)))).toEqual(Uint8Array.of(1, 2, 3));
    expect([...batch.heads(ownSegment)][0]!.term(0)).toEqual(signed);
    expect(recordsOf(batch.trail(ownSegment, values[3]!))).toEqual(records.slice(0, 3).map(r => [...r]));
    expect(batch.trail(ownSegment, values[2]!)!.length).toBe(2n);
    expect(batch.trail(ownSegment, seed)!.length).toBe(0n);
    expect(batch.trail(ownSegment, b(9))).toBeUndefined();
    // The same rows serve a snapshot as a reader looks them up, and an assembled trail continues after them.
    const snapshot: Snapshot = { backing: name, segment: ownSegment, historyHash: b(9), evidenceHash: values[3]!, issued: 0n, burned: 0n };
    expect(batch.served({ backing: name, segment: ownSegment, digest: snapshotDigest(snapshot) }, snapshot)!.length).toBe(3n);
    store.close();
    expect(db.isOpen).toBe(true);
    db.close();
  });

  it("serves each checkpoint's prefix of a stored trail, the same from bytes and from any chunking", async () => {
    const bytes = pack([{ kind: 4, payload: Uint8Array.of(1) }, { kind: 6, payload: trail(6) }, { kind: 6, payload: trail(3) }]);
    for (const load of [(s: EvidenceStore) => s.importBytes(bytes), (s: EvidenceStore) => s.importStream(chunks(bytes, 1)),
      (s: EvidenceStore) => s.importStream(chunks(bytes, 7)), (s: EvidenceStore) => s.importStream(chunks(bytes, 1 << 20))]) {
      const store = new EvidenceStore(), batch = await load(store);
      expect(batch.count(6)).toBe(2);
      // A snapshot is retained evidence, found by its digest; only per-read kinds are the package's own payloads.
      expect([batch.snapshot(sha256(Uint8Array.of(1))), batch.payloads(4)]).toEqual([Uint8Array.of(1), []]);
      // The segment's trails share one head.
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
    // Split across a supplier's parts, the rows still count: two one-byte items per part cost 258 bytes against
    // under 90 on the wire, so the second of two parts passes a quota of 400 that wire bytes alone would not.
    const parts = new EvidenceStore(":memory:", { maxBatchBytes: 400n });
    const part = (n: number): EvidencePart => ({ package: pack([0, 1].map(i => ({ kind: 4, payload: Uint8Array.of(2 * n + i) }))) });
    await expect(parts.take([part(0), part(1)])).rejects.toThrow(PackageLimitError);
    expect([parts.retained().snapshot(sha256(Uint8Array.of(1))) !== undefined, parts.retained().snapshot(sha256(Uint8Array.of(2)))]).toEqual([true, undefined]);
    // A trail part after a position the store does not hold is not read, and its stated bytes still count.
    const skipped = new EvidenceStore(":memory:", { maxBatchBytes: 1000n });
    const unheld = (n: number): EvidencePart => ({ trail: { after: { segment: b(n), position: 5n, evidence: b(9) }, size: 900n, chunks: [new Uint8Array(900)] } });
    await expect(skipped.take([unheld(1), unheld(2)])).rejects.toThrow(PackageLimitError);
    store.close(); exact.close(); parts.close(); skipped.close();
  });

  it("keeps only a terms field that names its backing and verifies, skipping one too long to verify", () => {
    const issuerSecret = b(12), realTerms = encodeRootTerms({ obligor: ed25519.getPublicKey(issuerSecret), payout: { thing: "t", quantumExponent: 0, perUnit: 1n },
      operator: header.operator, configuration: domain, venue: header.venue, interval: 1n });
    const named = { ...header, entries: [{ backing: rootTermsName(realTerms), link: b(6) }] }, id = segmentIdentity(named);
    const signed = { terms: realTerms, signature: ed25519.sign(rootTermsSignatureMessage(realTerms), issuerSecret) };
    const long = { terms: new Uint8Array(MAX_ROOT_TERMS_BYTES + 1).fill(4), signature: new Uint8Array(64) };
    const trailOf = (field: typeof signed) => encodeTrail({ header: segmentBytes(named), terms: [field], records: [] });
    expect(decodeTrail(trailOf(long)).terms[0]!.terms).toHaveLength(MAX_ROOT_TERMS_BYTES + 1);
    const store = new EvidenceStore();
    // Neither a field too long to verify nor one that does not name the backing is kept: the head alone is.
    const first = store.importBytes(pack([{ kind: 6, payload: trailOf(long) }, { kind: 6, payload: trailOf({ terms: Uint8Array.of(1), signature: signed.signature }) }]));
    expect([...first.heads(id)].map(head => head.term(0))).toEqual([undefined]);
    expect([...store.importBytes(pack([{ kind: 6, payload: trailOf(signed) }])).heads(id)].map(head => head.term(0))).toEqual([signed]);
    // A field already kept byte for byte is not verified again when its head is served again.
    vi.mocked(verifyRootTermsSignature).mockClear();
    expect([...store.importBytes(pack([{ kind: 6, payload: trailOf(signed) }])).heads(id)].map(head => head.term(0))).toEqual([signed]);
    expect(verifyRootTermsSignature).not.toHaveBeenCalled();
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

  it("assembles a later trail from its head and the records after a kept position, sharing the kept records", async () => {
    const file = evidenceFile(), tip = { segment, position: 3n, evidence: chain[3]! };
    let store = new EvidenceStore(file.path);
    store.importTrails([trail(3)]);
    store.close();
    // The retained file serves a later read of the same party.
    store = new EvidenceStore(file.path);
    expect(await store.importTrail(fetched(trail(6), 3), { after: tip })).toBe(true);
    const batch = store.importBytes(pack([]));
    for (let n = 0; n <= 6; n++) {
      const served = batch.served(expectedAt(n), snapshotAt(n))!;
      expect(recordsOf(served)).toEqual(records.slice(0, n).map(r => [...r]));
      for (let p = 0; p <= n; p++) {
        expect(recordsOf(served, BigInt(p))).toEqual(records.slice(p, n).map(r => [...r]));
        expect(served.evidence(BigInt(p))).toEqual(chain[p]);
      }
    }
    // A stream states its length; the same fetched bytes add nothing new.
    const again = fetched(trail(6), 3);
    expect(await store.importTrail(chunks(again, 5), { after: tip, size: BigInt(again.length) })).toBe(true);
    await expect(store.importTrail(chunks(again, 5), { after: tip })).rejects.toThrow(TypeError);
    // An assembly from the seed is a complete trail.
    expect(await store.importTrail(trail(6), { after: { segment, position: 0n, evidence: chain[0]! } })).toBe(true);
    store.close();
    expect([file.count("chain"), file.count("segment_head")]).toEqual([6, 1]);
  });

  it("keeps nothing of an assembly that does not frame, does not continue, or names no kept position", async () => {
    const store = new EvidenceStore(), tip = { segment, position: 3n, evidence: chain[3]! };
    store.importTrails([trail(3)]);
    const later = fetched(trail(6), 3);
    const other = encodeTrail({ header: segmentBytes({ ...header, sequence: 2n }), terms, records: [] });
    const cases: [Uint8Array, typeof tip][] = [
      [later, { ...tip, evidence: chain[2]! }], // a stated position its chain value is not at
      [later, { ...tip, evidence: b(1) }], // a chain value this store never kept
      [fetched(trail(2), 2), tip], // a count below the kept records: they would trail the frame
      [concat(later, Uint8Array.of(0)), tip], // bytes past the frame
      [later.subarray(0, later.length - 1), tip], // a truncated record
      [concat(other.subarray(0, other.length - 8), later.subarray(other.length - 8)), tip], // another segment's head
    ];
    for (const [bytes, after] of cases) {
      expect(await store.importTrail(bytes, { after })).toBe(false);
      expect(store.importBytes(pack([])).served(expectedAt(4), snapshotAt(4))).toBeUndefined();
    }
    // From the seed, the head must still be of the segment named, and the seed its own.
    expect(await store.importTrail(trail(6), { after: { ...tip, position: 0n, evidence: chain[1]! } })).toBe(false);
    expect(await store.importTrail(other, { after: { ...tip, position: 0n, evidence: chain[0]! } })).toBe(false);
    expect(await store.importTrail(later, { after: tip })).toBe(true);
    await expect(store.importTrail(later, { after: { ...tip, position: -1n } })).rejects.toThrow(TypeError);
    store.close();
  });

  it("keeps each record once for trails sharing a prefix, so a fork costs only its own records", () => {
    const file = evidenceFile(), store = new EvidenceStore(file.path);
    store.importTrails([trail(4)]); store.importTrails([trail(2), trail(4)]); store.importBytes(pack([{ kind: 6, payload: trail(4) }]));
    const forked = [...records.slice(0, 2), issue(9)];
    store.importTrails([trail(0, { records: forked })]);
    const fork = nextEvidenceHash(chain[2]!, evidenceHashes(decodeRecord(forked[2]!)), 3n);
    const batch = store.importBytes(pack([]));
    expect(recordsOf(batch.served(expectedAt(4), snapshotAt(4)))).toEqual(records.slice(0, 4).map(r => [...r]));
    const snapshot = { ...snapshotAt(3), evidenceHash: fork }, served = batch.served({ backing, segment, digest: snapshotDigest(snapshot) }, snapshot)!;
    expect(recordsOf(served)).toEqual(forked.map(r => [...r]));
    store.close();
    expect([file.count("chain"), file.count("segment_head")]).toEqual([5, 1]);
  });

  // The served-trail checks the retired harness check (`verifyTrailEvidence`) asserted, on the runtime path.
  it("serves a trail only as the evidence of its own backing, segment and ordered records", () => {
    const store = new EvidenceStore(), at = (n: number) => store.importBytes(pack([])).served(expectedAt(n), snapshotAt(n));
    const altered = (change: (record: Record) => Record): Uint8Array => encodeRecord(change(decodeRecord(records[0]!)));
    const proofOnly = altered(r => ({ ...r, proof: b(99) }));
    const authorizationOnly = altered(r => { const authorization = Uint8Array.from(r.authorization); authorization[0]! ^= 1; return { ...r, authorization }; });
    // Swapped order, or a record differing only in its proof or authorization, is not the snapshot's evidence.
    store.importTrails([trail(0, { records: [records[1]!, records[0]!] }), trail(0, { records: [proofOnly, records[1]!] }),
      trail(0, { records: [authorizationOnly, records[1]!] })]);
    expect(at(2)).toBeUndefined();
    const swapped = nextEvidenceHash(nextEvidenceHash(chain[0]!, evidenceHashes(decodeRecord(records[1]!)), 1n), evidenceHashes(decodeRecord(records[0]!)), 2n);
    const swappedSnapshot = { ...snapshotAt(2), evidenceHash: swapped };
    expect(recordsOf(store.importBytes(pack([])).served({ backing, segment, digest: snapshotDigest(swappedSnapshot) }, swappedSnapshot)))
      .toEqual([records[1]!, records[0]!].map(r => [...r]));
    store.importTrails([trail(2)]);
    expect(recordsOf(at(2))).toEqual(records.slice(0, 2).map(r => [...r]));
    // The expected backing and segment, and the snapshot's segment, must each be the served one.
    const batch = store.importBytes(pack([]));
    expect(batch.served({ ...expectedAt(2), backing: b(8) }, snapshotAt(2))).toBeUndefined();
    expect(batch.served({ ...expectedAt(2), segment: b(149) }, snapshotAt(2))).toBeUndefined();
    const elsewhere = { ...snapshotAt(2), segment: b(157) };
    expect(batch.served({ ...expectedAt(2), digest: snapshotDigest(elsewhere) }, elsewhere)).toBeUndefined();
    // A head that does not scope the backing serves nothing for it, even at its seed; scoping it, the empty prefix.
    const unscoped: SegmentHeader = { ...header, entries: [{ backing: b(6), link: b(6) }] }, other = segmentIdentity(unscoped);
    store.importTrails([encodeTrail({ header: segmentBytes(unscoped), terms, records: [] })]);
    const seed = { ...snapshotAt(0), segment: other, evidenceHash: genesisEvidenceHash(other) };
    expect(store.importBytes(pack([])).served({ backing, segment: other, digest: snapshotDigest(seed) }, seed)).toBeUndefined();
    expect(at(0)?.length).toBe(0n);
    // Under a head scoping both, a snapshot of one backing is not served as the other's.
    const both: SegmentHeader = { ...header, entries: [{ backing, link: backing }, { backing: b(8), link: b(8) }] }, shared = segmentIdentity(both);
    store.importTrails([encodeTrail({ header: segmentBytes(both), terms: [...terms, ...terms], records: [] })]);
    const own = { ...snapshotAt(0), segment: shared, evidenceHash: genesisEvidenceHash(shared) }, digest = snapshotDigest(own);
    expect(store.importBytes(pack([])).served({ backing: b(8), segment: shared, digest }, own)).toBeUndefined();
    expect(store.importBytes(pack([])).served({ backing, segment: shared, digest }, own)?.length).toBe(0n);
    store.close();
  });

  it("reads a long trail in pages from the seed or from a kept position", () => {
    const store = new EvidenceStore(), many = Array.from({ length: 4100 }, (_, i) => issue(100 + i));
    store.importTrails([trail(0, { records: many })]);
    let value = chain[0]!;
    for (const [i, record] of many.entries()) value = nextEvidenceHash(value, evidenceHashes(decodeRecord(record)), BigInt(i + 1));
    const snapshot = { ...snapshotAt(0), evidenceHash: value }, served = store.importBytes(pack([]))
      .served({ backing, segment, digest: snapshotDigest(snapshot) }, snapshot)!;
    expect(served.length).toBe(4100n);
    expect([...served.records()].map(r => [...r])).toEqual(many.map(r => [...r]));
    expect([...served.records(3n)].map(r => [...r])).toEqual(many.slice(3).map(r => [...r]));
    store.close();
  });

  it("checks retained evidence when it is used: damage reads as absent or unresolved, and a copy supplied again repairs it", () => {
    const file = evidenceFile(), directory = [{ name: backing, digest: snapshotDigest(snapshotAt(4)) }], root = directoryRoot(directory);
    const snapshot = snapshotBytes(snapshotAt(4)), all = pack([{ kind: 3, payload: encodeEvidenceDirectory(directory) }, { kind: 4, payload: snapshot },
      { kind: 6, payload: trail(4) }]);
    const first = new EvidenceStore(file.path); first.importBytes(all); first.close();
    const flipped = (bytes: Uint8Array): Uint8Array => { const out = new Uint8Array(bytes); out[out.length - 1]! ^= 1; return out; };
    type Batch = ReturnType<EvidenceStore["importBytes"]>;
    const unresolved = expect.objectContaining({ status: "unresolved-evidence" });
    /** Damage the file, check what a read then meets, and check that the same evidence supplied again repairs it. */
    const damaged = (damage: () => void, meets: (batch: Batch) => void, healthy: (batch: Batch) => unknown): void => {
      damage();
      let store = new EvidenceStore(file.path);
      meets(store.importBytes(pack([])));
      store.close();
      store = new EvidenceStore(file.path);
      expect(healthy(store.importBytes(all))).toBeDefined();
      store.close();
    };
    const servedAt = (n: number) => (batch: Batch) => batch.served(expectedAt(n), snapshotAt(n));
    const whole = (batch: Batch) => recordsOf(servedAt(4)(batch));
    // A record's bytes: found before that record is given, after the ones before it; nothing is removed.
    damaged(() => file.sql("UPDATE chain SET bytes = ? WHERE evidence = ?", flipped(records[1]!), chain[2]!), batch => {
      const given: Uint8Array[] = [];
      expect(() => { for (const record of servedAt(4)(batch)!.records()) given.push(record); }).toThrow(unresolved);
      expect(given).toEqual([records[0]]);
      // The damaged row is the top of checkpoint 2's trail: it is not served, rather than served shorter.
      expect(servedAt(2)(batch)).toBeUndefined();
    }, whole);
    // The top row's position: not a shorter trail, but none.
    damaged(() => file.sql("UPDATE chain SET position = 0 WHERE evidence = ?", chain[4]!), batch => expect(servedAt(4)(batch)).toBeUndefined(), whole);
    // A chain value under another key, a missing record, a moved position, a changed link read alone.
    damaged(() => file.sql("UPDATE chain SET evidence = ? WHERE position = 3", b(1)), batch => expect(() => whole(batch)).toThrow(unresolved), whole);
    damaged(() => file.sql("DELETE FROM chain WHERE evidence = ?", chain[3]!), batch => expect(() => recordsOf(servedAt(4)(batch), 2n)).toThrow(unresolved), whole);
    damaged(() => file.sql("UPDATE chain SET position = 9 WHERE position = 2"), batch => expect(() => whole(batch)).toThrow(unresolved), whole);
    damaged(() => file.sql("UPDATE chain SET prev = ? WHERE position = 2", b(1)), batch => expect(() => servedAt(4)(batch)!.evidence(2n)).toThrow(unresolved),
      batch => servedAt(4)(batch)!.evidence(2n));
    // A row of this segment under another segment's name serves no trail of this one.
    damaged(() => file.sql("UPDATE chain SET segment = ? WHERE position = 4", b(1)), batch => expect(servedAt(4)(batch)).toBeUndefined(), whole);
    // Objects found by their hash, and the head by its segment, read as absent.
    damaged(() => file.sql("UPDATE object SET payload = ? WHERE kind = 3", flipped(encodeEvidenceDirectory(directory))),
      batch => expect(batch.directory(root)).toBeUndefined(), batch => batch.directory(root));
    damaged(() => file.sql("UPDATE object SET payload = ? WHERE kind = 4", flipped(snapshot)), batch => expect(batch.snapshot(sha256(snapshot))).toBeUndefined(),
      batch => batch.snapshot(sha256(snapshot)));
    damaged(() => file.sql("UPDATE segment_head SET header = ?", flipped(headerBytes)), batch => expect([...batch.heads(segment)]).toEqual([]),
      batch => [...batch.heads(segment)][0]);
  });

  it("keeps a read's own items only while it lasts, and refuses a file of another layout", () => {
    const file = evidenceFile();
    let store = new EvidenceStore(file.path);
    const batch = store.importBytes(pack([{ kind: 1, payload: Uint8Array.of(1) }, { kind: 10, payload: Uint8Array.of(2) }, { kind: 6, payload: trail(1) }]));
    expect([batch.payloads(1), batch.payloads(10)]).toEqual([[Uint8Array.of(1)], [Uint8Array.of(2)]]);
    batch.release();
    expect([batch.payloads(1), batch.count(6), batch.served(expectedAt(1), snapshotAt(1))!.length]).toEqual([[], 0, 1n]);
    // A crashed read's items are gone when the file is opened again.
    store.importBytes(pack([{ kind: 2, payload: Uint8Array.of(3) }]));
    store.close();
    expect(file.count("item")).toBe(1);
    store = new EvidenceStore(file.path); store.close();
    expect(file.count("item")).toBe(0);
    file.sql("PRAGMA user_version = 99");
    expect(() => new EvidenceStore(file.path)).toThrow(new TypeError("the evidence file has another layout"));
  });

  it("serves a trail forward by position, with no walk back before its first record, giving up the turn as it goes", async () => {
    const long = Array.from({ length: 4096 + 5 }, (_, i) => records[i % records.length]!), values = [genesisEvidenceHash(segment)];
    for (const [i, record] of long.entries()) values.push(nextEvidenceHash(values[i]!, evidenceHashes(decodeRecord(record)), BigInt(i + 1)));
    const db = new DatabaseSync(":memory:", { readBigInts: true }), store = new EvidenceStore(db);
    store.importTrails([encodeTrail({ header: headerBytes, terms, records: long })]);
    const full = store.retained().trail(segment, values.at(-1)!)!;
    // Another task's timer: the first record comes before it runs, and it runs as the records go on.
    let turns = 0, running = true;
    const other = (): void => { if (running) { turns++; setImmediate(other); } };
    setImmediate(other);
    const served = full.stream()[Symbol.asyncIterator](), first = await served.next();
    const before = turns, rest: Uint8Array[] = [];
    for (let next = await served.next(); next.done !== true; next = await served.next()) rest.push(next.value);
    running = false;
    expect([before, turns >= 16]).toEqual([0, true]);
    expect([first.value as Uint8Array, ...rest]).toEqual([...full.records()]);
    expect(await collected(full.stream(4096n))).toEqual(long.slice(4096));
    // `reaches` is `through`, giving up the turn on its walk.
    expect([await full.reaches(5n, values[5]!), await full.reaches(5n, values[4]!)]).toEqual([full.through(5n, values[5]!), undefined]);
    expect(await full.reaches(5n, values[5]!)).toBe(BigInt(long.slice(0, 5).reduce((n, r) => n + 4 + r.length, 0)));
    // A kept value lost in the middle: read forward, the records before it are given and the read is then unresolved.
    db.prepare("DELETE FROM chain WHERE evidence = ?").run(values[2000]!);
    const given: Uint8Array[] = [];
    await expect((async () => { for await (const record of full.stream()) given.push(record); })()).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(given).toHaveLength(1999);
    expect(() => [...full.records()]).toThrow(expect.objectContaining({ status: "unresolved-evidence" }));
    db.close();
  }, 60_000);

  it("streams a kept trail after a position its chain passes through, and takes such parts into another store", async () => {
    const supplierDb = new DatabaseSync(":memory:", { readBigInts: true }), supplier = new EvidenceStore(supplierDb);
    const tip = { segment, position: 3n, evidence: chain[3]! };
    // A fork of the same segment after position 3.
    const forked = [...records.slice(0, 3), issue(10), issue(11)], fork = [...chain.slice(0, 4)];
    for (let i = 3; i < 5; i++) fork.push(nextEvidenceHash(fork[i]!, evidenceHashes(decodeRecord(forked[i]!)), BigInt(i + 1)));
    supplier.importTrails([trail(6), trail(0, { records: forked })]);
    const held = supplier.retained(), full = held.trail(segment, chain[6]!)!, sizes = (n: number) => BigInt(records.slice(0, n).reduce((sum, r) => sum + 4 + r.length, 0));
    expect(full.bytes).toBe(sizes(6));
    for (let p = 0; p <= 6; p++) expect(full.through(BigInt(p), chain[p]!)).toBe(sizes(p));
    // Not at that position, never kept, past the cut, and kept at that position on another chain.
    expect([full.through(3n, chain[2]!), full.through(2n, b(1)), full.through(7n, chain[6]!), held.trail(segment, chain[3]!)!.through(4n, chain[4]!),
      full.through(5n, fork[5]!), held.trail(segment, fork[5]!)!.through(5n, chain[5]!), held.trail(segment, fork[5]!)!.through(3n, chain[3]!)])
      .toEqual([undefined, undefined, undefined, undefined, undefined, undefined, sizes(3)]);
    const bytesOf = async (part: EvidencePart | undefined): Promise<Uint8Array> => {
      if (part === undefined || !("trail" in part)) throw new Error("not a trail part");
      const pieces: Uint8Array[] = [];
      for await (const piece of part.trail.chunks) pieces.push(piece);
      expect(part.trail.size).toBe(BigInt(concat(...pieces).length));
      return concat(...pieces);
    };
    // Whole, it is §10's frame; after a position, the head and the later records. The fixture's terms field
    // does not verify, so it was never kept and is served empty.
    const bare = (n: number): Uint8Array => trail(n, { terms: [{ terms: new Uint8Array(), signature: new Uint8Array(64) }] });
    const after = (n: number): Uint8Array => concat(bare(6).subarray(0, bare(0).length), bare(6).subarray(bare(0).length + Number(sizes(n))));
    // Read forward, a fork kept beside the cut is passed by the walk back, at the fork and after it.
    for (const after of [0n, 2n, 3n, 4n, 6n]) expect(await collected(full.stream(after))).toEqual([...full.records(after)]);
    expect(await collected(held.trail(segment, fork[5]!)!.stream())).toEqual(forked);
    expect(await collected(held.trail(segment, fork[5]!)!.stream(4n))).toEqual(forked.slice(4));
    expect(await bytesOf(await trailPart(full))).toEqual(bare(6));
    expect(await bytesOf(await trailPart(full, tip))).toEqual(after(3));
    expect(await bytesOf(await trailPart(full, { segment, position: 6n, evidence: chain[6]! }))).toEqual(after(6));
    expect(await bytesOf(await trailPart(held.trail(segment, chain[0]!)!))).toEqual(bare(0));
    expect(await trailPart(full, { ...tip, evidence: chain[2]! })).toBeUndefined();
    expect(await trailPart(full, { segment, position: 5n, evidence: fork[5]! })).toBeUndefined();

    const snapshot = snapshotBytes(snapshotAt(3)), receiver = new EvidenceStore();
    expect(await receiver.take([{ package: pack([{ kind: 1, payload: Uint8Array.of(1) }, { kind: 4, payload: snapshot }]) }, (await trailPart(held.trail(segment, chain[3]!)!))!])).toBe(true);
    expect(recordsOf(receiver.retained().served(expectedAt(3), snapshotAt(3)))).toEqual(records.slice(0, 3).map(r => [...r]));
    expect(await receiver.take((async function* () { yield (await trailPart(full, tip))!; })())).toBe(true);
    const kept = receiver.retained();
    expect(recordsOf(kept.served(expectedAt(6), snapshotAt(6)))).toEqual(records.map(r => [...r]));
    // A package part's per-read items are dropped at once; its objects stay.
    expect([kept.payloads(1), kept.snapshot(sha256(snapshot))]).toEqual([[], snapshot]);
    // A trail after a position the receiver does not hold is not kept; the other parts are.
    const empty = new EvidenceStore();
    expect(await empty.take([(await trailPart(full, tip))!, { package: pack([{ kind: 4, payload: snapshot }]) }])).toBe(false);
    expect([[...empty.retained().heads(segment)], empty.retained().snapshot(sha256(snapshot))]).toEqual([[], snapshot]);
    // The quota bounds all the parts of one take together, as it bounds one package, rows included: the
    // trail's item row and six record rows (128 + 6 × 192 bytes), and each object's 700 bytes and item row.
    const small = new EvidenceStore(":memory:", { maxBatchBytes: BigInt(bare(6).length) + 1280n + 2n * 828n + 100n });
    const object = (n: number): EvidencePart => ({ package: pack([{ kind: 4, payload: new Uint8Array(700).fill(n) }]) });
    expect(await small.take([(await trailPart(full))!, object(1)])).toBe(true);
    await expect(small.take([(await trailPart(full))!, object(2), object(3), object(4)])).rejects.toThrow(PackageLimitError);
    expect([small.retained().snapshot(sha256(new Uint8Array(700).fill(3))) !== undefined, small.retained().snapshot(sha256(new Uint8Array(700).fill(4)))])
      .toEqual([true, undefined]);
    small.close();
    // A supplier's parts served from nothing are one whole package; a trail after a position is not a frame.
    expect(await wholePackage(pack([{ kind: 1, payload: Uint8Array.of(1) }]), [{ package: pack([{ kind: 4, payload: snapshot }]) },
      { package: pack([{ kind: 4, payload: snapshot }]) }, (await trailPart(full))!]))
      .toEqual(pack([{ kind: 1, payload: Uint8Array.of(1) }, { kind: 4, payload: snapshot }, { kind: 6, payload: bare(6) }]));
    await expect(wholePackage(pack([]), [(await trailPart(full, tip))!])).rejects.toThrow("a whole package takes whole trails");
    // The cut's link at 4 damaged where the fork leaves it: the cut's own records before, then the walk back meets it.
    supplierDb.prepare("UPDATE chain SET prev = ? WHERE evidence = ?").run(b(1), chain[4]!);
    const given: Uint8Array[] = [];
    await expect((async () => { for await (const record of full.stream()) given.push(record); })()).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(given).toEqual(records.slice(0, 3));
    // The cut's row at 4 lost: the fork's lone row there is a genuine step, but the walk back from the cut's top
    // meets another value at 4, so nothing of the cut is spliced after it.
    supplierDb.prepare("UPDATE chain SET prev = ? WHERE evidence = ?").run(chain[3]!, chain[4]!);
    supplierDb.prepare("DELETE FROM chain WHERE evidence = ?").run(chain[4]!);
    given.length = 0;
    await expect((async () => { for await (const record of full.stream()) given.push(record); })()).rejects.toMatchObject({ status: "unresolved-evidence" });
    expect(given).toEqual([...records.slice(0, 3), forked[3]]);
    await expect((async () => { for await (const record of full.stream(4n)) given.push(record); })()).rejects.toMatchObject({ status: "unresolved-evidence" });
    for (const store of [receiver, empty]) store.close();
    supplierDb.close();
  });

  it("records the sequence each supplier's evidence was kept through, in the file that holds the evidence", () => {
    const file = evidenceFile();
    let store = new EvidenceStore(file.path);
    expect(store.suppliedThrough(b(1))).toBe(0n);
    store.supplied(b(1), 7n); store.supplied(b(2), 1n);
    store.close(); store = new EvidenceStore(file.path);
    expect([store.suppliedThrough(b(1)), store.suppliedThrough(b(2)), store.suppliedThrough(b(3))]).toEqual([7n, 1n, 0n]);
    store.supplied(b(1), 5n);
    expect(store.suppliedThrough(b(1))).toBe(5n);
    for (const sequence of [-1n, 1n << 63n, 1 as unknown as bigint]) expect(() => store.supplied(b(1), sequence)).toThrow(TypeError);
    store.close();
  });
});
