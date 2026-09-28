import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { limbsOf } from "../src/pool/field.js";
import { encodeReceipt, receiptBytes } from "../src/pool/v3/commitments.js";
import { encodeEvidencePackage } from "../src/pool/v3/package.js";
import { encodeRecord } from "../src/pool/v3/records.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { signCommitment } from "../src/venue-records.js";
import {
  V3_SERVICE_PROFILE, parseV3ServiceCommand, decodeV3ServiceReply, decodeV3ServicePackage,
  replyFromReceipt, replyFromCommitment, packageReply,
} from "../src/pool/v3/service-wire.js";

// Canonical framing fixtures only: they claim neither proof validity nor finality.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const domain = b(1), segment = b(2), secret = b(3), operator = ed25519.getPublicKey(secret);
const command = (fields: Record<string, unknown>) => ({ version: 1, profile: V3_SERVICE_PROFILE, ...fields });
const record = encodeRecord({ domain, kind: 5, publicInputs: [...limbsOf(domain), ...limbsOf(segment), 7n, ...limbsOf(b(4))],
  proof: new Uint8Array(), authorization: new Uint8Array(64), capsules: [] });
const receiptFields = { domain, segment, scopeRoot: 7n, position: 1n, statementHash: b(5), historyHash: b(6),
  proofHash: b(7), signatureHash: b(8), after: 1n };
const receipt = encodeReceipt({ ...receiptFields, operator, signature: ed25519.sign(receiptBytes(receiptFields), secret) });
const served = () => ({ selection: { domain, operator, venue: b(9), backing: b(10), root: b(11), sequence: 1n },
  package: encodeEvidencePackage([], { maxBytes: 1_048_576n, maxItems: 1024n }) });

describe("v3 service wire framing", () => {
  it("round trips record, receipt, commitment and untrusted package envelopes", () => {
    const submission = command({ kind: "submit", record: bytesToHex(record) });
    expect(parseV3ServiceCommand(submission)).toEqual(submission);
    for (const reply of [replyFromReceipt(receipt), replyFromCommitment("committed", signCommitment(secret, 1n, b(9))),
      replyFromCommitment("published", signCommitment(secret, 2n, b(10)))]) expect(decodeV3ServiceReply(reply)).toEqual(reply);
    expect(decodeV3ServicePackage(packageReply(served()))).toEqual(served());
  });

  it("rejects obsolete profiles, versions, unknown fields and invalid command identifiers", () => {
    for (const [value, reason] of [
      [command({ kind: "publish", extra: true }), "unexpected service fields"],
      [command({ kind: "publish", profile: "pool-store/v2" }), "wrong service profile"],
      [command({ kind: "publish", version: 2 }), "wrong service profile"],
      [command({ kind: "commit", id: "bad id" }), "invalid command id"],
      [command({ kind: "commit", id: "x".repeat(129) }), "invalid command id"],
      [command({ kind: "activate" }), "unsupported service command"],
      [command({ kind: "submit", statement: bytesToHex(record) }), "unexpected service fields"],
    ] as const) {
      expect(() => parseV3ServiceCommand(value)).toThrow(reason);
    }
  });

  it("rejects noncanonical hex, trailing bytes and recovery refresh records", () => {
    const refresh = encodeRecord({ domain, kind: 7, publicInputs: [...limbsOf(domain), ...limbsOf(b(4)), 1n, 2n, 3n],
      proof: b(6), authorization: new Uint8Array(), capsules: [] });
    for (const value of ["", "0", "GG", bytesToHex(record).toUpperCase()]) {
      expect(() => parseV3ServiceCommand(command({ kind: "submit", record: value }))).toThrow("invalid service hex");
    }
    expect(() => parseV3ServiceCommand(command({ kind: "submit", record: `${bytesToHex(record)}00` }))).toThrow(/trailing/i);
    expect(() => parseV3ServiceCommand(command({ kind: "submit", record: bytesToHex(refresh) }))).toThrow("a request is not a segment admission");
    for (const value of ["", `${bytesToHex(receipt)}00`, bytesToHex(receipt).toUpperCase()]) {
      expect(() => decodeV3ServiceReply(command({ kind: "accepted", receipt: value }))).toThrow("invalid service hex");
    }
    expect(() => decodeV3ServiceReply(command({ kind: "committed", commitment: "00" }))).toThrow("invalid service hex");
  });

  it("requires exact selection fields and a positive canonical u64 sequence", () => {
    const original = packageReply(served());
    for (const sequence of ["0", "01", "-1", "18446744073709551616", 1]) {
      expect(() => decodeV3ServicePackage({ ...original, selection: { ...original.selection, sequence } })).toThrow("invalid service sequence");
    }
    for (const change of [{ root: "00" }, { venue: "GG".repeat(32) }]) {
      expect(() => decodeV3ServicePackage({ ...original, selection: { ...original.selection, ...change } })).toThrow("invalid service hex");
    }
    expect(() => decodeV3ServicePackage({ ...original, selection: { ...original.selection, extra: true } })).toThrow("unexpected service fields");
    expect(() => decodeV3ServicePackage({ ...original, extra: true })).toThrow("unexpected service fields");
    expect(() => decodeV3ServicePackage({ ...original, package: "00".repeat(1_048_577) })).toThrow("invalid service hex");
  });
});
