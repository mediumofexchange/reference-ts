import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import * as f from "../model/pool-v3-fault-evidence.js";
import * as c from "../model/pool-v3-commitments.js";
import { deliveryHash, statementBytes, type EvidenceDigests, type Record as StatementRecord } from "../model/pool-v3-records.js";
import { EncodingError } from "../src/bytes.js";
import { directoryRoot, signCommitment, verifyCommitment } from "../src/commitment.js";
import { limbsOf } from "../src/pool/field.js";

// Independent Buffer/node:crypto wire oracle. Domains, roots, statements and
// proofs are synthetic; Ed25519 signatures and signed-directory context are real.
// Authentication below makes no claim about proof validity or fault class.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const cat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const ascii = (s: string): Buffer => Buffer.from(`moe/pool/v3/${s}`, "ascii");
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const u32 = (n: number): Buffer => integer(BigInt(n), 4);
const sha = (value: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha256").update(value).digest());
const zero = (): Uint8Array => new Uint8Array(32);
const eq = (a: Uint8Array, d: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(d));
const max = (1n << 64n) - 1n;
const domain = b(11), segment = b(13), backing = b(17), operatorSecret = b(19), backerSecret = b(23);
const operator = ed25519.getPublicKey(operatorSecret);

function digestFields(statement: Uint8Array, proof: Uint8Array, authorization: Uint8Array): EvidenceDigests {
  return { statementHash: sha(statement), proofHash: proof.length === 0 ? zero() : sha(proof),
    signatureHash: authorization.length === 0 ? zero() : sha(authorization) };
}
function rawSnapshot(s: c.Snapshot): Buffer {
  return cat(ascii("snapshot"), s.backing, s.segment, s.historyHash, s.evidenceHash,
    integer(s.issued, 8), integer(s.burned, 8));
}
function rawLink(previous: Uint8Array, target: EvidenceDigests, position: bigint): Uint8Array {
  return sha(cat(ascii("evidence-link"), previous, target.statementHash, target.proofHash,
    target.signatureHash, integer(position, 8)));
}
function rawEvidence(e: f.FaultEvidence): Buffer {
  return cat(ascii("fault-evidence"), rawSnapshot(e.snapshot), integer(e.position, 8), integer(e.length, 8), e.previous,
    u32(e.statement.length), e.statement, u32(e.proof.length), e.proof, u32(e.authorization.length), e.authorization,
    ...e.suffix.map(x => cat(x.statementHash, x.proofHash, x.signatureHash)));
}
function validIssue(): { statement: Uint8Array; proof: Uint8Array; authorization: Uint8Array } {
  const capsule = new Uint8Array(89).fill(29); capsule[0] = 1;
  const unsigned: StatementRecord = { domain, kind: 1,
    publicInputs: [...limbsOf(domain), ...limbsOf(segment), 31n, ...limbsOf(backing), 7n, 37n,
      ...limbsOf(deliveryHash(domain, [37n], [capsule]))],
    proof: b(41), authorization: new Uint8Array(64), capsules: [capsule] };
  const statement = statementBytes(unsigned);
  return { statement, proof: unsigned.proof, authorization: ed25519.sign(statement, backerSecret) };
}
function fixture() {
  const targets = [validIssue(),
    { statement: Uint8Array.of(0xff, 0, 7), proof: new Uint8Array(31).fill(43), authorization: new Uint8Array(65).fill(47) },
    { statement: new Uint8Array(0), proof: new Uint8Array(0), authorization: new Uint8Array(0) }];
  const triples = targets.map(x => digestFields(x.statement, x.proof, x.authorization));
  const before = [sha(cat(ascii("evidence-seed"), segment))];
  for (let i = 0; i < triples.length; i++) before.push(rawLink(before[i]!, triples[i]!, BigInt(i + 1)));
  const snapshot: c.Snapshot = { backing, segment, historyHash: b(53), evidenceHash: before[3]!, issued: 5n, burned: 9n };
  const digest = sha(rawSnapshot(snapshot));
  const evidence = (i: number): f.FaultEvidence => ({ snapshot, position: BigInt(i), length: 3n, previous: before[i - 1]!,
    ...targets[i - 1]!, suffix: triples.slice(i) });
  return { targets, triples, before, snapshot, digest, evidence };
}

describe("v3 portable fault evidence", () => {
  it("matches an independent exact-byte oracle at every target position", () => {
    const x = fixture();
    for (const position of [1, 2, 3]) {
      const evidence = x.evidence(position), expected = rawEvidence(evidence);
      expect(expected.length).toBe(250 + evidence.statement.length + evidence.proof.length + evidence.authorization.length
        + 96 * evidence.suffix.length);
      expect(Buffer.from(f.encodeFaultEvidence(evidence, 2n))).toEqual(expected);
      expect(Buffer.from(f.encodeFaultEvidence(f.decodeFaultEvidence(expected, 2n), 2n))).toEqual(expected);
    }
  });

  it("distinguishes SHA256(empty statement) from empty proof and authorization sentinels", () => {
    const evidence = fixture().evidence(3), target = digestFields(evidence.statement, evidence.proof, evidence.authorization);
    expect(target.statementHash).toEqual(sha(new Uint8Array(0)));
    expect(target.statementHash).not.toEqual(zero());
    expect(target.proofHash).toEqual(zero());
    expect(target.signatureHash).toEqual(zero());
    expect(f.verifyFaultEvidence({ backing, segment, digest: fixture().digest }, evidence, 0n)).toBe(true);
  });

  it("authenticates valid and malformed committed target bytes in a real signed directory", () => {
    const x = fixture(), directory = [{ name: backing, digest: x.digest }];
    const commitment = signCommitment(operatorSecret, 7n, directoryRoot(directory));
    expect(verifyCommitment(commitment)).toBe(true);
    expect(eq(commitment.operator, operator)).toBe(true);
    expect(eq(commitment.root, directoryRoot(directory))).toBe(true);
    const expected = { backing: directory[0]!.name, segment, digest: directory[0]!.digest };
    expect(f.verifyFaultEvidence(expected, x.evidence(1), 2n)).toBe(true); // well-framed, actually signed target
    expect(f.verifyFaultEvidence(expected, x.evidence(2), 1n)).toBe(true); // deliberately ill-framed raw fields
    for (const key of ["statement", "proof", "authorization"] as const) {
      const original = x.evidence(2), replacement = Uint8Array.from(original[key]);
      replacement[0] = replacement[0]! ^ 1;
      expect(f.verifyFaultEvidence(expected, { ...original, [key]: replacement }, 1n)).toBe(false);
    }
    for (const key of ["statementHash", "proofHash", "signatureHash"] as const) {
      const original = x.evidence(1), suffix = [...original.suffix];
      suffix[0] = { ...suffix[0]!, [key]: b(61) };
      expect(f.verifyFaultEvidence(expected, { ...original, suffix }, 2n)).toBe(false);
    }
    const original = x.evidence(2);
    expect(f.verifyFaultEvidence(expected, { ...original, previous: b(67) }, 1n)).toBe(false);
    expect(f.verifyFaultEvidence({ ...expected, backing: b(71) }, original, 1n)).toBe(false);
    expect(f.verifyFaultEvidence({ ...expected, segment: b(73) }, original, 1n)).toBe(false);
    expect(f.verifyFaultEvidence({ ...expected, digest: b(79) }, original, 1n)).toBe(false);
    const first = x.evidence(1), wrongPrevious = b(81), target = digestFields(first.statement, first.proof, first.authorization);
    let forgedEnd = rawLink(wrongPrevious, target, 1n);
    for (let i = 0; i < first.suffix.length; i++) forgedEnd = rawLink(forgedEnd, first.suffix[i]!, BigInt(i + 2));
    const forgedSnapshot = { ...first.snapshot, evidenceHash: forgedEnd };
    expect(f.verifyFaultEvidence({ backing, segment, digest: sha(rawSnapshot(forgedSnapshot)) },
      { ...first, previous: wrongPrevious, snapshot: forgedSnapshot }, 2n)).toBe(false);
  });

  it("rejects contexts, every truncation, trailing bytes and index-derived count attacks", () => {
    const encoded = rawEvidence(fixture().evidence(2));
    for (let i = 0; i < encoded.length; i++) expect(() => f.decodeFaultEvidence(encoded.subarray(0, i), 1n)).toThrow(EncodingError);
    expect(() => f.decodeFaultEvidence(cat(encoded, Uint8Array.of(0)), 1n)).toThrow(EncodingError);
    for (const offset of [0, 26]) {
      const changed = Buffer.from(encoded); changed[offset] = changed[offset]! ^ 1;
      expect(() => f.decodeFaultEvidence(changed, 1n)).toThrow(EncodingError);
    }
    for (const [position, length] of [[0n, 3n], [3n, 2n], [2n, 4n], [1n, max]] as const) {
      const changed = Buffer.from(encoded); changed.set(integer(position, 8), 190); changed.set(integer(length, 8), 198);
      expect(() => f.decodeFaultEvidence(changed, max)).toThrow(EncodingError);
    }
  });

  it("checks suffix budget and exact remaining length before copying any target or suffix", () => {
    const encoded = rawEvidence(fixture().evidence(1));
    const copies = vi.spyOn(Buffer.prototype, "subarray");
    try {
      expect(() => f.decodeFaultEvidence(encoded, 1n)).toThrow(f.FaultEvidenceLimitError);
      expect(copies).not.toHaveBeenCalled();
      const missing = encoded.subarray(0, encoded.length - 1); copies.mockClear();
      expect(() => f.decodeFaultEvidence(missing, 2n)).toThrow(EncodingError);
      expect(copies).not.toHaveBeenCalled();
    } finally { copies.mockRestore(); }
    let touched = false;
    const overBudget = { ...fixture().evidence(1), get statement(): Uint8Array { touched = true; throw new Error("copied target"); } };
    expect(() => f.encodeFaultEvidence(overBudget, 1n)).toThrow(f.FaultEvidenceLimitError);
    expect(touched).toBe(false);
  });

  it("keeps local refusal separate from malformed data and failed authentication", () => {
    const evidence = fixture().evidence(1), encoded = rawEvidence(evidence), expected = { backing, segment, digest: fixture().digest };
    for (const action of [() => f.encodeFaultEvidence(evidence, 1n), () => f.decodeFaultEvidence(encoded, 1n),
      () => f.verifyFaultEvidence(expected, evidence, 1n)]) {
      expect(action).toThrow(f.FaultEvidenceLimitError);
      expect(action).not.toThrow(EncodingError);
    }
    for (const budget of [-1n, max + 1n, 2 as unknown as bigint]) {
      expect(() => f.encodeFaultEvidence(evidence, budget)).toThrow(EncodingError);
      expect(() => f.decodeFaultEvidence(encoded, budget)).toThrow(EncodingError);
      expect(f.verifyFaultEvidence(expected, evidence, budget)).toBe(false);
    }
    expect(f.verifyFaultEvidence(expected, { ...evidence, position: 0n }, 2n)).toBe(false);
    const failure = new Error("programming failure");
    expect(() => f.verifyFaultEvidence(expected,
      { ...evidence, get position(): bigint { throw failure; } }, 2n)).toThrow(failure);
  });

  it("enforces target field, byte width and u64 boundaries", () => {
    const base = fixture().evidence(3);
    for (const key of ["statement", "proof", "authorization"] as const) {
      const atLimit = { ...base, [key]: new Uint8Array(f.MAX_TARGET_FIELD_BYTES) };
      expect(f.decodeFaultEvidence(f.encodeFaultEvidence(atLimit, 0n), 0n)[key].length).toBe(f.MAX_TARGET_FIELD_BYTES);
      expect(() => f.encodeFaultEvidence({ ...base, [key]: new Uint8Array(f.MAX_TARGET_FIELD_BYTES + 1) }, 0n)).toThrow(EncodingError);
    }
    for (const change of [{ position: 0n }, { position: -1n }, { position: max + 1n }, { position: 1 as unknown as bigint },
      { length: 0n }, { length: -1n }, { length: max + 1n }, { length: 1 as unknown as bigint }]) {
      expect(() => f.encodeFaultEvidence({ ...base, ...change }, max)).toThrow(EncodingError);
    }
    const terminal = { ...base, position: max, length: max };
    expect(f.decodeFaultEvidence(f.encodeFaultEvidence(terminal, 0n), 0n).position).toBe(max);
    for (const key of ["issued", "burned"] as const) {
      expect(() => f.encodeFaultEvidence({ ...base, snapshot: { ...base.snapshot, [key]: -1n } }, 0n)).toThrow(EncodingError);
      expect(() => f.encodeFaultEvidence({ ...base, snapshot: { ...base.snapshot, [key]: max + 1n } }, 0n)).toThrow(EncodingError);
    }
    const offsets = [238, 242 + base.statement.length, 246 + base.statement.length + base.proof.length];
    for (const offset of offsets) {
      const claimedOverLimit = Buffer.from(rawEvidence(base));
      claimedOverLimit.set(u32(f.MAX_TARGET_FIELD_BYTES + 1), offset);
      expect(() => f.decodeFaultEvidence(claimedOverLimit, 0n)).toThrow(EncodingError);
    }
  });

  it("has no protocol suffix cap and applies the exact caller-selected boundary", () => {
    const base = fixture().evidence(3), triple = digestFields(b(83), b(89), b(97));
    const count = 65_537, suffix = Array.from({ length: count }, () => triple);
    const seed = sha(cat(ascii("evidence-seed"), segment));
    let previous = seed;
    const target = digestFields(base.statement, base.proof, base.authorization);
    previous = rawLink(previous, target, 1n);
    for (let i = 0; i < count; i++) previous = rawLink(previous, triple, BigInt(i + 2));
    const evidence: f.FaultEvidence = { ...base, position: 1n, length: BigInt(count + 1), previous: seed, suffix,
      snapshot: { ...base.snapshot, evidenceHash: previous } };
    expect(() => f.encodeFaultEvidence(evidence, BigInt(count - 1))).toThrow(f.FaultEvidenceLimitError);
    const encoded = f.encodeFaultEvidence(evidence, BigInt(count));
    expect(encoded.length).toBe(250 + 96 * count);
    const decoded = f.decodeFaultEvidence(encoded, BigInt(count));
    expect(decoded.suffix.length).toBe(count);
    expect(Buffer.from(f.encodeFaultEvidence(decoded, BigInt(count))).equals(Buffer.from(encoded))).toBe(true);
    expect(f.verifyFaultEvidence({ backing, segment, digest: sha(rawSnapshot(evidence.snapshot)) }, evidence, BigInt(count))).toBe(true);
  });

  it("rejects sparse and malformed JS inputs without hiding unexpected getters", () => {
    const evidence = fixture().evidence(1), invalid: unknown[] = [undefined, null, {}, "evidence",
      { ...evidence, suffix: new Array(2) }, { ...evidence, suffix: [evidence.suffix[0], , evidence.suffix[1]] },
      { ...evidence, suffix: [null, evidence.suffix[1]] }, { ...evidence, previous: b(1).subarray(1) },
      { ...evidence, statement: "raw" }, { ...evidence, proof: new Uint8ClampedArray(32) },
      { ...evidence, snapshot: null }, { ...evidence, suffix: [{ ...evidence.suffix[0], proofHash: b(1).subarray(1) }, evidence.suffix[1]] }];
    const expected = { backing, segment, digest: fixture().digest };
    for (const value of invalid) {
      expect(() => f.encodeFaultEvidence(value as f.FaultEvidence, 2n)).toThrow(EncodingError);
      expect(f.verifyFaultEvidence(expected, value as f.FaultEvidence, 2n)).toBe(false);
    }
    for (const value of [undefined, null, {}, "bytes", new Uint8ClampedArray(250)]) {
      expect(() => f.decodeFaultEvidence(value as Uint8Array, 2n)).toThrow(EncodingError);
    }
  });

  it("owns Buffer and subarray inputs, decoded fields and encoded output", () => {
    const source = fixture().evidence(1), encoded = f.encodeFaultEvidence(source, 2n);
    const padded = cat(new Uint8Array(7).fill(0xaa), encoded, new Uint8Array(5).fill(0xbb));
    const input = padded.subarray(7, 7 + encoded.length);
    expect(input.byteOffset).toBeGreaterThan(0);
    const decoded = f.decodeFaultEvidence(input, 2n), baseline = f.encodeFaultEvidence(decoded, 2n);
    padded.fill(0); source.statement.fill(101); source.snapshot.historyHash.fill(103); source.suffix[0]!.proofHash.fill(107);
    expect(f.encodeFaultEvidence(decoded, 2n)).toEqual(baseline);
    expect(encoded).toEqual(baseline);
    const independent = f.decodeFaultEvidence(baseline, 2n);
    decoded.statement.fill(109); decoded.proof.fill(113); decoded.authorization.fill(127); decoded.previous.fill(131);
    decoded.snapshot.backing.fill(137); decoded.suffix[0]!.statementHash.fill(139);
    expect(f.encodeFaultEvidence(independent, 2n)).toEqual(baseline);
    expect(Object.isFrozen(independent.suffix)).toBe(true);
  });
});
