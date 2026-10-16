import { describe, expect, it } from "vitest";
import { isMalformedProofFailure, mixedPairingObject } from "../src/pool/proof-verifier.js";

// The pinned backend's own messages (scripts/pool/v3/check.mjs raises each on a real proof).
const MALFORMED = [
  "Non-canonical proof element: value >= field modulus",
  "Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))\n  Left   : 0x30644e",
  "Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))\n  Left   : 0x30644e",
  "Assertion failed: (value < fq::modulus)\n  Left   : 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47",
  "Deserialized point is not on the curve",
  "Cannot aggregate: incoming pairing points are at infinity (probably uninitialized).",
];

describe("the verifier's classification of backend failures", () => {
  it("reads the pinned backend's malformed-proof failures as malformed", () => {
    for (const message of MALFORMED) expect(isMalformedProofFailure(new Error(message))).toBe(true);
  });

  it("keeps every other failure the backend's", () => {
    for (const failure of [
      new Error("memory access out of bounds"),
      new Error("the proof verifier is closed"),
      new Error("Assertion failed: (some other invariant)"),
      new Error(`wrapped: ${MALFORMED[0]}`),
      new RangeError("Maximum call stack size exceeded"),
      MALFORMED[3],
      { message: MALFORMED[3] },
      undefined,
    ]) expect(isMalformedProofFailure(failure)).toBe(false);
  });
});

describe("the verifier's reading of a proof's pairing-point object (succinct-read §2 rule 2)", () => {
  // Words 0-3 are the first point, 4-7 the second; a point at infinity is four zero words.
  const proof = (first: boolean, second: boolean, length = 14656): Uint8Array => {
    const bytes = new Uint8Array(length).fill(0x11);
    if (!first) bytes.fill(0, 0, 128);
    if (!second) bytes.fill(0, 128, 256);
    return bytes;
  };

  it("refuses an object with exactly one point at infinity", () => {
    expect(mixedPairingObject(proof(false, true))).toBe(true);
    expect(mixedPairingObject(proof(true, false))).toBe(true);
  });

  it("takes both at infinity, as a circuit verifying no proof publishes, and neither, as a recursive one does", () => {
    expect(mixedPairingObject(proof(false, false))).toBe(false);
    expect(mixedPairingObject(proof(true, true))).toBe(false);
  });

  it("reads a point as finite on any nonzero byte of its four words", () => {
    for (const at of [0, 31, 127]) {
      const bytes = proof(false, true);
      bytes[at] = 1;
      expect(mixedPairingObject(bytes)).toBe(false);
    }
    for (const at of [128, 200, 255]) {
      const bytes = proof(true, false);
      bytes[at] = 1;
      expect(mixedPairingObject(bytes)).toBe(false);
    }
  });

  it("leaves bytes too short for an object to the backend's own length refusal", () => {
    expect(mixedPairingObject(new Uint8Array(255))).toBe(false);
    expect(mixedPairingObject(proof(false, true, 256))).toBe(true);
  });
});
