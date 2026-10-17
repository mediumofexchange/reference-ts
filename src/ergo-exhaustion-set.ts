// The venue exhaustion's circuit set (succinct-read §§4.3, 6; slice 43): the three exhaustion leaves, the node and the
// two folds, built from the sources at the leaves' production sizes under the pinned compiler and backend. The package
// ships each circuit's key and key hash (`exhaustion-set.json`, what a reader pins) and the circuits' sources
// (`exhaustion-circuits/`, which a prover compiles: `ergo-exhaustion-programs.ts`), not their programs, tens of
// megabytes a leaf; `scripts/venue/exhaustion-set.mjs` builds them again and checks the sources, the keys and the
// identities below.
//
// No set is adopted (§6 names twelve circuits, the start header and the agreement evidence), so this is a test set,
// labelled as such (§1): a succinct read under it is exercised against real fold proofs and attests nothing a reader may
// rely on until an adoption names its identities. Its start is the caller's (a CLI venue's anchor): one circuit set
// serves every start, which only the set identity and a fold's public inputs name.
//
// Nothing here loads `@noir-lang`: a reader verifies folds under the pinned first-fold and next-fold keys on verifier
// instances of its own (`keyedVerifier`), which read `[1]_1` and `[x]_2` and nothing else.
import { readFileSync } from "node:fs";
import type { Barretenberg } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteWriter, copyBytes, EncodingError } from "./bytes.js";
import type { ExhaustionSet } from "./ergo-exhaustion.js";
import type { LeafSizes } from "./ergo-exhaustion-prover.js";
import { fieldToBytes, fieldToHex, hexToField } from "./pool/field.js";
import { EXHAUSTION_PARAMETERS } from "./pool/parameters.js";
import { keyedVerifier, type CompiledProgram, type KeyedVerifier, type VerifierOptions } from "./pool/proof-verifier.js";

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
 * The shipped set's identities, held here and never read from a supplier: per circuit, as `CircuitIdentity`, under
 * the compiler and backend named, at the leaves' sizes, from `EXHAUSTION_PARAMETERS`. `scripts/venue/exhaustion-set.mjs`
 * builds the circuits again and asserts every entry and both shipped files.
 */
export const EXHAUSTION_SET_MANIFEST = Object.freeze({
  specification: "succinct-read 282c925",
  compiler: "nargo 1.0.0-beta.26+40d6574f851d926f93e0c3a271bac3e6e82ac905",
  backend: "@aztec/bb.js 5.2.0",
  verifierTarget: "noir-recursive",
  sizes: Object.freeze({ t: 167, m: 380, u: 746 }),
  parameters: EXHAUSTION_PARAMETERS,
  circuits: Object.freeze({
    "leaf-t": Object.freeze({
      bytecode: "82cd725db1094c67497372691c666dd08e5f007b2783343b9a2417c58e64e42c",
      vk: "a2c125ab2feca20af407697b6e1e6d99cba6a73ab65ec079a769be789e1ab4f2",
      keyHash: "0x1ab2476249309e13f2afc6bbbc35e73c601605b0472281d56d82f18241d476eb" }),
    "leaf-m": Object.freeze({
      bytecode: "9fae587c658321b9d420e27a619781681f42ebb6bc5f84fb30effe9ea6ca81c7",
      vk: "8ccc7ff201b41531ae8e2f752d8af6cf056d4fbdb89995e27804976e74bb4468",
      keyHash: "0x08103c1cbb738a837b4e785ea379b9eaccb8f03dbf318ebe171694022af69ddc" }),
    "leaf-u": Object.freeze({
      bytecode: "6a7b8d6fe23a3e7dbf0b9b63ab21c87ef007bde9e652ad964789aae427263823",
      vk: "219a3639bf3f8ff8ee49183496e56204a13ddc0e2bcdb6831a2c639fc14a2391",
      keyHash: "0x0881a4e495405f03c9252c4ed9a06f273f41cac96fb95bb6697446ecc1adb703" }),
    "node": Object.freeze({
      bytecode: "1df15219c293298eea602ed29021859a3d13625112f27effe8312f6144ab01e8",
      vk: "2ff0d792d5f34e9b9291b2b9f48378b0923eb030337a2c6ad4adce1f5f7bd445",
      keyHash: "0x1dc2959b6e05b085ee869d71cd8fcf903e044a2f19dbb6a2d0da47a5be203081" }),
    "fold-first": Object.freeze({
      bytecode: "539398acab4641d1ee228a3f5d8f8e62b01e98a49d89974b6bbed64cdb178ebf",
      vk: "54ae6b9bd08d753ecde56e32e7aa3975015146db42efb019e8dcb7e1e1c02ce0",
      keyHash: "0x128d1e3e96a79c134962c30cc773acc34f1c6923608a5b42ec734a3b0f9f8d12" }),
    "fold-next": Object.freeze({
      bytecode: "f054df2a0b832b27f42054464d179fc91e63ff8eeee11d9b69f2d08ceafb9367",
      vk: "268f7cd52a3b16938158bb42b5dcfbab3fd6f00637848e9d1835a475e43a9814",
      keyHash: "0x28042fd2c360b17a7254c3de948e5b45cd4d59c269a95c9500213750b598a7ee" }),
  }) as Readonly<Record<ExhaustionCircuit, CircuitIdentity>>,
});

/** Each built circuit's identities (§6). */
export function circuitIdentities(circuits: ExhaustionCircuits): Readonly<Record<ExhaustionCircuit, CircuitIdentity>> {
  return Object.freeze(Object.fromEntries(EXHAUSTION_CIRCUITS.map(name => {
    const c = circuits.circuits[name];
    return [name, Object.freeze({ bytecode: bytesToHex(sha256(base64(c.program.bytecode))), vk: bytesToHex(sha256(c.vk)), keyHash: fieldToHex(c.keyHash) })];
  })) as Record<ExhaustionCircuit, CircuitIdentity>);
}

const encoder = new TextEncoder();
const base64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], x => parseInt(x, 16));

/** A test set's identity (§6's frame, labelled `test`): SHA-256 over `moe/succinct/v1/set`, the label, `exhaustion-circuits`,
 * each circuit's name, bytecode's and key's SHA-256 and key hash in §4.3's order, the proving points' hash and the start
 * (not the sources, compiler or backend, which an adoption names, nor a check that each key hash derives from its key:
 * whoever builds the files chooses the set). */
export function exhaustionSetIdentity(identities: Readonly<Record<ExhaustionCircuit, CircuitIdentity>>,
    start: { readonly id: Uint8Array; readonly height: bigint }): Uint8Array {
  if (!(start?.id instanceof Uint8Array) || start.id.length !== 32 || typeof start.height !== "bigint" || start.height < 0n || start.height >= 1n << 32n) {
    throw new EncodingError("invalid exhaustion start");
  }
  const w = new ByteWriter();
  for (const part of [encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), encoder.encode("exhaustion-circuits"),
    ...EXHAUSTION_CIRCUITS.flatMap(name => [encoder.encode(name), hexBytes(identities[name].bytecode), hexBytes(identities[name].vk),
      fieldToBytes(hexToField(identities[name].keyHash))]),
    hexBytes(EXHAUSTION_PARAMETERS.g1), copyBytes(start.id), fieldToBytes(start.height)]) w.lengthPrefixed(part);
  return sha256(w.finish());
}

/** Where a set's verifier instances take `[1]_1` and `[x]_2` from: a started instance (the caller's to destroy after the
 * set is made), or a function starting one at the set's first verification, which the set destroys once read. */
export type ExhaustionVerifierSource = Barretenberg | (() => Promise<Barretenberg>);

/**
 * A test set over circuits with these identities and fold keys, from `start` (§§1, 6; `exhaustionSetIdentity`): a fold
 * verifies under the first-fold or next-fold key on verifier instances of its own. `close` ends them.
 */
export function exhaustionSetOver(identities: Readonly<Record<ExhaustionCircuit, CircuitIdentity>>,
    folds: { readonly first: ExhaustionKey; readonly next: ExhaustionKey }, start: { readonly id: Uint8Array; readonly height: bigint },
    source: ExhaustionVerifierSource, options: VerifierOptions = {}): ExhaustionSet & { close(): Promise<void> } {
  const identity = exhaustionSetIdentity(identities, start);
  // The keys it verifies under must be the ones its identity names.
  for (const [name, key] of [["fold-first", folds.first], ["fold-next", folds.next]] as const) {
    if (bytesToHex(sha256(key.vk)) !== identities[name].vk || fieldToHex(key.keyHash) !== identities[name].keyHash) {
      throw new EncodingError(`the ${name} key is not the one the set's identity names`);
    }
  }
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
    identity, test: true, start: Object.freeze({ id: copyBytes(start.id), height: start.height }),
    foldKeyHash: folds.next.keyHash,
    verifyFold: async (first: boolean, inputs: readonly bigint[], proof: Uint8Array) =>
      proof instanceof Uint8Array && proof.length === EXHAUSTION_PROOF_BYTES && await (await opened()).verify(first ? 1 : 2, inputs, proof),
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

/** The shipped set from `start` (`exhaustionSetOver` with the manifest's identities and the pinned fold keys). */
export function shippedExhaustionSet(start: { readonly id: Uint8Array; readonly height: bigint }, source: ExhaustionVerifierSource,
    options: VerifierOptions = {}): ExhaustionSet & { close(): Promise<void> } {
  const keys = exhaustionKeys();
  return exhaustionSetOver(EXHAUSTION_SET_MANIFEST.circuits, { first: keys["fold-first"], next: keys["fold-next"] }, start, source, options);
}
