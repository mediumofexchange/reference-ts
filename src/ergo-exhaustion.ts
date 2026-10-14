// Venue exhaustion read succinctly (succinct-read.md, `moe/succinct/v1` §4): a reader's option, never a verdict rule.
// For heights from an exhaustion set's start through a fold's end, a reader takes the outputs with venue-ergo §6's
// shape for its subject from the subject map (§4.2) under a fold proof (§4.3), fetches each such transaction with an
// inclusion path (§4.5) to its header on its own chain and attributes its objects itself (venue-ergo §§5–6); above the
// fold's end it reads sections natively (§4.6). Its result is a succinct judgment of the range (§4.4), laid out as a
// complete read's answer for the reader's own pool-v3 §13.3 derivation; it is never served (§1).
//
// The map is a function of the set's start and the chain (§4.2), so `SubjectMap` serves a prover, which proves it, and
// a supplier, which serves its paths and entries: neither is trusted by a reader, which recomputes every value.
//
// No circuit set is adopted (§6), so the only set here is a test set, labelled as such (`testExhaustionSet`): its fold
// proofs are hashes any party computes, which exercise every rule of the reader and attest nothing.
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { attributeTransaction, ergoOrdinal, orderedEntries, ownErgoProfile, sectionMatchesRoot, type AttributedObject, type ErgoProfile }
  from "./ergo-profile.js";
import { scanTransaction } from "./ergo-scan.js";
import { fieldToBytes, isField, limbsOf } from "./pool/field.js";
import { poseidon2Hash } from "./pool/poseidon2.js";
import type { RangeEntry, RangeRequest } from "./record-range.js";

export const T_ENTRY = 1010n;
export const T_MAP_LEAF = 1011n;
export const T_MAP_NODE = 1012n;
/** The map's depth: one level a bit of a 32-bit key. */
export const MAP_DEPTH = 32;
/** An inclusion path's most steps (§4.5). */
export const MAX_INCLUSION_STEPS = 32;
const U32 = 1n << 32n, U64 = 1n << 64n;

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
const isBytes = (v: unknown, width?: number): v is Uint8Array =>
  v instanceof Uint8Array && !(v.buffer instanceof SharedArrayBuffer) && (width === undefined || v.length === width);
const below = (v: unknown, bound: bigint): v is bigint => typeof v === "bigint" && v >= 0n && v < bound;
/** A set identity's frame (succinct-read §6): each part u32-length-prefixed. */
const setFrame = (parts: readonly Uint8Array[]): Uint8Array => {
  const w = new ByteWriter();
  for (const part of parts) w.lengthPrefixed(part);
  return w.finish();
};

/** An entry (§4.2): an output with venue-ergo §6's shape, at its block's height, its transaction's position in the
 * block's section and its index in the transaction. */
export interface MapEntry { readonly subject: Uint8Array; readonly height: bigint; readonly position: bigint; readonly output: bigint }

/** A subject's key: its last four bytes read as an integer (§4.2). */
export function subjectKey(subject: Uint8Array): bigint {
  if (!isBytes(subject, 32)) throw new EncodingError("a subject is 32 bytes");
  return BigInt(new DataView(subject.buffer, subject.byteOffset + 28, 4).getUint32(0, false));
}
/** `chain_i` from `chain_(i−1)` and the key's next entry (§4.2). */
export function entryChain(previous: bigint, entry: MapEntry): bigint {
  const [hi, lo] = limbsOf(entry.subject);
  return poseidon2Hash([T_ENTRY, previous, hi, lo, entry.height, entry.position, entry.output]);
}
/** A key's leaf: zero where its count is zero (§4.2). */
export function mapLeaf(count: bigint, chain: bigint): bigint {
  return count === 0n ? 0n : poseidon2Hash([T_MAP_LEAF, count, chain]);
}
export function mapNode(left: bigint, right: bigint): bigint {
  return poseidon2Hash([T_MAP_NODE, left, right]);
}
/** `z_0` through `z_32`, the empty subtrees by level; `z_32` is the empty map's root. */
export const EMPTY_SUBTREES: readonly bigint[] = Object.freeze((() => {
  const z = [0n];
  for (let l = 0; l < MAP_DEPTH; l++) z.push(mapNode(z[l]!, z[l]!));
  return z;
})());

/** A path for a key at a fold (§4.3): its leaf's count and chain value (zero where the count is) and 32 siblings, from
 * the leaf's up. */
export interface MapPath { readonly count: bigint; readonly chain: bigint; readonly siblings: readonly bigint[] }

/** The root a path gives for `key`, or undefined for a malformed path: a count of 2^64 or more, a nonzero chain at
 * count zero, other than 32 siblings, or a value that is not a field element. */
export function pathRoot(key: bigint, path: MapPath): bigint | undefined {
  if (!below(key, U32) || path === null || typeof path !== "object") return undefined;
  const { count, chain, siblings } = path;
  if (!below(count, U64) || !isField(chain) || (count === 0n && chain !== 0n) || !Array.isArray(siblings) || siblings.length !== MAP_DEPTH) return undefined;
  const own = [...siblings];
  if (!own.every(isField)) return undefined;
  let node = mapLeaf(count, chain);
  for (let l = 0; l < MAP_DEPTH; l++) node = (key >> BigInt(l)) & 1n ? mapNode(own[l]!, node) : mapNode(node, own[l]!);
  return node;
}

interface KeyState { count: bigint; chain: bigint; readonly entries: MapEntry[] }

/**
 * The map at a header (§4.2): empty at the start header, then every entry of every block from the start's child, in
 * order of height, position and output, appended to its key's chain. A prover or supplier keeps one; it holds every
 * entry and the map's nonempty nodes.
 */
export class SubjectMap {
  #height: bigint;
  #id: Uint8Array;
  readonly #keys = new Map<bigint, KeyState>();
  /** Nonempty nodes by level (0 the leaves) and index within it. */
  readonly #nodes: Map<bigint, bigint>[] = Array.from({ length: MAP_DEPTH + 1 }, () => new Map());

  /** The map at the start header `startId` at `startHeight`: empty. */
  constructor(startId: Uint8Array, startHeight: bigint) {
    if (!isBytes(startId, 32) || !below(startHeight, U32)) throw new EncodingError("invalid exhaustion start");
    this.#id = copyBytes(startId);
    this.#height = startHeight;
  }
  /** The header the map is at. */
  get end(): { readonly id: Uint8Array; readonly height: bigint } { return { id: copyBytes(this.#id), height: this.#height }; }
  get root(): bigint { return this.#node(MAP_DEPTH, 0n); }
  #node(level: number, index: bigint): bigint { return this.#nodes[level]!.get(index) ?? EMPTY_SUBTREES[level]!; }

  /** Append the next block: its header id, and its section's transactions' unsigned bytes in section order. The caller
   * has authenticated the section against the header and the header against its parent. */
  appendBlock(id: Uint8Array, transactions: readonly Uint8Array[]): void {
    if (!isBytes(id, 32) || !Array.isArray(transactions)) throw new EncodingError("invalid exhaustion block");
    const height = this.#height + 1n;
    if (height >= U32) throw new EncodingError("exhaustion height out of range");
    transactions.forEach((unsigned, position) => {
      for (const { output, subject } of scanTransaction(unsigned)) {
        this.#append({ subject, height, position: BigInt(position), output: BigInt(output) });
      }
    });
    this.#id = copyBytes(id);
    this.#height = height;
  }
  #append(entry: MapEntry): void {
    const key = subjectKey(entry.subject);
    const state = this.#keys.get(key) ?? { count: 0n, chain: 0n, entries: [] };
    state.chain = entryChain(state.chain, entry);
    state.count += 1n;
    state.entries.push(Object.freeze({ ...entry, subject: copyBytes(entry.subject) }));
    this.#keys.set(key, state);
    let node = mapLeaf(state.count, state.chain), index = key;
    this.#nodes[0]!.set(index, node);
    for (let l = 0; l < MAP_DEPTH; l++) {
      const sibling = this.#node(l, index ^ 1n);
      node = index & 1n ? mapNode(sibling, node) : mapNode(node, sibling);
      index >>= 1n;
      this.#nodes[l + 1]!.set(index, node);
    }
  }
  /** The path for `key` at the map's end. */
  path(key: bigint): MapPath {
    if (!below(key, U32)) throw new EncodingError("a key is below 2^32");
    const state = this.#keys.get(key), siblings: bigint[] = [];
    for (let l = 0, index = key; l < MAP_DEPTH; l++, index >>= 1n) siblings.push(this.#node(l, index ^ 1n));
    return Object.freeze({ count: state?.count ?? 0n, chain: state?.chain ?? 0n, siblings: Object.freeze(siblings) });
  }
  /** The key's entries after its first `from`, in chain order. */
  entries(key: bigint, from = 0n): readonly MapEntry[] {
    const all = this.#keys.get(key)?.entries ?? [];
    return Object.freeze(all.slice(Number(from)).map(e => Object.freeze({ ...e, subject: copyBytes(e.subject) })));
  }
}

/** One step of an inclusion path: a 32-byte sibling, or `null` for a lone child (§4.5). */
export type InclusionStep = Uint8Array | null;
const node = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return blake2b(out, { dkLen: 32 });
};
const LEAF = Uint8Array.of(0), INNER = Uint8Array.of(1);

/** The inclusion path for the transaction at position `j` of a section, under the rule whose leaves are `leaves` (the
 * ids, or the ids then the witness ids): venue-ergo §4's tree, a node without a right sibling hashing its left child
 * alone. */
export function inclusionPath(leaves: readonly Uint8Array[], j: number): readonly InclusionStep[] {
  if (!Array.isArray(leaves) || leaves.length === 0 || !Number.isInteger(j) || j < 0 || j >= leaves.length) throw new EncodingError("invalid inclusion position");
  let level = leaves.map(leaf => node(LEAF, leaf)), at = j;
  const steps: InclusionStep[] = [];
  do {
    const sibling = at % 2 === 0 ? level[at + 1] : level[at - 1];
    steps.push(sibling === undefined ? null : copyBytes(sibling));
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? node(INNER, level[i]!, level[i + 1]!) : node(INNER, level[i]!));
    level = next;
    at >>= 1;
  } while (level.length > 1);
  return Object.freeze(steps);
}
/** The inclusion path of a section's transaction at `j` under whichever rule reproduces `root`, or undefined where
 * neither does (venue-ergo §4). */
export function sectionInclusionPath(transactions: readonly { readonly unsigned: Uint8Array; readonly witnessId: Uint8Array }[], root: Uint8Array,
    j: number): readonly InclusionStep[] | undefined {
  const read = transactions.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId }));
  if (!sectionMatchesRoot(read, root)) return undefined;
  const ids = read.map(t => t.id);
  for (const leaves of [ids, [...ids, ...read.map(t => t.witnessId)]]) {
    const path = inclusionPath(leaves, j);
    if (inclusionRoot(read[j]!.id, j, path) !== undefined && same(inclusionRoot(read[j]!.id, j, path)!, root)) return path;
  }
  return undefined;
}
/**
 * §4.5: the transactions root an inclusion path gives for the transaction with id `id` at position `j`, or undefined
 * for a path of more than 32 steps, a malformed step, a lone child where bit `l` of `j` is one, or `j` with a set bit
 * at or above the path's length.
 */
export function inclusionRoot(id: Uint8Array, j: number, steps: readonly InclusionStep[]): Uint8Array | undefined {
  if (!isBytes(id, 32) || !Number.isInteger(j) || j < 0 || j >= 2 ** 32 || !Array.isArray(steps) || steps.length === 0 ||
      steps.length > MAX_INCLUSION_STEPS || BigInt(j) >> BigInt(steps.length) !== 0n) return undefined;
  let current = node(LEAF, id);
  for (let l = 0; l < steps.length; l++) {
    const step = steps[l], right = (BigInt(j) >> BigInt(l)) & 1n;
    if (step === null) {
      if (right) return undefined;
      current = node(INNER, current);
    } else if (isBytes(step, 32)) {
      current = right ? node(INNER, step, current) : node(INNER, current, step);
    } else return undefined;
  }
  return current;
}

/** A fold proof's public inputs (§4.3), the ids as 32 bytes. */
export interface FoldInputs {
  readonly startId: Uint8Array; readonly startHeight: bigint; readonly endId: Uint8Array; readonly endHeight: bigint;
  readonly mapRoot: bigint; readonly foldKeyHash: bigint;
}
/** A fold proof with its inputs; `first` names the circuit whose key it verifies under. */
export interface Fold { readonly first: boolean; readonly inputs: FoldInputs; readonly proof: Uint8Array }

/** The inputs in §4.3's order, `startHi, startLo, startHeight, endHi, endLo, endHeight, mapRoot, foldKeyHash`, the ids
 * as limbs; undefined for a malformed value. */
export function foldPublicInputs(inputs: FoldInputs): readonly bigint[] | undefined {
  if (inputs === null || typeof inputs !== "object") return undefined;
  const { startId, startHeight, endId, endHeight, mapRoot, foldKeyHash } = inputs;
  if (!isBytes(startId, 32) || !isBytes(endId, 32) || !below(startHeight, U32) || !below(endHeight, U32) || !isField(mapRoot) || !isField(foldKeyHash)) return undefined;
  return Object.freeze([...limbsOf(startId), startHeight, ...limbsOf(endId), endHeight, mapRoot, foldKeyHash]);
}

/** An exhaustion circuit set as a reader pins it (§§2, 4.3, 6). */
export interface ExhaustionSet {
  /** The set identity (§6), which names kept tuples (§4.4). */
  readonly identity: Uint8Array;
  /** True for a test set, which no adoption names (§1). */
  readonly test: boolean;
  /** The exhaustion's start header (§6). */
  readonly start: { readonly id: Uint8Array; readonly height: bigint };
  /** The next fold's pinned key hash, every fold's `foldKeyHash` (§4.3 rule 2). */
  readonly foldKeyHash: bigint;
  /** Whether `proof` verifies under the pinned first-fold key (`first`) or next-fold key with exactly these public
   * inputs (§4.3 rule 1). False for malformed bytes. */
  verifyFold(first: boolean, inputs: readonly bigint[], proof: Uint8Array): Promise<boolean> | boolean;
}

/** The reader's own accepted chain: its best header at a height above its anchor, and its tip's height. */
export interface ReaderChain {
  at(height: bigint): { readonly id: Uint8Array; readonly transactionsRoot: Uint8Array } | undefined;
  readonly tipHeight: bigint;
}

/** Why a fold is not used (§4.3): it does not verify, its key hash or start is not the pinned one, or its end is not
 * the reader's header at that height, at least the depth below its tip. */
export type FoldRefusal = "fold-proof" | "fold-key" | "fold-start" | "fold-end" | "fold-depth";

/** §4.3 rules 1–4. */
export async function foldRefusal(set: ExhaustionSet, fold: Fold, chain: ReaderChain, depth: bigint): Promise<FoldRefusal | undefined> {
  if (fold === null || typeof fold !== "object" || typeof fold.first !== "boolean" || !isBytes(fold.proof)) return "fold-proof";
  const inputs = foldPublicInputs(fold.inputs);
  if (inputs === undefined) return "fold-proof";
  const { startId, startHeight, endId, endHeight, foldKeyHash } = fold.inputs;
  if (await set.verifyFold(fold.first, inputs, copyBytes(fold.proof)) !== true) return "fold-proof";
  if (foldKeyHash !== set.foldKeyHash) return "fold-key";
  if (!same(startId, set.start.id) || startHeight !== set.start.height) return "fold-start";
  const header = chain.at(endHeight);
  if (header === undefined || !same(header.id, endId)) return "fold-end";
  if (chain.tipHeight - endHeight < depth) return "fold-depth";
  return undefined;
}

/** What a reader may keep for a key after a read (§4.4): the map's count and chain value for it at a fold's end. */
export interface KeptTuple {
  readonly identity: Uint8Array; readonly key: bigint; readonly count: bigint; readonly chain: bigint;
  readonly endHeight: bigint; readonly endId: Uint8Array;
}

/** A transaction a supplier gives for a `(height, position)`: its unsigned bytes and an inclusion path (§4.5). */
export interface IncludedTransaction { readonly unsigned: Uint8Array; readonly steps: readonly InclusionStep[] }

/** What a succinct range read takes from suppliers and from the reader's own state. */
export interface SuccinctRangeSources {
  readonly profile: ErgoProfile;
  /** The venue's anchor height `A`: index `i` is height `A + 1 + i`. */
  readonly anchorHeight: bigint;
  readonly set: ExhaustionSet;
  readonly chain: ReaderChain;
  readonly fold: Fold;
  /** The path for the request subject's key at the fold. */
  readonly path: MapPath;
  /** The key's entries after the kept count (all of them without `kept`), in chain order. */
  readonly entries: readonly MapEntry[];
  /** A tuple kept from an earlier read of this key under the same set (§4.4), whose end lies below the request. */
  readonly kept?: KeptTuple;
  /** The transaction at `position` of the block at `height`, with an inclusion path, or undefined where withheld. */
  transaction(height: bigint, position: bigint): Promise<IncludedTransaction | undefined> | IncludedTransaction | undefined;
  /** Index `i`'s attributed objects, read natively from a section that reproduced its header's root (§4.6), or
   * undefined where no such section is held. */
  sectionAt(index: bigint): Promise<readonly AttributedObject[] | undefined> | readonly AttributedObject[] | undefined;
}

/** Why a succinct read did not resolve: a fold refusal, a start above the anchor, a path that does not give the fold's
 * root, entries that do not reproduce it, a kept tuple that does not continue, a withheld or unincluded transaction,
 * or a missing section above the fold. The reader then reads natively, or the read stays unresolved (§4.6). */
export type SuccinctRangeRefusal = FoldRefusal | "start" | "path" | "entries" | "kept" | "transaction" | "section";
export type SuccinctRange =
  | { readonly entries: readonly RangeEntry[]; readonly kept: KeptTuple }
  | { readonly refused: SuccinctRangeRefusal };

/**
 * §4.4: the request's range from a fold, a path, the key's entries and their transactions, and native sections above
 * the fold's end. The caller has checked the venue and that `toIndex` is witnessed (venue-ergo §2); the request is
 * owned. A refusal establishes nothing (succinct-read §2 rule 3).
 */
export async function succinctRange(request: RangeRequest, sources: SuccinctRangeSources): Promise<SuccinctRange> {
  const profile = ownErgoProfile(sources.profile);
  const { anchorHeight: A, set, chain, fold, kept } = sources;
  const refused = (reason: SuccinctRangeRefusal): SuccinctRange => ({ refused: reason });
  // 1. The fold, and a start at or below the anchor.
  const refusal = await foldRefusal(set, fold, chain, profile.depth);
  if (refusal !== undefined) return refused(refusal);
  if (set.start.height > A) return refused("start");
  const E = fold.inputs.endHeight, first = A + 1n + request.fromIndex, last = A + 1n + request.toIndex;
  // 2. The path, and the entries that make its leaf from the kept tuple or from nothing.
  const key = subjectKey(request.subject), given = sources.path;
  if (given === null || typeof given !== "object" || !Array.isArray(given.siblings)) return refused("path");
  const path: MapPath = { count: given.count, chain: given.chain, siblings: [...given.siblings] };
  if (pathRoot(key, path) !== fold.inputs.mapRoot) return refused("path");
  let count = 0n, value = 0n;
  if (kept !== undefined) {
    if (kept === null || typeof kept !== "object" || !isBytes(kept.endId, 32) || !below(kept.count, U64) || !isField(kept.chain)) return refused("kept");
    // A kept tuple continues a later read of the same set and key only where the best chain still holds its end.
    const at = chain.at(kept.endHeight);
    if (!same(kept.identity, set.identity) || kept.key !== key || kept.endHeight > E || at === undefined || !same(at.id, kept.endId)) return refused("kept");
    if (first <= kept.endHeight) throw new RangeError("a kept tuple serves only heights above its end");
    count = kept.count; value = kept.chain;
  }
  const entries: MapEntry[] = [];
  if (!Array.isArray(sources.entries)) return refused("entries");
  for (const entry of sources.entries) {
    if (entry === null || typeof entry !== "object" || !isBytes(entry.subject, 32) || !below(entry.height, U32) ||
        !below(entry.position, U32) || !below(entry.output, U32)) return refused("entries");
    const own = { subject: copyBytes(entry.subject), height: entry.height, position: entry.position, output: entry.output };
    if (subjectKey(own.subject) !== key) return refused("entries");
    value = entryChain(value, own);
    count += 1n;
    entries.push(own);
  }
  if (count !== path.count || value !== path.chain) return refused("entries");
  // 3. Each transaction holding an entry for the subject in the window, fetched with its inclusion path.
  const top = last < E ? last : E, objects: { index: bigint; ordinal: bigint; record: Uint8Array }[] = [];
  const places = new Map<string, { height: bigint; position: bigint }>();
  for (const entry of entries) {
    if (entry.height < first || entry.height > top || !same(entry.subject, request.subject)) continue;
    places.set(`${entry.height}:${entry.position}`, { height: entry.height, position: entry.position });
  }
  const ordered = [...places.values()].sort((x, y) => x.height === y.height ? Number(x.position - y.position) : x.height < y.height ? -1 : 1);
  for (const { height, position } of ordered) {
    const header = chain.at(height), included = await sources.transaction(height, position);
    if (header === undefined || included === undefined || included === null || typeof included !== "object" || !isBytes(included.unsigned)) return refused("transaction");
    const unsigned = copyBytes(included.unsigned), root = inclusionRoot(blake2b(unsigned, { dkLen: 32 }), Number(position), included.steps);
    if (root === undefined || !same(root, header.transactionsRoot)) return refused("transaction");
    for (const object of attributeTransaction(profile, unsigned, Number(position))) {
      if (object.kind === request.kind && same(object.subject, request.subject)) objects.push({ index: height - A - 1n, ordinal: object.ordinal, record: object.record });
    }
  }
  // 4. Every height above the fold's end, natively.
  for (let index = (E - A > request.fromIndex ? E - A : request.fromIndex); index <= request.toIndex; index++) {
    const section = await sources.sectionAt(index);
    if (section === undefined) return refused("section");
    for (const object of section) {
      if (object.kind === request.kind && same(object.subject, request.subject)) objects.push({ index, ordinal: object.ordinal, record: object.record });
    }
  }
  // 5. Entered as venue-ergo §7 enters them.
  return {
    entries: orderedEntries(request.kind, objects),
    kept: Object.freeze({ identity: copyBytes(set.identity), key, count, chain: value, endHeight: E, endId: copyBytes(fold.inputs.endId) }),
  };
}

/** A test set (§1): a fold proof is SHA-256 over a fixed context, the set, the circuit and the public inputs. Anyone
 * makes one, so it attests nothing; `prove` makes one, as a prover would after computing the map natively. */
export function testExhaustionSet(label: string, start: { readonly id: Uint8Array; readonly height: bigint }):
    ExhaustionSet & { prove(first: boolean, inputs: FoldInputs): Uint8Array } {
  const encoder = new TextEncoder();
  if (!isBytes(start.id, 32) || !below(start.height, U32)) throw new EncodingError("invalid exhaustion start");
  const identity = sha256(setFrame([encoder.encode("moe/succinct/v1/set"), encoder.encode("test"), encoder.encode("exhaustion"),
    encoder.encode(label), copyBytes(start.id), fieldToBytes(start.height)]));
  const foldKeyHash = BigInt(`0x${Buffer.from(sha256(setFrame([encoder.encode("moe/succinct/v1/test-fold-key"), identity]))).toString("hex")}`) >> 8n;
  const proofOf = (first: boolean, inputs: readonly bigint[]): Uint8Array =>
    sha256(setFrame([encoder.encode("moe/succinct/v1/test-fold"), identity, Uint8Array.of(first ? 1 : 2), ...inputs.map(fieldToBytes)]));
  return Object.freeze({
    identity, test: true, start: Object.freeze({ id: copyBytes(start.id), height: start.height }), foldKeyHash,
    verifyFold: (first: boolean, inputs: readonly bigint[], proof: Uint8Array) => inputs.length === 8 && isBytes(proof) && same(proof, proofOf(first, inputs)),
    prove(first: boolean, inputs: FoldInputs): Uint8Array {
      const fields = foldPublicInputs(inputs);
      if (fields === undefined) throw new EncodingError("invalid fold inputs");
      return proofOf(first, fields);
    },
  });
}
