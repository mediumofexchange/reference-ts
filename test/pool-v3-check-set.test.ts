import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Barretenberg } from "@aztec/bb.js";
import { Noir, type CompiledCircuit } from "@noir-lang/noir_js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { FIELD_MODULUS, fieldToHex } from "../src/pool/field.js";
import { openTrailProver } from "../src/pool/v3/aggregator.js";
import { adoptedDomain } from "../src/pool/v3/configuration.js";
import {
  CHECK_SET_MANIFEST, checkSetIdentity, LEAF_KINDS, TRAIL_CIRCUITS, trailKeys, trailPrograms, type TrailCircuit,
} from "../src/pool/v3/check-set.js";
import type { Record } from "../src/pool/v3/records.js";
import { nodeDigest, statementLeafDigest } from "../src/pool/v3/succinct.js";

// The trail check set's circuits against the host (succinct-read §3.2), by witness execution: a leaf's output is the
// host's leafDigest of the record it verifies a proof of, and the node's is the host's nodeDigest. The backend's
// recursive verification is not executed here (witness generation defers it to proving); the check-set check proves
// and verifies every circuit, with hostile covers (scripts/pool/v3/check-set-check.mjs).
interface Genuine { readonly kind: number; readonly publicInputs: readonly string[]; readonly proof: string }
const genuine = (JSON.parse(readFileSync(new URL("./fixtures/pool-v3-genuine-proofs.json", import.meta.url), "utf8")) as
  { proofs: { [name: string]: Genuine } }).proofs;
const recordOf = (g: Genuine): Record => ({ domain: adoptedDomain(), kind: g.kind as Record["kind"], publicInputs: g.publicInputs.map(BigInt),
  proof: new Uint8Array(Buffer.from(g.proof, "base64")), authorization: new Uint8Array(), capsules: [] });
const fields = (bytes: Uint8Array): string[] => Array.from({ length: bytes.length / 32 }, (_, i) => `0x${Buffer.from(bytes.subarray(32 * i, 32 * i + 32)).toString("hex")}`);
const programs = trailPrograms(), keys = trailKeys();
const noir = (name: TrailCircuit) => new Noir(programs[name] as unknown as CompiledCircuit);
const NODE_KEY_HASH = fieldToHex(keys.node.keyHash);

describe("the trail check set (succinct-read §3.2)", () => {
  it("ships six circuits whose keys and programs are the manifest's, under a test-labelled identity", () => {
    expect(Object.keys(keys).sort()).toEqual([...TRAIL_CIRCUITS].sort());
    for (const name of TRAIL_CIRCUITS) {
      expect(Buffer.from(sha256(keys[name].vk)).toString("hex")).toBe(CHECK_SET_MANIFEST.circuits[name].vk);
      expect(keys[name].vk.length).toBe(115 * 32);
    }
    expect(new Set(TRAIL_CIRCUITS.map(name => keys[name].keyHash)).size).toBe(6);
    expect(checkSetIdentity()).toHaveLength(32);
  });

  it.each(Object.entries(LEAF_KINDS))("%s outputs the host's leaf digest over a genuine proof", async (name, kind) => {
    const g = Object.values(genuine).find(p => p.kind === kind)!;
    const record = recordOf(g);
    const { returnValue } = await noir(name as TrailCircuit).execute({ proof: fields(record.proof), inputs: [...g.publicInputs], node_key_hash: NODE_KEY_HASH });
    expect(BigInt(returnValue as string)).toBe(statementLeafDigest(record.kind, record.publicInputs, sha256(record.proof)));
  }, 120_000);

  it("a leaf takes no proof word of p or more", async () => {
    const g = genuine.spend!, proof = fields(recordOf(g).proof);
    // p itself as a word: the ABI encoder refuses it before the circuit runs.
    proof[100] = `0x${FIELD_MODULUS.toString(16).padStart(64, "0")}`;
    await expect(noir("leaf-spend").execute({ proof, inputs: [...g.publicInputs], node_key_hash: NODE_KEY_HASH })).rejects
      .toThrow(/`proof\[100\]` is invalid:\nValue 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001 exceeds field modulus/);
  }, 120_000);

  it("the aggregator refuses an instance not started with the check set's points", async () => {
    await expect(openTrailProver({} as Barretenberg, { verify: async () => true, parallel: 1, close: async () => {} })).rejects
      .toMatchObject({ name: "ParameterError", code: "UNCHECKED", message: "the aggregator proves on an instance startCheckSetBackend started" });
  });

  it("trail.nr's word constraints take exactly an element's canonical big-endian words", () => {
    const words = (n: bigint) => Array.from({ length: 8 }, (_, j) => String((n >> BigInt(32 * (7 - j))) & 0xffffffffn));
    const p = FIELD_MODULUS, x = 0x1234_5678_9abc_def0_0fed_cba9_8765_4321n;
    const cases = [
      { x: "5", words: words(5n) }, { x: String(p - 1n), words: words(p - 1n) }, { x: String(x), words: words(x) },
      // The modulus's top word with lower words below the modulus's: still below p.
      { x: String(p - (1n << 32n)), words: words(p - (1n << 32n)) },
      // An alias above p (x + p, x + 2p), p itself as zero, and another value.
      { x: String(x), words: words(x + p) }, { x: String(x), words: words(x + 2n * p) }, { x: "0", words: words(p) }, { x: "5", words: words(6n) },
    ];
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./check-set-words.child.mjs", import.meta.url)), JSON.stringify(cases)],
      { encoding: "utf8", timeout: 120_000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.slice(child.stdout.indexOf("[")))).toEqual([
      "accepted", "accepted", "accepted", "accepted",
      "Cannot satisfy constraint", "Cannot satisfy constraint", "Cannot satisfy constraint", "Cannot satisfy constraint",
    ]);
  }, 150_000);

  it("the node outputs the host's node digest and admits children only by a leaf's or its own key hash", async () => {
    const dummy = Array<string>(458).fill("0x01"), key = fields(keys["leaf-issue"].vk);
    const left = 5n, right = 7n;
    const base = { keys: [key, key], proofs: [dummy, dummy], digests: [fieldToHex(left), fieldToHex(right)], node_key_hash: NODE_KEY_HASH };
    const admitted = [fieldToHex(keys["leaf-issue"].keyHash), NODE_KEY_HASH];
    const { returnValue } = await noir("node").execute({ ...base, key_hashes: admitted });
    expect(BigInt(returnValue as string)).toBe(nodeDigest(left, right));
    // Another hash than the five leaves' and the node's own input is refused at the admission assertion, the only
    // constraint key_hashes meets in witness generation (the recursive verification is deferred to proving).
    await expect(noir("node").execute({ ...base, key_hashes: [admitted[0]!, fieldToHex(keys.node.keyHash + 1n)] })).rejects.toThrow(/^Cannot satisfy constraint$/);
  }, 120_000);
});
