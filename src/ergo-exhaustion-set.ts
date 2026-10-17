// The venue exhaustion's circuit set (succinct-read §§4.3, 6; slice 43): the three exhaustion leaves, the node and the
// two folds, built from the sources at the leaves' production sizes under the pinned compiler and backend. The package
// ships each circuit's key and key hash (`exhaustion-set.json`, what a reader pins) and the circuits' sources
// (`exhaustion-circuits/`, which a prover compiles: `ergo-exhaustion-programs.ts`), not their programs, tens of
// megabytes a leaf; `scripts/venue/exhaustion-set.mjs` builds them again and checks the sources, the keys and the
// identities below.
//
// No set is adopted (§6 names twelve circuits, the start header and the agreement evidence), so these six are half of a
// test set (`succinct-set.ts`, which frames its identity), labelled as such (§1): a succinct read under it is exercised
// against real fold proofs and attests nothing a reader may rely on until an adoption names its identities. Its start
// is the caller's (a CLI venue's anchor): one circuit set serves every start, which only the set identity and a fold's
// public inputs name.
//
// Nothing here loads `@noir-lang`: a reader verifies folds under the pinned first-fold and next-fold keys on verifier
// instances of its own (`keyedVerifier`), which read `[1]_1` and `[x]_2` and nothing else.
import { readFileSync } from "node:fs";
import type { Barretenberg } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyBytes, EncodingError } from "./bytes.js";
import { FoldVerificationError, type ExhaustionSet } from "./ergo-exhaustion.js";
import type { LeafSizes } from "./ergo-exhaustion-prover.js";
import { fieldToHex, hexToField } from "./pool/field.js";
import { EXHAUSTION_PARAMETERS } from "./pool/parameters.js";
import { keyedVerifier, ProofVerificationThrew, type CompiledProgram, type KeyedVerifier, type VerifierOptions } from "./pool/proof-verifier.js";

/** The exhaustion circuits (§4.3): the three leaves, the node, the first and the next fold. */
export const EXHAUSTION_CIRCUITS = Object.freeze(["leaf-t", "leaf-m", "leaf-u", "node", "fold-first", "fold-next"] as const);
export type ExhaustionCircuit = typeof EXHAUSTION_CIRCUITS[number];
/** Every exhaustion proof's length: UltraHonk's under the recursive target. */
export const EXHAUSTION_PROOF_BYTES = 458 * 32;
/** A key's length under the recursive target. */
export const EXHAUSTION_KEY_BYTES = 115 * 32;

/** One circuit's identities as an adoption would name them (§6): SHA-256 of its program's bytecode (the base64-decoded
 * bytes, as the compiler writes them) and of its key, and its key hash. */
export interface CircuitIdentity { readonly bytecode: string; readonly vk: string; readonly keyHash: string }
/** One circuit's key as a reader pins it. */
export interface ExhaustionKey { readonly vk: Uint8Array; readonly keyHash: bigint }
/** One built circuit: its program, its key's bytes and the key hash the backend derives. */
export interface BuiltCircuit extends ExhaustionKey { readonly program: CompiledProgram }
/** A built set of the six circuits, with the leaves' sizes read from their programs. */
export interface ExhaustionCircuits { readonly sizes: LeafSizes; readonly circuits: Readonly<Record<ExhaustionCircuit, BuiltCircuit>> }

/**
 * The six circuits' identities, held here and never read from a supplier (§6): per circuit, SHA-256 of its `main.nr`
 * (`exhaustion-circuits/<name>.nr`) and its `CircuitIdentity`, under the compiler and backend named, at the leaves'
 * sizes, from `EXHAUSTION_PARAMETERS`; `modules` are the shared sources, `reads` those each circuit compiles with.
 * `scripts/venue/exhaustion-set.mjs` builds the circuits again and asserts every entry and both shipped files.
 */
export const EXHAUSTION_SET_MANIFEST = Object.freeze({
  specification: "succinct-read 282c925",
  compiler: "nargo 1.0.0-beta.26+40d6574f851d926f93e0c3a271bac3e6e82ac905",
  backend: "@aztec/bb.js 5.2.0",
  verifierTarget: "noir-recursive",
  sizes: Object.freeze({ t: 167, m: 380, u: 746 }),
  parameters: EXHAUSTION_PARAMETERS,
  // The exhaustion module, Blake2b and the vendored sponge, pool-v3's helper.
  modules: Object.freeze({
    "blake2b.nr": "e2d2e406d54625dd3793abe0cdc0fd471f070b6b0a04327b734e31b67d673bd6",
    "exhaustion.nr": "2cacd3dcc12f3f15e855f07eb5654a101a4c7e2122af1c28bad453ebe504888a",
    "poseidon2.nr": "44f3a3d1abe7d5fa2da5c0339e52018195d55f295c320e530d355f9cc62159d8",
  }),
  // The modules each circuit's `main.nr` declares, which its compiler reads and its crate holds beside it: §6's
  // sources besides `main.nr`. The node and the folds hash nothing with Blake2b.
  reads: Object.freeze({
    "leaf-t": Object.freeze(["blake2b.nr", "exhaustion.nr", "poseidon2.nr"]),
    "leaf-m": Object.freeze(["blake2b.nr", "exhaustion.nr", "poseidon2.nr"]),
    "leaf-u": Object.freeze(["blake2b.nr", "exhaustion.nr", "poseidon2.nr"]),
    "node": Object.freeze(["exhaustion.nr", "poseidon2.nr"]),
    "fold-first": Object.freeze(["exhaustion.nr", "poseidon2.nr"]),
    "fold-next": Object.freeze(["exhaustion.nr", "poseidon2.nr"]),
  }) as Readonly<Record<ExhaustionCircuit, readonly ("blake2b.nr" | "exhaustion.nr" | "poseidon2.nr")[]>>,
  circuits: Object.freeze({
    "leaf-t": Object.freeze({
      source: "080ffd2a7f66f17e891eb29fd4b585e5fd1443882bd34036ec0b96a019068838",
      bytecode: "82cd725db1094c67497372691c666dd08e5f007b2783343b9a2417c58e64e42c",
      vk: "a2c125ab2feca20af407697b6e1e6d99cba6a73ab65ec079a769be789e1ab4f2",
      keyHash: "0x1ab2476249309e13f2afc6bbbc35e73c601605b0472281d56d82f18241d476eb" }),
    "leaf-m": Object.freeze({
      source: "5ce613a765de530bec1e6608d34a9d98c03dbfa2d3a0d9cb46b31139c763b601",
      bytecode: "9fae587c658321b9d420e27a619781681f42ebb6bc5f84fb30effe9ea6ca81c7",
      vk: "8ccc7ff201b41531ae8e2f752d8af6cf056d4fbdb89995e27804976e74bb4468",
      keyHash: "0x08103c1cbb738a837b4e785ea379b9eaccb8f03dbf318ebe171694022af69ddc" }),
    "leaf-u": Object.freeze({
      source: "d791eccb0c32df940cb8054dab0217a75533ae4fe4c1a1b2373d6982c07f1357",
      bytecode: "6a7b8d6fe23a3e7dbf0b9b63ab21c87ef007bde9e652ad964789aae427263823",
      vk: "219a3639bf3f8ff8ee49183496e56204a13ddc0e2bcdb6831a2c639fc14a2391",
      keyHash: "0x0881a4e495405f03c9252c4ed9a06f273f41cac96fb95bb6697446ecc1adb703" }),
    "node": Object.freeze({
      source: "3c77eb2066ebcf45d7d50352bfb3612dcf977af837c17e5292303f5a9a6eceb4",
      bytecode: "1df15219c293298eea602ed29021859a3d13625112f27effe8312f6144ab01e8",
      vk: "2ff0d792d5f34e9b9291b2b9f48378b0923eb030337a2c6ad4adce1f5f7bd445",
      keyHash: "0x1dc2959b6e05b085ee869d71cd8fcf903e044a2f19dbb6a2d0da47a5be203081" }),
    "fold-first": Object.freeze({
      source: "8aa15e90053fdc073a848d383123e697f867beb28b90829839411df325680dca",
      bytecode: "539398acab4641d1ee228a3f5d8f8e62b01e98a49d89974b6bbed64cdb178ebf",
      vk: "54ae6b9bd08d753ecde56e32e7aa3975015146db42efb019e8dcb7e1e1c02ce0",
      keyHash: "0x128d1e3e96a79c134962c30cc773acc34f1c6923608a5b42ec734a3b0f9f8d12" }),
    "fold-next": Object.freeze({
      source: "b3d6b16a1044d3ff161c269b71fc3ab0ad28148452d507eb1cc634f13624b043",
      bytecode: "f054df2a0b832b27f42054464d179fc91e63ff8eeee11d9b69f2d08ceafb9367",
      vk: "268f7cd52a3b16938158bb42b5dcfbab3fd6f00637848e9d1835a475e43a9814",
      keyHash: "0x28042fd2c360b17a7254c3de948e5b45cd4d59c269a95c9500213750b598a7ee" }),
  }) as Readonly<Record<ExhaustionCircuit, CircuitIdentity & { readonly source: string }>>,
});

/** Each built circuit's identities (§6). */
export function circuitIdentities(circuits: ExhaustionCircuits): Readonly<Record<ExhaustionCircuit, CircuitIdentity>> {
  return Object.freeze(Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => {
    const c = circuits.circuits[name];
    return [name, Object.freeze({ bytecode: bytesToHex(sha256(base64(c.program.bytecode))), vk: bytesToHex(sha256(c.vk)), keyHash: fieldToHex(c.keyHash) })];
  })) as Record<ExhaustionCircuit, CircuitIdentity>);
}

const base64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** Where a set's verifier instances take `[1]_1` and `[x]_2` from: a started instance (the caller's to destroy after the
 * set is made), or a function starting one at the set's first verification, which the set destroys once read. */
export type ExhaustionVerifierSource = Barretenberg | (() => Promise<Barretenberg>);

/**
 * The test set `identity` names (`testSetIdentity`), whose fold keys these are, from `start` (§§1, 6): a fold verifies
 * under the first-fold or next-fold key on verifier instances of its own. `close` ends them.
 */
export function exhaustionSetOver(identity: Uint8Array, folds: { readonly first: ExhaustionKey; readonly next: ExhaustionKey },
    start: { readonly id: Uint8Array; readonly height: bigint }, source: ExhaustionVerifierSource,
    options: VerifierOptions = {}): ExhaustionSet & { close(): Promise<void> } {
  if (!(identity instanceof Uint8Array) || identity.length !== 32) throw new EncodingError("a set identity is 32 bytes");
  if (!(start?.id instanceof Uint8Array) || start.id.length !== 32 || typeof start.height !== "bigint" || start.height < 0n || start.height >= 1n << 32n) {
    throw new EncodingError("invalid exhaustion start");
  }
  const own = copyBytes(identity);
  const pinned = [{ kind: 1, vk: copyBytes(folds.first.vk), publicInputs: 8 }, { kind: 2, vk: copyBytes(folds.next.vk), publicInputs: 8 }];
  const over = (api: Barretenberg): KeyedVerifier => keyedVerifier(api, pinned, EXHAUSTION_PROOF_BYTES, options);
  let verifier: Promise<KeyedVerifier> | undefined, closed = false;
  if (typeof source !== "function") verifier = Promise.resolve(over(source));
  const opened = (): Promise<KeyedVerifier> => {
    if (closed) return Promise.reject(new Error("the exhaustion set is closed"));
    // Started once; a start that fails is tried again at the next verification.
    verifier ??= (async () => {
      const api = await (source as () => Promise<Barretenberg>)();
      try { return over(api); } finally { await api.destroy(); }
    })();
    const made = verifier;
    made.catch(() => { if (verifier === made) verifier = undefined; });
    return made;
  };
  return Object.freeze({
    get identity() { return copyBytes(own); }, test: true, start: Object.freeze({ id: copyBytes(start.id), height: start.height }),
    foldKeyHash: folds.next.keyHash,
    verifyFold: async (first: boolean, inputs: readonly bigint[], proof: Uint8Array) => {
      if (!(proof instanceof Uint8Array) || proof.length !== EXHAUSTION_PROOF_BYTES) return false;
      // A verifier or instance that does not start, or a closed set, throws as itself: the reader's own fault. Only the
      // backend's throw on the bytes themselves (`ProofVerificationThrew`; the instance is retired) is the supplier's.
      const verifier = await opened();
      try { return await verifier.verify(first ? 1 : 2, inputs, proof); } catch (cause) {
        if (cause instanceof ProofVerificationThrew) throw new FoldVerificationError(`the fold's verification threw: ${cause.message}`, { cause });
        throw cause;
      }
    },
    close: async () => {
      closed = true;
      const made = verifier;
      verifier = undefined;
      await made?.then(v => v.close(), () => {});
    },
  });
}

/** The shipped set is missing, malformed or not the manifest's: an install fault, never a verdict. */
export class ExhaustionSetError extends Error {
  constructor(readonly code: "MISSING" | "IDENTITY", message: string, options?: ErrorOptions) {
    super(message, options); this.name = "ExhaustionSetError";
  }
}

const readShipped = (name: string): { readonly [circuit: string]: unknown } => {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")); } catch (cause) {
    throw new ExhaustionSetError("MISSING", `the package's ${name} cannot be read`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !== [...EXHAUSTION_CIRCUITS].sort().join()) {
    throw new ExhaustionSetError("IDENTITY", `the shipped ${name} is not the set's`);
  }
  return parsed as { readonly [circuit: string]: unknown };
};
const canonical = (text: unknown, what: string): Uint8Array => {
  if (typeof text !== "string") throw new ExhaustionSetError("IDENTITY", `the shipped ${what} is not the set's`);
  const bytes = base64(text);
  if (Buffer.from(bytes).toString("base64") !== text) throw new ExhaustionSetError("IDENTITY", `the shipped ${what} is not the set's`);
  return bytes;
};

/** The six pinned keys, read from the package afresh and each checked against the manifest's identities. */
export function exhaustionKeys(): Readonly<Record<ExhaustionCircuit, ExhaustionKey>> {
  const shipped = readShipped("exhaustion-set.json"), keys: { [name: string]: ExhaustionKey } = {};
  for (const name of EXHAUSTION_CIRCUITS) {
    const entry = shipped[name] as { readonly [field: string]: unknown } | null, expected = EXHAUSTION_SET_MANIFEST.circuits[name];
    const refuse = (): never => { throw new ExhaustionSetError("IDENTITY", `the shipped ${name} key is not the set's`); };
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "keyHash,vk") return refuse();
    const vk = canonical(entry.vk, `${name} key`);
    if (vk.length !== EXHAUSTION_KEY_BYTES || bytesToHex(sha256(vk)) !== expected.vk || entry.keyHash !== expected.keyHash) refuse();
    keys[name] = Object.freeze({ vk, keyHash: hexToField(expected.keyHash) });
  }
  return Object.freeze(keys as Record<ExhaustionCircuit, ExhaustionKey>);
}
