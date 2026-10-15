import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { foldPublicInputs, type Fold, type FoldInputs } from "../src/ergo-exhaustion.js";
import {
  EXHAUSTION_CIRCUITS, EXHAUSTION_PROOF_BYTES, ExhaustionPool, ExhaustionProverError, type ExhaustionBackend, type ExhaustionCircuit,
  type ExhaustionCircuits, type ExhaustionProof, type ProofStore,
} from "../src/ergo-exhaustion-pool.js";
import { ExhaustionServer, type ServedBlock } from "../src/ergo-exhaustion-server.js";
import { fieldToHex } from "../src/pool/field.js";
import { Chain, plainOutput, recordOutput, transaction } from "../src/ergo-synthetic.js";

// The prover pool (succinct-read §4.3) over a model of the circuits: each proof is a hash of its circuit and public
// inputs, and the model checks what the circuits' recursion would: a node's children join and verify under the keys
// they name, a fold's tree spans its states and a next fold continues its previous fold. Real proofs are
// scripts/venue/exhaustion-pool.mjs's.
const SIZES = { t: 2, m: 4, u: 1 };
const KEY_HASH: Record<ExhaustionCircuit, bigint> = { "leaf-t": 11n, "leaf-m": 12n, "leaf-u": 13n, node: 14n, "fold-first": 15n, "fold-next": 16n };
const array = (name: string, length: number) => ({ name, type: { kind: "array", length } });
const circuits: ExhaustionCircuits = {
  sizes: SIZES,
  circuits: Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => [name, {
    program: { noir_version: "model", bytecode: Buffer.from(name).toString("base64"),
      abi: { parameters: [array("tb", SIZES.t), array("mb", SIZES.m), array("uu", SIZES.u)] } },
    vk: new Uint8Array(115 * 32).fill(Number(KEY_HASH[name])), keyHash: KEY_HASH[name] }])) as unknown as ExhaustionCircuits["circuits"],
};
const circuitOfKey = new Map(EXHAUSTION_CIRCUITS.map(name => [fieldToHex(KEY_HASH[name]), name]));
const modelProof = (circuit: ExhaustionCircuit, publicInputs: readonly bigint[]): Uint8Array => {
  const seed = sha256(new TextEncoder().encode(`${circuit}:${publicInputs.join(",")}`)), proof = new Uint8Array(EXHAUSTION_PROOF_BYTES);
  for (let i = 0; i < proof.length; i += 32) proof.set(seed, i);
  return proof;
};
const hexOf = (fields: string[]): Uint8Array => Buffer.concat(fields.map(f => Buffer.from(f.slice(2).padStart(64, "0"), "hex")));
const big = (x: unknown): bigint => BigInt(x as string);

/** The model: witnesses carry their inputs; proofs check what the circuit's recursion checks. */
function modelBackend(options: { failProve?: (n: number, circuit: ExhaustionCircuit) => boolean; tamper?: ExhaustionCircuit } = {}) {
  const calls = { witness: 0, prove: 0 };
  /** Every proof the model made, by its bytes: what a recursive verifier would accept. */
  const made = new Map<string, { circuit: ExhaustionCircuit; publicInputs: readonly bigint[] }>();
  const madeAs = (proof: string[], key: string) => {
    const found = made.get(Buffer.from(hexOf(proof)).toString("hex"));
    expect(found?.circuit).toBe(circuitOfKey.get(key));
    return found!.publicInputs;
  };
  const backend: ExhaustionBackend = {
    async witness(circuit, inputs) { calls.witness++; return new TextEncoder().encode(JSON.stringify({ circuit, inputs })); },
    async prove(circuit, witness) {
      calls.prove++;
      if (options.failProve?.(calls.prove, circuit)) throw new Error("the prover's instance exited");
      const { inputs } = JSON.parse(new TextDecoder().decode(witness)) as { inputs: Record<string, unknown> };
      const verified = (proof: string[], key: string, publicInputs: readonly bigint[]) => {
        const name = circuitOfKey.get(key)!;
        expect(Buffer.from(hexOf(proof)).equals(Buffer.from(modelProof(name, publicInputs)))).toBe(true);
        return name;
      };
      let publicInputs: bigint[];
      if (circuit === "node") {
        const [kl, kr] = inputs.key_hashes as string[], [pl, pr] = inputs.proofs as string[][];
        const sin = big(inputs.sin), middle = big(inputs.middle), sout = big(inputs.sout), nk = big(inputs.node_key_hash);
        verified(pl!, kl!, [sin, middle, nk]);
        verified(pr!, kr!, [middle, sout, nk]);
        publicInputs = [sin, sout, nk];
      } else if (circuit.startsWith("fold")) {
        publicInputs = ["start_hi", "start_lo", "start_height", "end_hi", "end_lo", "end_height", "map_root", "fold_key_hash"].map(k => big(inputs[k]));
        // The tree's root carries the node key hash, and a next fold continues its previous fold from the same start.
        expect(madeAs(inputs.proof as string[], inputs.key_hash as string)[2]).toBe(KEY_HASH.node);
        if (circuit === "fold-next") {
          const previous = madeAs(inputs.previous_proof as string[], inputs.previous_key_hash as string);
          expect(previous.slice(0, 3)).toEqual(publicInputs.slice(0, 3));
          expect(previous[5]).toBe(big((inputs.m0 as { height: string }).height));
        }
      } else {
        publicInputs = [big(inputs.sin), big(inputs.sout), big(inputs.node_key_hash)];
      }
      if (options.tamper === circuit) publicInputs = [...publicInputs.slice(0, -1), publicInputs.at(-1)! + 1n];
      const proof = modelProof(circuit, publicInputs);
      made.set(Buffer.from(proof).toString("hex"), { circuit, publicInputs });
      return { proof, publicInputs };
    },
    async verify(circuit, proof, publicInputs) { return Buffer.from(proof).equals(Buffer.from(modelProof(circuit, publicInputs))); },
    async close() {},
  };
  return { backend, calls };
}
const memoryStore = (): ProofStore & { size: number } => {
  const kept = new Map<string, ExhaustionProof>();
  return { get: label => kept.get(label), put: (label, proof) => { kept.set(label, proof); }, get size() { return kept.size; } };
};

const s = sha256(Uint8Array.of(1)), u = sha256(Uint8Array.of(2));
function chain(count: number) {
  const c = new Chain();
  let tip = c.anchor;
  const blocks: ServedBlock[] = [];
  for (let i = 0; i < count; i++) {
    const txs = [transaction([plainOutput])];
    if (i % 2 === 0) txs.push(transaction([recordOutput(1, s, new Uint8Array(150).fill(i)), plainOutput, recordOutput(2, u, new Uint8Array(3))]));
    tip = c.mine(tip, txs, 0, i % 3 === 2 ? 1n : 2n);
    blocks.push({ id: tip.id, transactionsRoot: tip.bytes.subarray(65, 97), section: tip.section, header: tip.bytes });
  }
  return { start: { id: c.anchor.id, height: c.anchor.height }, blocks };
}
function served(pool: ExhaustionPool, start: { id: Uint8Array; height: bigint }) {
  return new ExhaustionServer({ start, foldKeyHash: pool.foldKeyHash, prove: (first, inputs, period) => pool.fold(first, inputs, period) });
}
/** The model fold proof for a server's fold, and the previous fold it names. */
const checked = (fold: Fold): boolean => Buffer.from(fold.proof).equals(Buffer.from(modelProof(fold.first ? "fold-first" : "fold-next", foldPublicInputs(fold.inputs)!)));

describe("the exhaustion prover pool (succinct-read §4.3)", () => {
  it("proves a server's periods leaf by leaf, joined by nodes and folded first and next", async () => {
    const { start, blocks } = chain(6);
    const { backend } = modelBackend(), lines: string[] = [];
    const pool = new ExhaustionPool({ circuits, backend, log: line => lines.push(line) });
    const server = served(pool, start);
    const first = await server.extend(blocks.slice(0, 3));
    expect(first.first).toBe(true);
    expect(checked(first)).toBe(true);
    expect(pool.last!.leaves.t + pool.last!.leaves.m + pool.last!.leaves.u).toBeGreaterThan(3);
    expect(pool.last!.leaves.u).toBeGreaterThan(0);
    expect(pool.last!.nodes).toBe(pool.last!.leaves.t + pool.last!.leaves.m + pool.last!.leaves.u - 1);
    const next = await server.extend(blocks.slice(3));
    expect(next.first).toBe(false);
    expect(checked(next)).toBe(true);
    expect(next.inputs.endHeight).toBe(start.height + 6n);
    expect(lines.some(line => /leaf 1\/\d+ \(t\): witness/.test(line))).toBe(true);
    expect(lines.at(-1)).toMatch(/^period to \d+: \d+ leaves, \d+ nodes, \d+ proved, 0 kept/);
  });

  it("resumes from kept proofs: proving the same periods again makes none", async () => {
    const { start, blocks } = chain(5);
    const store = memoryStore();
    const a = modelBackend(), first = served(new ExhaustionPool({ circuits, backend: a.backend, proofs: store }), start);
    await first.extend(blocks.slice(0, 2));
    const folded = await first.extend(blocks.slice(2));
    const proved = store.size;
    const b = modelBackend(), pool = new ExhaustionPool({ circuits, backend: b.backend, proofs: store }), again = served(pool, start);
    await again.extend(blocks.slice(0, 2));
    const refolded = await again.extend(blocks.slice(2));
    expect(b.calls.witness).toBe(0);
    expect(b.calls.prove).toBe(0);
    expect(pool.last!.made).toBe(0);
    expect(pool.last!.kept).toBeGreaterThan(0);
    expect(store.size).toBe(proved);
    expect(refolded).toEqual(folded);
  });

  it("keeps a period whose proof failed pending, answers no key past the fold, and proves it before the next", async () => {
    const { start, blocks } = chain(6);
    const store = memoryStore(), { backend, calls } = modelBackend({ failProve: n => n === 3 });
    const pool = new ExhaustionPool({ circuits, backend, proofs: store }), server = served(pool, start);
    await expect(server.extend(blocks.slice(0, 3))).rejects.toThrow("exited");
    expect(server.pending?.endHeight).toBe(start.height + 3n);
    expect(server.latest).toBeUndefined();
    expect(await server.key(start.height + 3n, 0n, 0n)).toBeUndefined();
    const before = calls.prove;
    const fold = await server.extend([]);
    expect(fold.inputs.endHeight).toBe(start.height + 3n);
    expect(checked(fold)).toBe(true);
    expect(pool.last!.kept).toBe(2);
    expect(calls.prove - before).toBe(pool.last!.made);
    expect(server.pending).toBeUndefined();
    const next = await server.extend(blocks.slice(3));
    expect(next.first).toBe(false);
    expect(checked(next)).toBe(true);
    expect(await server.key(next.inputs.endHeight, 0n, 0n)).toBeDefined();
  });

  it("refuses a period that does not end at the fold's inputs before any witness, and a proof carrying other inputs", async () => {
    const { start, blocks } = chain(3);
    const model = modelBackend(), pool = new ExhaustionPool({ circuits, backend: model.backend });
    let period: Parameters<ExhaustionPool["fold"]>[2] | undefined, inputs: FoldInputs | undefined;
    const server = new ExhaustionServer({ start, foldKeyHash: pool.foldKeyHash, prove: (_, i, p) => { inputs = i; period = p; return new Uint8Array(1); } });
    await server.extend(blocks);
    const refused = async (changed: Partial<FoldInputs>, p = period!) => {
      const error = await pool.fold(true, { ...inputs!, ...changed }, p).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ExhaustionProverError);
      return (error as ExhaustionProverError).code;
    };
    expect(await refused({ mapRoot: inputs!.mapRoot + 1n })).toBe("PERIOD");
    expect(await refused({ endHeight: inputs!.endHeight - 1n })).toBe("PERIOD");
    expect(await refused({ endId: blocks[1]!.id })).toBe("PERIOD");
    expect(await refused({ foldKeyHash: 7n })).toBe("PERIOD");
    expect(await refused({}, { ...period!, blocks: period!.blocks.map(({ header: _, ...b }) => b) })).toBe("PERIOD");
    await expect(pool.fold(false, inputs!, period!)).rejects.toThrow("a first fold continues no fold");
    expect(model.calls.witness).toBe(0);
    for (const tamper of ["leaf-t", "node", "fold-first"] as const) {
      const bad = new ExhaustionPool({ circuits, backend: modelBackend({ tamper }).backend });
      const error = await bad.fold(true, inputs!, period!).catch((e: unknown) => e);
      expect((error as ExhaustionProverError).code).toBe("PUBLIC_INPUTS");
    }
    expect(checked({ first: true, inputs: inputs!, proof: await pool.fold(true, inputs!, period!) })).toBe(true);
  });
});

