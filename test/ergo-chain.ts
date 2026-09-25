// A synthetic Ergo chain for tests of the runtime venue: real header bytes in
// the node's layout under the real mainnet rules, at difficulty 1 so that any
// nonce has the work, above a synthetic anchor at a mainnet height; blocks
// whose transactions carry records at the profile's locations, written in the
// node's unsigned serialization independently of the framer; and suppliers
// serving chosen branches of it. The header store verifies every header, so
// nothing here is trusted by the code under test.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { ANCHOR_CONTEXT } from "../src/ergo-headers.js";
import { transactionsRoot, type ErgoProfile, type ErgoTransactionView } from "../src/ergo-profile.js";
import type { ErgoSupplier } from "../src/ergo-supplier.js";
import type { RecordKind } from "../src/record-range.js";

const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const sha = (bytes: Uint8Array | string): Uint8Array => createHash("sha256").update(bytes).digest();
const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
const coll = (bytes: Uint8Array): Uint8Array => cat(Uint8Array.of(0x0e), vlq(BigInt(bytes.length)), bytes);
export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** Four distinct pay-to-public-key locations. */
const tree = (kind: number): Uint8Array => Buffer.from(`0008cd02${"ab".repeat(31)}0${kind}`, "hex");
export const SCRIPTS: Readonly<Record<RecordKind, Uint8Array>> = Object.freeze({ 1: tree(1), 2: tree(2), 3: tree(3), 4: tree(4) });
const PLAIN = Buffer.from("0008cd03" + "cc".repeat(32), "hex");

/** Difficulty 1, which EIP-37 keeps at blocks exactly 120 s apart. */
const D1 = 0x0101_0000;
const SPACING = 120_000n, T0 = 1_700_000_000_000n;
/** The anchor's height: above EIP-37's activation, 96 blocks before the next recalculation. */
export const ANCHOR_HEIGHT = 900_000n;
const GENERATOR = secp256k1.ProjectivePoint.BASE.toRawBytes(true);

/** A version 3 header (new-fields length zero) in the node's layout. */
function header(parentId: Uint8Array, height: bigint, timestamp: bigint, root: Uint8Array, salt = 0): Uint8Array {
  const nBits = new Uint8Array(4);
  new DataView(nBits.buffer).setUint32(0, D1, false);
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setUint32(4, salt, false);
  return cat(Uint8Array.of(3), parentId, new Uint8Array(32).fill(1), root, new Uint8Array(33).fill(3), vlq(timestamp),
    new Uint8Array(32).fill(4), nBits, vlq(height), Uint8Array.of(0, 0, 0, 0), GENERATOR, nonce);
}

/** An output: a tree and its register constants, R4 onward. */
export interface Output { readonly ergoTree: Uint8Array; readonly registers: readonly Uint8Array[] }
/** An output at kind `kind`'s location with the profile's shape: R4 the subject, R5 the bytes. */
export const recordOutput = (kind: RecordKind, subject: Uint8Array, bytes: Uint8Array, scripts = SCRIPTS): Output =>
  ({ ergoTree: scripts[kind], registers: [coll(subject), coll(bytes)] });
export const plainOutput: Output = { ergoTree: PLAIN, registers: [] };
/** Raw register constants, for outputs outside the profile's shape. */
export const rawOutput = (ergoTree: Uint8Array, registers: readonly Uint8Array[]): Output => ({ ergoTree, registers });

let serial = 0;
/** One transaction in the node's unsigned serialization: one input with an empty proof, then the outputs. */
export function transaction(outputs: readonly Output[], creationHeight = 1n): ErgoTransactionView {
  const seed = `tx-${serial++}`;
  const unsigned = cat(vlq(1n), sha(seed), vlq(0n), Uint8Array.of(0), vlq(0n), vlq(0n), vlq(BigInt(outputs.length)),
    ...outputs.map(o => cat(vlq(1_000_000n), o.ergoTree, vlq(creationHeight), Uint8Array.of(0), Uint8Array.of(o.registers.length), ...o.registers)));
  return Object.freeze({ unsigned, witnessId: hash(Buffer.from(seed)).subarray(1) });
}

export interface Block {
  readonly id: Uint8Array;
  readonly height: bigint;
  readonly bytes: Uint8Array;
  readonly parent: Block | undefined;
  readonly section: readonly ErgoTransactionView[];
}

/** The anchor, its 1,024-header context, and blocks mined above it on any branch. */
export class Chain {
  readonly context: readonly Uint8Array[];
  readonly anchor: Block;

  constructor() {
    const context: Uint8Array[] = [];
    let parentId: Uint8Array = sha("before the context"), last: Block | undefined;
    for (let i = 0; i <= ANCHOR_CONTEXT; i++) {
      const height = ANCHOR_HEIGHT - BigInt(ANCHOR_CONTEXT - i);
      const bytes = header(parentId, height, T0 + BigInt(i) * SPACING, new Uint8Array(32).fill(7));
      context.push(bytes);
      parentId = hash(bytes);
      last = { id: parentId, height, bytes, parent: undefined, section: [] };
    }
    this.context = context;
    this.anchor = last!;
  }

  /** A block on `parent` with these transactions (a plain one where none are given). */
  mine(parent: Block, transactions: readonly ErgoTransactionView[] = [], salt = 0): Block {
    const section = transactions.length > 0 ? transactions : [transaction([plainOutput])];
    const root = transactionsRoot(2n, section.map(t => ({ id: hash(t.unsigned), witnessId: t.witnessId })));
    const height = parent.height + 1n;
    const bytes = header(parent.id, height, T0 + (height - ANCHOR_HEIGHT + BigInt(ANCHOR_CONTEXT)) * SPACING, root, salt);
    return Object.freeze({ id: hash(bytes), height, bytes, parent, section: Object.freeze([...section]) });
  }

  /** `count` blocks on `parent`, block `i` (from 0) carrying `records(i)`'s transactions. */
  extend(parent: Block, count: number, records: (i: number) => readonly ErgoTransactionView[] = () => [], salt = 0): Block[] {
    const out: Block[] = [];
    let tip = parent;
    for (let i = 0; i < count; i++) { tip = this.mine(tip, records(i), salt); out.push(tip); }
    return out;
  }

  profile(depth: bigint, scripts = SCRIPTS): ErgoProfile {
    return { anchor: this.anchor.id, depth, scripts };
  }
}

/** A supplier serving one branch (its tip and every ancestor to the anchor), with hooks for failures. */
export class BranchSupplier implements ErgoSupplier {
  readonly name: string;
  tip: Block;
  /** Header ids whose section this supplier withholds. */
  readonly withheld = new Set<string>();
  /** Replaces a section's transactions as served, by header id. */
  readonly substituted = new Map<string, readonly ErgoTransactionView[]>();
  /** Called before each request; may throw or wait. */
  before: (call: "tip" | "headers" | "section") => Promise<void> = async () => {};
  readonly calls: string[] = [];

  constructor(name: string, tip: Block, private readonly chain: Chain) {
    this.name = name;
    this.tip = tip;
  }

  private at(height: bigint): Block | undefined {
    let block: Block | undefined = this.tip;
    while (block !== undefined && block.height > height) block = block.parent;
    if (block?.height === height) return block;
    // The context below the anchor, as a node serves it.
    const offset = Number(height - (ANCHOR_HEIGHT - BigInt(ANCHOR_CONTEXT)));
    const bytes = this.chain.context[offset];
    return bytes === undefined || height > ANCHOR_HEIGHT ? undefined : { id: hash(bytes), height, bytes, parent: undefined, section: [] };
  }

  async tipHeight(): Promise<bigint> {
    this.calls.push("tip");
    await this.before("tip");
    return this.tip.height;
  }

  async headers(fromHeight: bigint, toHeight: bigint): Promise<readonly Uint8Array[]> {
    this.calls.push(`headers ${fromHeight}-${toHeight}`);
    await this.before("headers");
    const out: Uint8Array[] = [];
    for (let height = fromHeight; height <= toHeight; height++) {
      const block = this.at(height);
      if (block === undefined) break;
      out.push(block.bytes);
    }
    return out;
  }

  async section(headerId: Uint8Array): Promise<readonly ErgoTransactionView[] | undefined> {
    this.calls.push(`section ${hex(headerId).slice(0, 8)}`);
    await this.before("section");
    const key = hex(headerId);
    if (this.withheld.has(key)) return undefined;
    const substitute = this.substituted.get(key);
    if (substitute !== undefined) return substitute;
    for (let block: Block | undefined = this.tip; block !== undefined; block = block.parent) {
      if (hex(block.id) === key) return block.section;
    }
    return undefined;
  }
}

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
