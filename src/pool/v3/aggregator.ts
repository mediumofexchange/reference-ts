// The trail aggregator (succinct-read §§2 rule 6, 3.2, 3.5): any party proves the check proofs that cover a trail's
// proved records, from the records with their proofs, under the test set's shipped programs (`check-set.ts`). Each
// statement proof is verified natively under pool-v3's key for its kind before its leaf is proved, since the pinned
// backend proves a leaf over a proof that does not verify and only that leaf's verification then fails (§3.5); a record
// whose proof fails, or does not have the 458 elements a leaf reads, gets no cover, and neither does any span holding
// it. Every check proof made here is verified under the set's pinned key, with the public inputs a reader derives,
// before it is returned. Nothing here is signed or carries authority: a reader checks every cover itself. A trail's
// spans are walked by `coverTrail` (succinct.ts), as a replica proves them (`V3Replica.prove`).
//
// The aggregator proves on an instance of its own, started by `startCheckSetBackend` from the check set's parameters,
// on the pinned WebAssembly backend or the native binary bb.js bundles (slice 42), and verifies covers on WebAssembly
// instances of the set's own either way. A failure while an instance proves can leave it unusable (a WebAssembly
// instance traps on later calls; a native one may have exited), so the instance is destroyed and the next proof starts
// a fresh one; proofs run one at a time, so none is in flight on an instance being retired.
import type { Barretenberg } from "@aztec/bb.js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyBytes, EncodingError } from "../../bytes.js";
import { fieldToHex } from "../field.js";
import { PROOF_OPTIONS, startCheckSetBackend, type KeyedVerifier, type ProvingParameters } from "../proof-verifier.js";
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
  /** The backend the covers are proved on. */
  readonly backend: "native" | "wasm";
  /** A cover of one proved record (a span of one), or undefined where its proof fails the native check. */
  leaf(record: Record): Promise<Cover | undefined>;
  /** A cover of two adjacent spans, left then right. */
  node(left: Cover, right: Cover): Promise<Cover>;
  close(): Promise<void>;
}

const LEAVES = new Map<number, TrailCircuit>(Object.entries(LEAF_KINDS).map(([name, kind]) => [kind, name as TrailCircuit]));
/** A proof's or key's bytes as the field elements a circuit's ABI takes. */
const fields = (bytes: Uint8Array): string[] => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${bytesToHex(bytes.subarray(32 * i, 32 * i + 32))}`);

/** How the aggregator proves. */
export interface TrailProverOptions {
  /** On the native binary the pinned bb.js bundles (`nativeRefusal` says where it does not), not WebAssembly. */
  readonly native?: boolean;
  /** Threads the proving instance runs (default one). */
  readonly threads?: number;
}

/**
 * The aggregator, checking statement proofs with `statements` (pool-v3's verifier, routing each kind to its own key)
 * before their leaves. `parameters` supplies the check set's parameters at each start of a proving instance, the
 * first here and each after a failure, so a long-lived prover keeps no copy of their 128 MiB; each start checks them.
 */
export async function openTrailProver(parameters: () => Promise<ProvingParameters>, statements: KeyedVerifier,
  options: TrailProverOptions = {}): Promise<TrailProver> {
  const native = options.native === true, threads = options.threads;
  const programs = trailPrograms(), keys = trailKeys();
  const start = async (): Promise<Barretenberg> => startCheckSetBackend(await parameters(), { native, ...threads === undefined ? {} : { threads } });
  /** An instance with each circuit's backend over it. */
  const over = (api: Barretenberg) => ({ api, backends: new Map(TRAIL_CIRCUITS.map(name =>
    [name, new UltraHonkBackend((programs[name] as unknown as CompiledCircuit).bytecode, api)] as const)) });
  let current: ReturnType<typeof over> | undefined = over(await start()), set: TrailCheckSet;
  try { set = openTrailCheckSet(current.api); } catch (error) { await current.api.destroy().catch(() => {}); throw error; }
  const noir = new Map(TRAIL_CIRCUITS.map(name => [name, new Noir(programs[name] as unknown as CompiledCircuit)] as const));
  const retire = async (): Promise<void> => {
    const retired = current;
    current = undefined;
    // The instance is abandoned either way; a failed destroy changes nothing the caller is told.
    if (retired !== undefined) await retired.api.destroy().catch(() => {});
  };
  let queue: Promise<unknown> = Promise.resolve(), closed = false;
  const serially = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };
  const nodeKeyHash = fieldToHex(keys.node.keyHash);
  /** Prove `name` over `inputs`; the proof must carry (nodeKeyHash, `digest`) and verify as a cover of `kind`. */
  const prove = (name: TrailCircuit, inputs: InputMap, kind: number | undefined, digest: bigint): Promise<Cover> => serially(async () => {
    if (closed) throw new Error("the trail prover is closed");
    const { witness } = await noir.get(name)!.execute(inputs);
    current ??= over(await start());
    try {
      const proof = await current.backends.get(name)!.generateProof(witness, PROOF_OPTIONS);
      const carried = proof.publicInputs.map(BigInt);
      if (carried.length !== 2 || carried[0] !== keys.node.keyHash || carried[1] !== digest) {
        throw new AggregatorError("PUBLIC_INPUTS", `the ${name} proof does not carry the span's digest`);
      }
      if (await set.verify(kind, digest, proof.proof) !== true) throw new AggregatorError("UNVERIFIED", `the ${name} proof does not verify`);
      return Object.freeze({ kind, digest, proof: copyBytes(proof.proof) });
    } catch (error) {
      // Whatever failed, the instance that made it is not trusted with the next proof.
      await retire();
      throw error;
    }
  });
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
  return { identity: set.identity, set, backend: native ? "native" : "wasm", leaf, node,
    // Proofs asked for before `close` finish; later ones refuse.
    async close() {
      closed = true;
      await serially(retire);
      await set.close();
    } };
}
