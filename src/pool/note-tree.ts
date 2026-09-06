// The pool's note tree (pool-v1 §4): a binary Merkle tree of depth 32 over H,
// append-only. Leaf i is the commitment of the i-th output accepted in the
// pool, counting from zero across every statement in acceptance order; an
// unused leaf is the field element 0. A node is hashed with the level of its
// children, 0 for two leaves and 31 for the root's children:
//
//   node(l, left, right) = H(T_NODE, l, left, right)
//   z_0 = 0,  z_{l+1} = node(l, z_l, z_l)
//
// An anchor is the root after any accepted statement, or z_32 before the
// first. The tree holds 2^32 leaves; a statement whose outputs would not fit
// is refused before it changes state, and there is no pruning or rollover
// under one pool identity.
//
// A wallet syncs the full leaf list and builds its own paths with this same
// class; it never asks a server for one leaf's path or index (§C1.5). So the
// tree here is both the operator's accumulator and the wallet's, and it
// stores every node on every leaf's path rather than only a frontier: paths
// for arbitrary leaves are what a wallet needs, and the reference
// implementation prefers one structure with an obvious proof of correctness.
// `appendAll` builds a synced list with about two hashes per leaf; at the
// host hash's cost (about a millisecond) a million leaves is minutes, and a
// faster field arithmetic or the backend's hash behind the same interface
// is the remedy when a deployment needs more.

import { EncodingError } from "../bytes.js";
import { isField, requireField } from "./field.js";
import { T_NODE } from "./notes.js";
import { poseidon2Hash } from "./poseidon2.js";

export const NOTE_TREE_DEPTH = 32;
export const NOTE_TREE_CAPACITY = 1n << 32n;

/** node(l, left, right) = H(T_NODE, l, left, right), l the children's level. */
export function noteNode(level: number, left: bigint, right: bigint): bigint {
  if (!Number.isInteger(level) || level < 0 || level >= NOTE_TREE_DEPTH) {
    throw new EncodingError("note-tree level out of range");
  }
  return poseidon2Hash([T_NODE, BigInt(level), requireField(left, "left child"), requireField(right, "right child")]);
}

/** z_0 … z_32: the empty subtree whose top is at each level. */
export const EMPTY_NOTE_SUBTREE: readonly bigint[] = (() => {
  const zeros = [0n];
  for (let level = 0; level < NOTE_TREE_DEPTH; level++) {
    zeros.push(noteNode(level, zeros[level] as bigint, zeros[level] as bigint));
  }
  return Object.freeze(zeros);
})();

/** The empty tree's root, the first anchor of every pool. */
export const EMPTY_NOTE_ROOT = EMPTY_NOTE_SUBTREE[NOTE_TREE_DEPTH] as bigint;

/** 32 siblings, one per level from 0 to 31, and 32 direction bits, true where the path node is the right child. */
export interface NotePath {
  readonly siblings: readonly bigint[];
  readonly right: readonly boolean[];
}

export function isNotePath(path: unknown): path is NotePath {
  if (typeof path !== "object" || path === null) return false;
  const p = path as Record<string, unknown>;
  const siblings = p["siblings"];
  const right = p["right"];
  if (!Array.isArray(siblings) || siblings.length !== NOTE_TREE_DEPTH) return false;
  if (!Array.isArray(right) || right.length !== NOTE_TREE_DEPTH) return false;
  // By index, not `every`: a sparse array's holes are skipped by `every`,
  // and a hole is neither a field element nor a boolean.
  for (let level = 0; level < NOTE_TREE_DEPTH; level++) {
    if (!isField(siblings[level]) || typeof right[level] !== "boolean") return false;
  }
  return true;
}

export function copyNotePath(path: NotePath): NotePath {
  if (!isNotePath(path)) throw new EncodingError("malformed note path");
  return Object.freeze({ siblings: Object.freeze([...path.siblings]), right: Object.freeze([...path.right]) });
}

/** The root a leaf and its path carry, computed as the circuit computes it. */
export function noteRootOf(leaf: bigint, path: NotePath): bigint {
  if (!isNotePath(path)) throw new EncodingError("malformed note path");
  let node = requireField(leaf, "leaf");
  for (let level = 0; level < NOTE_TREE_DEPTH; level++) {
    const sibling = path.siblings[level] as bigint;
    node = path.right[level] ? noteNode(level, sibling, node) : noteNode(level, node, sibling);
  }
  return node;
}

/** Whether a path carries `leaf` to `anchor`. A verifier: never throws. */
export function notePathProves(anchor: bigint, leaf: bigint, path: NotePath): boolean {
  try {
    return noteRootOf(leaf, path) === anchor;
  } catch {
    return false;
  }
}

export class NoteTree {
  private readonly leafList: bigint[] = [];
  private readonly present = new Set<bigint>();
  /** Nodes above the leaves, keyed `${level}:${index}`; absent means empty. */
  private readonly nodes = new Map<string, bigint>();

  /** How many leaves are in use. */
  get size(): bigint {
    return BigInt(this.leafList.length);
  }

  root(): bigint {
    return this.node(NOTE_TREE_DEPTH, 0);
  }

  has(commitment: bigint): boolean {
    return this.present.has(commitment);
  }

  /** The leaf at a position, or undefined past the used leaves. */
  leaf(position: bigint): bigint | undefined {
    if (typeof position !== "bigint" || position < 0n || position >= this.size) return undefined;
    return this.leafList[Number(position)];
  }

  /** Every used leaf, in order: what a wallet syncs. */
  leaves(): readonly bigint[] {
    return [...this.leafList];
  }

  /**
   * Append one commitment and return its position. Refuses a non-field, the
   * zero leaf (an unused leaf's value), a commitment already present, and a
   * full tree; admission has checked all four before it gets here, so each is
   * a programming error surfaced rather than a state the tree can reach.
   */
  append(commitment: bigint): bigint {
    return this.appendAll([commitment])[0] as bigint;
  }

  /**
   * Append commitments in order and return their positions, hashing each
   * changed node once rather than 32 per leaf: what a wallet syncing the
   * pool's leaf list calls, and what admission calls with a statement's one
   * or two outputs. All or nothing: the checks run before any change.
   */
  appendAll(commitments: readonly bigint[]): bigint[] {
    const fresh = new Set<bigint>();
    for (const commitment of commitments) {
      requireField(commitment, "commitment");
      if (commitment === 0n) throw new EncodingError("a zero commitment is an unused leaf");
      if (this.present.has(commitment) || fresh.has(commitment)) throw new EncodingError("commitment already in the note tree");
      fresh.add(commitment);
    }
    if (this.size + BigInt(commitments.length) > NOTE_TREE_CAPACITY) throw new EncodingError("note tree is full");
    if (commitments.length === 0) return [];
    const first = this.leafList.length;
    for (const commitment of commitments) {
      this.leafList.push(commitment);
      this.present.add(commitment);
    }
    // Recompute every node whose subtree changed: at each level, the parents
    // of the changed range, which is the range's halving up to the root.
    let low = first;
    let high = this.leafList.length - 1;
    for (let level = 0; level < NOTE_TREE_DEPTH; level++) {
      const parentLow = Math.floor(low / 2);
      const parentHigh = Math.floor(high / 2);
      for (let index = parentLow; index <= parentHigh; index++) {
        this.nodes.set(`${level + 1}:${index}`, noteNode(level, this.node(level, 2 * index), this.node(level, 2 * index + 1)));
      }
      low = parentLow;
      high = parentHigh;
    }
    return commitments.map((_, i) => BigInt(first + i));
  }

  /** The path for a used leaf, against the current root. */
  path(position: bigint): NotePath {
    if (typeof position !== "bigint" || position < 0n || position >= this.size) {
      throw new EncodingError("no leaf at that position");
    }
    const siblings: bigint[] = [];
    const right: boolean[] = [];
    let index = Number(position);
    for (let level = 0; level < NOTE_TREE_DEPTH; level++) {
      const isRight = index % 2 === 1;
      siblings.push(this.node(level, isRight ? index - 1 : index + 1));
      right.push(isRight);
      index = Math.floor(index / 2);
    }
    return Object.freeze({ siblings: Object.freeze(siblings), right: Object.freeze(right) });
  }

  private node(level: number, index: number): bigint {
    if (level === 0) return this.leafList[index] ?? 0n;
    return this.nodes.get(`${level}:${index}`) ?? (EMPTY_NOTE_SUBTREE[level] as bigint);
  }
}
