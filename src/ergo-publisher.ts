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
// **Idempotence is by memory, not by storage.** A record already published
// by this publisher is rebroadcast as the same transaction while any supplier
// still refuses to confirm its record box exists, so a retry after a lost
// response does not publish twice. After a restart the memory is gone and a
// retry may publish a second, identical object: readers take identical
// records as one (a commitment's second witnessing is below the held
// sequence, a revocation's is not its first), so the cost is one fee. Boxes
// this publisher has spent or created stay in memory, so publications chain
// in the mempool without waiting for a block.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2b.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { compareBytes, copyBytes } from "./bytes.js";
import { MINER_FEE_TREE_HEX } from "./ergo-profile.js";
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
/** Publications remembered for rebroadcast; older ones may publish twice after a refusal. */
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
  /** Broadcast signed transaction bytes; resolves once the supplier accepted them. */
  submit(signed: Uint8Array, id: Uint8Array): Promise<void>;
}

export interface ErgoPublisherOptions {
  /** The funding key: a 32-byte secp256k1 scalar. Copied; it pays fees and box minimums. */
  readonly secretKey: Uint8Array;
  readonly suppliers: readonly ErgoPublishingSupplier[];
  readonly fee?: bigint;
  readonly minValuePerByte?: bigint;
  /** A supplier call not settled in this many milliseconds did not supply. */
  readonly timeoutMs?: number;
}

interface Pending { readonly publication: ErgoPublication }

/**
 * An operator's wallet for venue records: one funding key, publishing one
 * record per transaction. Calls are serialized, so two publications never
 * choose one box.
 */
export class ErgoPublisher {
  readonly #key: ErgoKey;
  readonly #tree: Uint8Array;
  readonly #suppliers: readonly ErgoPublishingSupplier[];
  readonly #fee: bigint;
  readonly #perByte: bigint;
  readonly #timeoutMs: number;
  /** Publications by record (location, subject, record), oldest first. */
  readonly #pending = new Map<string, Pending>();
  /** Boxes remembered publications spend, and the change they create. */
  readonly #spent = new Set<string>();
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
    if (typeof this.#fee !== "bigint" || this.#fee <= 0n || this.#fee > MAX_U64 || typeof this.#perByte !== "bigint" || this.#perByte < 0n ||
        this.#perByte > 1_000_000n || !Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new VenueError("invalid Ergo publisher options");
  }

  /** The funding key's pay-to-public-key tree, where its boxes and change are. */
  get tree(): Uint8Array {
    return copyBytes(this.#tree);
  }

  /** Publish one record at its location, or confirm the transaction this
   * publisher already sent for it. Resolves once some supplier accepted the
   * transaction or shows its record box; throws `VenueError` otherwise. */
  async publish(request: ErgoRecordRequest): Promise<ErgoPublication> {
    const owned = ownRequest(request);
    const run = this.#queue.then(() => this.#publish(owned));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #publish(request: ErgoRecordRequest): Promise<ErgoPublication> {
    const key = bytesToHex(concat(vlq(BigInt(request.location.length)), request.location, request.subject, request.record));
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      const { publication } = pending;
      if (await this.#any(supplier => supplier.hasBox(publication.recordBox))) return publication;
      if (await this.#broadcast(publication)) return publication;
      this.#forget(key, pending);
    }
    let publication: ErgoPublication;
    try {
      publication = await this.#build(request);
    } catch (error) {
      // Remembered change or spends may belong to transactions the network dropped: forget those no supplier
      // shows, and try once more.
      if (!(error instanceof VenueError) || !await this.#prune()) throw error;
      publication = await this.#build(request);
    }
    this.#remember(key, { publication });
    return publication;
  }

  /** A new transaction for the record, accepted by some supplier. */
  async #build(request: ErgoRecordRequest): Promise<ErgoPublication> {
    const inputs = await this.#select(request.height, publicationCost(request, this.#tree, this.#fee, this.#perByte));
    const publication = buildPublication(this.#key, this.#tree, inputs, request, this.#fee, this.#perByte);
    if (!await this.#broadcast(publication)) throw new VenueError("no supplier accepted the publication");
    return publication;
  }

  /** Forget remembered change no supplier shows, and remembered publications
   * whose record box no supplier shows, which frees their inputs: a new
   * transaction spending one of them excludes the old, so at most one lands.
   * Nothing is rebroadcast here, since a record may have been abandoned.
   * Whether anything was forgotten. */
  async #prune(): Promise<boolean> {
    let pruned = false;
    for (const [id, box] of [...this.#created]) {
      if (!await this.#any(supplier => supplier.hasBox(copyBytes(box.id)))) { this.#created.delete(id); pruned = true; }
    }
    for (const [key, pending] of [...this.#pending]) {
      if (!await this.#any(supplier => supplier.hasBox(copyBytes(pending.publication.recordBox)))) { this.#forget(key, pending); pruned = true; }
    }
    return pruned;
  }

  /** Plain boxes of the key that suppliers offer and remembered change, less
   * what remembered publications spend; the largest first until the record's
   * minimum, the fee and a change box are covered, or `MAX_INPUTS` are taken. */
  async #select(height: bigint, needed: bigint): Promise<ErgoPlainBox[]> {
    const offered = new Map<string, ErgoPlainBox>(this.#created);
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => supplier.unspentBoxes(copyBytes(this.#tree)));
      if (!answer.ok || !Array.isArray(answer.value)) continue;
      try {
        for (const bytes of answer.value as unknown[]) {
          const box = isRealBytes(bytes) && bytes.length <= MAX_BOX_BYTES ? readPlainBox(copyBytes(bytes), this.#tree) : undefined;
          if (box !== undefined) offered.set(bytesToHex(box.id), box);
        }
      } catch { /* an answer that throws while read supplies nothing more */ }
    }
    const boxes = [...offered.entries()].filter(([id, box]) => !this.#spent.has(id) && box.creationHeight <= height)
      .map(([, box]) => box).sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : compareBytes(a.id, b.id)));
    const chosen: ErgoPlainBox[] = [];
    let total = 0n;
    for (const box of boxes) {
      if (chosen.length === MAX_INPUTS || total >= needed) break;
      chosen.push(box);
      total += box.value;
    }
    if (chosen.length === 0) throw new VenueError("no supplier offered a box of the publisher's key");
    return chosen;
  }

  /** Whether any supplier accepted the signed transaction. */
  async #broadcast(publication: ErgoPublication): Promise<boolean> {
    let accepted = false;
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => supplier.submit(copyBytes(publication.signed), copyBytes(publication.id)));
      accepted ||= answer.ok;
    }
    return accepted;
  }

  async #any(call: (supplier: ErgoPublishingSupplier) => Promise<boolean>): Promise<boolean> {
    for (const supplier of this.#suppliers) {
      const answer = await this.#call(() => call(supplier));
      if (answer.ok && answer.value === true) return true;
    }
    return false;
  }

  #remember(key: string, pending: Pending): void {
    this.#pending.set(key, pending);
    for (const input of pending.publication.inputs) { const id = bytesToHex(input); this.#spent.add(id); this.#created.delete(id); }
    const change = pending.publication.change;
    if (change !== undefined) this.#created.set(bytesToHex(change.id), Object.freeze({ id: change.id, value: change.value, creationHeight: change.creationHeight }));
    if (this.#pending.size > PENDING_LIMIT) {
      const [oldest, entry] = this.#pending.entries().next().value!;
      this.#pending.delete(oldest);
      // An old publication's inputs are long settled; its change stays offered until a supplier stops offering it.
      for (const input of entry.publication.inputs) this.#spent.delete(bytesToHex(input));
    }
  }

  /** A publication no supplier accepts or shows: its inputs are free again and its change never existed. */
  #forget(key: string, pending: Pending): void {
    this.#pending.delete(key);
    for (const input of pending.publication.inputs) this.#spent.delete(bytesToHex(input));
    if (pending.publication.change !== undefined) this.#created.delete(bytesToHex(pending.publication.change.id));
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
