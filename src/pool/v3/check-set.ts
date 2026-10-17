// The trail check set (succinct-read §§2, 3.2, 6): five trail leaves, one per proved kind, each verifying one
// statement proof under pool-v3 §11.4's key for its kind, a constant in the circuit, and the trail node over two
// children admitted by key hash. Their sources are generated from the keys they hold and compiled by
// scripts/pool/v3/check-set.mjs; the package ships each circuit's key and key hash (`check-set.json`, what a reader
// pins) apart from its bytecode (`check-set-programs.json`, what a prover runs), so a reader carries a few kilobytes,
// not the provers' programs.
//
// No set is adopted (§6 names twelve circuits, the exhaustion's start header and the agreement evidence), so these six
// are half of a test set (`../../succinct-set.ts`, which frames its identity), labelled as such (§1): a succinct read
// under it is exercised against real check proofs and attests nothing a reader may rely on until an adoption names its
// identities.
//
// A reader verifies a cover only under the pinned key the rule names, with public inputs it derived itself: the node's
// pinned key hash and the digest it computed (§2 rule 2). The verification reads `[1]_1` and `[x]_2` and nothing else,
// as any verification does (`keyedVerifier`), so a reader needs no more parameters than pool-v3's.
import { readFileSync } from "node:fs";
import type { Barretenberg } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyBytes, copyUnshared, EncodingError } from "../../bytes.js";
import { hexToField, isField } from "../field.js";
import { CHECK_SET_PARAMETERS } from "../parameters.js";
import { keyedVerifier, type VerifierOptions } from "../proof-verifier.js";
import { POOL_V3_MANIFEST, PROOF_BYTES } from "./configuration.js";
import { COVER_PROOF_BYTES, SUCCINCT_SPECIFICATION, type CheckSet } from "./succinct.js";

/** The circuits in the order the set identity frames them: the five leaves by kind, then the node. */
export const TRAIL_CIRCUITS = Object.freeze(["leaf-issue", "leaf-spend", "leaf-burn", "leaf-demand", "leaf-settle", "node"] as const);
export type TrailCircuit = typeof TRAIL_CIRCUITS[number];
/** Each leaf's kind (§3.2). */
export const LEAF_KINDS: Readonly<Record<Exclude<TrailCircuit, "node">, number>> =
  Object.freeze({ "leaf-issue": 1, "leaf-spend": 2, "leaf-burn": 3, "leaf-demand": 4, "leaf-settle": 6 });

/**
 * The six circuits' identities, held here and never read from a supplier (§6): per circuit, SHA-256 of its `main.nr`
 * (`scripts/pool/v3/trail-circuits/`), of its bytecode as the compiler emits it (pool-v2 §2) and of its key, and its key
 * hash as the backend derives it, under pool-v3's compiler, backend and target and `CHECK_SET_PARAMETERS`; `modules`
 * are the shared sources each compiles with. `scripts/pool/v3/check-set.mjs` regenerates the sources and the shipped
 * files and prints these; the check-set check derives every key again and asserts them.
 */
export const CHECK_SET_MANIFEST = Object.freeze({
  specification: SUCCINCT_SPECIFICATION,
  toolchain: POOL_V3_MANIFEST.toolchain,
  verifierTarget: POOL_V3_MANIFEST.verifierTarget,
  parameters: CHECK_SET_PARAMETERS,
  // The trail module and the vendored sponge, pool-v3's helper.
  modules: Object.freeze({
    "poseidon2.nr": "44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8",
    "trail.nr": "f24205608c72f9d36a603d52114aac35ba7692a0d5282967f8010bcda2dc6d00",
  }),
  circuits: Object.freeze({
    "leaf-issue": Object.freeze({
      source: "0ff6a6eaa1f627ca97fd6ac0d75a6287e0c1fca169d0d400dd9119f9c38be6e7",
      bytecode: "5b5661209bc9236984c6c1269365ec1777e74935d73afac3bf48589bd72c6cf5",
      vk: "b544f0672ddb223c3a4b6ca68f16de1baff64f9fd8a7f3e2136968c98df6ea51",
      keyHash: "0x1ed136d79ff6482f5110ad8d412a4bccf4f78ef3bb26baa8742021bf05dae1f9" }),
    "leaf-spend": Object.freeze({
      source: "1989c6fd71558bb1bb89a11c5d3b45aa92c393a0f58c1365927f97635f35ac54",
      bytecode: "bd77672f3517c9dc61d36fae35b666ef6685b9fd08036128e665137bdb4d48de",
      vk: "d09081ce893e463d017c3bcffb7e7288917f6b07c8821a25dc5c292dc1c01fd5",
      keyHash: "0x17ec3c97d60e19d6f767edbb8dd32cd1cc1e9d0efbb49c85fb0e7618be4e07ad" }),
    "leaf-burn": Object.freeze({
      source: "ebb12a572d4d6811ff9103b72888396c3f7ccbe3a301a1a0308a5c840320595c",
      bytecode: "1c5f345c1fb5f29ccfef208b33b329162a77488f9367c105ea464ff58858fe59",
      vk: "eb34d7e31535326e40c9e95354a30b40076cf94c2db5cb844cddd2f9940f2cf7",
      keyHash: "0x15e5e6198192f2a6764a5fd5d92d49b3a6ebb390943ca36c13e01177a63adc28" }),
    "leaf-demand": Object.freeze({
      source: "1bfd637a5cc76d0e1fd4780c7e048bc3a658b2a550fbd173aea2051c90b2eee1",
      bytecode: "29dbac097db88428346ae84a8fa6f6d830eeb7d53c81636cb96033e59f7c85f1",
      vk: "6c7a019c8f8f3d47bef221979c73fc7d5328af2c77c503770222ee76af999547",
      keyHash: "0x2eb8fb9f63aae39ed809c9141c1863e9f0c486b1ac9b2a99119ff3863301bd5e" }),
    "leaf-settle": Object.freeze({
      source: "2e8d62d6b7e67cdad7aadc0ac1236b540248c92137e43166e13bab6088ce7ca0",
      bytecode: "dccc5aa8d9feed0f76687b4535ea78b8b9910ce90657f60b241a98d9ca7d1d6c",
      vk: "c92db81e26d2e2337e67b7c92029a85f615b8f1b12626bdf9a812ba80c746dd6",
      keyHash: "0x18586fd043b8bcef2680760e07a783c8454e6d4546e5d58d8fd592f7015d4c01" }),
    "node": Object.freeze({
      source: "0b99cd07733fe6b1277646aab9e58ba699fee73026261c09e22adcc36a5c3aa7",
      bytecode: "a6eb5dac027b22ec46beb4cb2e794b7e4bd21fab26ab9120b3c6a15d2411ba54",
      vk: "9e9a1a3184d75789fe5e937b80fe8b65c538145defb24705552d1f8f4d727477",
      keyHash: "0x2bdf9a3880b1d558bb229fabd02902bc646a7d755a2fa4594d58226e4f9d3282" }),
  }) as Readonly<Record<TrailCircuit, { readonly source: string; readonly bytecode: string; readonly vk: string; readonly keyHash: string }>>,
});

/** The shipped set is missing, malformed or not the manifest's: an install fault, never a verdict. */
export class CheckSetError extends Error {
  constructor(readonly code: "MISSING" | "IDENTITY", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "CheckSetError";
  }
}

/** One circuit's key as a reader pins it. */
export interface TrailKey {
  readonly vk: Uint8Array;
  readonly keyHash: bigint;
}

const readShipped = (name: string): { readonly [circuit: string]: unknown } => {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")); } catch (cause) {
    throw new CheckSetError("MISSING", `the package's ${name} cannot be read`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !== [...TRAIL_CIRCUITS].sort().join()) {
    throw new CheckSetError("IDENTITY", `the shipped ${name} is not the set's`);
  }
  return parsed as { readonly [circuit: string]: unknown };
};
const canonical = (text: unknown, what: string): Uint8Array => {
  if (typeof text !== "string") throw new CheckSetError("IDENTITY", `the shipped ${what} is not the set's`);
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new CheckSetError("IDENTITY", `the shipped ${what} is not the set's`);
  return new Uint8Array(bytes);
};

/** The six pinned keys, read from the package afresh and each checked against the manifest's identities. */
export function trailKeys(): Readonly<Record<TrailCircuit, TrailKey>> {
  const shipped = readShipped("check-set.json"), keys: { [name: string]: TrailKey } = {};
  for (const name of TRAIL_CIRCUITS) {
    const entry = shipped[name] as { readonly [field: string]: unknown } | null;
    const expected = CHECK_SET_MANIFEST.circuits[name];
    const refuse = (): never => { throw new CheckSetError("IDENTITY", `the shipped ${name} key is not the set's`); };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return refuse();
    const vk = canonical(entry.vk, `${name} key`);
    if (bytesToHex(sha256(vk)) !== expected.vk || entry.keyHash !== expected.keyHash) refuse();
    if (name !== "node" && entry.kind !== LEAF_KINDS[name]) refuse();
    keys[name] = Object.freeze({ vk, keyHash: hexToField(expected.keyHash) });
  }
  return Object.freeze(keys as Record<TrailCircuit, TrailKey>);
}

/** One circuit's program as a prover runs it. */
export interface TrailProgram {
  readonly noir_version: string;
  readonly abi: object;
  readonly bytecode: string;
}

/** The six programs, read afresh and each checked against the manifest's bytecode identity and compiler. */
export function trailPrograms(): Readonly<Record<TrailCircuit, TrailProgram>> {
  const shipped = readShipped("check-set-programs.json"), programs: { [name: string]: TrailProgram } = {};
  const compiler = CHECK_SET_MANIFEST.toolchain["@noir-lang/noir_wasm"];
  for (const name of TRAIL_CIRCUITS) {
    const entry = shipped[name] as { readonly [field: string]: unknown } | null;
    const refuse = (): never => { throw new CheckSetError("IDENTITY", `the shipped ${name} program is not the set's`); };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "abi,bytecode,noir_version") return refuse();
    const { noir_version, abi, bytecode } = entry;
    if (typeof noir_version !== "string" || noir_version.split("+")[0] !== compiler || abi === null || typeof abi !== "object") refuse();
    if (bytesToHex(sha256(canonical(bytecode, `${name} bytecode`))) !== CHECK_SET_MANIFEST.circuits[name].bytecode) refuse();
    programs[name] = Object.freeze({ noir_version: noir_version as string, abi: abi as object, bytecode: bytecode as string });
  }
  return Object.freeze(programs as Record<TrailCircuit, TrailProgram>);
}

/** The node key's slot in the keyed verifier, beside the leaves' kinds 1–6. */
const NODE = 0;

/** A check set that verifies real check proofs, with `close` for its verifier's instances. */
export interface TrailCheckSet extends CheckSet {
  /** The trail node's pinned key hash, every cover's first public input (§3.2). */
  readonly nodeKeyHash: bigint;
  close(): Promise<void>;
}

/**
 * The test set `identity` names (`testSetIdentity`) over the pinned keys, on verifier instances of its own built from
 * `api` (a backend `startBackend` or `startCheckSetBackend` started): a cover verifies under the leaf key of `kind`, or
 * the node key where `kind` is undefined, with public inputs exactly (the node's pinned key hash, `digest`) (§2 rule 2,
 * §3.2). False for a kind without a leaf, a digest that is not a field element, or bytes of any other length.
 */
export function openTrailCheckSet(api: Barretenberg, identity: Uint8Array, options: VerifierOptions = {}): TrailCheckSet {
  if (!(identity instanceof Uint8Array) || identity.length !== 32) throw new EncodingError("a set identity is 32 bytes");
  const own = copyBytes(identity);
  const keys = trailKeys(), nodeKeyHash = keys.node.keyHash;
  const verifier = keyedVerifier(api, [
    ...TRAIL_CIRCUITS.map(name => ({ kind: name === "node" ? NODE : LEAF_KINDS[name], vk: keys[name].vk, publicInputs: 2 })),
  ], PROOF_BYTES, options);
  return Object.freeze({
    get identity() { return copyBytes(own); }, test: true, nodeKeyHash,
    async verify(kind: number | undefined, digest: bigint, proof: Uint8Array): Promise<boolean> {
      const slot = kind === undefined ? NODE : kind;
      if ((kind !== undefined && !Object.values(LEAF_KINDS).includes(kind)) || !isField(digest)) return false;
      let own: Uint8Array;
      try { own = copyUnshared(proof); } catch (error) {
        if (error instanceof EncodingError) return false;
        throw error;
      }
      if (own.length !== COVER_PROOF_BYTES) return false;
      return verifier.verify(slot, [nodeKeyHash, digest], own);
    },
    close: () => verifier.close(),
  });
}
