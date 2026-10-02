// A synthetic Ergo chain under the synthetic reference context
// (`moe/venue/ergo-synthetic/reference`, venue guide "Reference contexts"):
// real header bytes in the node's layout under the mainnet rules, at
// difficulty 1 so that any nonce has the work, above a synthetic anchor at a
// mainnet height; blocks whose transactions carry records at a profile's
// locations, written in the node's unsigned serialization independently of the
// framer; and a supplier serving chosen branches of it.
//
// Reference tooling for tests, the local replay harness and drills, never a
// deployment venue. `ErgoVenue` reads it only under the synthetic context and
// verifies every header and section, so nothing here is trusted by a reader;
// no mainnet header has difficulty 1 and a header id commits to its ancestry,
// so a profile of this chain cannot follow the mainnet.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { copyBytes } from "./bytes.js";
import { ANCHOR_CONTEXT } from "./ergo-headers.js";
import type { ErgoPublishingSupplier } from "./ergo-publisher.js";
import { ERGO_SYNTHETIC_REFERENCE, transactionsRoot, type ErgoProfile, type ErgoTransactionView } from "./ergo-profile.js";
import type { ErgoSupplier } from "./ergo-supplier.js";
import type { RecordKind } from "./record-range.js";

const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const sha = (bytes: Uint8Array | string): Uint8Array => sha256(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
const coll = (bytes: Uint8Array): Uint8Array => cat(Uint8Array.of(0x0e), vlq(BigInt(bytes.length)), bytes);

/** Four distinct pay-to-public-key locations. */
const tree = (kind: number): Uint8Array => Buffer.from(`0008cd02${"ab".repeat(31)}0${kind}`, "hex");
export const SYNTHETIC_SCRIPTS: Readonly<Record<RecordKind, Uint8Array>> = Object.freeze({ 1: tree(1), 2: tree(2), 3: tree(3), 4: tree(4) });
const PLAIN = Buffer.from("0008cd03" + "cc".repeat(32), "hex");

/** Difficulty 1, which EIP-37 keeps at blocks exactly 120 s apart. */
const D1 = 0x0101_0000;
const SPACING = 120_000n, T0 = 1_700_000_000_000n;
/** The anchor's height: above EIP-37's activation, 96 blocks before the next recalculation. */
export const SYNTHETIC_ANCHOR_HEIGHT = 900_000n;
const GENERATOR = secp256k1.ProjectivePoint.BASE.toRawBytes(true);

/** A version 3 header (new-fields length zero) in the node's layout. */
function header(parentId: Uint8Array, height: bigint, timestamp: bigint, root: Uint8Array, salt = 0, bits = D1): Uint8Array {
  const nBits = new Uint8Array(4);
  new DataView(nBits.buffer).setUint32(0, bits, false);
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setUint32(4, salt, false);
  return cat(Uint8Array.of(3), parentId, new Uint8Array(32).fill(1), root, new Uint8Array(33).fill(3), vlq(timestamp),
    new Uint8Array(32).fill(4), nBits, vlq(height), Uint8Array.of(0, 0, 0, 0), GENERATOR, nonce);
}

/** An output: a tree and its register constants, R4 onward. */
export interface Output { readonly ergoTree: Uint8Array; readonly registers: readonly Uint8Array[] }
/** An output at kind `kind`'s location with the profile's shape: R4 the subject, R5 the bytes. */
export const recordOutput = (kind: RecordKind, subject: Uint8Array, bytes: Uint8Array, scripts = SYNTHETIC_SCRIPTS): Output =>
  ({ ergoTree: scripts[kind], registers: [coll(subject), coll(bytes)] });
export const plainOutput: Output = { ergoTree: PLAIN, registers: [] };
/** Raw register constants, for outputs outside the profile's shape. */
export const rawOutput = (ergoTree: Uint8Array, registers: readonly Uint8Array[]): Output => ({ ergoTree, registers });

let serial = 0;
/** One transaction in the node's unsigned serialization: one input, named by
 * `seed`, with an empty proof, then the outputs. Without a seed each call
 * makes a distinct transaction. */
export function transaction(outputs: readonly Output[], creationHeight = 1n, seed = `tx-${serial++}`): ErgoTransactionView {
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

/** The anchor, its 1,024-header context, and blocks mined above it on any branch. The same in every process. */
export class Chain {
  readonly context: readonly Uint8Array[];
  readonly anchor: Block;

  constructor() {
    const context: Uint8Array[] = [];
    let parentId: Uint8Array = sha("before the context"), last: Block | undefined;
    for (let i = 0; i <= ANCHOR_CONTEXT; i++) {
      const height = SYNTHETIC_ANCHOR_HEIGHT - BigInt(ANCHOR_CONTEXT - i);
      const bytes = header(parentId, height, T0 + BigInt(i) * SPACING, new Uint8Array(32).fill(7));
      context.push(bytes);
      parentId = hash(bytes);
      last = { id: parentId, height, bytes, parent: undefined, section: [] };
    }
    this.context = context;
    this.anchor = last!;
  }

  /** This context with its anchor rewritten at difficulty bits `bits`: another anchor over the same ancestors. */
  reanchored(bits: number): { readonly anchorId: Uint8Array; readonly context: readonly Uint8Array[] } {
    const parent = this.context[this.context.length - 2]!;
    const bytes = header(hash(parent), SYNTHETIC_ANCHOR_HEIGHT, T0 + BigInt(ANCHOR_CONTEXT) * SPACING, new Uint8Array(32).fill(7), 0, bits);
    return { anchorId: hash(bytes), context: [...this.context.slice(0, -1), bytes] };
  }

  /** A block on `parent` with these transactions (a plain one where none are given). */
  mine(parent: Block, transactions: readonly ErgoTransactionView[] = [], salt = 0): Block {
    const section = transactions.length > 0 ? transactions : [transaction([plainOutput])];
    const root = transactionsRoot(2n, section.map(t => ({ id: hash(t.unsigned), witnessId: t.witnessId })));
    const height = parent.height + 1n;
    const bytes = header(parent.id, height, T0 + (height - SYNTHETIC_ANCHOR_HEIGHT + BigInt(ANCHOR_CONTEXT)) * SPACING, root, salt);
    return Object.freeze({ id: hash(bytes), height, bytes, parent, section: Object.freeze([...section]) });
  }

  /** `count` blocks on `parent`, block `i` (from 0) carrying `records(i)`'s transactions. */
  extend(parent: Block, count: number, records: (i: number) => readonly ErgoTransactionView[] = () => [], salt = 0): Block[] {
    const out: Block[] = [];
    let tip = parent;
    for (let i = 0; i < count; i++) { tip = this.mine(tip, records(i), salt); out.push(tip); }
    return out;
  }

  /** A profile under the synthetic reference context: this chain is no deployment's. */
  profile(depth: bigint, scripts = SYNTHETIC_SCRIPTS): ErgoProfile {
    return { reference: ERGO_SYNTHETIC_REFERENCE, anchor: this.anchor.id, depth, scripts };
  }
}

/** A block's ancestors from `tip` down, while each is strictly lower than the block before it: a
 * supplied graph whose parent links loop or climb ends there instead of looping. */
function* ancestors(tip: Block | undefined): Generator<Block> {
  let previous: bigint | undefined;
  for (let block = tip; block !== undefined; block = block.parent) {
    if (typeof block.height !== "bigint" || (previous !== undefined && block.height >= previous)) return;
    previous = block.height;
    yield block;
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
  private readonly chain: Chain;

  constructor(name: string, tip: Block, chain: Chain) {
    this.name = name;
    this.tip = tip;
    this.chain = chain;
  }

  private at(height: bigint): Block | undefined {
    for (const block of ancestors(this.tip)) if (block.height <= height) { if (block.height === height) return block; break; }
    // The context below the anchor, as a node serves it.
    const offset = Number(height - (SYNTHETIC_ANCHOR_HEIGHT - BigInt(ANCHOR_CONTEXT)));
    const bytes = this.chain.context[offset];
    return bytes === undefined || height > SYNTHETIC_ANCHOR_HEIGHT ? undefined : { id: hash(bytes), height, bytes, parent: undefined, section: [] };
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
    this.calls.push(`section ${bytesToHex(headerId).slice(0, 8)}`);
    await this.before("section");
    const key = bytesToHex(headerId);
    if (this.withheld.has(key)) return undefined;
    const substitute = this.substituted.get(key);
    if (substitute !== undefined) return substitute;
    for (const block of ancestors(this.tip)) if (bytesToHex(block.id) === key) return block.section;
    return undefined;
  }
}

let fundingSerial = 0;
/** A plain box of `tree` as the node serializes it, created by a transaction with id `txId` at output `index`. */
export function plainBox(tree: Uint8Array, value: bigint, creationHeight: bigint, txId: Uint8Array = sha(`funding-${fundingSerial++}`), index = 0): Uint8Array {
  return cat(vlq(value), tree, vlq(creationHeight), Uint8Array.of(0, 0), txId, vlq(BigInt(index)));
}

/**
 * A node's mempool for the publisher's transactions, written independently of
 * the publisher: it reads a signed transaction in the publisher's shape
 * (inputs with a proof and no extension, no data inputs or tokens, outputs
 * with `Coll[Byte]` registers), and accepts it only where every input is an
 * unspent box it holds, every proof verifies for that box's key over the
 * unsigned bytes, and the values balance exactly. Accepted transactions wait
 * in `pool` for the chain to mine them. This reference supplier supports the
 * synthetic profile's pay-to-public-key locations and the fee tree; it does
 * not reproduce full node consensus or relay policy.
 */
export class MempoolNode implements ErgoPublishingSupplier {
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
  /** Every output of a pooled transaction, spent in the pool or not. */
  private readonly createdInPool = new Map<string, Uint8Array>();

  constructor(name: string, private readonly verify: (publicKey: Uint8Array, message: Uint8Array, proof: Uint8Array) => boolean) {
    this.name = name;
  }

  fund(box: Uint8Array): Uint8Array {
    box = copyBytes(box);
    const id = hash(box);
    this.confirmed.set(bytesToHex(id), box);
    this.boxes.set(bytesToHex(id), box);
    return id;
  }

  /** The node lost its mempool, and `unspent` is now its whole UTXO set. */
  reset(unspent: readonly Uint8Array[] = []): void {
    this.pool.splice(0);
    this.boxes.clear();
    this.confirmed.clear();
    this.createdInPool.clear();
    this.spentInPool.clear();
    for (const box of unspent) this.fund(box);
  }

  /** Whoever holds the box spent it in a block: no answer shows it any more. */
  spend(boxId: Uint8Array): void {
    const key = bytesToHex(boxId);
    this.boxes.delete(key);
    this.confirmed.delete(key);
    this.createdInPool.delete(key);
  }

  async unspentBoxes(tree: Uint8Array): Promise<readonly Uint8Array[]> {
    const source = this.mempoolAware ? this.boxes : this.confirmed;
    return [...source.values()].filter(box => { const read = readBox(box); return read !== undefined && bytesToHex(read.tree) === bytesToHex(tree); }).map(copyBytes);
  }

  /** A box as the node's `/utxo/withPool/byIdBinary` answers it: unspent in blocks or created in the mempool,
   * even where a pooled transaction spends it (recorded real node answers, `test/fixtures/ergo-node-answers.json`). */
  box(boxId: Uint8Array): Uint8Array | undefined {
    const key = bytesToHex(boxId), box = this.boxes.get(key) ?? this.confirmed.get(key) ?? this.createdInPool.get(key);
    return box === undefined ? undefined : copyBytes(box);
  }

  async hasBox(boxId: Uint8Array): Promise<boolean> {
    return this.box(boxId) !== undefined;
  }

  async hasTransaction(id: Uint8Array): Promise<boolean> {
    return this.mined.has(bytesToHex(id)) || this.pool.some(t => bytesToHex(hash(t.unsigned)) === bytesToHex(id));
  }

  async submit(signed: Uint8Array, id: Uint8Array): Promise<void> {
    signed = copyBytes(signed);
    id = copyBytes(id);
    const tx = readSigned(signed);
    this.submitted.push(bytesToHex(id));
    if (tx === undefined || bytesToHex(hash(tx.unsigned)) !== bytesToHex(id) || this.refuse(bytesToHex(id))) throw new Error("refused");
    if (this.mined.has(bytesToHex(id)) || this.pool.some(t => bytesToHex(hash(t.unsigned)) === bytesToHex(id))) return;
    let total = 0n;
    const inputs = new Set<string>();
    for (const [i, input] of tx.inputs.entries()) {
      const key = bytesToHex(input.boxId);
      if (inputs.has(key)) throw new Error("an input occurs twice");
      inputs.add(key);
      const box = this.boxes.get(bytesToHex(input.boxId)), read = box === undefined ? undefined : readBox(box);
      if (read === undefined || bytesToHex(read.tree.subarray(0, 3)) !== "0008cd" || !this.verify(read.tree.subarray(3), tx.unsigned, tx.proofs[i]!)) {
        throw new Error("an input is missing or its proof does not verify");
      }
      total += read.value;
    }
    if (total !== tx.outputs.reduce((sum, o) => sum + o.value, 0n)) throw new Error("values do not balance");
    for (const input of tx.inputs) {
      const key = bytesToHex(input.boxId);
      this.boxes.delete(key);
      this.spentInPool.add(key);
    }
    tx.outputs.forEach((output, index) => {
      const box = cat(output.candidate, id, vlq(BigInt(index)));
      this.boxes.set(bytesToHex(hash(box)), box);
      this.createdInPool.set(bytesToHex(hash(box)), box);
    });
    this.pool.push(Object.freeze({ unsigned: tx.unsigned, witnessId: hash(cat(...tx.proofs)).subarray(1) }));
  }

  /** The pool's transactions for the next block; their outputs become confirmed. */
  take(): ErgoTransactionView[] {
    for (const [id, box] of this.createdInPool) this.confirmed.set(id, box);
    for (const id of this.spentInPool) this.confirmed.delete(id);
    this.createdInPool.clear();
    this.spentInPool.clear();
    for (const t of this.pool) this.mined.add(bytesToHex(hash(t.unsigned)));
    return this.pool.splice(0);
  }
}

/** A box's value and pay-to-public-key tree, for synthetic funding and change. */
function readBox(box: Uint8Array): { value: bigint; tree: Uint8Array } | undefined {
  const cursor = { at: 0 };
  const value = readVlq(box, cursor);
  if (value === undefined) return undefined;
  if (cursor.at + 36 <= box.length && box[cursor.at] === 0x00 && box[cursor.at + 1] === 0x08 && box[cursor.at + 2] === 0xcd) {
    return { value, tree: box.subarray(cursor.at, cursor.at + 36) };
  }
  return undefined;
}
function readVlq(bytes: Uint8Array, cursor: { at: number }): bigint | undefined {
  let value = 0n;
  for (let shift = 0n; cursor.at < bytes.length && shift < 70n; shift += 7n) {
    const byte = bytes[cursor.at++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return (shift > 0n && byte === 0) || value > 0xffff_ffff_ffff_ffffn ? undefined : value;
  }
  return undefined;
}
/** A signed transaction in the publisher's shape, split into its parts. */
function readSigned(signed: Uint8Array): {
  unsigned: Uint8Array; proofs: Uint8Array[]; inputs: { boxId: Uint8Array }[]; outputs: { value: bigint; candidate: Uint8Array }[];
} | undefined {
  const cursor = { at: 0 }, parts: Uint8Array[] = [], proofs: Uint8Array[] = [], inputs: { boxId: Uint8Array }[] = [];
  const count = readVlq(signed, cursor);
  if (count === undefined || count === 0n || count > 65535n) return undefined;
  parts.push(vlq(count));
  for (let i = 0n; i < count; i++) {
    if (cursor.at + 32 > signed.length) return undefined;
    const boxId = signed.subarray(cursor.at, cursor.at + 32);
    cursor.at += 32;
    const length = readVlq(signed, cursor);
    if (length === undefined || length > 65535n || length > BigInt(signed.length - cursor.at)) return undefined;
    proofs.push(signed.subarray(cursor.at, cursor.at + Number(length)));
    cursor.at += Number(length);
    if (signed[cursor.at++] !== 0) return undefined;
    inputs.push({ boxId });
    parts.push(boxId, Uint8Array.of(0, 0));
  }
  const bodyStart = cursor.at;
  if (readVlq(signed, cursor) !== 0n || readVlq(signed, cursor) !== 0n) return undefined;
  const outputCount = readVlq(signed, cursor);
  if (outputCount === undefined || outputCount === 0n || outputCount > 65535n) return undefined;
  const outputs: { value: bigint; candidate: Uint8Array }[] = [];
  for (let i = 0n; i < outputCount; i++) {
    const start = cursor.at, value = readVlq(signed, cursor);
    if (value === undefined) return undefined;
    const tree = signed[cursor.at] === 0x00 ? 36 : signed[cursor.at] === 0x10 ? 105 : -1;
    if (tree < 0 || cursor.at + tree > signed.length) return undefined;
    cursor.at += tree;
    const height = readVlq(signed, cursor);
    if (height === undefined || height > 0xffff_ffffn || signed[cursor.at++] !== 0) return undefined;
    const registers = signed[cursor.at++]!;
    if (registers === undefined || registers > 6) return undefined;
    for (let r = 0; r < registers; r++) {
      if (signed[cursor.at++] !== 0x0e) return undefined;
      const length = readVlq(signed, cursor);
      if (length === undefined || length > 65535n || length > BigInt(signed.length - cursor.at)) return undefined;
      cursor.at += Number(length);
    }
    outputs.push({ value, candidate: signed.subarray(start, cursor.at) });
  }
  if (cursor.at !== signed.length) return undefined;
  return { unsigned: cat(...parts, signed.subarray(bodyStart)), proofs, inputs, outputs };
}

/** A mining supplier for synthetic journal drills. Transactions must first
 * pass the mempool's proof and value checks; only mine() puts them into
 * header-authenticated sections, and readers still apply their depth. */
export class MiningSupplier extends BranchSupplier {
  readonly mempool: MempoolNode;
  private readonly miningChain: Chain;

  constructor(name: string, chain: Chain, verify: (publicKey: Uint8Array, message: Uint8Array, proof: Uint8Array) => boolean) {
    super(name, chain.anchor, chain);
    this.miningChain = chain;
    this.mempool = new MempoolNode(`${name} mempool`, verify);
  }

  mine(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("invalid synthetic block count");
    for (let i = 0; i < count; i++) this.tip = this.miningChain.mine(this.tip, this.mempool.take());
  }
}
