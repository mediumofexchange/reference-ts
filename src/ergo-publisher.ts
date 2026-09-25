// Publishing records on Ergo (venue-ergo.md §§5, 8): the operator's wallet.
//
// A record is one output at its kind's location whose R4 is the subject and
// R5 the record (§6). This builds that transaction in the profile's grammar
// (§5): plain inputs of one pay-to-public-key key with empty extensions, the
// record output, change back to the key and the fee at the miner-fee tree,
// every register a `Coll[Byte]`. It signs each input itself, Ergo's proveDlog
// Schnorr proof over the unsigned bytes, on @noble/curves, so the runtime needs
// no Ergo library, and broadcasts the signed bytes through suppliers it does
// not trust.
//
// **Publishing proves nothing; reading does.** A supplier that accepts a
// transaction has said so, not shown it: the record counts only once the
// reader's own view (`ErgoVenue`) holds it at a witnessed index. So a supplier
// here can withhold, lie about boxes or drop a transaction, which costs a
// publication its window (the store then refuses to build on it), but it
// cannot make a reader hold a record that is not on the chain. A box a
// supplier offers is taken only as bytes that hash to its id, a plain box of
// this key; a false value or a spent box makes a transaction the network
// refuses (Ergo preserves value exactly), never one that pays anyone else.
//
// **What the key can do.** It pays fees and minimum box values, nothing more:
// records are signed by their own keys (an operator's commitment, a backer's
// revocation), and a transaction's author has no say in what a reader makes of
// its record. Each box at a location carries the network's minimum value,
// which whoever can spend that location collects (§1).
//
// **One transaction per record, remembered before it is sent.** A record's
// transaction is built once; every later attempt sends the same bytes (after
// any unsettled transaction whose change it spends), so a lost response, an
// unreachable supplier or a dropped transaction never leads to a second,
// non-conflicting one. It is forgotten only once a verifying view holds the
// record (`settle`). The memory is not stored: after a restart a retry may
// publish a second, identical object, which readers take as one (a
// commitment's later witnessing is below the held sequence, a revocation's
// first witnessing counts, and a repeated replacement restates its own
// link), so the cost is a fee. Change this publisher created is spent before
// any index shows it, so publications chain in the mempool. The funding key
// must be this publisher's alone: a transaction spending its boxes elsewhere
// can invalidate a remembered one for good.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes } from "./bytes.js";
import { MINER_FEE_TREE_HEX } from "./ergo-profile.js";
import { parseNodeJson, type NodeJson } from "./ergo-supplier.js";
import { VenueError } from "./venue.js";

/** The pinned node's minimum fee for its mempool (`minimalFeeAmount`) plus
 * the margin wallets add; a deployment may pay more. */
export const DEFAULT_ERGO_FEE = 1_100_000n;
/** The mainnet's voted `minValuePerByte` at the pinned node: a box's value is
 * at least this times its full serialized length. */
export const DEFAULT_MIN_VALUE_PER_BYTE = 360n;

const N = secp256k1.CURVE.n;
const G = secp256k1.ProjectivePoint.BASE;
const FEE_TREE = hexToBytes(MINER_FEE_TREE_HEX);
const P2PK_PREFIX = Uint8Array.of(0x00, 0x08, 0xcd);
const COLL_BYTE = 0x0e;
/** Soundness of Ergo's Sigma protocols: the challenge is 24 bytes. */
const CHALLENGE_BYTES = 24;
const PROOF_BYTES = CHALLENGE_BYTES + 32;
const NONCE_TAG = new TextEncoder().encode("moe/ergo/publisher/nonce/v1");
/** The node's consensus limit on a box's serialized bytes. */
const MAX_BOX_BYTES = 4096;
const MAX_U16 = 0xffff;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_INPUTS = 64;
/** Unsettled publications remembered at once; a view settles them as it reads their records. */
const PENDING_LIMIT = 1024;

const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { dkLen: 32 });
const vlq = (n: bigint): Uint8Array => {
  const out: number[] = [];
  do { let byte = Number(n & 0x7fn); n >>= 7n; if (n > 0n) byte |= 0x80; out.push(byte); } while (n > 0n);
  return Uint8Array.from(out);
};
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const toBigint = (bytes: Uint8Array): bigint => bytes.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
const scalarBytes = (n: bigint): Uint8Array => hexToBytes(n.toString(16).padStart(64, "0"));
const isRealBytes = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && value instanceof Uint8Array && !(value.buffer instanceof SharedArrayBuffer);

/** The pay-to-public-key tree of a compressed secp256k1 key. */
export function payToPublicKeyTree(publicKey: Uint8Array): Uint8Array {
  if (!isRealBytes(publicKey) || publicKey.length !== 33) throw new VenueError("a public key is 33 compressed bytes");
  secp256k1.ProjectivePoint.fromHex(publicKey);
  return concat(P2PK_PREFIX, publicKey);
}

/** The Fiat–Shamir challenge of a proveDlog leaf (sigma's `fiat_shamir_tree_to_bytes`):
 * the leaf prefix, the proposition as a segregated ErgoTree v0 and the
 * commitment `a`, each 16-bit length-prefixed, then the message; Blake2b-256
 * cut to 24 bytes. */
function challenge(publicKey: Uint8Array, a: Uint8Array, message: Uint8Array): Uint8Array {
  const proposition = concat(Uint8Array.of(0x10, 0x01, 0x08, 0xcd), publicKey, Uint8Array.of(0x73, 0x00));
  const tree = concat(Uint8Array.of(1, 0, proposition.length), proposition, Uint8Array.of(0, a.length), a);
  return hash(concat(tree, message)).subarray(0, CHALLENGE_BYTES);
}

/** Whether `proof` is the key's proveDlog proof over `message`: the challenge
 * `e` (24 bytes) and response `z` (32 bytes, below the group order), with
 * `a = g^z · h^-e` hashing back to `e`. */
export function verifyErgoProof(publicKey: Uint8Array, message: Uint8Array, proof: Uint8Array): boolean {
  try {
    if (!isRealBytes(publicKey) || publicKey.length !== 33 || !isRealBytes(message) || !isRealBytes(proof) || proof.length !== PROOF_BYTES) return false;
    const h = secp256k1.ProjectivePoint.fromHex(publicKey);
    const e = proof.subarray(0, CHALLENGE_BYTES), z = toBigint(proof.subarray(CHALLENGE_BYTES));
    if (z >= N) return false;
    const gz = z === 0n ? secp256k1.ProjectivePoint.ZERO : G.multiply(z);
    const he = toBigint(e) === 0n ? secp256k1.ProjectivePoint.ZERO : h.multiply(toBigint(e));
    const a = gz.subtract(he);
    if (a.equals(secp256k1.ProjectivePoint.ZERO)) return false;
    return compareBytes(challenge(publicKey, a.toRawBytes(true), message), e) === 0;
  } catch {
    return false;
  }
}

/** One secp256k1 key's proveDlog proofs. The nonce is hedged: Blake2b-512 of
 * a tag, the secret, the message, the input's position and fresh randomness,
 * reduced mod the order, so neither a weak generator nor a repeated message
 * alone repeats it. Every proof is verified before it leaves. */
class ErgoKey {
  readonly publicKey: Uint8Array;
  readonly #secret: bigint;
  constructor(secretKey: Uint8Array) {
    if (!isRealBytes(secretKey) || secretKey.length !== 32) throw new VenueError("an Ergo secret key is 32 bytes");
    const secret = toBigint(secretKey);
    if (secret === 0n || secret >= N) throw new VenueError("an Ergo secret key is a scalar below the group order");
    this.#secret = secret;
    this.publicKey = G.multiply(secret).toRawBytes(true);
  }
  prove(message: Uint8Array, position: number): Uint8Array {
    for (;;) {
      const seed = blake2b(concat(NONCE_TAG, scalarBytes(this.#secret), vlq(BigInt(message.length)), message,
        vlq(BigInt(position)), randomBytes(32)), { dkLen: 64 });
      const r = toBigint(seed) % N;
      if (r === 0n) continue;
      const a = G.multiply(r).toRawBytes(true);
      const e = challenge(this.publicKey, a, message);
      const z = (r + toBigint(e) * this.#secret) % N;
      const proof = concat(e, scalarBytes(z));
      if (!verifyErgoProof(this.publicKey, message, proof)) throw new Error("an Ergo proof failed its own verification");
      return proof;
    }
  }
}

/** A plain box of the publisher's key: its id, value and creation height. */
export interface ErgoPlainBox {
  readonly id: Uint8Array;
  readonly value: bigint;
  readonly creationHeight: bigint;
}

/** A box's serialized bytes read as a plain box of `tree`: the value, the
 * tree, the creation height, no tokens, no registers, the creating
 * transaction's id and the output index, ending exactly. Its id is their
 * Blake2b-256. Anything else is not a box this publisher spends. */
export function readPlainBox(bytes: Uint8Array, tree: Uint8Array): ErgoPlainBox | undefined {
  if (!isRealBytes(bytes)) return undefined;
  let at = 0;
  const readVlq = (max: bigint): bigint | undefined => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= bytes.length) return undefined;
      const byte = bytes[at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return (byte === 0 && shift > 0n) || value > max ? undefined : value;
    }
    return undefined;
  };
  const value = readVlq(MAX_U64);
  if (value === undefined || bytes.length - at < tree.length || compareBytes(bytes.subarray(at, at + tree.length), tree) !== 0) return undefined;
  at += tree.length;
  const creationHeight = readVlq(0xffff_ffffn);
  if (creationHeight === undefined || bytes[at] !== 0 || bytes[at + 1] !== 0) return undefined;
  at += 2 + 32;
  if (at > bytes.length || readVlq(BigInt(MAX_U16)) === undefined || at !== bytes.length) return undefined;
  return Object.freeze({ id: hash(bytes), value, creationHeight });
}

/** One output of a transaction this builds. */
interface Candidate { readonly value: bigint; readonly tree: Uint8Array; readonly registers: readonly Uint8Array[] }
const coll = (bytes: Uint8Array): Uint8Array => concat(Uint8Array.of(COLL_BYTE), vlq(BigInt(bytes.length)), bytes);
const candidateBytes = (c: Candidate, height: bigint): Uint8Array =>
  concat(vlq(c.value), c.tree, vlq(height), Uint8Array.of(0, c.registers.length), ...c.registers);
/** The full box's length at output `index`: the candidate, the transaction id and the index. */
const boxLength = (c: Candidate, height: bigint, index: number): number => candidateBytes(c, height).length + 32 + vlq(BigInt(index)).length;
/** The least value the network admits for this output (the pinned node's
 * `minimalErgoAmount`: the per-byte minimum times the full box bytes). */
function minimumValue(c: Omit<Candidate, "value">, height: bigint, index: number, perByte: bigint): bigint {
  let value = 0n;
  for (;;) {
    const needed = perByte * BigInt(boxLength({ ...c, value }, height, index));
    if (needed <= value) return value;
    value = needed;
  }
}

/** A built transaction: its id, both serializations, and the boxes it spends and creates. */
export interface ErgoPublication {
  readonly id: Uint8Array;
  readonly unsigned: Uint8Array;
  readonly signed: Uint8Array;
  readonly inputs: readonly Uint8Array[];
  /** The record box's id: output 0. */
  readonly recordBox: Uint8Array;
  /** The change box (output 1), where there is one. */
  readonly change?: ErgoPlainBox & { readonly bytes: Uint8Array };
}

export interface ErgoRecordRequest {
  /** The record's location: its kind's tree in the profile. */
  readonly location: Uint8Array;
  readonly subject: Uint8Array;
  readonly record: Uint8Array;
  /** Every output's creation height: at most the including block's height and
   * at least every input's (the node's `txFuture` and `txMonotonicHeight`). */
  readonly height: bigint;
}

const recordOutput = (request: ErgoRecordRequest): Omit<Candidate, "value"> =>
  ({ tree: request.location, registers: [coll(request.subject), coll(request.record)] });
/** What a publication spends beside change: the record box's minimum, the fee and a change box's minimum. */
const publicationCost = (request: ErgoRecordRequest, tree: Uint8Array, fee: bigint, perByte: bigint): bigint =>
  minimumValue(recordOutput(request), request.height, 0, perByte) + fee + minimumValue({ tree, registers: [] }, request.height, 1, perByte);

/** The unsigned and signed transaction carrying one record, from these inputs
 * (all of `key`'s tree, in order): output 0 the record at its location with
 * the minimum value, output 1 the change to the key where it reaches the
 * minimum (otherwise it joins the fee), output 2 the fee. */
function buildPublication(key: ErgoKey, tree: Uint8Array, inputs: readonly ErgoPlainBox[], request: ErgoRecordRequest, fee: bigint, perByte: bigint): ErgoPublication {
  const { height } = request;
  const record = recordOutput(request);
  const recordValue = minimumValue(record, height, 0, perByte);
  const outputs: Candidate[] = [{ ...record, value: recordValue }];
  if (boxLength(outputs[0]!, height, 0) > MAX_BOX_BYTES) throw new VenueError("the record does not fit one box");
  const total = inputs.reduce((sum, box) => sum + box.value, 0n);
  const changeMinimum = minimumValue({ tree, registers: [] }, height, 1, perByte);
  const rest = total - recordValue - fee;
  if (rest < 0n) throw new VenueError("the publisher's boxes do not cover the record and the fee");
  let paid = fee;
  if (rest >= changeMinimum) outputs.push({ tree, registers: [], value: rest });
  else paid += rest;
  outputs.push({ tree: FEE_TREE, registers: [], value: paid });
  const body = concat(vlq(0n), vlq(0n), vlq(BigInt(outputs.length)), ...outputs.map(o => candidateBytes(o, height)));
  const unsigned = concat(vlq(BigInt(inputs.length)), ...inputs.map(box => concat(box.id, vlq(0n), Uint8Array.of(0))), body);
  const signed = concat(vlq(BigInt(inputs.length)), ...inputs.map((box, i) => {
    const proof = key.prove(unsigned, i);
    return concat(box.id, vlq(BigInt(proof.length)), proof, Uint8Array.of(0));
  }), body);
  const id = hash(unsigned);
  const boxId = (index: number): Uint8Array => hash(concat(candidateBytes(outputs[index]!, height), id, vlq(BigInt(index))));
  const change = outputs.length === 3 ? outputs[1]! : undefined;
  return Object.freeze({
    id, unsigned, signed, inputs: Object.freeze(inputs.map(box => copyBytes(box.id))), recordBox: boxId(0),
    ...(change === undefined ? {} : { change: Object.freeze({
      id: boxId(1), value: change.value, creationHeight: height, bytes: concat(candidateBytes(change, height), id, vlq(1n)),
    }) }),
  });
}

/** One place to broadcast transactions and learn boxes. Every method may fail
 * (throw or reject); the publisher treats that as the supplier not supplying. */
export interface ErgoPublishingSupplier {
  readonly name: string;
  /** Serialized bytes of unspent boxes guarded by `tree`, counting the
   * supplier's mempool and leaving out boxes its mempool spends. */
  unspentBoxes(tree: Uint8Array): Promise<readonly Uint8Array[]>;
  /** Whether a box with this id is unspent in the supplier's UTXO set or created in its mempool. */
  hasBox(boxId: Uint8Array): Promise<boolean>;
  /** Whether the supplier holds a transaction with this id, in its mempool or its blocks. */
  hasTransaction(id: Uint8Array): Promise<boolean>;
  /** Broadcast signed transaction bytes; resolves once the supplier accepted them. */
  submit(signed: Uint8Array, id: Uint8Array): Promise<void>;
}

export interface ErgoPublisherOptions {
  /** The funding key: a 32-byte secp256k1 scalar. Copied; it pays fees and box
   * minimums, and no other wallet may spend its boxes. */
  readonly secretKey: Uint8Array;
  readonly suppliers: readonly ErgoPublishingSupplier[];
  readonly fee?: bigint;
  readonly minValuePerByte?: bigint;
  /** A supplier call not settled in this many milliseconds did not supply. */
  readonly timeoutMs?: number;
}

/** A publication built for one record, remembered before it is first sent. */
interface Pending {
  readonly key: string;
  readonly request: ErgoRecordRequest;
  readonly inputs: readonly ErgoPlainBox[];
  readonly publication: ErgoPublication;
}
const recordKey = (r: ErgoRecordRequest): string =>
  bytesToHex(concat(vlq(BigInt(r.location.length)), r.location, r.subject, vlq(BigInt(r.record.length)), r.record));

/**
 * An operator's wallet for venue records: one funding key, one record per
 * transaction. Calls are serialized, so two publications never choose one box.
 */
export class ErgoPublisher {
  readonly #key: ErgoKey;
  readonly #tree: Uint8Array;
  readonly #suppliers: readonly ErgoPublishingSupplier[];
  readonly #fee: bigint;
  readonly #perByte: bigint;
  readonly #timeoutMs: number;
  /** Unsettled publications by record, oldest first. */
  readonly #pending = new Map<string, Pending>();
  /** The unsettled publication that creates each change box, by box id. */
  readonly #byChange = new Map<string, Pending>();
  /** Boxes remembered publications spend. */
  readonly #spent = new Set<string>();
  /** Change this publisher created and has not spent, landed or not, while no supplier shows it gone. */
  readonly #created = new Map<string, ErgoPlainBox>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ErgoPublisherOptions) {
    this.#key = new ErgoKey(options.secretKey);
    this.#tree = payToPublicKeyTree(this.#key.publicKey);
    if (!Array.isArray(options.suppliers) || options.suppliers.length === 0) throw new VenueError("a publisher needs a supplier");
    this.#suppliers = Object.freeze([...options.suppliers]);
    this.#fee = options.fee ?? DEFAULT_ERGO_FEE;
    this.#perByte = options.minValuePerByte ?? DEFAULT_MIN_VALUE_PER_BYTE;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    if (typeof this.#fee !== "bigint" || typeof this.#perByte !== "bigint" || this.#perByte < 1n || this.#perByte > 1_000_000n ||
        this.#fee > MAX_U64 || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new VenueError("invalid Ergo publisher options");
    // The fee box is a box too: it must reach the minimum at any height.
    if (this.#fee < minimumValue({ tree: FEE_TREE, registers: [] }, 0xffff_ffffn, 2, this.#perByte)) {
      throw new VenueError("the fee is below its box's minimum value");
    }
  }

  /** The funding key's pay-to-public-key tree, where its boxes and change are. */
  get tree(): Uint8Array {
    return copyBytes(this.#tree);
  }

  /** How many publications are remembered and not yet settled. */
  get unsettled(): number {
    return this.#pending.size;
  }

  /**
   * Publish one record at its location. A record this publisher already built
   * a transaction for gets that same transaction, sent again unless a
   * supplier shows its record box: it is remembered before it is first sent,
   * so a lost response or an unreachable supplier never leads to a second
   * transaction. Resolves once a supplier accepted it or shows its record
   * box; otherwise throws `VenueError` and keeps it for the next attempt.
   *
   * A remembered transaction every supplier refuses, one of whose inputs no
   * supplier shows and one answers it lacks (an invented box, a dropped
   * parent), can never land as it is: it is dropped with its change and
   * rebuilt spending every input of it that a supplier still shows, so the
   * two conflict wherever they can. Where none is shown, the old one could
   * land only if its inputs came back, and the record would then be
   * witnessed twice, which readers take as once.
   */
  async publish(request: ErgoRecordRequest): Promise<ErgoPublication> {
    const owned = ownRequest(request);
    return this.#serialized(() => this.#publish(owned));
  }

  /**
   * Forget the publications whose records a verifying view holds (`holds`
   * answers for a record at a final index). A publication whose record box
   * or change a supplier shows has landed, so its inputs leave the memory
   * too; otherwise, as when someone else published the same record, its
   * inputs stay reserved, so no later transaction conflicts with one that
   * may still land.
   */
  async settle(holds: (request: ErgoRecordRequest) => boolean): Promise<void> {
    return this.#serialized(async () => {
      for (const pending of [...this.#pending.values()]) {
        if (!holds(pending.request)) continue;
        const { publication } = pending, change = publication.change;
        const landed = await this.#any(s => s.hasBox(copyBytes(publication.recordBox))) ||
          (change !== undefined && await this.#any(s => s.hasBox(copyBytes(change.id))));
        this.#pending.delete(pending.key);
        if (change !== undefined) this.#byChange.delete(bytesToHex(change.id));
        // Landed change stays the publisher's own until it spends it, whatever an index lists.
        if (landed) for (const input of publication.inputs) this.#spent.delete(bytesToHex(input));
        else if (change !== undefined) this.#created.delete(bytesToHex(change.id));
      }
    });
  }

  #serialized<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(action);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #publish(request: ErgoRecordRequest): Promise<ErgoPublication> {
    const key = recordKey(request);
    const kept = (): never => { throw new VenueError("no supplier accepted the publication; it is kept and sent again on the next attempt"); };
    let pending = this.#pending.get(key);
    if (pending !== undefined) {
      if (await this.#shown(pending) || await this.#send(pending, new Set())) return pending.publication;
      const { live, gone } = await this.#inspect(pending);
      if (gone.length > 0) {
        this.#forget(pending, gone);
        pending = await this.#build(key, request, live, new Set(gone.map(box => bytesToHex(box.id))));
      } else if (request.height !== pending.request.height) {
        // Refused for something other than its inputs, such as a height the chain went back below:
        // the same inputs at the caller's height, so the old and the new conflict.
        const old = pending;
        this.#forget(old, []);
        pending = await this.#build(key, request, old.inputs, new Set());
      } else {
        kept();
      }
    } else {
      if (this.#pending.size >= PENDING_LIMIT) throw new VenueError("the publisher holds too many unsettled publications; settle it from a view");
      pending = await this.#build(key, request, [], new Set());
    }
    if (!await this.#send(pending, new Set())) kept();
    return pending.publication;
  }

  /** A new transaction for the record, spending `required` and never `excluded`, remembered before it is sent. */
  async #build(key: string, asked: ErgoRecordRequest, required: readonly ErgoPlainBox[], excluded: ReadonlySet<string>): Promise<Pending> {
    // Outputs are created no lower than any required input (the node's txMonotonicHeight).
    const floor = required.reduce((high, box) => (box.creationHeight > high ? box.creationHeight : high), asked.height);
    const request: ErgoRecordRequest = floor === asked.height ? asked : Object.freeze({ ...asked, height: floor });
    const inputs = await this.#select(request.height, publicationCost(request, this.#tree, this.#fee, this.#perByte), required, excluded);
    const pending: Pending = Object.freeze({ key, request, inputs: Object.freeze(inputs),
      publication: buildPublication(this.#key, this.#tree, inputs, request, this.#fee, this.#perByte) });
    this.#remember(pending);
    return pending;
  }

  /** A refused publication's inputs that some supplier answers it lacks
   * (gone, as selection judges a box), and those one shows and none denies
   * (live). A supplier denying a real input costs at most a second witnessing
   * of the record; one vouching for an invented input cannot keep it. */
  async #inspect(pending: Pending): Promise<{ live: ErgoPlainBox[]; gone: ErgoPlainBox[] }> {
    const live: ErgoPlainBox[] = [], gone: ErgoPlainBox[] = [];
    for (const box of pending.inputs) {
      if (await this.#denied(box.id)) gone.push(box);
      else if (await this.#any(supplier => supplier.hasBox(copyBytes(box.id)))) live.push(box);
    }
    return { live, gone };
  }

  /** Drop a publication that cannot land: its change never existed, its inputs are free, and `gone` ones are no one's. */
  #forget(pending: Pending, gone: readonly ErgoPlainBox[]): void {
    this.#pending.delete(pending.key);
    const change = pending.publication.change;
    if (change !== undefined) { this.#byChange.delete(bytesToHex(change.id)); this.#created.delete(bytesToHex(change.id)); }
    for (const input of pending.publication.inputs) this.#spent.delete(bytesToHex(input));
    for (const box of gone) this.#created.delete(bytesToHex(box.id));
  }

  /** Send a publication after the unsettled ones whose change it spends and no supplier shows. */
  async #send(pending: Pending, visited: Set<string>): Promise<boolean> {
    visited.add(pending.key);
    for (const input of pending.publication.inputs) {
      const parent = this.#byChange.get(bytesToHex(input));
      if (parent !== undefined && !visited.has(parent.key) && !await this.#shown(parent)) await this.#send(parent, visited);
    }
    let accepted = false;
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => supplier.submit(copyBytes(pending.publication.signed), copyBytes(pending.publication.id)));
      accepted ||= answer.ok;
    }
    return accepted;
  }

  /** Whether a supplier shows the record box or holds the transaction: it is pending or it landed, and its
   * inputs, spent by it, are not gone. */
  async #shown(pending: Pending): Promise<boolean> {
    return await this.#any(supplier => supplier.hasBox(copyBytes(pending.publication.recordBox))) ||
      this.#any(supplier => supplier.hasTransaction(copyBytes(pending.publication.id)));
  }

  /**
   * `required`, then boxes covering the record's minimum, the fee and a
   * change box, largest first, at most `MAX_INPUTS`: change this publisher
   * created and has not spent, and plain boxes of the key that suppliers
   * offer, each taken only as bytes hashing to its id and only where no
   * supplier answers that it lacks the box, so a supplier inventing a box
   * cannot outvote one that knows better.
   */
  async #select(height: bigint, needed: bigint, required: readonly ErgoPlainBox[], excluded: ReadonlySet<string>): Promise<ErgoPlainBox[]> {
    const own = new Map<string, ErgoPlainBox>();
    for (const [id, box] of this.#created) if (!this.#spent.has(id)) own.set(id, box);
    const offered = new Map<string, ErgoPlainBox>();
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => supplier.unspentBoxes(copyBytes(this.#tree)));
      if (!answer.ok) continue;
      try {
        if (!Array.isArray(answer.value)) continue;
        for (const bytes of answer.value as unknown[]) {
          const box = isRealBytes(bytes) && bytes.length <= MAX_BOX_BYTES ? readPlainBox(copyBytes(bytes), this.#tree) : undefined;
          if (box !== undefined && !own.has(bytesToHex(box.id))) offered.set(bytesToHex(box.id), box);
        }
      } catch { /* an answer that throws while read supplies nothing more */ }
    }
    const requiredIds = new Set(required.map(box => bytesToHex(box.id)));
    const candidates = [...own.entries(), ...offered.entries()]
      .filter(([id, box]) => !this.#spent.has(id) && !excluded.has(id) && !requiredIds.has(id) && box.creationHeight <= height)
      .sort(([, a], [, b]) => (a.value > b.value ? -1 : a.value < b.value ? 1 : compareBytes(a.id, b.id)));
    const chosen: ErgoPlainBox[] = [...required];
    let total = required.reduce((sum, box) => sum + box.value, 0n);
    for (const [id, box] of candidates) {
      if (chosen.length === MAX_INPUTS || total >= needed) break;
      if (!own.has(id) && await this.#denied(box.id)) continue;
      chosen.push(box);
      total += box.value;
    }
    if (chosen.length === 0) throw new VenueError("no supplier offered a box of the publisher's key");
    return chosen;
  }

  /** Whether some supplier answers that it lacks the box. */
  async #denied(boxId: Uint8Array): Promise<boolean> {
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => supplier.hasBox(copyBytes(boxId)));
      if (answer.ok && answer.value === false) return true;
    }
    return false;
  }

  async #any(call: (supplier: ErgoPublishingSupplier) => Promise<boolean>): Promise<boolean> {
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => call(supplier));
      if (answer.ok && answer.value === true) return true;
    }
    return false;
  }

  #remember(pending: Pending): void {
    this.#pending.set(pending.key, pending);
    for (const input of pending.publication.inputs) { this.#spent.add(bytesToHex(input)); this.#created.delete(bytesToHex(input)); }
    const change = pending.publication.change;
    if (change !== undefined) {
      this.#byChange.set(bytesToHex(change.id), pending);
      this.#created.set(bytesToHex(change.id), Object.freeze({ id: change.id, value: change.value, creationHeight: change.creationHeight }));
    }
  }

  async #call<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), this.#timeoutMs); });
    try {
      return { ok: true, value: await Promise.race([Promise.resolve().then(call), late]) };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

function ownRequest(request: ErgoRecordRequest): ErgoRecordRequest {
  const { location, subject, record, height } = request;
  if (!isRealBytes(location) || !isRealBytes(subject) || subject.length !== 32 || !isRealBytes(record) || record.length > MAX_U16 ||
      typeof height !== "bigint" || height < 0n || height > 0xffff_ffffn) throw new VenueError("invalid Ergo record request");
  return Object.freeze({ location: copyBytes(location), subject: copyBytes(subject), record: copyBytes(record), height });
}

// --- A node as a publishing supplier ------------------------------------------------------------------------

export interface ErgoNodePublisherOptions {
  /** A label; defaults to the base URL. */
  readonly name?: string;
  /** Defaults to the global `fetch`. */
  readonly fetch?: (url: string, init: NodeRequestInit) => Promise<Response>;
  /** Per request. */
  readonly timeoutMs?: number;
}
/** What the node publisher asks of `fetch`: a GET, or a POST of a JSON string. */
export interface NodeRequestInit {
  readonly signal: AbortSignal;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}
/** Boxes asked of the node's index per request, and the pages read, oldest
 * first, so boxes a stranger sends later cannot push the funding out of view. */
const BOXES_PER_PAGE = 100, BOX_PAGES = 10;
/** Every answer here is small: a page of boxes, one box or an id. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const HEX = /^(?:[0-9a-f]{2})*$/;

/**
 * A node as a publishing supplier, over its REST API: the key's boxes from its
 * index (`/blockchain/box/unspent/byErgoTree`, which needs `extraIndex`), a
 * box from its UTXO set with the mempool (`/utxo/withPool/byIdBinary/{id}`),
 * a transaction from its mempool or its index
 * (`/transactions/unconfirmed/byTransactionId/{id}`, `/blockchain/transaction/byId/{id}`),
 * and submission (`/transactions/bytes`). The node is untrusted: a box it
 * lists is copied to bytes and counts only where they hash to the id it
 * states, and a submission counts only where it answers with the id.
 */
export function ergoNodePublisher(baseUrl: string, options: ErgoNodePublisherOptions = {}): ErgoPublishingSupplier {
  const base = baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? ((url: string, init: NodeRequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 30_000;
  /** The answer as the node's JSON, or undefined where it answers 404. A body is POSTed as a JSON string. */
  const call = async (path: string, body?: string): Promise<NodeJson | undefined> => {
    const response = await fetcher(`${base}${path}`, body === undefined ? { signal: AbortSignal.timeout(timeoutMs) } :
      { signal: AbortSignal.timeout(timeoutMs), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    if (Number(response.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) throw new Error(`${path}: response too long`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${path}: response too long`);
    return parseNodeJson(text);
  };
  return Object.freeze({
    name: options.name ?? base,
    async unspentBoxes(tree: Uint8Array): Promise<readonly Uint8Array[]> {
      const out: Uint8Array[] = [];
      for (let page = 0; page < BOX_PAGES; page++) {
        const statements = await call(`/blockchain/box/unspent/byErgoTree?offset=${page * BOXES_PER_PAGE}&limit=${BOXES_PER_PAGE}` +
          "&sortDirection=asc&includeUnconfirmed=true&excludeMempoolSpent=true", bytesToHex(tree));
        if (statements === undefined) break;
        if (!Array.isArray(statements)) throw new Error("unspent boxes: not a list");
        for (const statement of statements.slice(0, BOXES_PER_PAGE)) {
          const box = copyPlainBox(statement);
          if (box !== undefined) out.push(box);
        }
        if (statements.length < BOXES_PER_PAGE) break;
      }
      return out;
    },
    async hasTransaction(txId: Uint8Array): Promise<boolean> {
      const id = bytesToHex(txId);
      // Each place is asked on its own: a mempool that fails to answer does not keep the index from being read.
      let answered = false, failure: unknown;
      for (const path of [`/transactions/unconfirmed/byTransactionId/${id}`, `/blockchain/transaction/byId/${id}`]) {
        try {
          const transaction = await call(path);
          answered = true;
          if (transaction instanceof Map && transaction.get("id") === id) return true;
        } catch (error) {
          failure = error;
        }
      }
      if (!answered) throw failure;
      return false;
    },
    async hasBox(boxId: Uint8Array): Promise<boolean> {
      const id = bytesToHex(boxId);
      const box = await call(`/utxo/withPool/byIdBinary/${id}`);
      const stated = box instanceof Map ? box.get("bytes") : undefined;
      return typeof stated === "string" && HEX.test(stated) && bytesToHex(hash(hexToBytes(stated))) === id;
    },
    async submit(signed: Uint8Array, id: Uint8Array): Promise<void> {
      if (await call("/transactions/bytes", bytesToHex(signed)) !== bytesToHex(id)) {
        throw new Error("/transactions/bytes: the node did not accept the transaction");
      }
    },
  });
}

/** A plain box (no tokens, no registers) copied from the node's statement of
 * it, as its index lists them: value, tree, creation height, the two empty
 * counts, the creating transaction's id and the output index; undefined for
 * any other box, or one whose copy does not hash to the id stated. */
function copyPlainBox(statement: NodeJson): Uint8Array | undefined {
  if (!(statement instanceof Map)) return undefined;
  const text = (key: string, width?: number): Uint8Array | undefined => {
    const value = statement.get(key);
    return typeof value === "string" && HEX.test(value) && (width === undefined || value.length === 2 * width) ? hexToBytes(value) : undefined;
  };
  const integer = (key: string, max: bigint): bigint | undefined => {
    const value = statement.get(key);
    return typeof value === "bigint" && value >= 0n && value <= max ? value : undefined;
  };
  const assets = statement.get("assets"), registers = statement.get("additionalRegisters");
  if (!Array.isArray(assets) || assets.length !== 0 || !(registers instanceof Map) || registers.size !== 0) return undefined;
  const value = integer("value", MAX_U64), tree = text("ergoTree"), height = integer("creationHeight", 0xffff_ffffn);
  const txId = text("transactionId", 32), index = integer("index", BigInt(MAX_U16));
  if (value === undefined || tree === undefined || height === undefined || txId === undefined || index === undefined) return undefined;
  const out = concat(vlq(value), tree, vlq(height), Uint8Array.of(0, 0), txId, vlq(index));
  return statement.get("boxId") === bytesToHex(hash(out)) ? out : undefined;
}

