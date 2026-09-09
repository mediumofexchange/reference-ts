import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import * as c from "../model/pool-v3-commitments.js";
import { deliveryHash, encodeRecord, evidenceHashes, hashEvidenceFields, statementBytes, statementHash,
  type EvidenceDigests, type Record as StatementRecord } from "../model/pool-v3-records.js";
import { EncodingError } from "../src/bytes.js";
import * as contexts from "../src/contexts.js";
import { directoryRoot, signCommitment, verifyCommitment } from "../src/commitment.js";
import { FIELD_MODULUS, limbsOf } from "../src/pool/field.js";
import { verifySignatureStrict } from "../src/keys.js";

// Independent framing oracle. Roots, domains and proof bytes are synthetic;
// Ed25519 signatures are real. No fixture claims valid state, proof or finality.
const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const ascii = (s: string): Buffer => Buffer.from(`moe/pool/v3/${s}`, "ascii");
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const sha = (b: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha256").update(b).digest());
const domain = bytes(17), segment = bytes(19), backing = bytes(23), operatorSecret = bytes(29), backerSecret = bytes(31);
const operator = ed25519.getPublicKey(operatorSecret), backer = ed25519.getPublicKey(backerSecret);
const max = (1n << 64n) - 1n;
const triple = (n: number): EvidenceDigests => ({ statementHash: bytes(n), proofHash: bytes(n + 1), signatureHash: bytes(n + 2) });
const eq = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
function rawEvidence(previous: Uint8Array, e: EvidenceDigests, position: bigint): Uint8Array {
  return sha(cat(ascii("evidence-link"), previous, e.statementHash, e.proofHash, e.signatureHash, integer(position, 8)));
}
function rawHistory(previous: Uint8Array, statement: Uint8Array, note: bigint, spent: Uint8Array, i: bigint): Uint8Array {
  return sha(cat(ascii("history"), previous, statement, integer(note, 32), spent, integer(i, 8)));
}
function rawSnapshot(s: c.Snapshot): Buffer {
  return cat(ascii("snapshot"), s.backing, s.segment, s.historyHash, s.evidenceHash, integer(s.issued, 8), integer(s.burned, 8));
}
function rawReceipt(r: c.ReceiptFields): Buffer {
  return cat(ascii("receipt"), r.domain, r.segment, integer(r.scopeRoot, 32), integer(r.position, 8),
    r.statementHash, r.historyHash, r.proofHash, r.signatureHash, integer(r.after, 8));
}
function snapshot(evidenceHash = bytes(37)): c.Snapshot {
  return { backing, segment, historyHash: bytes(41), evidenceHash, issued: 100n, burned: 10n };
}
function receipt(fields: Partial<c.ReceiptFields> = {}): c.Receipt {
  const r = { domain, segment, scopeRoot: 43n, position: 2n, ...triple(47), historyHash: bytes(53), after: 1n, ...fields };
  return { ...r, operator, signature: ed25519.sign(rawReceipt(r), operatorSecret) };
}
const authority = { domain, segment, scopeRoot: 43n, operator };
function issue(): StatementRecord {
  const capsule = new Uint8Array(89).fill(3); capsule[0] = 1;
  const record: StatementRecord = { domain, kind: 1,
    publicInputs: [...limbsOf(domain), ...limbsOf(segment), 43n, ...limbsOf(backing), 100n, 59n,
      ...limbsOf(deliveryHash(domain, [59n], [capsule]))],
    proof: bytes(61), authorization: new Uint8Array(64), capsules: [capsule] };
  return { ...record, authorization: ed25519.sign(statementBytes(record), backerSecret) };
}
function suffixFixture() {
  const events = [triple(3), triple(7), triple(11)], seed = sha(cat(ascii("evidence-seed"), segment));
  const before = [seed];
  for (let i = 0; i < events.length; i++) before.push(rawEvidence(before[i]!, events[i]!, BigInt(i + 1)));
  const s = snapshot(before[3]!);
  const opening = (position: number): c.EvidenceOpening => ({ position: BigInt(position), length: 3n,
    previous: before[position - 1]!, target: events[position - 1]!, suffix: events.slice(position) });
  return { events, before, s, digest: sha(rawSnapshot(s)), opening };
}

describe("v3 commitment frames", () => {
  it("matches independent seeds, recurrences and snapshot bytes", () => {
    const h0 = sha(cat(ascii("genesis"), segment)), e0 = sha(cat(ascii("evidence-seed"), segment)), event = triple(67);
    expect(c.genesisHistoryHash(segment)).toEqual(h0);
    expect(c.genesisEvidenceHash(segment)).toEqual(e0);
    expect(h0).not.toEqual(e0);
    const h1 = rawHistory(h0, event.statementHash, 71n, bytes(73), 1n), e1 = rawEvidence(e0, event, 1n);
    expect(c.nextHistoryHash(h0, event.statementHash, 71n, bytes(73), 1n)).toEqual(h1);
    expect(c.nextEvidenceHash(e0, event, 1n)).toEqual(e1);
    const s = { ...snapshot(e1), historyHash: h1 };
    expect(Buffer.from(c.snapshotBytes(s))).toEqual(rawSnapshot(s));
    expect(c.snapshotDigest(s)).toEqual(sha(rawSnapshot(s)));
    expect(c.snapshotBytes(s).length).toBe(164);
  });
  it("commits every recurrence field and still advances on unchanged roots", () => {
    const e = triple(3), prev = bytes(7), baseline = c.nextEvidenceHash(prev, e, 1n);
    for (const key of ["statementHash", "proofHash", "signatureHash"] as const) {
      expect(c.nextEvidenceHash(prev, { ...e, [key]: bytes(83) }, 1n)).not.toEqual(baseline);
    }
    expect(c.nextEvidenceHash(bytes(89), e, 1n)).not.toEqual(baseline);
    expect(c.nextEvidenceHash(prev, e, 2n)).not.toEqual(baseline);
    const original = c.nextHistoryHash(prev, e.statementHash, 11n, bytes(13), 1n);
    const variants = [c.nextHistoryHash(bytes(17), e.statementHash, 11n, bytes(13), 1n),
      c.nextHistoryHash(prev, bytes(19), 11n, bytes(13), 1n), c.nextHistoryHash(prev, e.statementHash, 23n, bytes(13), 1n),
      c.nextHistoryHash(prev, e.statementHash, 11n, bytes(29), 1n), c.nextHistoryHash(prev, e.statementHash, 11n, bytes(13), 2n),
      c.nextHistoryHash(original, e.statementHash, 11n, bytes(13), 2n)];
    for (const changed of variants) expect(changed).not.toEqual(original);
  });
  it("frames invalid supply for authentication, without allowing integer wrap or malformed roots", () => {
    const invalid = { ...snapshot(), issued: 0n, burned: max };
    expect(c.snapshotDigest(invalid)).toEqual(sha(rawSnapshot(invalid)));
    expect(Buffer.from(c.snapshotBytes(c.decodeSnapshot(rawSnapshot(invalid))))).toEqual(rawSnapshot(invalid));
    for (const n of [-1n, 1n << 64n, 1 as unknown as bigint]) {
      expect(() => c.snapshotBytes({ ...snapshot(), issued: n })).toThrow(EncodingError);
      expect(() => c.snapshotBytes({ ...snapshot(), burned: n })).toThrow(EncodingError);
    }
    for (const n of [0n, -1n, 1n << 64n, 1 as unknown as bigint]) {
      expect(() => c.nextHistoryHash(bytes(1), bytes(2), 0n, bytes(3), n)).toThrow(EncodingError);
      expect(() => c.nextEvidenceHash(bytes(1), triple(2), n)).toThrow(EncodingError);
    }
    expect(() => c.nextEvidenceHash(bytes(1), triple(2), max)).not.toThrow();
    expect(() => c.nextHistoryHash(bytes(1), bytes(2), FIELD_MODULUS - 1n, bytes(3), max)).not.toThrow();
    expect(() => c.nextHistoryHash(bytes(1), bytes(2), FIELD_MODULUS, bytes(3), 1n)).toThrow(EncodingError);
  });
  it("rejects every truncated snapshot/receipt prefix, context substitution and trailing bytes", () => {
    const r = receipt(), pairs = [ [rawSnapshot(snapshot()), c.decodeSnapshot],
      [cat(rawReceipt(r), r.operator, r.signature), c.decodeReceipt] ] as const;
    for (const [bytes, decode] of pairs) {
      for (let i = 0; i < bytes.length; i++) expect(() => decode(bytes.subarray(0, i))).toThrow(EncodingError);
      expect(() => decode(cat(bytes, Uint8Array.of(0)))).toThrow(EncodingError);
      const v2 = Buffer.from(bytes); v2[10] = 50;
      expect(() => decode(v2)).toThrow(EncodingError);
    }
    const b = cat(rawReceipt(r), r.operator, r.signature);
    b.set(integer(0n, 8), 19 + 96);
    expect(() => c.decodeReceipt(b)).toThrow(EncodingError);
    b.set(integer(1n, 8), 19 + 96); b.set(integer(FIELD_MODULUS, 32), 19 + 64);
    expect(() => c.decodeReceipt(b)).toThrow(EncodingError);
  });
  it("owns Buffer-decoded arrays and raw evidence hashes", () => {
    const s = rawSnapshot(snapshot()), first = c.decodeSnapshot(s), second = c.decodeSnapshot(s), expected = Buffer.from(s);
    s.fill(0); first.backing.fill(0); first.segment.fill(0); first.historyHash.fill(0); first.evidenceHash.fill(0);
    expect(Buffer.from(c.snapshotBytes(second))).toEqual(expected);
    const source = receipt(), raw = cat(rawReceipt(source), source.operator, source.signature);
    const a = c.decodeReceipt(raw), b = c.decodeReceipt(raw), saved = Buffer.from(raw); raw.fill(0);
    for (const value of Object.values(a)) if (value instanceof Uint8Array) value.fill(0);
    expect(Buffer.from(c.encodeReceipt(b))).toEqual(saved);
    const sh = bytes(1), proof = bytes(2), auth = bytes(3), hashed = hashEvidenceFields(sh, proof, auth);
    const want = { statementHash: Uint8Array.from(sh), proofHash: sha(proof), signatureHash: sha(auth) };
    sh.fill(0); proof.fill(0); auth.fill(0); expect(hashed).toEqual(want);
  });
});

describe("authentication without a validity verdict", () => {
  it("distinguishes operator-committed failing authorization from replica substitution", () => {
    const good = issue(), bad = { ...good, authorization: new Uint8Array(64) };
    expect(verifySignatureStrict(good.authorization, statementBytes(good), backer)).toBe(true);
    expect(verifySignatureStrict(bad.authorization, statementBytes(bad), backer)).toBe(false);
    expect(statementHash(good)).toEqual(statementHash(bad));
    const seed = c.genesisEvidenceHash(segment), original = evidenceHashes(good), failing = evidenceHashes(bad);
    const history = c.nextHistoryHash(c.genesisHistoryHash(segment), original.statementHash, 101n, bytes(103), 1n);
    const goodSnapshot = { ...snapshot(c.nextEvidenceHash(seed, original, 1n)), historyHash: history };
    const badSnapshot = { ...goodSnapshot, evidenceHash: c.nextEvidenceHash(seed, failing, 1n) };
    const opening = (target: EvidenceDigests): c.EvidenceOpening => ({ position: 1n, length: 1n, previous: seed, target, suffix: [] });
    const directory = [{ name: backing, digest: c.snapshotDigest(goodSnapshot) }];
    const signed = signCommitment(operatorSecret, 2n, directoryRoot(directory));
    expect(verifyCommitment(signed)).toBe(true);
    expect(eq(directoryRoot(directory), signed.root)).toBe(true);
    expect(c.verifyEvidenceOpening(directory[0]!.digest, goodSnapshot, opening(original))).toBe(true);
    expect(c.verifyEvidenceOpening(directory[0]!.digest, goodSnapshot, opening(failing))).toBe(false);
    expect(c.verifyEvidenceOpening(directory[0]!.digest, badSnapshot, opening(failing))).toBe(false);
    const badDirectory = [{ name: backing, digest: c.snapshotDigest(badSnapshot) }];
    const badCommitment = signCommitment(operatorSecret, 3n, directoryRoot(badDirectory));
    expect(verifyCommitment(badCommitment)).toBe(true);
    expect(c.verifyEvidenceOpening(badDirectory[0]!.digest, badSnapshot, opening(failing))).toBe(true);
    // The signature failure is authenticated; no full checkpoint class is
    // asserted without proof/state/import/time/record-prefix evidence.
  });
  it("hashes actual malformed-length fields while strict record decoding still refuses them", () => {
    const s = issue(), sh = statementHash(s);
    for (const [proof, authorization] of [[new Uint8Array(0), new Uint8Array(0)],
      [new Uint8Array(31).fill(5), new Uint8Array(65).fill(7)]] as const) {
      expect(() => encodeRecord({ ...s, proof, authorization })).toThrow(EncodingError);
      const target = hashEvidenceFields(sh, proof, authorization);
      expect(target.proofHash).toEqual(proof.length ? sha(proof) : bytes(0));
      expect(target.signatureHash).toEqual(authorization.length ? sha(authorization) : bytes(0));
      const previous = c.genesisEvidenceHash(segment), snap = snapshot(c.nextEvidenceHash(previous, target, 1n));
      expect(c.verifyEvidenceOpening(c.snapshotDigest(snap), snap, { position: 1n, length: 1n, previous, target, suffix: [] })).toBe(true);
    }
    expect(sha(new Uint8Array(0))).not.toEqual(bytes(0));
    expect(() => hashEvidenceFields(sh, undefined as unknown as Uint8Array, new Uint8Array(0))).toThrow(EncodingError);
    expect(() => hashEvidenceFields(sh, new Uint8Array(0), undefined as unknown as Uint8Array)).toThrow(EncodingError);
  });
  it("proof variants keep statement/history identity but change evidence, snapshot and receipt comparison", () => {
    const a = issue(), b = { ...a, proof: bytes(109) }, ea = evidenceHashes(a), eb = evidenceHashes(b);
    expect(ea.statementHash).toEqual(eb.statementHash);
    const h = c.nextHistoryHash(c.genesisHistoryHash(segment), ea.statementHash, 113n, bytes(127), 1n);
    expect(c.nextHistoryHash(c.genesisHistoryHash(segment), eb.statementHash, 113n, bytes(127), 1n)).toEqual(h);
    const sa = snapshot(c.nextEvidenceHash(c.genesisEvidenceHash(segment), ea, 1n));
    const sb = snapshot(c.nextEvidenceHash(c.genesisEvidenceHash(segment), eb, 1n));
    expect(c.snapshotDigest(sa)).not.toEqual(c.snapshotDigest(sb));
    const r = receipt({ ...ea, position: 1n, historyHash: h });
    expect(c.verifyReceipt(authority, r)).toBe(true);
    expect(c.receiptMatchesEvent(r, { ...ea, position: 1n, historyHash: h })).toBe(true);
    expect(c.receiptMatchesEvent(r, { ...eb, position: 1n, historyHash: h })).toBe(false);
  });
  it("adopts exact source evidence at a new segment/position without a source-binding equality check", () => {
    // Withdrawal is eligible for adoption; its original presenter signs the
    // source-segment statement, while the adopter signs the new receipt.
    const unsigned: StatementRecord = { domain, kind: 5,
      publicInputs: [...limbsOf(domain), ...limbsOf(segment), 43n, ...limbsOf(bytes(129))],
      proof: new Uint8Array(0), authorization: new Uint8Array(64), capsules: [] };
    const signedBytes = cat(ascii("withdrawal"), domain, statementHash(unsigned));
    const source = { ...unsigned, authorization: ed25519.sign(signedBytes, backerSecret) };
    expect(verifySignatureStrict(source.authorization, signedBytes, backer)).toBe(true);
    const before = encodeRecord(source), target = evidenceHashes(source);
    const adopter = bytes(131), prefix = c.nextEvidenceHash(c.genesisEvidenceHash(adopter), triple(137), 1n);
    const end = c.nextEvidenceHash(prefix, target, 2n), s = { ...snapshot(end), segment: adopter };
    expect(c.verifyEvidenceOpening(c.snapshotDigest(s), s, { position: 2n, length: 2n, previous: prefix, target, suffix: [] })).toBe(true);
    const r = receipt({ ...target, segment: adopter, position: 2n, after: 7n });
    expect(c.verifyReceipt({ ...authority, segment: adopter }, r)).toBe(true);
    expect(c.verifyReceipt(authority, r)).toBe(false);
    expect(c.receiptMatchesEvent(r, { ...target, position: 2n, historyHash: r.historyHash })).toBe(true);
    expect(encodeRecord(source)).toEqual(before);
    expect(c.nextEvidenceHash(c.genesisEvidenceHash(segment), target, 1n)).not.toEqual(end);
  });
});

describe("evidence suffix and receipt boundaries", () => {
  it("authenticates first, interior and terminal positions without replaying the prefix", () => {
    const f = suffixFixture();
    for (const i of [1, 2, 3]) expect(c.verifyEvidenceOpening(f.digest, f.s, f.opening(i))).toBe(true);
  });
  it("rejects changed snapshot fields, target fields, preceding hash and suffix contents/order", () => {
    const f = suffixFixture(), o = f.opening(1);
    for (const key of ["backing", "segment", "historyHash", "evidenceHash"] as const) {
      expect(c.verifyEvidenceOpening(f.digest, { ...f.s, [key]: bytes(149) }, o)).toBe(false);
    }
    for (const key of ["issued", "burned"] as const) expect(c.verifyEvidenceOpening(f.digest, { ...f.s, [key]: 151n }, o)).toBe(false);
    expect(c.verifyEvidenceOpening(bytes(157), f.s, o)).toBe(false);
    for (const key of ["statementHash", "proofHash", "signatureHash"] as const) {
      expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, target: { ...o.target, [key]: bytes(163) } })).toBe(false);
      const suffix = [...o.suffix]; suffix[0] = { ...suffix[0]!, [key]: bytes(167) };
      expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, suffix })).toBe(false);
    }
    expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, suffix: [...o.suffix].reverse() })).toBe(false);
    expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, previous: bytes(173) })).toBe(false);
    const wrongPrevious = bytes(179);
    const forgedFirst = snapshot(c.nextEvidenceHash(wrongPrevious, o.target, 1n));
    // Even a matching terminal cannot legitimize a non-seed at position one.
    expect(c.verifyEvidenceOpening(c.snapshotDigest(forgedFirst), forgedFirst,
      { position: 1n, length: 1n, previous: wrongPrevious, target: o.target, suffix: [] })).toBe(false);
  });
  it("requires consecutive positions, exact suffix length and u64 bounds without allocating from claims", () => {
    const f = suffixFixture(), o = f.opening(1);
    for (const change of [{ position: 0n }, { position: -1n }, { position: 2n }, { length: 0n }, { length: 2n },
      { length: max }, { length: max + 1n }, { suffix: o.suffix.slice(1) }, { suffix: [...o.suffix, triple(181)] }]) {
      expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, ...change })).toBe(false);
    }
    const sparse = [...o.suffix]; delete sparse[0];
    expect(c.verifyEvidenceOpening(f.digest, f.s, { ...o, suffix: sparse })).toBe(false);
    const previous = bytes(191), target = triple(193), s = snapshot(c.nextEvidenceHash(previous, target, max));
    expect(c.verifyEvidenceOpening(c.snapshotDigest(s), s, { position: max, length: max, previous, target, suffix: [] })).toBe(true);
    expect(c.verifyEvidenceOpening(c.snapshotDigest(s), s, { position: max, length: max + 1n, previous, target, suffix: [target] })).toBe(false);
  });
  it("matches exact receipt bytes, verifies strict signatures, and binds every signed field and authority", () => {
    const r = receipt();
    expect(Buffer.from(c.receiptBytes(r))).toEqual(rawReceipt(r));
    expect(c.receiptBytes(r).length).toBe(259);
    expect(Buffer.from(c.encodeReceipt(r))).toEqual(cat(rawReceipt(r), operator, r.signature));
    expect(c.encodeReceipt(r).length).toBe(355);
    expect(c.verifyReceipt(authority, r)).toBe(true);
    for (const key of ["domain", "segment", "statementHash", "historyHash", "proofHash", "signatureHash", "operator"] as const) {
      expect(c.verifyReceipt(authority, { ...r, [key]: bytes(197) })).toBe(false);
    }
    for (const key of ["scopeRoot", "position", "after"] as const) expect(c.verifyReceipt(authority, { ...r, [key]: r[key] + 1n })).toBe(false);
    for (const key of ["domain", "segment", "operator"] as const) expect(c.verifyReceipt({ ...authority, [key]: bytes(199) }, r)).toBe(false);
    expect(c.verifyReceipt({ ...authority, scopeRoot: 0n }, r)).toBe(false);
    expect(c.verifyReceipt(authority, { ...r, signature: new Uint8Array(64) })).toBe(false);
    expect(c.verifyReceipt({ ...authority, operator: bytes(0) }, { ...r, operator: bytes(0), signature: new Uint8Array(64) })).toBe(false);
    expect(c.verifyReceipt(authority, { ...r, signature: ed25519.sign(sha(rawReceipt(r)), operatorSecret) })).toBe(false);
    for (const after of [0n, max]) expect(c.verifyReceipt(authority, receipt({ after, position: max }))).toBe(true);
    expect(c.receiptMatchesEvent(r, r)).toBe(true);
    for (const key of ["statementHash", "historyHash", "proofHash", "signatureHash"] as const) expect(c.receiptMatchesEvent(r, { ...r, [key]: bytes(211) })).toBe(false);
    expect(c.receiptMatchesEvent(r, { ...r, position: r.position + 1n })).toBe(false);
  });
  it("returns false for malformed verification inputs but preserves unexpected programming failures", () => {
    const f = suffixFixture();
    for (const bad of [undefined, null, {}, "x", new Uint8ClampedArray(32)]) {
      expect(c.verifyReceipt(bad as c.ReceiptAuthority, receipt())).toBe(false);
      expect(c.verifyReceipt(authority, bad as c.Receipt)).toBe(false);
      expect(c.receiptMatchesEvent(receipt(), bad as c.Receipt)).toBe(false);
      expect(c.verifyEvidenceOpening(f.digest, bad as c.Snapshot, f.opening(1))).toBe(false);
      expect(c.verifyEvidenceOpening(f.digest, f.s, bad as c.EvidenceOpening)).toBe(false);
      expect(() => c.decodeReceipt(bad as Uint8Array)).toThrow(EncodingError);
      expect(() => c.decodeSnapshot(bad as Uint8Array)).toThrow(EncodingError);
    }
    for (const bad of [new Uint8Array(31), "x".repeat(32), new Uint8ClampedArray(32)]) {
      expect(c.verifyEvidenceOpening(bad as unknown as Uint8Array, f.s, f.opening(1))).toBe(false);
      expect(() => c.snapshotBytes({ ...f.s, backing: bad as unknown as Uint8Array })).toThrow(EncodingError);
    }
    const failure = new Error("programming failure"), broken = { get position(): bigint { throw failure; } };
    expect(() => c.verifyEvidenceOpening(f.digest, f.s, broken as c.EvidenceOpening)).toThrow(failure);
    expect(() => c.verifyReceipt(authority, { ...receipt(), get position(): bigint { throw failure; } })).toThrow(failure);
  });
  it("keeps all new contexts prefix-free with the existing construction contexts", () => {
    const tags = Object.values(contexts).filter((v): v is Uint8Array => v instanceof Uint8Array);
    for (const name of ["genesis", "history", "evidence-seed", "evidence-link", "snapshot", "receipt",
      "statement", "acceptance", "release", "withdrawal", "publication", "delivery", "spent/empty", "spent/leaf", "spent/node"]) tags.push(ascii(name));
    expect(contexts.contextsArePrefixFree(tags)).toBe(true);
  });
});
