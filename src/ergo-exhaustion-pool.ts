// The venue exhaustion's prover side (succinct-read §4.3, slice 43): a period handed over by the map's keeper
// (`ExhaustionServer`) is proved leaf by leaf, joined pairwise by exhaustion nodes and folded, first or next, on the
// bundled native backend from `EXHAUSTION_PARAMETERS`' points. A fold's period is checked against the map before any
// proof starts (its leaves must end where a fold requires, at the fold's end header with the map's root), and each
// proof must carry the public inputs its place requires, so a disagreement costs no hours of proving.
//
// Leaves and nodes are independent proofs: one prover proves them one at a time while it computes the next leaf's
// witness, which takes less time than a proof; provers on several machines share a period by the same tree. Each proof
// is kept under the hash of its circuit and inputs (`proofs`), so a prover that stops resumes where it stood and a
// period proved again costs only its witnesses' state, not its proofs.
//
// No set is adopted (§6): `circuitExhaustionSet` names a test set over built circuits, whose folds are real proofs a
// reader verifies under the pinned fold keys, and which no reader may rely on until an adoption names its identities.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UltraHonkBackend, type Barretenberg } from "@aztec/bb.js";
import { Noir, type CompiledCircuit, type InputMap } from "@noir-lang/noir_js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { foldPublicInputs, type ExhaustionSet, type Fold, type FoldInputs, type MapUpdate } from "./ergo-exhaustion.js";
import { foldStateInputs, isPeriodEnd, leavesOf, stateEnd, stateHash, type ExhaustionLeaf, type LeafSizes, type PeriodLeaves }
  from "./ergo-exhaustion-prover.js";
import type { ServedBlock } from "./ergo-exhaustion-server.js";
import { fieldToBytes, fieldToHex, limbsOf } from "./pool/field.js";
import { EXHAUSTION_PARAMETERS } from "./pool/parameters.js";
import { keyedVerifier, PROOF_OPTIONS, startExhaustionBackend, type CompiledProgram, type KeyedVerifier, type ProvingParameters }
  from "./pool/proof-verifier.js";

/** The exhaustion circuits (§4.3): the three leaves, the node, the first and the next fold. */
export const EXHAUSTION_CIRCUITS = Object.freeze(["leaf-t", "leaf-m", "leaf-u", "node", "fold-first", "fold-next"] as const);
export type ExhaustionCircuit = typeof EXHAUSTION_CIRCUITS[number];
/** Every exhaustion proof's length: UltraHonk's under the recursive target. */
export const EXHAUSTION_PROOF_BYTES = 458 * 32;
const KEY_BYTES = 115 * 32;

/** One built circuit: its program, its key's bytes and the key hash the backend derives. */
export interface BuiltCircuit { readonly program: CompiledProgram; readonly vk: Uint8Array; readonly keyHash: bigint }
/** A built set of the six circuits, with the leaves' sizes read from their programs. */
export interface ExhaustionCircuits { readonly sizes: LeafSizes; readonly circuits: Readonly<Record<ExhaustionCircuit, BuiltCircuit>> }

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
    if (typeof program?.bytecode !== "string" || vk.length !== KEY_BYTES || hash.length !== 32) throw new EncodingError(`a malformed ${name} build`);
    return [name, Object.freeze({ program, vk, keyHash: BigInt(`0x${hash.toString("hex")}`) })];
  })) as Record<ExhaustionCircuit, BuiltCircuit>;
  const sizes = Object.freeze({ t: abiLength(circuits["leaf-t"].program, "tb"), m: abiLength(circuits["leaf-m"].program, "mb"),
    u: abiLength(circuits["leaf-u"].program, "uu") });
  return Object.freeze({ sizes, circuits: Object.freeze(circuits) });
}

/** Each circuit's identities as an adoption would name them (§6): SHA-256 of its decoded bytecode and of its key, and
 * its key hash. */
export function circuitIdentities(circuits: ExhaustionCircuits): Readonly<Record<ExhaustionCircuit, { bytecode: string; vk: string; keyHash: string }>> {
  return Object.freeze(Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => {
    const c = circuits.circuits[name];
    return [name, Object.freeze({ bytecode: bytesToHex(sha256(Buffer.from(c.program.bytecode, "base64"))), vk: bytesToHex(sha256(c.vk)),
      keyHash: fieldToHex(c.keyHash) })];
  })) as Record<ExhaustionCircuit, { bytecode: string; vk: string; keyHash: string }>);
}

/**
 * A test set over built circuits from `start` (§§1, 6): its identity frames `moe/succinct/v1/set`, the label `test`,
 * each circuit's identities in §4.3's order, the proving points' hash and the start; a fold verifies under the pinned
 * first-fold or next-fold key on instances of `api`'s (which reads only `[1]_1` and `[x]_2`). `close` ends its verifier.
 */
export function circuitExhaustionSet(circuits: ExhaustionCircuits, start: { readonly id: Uint8Array; readonly height: bigint },
    api: Barretenberg): ExhaustionSet & { close(): Promise<void> } {
  if (!(start?.id instanceof Uint8Array) || start.id.length !== 32 || typeof start.height !== "bigint" || start.height < 0n || start.height >= 1n << 32n) {
    throw new EncodingError("invalid exhaustion start");
  }
  const encoder = new TextEncoder(), w = new ByteWriter(), ids = circuitIdentities(circuits);
  for (const part of [encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), encoder.encode("exhaustion-circuits"),
    ...EXHAUSTION_CIRCUITS.flatMap(name => [encoder.encode(name), Buffer.from(ids[name].bytecode, "hex"), Buffer.from(ids[name].vk, "hex"),
      fieldToBytes(circuits.circuits[name].keyHash)]),
    Buffer.from(EXHAUSTION_PARAMETERS.g1, "hex"), copyBytes(start.id), fieldToBytes(start.height)]) w.lengthPrefixed(part);
  const verifier: KeyedVerifier = keyedVerifier(api, [{ kind: 1, vk: circuits.circuits["fold-first"].vk, publicInputs: 8 },
    { kind: 2, vk: circuits.circuits["fold-next"].vk, publicInputs: 8 }], EXHAUSTION_PROOF_BYTES);
  return Object.freeze({
    identity: sha256(w.finish()), test: true, start: Object.freeze({ id: copyBytes(start.id), height: start.height }),
    foldKeyHash: circuits.circuits["fold-next"].keyHash,
    verifyFold: (first: boolean, inputs: readonly bigint[], proof: Uint8Array) => verifier.verify(first ? 1 : 2, inputs, proof),
    close: () => verifier.close(),
  });
}

/** A proof as the pool holds it: its bytes and the public inputs it carries. */
export interface ExhaustionProof { readonly circuit: ExhaustionCircuit; readonly proof: Uint8Array; readonly publicInputs: readonly bigint[] }

/** What proves one circuit's statement: a witness from inputs, then a proof from the witness. The pool's own runs on
 * noir_js and the native backend; tests give another. */
export interface ExhaustionBackend {
  /** The witness of `circuit` over `inputs` (noir_js' compressed form). A refusal names the failed check. */
  witness(circuit: ExhaustionCircuit, inputs: InputMap): Promise<Uint8Array>;
  /** A proof of `circuit` from `witness`, under the recursive target. */
  prove(circuit: ExhaustionCircuit, witness: Uint8Array): Promise<{ proof: Uint8Array; publicInputs: readonly bigint[] }>;
  /** Whether `proof` verifies under `circuit`'s key with exactly `publicInputs`. */
  verify(circuit: ExhaustionCircuit, proof: Uint8Array, publicInputs: readonly bigint[]): Promise<boolean>;
  close(): Promise<void>;
}

/** The pool's backend: noir_js witnesses and native proofs on an instance started from `parameters` at the first proof
 * and again after any failure, which retires the instance that failed (as the trail aggregator does). */
export function nativeExhaustionBackend(circuits: ExhaustionCircuits, parameters: () => Promise<ProvingParameters>,
    options: { readonly threads?: number } = {}): ExhaustionBackend {
  const noir = new Map(EXHAUSTION_CIRCUITS.map(name => [name, new Noir(circuits.circuits[name].program as unknown as CompiledCircuit)] as const));
  let current: { api: Barretenberg; backends: Map<ExhaustionCircuit, UltraHonkBackend> } | undefined;
  const instance = async () => {
    if (current !== undefined) return current;
    const api = await startExhaustionBackend(await parameters(), options.threads === undefined ? {} : { threads: options.threads });
    current = { api, backends: new Map(EXHAUSTION_CIRCUITS.map(name => [name, new UltraHonkBackend(circuits.circuits[name].program.bytecode, api)] as const)) };
    return current;
  };
  const retire = async (): Promise<void> => {
    const retired = current;
    current = undefined;
    if (retired !== undefined) await retired.api.destroy().catch(() => {});
  };
  const guarded = async <T>(task: (backends: Map<ExhaustionCircuit, UltraHonkBackend>) => Promise<T>): Promise<T> => {
    try { return await task((await instance()).backends); } catch (error) { await retire(); throw error; }
  };
  return {
    async witness(circuit, inputs) { return (await noir.get(circuit)!.execute(inputs)).witness; },
    prove: (circuit, witness) => guarded(async backends => {
      const made = await backends.get(circuit)!.generateProof(witness, PROOF_OPTIONS);
      return { proof: copyBytes(made.proof), publicInputs: made.publicInputs.map(BigInt) };
    }),
    verify: (circuit, proof, publicInputs) => guarded(backends =>
      backends.get(circuit)!.verifyProof({ proof: copyBytes(proof), publicInputs: publicInputs.map(fieldToHex) }, PROOF_OPTIONS)),
    close: retire,
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
        return { circuit: kept.circuit, proof, publicInputs: kept.publicInputs.map(x => BigInt(x)) };
      } catch { return undefined; }
    },
    put(label, { circuit, proof, publicInputs }) {
      const file = join(directory, `${label}.json`), temporary = `${file}.${process.pid}.tmp`;
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
  constructor(readonly code: "PERIOD" | "PUBLIC_INPUTS" | "UNVERIFIED", message: string) {
    super(message); this.name = "ExhaustionProverError";
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
    const blocks = period.blocks.map(block => {
      if (!(block.header instanceof Uint8Array)) throw new ExhaustionProverError("PERIOD", "a period's block carries no header bytes");
      return { header: block.header, transactions: block.section };
    });
    const run = leavesOf({ begin: period.begin, blocks, updates: period.updates }, this.sizes, this.nodeKeyHash);
    const end = stateEnd(run.end);
    if (!isPeriodEnd(run.end) || end.height !== inputs.endHeight || compareBytes(end.id, inputs.endId) !== 0 || run.end.u.root !== inputs.mapRoot) {
      throw new ExhaustionProverError("PERIOD", `the period's leaves do not end at the fold's end header ${inputs.endHeight} with its map root`);
    }
    return run;
  }

  /** The fold proof for `inputs` over `period`. */
  async fold(first: boolean, inputs: FoldInputs, period: ServedPeriod): Promise<Uint8Array> {
    const started = Date.now();
    if (first !== (period.previous === undefined)) throw new ExhaustionProverError("PERIOD", "a first fold continues no fold, and a next fold one");
    const publicInputs = foldPublicInputs(inputs);
    if (publicInputs === undefined || inputs.foldKeyHash !== this.foldKeyHash) throw new ExhaustionProverError("PERIOD", "fold inputs this set does not prove");
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
      const one = this.#prove(circuit, leaf.inputs as InputMap, expected, `period to ${inputs.endHeight}: leaf ${k + 1}/${run.leaves.length} (${leaf.kind})`,
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
    const foldInputs: InputMap = {
      start_hi: fieldToHex(sh), start_lo: fieldToHex(sl), start_height: fieldToHex(inputs.startHeight), end_hi: fieldToHex(eh), end_lo: fieldToHex(el),
      end_height: fieldToHex(inputs.endHeight), map_root: fieldToHex(inputs.mapRoot), fold_key_hash: fieldToHex(inputs.foldKeyHash),
      key: this.#keys[root.circuit].fields, proof: fields(root.proof), key_hash: this.#keys[root.circuit].hash,
      ...foldStateInputs(run.start, "0"), ...foldStateInputs(run.end, "1"),
    } as InputMap;
    if (period.previous !== undefined) {
      const previous = this.#keys[period.previous.first ? "fold-first" : "fold-next"];
      Object.assign(foldInputs, { previous_key: previous.fields, previous_proof: fields(period.previous.proof), previous_key_hash: previous.hash });
    }
    const circuit = first ? "fold-first" : "fold-next";
    const fold = await this.#prove(circuit, foldInputs, publicInputs, `period to ${inputs.endHeight}: ${circuit}`, Promise.resolve(), tally);
    if (await this.#options.backend.verify(circuit, fold.proof, publicInputs) !== true) {
      throw new ExhaustionProverError("UNVERIFIED", `the ${circuit} proof to ${inputs.endHeight} does not verify`);
    }
    this.#last = Object.freeze({ leaves: Object.freeze(counts), nodes, made, kept, seconds: (Date.now() - started) / 1000 });
    this.#options.log?.(`period to ${inputs.endHeight}: ${run.leaves.length} leaves, ${nodes} nodes, ${made} proved, ${kept} kept, ${this.#last.seconds.toFixed(0)} s`);
    return copyBytes(fold.proof);
  }

  /** `circuit` over `inputs`, kept or proved after `after` settles; the proof must carry `expected`. */
  async #prove(circuit: ExhaustionCircuit, inputs: InputMap, expected: readonly bigint[], label: string, after: Promise<unknown>,
      tally: (fresh: boolean) => void): Promise<ExhaustionProof> {
    const { backend, proofs, log } = this.#options;
    const name = bytesToHex(sha256(new TextEncoder().encode(`${circuit}\n${JSON.stringify(inputs)}`)));
    const held = proofs?.get(name);
    if (held !== undefined && held.circuit === circuit && same(held.publicInputs, expected)) { tally(false); return held; }
    const t0 = Date.now();
    const witness = await backend.witness(circuit, inputs);
    const t1 = Date.now();
    await after;
    const t2 = Date.now();
    const made = await backend.prove(circuit, witness);
    if (!same(made.publicInputs, expected)) throw new ExhaustionProverError("PUBLIC_INPUTS", `the ${circuit} proof does not carry its place's public inputs`);
    if (made.proof.length !== EXHAUSTION_PROOF_BYTES) throw new ExhaustionProverError("PUBLIC_INPUTS", `a ${circuit} proof of ${made.proof.length} bytes`);
    const proof: ExhaustionProof = Object.freeze({ circuit, proof: copyBytes(made.proof), publicInputs: Object.freeze([...made.publicInputs]) });
    proofs?.put(name, proof);
    tally(true);
    log?.(`${label}: witness ${((t1 - t0) / 1000).toFixed(1)} s, proof ${((Date.now() - t2) / 1000).toFixed(1)} s`);
    return proof;
  }
}

/** The leaves' kinds in order, for a log or a report. */
export const leafKinds = (leaves: readonly ExhaustionLeaf[]): string => leaves.map(l => l.kind).join("");
