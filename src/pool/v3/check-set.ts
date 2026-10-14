// The trail check set (succinct-read §§2, 3.2, 6): five trail leaves, one per proved kind, each verifying one
// statement proof under pool-v3 §11.4's key for its kind, a constant in the circuit, and the trail node over two
// children admitted by key hash. Their sources are generated from the keys they hold and compiled by
// scripts/pool/v3/check-set.mjs; the package ships each circuit's key and key hash (`check-set.json`, what a reader
// pins) apart from its bytecode (`check-set-programs.json`, what a prover runs), so a reader carries a few kilobytes,
// not the provers' programs.
//
// No set is adopted (§6 names twelve circuits, the exhaustion's start header and the agreement evidence), so this set
// is a test set, labelled as such (§1): a succinct read under it is exercised against real check proofs and attests
// nothing a reader may rely on until an adoption names its identities.
//
// A reader verifies a cover only under the pinned key the rule names, with public inputs it derived itself: the node's
// pinned key hash and the digest it computed (§2 rule 2). The verification reads `[1]_1` and `[x]_2` and nothing else,
// as any verification does (`keyedVerifier`), so a reader needs no more parameters than pool-v3's.
import { readFileSync } from "node:fs";
import type { Barretenberg } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyUnshared, EncodingError } from "../../bytes.js";
import { hexToField, isField } from "../field.js";
import { CHECK_SET_PARAMETERS } from "../parameters.js";
import { keyedVerifier, type VerifierOptions } from "../proof-verifier.js";
import { POOL_V3_MANIFEST, PROOF_BYTES } from "./configuration.js";
import { COVER_PROOF_BYTES, setFrame, SUCCINCT_SPECIFICATION, type CheckSet } from "./succinct.js";

/** The set's circuits in the order the set identity frames them: the five leaves by kind, then the node. */
export const TRAIL_CIRCUITS = Object.freeze(["leaf-issue", "leaf-spend", "leaf-burn", "leaf-demand", "leaf-settle", "node"] as const);
export type TrailCircuit = typeof TRAIL_CIRCUITS[number];
/** Each leaf's kind (§3.2). */
export const LEAF_KINDS: Readonly<Record<Exclude<TrailCircuit, "node">, number>> =
  Object.freeze({ "leaf-issue": 1, "leaf-spend": 2, "leaf-burn": 3, "leaf-demand": 4, "leaf-settle": 6 });

/**
 * The test set's identities, held here and never read from a supplier: per circuit, SHA-256 of its decompressed
 * bytecode and of its key, and its key hash as the backend derives it, under pool-v3's compiler, backend and target
 * and `CHECK_SET_PARAMETERS`. `scripts/pool/v3/check-set.mjs` regenerates the sources and the shipped files and prints
 * these; the check-set check derives every key again and asserts them.
 */
export const CHECK_SET_MANIFEST = Object.freeze({
  specification: SUCCINCT_SPECIFICATION,
  toolchain: POOL_V3_MANIFEST.toolchain,
  verifierTarget: POOL_V3_MANIFEST.verifierTarget,
  parameters: CHECK_SET_PARAMETERS,
  circuits: Object.freeze({
    "leaf-issue": Object.freeze({
      bytecode: "52575d108afd5b16707c203607110c40ed359bb98007e68441918a0a8c776eed",
      vk: "b544f0672ddb223c3a4b6ca68f16de1baff64f9fd8a7f3e2136968c98df6ea51",
      keyHash: "0x1ed136d79ff6482f5110ad8d412a4bccf4f78ef3bb26baa8742021bf05dae1f9" }),
    "leaf-spend": Object.freeze({
      bytecode: "fc140ef8cba2dc25947ef2c5d9404b5e6fcc5295bcc91395f269f6e592134ca5",
      vk: "d09081ce893e463d017c3bcffb7e7288917f6b07c8821a25dc5c292dc1c01fd5",
      keyHash: "0x17ec3c97d60e19d6f767edbb8dd32cd1cc1e9d0efbb49c85fb0e7618be4e07ad" }),
    "leaf-burn": Object.freeze({
      bytecode: "6a7f0476812e25d065b1cb9820267ee8dae81d2d49b0df9d909653f69b05cd80",
      vk: "eb34d7e31535326e40c9e95354a30b40076cf94c2db5cb844cddd2f9940f2cf7",
      keyHash: "0x15e5e6198192f2a6764a5fd5d92d49b3a6ebb390943ca36c13e01177a63adc28" }),
    "leaf-demand": Object.freeze({
      bytecode: "d561a10d65ffd2bcb96ec9354a545a3c3953d040f316242545015c5177a91a5c",
      vk: "6c7a019c8f8f3d47bef221979c73fc7d5328af2c77c503770222ee76af999547",
      keyHash: "0x2eb8fb9f63aae39ed809c9141c1863e9f0c486b1ac9b2a99119ff3863301bd5e" }),
    "leaf-settle": Object.freeze({
      bytecode: "ee593cfc033d3fe2bd853f41d7ce8c16027f38f38d4152e5ddd40e7bd856862e",
      vk: "c92db81e26d2e2337e67b7c92029a85f615b8f1b12626bdf9a812ba80c746dd6",
      keyHash: "0x18586fd043b8bcef2680760e07a783c8454e6d4546e5d58d8fd592f7015d4c01" }),
    "node": Object.freeze({
      bytecode: "3f0bb706ecd6c72dbe9a038333ed24055274f1bb4a8d41b09db016a5113bf2db",
      vk: "9e9a1a3184d75789fe5e937b80fe8b65c538145defb24705552d1f8f4d727477",
      keyHash: "0x2bdf9a3880b1d558bb229fabd02902bc646a7d755a2fa4594d58226e4f9d3282" }),
  }) as Readonly<Record<TrailCircuit, { readonly bytecode: string; readonly vk: string; readonly keyHash: string }>>,
});

/** The shipped set is missing, malformed or not the manifest's: an install fault, never a verdict. */
export class CheckSetError extends Error {
  constructor(readonly code: "MISSING" | "IDENTITY", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "CheckSetError";
  }
}

const encoder = new TextEncoder();
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16));

/**
 * The test set's identity (§6's frame, labelled `test`): SHA-256 over the context, the label, and per circuit its
 * name, bytecode and key identities and key hash, then the compiler, backend, target and parameters. It names a
 * succinct read's kept state (§2 rule 8); no adoption names it.
 */
export function checkSetIdentity(): Uint8Array {
  const m = CHECK_SET_MANIFEST;
  return sha256(setFrame([encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), encoder.encode("trail"),
    ...TRAIL_CIRCUITS.flatMap(name => [encoder.encode(name), hexBytes(m.circuits[name].bytecode), hexBytes(m.circuits[name].vk),
      hexBytes(m.circuits[name].keyHash.slice(2))]),
    encoder.encode(m.toolchain["@noir-lang/noir_wasm"]), encoder.encode(m.toolchain["@aztec/bb.js"]), encoder.encode(m.verifierTarget),
    encoder.encode(String(m.parameters.points)), hexBytes(m.parameters.g1), hexBytes(POOL_V3_MANIFEST.parameters.g2)]));
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
    // The identity hashes the decompressed bytes, as the backend reads them.
    const { gunzipSync } = process.getBuiltinModule("node:zlib");
    if (bytesToHex(sha256(gunzipSync(canonical(bytecode, `${name} bytecode`)))) !== CHECK_SET_MANIFEST.circuits[name].bytecode) refuse();
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
 * The test set over the pinned keys, on verifier instances of its own built from `api` (a backend `startBackend` or
 * `startCheckSetBackend` started): a cover verifies under the leaf key of `kind`, or the node key where `kind` is
 * undefined, with public inputs exactly (the node's pinned key hash, `digest`) (§2 rule 2, §3.2). False for a kind
 * without a leaf, a digest that is not a field element, or bytes of any other length.
 */
export function openTrailCheckSet(api: Barretenberg, options: VerifierOptions = {}): TrailCheckSet {
  const keys = trailKeys(), nodeKeyHash = keys.node.keyHash;
  const verifier = keyedVerifier(api, [
    ...TRAIL_CIRCUITS.map(name => ({ kind: name === "node" ? NODE : LEAF_KINDS[name], vk: keys[name].vk, publicInputs: 2 })),
  ], PROOF_BYTES, options);
  const identity = checkSetIdentity();
  return Object.freeze({
    identity, test: true, nodeKeyHash,
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
