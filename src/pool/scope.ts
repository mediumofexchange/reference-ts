// The scope and its authenticated root (pool-v2 §5; C1.2.2).
//
// A scope is the public, sorted set of backings one operator serves together
// under one domain on one venue, each with the replacement link under which
// the operator holds it: an entry is (backing name, link). Entries are sorted
// strictly ascending by the backing's bytes, so a scope has no duplicate
// backing, and a scope holds between 1 and 2^16 entries.
//
// The scope is authenticated in-circuit by a Merkle tree of depth 16 over H:
// entry i is leaf i in sorted order, an unused leaf is 0, and
//
//   leaf(backing, link)   = H(T_SCOPE_LEAF, backingHi, backingLo, linkHi, linkLo)
//   snode(l, left, right) = H(T_SCOPE_NODE, l, left, right)     l the children's level
//   s_0 = 0,  s_{l+1} = snode(l, s_l, s_l)
//
// A statement proves that the backing of every note it spends or creates is
// an entry of the scope whose root it names, and which entry stays private.
// The tree here is what the operator builds from its segment header and
// what a wallet builds from the same public header to make its scope paths;
// the used leaves are a prefix, so it is computed level by level over that
// prefix and empty subtrees stand in for the rest.

import { compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { isField, limbsOf, requireField } from "./field.js";
import { T_SCOPE_LEAF, T_SCOPE_NODE } from "./notes.js";
import { poseidon2Hash } from "./poseidon2.js";

export const SCOPE_DEPTH = 16;
/** 2^16 entries: the bound the configuration fixes (§2, §13). */
export const SCOPE_CAPACITY = 1 << SCOPE_DEPTH;

export interface ScopeEntry {
  /** The backing's name. */
  readonly backing: Uint8Array;
  /** The identity of the backing's current link in its witnessed replacement chain (§5). */
  readonly link: Uint8Array;
}

export function isScopeEntry(entry: unknown): entry is ScopeEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return e["backing"] instanceof Uint8Array && e["backing"].length === 32 &&
    e["link"] instanceof Uint8Array && e["link"].length === 32;
}

export function copyScopeEntry(entry: ScopeEntry): ScopeEntry {
  if (!isScopeEntry(entry)) throw new EncodingError("malformed scope entry");
  return Object.freeze({ backing: copyBytes(entry.backing), link: copyBytes(entry.link) });
}

/**
 * Whether `entries` is a canonical scope: between 1 and 2^16 well-formed
 * entries, strictly ascending by backing name. By index rather than
 * `every`, since a sparse array's holes are skipped by `every`.
 */
export function isCanonicalScope(entries: unknown): entries is readonly ScopeEntry[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > SCOPE_CAPACITY) return false;
  for (let i = 0; i < entries.length; i++) {
    if (!isScopeEntry(entries[i])) return false;
    if (i > 0 && compareBytes((entries[i - 1] as ScopeEntry).backing, (entries[i] as ScopeEntry).backing) >= 0) return false;
  }
  return true;
}

/** A canonical scope as fresh, frozen copies; throws EncodingError on anything else. */
export function requireScope(entries: readonly ScopeEntry[]): readonly ScopeEntry[] {
  if (!isCanonicalScope(entries)) {
    throw new EncodingError("a scope is 1 to 65536 entries, strictly ascending by backing name");
  }
  return Object.freeze(entries.map(copyScopeEntry));
}

/** leaf(backing, link) = H(T_SCOPE_LEAF, backingHi, backingLo, linkHi, linkLo), nonzero. */
export function scopeLeaf(entry: ScopeEntry): bigint {
  if (!isScopeEntry(entry)) throw new EncodingError("malformed scope entry");
  const [backingHi, backingLo] = limbsOf(entry.backing);
  const [linkHi, linkLo] = limbsOf(entry.link);
  const leaf = poseidon2Hash([T_SCOPE_LEAF, backingHi, backingLo, linkHi, linkLo]);
  if (leaf === 0n) throw new EncodingError("scope leaf must be nonzero");
  return leaf;
}

/** snode(l, left, right) = H(T_SCOPE_NODE, l, left, right), l the children's level. */
export function scopeNode(level: number, left: bigint, right: bigint): bigint {
  if (!Number.isInteger(level) || level < 0 || level >= SCOPE_DEPTH) {
    throw new EncodingError("scope-tree level out of range");
  }
  return poseidon2Hash([T_SCOPE_NODE, BigInt(level), requireField(left, "left child"), requireField(right, "right child")]);
}

/** s_0 … s_16: the empty subtree whose top is at each level. */
export const EMPTY_SCOPE_SUBTREE: readonly bigint[] = (() => {
  const zeros = [0n];
  for (let level = 0; level < SCOPE_DEPTH; level++) {
    zeros.push(scopeNode(level, zeros[level] as bigint, zeros[level] as bigint));
  }
  return Object.freeze(zeros);
})();

/** 16 siblings, one per level from 0 to 15, and 16 direction bits, true where the path node is the right child. */
export interface ScopePath {
  readonly siblings: readonly bigint[];
  readonly right: readonly boolean[];
}

export function isScopePath(path: unknown): path is ScopePath {
  if (typeof path !== "object" || path === null) return false;
  const p = path as Record<string, unknown>;
  const siblings = p["siblings"];
  const right = p["right"];
  if (!Array.isArray(siblings) || siblings.length !== SCOPE_DEPTH) return false;
  if (!Array.isArray(right) || right.length !== SCOPE_DEPTH) return false;
  for (let level = 0; level < SCOPE_DEPTH; level++) {
    if (!isField(siblings[level]) || typeof right[level] !== "boolean") return false;
  }
  return true;
}

/** The root a leaf and its path carry, computed as the circuit computes it. */
export function scopeRootOf(leaf: bigint, path: ScopePath): bigint {
  if (!isScopePath(path)) throw new EncodingError("malformed scope path");
  let node = requireField(leaf, "leaf");
  for (let level = 0; level < SCOPE_DEPTH; level++) {
    const sibling = path.siblings[level] as bigint;
    node = path.right[level] ? scopeNode(level, sibling, node) : scopeNode(level, node, sibling);
  }
  return node;
}

/** Whether a path carries `leaf` to `root`. A verifier: never throws. */
export function scopePathProves(root: bigint, leaf: bigint, path: ScopePath): boolean {
  try {
    return scopeRootOf(leaf, path) === root;
  } catch {
    return false;
  }
}

/**
 * A canonical scope with its tree built once: the root every statement of
 * the segment names, and the path each entry proves membership by.
 */
export class ScopeTree {
  private readonly list: readonly ScopeEntry[];
  /** levels[l][i] is the node at level l over the used prefix; absent nodes are s_l. */
  private readonly levels: readonly (readonly bigint[])[];
  private readonly positions = new Map<string, number>();

  constructor(entries: readonly ScopeEntry[]) {
    this.list = requireScope(entries);
    const levels: bigint[][] = [this.list.map(scopeLeaf)];
    for (let level = 0; level < SCOPE_DEPTH; level++) {
      const below = levels[level] as bigint[];
      const above: bigint[] = [];
      for (let i = 0; i < below.length; i += 2) {
        above.push(scopeNode(level, below[i] as bigint, below[i + 1] ?? (EMPTY_SCOPE_SUBTREE[level] as bigint)));
      }
      levels.push(above);
    }
    this.levels = levels;
    this.list.forEach((entry, i) => this.positions.set(hex(entry.backing), i));
  }

  /** How many entries the scope has. */
  get size(): number {
    return this.list.length;
  }

  /** The entries in sorted order, as copies. */
  entries(): ScopeEntry[] {
    return this.list.map(copyScopeEntry);
  }

  /** scopeRoot (§5). */
  root(): bigint {
    return (this.levels[SCOPE_DEPTH] as readonly bigint[])[0] as bigint;
  }

  /** The leaf position of a backing, or undefined where it is not in scope. */
  indexOf(backing: Uint8Array): number | undefined {
    return backing instanceof Uint8Array && backing.length === 32 ? this.positions.get(hex(backing)) : undefined;
  }

  has(backing: Uint8Array): boolean {
    return this.indexOf(backing) !== undefined;
  }

  /** The entry for a backing, as a copy, or undefined. */
  entry(backing: Uint8Array): ScopeEntry | undefined {
    const index = this.indexOf(backing);
    return index === undefined ? undefined : copyScopeEntry(this.list[index] as ScopeEntry);
  }

  /** The path for the entry at a position, against the root. */
  path(index: number): ScopePath {
    if (!Number.isInteger(index) || index < 0 || index >= this.list.length) {
      throw new EncodingError("no scope entry at that position");
    }
    const siblings: bigint[] = [];
    const right: boolean[] = [];
    let i = index;
    for (let level = 0; level < SCOPE_DEPTH; level++) {
      const isRight = i % 2 === 1;
      siblings.push((this.levels[level] as readonly bigint[])[isRight ? i - 1 : i + 1] ?? (EMPTY_SCOPE_SUBTREE[level] as bigint));
      right.push(isRight);
      i = Math.floor(i / 2);
    }
    return Object.freeze({ siblings: Object.freeze(siblings), right: Object.freeze(right) });
  }

  /** The path for a backing's entry, or undefined where it is not in scope. */
  pathFor(backing: Uint8Array): ScopePath | undefined {
    const index = this.indexOf(backing);
    return index === undefined ? undefined : this.path(index);
  }
}

/** scopeRoot of a canonical scope, for a caller that needs the root alone. */
export function scopeRoot(entries: readonly ScopeEntry[]): bigint {
  return new ScopeTree(entries).root();
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
