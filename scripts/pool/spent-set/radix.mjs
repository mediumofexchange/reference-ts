// pool-spent C1.2.8–9 feasibility candidate; no production export or v2 use.
// Contract: money-from-first-principles 78f8a8c. Retire into the v3 runtime
// when its statement/import integration is implemented and independently reviewed.
import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();
const EMPTY = sha256(encoder.encode('moe/pool/v3/spent/empty'));
const LEAF = encoder.encode('moe/pool/v3/spent/leaf');
const NODE = encoder.encode('moe/pool/v3/spent/node');
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typed, 'length').get;
const brandOf = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const bufferOf = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;

function keyOf(input) {
  if (brandOf.call(input) !== 'Uint8Array' || lengthOf.call(input) !== 32) {
    throw new TypeError('a spent-set key is 32 bytes');
  }
  // Shared storage can race the key/hash snapshot; no shared input is accepted.
  bufferLength.call(bufferOf.call(input));
  const bytes = new Uint8Array(32);
  Uint8Array.prototype.set.call(bytes, input);
  let key = 0n;
  for (let i = 0; i < 32; i++) key = (key << 8n) | BigInt(bytes[i]);
  return { key, bytes };
}

const rightAt = (key, bit) => ((key >> (255n - bit)) & 1n) === 1n;
const splitAt = (a, b) => 256n - BigInt((a ^ b).toString(2).length);

export class RadixSpentSet {
  #tree;
  #size = 0n;
  #hashes = 0n;

  get size() { return this.#size; }
  get hashes() { return this.#hashes; }
  root() { return new Uint8Array(this.#tree?.hash ?? EMPTY); }

  has(input) {
    const { key } = keyOf(input);
    let node = this.#tree;
    while (node?.bit !== undefined) node = rightAt(key, node.bit) ? node.right : node.left;
    return node?.key === key;
  }

  insert(input) {
    const { key, bytes } = keyOf(input);
    let terminal = this.#tree;
    while (terminal?.bit !== undefined) {
      terminal = rightAt(key, terminal.bit) ? terminal.right : terminal.left;
    }
    if (terminal?.key === key) throw new Error('nullifier already in the spent set');
    const frame = new Uint8Array(LEAF.length + 32);
    frame.set(LEAF); frame.set(bytes, LEAF.length);
    const leaf = { key, hash: sha256(frame) };
    let hashes = 1n;
    const branch = (bit, left, right) => {
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
    const insert = node => {
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
