# Vendored Poseidon2 helper

`poseidon2.nr` is an unmodified copy of
[noir-lang/poseidon v0.3.0, src/poseidon2.nr](https://github.com/noir-lang/poseidon/blob/v0.3.0/src/poseidon2.nr).
SHA-256: `44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8`.

The upstream Apache-2.0 license is preserved in `LICENSE`; the repository's
CC0 dedication does not replace that third-party license. The helper uses the
compiler's Poseidon2 permutation. Real circuit proofs are checked against
commitments, nullifiers and Merkle paths computed by Barretenberg's host hash,
exercising agreement at the domain-specific input lengths 2, 8, 5 and 4.

The experiment pins Noir `1.0.0-beta.26` and Barretenberg `5.2.0` in its separate
lockfile. Updating either dependency or this helper requires rerunning the full
experiment and reviewing the changed circuit and verification-key identities.
