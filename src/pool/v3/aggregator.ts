// The trail aggregator (succinct-read §§2 rule 6, 3.2, 3.5): any party proves the check proofs that cover a trail's
// proved records, from the records with their proofs, under the test set's shipped programs (`check-set.ts`). Each
// statement proof is verified natively under pool-v3's key for its kind before its leaf is proved, since the pinned
// backend proves a leaf over a proof that does not verify and only that leaf's verification then fails (§3.5); a record
// whose proof fails, or does not have the 458 elements a leaf reads, gets no cover, and neither does any span holding
// it. Every check proof made here is verified under the set's pinned key, with the public inputs a reader derives,
// before it is returned. Nothing here is signed or carries authority: a reader checks every cover itself. A trail's
// spans are walked by `coverTrail` (succinct.ts), as a replica proves them (`V3Replica.prove`).
//
// Proving reads the check set's parameters: the backend must be started by `startCheckSetBackend`.
import type { Barretenberg } from "@aztec/bb.js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyBytes, EncodingError } from "../../bytes.js";
import { fieldToHex } from "../field.js";
import { CHECK_SET_PARAMETERS } from "../parameters.js";
import { ParameterError, PROOF_OPTIONS, startedPoints, type KeyedVerifier, type VerifierOptions } from "../proof-verifier.js";
import { LEAF_KINDS, openTrailCheckSet, TRAIL_CIRCUITS, trailKeys, trailPrograms, type TrailCheckSet, type TrailCircuit } from "./check-set.js";
import type { Record } from "./records.js";
import { COVER_PROOF_BYTES, nodeDigest, statementLeafDigest, type Cover, type SpanProver } from "./succinct.js";

export type { Cover };

/** A proof the aggregator made that does not carry the inputs a reader derives, or does not verify under the pinned key. */
export class AggregatorError extends Error {
  constructor(readonly code: "PUBLIC_INPUTS" | "UNVERIFIED", message: string) {
    super(message); this.name = "AggregatorError";
  }
}

export interface TrailProver extends SpanProver {
  /** The set the covers verify under, on verifier instances of its own. */
  readonly set: TrailCheckSet;
  /** A cover of one proved record (a span of one), or undefined where its proof fails the native check. */
  leaf(record: Record): Promise<Cover | undefined>;
  /** A cover of two adjacent spans, left then right. */
  node(left: Cover, right: Cover): Promise<Cover>;
  close(): Promise<void>;
}

const LEAVES = new Map<number, TrailCircuit>(Object.entries(LEAF_KINDS).map(([name, kind]) => [kind, name as TrailCircuit]));
/** A proof's or key's bytes as the field elements a circuit's ABI takes. */
const fields = (bytes: Uint8Array): string[] => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${bytesToHex(bytes.subarray(32 * i, 32 * i + 32))}`);

/**
 * The aggregator over `api`, which `startCheckSetBackend` started, checking statement proofs with `statements`
 * (pool-v3's verifier, routing each kind to its own key) before their leaves.
 */
export async function openTrailProver(api: Barretenberg, statements: KeyedVerifier, options: VerifierOptions = {}): Promise<TrailProver> {
  // Proving a 2^21-row circuit needs the check set's points; refused here rather than deep inside the backend.
  if (startedPoints(api) !== CHECK_SET_PARAMETERS.points) throw new ParameterError("UNCHECKED", "the aggregator proves on an instance startCheckSetBackend started");
  const programs = trailPrograms(), keys = trailKeys(), set = openTrailCheckSet(api, options);
  const circuits = new Map<TrailCircuit, { readonly noir: Noir; readonly backend: UltraHonkBackend }>();
  for (const name of TRAIL_CIRCUITS) {
    const program = programs[name] as unknown as CompiledCircuit;
    circuits.set(name, { noir: new Noir(program), backend: new UltraHonkBackend(program.bytecode, api) });
  }
  const nodeKeyHash = fieldToHex(keys.node.keyHash);
  /** Prove `name` over `inputs`; the proof must carry (nodeKeyHash, `digest`) and verify as a cover of `kind`. */
  const prove = async (name: TrailCircuit, inputs: InputMap, kind: number | undefined, digest: bigint): Promise<Cover> => {
    const circuit = circuits.get(name)!;
    const { witness } = await circuit.noir.execute(inputs);
    const proof = await circuit.backend.generateProof(witness, PROOF_OPTIONS);
    const carried = proof.publicInputs.map(BigInt);
    if (carried.length !== 2 || carried[0] !== keys.node.keyHash || carried[1] !== digest) {
      throw new AggregatorError("PUBLIC_INPUTS", `the ${name} proof does not carry the span's digest`);
    }
    if (await set.verify(kind, digest, proof.proof) !== true) throw new AggregatorError("UNVERIFIED", `the ${name} proof does not verify`);
    return Object.freeze({ kind, digest, proof: copyBytes(proof.proof) });
  };
  const leaf = async (record: Record): Promise<Cover | undefined> => {
    const name = LEAVES.get(record?.kind);
    if (name === undefined) throw new EncodingError("a leaf covers kinds 1, 2, 3, 4 and 6");
    const proof = copyBytes(record.proof), inputs = [...record.publicInputs];
    // §3.5: native first; a proof of any other length enters no leaf.
    if (proof.length !== COVER_PROOF_BYTES || await statements.verify(record.kind, inputs, proof) !== true) return undefined;
    const digest = statementLeafDigest(record.kind, inputs, sha256(proof));
    return prove(name, { proof: fields(proof), inputs: inputs.map(fieldToHex), node_key_hash: nodeKeyHash }, record.kind, digest);
  };
  const node = async (left: Cover, right: Cover): Promise<Cover> => {
    const children = [left, right].map(child => {
      const name = child.kind === undefined ? "node" : LEAVES.get(child.kind);
      if (name === undefined) throw new EncodingError("a child is a leaf of kind 1, 2, 3, 4 or 6, or a node");
      return { key: keys[name], proof: copyBytes(child.proof), digest: child.digest };
    });
    const digest = nodeDigest(left.digest, right.digest);
    return prove("node", {
      keys: children.map(c => fields(c.key.vk)), proofs: children.map(c => fields(c.proof)),
      key_hashes: children.map(c => fieldToHex(c.key.keyHash)), digests: children.map(c => fieldToHex(c.digest)), node_key_hash: nodeKeyHash,
    }, undefined, digest);
  };
  return { identity: set.identity, set, leaf, node, close: () => set.close() };
}
