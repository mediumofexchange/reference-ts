// The succinct circuit set (succinct-read §6): the twelve circuits an adoption names, the trail check set's six
// (`pool/v3/check-set.ts`) and the venue exhaustion's six (`ergo-exhaustion-set.ts`), in one manifest, and the set
// identity's frame over it and the exhaustion's start. One identity names the whole set: a succinct read's kept state,
// classes and tuples (§2 rule 8, §4.4), the covers a replica serves and the folds it proves, and what a reader drops on
// a disagreement (§2 rule 7).
//
// No set is adopted, so the shipped set is a test set (§1): its identity is §6's frame under a context of its own,
// `moe/succinct/v1/test-set`, which no adoption's identity can equal, from the caller's start (a CLI venue's anchor).
import type { Barretenberg } from "@aztec/bb.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, EncodingError } from "./bytes.js";
import type { ExhaustionSet } from "./ergo-exhaustion.js";
import { EXHAUSTION_CIRCUITS, EXHAUSTION_SET_MANIFEST, exhaustionKeys, exhaustionSetOver, type ExhaustionCircuit,
  type ExhaustionVerifierSource } from "./ergo-exhaustion-set.js";
import { fieldToBytes, hexToField } from "./pool/field.js";
import { BN254_PARAMETERS } from "./pool/parameters.js";
import type { VerifierOptions } from "./pool/proof-verifier.js";
import { CHECK_SET_MANIFEST, openTrailCheckSet, TRAIL_CIRCUITS, type TrailCheckSet, type TrailCircuit } from "./pool/v3/check-set.js";

/** The twelve circuits under §6's names, in the order its frame holds them. */
export const SUCCINCT_CIRCUITS = Object.freeze(["trail-issue", "trail-spend", "trail-burn", "trail-demand", "trail-settle", "trail-node",
  "exhaustion-tx", "exhaustion-tree", "exhaustion-map", "exhaustion-node", "fold-first", "fold-next"] as const);
export type SuccinctCircuit = typeof SUCCINCT_CIRCUITS[number];

/** One circuit as §6's frame holds it: each source file by its path below the package's `src` with its SHA-256, the
 * SHA-256 of its bytecode as the compiler emits it and of its key, and its key hash (`0x` and 64 hex digits). */
export interface SetCircuit {
  readonly sources: Readonly<Record<string, string>>;
  readonly bytecode: string;
  readonly vk: string;
  readonly keyHash: string;
}
/** What §6's frame holds besides the start, and the specification revision whose frame it is (not framed). */
export interface SetManifest {
  readonly specification: string;
  readonly circuits: Readonly<Record<SuccinctCircuit, SetCircuit>>;
  /** The compiler that produced every bytecode identity; any reproducing them qualifies (pool-v3 §4, Reproduction). */
  readonly compiler: string;
  readonly backend: string;
  readonly verifierTarget: string;
  /** Ignition's leading G1 points proving reads, their layout's SHA-256, and `[x]_2`'s (pool-v3 §4). */
  readonly parameters: { readonly points: number; readonly g1: string; readonly g2: string };
}
/** The exhaustion's start header (§6). */
export interface SetStart { readonly id: Uint8Array; readonly height: bigint }

const trailName: Readonly<Record<TrailCircuit, SuccinctCircuit>> = Object.freeze({ "leaf-issue": "trail-issue", "leaf-spend": "trail-spend",
  "leaf-burn": "trail-burn", "leaf-demand": "trail-demand", "leaf-settle": "trail-settle", "node": "trail-node" });
const exhaustionName: Readonly<Record<ExhaustionCircuit, SuccinctCircuit>> = Object.freeze({ "leaf-t": "exhaustion-tx", "leaf-m": "exhaustion-tree",
  "leaf-u": "exhaustion-map", "node": "exhaustion-node", "fold-first": "fold-first", "fold-next": "fold-next" });

/** The shipped set's manifest, from its two halves' (each checked against what it builds by its own script). Both
 * halves compile under one Noir version (the trail set on noir_wasm, the exhaustion set on the native nargo of the same
 * revision, whose bytecode is noir_wasm's) with the vendored sponge, prove under the backend and target pool-v3 §4 names,
 * and read Ignition's leading points up to the exhaustion leaves' 2^22, of which the trail set's 2^21 are a prefix. */
export const SUCCINCT_SET_MANIFEST: SetManifest = Object.freeze({
  specification: "succinct-read c90b230",
  circuits: Object.freeze(Object.fromEntries([
    ...TRAIL_CIRCUITS.map(name => [trailName[name], Object.freeze({
      sources: Object.freeze({ "main.nr": CHECK_SET_MANIFEST.circuits[name].source, ...CHECK_SET_MANIFEST.modules }),
      bytecode: CHECK_SET_MANIFEST.circuits[name].bytecode, vk: CHECK_SET_MANIFEST.circuits[name].vk, keyHash: CHECK_SET_MANIFEST.circuits[name].keyHash })]),
    ...EXHAUSTION_CIRCUITS.map(name => [exhaustionName[name], Object.freeze({
      sources: Object.freeze({ "main.nr": EXHAUSTION_SET_MANIFEST.circuits[name].source,
        ...Object.fromEntries(EXHAUSTION_SET_MANIFEST.reads[name].map(module => [module, EXHAUSTION_SET_MANIFEST.modules[module]])) }),
      bytecode: EXHAUSTION_SET_MANIFEST.circuits[name].bytecode, vk: EXHAUSTION_SET_MANIFEST.circuits[name].vk,
      keyHash: EXHAUSTION_SET_MANIFEST.circuits[name].keyHash })]),
  ]) as Record<SuccinctCircuit, SetCircuit>),
  compiler: "noir 1.0.0-beta.26+40d6574f851d926f93e0c3a271bac3e6e82ac905",
  backend: EXHAUSTION_SET_MANIFEST.backend,
  verifierTarget: EXHAUSTION_SET_MANIFEST.verifierTarget,
  parameters: Object.freeze({ points: EXHAUSTION_SET_MANIFEST.parameters.points, g1: EXHAUSTION_SET_MANIFEST.parameters.g1, g2: BN254_PARAMETERS.g2 }),
});

/** The adopted identity's context (§6), and the one the reference's test sets take in its place (§1). */
export const SET_CONTEXT = "moe/succinct/v1/set";
export const TEST_SET_CONTEXT = "moe/succinct/v1/test-set";

const encoder = new TextEncoder();
/** A SHA-256 named in hex, as its 32 bytes. */
const hash32 = (w: ByteWriter, hex: string, what: string): void => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new EncodingError(`${what} is not a SHA-256 in hex`);
  w.fixed(Uint8Array.from(hex.match(/../g)!, x => parseInt(x, 16)), 32, what);
};
/** `text(s)`: a u32 length and ASCII. */
const text = (w: ByteWriter, value: string, what: string): void => {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value)) throw new EncodingError(`${what} is not ASCII text`);
  w.u32(value.length);
  w.fixed(encoder.encode(value), value.length, what);
};

/**
 * §6's `setBytes` over `manifest` and `start`, beginning with `context`: per circuit in §6's order its name, source
 * count and each source (path, SHA-256) in strictly ascending byte order of paths, bytecode, key and key hash; then the
 * compiler, backend, target, points, G1 and G2 hashes, and the start's id and height.
 */
export function setBytes(manifest: SetManifest, start: SetStart, context: string = SET_CONTEXT): Uint8Array {
  if (!(start?.id instanceof Uint8Array) || start.id.length !== 32 || typeof start.height !== "bigint" || start.height < 0n || start.height >= 1n << 32n) {
    throw new EncodingError("invalid exhaustion start");
  }
  const { points } = manifest.parameters;
  if (!Number.isSafeInteger(points) || points < 1 || points >= 2 ** 32) throw new EncodingError("invalid point count");
  const w = new ByteWriter();
  w.fixed(encoder.encode(context), context.length, "the context");
  for (const name of SUCCINCT_CIRCUITS) {
    const c = manifest.circuits[name];
    if (c === undefined) throw new EncodingError(`the manifest has no ${name}`);
    text(w, name, "a circuit name");
    // Ascending byte order of the ASCII paths (a code-unit sort, which for ASCII is byte order); an object's keys are
    // distinct, so the order is strict.
    const sources = Object.keys(c.sources).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (sources.length === 0) throw new EncodingError(`${name} has no source`);
    w.u32(sources.length);
    for (const source of sources) {
      text(w, source, `a source name of ${name}`);
      hash32(w, c.sources[source]!, `${name}'s ${source}`);
    }
    hash32(w, c.bytecode, `${name}'s bytecode`);
    hash32(w, c.vk, `${name}'s key`);
    if (!/^0x[0-9a-f]{64}$/.test(c.keyHash)) throw new EncodingError(`${name}'s key hash is not a field element in hex`);
    w.fixed(fieldToBytes(hexToField(c.keyHash)), 32, `${name}'s key hash`);
  }
  text(w, manifest.compiler, "the compiler");
  text(w, manifest.backend, "the backend");
  text(w, manifest.verifierTarget, "the verifier target");
  w.u32(points);
  hash32(w, manifest.parameters.g1, "the G1 points");
  hash32(w, manifest.parameters.g2, "the G2 point");
  w.fixed(start.id, 32, "the start id");
  w.u32(Number(start.height));
  return w.finish();
}

/** The shipped set's test identity from `start`: SHA-256 of §6's frame under `TEST_SET_CONTEXT` (§1). */
export function testSetIdentity(start: SetStart): Uint8Array {
  return sha256(setBytes(SUCCINCT_SET_MANIFEST, start, TEST_SET_CONTEXT));
}

/** The shipped trail check set from `start`, on verifier instances of its own over `api` (`openTrailCheckSet`). */
export function shippedCheckSet(api: Barretenberg, start: SetStart, options: VerifierOptions = {}): TrailCheckSet {
  return openTrailCheckSet(api, testSetIdentity(start), options);
}

/** The shipped exhaustion set from `start` (`exhaustionSetOver` with the pinned fold keys). */
export function shippedExhaustionSet(start: SetStart, source: ExhaustionVerifierSource,
    options: VerifierOptions = {}): ExhaustionSet & { close(): Promise<void> } {
  const keys = exhaustionKeys();
  return exhaustionSetOver(testSetIdentity(start), { first: keys["fold-first"], next: keys["fold-next"] }, start, source, options);
}
