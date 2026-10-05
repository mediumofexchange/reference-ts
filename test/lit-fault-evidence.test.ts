import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { EncodingError } from "../src/bytes.js";
import { litConfigHash } from "../src/lit/configuration.js";
import * as frames from "../src/lit/commitments.js";
import * as fault from "../src/lit/fault-evidence.js";
import * as codec from "../src/lit/records.js";

// lit-v1 §6's fault evidence against a Buffer/node:crypto oracle, and compact
// intrinsic exclusion over records that otherwise satisfy §3 so only the
// failure under test can decide. Records are built with the reviewed codec.
const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
const join = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);
const int = (v: bigint | number, bytes: number): Buffer => Buffer.from(BigInt(v).toString(16).padStart(bytes * 2, "0"), "hex");
const hash = (...b: Uint8Array[]): Buffer => createHash("sha256").update(join(...b)).digest();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const id = (n: number): Buffer => Buffer.alloc(32, n);
const secretOf = (n: number): Uint8Array => hash(ascii("lit fault secret"), int(n, 1));
const keyOf = (n: number): Uint8Array => ed25519.getPublicKey(secretOf(n));
const sign = (n: number, message: Uint8Array): Uint8Array => ed25519.sign(message, secretOf(n));
const reason = (f: () => unknown): string => {
  try { f(); } catch (error) { expect(error).toBeInstanceOf(EncodingError); return (error as Error).message; }
  throw new Error("expected a refusal");
};

const DOMAIN = litConfigHash(), SEGMENT = id(19), BACKING = id(31), K = 1;
const issue: codec.Issue = { domain: DOMAIN, kind: 1, segment: SEGMENT, backing: BACKING, quantity: 100n, owner: keyOf(2), nonce: id(41) };
const [note] = codec.derivedOutputs(issue);
const spend: codec.Spend = { domain: DOMAIN, kind: 2, segment: SEGMENT, inputs: [note!],
  outputs: [{ backing: BACKING, value: 60n, owner: keyOf(3) }, { backing: BACKING, value: 40n, owner: keyOf(4) }] };
const signed = (s: codec.Statement, signer: number): codec.LitRecord =>
  ({ statement: s, authorization: sign(signer, codec.statementBytes(s)) });
const issueRecord = signed(issue, K), spendRecord = signed(spend, 2);
const pairOf = (r: codec.LitRecord) => codec.evidencePair(r);

describe("lit-v1 §6 fault evidence", () => {
  const e0 = frames.genesisEvidenceHash(SEGMENT);
  const e1 = frames.nextEvidenceHash(e0, pairOf(issueRecord), 1n), e2 = frames.nextEvidenceHash(e1, pairOf(spendRecord), 2n);
  const snapshot = { backing: BACKING, segment: SEGMENT, historyHash: id(7), evidenceHash: e2, issued: 100n, burned: 0n };
  const evidence = { snapshot, position: 1n, length: 2n, previous: e0, statement: codec.statementBytes(issue),
    authorization: issueRecord.authorization, suffix: [pairOf(spendRecord)] };
  const expected = { backing: BACKING, segment: SEGMENT, digest: frames.snapshotDigest(snapshot) };

  it("frames the pair as the oracle does, 244 bytes plus the fields and 64 per later event, and authenticates it", () => {
    const bytes = fault.encodeFaultEvidence(evidence, 8n);
    const p = pairOf(spendRecord);
    const oracle = join(ascii("moe/lit/v1/fault-evidence"), frames.snapshotBytes(snapshot), int(1n, 8), int(2n, 8), e0,
      int(evidence.statement.length, 4), evidence.statement, int(64, 4), evidence.authorization, p.statementHash, p.signatureHash);
    expect(hex(bytes)).toBe(hex(oracle));
    expect(bytes.length).toBe(244 + evidence.statement.length + 64 + 64);
    expect(fault.FIXED_BYTES).toBe(244);
    const decoded = fault.decodeFaultEvidence(bytes, 8n);
    expect(hex(fault.encodeFaultEvidence(decoded, 8n))).toBe(hex(bytes));
    expect(fault.verifyFaultEvidence(expected, decoded, 8n)).toBe(true);
    expect(fault.verifyFaultEvidence({ ...expected, segment: id(23) }, decoded, 8n)).toBe(false);
    expect(fault.verifyFaultEvidence(expected, { ...decoded, authorization: sign(3, evidence.statement) }, 8n)).toBe(false);
    expect(fault.verifyFaultEvidence(expected, { ...decoded, statement: Uint8Array.of(...decoded.statement, 0) }, 8n)).toBe(false);
  });

  it("refuses a field past 4096 bytes, a wrong suffix length and a suffix over the budget", () => {
    const bytes = fault.encodeFaultEvidence(evidence, 8n);
    expect(reason(() => fault.encodeFaultEvidence({ ...evidence, statement: new Uint8Array(4097) }, 8n))).toBe("target field too long");
    const long = Buffer.from(bytes); long.writeUInt32BE(4097, 236);
    expect(reason(() => fault.decodeFaultEvidence(long, 8n))).toBe("target field too long");
    expect(reason(() => fault.decodeFaultEvidence(bytes.subarray(0, bytes.length - 1), 8n))).toBe("wrong suffix byte length");
    expect(reason(() => fault.decodeFaultEvidence(join(bytes, new Uint8Array(64)), 8n))).toBe("wrong suffix byte length");
    expect(() => fault.decodeFaultEvidence(bytes, 0n)).toThrow(fault.FaultEvidenceLimitError);
    expect(reason(() => fault.encodeFaultEvidence({ ...evidence, suffix: [] }, 8n))).toBe("wrong evidence suffix length");
    expect(reason(() => fault.decodeFaultEvidence(Buffer.from(bytes).fill(0, 188, 196), 8n))).toBe("invalid evidence positions");
  });
});

describe("lit-v1 §6 compact intrinsic exclusion", () => {
  const kOf = (backing: Uint8Array): Uint8Array | undefined => hex(backing) === hex(BACKING) ? keyOf(K) : undefined;
  const statement = (r: codec.LitRecord) => codec.statementBytes(r.statement);
  it("excludes a failing signature under a key the statement names or K, and failing arithmetic", () => {
    expect(fault.intrinsicallyInvalid(statement(issueRecord), issueRecord.authorization, kOf)).toBe(false);
    expect(fault.intrinsicallyInvalid(statement(spendRecord), spendRecord.authorization, kOf)).toBe(false);
    expect(fault.intrinsicallyInvalid(statement(issueRecord), sign(2, statement(issueRecord)), kOf)).toBe(true);
    expect(fault.intrinsicallyInvalid(statement(spendRecord), sign(3, statement(spendRecord)), kOf)).toBe(true);
    const unbalanced = signed({ ...spend, outputs: [spend.outputs[0]!] }, 2);
    expect(fault.intrinsicallyInvalid(statement(unbalanced), unbalanced.authorization, kOf)).toBe(true);
  });

  it("is not intrinsic when the target is malformed, of another domain, of a wrong length, unresolved or needs the demand", () => {
    expect(fault.intrinsicallyInvalid(statement(spendRecord), spendRecord.authorization.subarray(1), kOf)).toBe(false);
    expect(fault.intrinsicallyInvalid(Uint8Array.of(...statement(spendRecord), 0), spendRecord.authorization, kOf)).toBe(false);
    const foreign = { ...spend, domain: id(5) };
    expect(fault.intrinsicallyInvalid(codec.statementBytes(foreign), sign(3, codec.statementBytes(foreign)), kOf)).toBe(false);
    expect(fault.intrinsicallyInvalid(statement(issueRecord), sign(2, statement(issueRecord)), () => undefined)).toBe(false);
    const withdraw: codec.Withdraw = { domain: DOMAIN, kind: 5, segment: SEGMENT, demand: id(9) };
    expect(fault.intrinsicallyInvalid(codec.statementBytes(withdraw), new Uint8Array(64), kOf)).toBe(false);
  });
});
