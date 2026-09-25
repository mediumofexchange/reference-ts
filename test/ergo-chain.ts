// The synthetic Ergo chain for tests of the runtime venue and publisher: the
// chain, its transactions and branch suppliers are the runtime's reference
// tooling (`src/ergo-synthetic.ts`); a mempool node for the publisher's
// transactions, written independently of the publisher, is here.
import { createHash } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b.js";
import type { ErgoTransactionView } from "../src/ergo-profile.js";

export {
  BranchSupplier, Chain, plainOutput, rawOutput, recordOutput, SYNTHETIC_ANCHOR_HEIGHT as ANCHOR_HEIGHT, SYNTHETIC_SCRIPTS as SCRIPTS,
  transaction, type Block, type Output,
} from "../src/ergo-synthetic.js";

const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const sha = (bytes: Uint8Array | string): Uint8Array => createHash("sha256").update(bytes).digest();
const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

let serial = 0;
/** A plain box of `tree` as the node serializes it, created by a transaction with id `txId` at output `index`. */
export function plainBox(tree: Uint8Array, value: bigint, creationHeight: bigint, txId: Uint8Array = sha(`funding-${serial++}`), index = 0): Uint8Array {
  return cat(vlq(value), tree, vlq(creationHeight), Uint8Array.of(0, 0), txId, vlq(BigInt(index)));
}

/**
 * A node's mempool for the publisher's transactions, written independently of
 * the publisher: it reads a signed transaction in the publisher's shape
 * (inputs with a proof and no extension, no data inputs or tokens, outputs
 * with `Coll[Byte]` registers), and accepts it only where every input is an
 * unspent box it holds, every proof verifies for that box's key over the
 * unsigned bytes, and the values balance exactly. Accepted transactions wait
 * in `pool` for the chain to mine them.
 */
export class MempoolNode {
  readonly name: string;
  /** Unspent boxes by id, as bytes. */
  readonly boxes = new Map<string, Uint8Array>();
  /** Accepted transactions, oldest first, until taken by `take`. */
  readonly pool: ErgoTransactionView[] = [];
  readonly submitted: string[] = [];
  /** Whether `unspentBoxes` shows the mempool's outputs and hides what it spends; a stale index does neither. */
  mempoolAware = true;
  refuse: (id: string) => boolean = () => false;
  /** Boxes in blocks, which a stale index lists. */
  readonly confirmed = new Map<string, Uint8Array>();
  /** Ids of transactions `take` handed to a block. */
  readonly mined = new Set<string>();
  private readonly spentInPool = new Set<string>();
  private readonly createdInPool = new Map<string, Uint8Array>();

  constructor(name: string, private readonly verify: (publicKey: Uint8Array, message: Uint8Array, proof: Uint8Array) => boolean) {
    this.name = name;
  }

  fund(box: Uint8Array): Uint8Array {
    const id = hash(box);
    this.confirmed.set(hex(id), box);
    this.boxes.set(hex(id), box);
    return id;
  }

  async unspentBoxes(tree: Uint8Array): Promise<readonly Uint8Array[]> {
    const source = this.mempoolAware ? this.boxes : this.confirmed;
    return [...source.values()].filter(box => { const read = readBox(box); return read !== undefined && hex(read.tree) === hex(tree); });
  }

  async hasBox(boxId: Uint8Array): Promise<boolean> {
    return this.boxes.has(hex(boxId));
  }

  async hasTransaction(id: Uint8Array): Promise<boolean> {
    return this.mined.has(hex(id)) || this.pool.some(t => hex(hash(t.unsigned)) === hex(id));
  }

  async submit(signed: Uint8Array, id: Uint8Array): Promise<void> {
    const tx = readSigned(signed);
    this.submitted.push(hex(id));
    if (tx === undefined || hex(hash(tx.unsigned)) !== hex(id) || this.refuse(hex(id))) throw new Error("refused");
    if (this.pool.some(t => hex(hash(t.unsigned)) === hex(id))) return;
    let total = 0n;
    for (const [i, input] of tx.inputs.entries()) {
      const box = this.boxes.get(hex(input.boxId)), read = box === undefined ? undefined : readBox(box);
      if (read === undefined || hex(read.tree.subarray(0, 3)) !== "0008cd" || !this.verify(read.tree.subarray(3), tx.unsigned, tx.proofs[i]!)) {
        throw new Error("an input is missing or its proof does not verify");
      }
      total += read.value;
    }
    if (total !== tx.outputs.reduce((sum, o) => sum + o.value, 0n)) throw new Error("values do not balance");
    for (const input of tx.inputs) { this.boxes.delete(hex(input.boxId)); this.confirmed.delete(hex(input.boxId)); this.spentInPool.add(hex(input.boxId)); }
    tx.outputs.forEach((output, index) => {
      const box = cat(output.candidate, id, vlq(BigInt(index)));
      this.boxes.set(hex(hash(box)), box);
      this.createdInPool.set(hex(hash(box)), box);
    });
    this.pool.push(Object.freeze({ unsigned: tx.unsigned, witnessId: hash(cat(...tx.proofs)).subarray(1) }));
  }

  /** The pool's transactions for the next block; their outputs become confirmed. */
  take(): ErgoTransactionView[] {
    for (const [id, box] of this.createdInPool) this.confirmed.set(id, box);
    this.createdInPool.clear();
    this.spentInPool.clear();
    for (const t of this.pool) this.mined.add(hex(hash(t.unsigned)));
    return this.pool.splice(0);
  }
}

/** A box's value and tree, for a box whose tree is pay-to-public-key or sized. */
function readBox(box: Uint8Array): { value: bigint; tree: Uint8Array } | undefined {
  const cursor = { at: 0 };
  const value = readVlq(box, cursor);
  if (value === undefined) return undefined;
  if (box[cursor.at] === 0x00 && box[cursor.at + 1] === 0x08 && box[cursor.at + 2] === 0xcd) return { value, tree: box.subarray(cursor.at, cursor.at + 36) };
  return undefined;
}
function readVlq(bytes: Uint8Array, cursor: { at: number }): bigint | undefined {
  let value = 0n;
  for (let shift = 0n; cursor.at < bytes.length; shift += 7n) {
    const byte = bytes[cursor.at++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
  }
  return undefined;
}
/** A signed transaction in the publisher's shape, split into its parts. */
function readSigned(signed: Uint8Array): {
  unsigned: Uint8Array; proofs: Uint8Array[]; inputs: { boxId: Uint8Array }[]; outputs: { value: bigint; candidate: Uint8Array }[];
} | undefined {
  const cursor = { at: 0 }, parts: Uint8Array[] = [], proofs: Uint8Array[] = [], inputs: { boxId: Uint8Array }[] = [];
  const count = readVlq(signed, cursor);
  if (count === undefined) return undefined;
  parts.push(vlq(count));
  for (let i = 0n; i < count; i++) {
    const boxId = signed.subarray(cursor.at, cursor.at + 32);
    cursor.at += 32;
    const length = readVlq(signed, cursor);
    if (length === undefined) return undefined;
    proofs.push(signed.subarray(cursor.at, cursor.at + Number(length)));
    cursor.at += Number(length);
    if (signed[cursor.at++] !== 0) return undefined;
    inputs.push({ boxId });
    parts.push(boxId, Uint8Array.of(0, 0));
  }
  const bodyStart = cursor.at;
  if (readVlq(signed, cursor) !== 0n || readVlq(signed, cursor) !== 0n) return undefined;
  const outputCount = readVlq(signed, cursor);
  if (outputCount === undefined) return undefined;
  const outputs: { value: bigint; candidate: Uint8Array }[] = [];
  for (let i = 0n; i < outputCount; i++) {
    const start = cursor.at, value = readVlq(signed, cursor);
    if (value === undefined) return undefined;
    const tree = signed[cursor.at] === 0x00 ? 36 : signed[cursor.at] === 0x10 ? 105 : -1;
    if (tree < 0) return undefined;
    cursor.at += tree;
    if (readVlq(signed, cursor) === undefined || signed[cursor.at++] !== 0) return undefined;
    const registers = signed[cursor.at++]!;
    for (let r = 0; r < registers; r++) {
      if (signed[cursor.at++] !== 0x0e) return undefined;
      const length = readVlq(signed, cursor);
      if (length === undefined) return undefined;
      cursor.at += Number(length);
    }
    outputs.push({ value, candidate: signed.subarray(start, cursor.at) });
  }
  if (cursor.at !== signed.length) return undefined;
  return { unsigned: cat(...parts, signed.subarray(bodyStart)), proofs, inputs, outputs };
}
