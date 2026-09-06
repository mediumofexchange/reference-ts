// The spent set (pool-v2 §11; invariant 23): a sparse Merkle tree of height
// 256 over SHA-256, keyed by the nullifier's 32 big-endian bytes, so that
// both membership and non-membership are provable in the clear against
// `spentRoot`. Construction §C2b.3's snapshot redemption reads a holder's
// non-membership proof at the last witnessed commitment's spent root.
//
//   leaf(nf)          = SHA256("moe/pool/v1/spent/leaf" ‖ nf)      nf in the set
//   e_0               = 0[32]                                        the empty leaf
//   node(left, right) = SHA256("moe/pool/v1/spent/node" ‖ left ‖ right)
//   e_{h+1}           = node(e_h, e_h)
//
// Key bits are numbered from the most significant as bit 0. At height h,
// counting 0 at the leaf, the node on a key's path is the right child of its
// parent when bit 255 − h of the key is 1: the root's children are told
// apart by the most significant bit and the leaf's parent by the least. In
// integer terms the node at height h has index key >> h, its sibling has
// index (key >> h) ^ 1, and it is the right child when that index is odd.
//
// A proof is the 256 siblings, sent as a 32-byte map followed by the
// siblings not omitted: bit h of the map (numbered as the key's bits are,
// from the most significant) is 1 exactly when the sibling at height h
// equals e_h, and those siblings are omitted; every other sibling is sent in
// ascending height. A map clear for a sibling equal to e_h is malformed, so
// one set of siblings has one encoding.
//
// The set is stored as a trie of the keys, not as 256 nodes per key: a
// subtree holding one key is a leaf whose hash at any height is the chain
// of that key's path through empty siblings, computed when needed and
// cached at the height the leaf sits at; a subtree holding two or more keys
// is a branch with a cached hash. So the memory is a few objects per key,
// and an insertion rehashes the branches on one path plus at most one
// displaced leaf's chain. Replay (§7) rebuilds the same structure.

import { sha256 } from "@noble/hashes/sha2.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "../bytes.js";
import { POOL_SPENT_LEAF_CONTEXT, POOL_SPENT_NODE_CONTEXT } from "../contexts.js";

export const SPENT_SET_HEIGHT = 256;
const HASH_LENGTH = 32;

function requireKey(nullifier: Uint8Array): Uint8Array {
  if (!(nullifier instanceof Uint8Array) || nullifier.length !== HASH_LENGTH) {
    throw new EncodingError("a spent-set key is 32 bytes");
  }
  return nullifier;
}

export function spentLeaf(nullifier: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_SPENT_LEAF_CONTEXT);
  w.key32(requireKey(nullifier), "nullifier");
  return sha256(w.finish());
}

export function spentNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(POOL_SPENT_NODE_CONTEXT);
  w.key32(left, "left child");
  w.key32(right, "right child");
  return sha256(w.finish());
}

/** e_0 … e_256, private: the module hands out copies and reads only these. */
const EMPTY: readonly Uint8Array[] = (() => {
  const empty: Uint8Array[] = [new Uint8Array(HASH_LENGTH)];
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    empty.push(spentNode(empty[height] as Uint8Array, empty[height] as Uint8Array));
  }
  return Object.freeze(empty);
})();

/** e_0 … e_256: the empty subtree of each height. A copy: bytes cannot be frozen. */
export const EMPTY_SPENT_SUBTREE: readonly Uint8Array[] = Object.freeze(EMPTY.map(copyBytes));

/** The empty set's root, every pool's spentRoot_0. A copy, as above. */
export const EMPTY_SPENT_ROOT = copyBytes(EMPTY[SPENT_SET_HEIGHT] as Uint8Array);

function keyOf(nullifier: Uint8Array): bigint {
  let key = 0n;
  for (const b of requireKey(nullifier)) key = (key << 8n) | BigInt(b);
  return key;
}

/** Whether the node at height `height` on `key`'s path is the right child of its parent. */
function isRight(key: bigint, height: number): boolean {
  return ((key >> BigInt(height)) & 1n) === 1n;
}

/** The hash at `height` of a subtree holding only `key`: its path through empty siblings. */
function chain(key: bigint, leaf: Uint8Array, height: number): Uint8Array {
  let node = leaf;
  for (let h = 0; h < height; h++) {
    const empty = EMPTY[h] as Uint8Array;
    node = isRight(key, h) ? spentNode(empty, node) : spentNode(node, empty);
  }
  return node;
}

/** The root reached from `leaf` at `key` through 256 siblings. */
function rootFrom(key: bigint, leaf: Uint8Array, siblings: readonly Uint8Array[]): Uint8Array {
  let node = leaf;
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    const sibling = siblings[height] as Uint8Array;
    node = isRight(key, height) ? spentNode(sibling, node) : spentNode(node, sibling);
  }
  return node;
}

/** Encode 256 siblings as a map and the siblings the map does not omit. */
export function encodeSpentProof(siblings: readonly Uint8Array[]): Uint8Array {
  if (siblings.length !== SPENT_SET_HEIGHT) throw new EncodingError("a spent-set proof has 256 siblings");
  const map = new Uint8Array(HASH_LENGTH);
  const sent: Uint8Array[] = [];
  siblings.forEach((sibling, height) => {
    if (!(sibling instanceof Uint8Array) || sibling.length !== HASH_LENGTH) {
      throw new EncodingError("a spent-set sibling is 32 bytes");
    }
    if (compareBytes(sibling, EMPTY[height] as Uint8Array) === 0) {
      map[height >> 3] = (map[height >> 3] as number) | (0x80 >> (height & 7));
    } else {
      sent.push(sibling);
    }
  });
  const out = new Uint8Array(HASH_LENGTH + HASH_LENGTH * sent.length);
  out.set(map, 0);
  sent.forEach((sibling, i) => out.set(sibling, HASH_LENGTH * (i + 1)));
  return out;
}

/** Strict inverse of encodeSpentProof, as fresh copies. Throws EncodingError where map and siblings disagree. */
export function decodeSpentProof(proof: Uint8Array): Uint8Array[] {
  if (!(proof instanceof Uint8Array) || proof.length < HASH_LENGTH || proof.length % HASH_LENGTH !== 0) {
    throw new EncodingError("malformed spent-set proof");
  }
  const siblings: Uint8Array[] = [];
  let offset = HASH_LENGTH;
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    const omitted = ((proof[height >> 3] as number) >> (7 - (height & 7))) & 1;
    if (omitted === 1) {
      siblings.push(copyBytes(EMPTY[height] as Uint8Array));
      continue;
    }
    if (offset + HASH_LENGTH > proof.length) throw new EncodingError("spent-set proof is missing siblings");
    const sibling = copyBytes(proof.subarray(offset, offset + HASH_LENGTH));
    if (compareBytes(sibling, EMPTY[height] as Uint8Array) === 0) {
      throw new EncodingError("spent-set proof sends a sibling its map should omit");
    }
    siblings.push(sibling);
    offset += HASH_LENGTH;
  }
  if (offset !== proof.length) throw new EncodingError("spent-set proof has trailing bytes");
  return siblings;
}

/**
 * Whether `proof` carries the nullifier's leaf (`member` true) or the empty
 * leaf (`member` false) at the nullifier's key to `root`. A verifier: never
 * throws, and answers false to anything but a boolean question.
 */
export function spentProofProves(root: Uint8Array, nullifier: Uint8Array, proof: Uint8Array, member: boolean): boolean {
  if (typeof member !== "boolean") return false;
  try {
    const siblings = decodeSpentProof(proof);
    const leaf = member ? spentLeaf(nullifier) : (EMPTY[0] as Uint8Array);
    return compareBytes(rootFrom(keyOf(nullifier), leaf, siblings), root) === 0;
  } catch {
    return false;
  }
}

/** A subtree holding one key, with its hash cached at the height it last sat at. */
interface Leaf {
  readonly kind: "leaf";
  readonly key: bigint;
  readonly leaf: Uint8Array;
  height: number;
  hash: Uint8Array;
}

/** A subtree holding two or more keys. Its height is its depth below the root. */
interface Branch {
  readonly kind: "branch";
  left: Trie;
  right: Trie;
  hash: Uint8Array;
}

type Trie = Leaf | Branch | undefined;

function hashOf(node: Trie, height: number): Uint8Array {
  if (node === undefined) return EMPTY[height] as Uint8Array;
  if (node.kind === "branch") return node.hash;
  if (node.height !== height) {
    node.hash = chain(node.key, node.leaf, height);
    node.height = height;
  }
  return node.hash;
}

export class SpentSet {
  private trie: Trie = undefined;
  private count = 0n;

  get size(): bigint {
    return this.count;
  }

  root(): Uint8Array {
    return copyBytes(hashOf(this.trie, SPENT_SET_HEIGHT));
  }

  has(nullifier: Uint8Array): boolean {
    return this.find(keyOf(nullifier)).node?.key === keyOf(nullifier);
  }

  /** Insert one nullifier, rehashing the branches on its path. */
  insert(nullifier: Uint8Array): void {
    const key = keyOf(nullifier);
    if (this.has(nullifier)) throw new EncodingError("nullifier already in the spent set");
    this.trie = insertInto(this.trie, SPENT_SET_HEIGHT, key, spentLeaf(nullifier));
    this.count += 1n;
  }

  /** The encoded proof for a key, whether or not it is a member. */
  proof(nullifier: Uint8Array): Uint8Array {
    const key = keyOf(nullifier);
    const siblings: Uint8Array[] = [];
    for (let h = 0; h < SPENT_SET_HEIGHT; h++) siblings.push(EMPTY[h] as Uint8Array);
    const { node, height, path } = this.find(key);
    path.forEach(({ sibling, height: h }) => {
      siblings[h] = hashOf(sibling, h);
    });
    if (node !== undefined && node.key !== key) {
      // The subtree at `height` holds one other key: the two paths share it
      // down to the highest bit where they differ, and there that key's
      // chain is the sibling; everywhere else below, the sibling is empty.
      let d = height - 1;
      while (d >= 0 && isRight(key, d) === isRight(node.key, d)) d--;
      siblings[d] = chain(node.key, node.leaf, d);
    }
    return encodeSpentProof(siblings);
  }

  /**
   * Walk `key`'s path from the root to the leaf or empty subtree that ends
   * it, recording each branch's sibling on the way. `height` is the height
   * of the subtree the walk stopped at.
   */
  private find(key: bigint): { node: Leaf | undefined; height: number; path: { sibling: Trie; height: number }[] } {
    const path: { sibling: Trie; height: number }[] = [];
    let node: Trie = this.trie;
    let height = SPENT_SET_HEIGHT;
    while (node !== undefined && node.kind === "branch") {
      const right = isRight(key, height - 1);
      path.push({ sibling: right ? node.left : node.right, height: height - 1 });
      node = right ? node.right : node.left;
      height -= 1;
    }
    return { node, height, path };
  }
}

/** Place `key` into the subtree `node` of height `height`, returning the subtree. */
function insertInto(node: Trie, height: number, key: bigint, leaf: Uint8Array): Trie {
  if (node === undefined) return { kind: "leaf", key, leaf, height: 0, hash: leaf };
  if (node.kind === "leaf") {
    // Two keys in one subtree: a branch, with the resident key placed on its
    // side and the new key inserted below.
    const branch: Branch = { kind: "branch", left: undefined, right: undefined, hash: EMPTY[height] as Uint8Array };
    if (isRight(node.key, height - 1)) branch.right = node;
    else branch.left = node;
    return insertInto(branch, height, key, leaf);
  }
  if (isRight(key, height - 1)) node.right = insertInto(node.right, height - 1, key, leaf);
  else node.left = insertInto(node.left, height - 1, key, leaf);
  node.hash = spentNode(hashOf(node.left, height - 1), hashOf(node.right, height - 1));
  return node;
}
