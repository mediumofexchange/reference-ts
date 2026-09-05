import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import {
  copyNotePath,
  EMPTY_NOTE_ROOT,
  EMPTY_NOTE_SUBTREE,
  NOTE_TREE_DEPTH,
  noteNode,
  notePathProves,
  noteRootOf,
  NoteTree,
} from "../src/pool/note-tree.js";
import { T_NODE } from "../src/pool/notes.js";
import { poseidon2Hash } from "../src/pool/poseidon2.js";

// pool-v1 §4: a depth-32 append-only tree over H, nodes tagged with their
// children's level, unused leaves zero, anchors the roots after statements.

/** The root of `leaves` computed the slow way: fold every level with empty padding. */
function slowRoot(leaves: readonly bigint[]): bigint {
  let level = [...leaves];
  for (let l = 0; l < NOTE_TREE_DEPTH; l++) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(noteNode(l, level[i] as bigint, level[i + 1] ?? (EMPTY_NOTE_SUBTREE[l] as bigint)));
    }
    level = next;
  }
  return level[0] ?? EMPTY_NOTE_ROOT;
}

describe("pool-v1 §4: the note tree", () => {
  it("hashes nodes with their children's level and builds the empty subtrees from zero", () => {
    expect(EMPTY_NOTE_SUBTREE[0]).toBe(0n);
    expect(EMPTY_NOTE_SUBTREE).toHaveLength(NOTE_TREE_DEPTH + 1);
    for (let l = 0; l < NOTE_TREE_DEPTH; l++) {
      const z = EMPTY_NOTE_SUBTREE[l] as bigint;
      expect(EMPTY_NOTE_SUBTREE[l + 1]).toBe(poseidon2Hash([T_NODE, BigInt(l), z, z]));
    }
    expect(new NoteTree().root()).toBe(EMPTY_NOTE_ROOT);
    expect(() => noteNode(32, 0n, 0n)).toThrow(EncodingError);
    expect(() => noteNode(-1, 0n, 0n)).toThrow(EncodingError);
  });

  it("appends in order, roots as the slow fold does, and proves each leaf's path", () => {
    const tree = new NoteTree();
    const leaves = [11n, 22n, 33n, 44n, 55n];
    leaves.forEach((leaf, i) => {
      expect(tree.append(leaf)).toBe(BigInt(i));
      expect(tree.root()).toBe(slowRoot(leaves.slice(0, i + 1)));
    });
    expect(tree.size).toBe(5n);
    expect(tree.leaves()).toEqual(leaves);
    for (let i = 0n; i < 5n; i++) {
      const path = tree.path(i);
      expect(path.siblings).toHaveLength(NOTE_TREE_DEPTH);
      expect(path.right).toHaveLength(NOTE_TREE_DEPTH);
      expect(path.right[0]).toBe(i % 2n === 1n);
      expect(noteRootOf(tree.leaf(i) as bigint, path)).toBe(tree.root());
      expect(notePathProves(tree.root(), tree.leaf(i) as bigint, path)).toBe(true);
      expect(notePathProves(tree.root(), tree.leaf(i) as bigint, copyNotePath(path))).toBe(true);
    }
    expect(tree.has(33n)).toBe(true);
    expect(tree.has(66n)).toBe(false);
    expect(tree.leaf(5n)).toBeUndefined();
    expect(tree.leaf(-1n)).toBeUndefined();
  });

  it("an older anchor still proves a leaf against the tree it was computed in, and not against a newer one", () => {
    const tree = new NoteTree();
    tree.append(1n);
    tree.append(2n);
    const olderRoot = tree.root();
    const olderPath = tree.path(0n);
    tree.append(3n);
    expect(notePathProves(olderRoot, 1n, olderPath)).toBe(true);
    expect(notePathProves(tree.root(), 1n, olderPath)).toBe(false);
    expect(notePathProves(tree.root(), 1n, tree.path(0n))).toBe(true);
  });

  it("refuses a tampered sibling, direction, or leaf, and a malformed path", () => {
    const tree = new NoteTree();
    for (const leaf of [7n, 8n, 9n]) tree.append(leaf);
    const path = tree.path(1n);
    const root = tree.root();
    const siblings = [...path.siblings];
    siblings[0] = (siblings[0] as bigint) + 1n;
    expect(notePathProves(root, 8n, { ...path, siblings })).toBe(false);
    const high = [...path.siblings];
    high[31] = 1n;
    expect(notePathProves(root, 8n, { ...path, siblings: high })).toBe(false);
    const right = [...path.right];
    right[0] = !right[0];
    expect(notePathProves(root, 8n, { ...path, right })).toBe(false);
    expect(notePathProves(root, 9n, path)).toBe(false);
    expect(notePathProves(root, 8n, { siblings: path.siblings.slice(1), right: path.right })).toBe(false);
    expect(notePathProves(root, 8n, { siblings: path.siblings, right: path.right.map(() => 1 as unknown as boolean) })).toBe(false);
    expect(notePathProves(root, 8n, null as unknown as never)).toBe(false);
    expect(() => noteRootOf(8n, { siblings: [], right: [] })).toThrow(EncodingError);
    expect(() => copyNotePath({ siblings: [], right: [] })).toThrow(EncodingError);
  });

  it("refuses the zero leaf, a duplicate, and a position that is not in use", () => {
    const tree = new NoteTree();
    expect(() => tree.append(0n)).toThrow(EncodingError);
    tree.append(5n);
    expect(() => tree.append(5n)).toThrow(EncodingError);
    expect(() => tree.append(-5n)).toThrow(EncodingError);
    expect(() => tree.path(1n)).toThrow(EncodingError);
    expect(() => tree.path(-1n)).toThrow(EncodingError);
    expect(() => tree.path(0 as unknown as bigint)).toThrow(EncodingError);
    expect(tree.size).toBe(1n);
  });

  it("hands out copies of its leaves", () => {
    const tree = new NoteTree();
    tree.append(1n);
    const leaves = tree.leaves() as bigint[];
    leaves.push(2n);
    expect(tree.leaves()).toEqual([1n]);
  });
});
