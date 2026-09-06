import { describe, expect, it } from "vitest";
import { EncodingError } from "../src/bytes.js";
import { limbsOf } from "../src/pool/field.js";
import { T_SCOPE_LEAF, T_SCOPE_NODE } from "../src/pool/notes.js";
import { poseidon2Hash } from "../src/pool/poseidon2.js";
import {
  EMPTY_SCOPE_SUBTREE,
  isCanonicalScope,
  isScopePath,
  requireScope,
  SCOPE_CAPACITY,
  SCOPE_DEPTH,
  scopeLeaf,
  scopeNode,
  scopePathProves,
  scopeRoot,
  scopeRootOf,
  ScopeTree,
  type ScopeEntry,
} from "../src/pool/scope.js";

// pool-v2 §5: the scope is a sorted set of (backing, link) entries, authenticated
// by a depth-16 tree over H with its own leaf and node tags; a statement proves
// membership of each hidden backing by a scope path, and which entry stays private.

const name = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const entry = (backing: number, link = backing + 0x40): ScopeEntry => ({ backing: name(backing), link: name(link) });

describe("pool-v2 §5: the scope's leaves, nodes and root", () => {
  it("hashes a leaf as H(T_SCOPE_LEAF, backing limbs, link limbs) and a node as H(T_SCOPE_NODE, level, left, right)", () => {
    const e = entry(3, 9);
    expect(scopeLeaf(e)).toBe(poseidon2Hash([T_SCOPE_LEAF, ...limbsOf(e.backing), ...limbsOf(e.link)]));
    expect(scopeLeaf(entry(3, 10))).not.toBe(scopeLeaf(e));
    expect(scopeNode(0, 1n, 2n)).toBe(poseidon2Hash([T_SCOPE_NODE, 0n, 1n, 2n]));
    expect(scopeNode(15, 1n, 2n)).not.toBe(scopeNode(14, 1n, 2n));
    expect(() => scopeNode(16, 1n, 2n)).toThrow(EncodingError);
    expect(EMPTY_SCOPE_SUBTREE).toHaveLength(SCOPE_DEPTH + 1);
    expect(EMPTY_SCOPE_SUBTREE[0]).toBe(0n);
    expect(EMPTY_SCOPE_SUBTREE[1]).toBe(scopeNode(0, 0n, 0n));
    expect(SCOPE_CAPACITY).toBe(65536);
  });

  it("roots one, two and three entries as the manual computation over the used prefix", () => {
    const [a, b, c] = [entry(1), entry(2), entry(3)];
    const z = EMPTY_SCOPE_SUBTREE;
    const up = (level: number, nodes: bigint[]): bigint[] => {
      const out: bigint[] = [];
      for (let i = 0; i < nodes.length; i += 2) out.push(scopeNode(level, nodes[i] as bigint, nodes[i + 1] ?? (z[level] as bigint)));
      return out;
    };
    const manual = (entries: ScopeEntry[]): bigint => {
      let level = entries.map(scopeLeaf);
      for (let l = 0; l < SCOPE_DEPTH; l++) level = up(l, level);
      return level[0] as bigint;
    };
    expect(scopeRoot([a])).toBe(manual([a]));
    expect(scopeRoot([a, b])).toBe(manual([a, b]));
    expect(scopeRoot([a, b, c])).toBe(manual([a, b, c]));
    expect(scopeRoot([a, b])).not.toBe(scopeRoot([a, c]));
    expect(scopeRoot([a])).not.toBe(scopeRoot([b]));
    // The same backings under other links are another scope.
    expect(scopeRoot([entry(1, 0x99), b])).not.toBe(scopeRoot([a, b]));
  });

  it("gives each entry a path that proves against the root and against no other leaf, entry or root", () => {
    const entries = [entry(1), entry(2), entry(3), entry(4), entry(5)];
    const tree = new ScopeTree(entries);
    expect(tree.size).toBe(5);
    entries.forEach((e, i) => {
      expect(tree.indexOf(e.backing)).toBe(i);
      expect(tree.has(e.backing)).toBe(true);
      expect(tree.entry(e.backing)).toEqual(e);
      const path = tree.path(i);
      expect(isScopePath(path)).toBe(true);
      expect(scopeRootOf(scopeLeaf(e), path)).toBe(tree.root());
      expect(scopePathProves(tree.root(), scopeLeaf(e), path)).toBe(true);
      expect(tree.pathFor(e.backing)).toEqual(path);
      // Under another link, another root, or at another entry's path, the proof fails.
      expect(scopePathProves(tree.root(), scopeLeaf({ ...e, link: name(0x77) }), path)).toBe(false);
      expect(scopePathProves(tree.root() + 1n, scopeLeaf(e), path)).toBe(false);
      expect(scopePathProves(tree.root(), scopeLeaf(e), tree.path((i + 1) % 5))).toBe(false);
      expect(scopePathProves(tree.root(), scopeLeaf(entry(9)), path)).toBe(false);
    });
    expect(tree.has(name(9))).toBe(false);
    expect(tree.pathFor(name(9))).toBeUndefined();
    expect(tree.entry(name(9))).toBeUndefined();
    expect(() => tree.path(5)).toThrow(EncodingError);
    expect(() => tree.path(-1)).toThrow(EncodingError);
    expect(scopePathProves(tree.root(), scopeLeaf(entries[0] as ScopeEntry), { siblings: [1n], right: [true] } as never)).toBe(false);
    // A direction bit flipped at the top level is another root.
    const path = tree.path(0);
    expect(scopePathProves(tree.root(), scopeLeaf(entries[0] as ScopeEntry), { siblings: path.siblings, right: path.right.map((r, l) => (l === 15 ? !r : r)) })).toBe(false);
  });

  it("is canonical only when sorted strictly by backing, between one and 2^16 entries, each well-formed", () => {
    expect(isCanonicalScope([entry(1), entry(2)])).toBe(true);
    expect(isCanonicalScope([entry(2), entry(1)])).toBe(false);
    expect(isCanonicalScope([entry(1), entry(1, 0x50)])).toBe(false);
    expect(isCanonicalScope([])).toBe(false);
    expect(isCanonicalScope([{ backing: new Uint8Array(31), link: name(1) }])).toBe(false);
    expect(isCanonicalScope([{ backing: name(1), link: new Uint8Array(33) }])).toBe(false);
    expect(isCanonicalScope([null])).toBe(false);
    expect(isCanonicalScope("scope")).toBe(false);
    const holey = [entry(1), entry(2)];
    delete holey[1];
    expect(isCanonicalScope(holey)).toBe(false);
    expect(() => new ScopeTree([entry(2), entry(1)])).toThrow(EncodingError);
    expect(() => requireScope([])).toThrow(EncodingError);
    // 2^16 entries are a scope; one more is not.
    const many: ScopeEntry[] = [];
    for (let i = 0; i <= SCOPE_CAPACITY; i++) {
      const backing = new Uint8Array(32);
      backing[29] = (i >> 16) & 0xff;
      backing[30] = (i >> 8) & 0xff;
      backing[31] = i & 0xff;
      many.push({ backing, link: backing });
    }
    expect(isCanonicalScope(many.slice(0, SCOPE_CAPACITY))).toBe(true);
    expect(isCanonicalScope(many)).toBe(false);
    // Copies own their bytes.
    const original = entry(1);
    const copied = requireScope([original]);
    original.backing[0] = 0xff;
    expect((copied[0] as ScopeEntry).backing[0]).toBe(1);
    expect(new ScopeTree([entry(1)]).entries()).toEqual([entry(1)]);
  });
});
