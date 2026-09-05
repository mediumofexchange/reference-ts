// The spent set (pool-v1 §8; invariant 23): a sparse Merkle tree of height
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
// ascending height. A map clear for a sibling equal to e_h, or set for one
// that is not, is malformed, so one set of siblings has one encoding.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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

/** e_0 … e_256: the empty subtree of each height. */
export const EMPTY_SPENT_SUBTREE: readonly Uint8Array[] = (() => {
  const empty: Uint8Array[] = [new Uint8Array(HASH_LENGTH)];
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    empty.push(spentNode(empty[height] as Uint8Array, empty[height] as Uint8Array));
  }
  return Object.freeze(empty);
})();

/** The empty set's root, every pool's spentRoot_0. */
export const EMPTY_SPENT_ROOT = EMPTY_SPENT_SUBTREE[SPENT_SET_HEIGHT] as Uint8Array;

function keyOf(nullifier: Uint8Array): bigint {
  let key = 0n;
  for (const b of requireKey(nullifier)) key = (key << 8n) | BigInt(b);
  return key;
}

/** The root reached from `leaf` at `key` through 256 siblings. */
function rootFrom(key: bigint, leaf: Uint8Array, siblings: readonly Uint8Array[]): Uint8Array {
  let node = leaf;
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    const sibling = siblings[height] as Uint8Array;
    node = ((key >> BigInt(height)) & 1n) === 1n ? spentNode(sibling, node) : spentNode(node, sibling);
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
    if (compareBytes(sibling, EMPTY_SPENT_SUBTREE[height] as Uint8Array) === 0) {
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

/** Strict inverse of encodeSpentProof. Throws EncodingError where map and siblings disagree. */
export function decodeSpentProof(proof: Uint8Array): Uint8Array[] {
  if (!(proof instanceof Uint8Array) || proof.length < HASH_LENGTH || proof.length % HASH_LENGTH !== 0) {
    throw new EncodingError("malformed spent-set proof");
  }
  const siblings: Uint8Array[] = [];
  let offset = HASH_LENGTH;
  for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
    const omitted = ((proof[height >> 3] as number) >> (7 - (height & 7))) & 1;
    if (omitted === 1) {
      siblings.push(EMPTY_SPENT_SUBTREE[height] as Uint8Array);
      continue;
    }
    if (offset + HASH_LENGTH > proof.length) throw new EncodingError("spent-set proof is missing siblings");
    const sibling = copyBytes(proof.subarray(offset, offset + HASH_LENGTH));
    if (compareBytes(sibling, EMPTY_SPENT_SUBTREE[height] as Uint8Array) === 0) {
      throw new EncodingError("spent-set proof sends a sibling its map should omit");
    }
    siblings.push(sibling);
    offset += HASH_LENGTH;
  }
  if (offset !== proof.length) throw new EncodingError("spent-set proof has trailing bytes");
  return siblings;
}

/**
 * Whether `proof` carries the nullifier's leaf (`member`) or the empty leaf
 * (not `member`) at the nullifier's key to `root`. A verifier: never throws.
 */
export function spentProofProves(root: Uint8Array, nullifier: Uint8Array, proof: Uint8Array, member: boolean): boolean {
  try {
    const siblings = decodeSpentProof(proof);
    const leaf = member ? spentLeaf(nullifier) : (EMPTY_SPENT_SUBTREE[0] as Uint8Array);
    return compareBytes(rootFrom(keyOf(nullifier), leaf, siblings), root) === 0;
  } catch {
    return false;
  }
}

export class SpentSet {
  /** Nodes above the leaves, keyed `${height}:${index}`; absent means empty. */
  private readonly nodes = new Map<string, Uint8Array>();
  private readonly members = new Set<string>();

  get size(): bigint {
    return BigInt(this.members.size);
  }

  root(): Uint8Array {
    return copyBytes(this.node(SPENT_SET_HEIGHT, 0n));
  }

  has(nullifier: Uint8Array): boolean {
    return this.members.has(bytesToHex(requireKey(nullifier)));
  }

  /** Insert one nullifier, recomputing the 256 nodes on its path. */
  insert(nullifier: Uint8Array): void {
    const hex = bytesToHex(requireKey(nullifier));
    if (this.members.has(hex)) throw new EncodingError("nullifier already in the spent set");
    this.members.add(hex);
    const key = keyOf(nullifier);
    let node = spentLeaf(nullifier);
    this.nodes.set(`0:${key.toString(16)}`, node);
    for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
      const index = key >> BigInt(height);
      const sibling = this.node(height, index ^ 1n);
      node = (index & 1n) === 1n ? spentNode(sibling, node) : spentNode(node, sibling);
      this.nodes.set(`${height + 1}:${(index >> 1n).toString(16)}`, node);
    }
  }

  /** The encoded proof for a key, whether or not it is a member. */
  proof(nullifier: Uint8Array): Uint8Array {
    const key = keyOf(nullifier);
    const siblings: Uint8Array[] = [];
    for (let height = 0; height < SPENT_SET_HEIGHT; height++) {
      siblings.push(this.node(height, (key >> BigInt(height)) ^ 1n));
    }
    return encodeSpentProof(siblings);
  }

  private node(height: number, index: bigint): Uint8Array {
    return this.nodes.get(`${height}:${index.toString(16)}`) ?? (EMPTY_SPENT_SUBTREE[height] as Uint8Array);
  }
}
