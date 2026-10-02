// The six compiled relations this package ships (pool-v3 §11.4).
// `programs.json` beside this module holds each relation's compiler version,
// ABI and bytecode, compiled from the sources the manifest names
// (`scripts/pool/v3/programs.mjs` checks that the sources compile to it
// exactly, ABI included, which no identity covers). The loader reads it
// afresh and refuses unless every bytecode identity is the manifest's; the
// verifier (`verifier.ts`) then derives each key and refuses unless every key
// identity is too (§11.1). No caller supplies artifacts, so a party proves and
// verifies only under the adopted configuration.
//
// Nothing here needs a proving backend: a party can check its install without
// loading either backend package.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CircuitTable } from "../proof-verifier.js";
import { POOL_V3_MANIFEST, RELATION_KINDS, RELATIONS, type Relation } from "./configuration.js";

/** pool-v3's six relations: kind, artifact and public-input count (§3), proofs to §5's bound. */
export const POOL_V3_CIRCUITS: CircuitTable = Object.freeze({
  circuits: Object.freeze(([["issue", 11], ["spend", 15], ["burn", 15], ["demand", 16], ["settle", 17], ["request", 7]] as const)
    .map(([name, publicInputs]) => Object.freeze({ kind: RELATION_KINDS[name], name, publicInputs }))),
  maxProofBytes: 131072,
});

/** One shipped relation: the compiler's version, the ABI witness generation encodes inputs by, and base64 of the
 * compressed bytecode, whose decoded bytes the manifest's bytecode identity hashes. */
export interface ShippedProgram {
  readonly noir_version: string;
  readonly abi: object;
  readonly bytecode: string;
}

/** The package's compiled relations are missing, malformed, or not the adopted configuration's: an install fault,
 * never an evidence verdict. */
export class ProgramError extends Error {
  constructor(readonly code: "MISSING" | "IDENTITY", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ProgramError";
  }
}

const SHIPPED = new URL("./programs.json", import.meta.url);
const FIELDS = ["abi", "bytecode", "noir_version"].join();
const COMPILER = POOL_V3_MANIFEST.toolchain["@noir-lang/noir_wasm"];

/**
 * The six shipped relations, read from the package afresh and each checked against the manifest: exactly the
 * configuration's relations, each with exactly its three fields, compiled by the manifest's compiler, with
 * canonical base64 bytecode whose identity is the manifest's. Every call returns objects of its own.
 */
export function adoptedPrograms(): Readonly<{ [name in Relation]: ShippedProgram }> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(SHIPPED, "utf8")); } catch (cause) {
    throw new ProgramError("MISSING", "the package's compiled relations cannot be read", { cause });
  }
  const refuse = (what: string): never => { throw new ProgramError("IDENTITY", `the shipped ${what} is not the configuration's`); };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join() !== [...RELATIONS].sort().join()) refuse("relation set");
  const programs: { [name: string]: ShippedProgram } = {};
  for (const name of RELATIONS) {
    const entry: unknown = (parsed as { [name: string]: unknown })[name];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== FIELDS) refuse(`${name} artifact`);
    const { noir_version, abi, bytecode } = entry as { readonly [field: string]: unknown };
    if (typeof noir_version !== "string" || noir_version.split("+")[0] !== COMPILER) refuse(`${name} compiler`);
    if (abi === null || typeof abi !== "object" || Array.isArray(abi)) refuse(`${name} ABI`);
    if (typeof bytecode !== "string") return refuse(`${name} bytecode`);
    const decoded = Buffer.from(bytecode, "base64");
    if (decoded.toString("base64") !== bytecode || bytesToHex(sha256(decoded)) !== POOL_V3_MANIFEST.circuits[name].bytecode) refuse(`${name} bytecode`);
    programs[name] = Object.freeze({ noir_version: noir_version as string, abi: abi as object, bytecode });
  }
  return Object.freeze(programs as { [name in Relation]: ShippedProgram });
}
