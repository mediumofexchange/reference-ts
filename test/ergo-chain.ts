// Synthetic reference chain and independently parsed publishing mempool.
// Their shared implementation also serves the journal acceptance harness.
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ANCHOR_CONTEXT, autolykosPowValid, decodeCompactBits, DIFFICULTY_EPOCH, eip37Difficulty, parseErgoHeader, type ErgoHeader } from "../src/ergo-headers.js";
import { transactionsRoot, type ErgoProfile, type ErgoTransactionView } from "../src/ergo-profile.js";
import type { ErgoSupplier } from "../src/ergo-supplier.js";
import { plainOutput, SYNTHETIC_SCRIPTS, transaction } from "../src/ergo-synthetic.js";

export {
  BranchSupplier, Chain, MiningSupplier, MempoolNode, plainBox, plainOutput, rawOutput, recordOutput,
  SYNTHETIC_ANCHOR_HEIGHT as ANCHOR_HEIGHT, SYNTHETIC_SCRIPTS as SCRIPTS,
  transaction, type Block, type Output,
} from "../src/ergo-synthetic.js";

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
/** The compact bits of a difficulty the node's normalization keeps exactly. */
function compact(difficulty: bigint): number {
  const bytes: number[] = [];
  for (let value = difficulty; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  if (bytes[0]! & 0x80) bytes.unshift(0);
  const mantissa = [...bytes.slice(0, 3), 0, 0, 0].slice(0, 3);
  const bits = ((bytes.length << 24) | (mantissa[0]! << 16) | (mantissa[1]! << 8) | mantissa[2]!) >>> 0;
  if (decodeCompactBits(bits) !== difficulty) throw new Error(`difficulty ${difficulty} has no exact compact form`);
  return bits;
}
const GENERATOR = secp256k1.ProjectivePoint.BASE.toRawBytes(true);
function workedHeader(parentId: Uint8Array, height: bigint, timestamp: bigint, root: Uint8Array, bits: number, nonce: number): Uint8Array {
  const out = Buffer.concat([Uint8Array.of(3), parentId, new Uint8Array(32).fill(1), root, new Uint8Array(33).fill(3), vlq(timestamp),
    new Uint8Array(32).fill(4), new Uint8Array(4), vlq(height), Uint8Array.of(0, 0, 0, 0), GENERATOR, new Uint8Array(8)]);
  const at = 1 + 32 + 32 + 32 + 33 + vlq(timestamp).length + 32;
  out.writeUInt32BE(bits, at);
  out.writeUInt32BE(nonce, out.length - 4);
  return Uint8Array.from(out);
}

export interface WorkedBlock {
  readonly id: Uint8Array;
  readonly height: bigint;
  readonly header: ErgoHeader;
  readonly bytes: Uint8Array;
  readonly parent: WorkedBlock | undefined;
  readonly section: readonly ErgoTransactionView[];
  /** The difficulty its parent required of it. */
  readonly difficulty: bigint;
}

/**
 * A chain under the mainnet context (no reference context) above a hand-built
 * anchor context of one low difficulty, every block mined with real Autolykos
 * v2 work at the difficulty its parent requires. Branches crossing an epoch
 * boundary can therefore require different difficulties, so a heavier branch
 * can be shorter, which the synthetic reference context (difficulty 1
 * throughout) cannot show.
 */
export class WorkedChain {
  readonly context: readonly Uint8Array[];
  readonly anchor: WorkedBlock;
  readonly #below = new Map<bigint, ErgoHeader>();
  #serial = 0;

  /** The anchor at `anchorHeight` over 1,024 headers at `difficulty`, 120 s apart. */
  constructor(difficulty: bigint, anchorHeight: bigint) {
    const context: Uint8Array[] = [];
    let parentId = sha256(new TextEncoder().encode("worked chain context")), last: ErgoHeader | undefined;
    for (let i = 0; i <= ANCHOR_CONTEXT; i++) {
      const height = anchorHeight - BigInt(ANCHOR_CONTEXT - i);
      const bytes = workedHeader(parentId, height, 1_700_000_000_000n + BigInt(i) * 120_000n, new Uint8Array(32).fill(7), compact(difficulty), 0);
      last = parseErgoHeader(bytes)!;
      this.#below.set(height, last);
      context.push(bytes);
      parentId = last.id;
    }
    this.context = context;
    this.anchor = Object.freeze({ id: last!.id, height: anchorHeight, header: last!, bytes: context.at(-1)!, parent: undefined, section: [], difficulty });
  }

  profile(depth: bigint): ErgoProfile {
    return { anchor: this.anchor.id, depth, scripts: SYNTHETIC_SCRIPTS };
  }

  /** A block on `parent` at `timestamp` (the parent's plus 120 s by default), carrying one plain transaction. */
  mine(parent: WorkedBlock, timestamp = parent.header.timestamp + 120_000n): WorkedBlock {
    const section = [transaction([plainOutput], 1n, `worked-${this.#serial++}`)];
    const root = transactionsRoot(2n, section.map(t => ({ id: blake2b(t.unsigned, { dkLen: 32 }), witnessId: t.witnessId })));
    const difficulty = this.#required(parent), bits = compact(difficulty), height = parent.height + 1n;
    for (let nonce = 0; ; nonce++) {
      const bytes = workedHeader(parent.id, height, timestamp, root, bits, nonce), header = parseErgoHeader(bytes)!;
      if (autolykosPowValid(header)) return Object.freeze({ id: header.id, height, header, bytes, parent, section, difficulty });
    }
  }

  extend(parent: WorkedBlock, count: number): WorkedBlock[] {
    const out: WorkedBlock[] = [];
    for (let i = 0, tip = parent; i < count; i++) { tip = this.mine(tip); out.push(tip); }
    return out;
  }

  /** A supplier serving `tip`'s branch and the anchor's context. */
  supplier(name: string, tip: WorkedBlock): ErgoSupplier {
    const byHeight = new Map<bigint, Uint8Array>(), sections = new Map<string, readonly ErgoTransactionView[]>();
    for (let at: WorkedBlock | undefined = tip; at?.parent !== undefined; at = at.parent) { byHeight.set(at.height, at.bytes); sections.set(hex(at.id), at.section); }
    const lowest = this.anchor.height - BigInt(ANCHOR_CONTEXT);
    for (let height = lowest; height <= this.anchor.height; height++) byHeight.set(height, this.context[Number(height - lowest)]!);
    return {
      name,
      tipHeight: async () => tip.height,
      headers: async (from, to) => {
        const out: Uint8Array[] = [];
        for (let height = from; height <= to && byHeight.has(height); height++) out.push(byHeight.get(height)!);
        return out;
      },
      section: async id => sections.get(hex(id)),
    };
  }

  /** The difficulty the pinned node requires of a child of `parent` (EIP-37 at an epoch's end). */
  #required(parent: WorkedBlock): bigint {
    if (parent.height % DIFFICULTY_EPOCH !== 0n) return decodeCompactBits(parent.header.nBits);
    const previous: ErgoHeader[] = [];
    for (let i = 8n; i >= 0n; i--) {
      const height = parent.height - i * DIFFICULTY_EPOCH;
      let at: WorkedBlock | undefined = parent;
      while (at !== undefined && at.height > height) at = at.parent;
      previous.push(at?.height === height ? at.header : this.#below.get(height)!);
    }
    return eip37Difficulty(previous);
  }
}
