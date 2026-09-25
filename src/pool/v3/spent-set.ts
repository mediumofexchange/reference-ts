// The successor's compressed spent root, pool-spent C1.2.8–9 at 78f8a8c: a
// binary tree of full-key leaves, nonempty children and absolute
// first-differing-bit branches, so one set has one root in any insert order.
import { sha256 } from "@noble/hashes/sha2.js";
import { V3_SPENT_EMPTY_CONTEXT, V3_SPENT_LEAF_CONTEXT as LEAF, V3_SPENT_NODE_CONTEXT as NODE } from "../../contexts.js";

const EMPTY = sha256(V3_SPENT_EMPTY_CONTEXT);
// Intrinsic getters: a subclass or own property cannot misreport a key.
const typed = Object.getPrototypeOf(Uint8Array.prototype) as object;
const getter = (target: object, key: PropertyKey): ((this: unknown) => unknown) =>
  Object.getOwnPropertyDescriptor(target, key)!.get!;
const lengthOf = getter(typed, "length"), brandOf = getter(typed, Symbol.toStringTag),
  bufferOf = getter(typed, "buffer"), bufferLength = getter(ArrayBuffer.prototype, "byteLength");

interface Leaf { readonly key: bigint; readonly hash: Uint8Array; readonly bit?: undefined }
interface Branch { readonly key: bigint; readonly bit: bigint; readonly left: Tree; readonly right: Tree; readonly hash: Uint8Array }
type Tree = Leaf | Branch;

function keyOf(input: unknown): { key: bigint; bytes: Uint8Array } {
  if (brandOf.call(input) !== "Uint8Array" || lengthOf.call(input) !== 32) {
    throw new TypeError("a spent-set key is 32 bytes");
  }
  // Shared storage can race the key/hash snapshot; no shared input is accepted.
  bufferLength.call(bufferOf.call(input));
  const bytes = new Uint8Array(32);
  Uint8Array.prototype.set.call(bytes, input as Uint8Array);
  let key = 0n;
  for (let i = 0; i < 32; i++) key = (key << 8n) | BigInt(bytes[i]!);
  return { key, bytes };
}

const rightAt = (key: bigint, bit: bigint): boolean => ((key >> (255n - bit)) & 1n) === 1n;
const splitAt = (a: bigint, b: bigint): bigint => 256n - BigInt((a ^ b).toString(2).length);

export class RadixSpentSet {
  #tree: Tree | undefined;
  #size = 0n;
  #hashes = 0n;

  get size(): bigint { return this.#size; }
  get hashes(): bigint { return this.#hashes; }
  root(): Uint8Array { return new Uint8Array(this.#tree?.hash ?? EMPTY); }

  /** Insertion replaces paths functionally, so a copy may share every node. */
  fork(): RadixSpentSet {
    const copy = new RadixSpentSet();
    copy.#tree = this.#tree; copy.#size = this.#size; copy.#hashes = this.#hashes;
    return copy;
  }

  has(input: Uint8Array): boolean {
    const { key } = keyOf(input);
    let node = this.#tree;
    while (node?.bit !== undefined) node = rightAt(key, node.bit) ? node.right : node.left;
    return node?.key === key;
  }

  insert(input: Uint8Array): void {
    const { key, bytes } = keyOf(input);
    let terminal = this.#tree;
    while (terminal?.bit !== undefined) {
      terminal = rightAt(key, terminal.bit) ? terminal.right : terminal.left;
    }
    if (terminal?.key === key) throw new Error("nullifier already in the spent set");
    const frame = new Uint8Array(LEAF.length + 32);
    frame.set(LEAF); frame.set(bytes, LEAF.length);
    const leaf: Leaf = { key, hash: sha256(frame) };
    let hashes = 1n;
    const branch = (bit: bigint, left: Tree, right: Tree): Branch => {
      const frame = new Uint8Array(NODE.length + 66);
      frame.set(NODE);
      // bit is derived from 256-bit keys; these checked-width bytes fit u8.
      frame[NODE.length] = Number(bit >> 8n);
      frame[NODE.length + 1] = Number(bit & 255n);
      frame.set(left.hash, NODE.length + 2);
      frame.set(right.hash, NODE.length + 34);
      hashes++;
      return { key: left.key, bit, left, right, hash: sha256(frame) };
    };
    const insert = (node: Tree | undefined): Tree => {
      if (node === undefined) return leaf;
      const bit = node.key === key ? 256n : splitAt(node.key, key);
      if (node.bit === undefined || bit < node.bit) {
        return rightAt(key, bit) ? branch(bit, node, leaf) : branch(bit, leaf, node);
      }
      return rightAt(key, node.bit)
        ? branch(node.bit, node.left, insert(node.right))
        : branch(node.bit, insert(node.left), node.right);
    };
    // Functional path replacement: failure cannot expose a partly changed tree.
    this.#tree = insert(this.#tree);
    this.#size++;
    this.#hashes += hashes;
  }
}
