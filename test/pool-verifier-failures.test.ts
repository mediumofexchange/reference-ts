import { describe, expect, it } from "vitest";
import { isMalformedProofFailure } from "../src/pool/barretenberg.js";

// The pinned backend's own messages (scripts/pool/check.mjs raises each on a real proof).
const MALFORMED = [
  "Non-canonical proof element: value >= field modulus",
  "Assertion failed: (uint256_t(fr_vec[0]) < (uint256_t(1) << (NUM_LIMB_BITS * 2)))\n  Left   : 0x30644e",
  "Assertion failed: (uint256_t(fr_vec[1]) < (uint256_t(1) << (TOTAL_BITS - NUM_LIMB_BITS * 2)))\n  Left   : 0x30644e",
  "Deserialized point is not on the curve",
  "Cannot aggregate: incoming pairing points are at infinity (probably uninitialized).",
];

describe("the verifier's classification of backend failures (pool-v2 §12)", () => {
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
