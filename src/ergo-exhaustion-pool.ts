// The venue exhaustion's prover side (succinct-read §4.3, slice 43): a period handed over by the map's keeper
// (`ExhaustionServer`) is proved leaf by leaf, joined pairwise by exhaustion nodes and folded, first or next, on the
// bundled native backend from `EXHAUSTION_PARAMETERS`' points. A fold's period is checked against the map before any
// proof starts (its leaves must end where a fold requires, at the fold's end header with the map's root), and each
// proof must carry the public inputs its place requires, so a disagreement costs no hours of proving.
//
// Leaves and nodes are independent proofs: one prover proves them one at a time while it computes the next leaf's
// witness (natively, in a process of its own: `exhaustionPrograms`), which takes less time than a proof; provers on several machines share a period by the same tree. Each proof
// is kept under the hash of its circuit and inputs (`proofs`), so a prover that stops resumes where it stood and a
// period proved again costs a verification of each kept proof, not the proofs.
//
// No set is adopted (§6): `circuitExhaustionSet` names a test set over built circuits, whose folds are real proofs a
// reader verifies under the pinned fold keys, and which no reader may rely on until an adoption names its identities.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Barretenberg } from "@aztec/bb.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { EMPTY_SUBTREES, foldPublicInputs, MAP_DEPTH, type Fold, type FoldInputs, type MapUpdate } from "./ergo-exhaustion.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_KEY_BYTES, EXHAUSTION_PROOF_BYTES, type BuiltCircuit, type ExhaustionCircuit, type ExhaustionCircuits }
  from "./ergo-exhaustion-set.js";
import { foldStateInputs, isPeriodEnd, leavesOf, stateEnd, stateHash, type ExhaustionLeaf, type LeafSizes, type PeriodLeaves }
  from "./ergo-exhaustion-prover.js";
import type { ServedBlock } from "./ergo-exhaustion-server.js";
import { fieldToHex, limbsOf } from "./pool/field.js";
import { keyedVerifier, startExhaustionBackend, type CompiledProgram, type KeyedVerifier, type ProvingParameters }
  from "./pool/proof-verifier.js";

export { circuitExhaustionSet, circuitIdentities, EXHAUSTION_CIRCUITS, EXHAUSTION_PROOF_BYTES, type BuiltCircuit, type ExhaustionCircuit,
  type ExhaustionCircuits } from "./ergo-exhaustion-set.js";

/** A parameter's array length in a program's ABI. */
function abiLength(program: CompiledProgram, name: string): number {
  const abi = (program as unknown as { abi?: { parameters?: { name: string; type: { kind: string; length?: number } }[] } }).abi;
  const length = abi?.parameters?.find(p => p.name === name)?.type.length;
  if (!Number.isSafeInteger(length) || length! <= 0) throw new EncodingError(`a leaf program without its ${name} array`);
  return length!;
}

/** The circuits as `scripts/venue/exhaustion-build.mjs` writes them: `<name>/program.json`, `<name>/vk/vk` and
 * `<name>/vk/vk_hash` under `directory`. Nothing here judges them: a set's identity names what was read. */
export function readExhaustionCircuits(directory: string): ExhaustionCircuits {
  const circuits = Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => {
    const program = JSON.parse(readFileSync(join(directory, name, "program.json"), "utf8")) as CompiledProgram;
    const vk = new Uint8Array(readFileSync(join(directory, name, "vk", "vk")));
    const hash = readFileSync(join(directory, name, "vk", "vk_hash"));
    if (typeof program?.bytecode !== "string" || vk.length !== EXHAUSTION_KEY_BYTES || hash.length !== 32) throw new EncodingError(`a malformed ${name} build`);
    return [name, Object.freeze({ program, vk, keyHash: BigInt(`0x${hash.toString("hex")}`) })];
  })) as Record<ExhaustionCircuit, BuiltCircuit>;
  const sizes = Object.freeze({ t: abiLength(circuits["leaf-t"].program, "tb"), m: abiLength(circuits["leaf-m"].program, "mb"),
    u: abiLength(circuits["leaf-u"].program, "uu") });
  return Object.freeze({ sizes, circuits: Object.freeze(circuits) });
}

/** A proof as the pool holds it: its bytes and the public inputs it carries. */
export interface ExhaustionProof { readonly circuit: ExhaustionCircuit; readonly proof: Uint8Array; readonly publicInputs: readonly bigint[] }

/** A circuit's inputs by parameter name: strings, booleans, arrays and structs, as `ergo-exhaustion-prover.ts` builds them. */
export type CircuitInputs = Readonly<Record<string, unknown>>;
/** A circuit's witness over its inputs, compressed as the backend takes it. A refusal names the failed check. */
export type ExhaustionWitness = (circuit: ExhaustionCircuit, inputs: CircuitInputs) => Promise<Uint8Array>;

/** What proves one circuit's statement: a witness from inputs, then a proof from the witness. The pool's own computes
 * witnesses natively and proves on the native backend; tests give another. */
export interface ExhaustionBackend {
  /** The witness of `circuit` over `inputs`. A refusal names the failed check. */
  witness: ExhaustionWitness;
  /** A proof of `circuit` from `witness`, under the recursive target. */
  prove(circuit: ExhaustionCircuit, witness: Uint8Array): Promise<{ proof: Uint8Array; publicInputs: readonly bigint[] }>;
  /** Whether `proof` verifies under `circuit`'s key with exactly `publicInputs`. */
  verify(circuit: ExhaustionCircuit, proof: Uint8Array, publicInputs: readonly bigint[]): Promise<boolean>;
  close(): Promise<void>;
}

/** UltraHonk's settings under the recursive target (`PROOF_OPTIONS`), as bb.js 5.2.0 derives them. */
const RECURSIVE_SETTINGS = Object.freeze({ ipaAccumulation: false, oracleHashType: "poseidon2", disableZk: false, optimizedSolidityVerifier: false });

/** The pool's backend: witnesses by `witnesses` (`exhaustionPrograms`' native ones) and native proofs on an instance started from `parameters` at the first proof
 * and again after any failure, which retires the instance that failed (as the trail aggregator does). Each proof is
 * made with the circuit's built key (bb.js's `generateProof` passes none and derives it again at every proof, about
 * two fifths of a leaf's time). Proofs are verified apart from the prover, under the built keys on verifying instances
 * of their own (`keyedVerifier`, which reads the started instance's `[1]_1` and `[x]_2` once): bytes that are no proof
 * verify as false and retire only a verifying instance, never the one proving. */
export function nativeExhaustionBackend(circuits: ExhaustionCircuits, witnesses: ExhaustionWitness, parameters: () => Promise<ProvingParameters>,
    options: { readonly threads?: number } = {}): ExhaustionBackend {
  const bytecode = new Map(EXHAUSTION_CIRCUITS.map(name =>
    [name, gunzipSync(Buffer.from(circuits.circuits[name].program.bytecode, "base64"))] as const));
  type Instance = { readonly api: Barretenberg };
  // One instance at a time: concurrent calls share the start in flight, and a failure retires only the instance it ran on.
  let current: Promise<Instance> | undefined, verifying: Promise<KeyedVerifier> | undefined, closed = false;
  const instance = (): Promise<Instance> => {
    // A closed backend starts nothing: a period proving when it closed stops at its next proof or verification.
    if (closed) return Promise.reject(new Error("the exhaustion backend is closed"));
    current ??= (async () => {
      const api = await startExhaustionBackend(await parameters(), options.threads === undefined ? {} : { threads: options.threads });
      return { api };
    })();
    const started = current;
    started.catch(() => { if (current === started) current = undefined; });
    return started;
  };
  const retire = async (which: Promise<Instance> | undefined = current): Promise<void> => {
    if (which === undefined) return;
    if (current === which) current = undefined;
    await which.then(on => on.api.destroy(), () => {}).catch(() => {});
  };
  const guarded = async <T>(task: (on: Instance) => Promise<T>): Promise<T> => {
    const used = instance();
    try { return await task(await used); } catch (error) { await retire(used); throw error; }
  };
  return {
    witness: (circuit, inputs) => witnesses(circuit, inputs),
    prove: (circuit, witness) => guarded(async ({ api }) => {
      const made = await api.circuitProve({ witness: gunzipSync(witness),
        circuit: { name: circuit, bytecode: bytecode.get(circuit)!, verificationKey: circuits.circuits[circuit].vk }, settings: RECURSIVE_SETTINGS });
      const proof = new Uint8Array(made.proof.length * 32);
      made.proof.forEach((field, i) => proof.set(field, 32 * i));
      return { proof, publicInputs: made.publicInputs.map(field => BigInt(`0x${Buffer.from(field).toString("hex")}`)) };
    }),
    async verify(circuit, proof, publicInputs) {
      if (verifying === undefined) {
        const made = verifying = instance().then(on => keyedVerifier(on.api, EXHAUSTION_CIRCUITS.map((name, kind) =>
          ({ kind, vk: circuits.circuits[name].vk, publicInputs: name.startsWith("fold") ? 8 : 3 })), EXHAUSTION_PROOF_BYTES));
        made.catch(() => { if (verifying === made) verifying = undefined; });
      }
      return (await verifying).verify(EXHAUSTION_CIRCUITS.indexOf(circuit), publicInputs, proof);
    },
    async close() {
      closed = true;
      const verifier = verifying;
      verifying = undefined;
      await Promise.all([retire(), verifier?.then(v => v.close(), () => {}).catch(() => {})]);
    },
  };
}

/** Where proofs are kept by the hash of their circuit and inputs: one file each, written whole. */
export interface ProofStore {
  get(label: string): ExhaustionProof | undefined;
  put(label: string, proof: ExhaustionProof): void;
}
/** Proofs kept as files in `directory`. A file that does not read as a proof is passed over and proved again. */
export function proofDirectory(directory: string): ProofStore {
  mkdirSync(directory, { recursive: true });
  return {
    get(label) {
      try {
        const kept = JSON.parse(readFileSync(join(directory, `${label}.json`), "utf8")) as { circuit: ExhaustionCircuit; proof: string; publicInputs: string[] };
        const proof = new Uint8Array(Buffer.from(kept.proof, "base64"));
        if (!EXHAUSTION_CIRCUITS.includes(kept.circuit) || proof.length !== EXHAUSTION_PROOF_BYTES || !Array.isArray(kept.publicInputs)) return undefined;
        return Object.freeze({ circuit: kept.circuit, proof, publicInputs: Object.freeze(kept.publicInputs.map(x => BigInt(x))) });
      } catch { return undefined; }
    },
    put(label, { circuit, proof, publicInputs }) {
      const file = join(directory, `${label}.json`), temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ circuit, proof: Buffer.from(proof).toString("base64"), publicInputs: publicInputs.map(fieldToHex) }));
      renameSync(temporary, file);
    },
  };
}

/** A period as `ExhaustionServer` hands it to `prove`: where it begins, its blocks, the map's updates over them and the
 * fold it continues (none for a first fold). */
export interface ServedPeriod {
  readonly begin: { readonly id: Uint8Array; readonly height: bigint; readonly root: bigint };
  readonly blocks: readonly ServedBlock[];
  readonly updates: readonly MapUpdate[];
  readonly previous: Fold | undefined;
}

/** What a period's proving did: its leaves by kind, its nodes, and how many proofs were made rather than kept. */
export interface PeriodProved {
  readonly leaves: { readonly t: number; readonly m: number; readonly u: number };
  readonly nodes: number;
  readonly made: number;
  readonly kept: number;
  readonly seconds: number;
}

export class ExhaustionProverError extends Error {
  constructor(readonly code: "PERIOD" | "PUBLIC_INPUTS" | "UNVERIFIED", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ExhaustionProverError";
  }
}

export interface ExhaustionPoolOptions {
  readonly circuits: ExhaustionCircuits;
  readonly backend: ExhaustionBackend;
  /** Where proofs are kept; none keeps them only for the period. */
  readonly proofs?: ProofStore;
  /** One line per proof and per period. */
  readonly log?: (line: string) => void;
}

/** A proof's or key's bytes as the circuits take them: each 32 bytes one field, as hex (the recursive verifier judges them). */
const fields = (bytes: Uint8Array): string[] => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${Buffer.from(bytes.subarray(32 * i, 32 * i + 32)).toString("hex")}`);
const same = (a: readonly bigint[], b: readonly bigint[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A prover of exhaustion periods over built circuits. `fold(first, inputs, period)` is `ExhaustionServer`'s `prove`:
 * the period's leaves are recomputed from its blocks and the map's updates, its end checked against `inputs`, and the
 * fold proved and verified under its own key before it is returned.
 */
export class ExhaustionPool {
  readonly sizes: LeafSizes;
  readonly nodeKeyHash: bigint;
  readonly foldKeyHash: bigint;
  readonly #options: ExhaustionPoolOptions;
  readonly #keys: Readonly<Record<ExhaustionCircuit, { readonly fields: string[]; readonly hash: string }>>;
  #last: PeriodProved | undefined;

  constructor(options: ExhaustionPoolOptions) {
    this.#options = options;
    const { circuits } = options.circuits;
    this.sizes = options.circuits.sizes;
    this.nodeKeyHash = circuits.node.keyHash;
    this.foldKeyHash = circuits["fold-next"].keyHash;
    this.#keys = Object.freeze(Object.fromEntries(EXHAUSTION_CIRCUITS.map(name =>
      [name, Object.freeze({ fields: fields(circuits[name].vk), hash: fieldToHex(circuits[name].keyHash) })])) as Record<ExhaustionCircuit, { fields: string[]; hash: string }>);
  }

  /** What the last period's proving did. */
  get last(): PeriodProved | undefined { return this.#last; }

  /** The period's leaves, checked to end where `inputs` say with the map's root: a disagreement refuses `PERIOD`. */
  leaves(inputs: FoldInputs, period: ServedPeriod): PeriodLeaves {
    // Each header must be its block's and name the one before as its parent: the circuits refuse a break at its leaf,
    // after the leaves before it are proved.
    let parent = period.begin.id;
    const blocks = period.blocks.map(block => {
      if (!(block.header instanceof Uint8Array)) throw new ExhaustionProverError("PERIOD", "a period's block carries no header bytes");
      if (block.header.length < 97 || compareBytes(blake2b(block.header, { dkLen: 32 }), block.id) !== 0 || compareBytes(block.header.subarray(1, 33), parent) !== 0) {
        throw new ExhaustionProverError("PERIOD", "a period's headers do not chain from its start");
      }
      parent = block.id;
      return { header: block.header, transactions: block.section };
    });
    let run: PeriodLeaves;
    try { run = leavesOf({ begin: period.begin, blocks, updates: period.updates }, this.sizes, this.nodeKeyHash); } catch (error) {
      throw new ExhaustionProverError("PERIOD", `the period's leaves cannot be built: ${(error as Error).message}`, { cause: error });
    }
    const end = stateEnd(run.end);
    if (!isPeriodEnd(run.end) || end.height !== inputs.endHeight || compareBytes(end.id, inputs.endId) !== 0 || run.end.u.root !== inputs.mapRoot) {
      throw new ExhaustionProverError("PERIOD", `the period's leaves do not end at the fold's end header ${inputs.endHeight} with its map root`);
    }
    return run;
  }

  /** Whether the period continues what its fold continues: a first fold's from the start with the empty map, a next
   * fold's from its previous fold's end with that fold's root, under the same start and key hash, the previous fold's
   * proof verifying under its key. The circuits check the same, but only at the fold, after every leaf is proved. */
  async #continues(first: boolean, inputs: FoldInputs, period: ServedPeriod): Promise<void> {
    const { begin, previous } = period;
    const refuse = (why: string): never => { throw new ExhaustionProverError("PERIOD", `the period ${why}`); };
    if (first) {
      if (previous !== undefined) refuse("of a first fold continues a fold");
      if (begin.height !== inputs.startHeight || compareBytes(begin.id, inputs.startId) !== 0 || begin.root !== EMPTY_SUBTREES[MAP_DEPTH]) {
        refuse("of a first fold does not begin at the start with the empty map");
      }
      return;
    }
    if (previous === undefined) return refuse("of a next fold continues no fold");
    const before = foldPublicInputs(previous.inputs);
    if (before === undefined || previous.inputs.startHeight !== inputs.startHeight || compareBytes(previous.inputs.startId, inputs.startId) !== 0 ||
        previous.inputs.foldKeyHash !== inputs.foldKeyHash) refuse("continues a fold of another start or key");
    if (previous.inputs.endHeight !== begin.height || compareBytes(previous.inputs.endId, begin.id) !== 0 || previous.inputs.mapRoot !== begin.root) {
      refuse("does not begin where its previous fold ends");
    }
    if (await this.#options.backend.verify(previous.first ? "fold-first" : "fold-next", previous.proof, before!) !== true) {
      refuse("continues a fold whose proof does not verify");
    }
  }

  /** The fold proof for `inputs` over `period`. */
  async fold(first: boolean, inputs: FoldInputs, period: ServedPeriod): Promise<Uint8Array> {
    const started = Date.now();
    const publicInputs = foldPublicInputs(inputs);
    if (publicInputs === undefined || inputs.foldKeyHash !== this.foldKeyHash) throw new ExhaustionProverError("PERIOD", "fold inputs this set does not prove");
    await this.#continues(first, inputs, period);
    const run = this.leaves(inputs, period);
    const counts = { t: 0, m: 0, u: 0 };
    for (const leaf of run.leaves) counts[leaf.kind]++;
    let made = 0, kept = 0;
    const tally = (fresh: boolean): void => { if (fresh) made++; else kept++; };
    const level: ExhaustionProof[] = [];
    // Leaves in order, each witness computed while the previous leaf proves; a failed leaf stops the ones after it.
    let proving: Promise<unknown> = Promise.resolve();
    const leafProofs: Promise<ExhaustionProof>[] = [];
    for (const [k, leaf] of run.leaves.entries()) {
      const circuit = `leaf-${leaf.kind}` as const;
      const expected = [leaf.sin, leaf.sout, this.nodeKeyHash];
      const one = this.#prove(circuit, leaf.inputs, expected, `period to ${inputs.endHeight}: leaf ${k + 1}/${run.leaves.length} (${leaf.kind})`,
        proving, tally);
      one.catch(() => {});
      leafProofs.push(one);
      proving = one;
      // At most one leaf's witness waits for the prover.
      if (k > 0) await leafProofs[k - 1];
    }
    for (const p of leafProofs) level.push(await p);
    let nodes = 0, current = level;
    while (current.length > 1) {
      const up: ExhaustionProof[] = [];
      for (let i = 0; i + 1 < current.length; i += 2) {
        const [a, b] = [current[i]!, current[i + 1]!];
        up.push(await this.#prove("node", {
          sin: fieldToHex(a.publicInputs[0]!), sout: fieldToHex(b.publicInputs[1]!), node_key_hash: fieldToHex(this.nodeKeyHash),
          keys: [this.#keys[a.circuit].fields, this.#keys[b.circuit].fields], proofs: [fields(a.proof), fields(b.proof)],
          key_hashes: [this.#keys[a.circuit].hash, this.#keys[b.circuit].hash], middle: fieldToHex(a.publicInputs[1]!),
        }, [a.publicInputs[0]!, b.publicInputs[1]!, this.nodeKeyHash], `period to ${inputs.endHeight}: node`, Promise.resolve(), tally));
        nodes++;
      }
      if (current.length % 2) up.push(current.at(-1)!);
      current = up;
    }
    const root = current[0]!;
    if (root.publicInputs[0] !== stateHash(run.start) || root.publicInputs[1] !== stateHash(run.end)) {
      throw new ExhaustionProverError("PUBLIC_INPUTS", "the period's tree does not span its states");
    }
    const [sh, sl] = limbsOf(inputs.startId), [eh, el] = limbsOf(inputs.endId);
    const foldInputs: Record<string, unknown> = {
      start_hi: fieldToHex(sh), start_lo: fieldToHex(sl), start_height: fieldToHex(inputs.startHeight), end_hi: fieldToHex(eh), end_lo: fieldToHex(el),
      end_height: fieldToHex(inputs.endHeight), map_root: fieldToHex(inputs.mapRoot), fold_key_hash: fieldToHex(inputs.foldKeyHash),
      key: this.#keys[root.circuit].fields, proof: fields(root.proof), key_hash: this.#keys[root.circuit].hash,
      ...foldStateInputs(run.start, "0"), ...foldStateInputs(run.end, "1"),
    };
    if (period.previous !== undefined) {
      const previous = this.#keys[period.previous.first ? "fold-first" : "fold-next"];
      Object.assign(foldInputs, { previous_key: previous.fields, previous_proof: fields(period.previous.proof), previous_key_hash: previous.hash });
    }
    const circuit = first ? "fold-first" : "fold-next";
    const fold = await this.#prove(circuit, foldInputs, publicInputs, `period to ${inputs.endHeight}: ${circuit}`, Promise.resolve(), tally);
    this.#last = Object.freeze({ leaves: Object.freeze(counts), nodes, made, kept, seconds: (Date.now() - started) / 1000 });
    this.#options.log?.(`period to ${inputs.endHeight}: ${run.leaves.length} leaves, ${nodes} nodes, ${made} proved, ${kept} kept, ${this.#last.seconds.toFixed(0)} s`);
    return copyBytes(fold.proof);
  }

  /** `circuit` over `inputs`, kept or proved after `after` settles; the proof must carry `expected`. */
  async #prove(circuit: ExhaustionCircuit, inputs: CircuitInputs, expected: readonly bigint[], label: string, after: Promise<unknown>,
      tally: (fresh: boolean) => void): Promise<ExhaustionProof> {
    const { backend, proofs, log } = this.#options;
    const name = bytesToHex(sha256(new TextEncoder().encode(`${circuit}\n${JSON.stringify(inputs)}`)));
    // A kept proof is verified again (a second against a proof's minute): a damaged file is proved again, not folded.
    const held = proofs?.get(name);
    if (held !== undefined && held.circuit === circuit && same(held.publicInputs, expected) &&
        await backend.verify(circuit, held.proof, expected).catch(() => false) === true) {
      tally(false);
      return held;
    }
    const t0 = Date.now();
    const witness = await backend.witness(circuit, inputs);
    const t1 = Date.now();
    await after;
    const t2 = Date.now();
    const made = await backend.prove(circuit, witness);
    if (!same(made.publicInputs, expected)) throw new ExhaustionProverError("PUBLIC_INPUTS", `the ${circuit} proof does not carry its place's public inputs`);
    if (made.proof.length !== EXHAUSTION_PROOF_BYTES) throw new ExhaustionProverError("UNVERIFIED", `a ${circuit} proof of ${made.proof.length} bytes`);
    // A proof that does not verify under its own key would fail only at the fold, and kept, at every later attempt.
    if (await backend.verify(circuit, made.proof, made.publicInputs) !== true) throw new ExhaustionProverError("UNVERIFIED", `a ${circuit} proof does not verify`);
    const proof: ExhaustionProof = Object.freeze({ circuit, proof: copyBytes(made.proof), publicInputs: Object.freeze([...made.publicInputs]) });
    proofs?.put(name, proof);
    tally(true);
    log?.(`${label}: witness ${((t1 - t0) / 1000).toFixed(1)} s, proof ${((Date.now() - t2) / 1000).toFixed(1)} s`);
    return proof;
  }
}

/** The leaves' kinds in order, for a log or a report. */
export const leafKinds = (leaves: readonly ExhaustionLeaf[]): string => leaves.map(l => l.kind).join("");
