import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { ByteWriter, EncodingError } from "../src/bytes.js";
import { isValidPublicKey, verifySignatureStrict } from "../src/keys.js";
import {
  decodeCommitment, decodeReplacement, decodeRevocation, directoryRoot, encodeCommitment, encodeReplacement, encodeRevocation,
  isEquivocation, isSignedRevocation, replacementMessage, ROLE_OPERATOR, signCommitment, signRevocation, verifyCommitment,
  verifyReplacement, type Commitment, type Replacement,
} from "../src/venue-records.js";
import { lookAlikes, lyingLength } from "./hostile-bytes.js";

// The venue records of kinds 1-3 (pool-v3 §13.1) and the key rules every
// verifier funnels through: their exact bytes, strict inverses and verifiers
// that answer rather than throw. No venue, walk or construction is involved.
const b = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const sha = (bytes: Uint8Array): Uint8Array => Uint8Array.from(createHash("sha256").update(bytes).digest());
const integer = (n: bigint, width: number): Buffer => Buffer.from(n.toString(16).padStart(width * 2, "0"), "hex");
const operatorSecret = b(0x31), operator = ed25519.getPublicKey(operatorSecret);
const strangerSecret = b(0x32);
const backerSecret = b(0x33), backer = ed25519.getPublicKey(backerSecret);
const heirSecret = b(0x34), heir = ed25519.getPublicKey(heirSecret);
const backingName = b(0x17);

/** The refusal a call raises: the codec's EncodingError and its message, or anything else as thrown. */
function refusal(call: () => unknown): unknown {
  try { call(); } catch (error) { return error instanceof EncodingError ? ["EncodingError", error.message] : error; }
  return "no refusal";
}

describe("kind 1: a commitment (C2.3)", () => {
  it("round-trips a commitment, and refuses anything else", () => {
    const commitment = signCommitment(operatorSecret, 7n, new Uint8Array(32).fill(0xab));
    const bytes = encodeCommitment(commitment);
    expect(bytes).toHaveLength(8 + 32 + 32 + 64);
    expect(decodeCommitment(bytes)).toEqual(commitment);
    expect(encodeCommitment(decodeCommitment(bytes))).toEqual(bytes);
    expect(refusal(() => decodeCommitment(bytes.slice(0, bytes.length - 1)))).toEqual(["EncodingError", "truncated"]);
    expect(refusal(() => decodeCommitment(new Uint8Array([...bytes, 0])))).toEqual(["EncodingError", "trailing bytes"]);
  });

  it("verifies only the (sequence, root) the operator signed", () => {
    const commitment = signCommitment(operatorSecret, 4n, b(0x44));
    expect(verifyCommitment(commitment)).toBe(true);
    const mutatedRoot = commitment.root.slice();
    mutatedRoot[0] = mutatedRoot[0]! ^ 0xff;
    expect(verifyCommitment({ ...commitment, root: mutatedRoot })).toBe(false);
    expect(verifyCommitment({ ...commitment, sequence: commitment.sequence + 1n })).toBe(false);
  });

  it("rejects signatures made under the old commitment domain", () => {
    const root = directoryRoot([]);
    const signedUnder = (context: string): Commitment => {
      const message = new ByteWriter();
      message.context(new TextEncoder().encode(context));
      message.u64(0n);
      message.key32(root, "root");
      return { sequence: 0n, root, operator, signature: ed25519.sign(message.finish(), operatorSecret) };
    };
    expect(verifyCommitment(signedUnder("moe/commitment/v1"))).toBe(false);
    // The live domain, framed independently, is the one signCommitment signs.
    expect(verifyCommitment(signedUnder("moe/commitment/v2"))).toBe(true);
    expect(signedUnder("moe/commitment/v2").signature).toEqual(signCommitment(operatorSecret, 0n, root).signature);
  });

  it("answers false, rather than throwing, on a malformed operator key or commitment", () => {
    const signature = new Uint8Array(64);
    expect(verifyCommitment({ sequence: 0n, root: b(1), operator: new Uint8Array(31), signature })).toBe(false);
    const honest = signCommitment(operatorSecret, 2n, b(0x42));
    // The genuine signature under a key one byte short or long.
    expect(verifyCommitment({ ...honest, operator: honest.operator.subarray(0, 31) })).toBe(false);
    expect(verifyCommitment({ ...honest, operator: Uint8Array.of(...honest.operator, 0) })).toBe(false);
    for (const bad of [{ ...honest, operator: undefined }, { ...honest, root: undefined }, { ...honest, signature: undefined },
      { ...honest, sequence: undefined }, undefined]) {
      expect(verifyCommitment(bad as unknown as Commitment)).toBe(false);
    }
  });
});

describe("equivocation: two roots signed at one sequence (C2.3)", () => {
  const honest = signCommitment(operatorSecret, 3n, b(0x60));

  it("is two roots at one operator sequence, never commitments at distinct sequences, whatever the venue's clock", () => {
    // The sequence is the operator's own count, not a venue index: no clock is an input.
    expect(isEquivocation(honest, signCommitment(operatorSecret, 3n, b(0xab)))).toBe(true);
    expect(isEquivocation(honest, signCommitment(operatorSecret, 4n, b(0xab)))).toBe(false);
    expect(isEquivocation(honest, signCommitment(operatorSecret, 4n, honest.root))).toBe(false);
  });

  it("is not the operator's where another key signed the second root", () => {
    const impostor = signCommitment(strangerSecret, honest.sequence, b(0xcd));
    expect(verifyCommitment(impostor)).toBe(true);
    expect(isEquivocation(honest, impostor)).toBe(false);
    expect(isEquivocation(impostor, honest)).toBe(false);
  });

  it("answers false, rather than throwing, on a malformed or unsigned commitment", () => {
    const malformed = [
      { ...honest, operator: undefined }, { ...honest, root: undefined }, { ...honest, signature: undefined },
      { ...honest, sequence: undefined }, undefined,
    ];
    for (const bad of malformed) {
      expect(isEquivocation(bad as unknown as Commitment, honest)).toBe(false);
      expect(isEquivocation(honest, bad as unknown as Commitment)).toBe(false);
    }
    // A second root at the same sequence under the operator's key, but not signed by it, proves nothing.
    const twin = signCommitment(operatorSecret, honest.sequence, b(0xab));
    expect(isEquivocation(honest, { ...twin, signature: honest.signature })).toBe(false);
    expect(isEquivocation({ ...twin, signature: honest.signature }, honest)).toBe(false);
  });
});

describe("the commitment directory (MOED v1)", () => {
  it("matches the specified fixed framing and canonical unsigned name order", () => {
    const low = { name: new Uint8Array(32).fill(0x7f), digest: new Uint8Array(32).fill(1) };
    const high = { name: new Uint8Array(32).fill(0x80), digest: new Uint8Array(32).fill(2) };
    const bytes = Buffer.concat([Buffer.from("4d4f45440100000002", "hex"), low.name, low.digest, high.name, high.digest]);
    expect(directoryRoot([low, high])).toEqual(sha(bytes));
    expect(directoryRoot([])).toEqual(sha(Buffer.from("4d4f45440100000000", "hex")));
    expect(refusal(() => directoryRoot([high, low]))).toEqual(["EncodingError", "directory names must be strictly increasing"]);
    expect(refusal(() => directoryRoot([low, low]))).toEqual(["EncodingError", "directory names must be strictly increasing"]);
    expect(refusal(() => directoryRoot([{ ...low, name: new Uint8Array(31) }]))).toEqual(["EncodingError", "backing name must be 32 bytes"]);
    expect(refusal(() => directoryRoot([{ ...low, digest: new Uint8Array(33) }]))).toEqual(["EncodingError", "snapshot digest must be 32 bytes"]);
  });

  it("binds names even when snapshot digests are unchanged", () => {
    const entry = { name: new Uint8Array(32).fill(1), digest: new Uint8Array(32).fill(3) };
    expect(directoryRoot([entry])).not.toEqual(directoryRoot([{ ...entry, name: new Uint8Array(32).fill(2) }]));
  });
});

describe("kind 2: a replacement (C2.5)", () => {
  function replacementBy(successorSecret: Uint8Array, effective: bigint): Replacement {
    const fields = { role: ROLE_OPERATOR, successor: ed25519.getPublicKey(successorSecret), predecessor: backingName, effective };
    const message = replacementMessage(backingName, { ...fields, signature: new Uint8Array(64), successorSignature: new Uint8Array(64) });
    return { ...fields, signature: ed25519.sign(message, backerSecret), successorSignature: ed25519.sign(message, successorSecret) };
  }

  it("round-trips a replacement, and refuses anything else", () => {
    const replacement: Replacement = {
      role: ROLE_OPERATOR, successor: operator, predecessor: backingName, effective: 12n,
      signature: ed25519.sign(new Uint8Array(8), backerSecret), successorSignature: ed25519.sign(new Uint8Array(8), operatorSecret),
    };
    const bytes = encodeReplacement(backingName, replacement);
    // Two signatures: the rule-holder's and the successor's, over one message.
    expect(bytes).toHaveLength(32 + 1 + 32 + 32 + 8 + 64 + 64);
    const decoded = decodeReplacement(bytes);
    expect(decoded.replacement).toEqual(replacement);
    expect(decoded.backingName).toEqual(backingName);
    expect(encodeReplacement(decoded.backingName, decoded.replacement)).toEqual(bytes);
    expect(refusal(() => decodeReplacement(bytes.slice(1)))).toEqual(["EncodingError", "truncated"]);
    expect(refusal(() => decodeReplacement(new Uint8Array([...bytes, 0])))).toEqual(["EncodingError", "trailing bytes"]);
  });

  it("takes both signatures over one message, so there is one record and one tag", () => {
    const replacement = replacementBy(heirSecret, 10n);
    const message = replacementMessage(backingName, replacement);
    // The message, framed independently: tag, backing name, role, successor, predecessor, effective index.
    expect(Buffer.from(message)).toEqual(Buffer.concat([Buffer.from("moe/replacement/v1", "ascii"), backingName,
      Uint8Array.of(ROLE_OPERATOR), heir, backingName, integer(10n, 8)]));
    expect(ed25519.verify(replacement.signature, message, backer)).toBe(true);
    expect(ed25519.verify(replacement.successorSignature, message, heir)).toBe(true);
    expect(verifyReplacement(backingName, replacement, backer)).toBe(true);
    // And it round-trips as one record.
    const decoded = decodeReplacement(encodeReplacement(backingName, replacement));
    expect(decoded.replacement.successorSignature).toEqual(replacement.successorSignature);
    expect(decoded.replacement.signature).toEqual(replacement.signature);
  });
});

describe("kind 3: a revocation is K's own signature over K (C2b.1)", () => {
  it("round-trips as a record, both ways", () => {
    const revocation = signRevocation(backerSecret);
    const bytes = encodeRevocation(revocation);
    const back = decodeRevocation(bytes);
    expect(back.obligor).toEqual(revocation.obligor);
    expect(back.signature).toEqual(revocation.signature);
    expect(encodeRevocation(back)).toEqual(bytes);
  });

  it("carries no sequence, no venue and no expiry, because it cannot be undone", () => {
    // Two revocations by one key are byte-identical, so anyone may relay one anywhere.
    expect(encodeRevocation(signRevocation(backerSecret))).toEqual(encodeRevocation(signRevocation(backerSecret)));
    expect(encodeRevocation(signRevocation(backerSecret))).toHaveLength(32 + 64);
  });

  it("is valid only under the key it revokes", () => {
    expect(isSignedRevocation(signRevocation(backerSecret))).toBe(true);
    expect(isSignedRevocation({ obligor: backer, signature: signRevocation(strangerSecret).signature })).toBe(false);
  });

  it("answers on hostile input rather than throwing", () => {
    expect(isSignedRevocation({ obligor: new Uint8Array(3), signature: new Uint8Array(64) })).toBe(false);
    expect(isSignedRevocation(undefined as never)).toBe(false);
    expect(refusal(() => decodeRevocation(new Uint8Array(10)))).toEqual(["EncodingError", "truncated"]);
    expect(refusal(() => decodeRevocation(new Uint8Array(97)))).toEqual(["EncodingError", "trailing bytes"]);
  });
});

describe("verifiers never throw, at the function they all funnel through (keys.ts)", () => {
  const message = new Uint8Array(32).fill(0x11);
  const key = ed25519.getPublicKey(backerSecret);
  const signature = ed25519.sign(message, backerSecret);

  it("answers false for a signature that is absent or not bytes", () => {
    for (const bad of [undefined, null, "not bytes", 0, {}, [1, 2, 3]]) {
      expect(verifySignatureStrict(bad as unknown as Uint8Array, message, key)).toBe(false);
    }
  });

  it("answers false for a key that is absent or not bytes", () => {
    for (const bad of [undefined, null, "not bytes", 0, {}]) {
      expect(verifySignatureStrict(signature, message, bad as unknown as Uint8Array)).toBe(false);
    }
  });

  it("answers false for a message that is absent or not bytes", () => {
    for (const bad of [undefined, null, "not bytes", 0]) {
      expect(verifySignatureStrict(signature, bad as unknown as Uint8Array, key)).toBe(false);
    }
  });

  it("answers false, rather than throwing, for a key that is not bytes", () => {
    for (const bad of [undefined, null, "not bytes", 0, {}]) {
      expect(isValidPublicKey(bad as unknown as Uint8Array)).toBe(false);
    }
    expect(isValidPublicKey(key)).toBe(true);
  });

  it("answers false for objects that only claim to be bytes, or bytes misreporting their length", () => {
    for (const fake of lookAlikes(64)) expect(verifySignatureStrict(fake, message, key)).toBe(false);
    for (const fake of lookAlikes(32)) {
      expect(verifySignatureStrict(signature, message, fake)).toBe(false);
      expect(verifySignatureStrict(signature, fake, key)).toBe(false);
      expect(isValidPublicKey(fake)).toBe(false);
    }
    expect(verifySignatureStrict(lyingLength(signature, 63), message, key)).toBe(true);
    expect(verifySignatureStrict(signature, message, lyingLength(new Uint8Array(31), 32))).toBe(false);
    expect(verifySignatureStrict(signature, lyingLength(message, 1), key)).toBe(true);
    expect(isValidPublicKey(lyingLength(new Uint8Array(33).fill(1), 32))).toBe(false);
  });

  it("still answers true for the real thing", () => {
    expect(verifySignatureStrict(signature, message, key)).toBe(true);
  });
});
