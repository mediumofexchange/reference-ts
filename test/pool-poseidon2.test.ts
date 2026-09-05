import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { FIELD_MODULUS, fieldToHex, identifierOf } from "../src/pool/field.js";
import { commitmentOf, nullifierOf, ownerOf } from "../src/pool/notes.js";
import { poseidon2Hash, poseidon2Permutation } from "../src/pool/poseidon2.js";

// pool-v1 §1: H is Poseidon2 over BN254, width 4, rate 3, the Noir standard
// library's permutation in noir-lang/poseidon v0.3.0's sponge. The host
// implementation is bound to the circuits' by vectors: the permutation's own
// test vector from Barretenberg's poseidon2_params.hpp, and hash outputs
// recorded from Barretenberg 5.2.0's `poseidon2Hash`, the backend the pinned
// circuits prove under (`scripts/pool/check.mjs` proves against the same).

const p = FIELD_MODULUS;

describe("pool-v1 §1: the in-circuit hash on the host", () => {
  it("permutes Barretenberg's test vector", () => {
    expect(poseidon2Permutation([0n, 1n, 2n, 3n]).map(fieldToHex)).toEqual([
      "0x01bd538c2ee014ed5141b29e9ae240bf8db3fe5b9a38629a9647cf8d76c01737",
      "0x239b62e7db98aa3a2a8f6a0d2fa1709e7a35959aa6c7034814d9daa90cbac662",
      "0x04cbb44c61d928ed06808456bf758cbf0c18d1e15a7b6dbc8245fa7515d5e3cb",
      "0x2e11c5cff2a22c64d01304b778d78f6998eff1ab73163a35603f54794c30847a",
    ]);
  });

  it("matches the backend's sponge for every block shape, including the full-block boundary", () => {
    const vectors: [bigint[], string][] = [
      [[1n], "0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373"],
      [[1n, 2n], "0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383"],
      [[1n, 2n, 3n], "0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8"],
      [[1n, 2n, 3n, 4n], "0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9"],
      [[1n, 2n, 3n, 4n, 5n], "0x2247be7014a54d17342a7ef677f58d28877780d203860396967f5d0a18d259db"],
      [[1001n, 7n], "0x156abdc75cd1df1e6a4c590f444051aa4494bdf74b1f0f530686e3a30dd27ddd"],
      [[1002n, 17n, 29n, 31n, 43n, 100n, 5n, 6n], "0x13d87fac4acd7b0c86f4bd8bf7500e0cb37a27c142c583647202412d841fe518"],
      [[p - 1n, p - 2n, 0n, p - 1n], "0x1efae30ebe6fba2ca512a141ebf29320399f1763a503f7ee6f7099621bdfd039"],
      [[0n, 0n, 0n], "0x2a5de47ed300af27b706aaa14762fc468f5cfc16cd8116eb6b09b0f2643ca2b9"],
      [[0n], "0x2710144414c3a5f2354f4c08d52ed655b9fe253b4bf12cb9ad3de693d9b1db11"],
    ];
    for (const [input, expected] of vectors) expect(fieldToHex(poseidon2Hash(input))).toBe(expected);
    // The length enters the initial state, so a shorter input is not a prefix's hash.
    expect(poseidon2Hash([1n, 2n, 3n])).not.toBe(poseidon2Hash([1n, 2n, 3n, 0n]));
  });

  it("refuses anything but one or more canonical field elements", () => {
    expect(() => poseidon2Hash([])).toThrow(EncodingError);
    expect(() => poseidon2Hash([p])).toThrow(EncodingError);
    expect(() => poseidon2Hash([-1n])).toThrow(EncodingError);
    expect(() => poseidon2Hash([1 as unknown as bigint])).toThrow(EncodingError);
    expect(() => poseidon2Permutation([1n, 2n, 3n])).toThrow(EncodingError);
    expect(() => poseidon2Permutation([1n, 2n, 3n, p])).toThrow(EncodingError);
  });

  it("derives owner, commitment and nullifier with the tags in the pinned order", () => {
    // The vectors above, read as pool-v1 §3's objects: pool limbs (17, 29),
    // backing limbs (31, 43), value 100, owner 5, rho 6.
    expect(fieldToHex(ownerOf(7n))).toBe("0x156abdc75cd1df1e6a4c590f444051aa4494bdf74b1f0f530686e3a30dd27ddd");
    const pool = identifierOf(17n, 29n);
    const backing = identifierOf(31n, 43n);
    expect(fieldToHex(commitmentOf(pool, { backing, value: 100n, owner: 5n, rho: 6n }))).toBe(
      "0x13d87fac4acd7b0c86f4bd8bf7500e0cb37a27c142c583647202412d841fe518",
    );
    const cm = commitmentOf(pool, { backing, value: 100n, owner: 5n, rho: 6n });
    expect(nullifierOf(pool, cm, 9n)).toBe(poseidon2Hash([1003n, 17n, 29n, cm, 9n]));
    // Nonzero throughout: a zero secret, owner, rho, value out of range, or a foreign limb width is refused.
    expect(() => ownerOf(0n)).toThrow(EncodingError);
    expect(() => commitmentOf(pool, { backing, value: 100n, owner: 0n, rho: 6n })).toThrow(EncodingError);
    expect(() => commitmentOf(pool, { backing, value: 100n, owner: 5n, rho: 0n })).toThrow(EncodingError);
    expect(() => commitmentOf(pool, { backing, value: 1n << 64n, owner: 5n, rho: 6n })).toThrow(EncodingError);
    expect(() => commitmentOf(pool, { backing: new Uint8Array(31), value: 1n, owner: 5n, rho: 6n })).toThrow(EncodingError);
    expect(() => nullifierOf(pool, cm, 0n)).toThrow(EncodingError);
    expect(() => nullifierOf(pool, 0n, 9n)).toThrow(EncodingError);
    // A value of zero is a padding input or an empty output, and is allowed.
    expect(commitmentOf(pool, { backing, value: 0n, owner: 5n, rho: 6n })).not.toBe(0n);
  });
});
