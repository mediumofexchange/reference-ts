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
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ANCHOR_CONTEXT } from "./ergo-headers.js";
import { ERGO_SYNTHETIC_REFERENCE, transactionsRoot, type ErgoProfile, type ErgoTransactionView } from "./ergo-profile.js";
import type { ErgoSupplier } from "./ergo-supplier.js";
import type { RecordKind } from "./record-range.js";

const cat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);
const sha = (bytes: Uint8Array | string): Uint8Array => createHash("sha256").update(bytes).digest();
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
    let block: Block | undefined = this.tip;
    while (block !== undefined && block.height > height) block = block.parent;
    if (block?.height === height) return block;
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
    for (let block: Block | undefined = this.tip; block !== undefined; block = block.parent) {
      if (bytesToHex(block.id) === key) return block.section;
    }
    return undefined;
  }
}
