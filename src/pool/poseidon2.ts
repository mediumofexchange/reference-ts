// Poseidon2 over the BN254 scalar field, state width 4, rate 3: the in-circuit
// hash H of pool-v2 §1, computed on the host by Barretenberg itself.
//
// The circuits hash under Barretenberg 5.2.0, the exact-pinned backend that
// proves and verifies them. The host asks the same backend's
// `poseidon2Hash` and `poseidon2Permutation` (crypto/poseidon2), so a
// wallet-computed commitment and a replayed note tree hash as the circuits
// do: a host hash that disagreed would make every commitment unprovable.
// The sponge is noir-lang/poseidon v0.3.0's (pool-v2 §1,
// `src/pool/circuits/vendor/poseidon2.nr`): the state starts as
// [0, 0, 0, n · 2^64] for n inputs, three inputs a block, the output the
// first state element. pool-poseidon2.test.ts pins the permutation's own test
// vector and recorded hash outputs, and compares every result with an
// independent bigint implementation of the published parameters
// (test/poseidon2-oracle.ts), which was the host hash until slice 15.
//
// The instance is Barretenberg's single-threaded WebAssembly backend, started
// once when this module loads (about 0.2 s and 30 MB): a hash call is then
// synchronous and about five times faster than the bigint one, which the
// replay's note tree spends most of its time in (WORK.md Next 4 (ay)). It
// loads no proving parameters and proves or verifies nothing, so the
// parameter check before loading (pool-v3 §4, proof-verifier.ts) has nothing
// to check here. The WebAssembly backend is chosen over a native one so that
// every host computes H with the same code, and it is the binary the pinned
// package ships, named by its path: bb.js would otherwise run whatever binary
// `BB_WASM_PATH` names, which the verifier refuses at every start
// (proof-verifier.ts) but which this instance, started once at import, would
// keep for the life of the process. The start-up cost is paid by every
// process that loads the pool's primitives, the `moe` commands included.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BackendType, BarretenbergSync } from "@aztec/bb.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../bytes.js";
import { isField } from "./field.js";

const WIDTH = 4;

/** The WebAssembly binary inside the installed bb.js, where its own loader finds it by default: beside its Node build,
 * found from that build's `platform` export (dest/node/bb_backends/node/). */
const PACKAGED_WASM = join(dirname(createRequire(import.meta.url).resolve("@aztec/bb.js/platform")), "../../barretenberg_wasm/barretenberg-threads.wasm.gz");
const backend = await BarretenbergSync.new({ backend: BackendType.Wasm, threads: 1, wasmPath: PACKAGED_WASM });

export type PermutationState = readonly [bigint, bigint, bigint, bigint];

/**
 * An owned copy of `values` read once by index, or undefined unless it holds
 * canonical field elements, `count` of them where a count is given. By index,
 * since `every` skips a sparse array's holes; one read, so the value checked
 * is the value hashed.
 */
function fields(values: readonly bigint[], count?: number): bigint[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const length = values.length;
  if (count !== undefined && length !== count) return undefined;
  const own: bigint[] = [];
  for (let i = 0; i < length; i++) {
    const value: unknown = values[i];
    if (!isField(value)) return undefined;
    own.push(value);
  }
  return own;
}

/** A canonical field element as the backend reads it: 32 bytes, big-endian. */
const encoded = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, "0"));

/** The backend's answer, which must be one canonical field element; anything else is a fault of the backend, not of the input. */
function decoded(bytes: Uint8Array): bigint {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("Barretenberg returned a hash that is not 32 bytes");
  const value = BigInt(`0x${bytesToHex(bytes)}`);
  if (!isField(value)) throw new Error("Barretenberg returned a hash that is not a canonical field element");
  return value;
}

/** The permutation over four canonical field elements. */
export function poseidon2Permutation(input: readonly bigint[]): PermutationState {
  const s = fields(input, WIDTH);
  if (s === undefined) throw new EncodingError("permutation input must be four canonical field elements");
  const { outputs } = backend.poseidon2Permutation({ inputs: s.map(encoded) });
  if (!Array.isArray(outputs) || outputs.length !== WIDTH) throw new Error("Barretenberg returned a permutation that is not four elements");
  return [decoded(outputs[0]!), decoded(outputs[1]!), decoded(outputs[2]!), decoded(outputs[3]!)];
}

/**
 * The variable-length sponge of pool-v2 §1 over one or more canonical field
 * elements. Every in-circuit object hashes its domain tag as the first input,
 * which the callers in notes.ts and note-tree.ts supply; so no object of
 * this construction hashes zero inputs, and the host refuses to (the Noir
 * sponge would permute once over the empty state).
 */
export function poseidon2Hash(input: readonly bigint[]): bigint {
  const inputs = fields(input);
  if (inputs === undefined || inputs.length === 0) {
    throw new EncodingError("hash input must be one or more canonical field elements");
  }
  return decoded(backend.poseidon2Hash({ inputs: inputs.map(encoded) }).hash);
}
