// The Ergo venue profile (venue-ergo.md) for pool-v3 §13 answers.
//
// A venue is named with its finality rule and lag (C2.3.2, C2.3.5), and §13.1
// makes the attribution rule part of that name: how an object at the venue is
// assigned to a record kind and subject and how its exact bytes are
// reassembled. The profile fixes all three for an Ergo chain and reads the
// record from full blocks: every output of every transaction of every block in
// the range, each block's transaction section checked against its header's
// transaction root, so absence is proven by exhaustion (§13.2). A transaction
// is its unsigned bytes and witness id; the profile's own framer reads its
// outputs, so no decoder refusal can leave an index without its section. It applies no
// signature, sequence, kind or content rule; the reader's §13.3 rules do.
// The header chain is the reader's own authenticated header source, checked
// here only for contiguity, linkage and the anchor: the venue's index space
// begins at the block after the profile's pinned anchor header, so index 0 is
// that block and a read from index zero is bounded by the anchor. The runtime
// view `src/ergo.ts` reads under this profile.
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "./bytes.js";
import { utf8Encoder } from "./contexts.js";
import { copyRequest, encodeRangeAnswer, MAX_RANGE_RECORD_BYTES, PUBLICATION_RANGE,
  type RangeEntry, type RangeLimits, type RangeRequest, type RecordKind } from "./record-range.js";

/** venue-ergo's own identity context: the mainnet chain under its header rules. */
export const ERGO_PROFILE_CONTEXT = "moe/venue/ergo/v3";
/** A reference-only context, never a deployment profile (venue-ergo stays
 * mainnet-only): the synthetic test chain, read under the mainnet header
 * rules. A profile naming it hashes to another identity, so which chain a
 * venue identity names is read from its preimage, never from its 32 bytes. */
export const ERGO_SYNTHETIC_REFERENCE = "moe/venue/ergo-synthetic/reference";
/** The closed set of reference contexts; the testnet's joins with its header rules. */
export const ERGO_REFERENCE_CONTEXTS = Object.freeze([ERGO_SYNTHETIC_REFERENCE] as const);
export type ErgoReferenceContext = (typeof ERGO_REFERENCE_CONTEXTS)[number];
export const RECORD_KINDS: readonly RecordKind[] = Object.freeze([1, 2, 3, 4]);
const MAX_U64 = (1n << 64n) - 1n, MAX_U32 = 0xffff_ffffn, COLL_BYTE_TYPE = 0x0e;
const ZERO32 = new Uint8Array(32);
const u64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= MAX_U64;
const isBytes = (v: unknown, width?: number): v is Uint8Array =>
  v instanceof Uint8Array && !(v.buffer instanceof SharedArrayBuffer) && (width === undefined || v.length === width);

/** What the venue identity names: the chain by its anchor header (the last
 * block before the venue's index space, so index `i` is the block `i + 1`
 * heights above it), the finality depth, and one location (an exact
 * ErgoTree) per record kind. A header id commits to its whole ancestry, so
 * the anchor names the chain; the all-zero id names no header. A profile
 * without `reference` is venue-ergo's; one with it names a reference context. */
export interface ErgoProfile {
  readonly reference?: ErgoReferenceContext;
  readonly anchor: Uint8Array;
  readonly depth: bigint;
  readonly scripts: Readonly<Record<RecordKind, Uint8Array>>;
}
/** The profile is read once and owned: the identity is hashed over, and every
 * output attributed by, the same bytes (§13.1: two attribution rules are two venues). */
export function ownErgoProfile(profile: ErgoProfile): ErgoProfile {
  if (profile === null || typeof profile !== "object") throw new EncodingError("invalid Ergo profile");
  const { reference, anchor, depth, scripts } = profile;
  if ((reference !== undefined && !ERGO_REFERENCE_CONTEXTS.includes(reference)) || !isBytes(anchor, 32) || compareBytes(anchor, ZERO32) === 0 || !u64(depth) || depth === MAX_U64 ||
      scripts === null || typeof scripts !== "object") {
    throw new EncodingError("invalid Ergo profile");
  }
  const owned: Partial<Record<RecordKind, Uint8Array>> = {};
  for (const kind of RECORD_KINDS) {
    const script = scripts[kind];
    if (!isBytes(script)) throw new EncodingError("invalid Ergo profile script");
    const copy = copyBytes(script);
    // A location is one tree the framer reads whole, or no output could be at it.
    if (!isTree(copy)) throw new EncodingError("invalid Ergo profile script");
    owned[kind] = copy;
  }
  // One location attributes to one kind; two kinds at one script would make one object two objects.
  for (const kind of RECORD_KINDS) {
    for (const other of RECORD_KINDS) {
      if (other < kind && compareBytes(owned[other]!, owned[kind]!) === 0) throw new EncodingError("two kinds at one location");
    }
  }
  return Object.freeze({ ...(reference === undefined ? {} : { reference }), anchor: copyBytes(anchor), depth,
    scripts: Object.freeze(owned as Record<RecordKind, Uint8Array>) });
}
/** Naming the venue is agreeing the chain from its anchor, the depth and the
 * attribution rule (C2.3.2, §13.1), under venue-ergo's context or the
 * reference context the profile names. */
export function ergoProfileIdentity(profile: ErgoProfile): Uint8Array {
  const owned = ownErgoProfile(profile), w = new ByteWriter();
  w.lengthPrefixed(utf8Encoder.encode(owned.reference ?? ERGO_PROFILE_CONTEXT));
  w.key32(owned.anchor, "anchor header id");
  w.u64(owned.depth);
  for (const kind of RECORD_KINDS) w.lengthPrefixed(owned.scripts[kind]);
  return sha256(w.finish());
}
/** C2.3.5: a transaction submitted at clock `c` lands at height `c + depth + 1` at the earliest. */
export function ergoLag(profile: ErgoProfile): bigint {
  return ownErgoProfile(profile).depth + 1n;
}

/** Header fields the verifier reads; the reader's header source authenticates them. */
export interface ErgoHeaderView {
  readonly id: Uint8Array;
  readonly parentId: Uint8Array;
  readonly height: bigint;
  readonly version: bigint;
  readonly transactionsRoot: Uint8Array;
}
/** One output as the profile's framer reads it from the transaction's
 * unsigned bytes: the ErgoTree bytes and each present register's serialized constant. */
export interface ErgoOutputView { readonly ergoTree: Uint8Array; readonly registers: Readonly<Record<string, Uint8Array>> }
/** A transaction as a block commits to it: its unsigned bytes (the node's
 * serialization with every input's proof empty, whose Blake2b-256 is the
 * transaction id) and its 31-byte witness id (Blake2b-256 of the
 * concatenated input proofs, first byte dropped; a section under the
 * ids-only rule does not commit to it). */
export interface ErgoTransactionView { readonly unsigned: Uint8Array; readonly witnessId: Uint8Array }
export interface ErgoBlockView { readonly headerId: Uint8Array; readonly transactions: readonly ErgoTransactionView[] }
export interface ErgoRangeEvidence { readonly headers: readonly ErgoHeaderView[]; readonly blocks: readonly ErgoBlockView[] }

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
const node = (prefix: number, ...parts: Uint8Array[]): Uint8Array => blake2b(concat([Uint8Array.of(prefix), ...parts]), { dkLen: 32 });
/** scrypto's tree as the pinned node builds it: leaf prefix 0, internal
 * prefix 1, an absent right sibling contributes no bytes, and even one leaf
 * has an internal parent. A block's transaction section is never empty. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new EncodingError("a block transaction section is nonempty");
  let level = leaves.map(leaf => node(0, leaf));
  do {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(node(1, level[i]!, level[i + 1] ?? new Uint8Array(0)));
    level = next;
  } while (level.length > 1);
  return level[0]!;
}
/** The root under a section's own version, the marker in the section's
 * serialization (1 = ids only), never the header's: version 1 over the
 * transaction ids alone, every other version over all ids followed by all
 * witness ids. A reader matches a header with `sectionMatchesRoot`. */
export function transactionsRoot(version: bigint, transactions: readonly { readonly id: Uint8Array; readonly witnessId: Uint8Array }[]): Uint8Array {
  const ids = transactions.map(transaction => transaction.id);
  return merkleRoot(version === 1n ? ids : [...ids, ...transactions.map(transaction => transaction.witnessId)]);
}
/** Whether a section reproduces a header's transactions root under either
 * rule. The node takes the rule from the section's own serialization (its
 * version marker, absent for version 1), which nothing compares with the
 * header's version, so the miner chooses it. Without a Blake2b collision two
 * sections cannot match under different rules: leaves and nodes hash under
 * different prefixes, and only the second rule has 31-byte leaves. Under the
 * ids-only rule the witness ids are unbound, which nothing here reads. */
export function sectionMatchesRoot(transactions: readonly { readonly id: Uint8Array; readonly witnessId: Uint8Array }[], root: Uint8Array): boolean {
  return compareBytes(transactionsRoot(1n, transactions), root) === 0 || compareBytes(transactionsRoot(2n, transactions), root) === 0;
}

/** A `Coll[Byte]` constant as a box carries it: type code 0x0e, a minimal
 * unsigned VLQ length and the bytes, ending exactly. Any other register
 * value is not the profile's shape. */
export function collBytes(constant: Uint8Array): Uint8Array | undefined {
  if (!isBytes(constant) || constant.length < 2 || constant[0] !== COLL_BYTE_TYPE) return undefined;
  let length = 0, at = 1;
  for (let shift = 0; ; shift += 7) {
    if (at >= constant.length || shift > 28) return undefined;
    const byte = constant[at++]!;
    length += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      if (byte === 0 && at > 2) return undefined;
      break;
    }
  }
  return constant.length - at === length ? constant.subarray(at) : undefined;
}

/** Ergo's miner-fee proposition (minerRewardDelay 720), the one unsized tree
 * besides pay-to-public-key that the framer reads; a mempool admits a
 * transaction only with a fee output at it. */
export const MINER_FEE_TREE_HEX = "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a7017300730110010204" +
  "02d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";
const MINER_FEE_TREE = hexToBytes(MINER_FEE_TREE_HEX);
const P2PK_PREFIX = Uint8Array.of(0x00, 0x08, 0xcd), P2PK_BYTES = 36, SIZE_FLAG = 0x08, HEADER_RESERVED = 0xe0;
const MAX_U16 = 0xffffn, MAX_EXTENSION = 127;

/** A cursor over one transaction's unsigned bytes. Every read is bounded by
 * the bytes themselves, so framing is linear in their length and allocates
 * nothing a count claims. Any failure is `undefined`, never a throw. */
class Cursor {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number | undefined { return this.at < this.bytes.length ? this.bytes[this.at++] : undefined; }
  /** A minimal unsigned VLQ no larger than `max`, as the node's writer emits it. */
  vlq(max: bigint): bigint | undefined {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      if (byte === undefined) return undefined;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return (byte === 0 && shift > 0n) || value > max ? undefined : value;
    }
    return undefined;
  }
  skip(count: bigint): boolean {
    if (count > BigInt(this.bytes.length - this.at)) return false;
    this.at += Number(count);
    return true;
  }
  startsWith(prefix: Uint8Array): boolean {
    if (prefix.length > this.bytes.length - this.at) return false;
    for (let i = 0; i < prefix.length; i++) if (this.bytes[this.at + i] !== prefix[i]) return false;
    return true;
  }
}
/** An ErgoTree as a box carries it: a sized tree (size flag set, header bits
 * 5–7 clear) is its header, a minimal VLQ size and that many bytes, as the
 * node writes a tree it parsed and as it keeps one it could not; an unsized
 * tree is read only as exactly pay-to-public-key (`0008cd` and a 33-byte
 * point) or the miner-fee tree, both complete expressions, so no other tree
 * begins with them. */
function frameTree(cursor: Cursor): Uint8Array | undefined {
  const start = cursor.at, header = cursor.byte();
  if (header === undefined || (header & HEADER_RESERVED) !== 0) return undefined;
  if ((header & SIZE_FLAG) !== 0) {
    const size = cursor.vlq(MAX_U32);
    if (size === undefined || !cursor.skip(size)) return undefined;
  } else {
    cursor.at = start;
    if (cursor.startsWith(P2PK_PREFIX) && cursor.skip(BigInt(P2PK_BYTES))) return cursor.bytes.subarray(start, cursor.at);
    if (!cursor.startsWith(MINER_FEE_TREE)) return undefined;
    cursor.at += MINER_FEE_TREE.length;
  }
  return cursor.bytes.subarray(start, cursor.at);
}
/** Whether `bytes` are exactly one tree as the framer reads it. */
function isTree(bytes: Uint8Array): boolean {
  const cursor = new Cursor(bytes);
  return frameTree(cursor) !== undefined && cursor.at === bytes.length;
}
/** A `Coll[Byte]` constant in place: type code 0x0e, a minimal VLQ length of
 * at most 65,535 (the node writes it as an unsigned short) and the bytes.
 * The only value the framer reads, in registers and context extensions. */
function frameCollBytes(cursor: Cursor): Uint8Array | undefined {
  const start = cursor.at;
  if (cursor.byte() !== COLL_BYTE_TYPE) return undefined;
  const length = cursor.vlq(MAX_U16);
  return length !== undefined && cursor.skip(length) ? cursor.bytes.subarray(start, cursor.at) : undefined;
}
/** The profile's reading of a transaction's unsigned bytes: its outputs in
 * order, each tree and register constant as exact bytes, or `undefined` where
 * the bytes leave the framer's grammar, in which case the transaction
 * carries no record. The grammar is the pinned node's transaction
 * serialization (inputs with empty proofs, data inputs, token ids, outputs)
 * restricted to what a publisher needs: context extensions and registers of
 * `Coll[Byte]` constants, trees as `frameTree` reads them, minimal VLQs, and
 * nothing after the last output. Every reader frames the same committed
 * bytes alike, and the root binds them, so framing needs no equivalence
 * with the node beyond the publisher's own shape: a transaction outside it
 * is one its author could have written inside it. */
export function frameTransaction(unsigned: Uint8Array): readonly ErgoOutputView[] | undefined {
  if (!isBytes(unsigned)) return undefined;
  const cursor = new Cursor(unsigned);
  const inputs = cursor.vlq(MAX_U16);
  if (inputs === undefined) return undefined;
  for (let i = 0n; i < inputs; i++) {
    if (!cursor.skip(32n) || cursor.vlq(MAX_U16) !== 0n) return undefined;
    const entries = cursor.byte();
    if (entries === undefined || entries > MAX_EXTENSION) return undefined;
    for (let e = 0; e < entries; e++) if (cursor.byte() === undefined || frameCollBytes(cursor) === undefined) return undefined;
  }
  const dataInputs = cursor.vlq(MAX_U16);
  if (dataInputs === undefined || !cursor.skip(32n * dataInputs)) return undefined;
  const tokenIds = cursor.vlq(MAX_U32);
  if (tokenIds === undefined || !cursor.skip(32n * tokenIds)) return undefined;
  const count = cursor.vlq(MAX_U16);
  if (count === undefined) return undefined;
  const outputs: ErgoOutputView[] = [];
  for (let o = 0n; o < count; o++) {
    if (cursor.vlq(MAX_U64) === undefined) return undefined;
    const ergoTree = frameTree(cursor);
    if (ergoTree === undefined || cursor.vlq(MAX_U32) === undefined) return undefined;
    const tokens = cursor.byte();
    if (tokens === undefined) return undefined;
    for (let t = 0; t < tokens; t++) if (cursor.vlq(MAX_U32) === undefined || cursor.vlq(MAX_U64) === undefined) return undefined;
    const registerCount = cursor.byte();
    if (registerCount === undefined || registerCount > 6) return undefined;
    const registers: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (let r = 0; r < registerCount; r++) {
      const constant = frameCollBytes(cursor);
      if (constant === undefined) return undefined;
      registers[`R${4 + r}`] = copyBytes(constant);
    }
    outputs.push(Object.freeze({ ergoTree: copyBytes(ergoTree), registers: Object.freeze(registers) }));
  }
  return cursor.at === unsigned.length ? Object.freeze(outputs) : undefined;
}

/** An object the profile attributes at one height: its kind and subject by
 * location and shape, its position in the venue's order and its exact bytes. */
export interface AttributedObject { readonly kind: RecordKind; readonly subject: Uint8Array; readonly ordinal: bigint; readonly record: Uint8Array }
interface Piece { readonly kind: RecordKind; readonly subject: Uint8Array; readonly piece: Uint8Array }
/** Location is the exact ErgoTree of one kind; shape is R4 a 32-byte
 * `Coll[Byte]` (the subject) and R5 a `Coll[Byte]` (the bytes), both the
 * output's own registers. Other registers are not read. */
function attributeOutput(profile: ErgoProfile, output: ErgoOutputView): Piece | undefined {
  if (output === null || typeof output !== "object" || !isBytes(output.ergoTree) ||
      output.registers === null || typeof output.registers !== "object") throw new EncodingError("invalid Ergo output view");
  const kind = RECORD_KINDS.find(candidate => compareBytes(profile.scripts[candidate], output.ergoTree) === 0);
  if (kind === undefined) return undefined;
  const { registers } = output;
  const r4 = Object.hasOwn(registers, "R4") ? registers["R4"] : undefined;
  const r5 = Object.hasOwn(registers, "R5") ? registers["R5"] : undefined;
  if (r4 === undefined || r5 === undefined) return undefined;
  const subject = collBytes(r4), piece = collBytes(r5);
  if (subject === undefined || subject.length !== 32 || piece === undefined) return undefined;
  return { kind, subject, piece };
}
/** The venue's order within a height: transaction position, then output
 * index (§13.1), packed so that positions compare as the chain orders them. */
export function ergoOrdinal(transaction: number, output: number): bigint {
  if (!Number.isInteger(transaction) || !Number.isInteger(output) || transaction < 0 || output < 0 ||
      BigInt(transaction) > MAX_U32 || BigInt(output) > MAX_U32) throw new EncodingError("Ergo position out of range");
  return (BigInt(transaction) << 32n) | BigInt(output);
}
/** A transaction as the reader holds it: its owned unsigned bytes, the id
 * computed from them and its witness id. Its outputs are framed only when
 * it is attributed. */
interface ReadTransaction { readonly id: Uint8Array; readonly witnessId: Uint8Array; readonly unsigned: Uint8Array }
function attributeOwned(profile: ErgoProfile, transactions: readonly ReadTransaction[]): readonly AttributedObject[] {
  const objects: AttributedObject[] = [];
  transactions.forEach((transaction, position) => {
    // A transaction the framer does not read carries no record.
    const outputs = frameTransaction(transaction.unsigned);
    if (outputs === undefined) return;
    for (let at = 0; at < outputs.length; at++) {
      const first = attributeOutput(profile, outputs[at]!);
      if (first === undefined) continue;
      const ordinal = ergoOrdinal(position, at);
      if (first.kind !== PUBLICATION_RANGE) {
        if (first.piece.length === MAX_RANGE_RECORD_BYTES[first.kind]) {
          objects.push(Object.freeze({ kind: first.kind, subject: copyBytes(first.subject), ordinal, record: copyBytes(first.piece) }));
        }
        continue;
      }
      const pieces = [first.piece];
      let end = at + 1;
      for (; end < outputs.length; end++) {
        const next = attributeOutput(profile, outputs[end]!);
        if (next === undefined || next.kind !== PUBLICATION_RANGE || compareBytes(next.subject, first.subject) !== 0) break;
        pieces.push(next.piece);
      }
      const record = concat(pieces);
      if (record.length <= MAX_RANGE_RECORD_BYTES[PUBLICATION_RANGE]) {
        objects.push(Object.freeze({ kind: PUBLICATION_RANGE, subject: copyBytes(first.subject), ordinal, record }));
      }
      // The boundary output is read again as the next object's first candidate.
      at = end - 1;
    }
  });
  return Object.freeze(objects);
}
/** Every view is read once, field by field, into an owned copy before
 * anything is judged, so no accessor can pass one value to a check and
 * another to a use; the id is hashed, and the outputs later framed, from
 * that copy. A malformed view is undefined. */
function ownTransaction(transaction: ErgoTransactionView): ReadTransaction | undefined {
  if (transaction === null || typeof transaction !== "object") return undefined;
  const { unsigned, witnessId } = transaction;
  if (!isBytes(unsigned) || !isBytes(witnessId, 31)) return undefined;
  const bytes = copyBytes(unsigned);
  return Object.freeze({ id: blake2b(bytes, { dkLen: 32 }), witnessId: copyBytes(witnessId), unsigned: bytes });
}
/** A block's transactions, each owned; undefined if any view is malformed. */
function ownTransactions(transactions: readonly ErgoTransactionView[]): readonly ReadTransaction[] | undefined {
  const owned: ReadTransaction[] = [];
  for (const transaction of transactions) {
    const read = ownTransaction(transaction);
    if (read === undefined) return undefined;
    owned.push(read);
  }
  return Object.freeze(owned);
}
function ownHeader(header: ErgoHeaderView): ErgoHeaderView | undefined {
  if (header === null || typeof header !== "object") return undefined;
  const { id, parentId, height, version, transactionsRoot } = header;
  if (!isBytes(id, 32) || !isBytes(parentId, 32) || !isBytes(transactionsRoot, 32) || !u64(height) || !u64(version)) return undefined;
  return Object.freeze({ id: copyBytes(id), parentId: copyBytes(parentId), height, version, transactionsRoot: copyBytes(transactionsRoot) });
}
/** Every object the profile attributes in one block's transaction section,
 * in venue order. Kinds 1–3 are one output each, at exactly the kind's
 * length. A kind-4 object is the maximal run of adjacent outputs of one
 * transaction at the kind-4 location with one subject, its record the
 * pieces' bytes in output order, its ordinal the first output's; a run
 * longer than the kind's bound is no object. A transaction the framer does
 * not read contributes nothing. */
export function attributeBlock(profile: ErgoProfile, transactions: readonly ErgoTransactionView[]): readonly AttributedObject[] {
  const owned = ownErgoProfile(profile);
  if (!Array.isArray(transactions)) throw new EncodingError("invalid Ergo transactions");
  const ownedTransactions = transactions.map(ownTransaction);
  if (ownedTransactions.some(transaction => transaction === undefined)) throw new EncodingError("invalid Ergo transaction view");
  return attributeOwned(owned, ownedTransactions as ReadTransaction[]);
}

/** §4 and §6 for one supplied section: every transaction view owned once,
 * then, only where the section is nonempty and reproduces `root` under
 * either rule, the objects the profile attributes in it, in venue order.
 * Undefined for any other section, which is not that header's. */
export function attributeSection(profile: ErgoProfile, transactions: readonly ErgoTransactionView[], root: Uint8Array): readonly AttributedObject[] | undefined {
  return attributeOwnedSection(ownErgoProfile(profile), transactions, root);
}
function attributeOwnedSection(profile: ErgoProfile, transactions: readonly ErgoTransactionView[], root: Uint8Array): readonly AttributedObject[] | undefined {
  if (!Array.isArray(transactions) || !isBytes(root, 32)) return undefined;
  const read = ownTransactions(transactions);
  // Outputs are framed only from a section whose root holds.
  if (read === undefined || read.length === 0 || !sectionMatchesRoot(read, root)) return undefined;
  try {
    return attributeOwned(profile, read);
  } catch (error) {
    if (error instanceof EncodingError) return undefined;
    throw error;
  }
}

/** The venue's constants and one §13 answer per request, or none where the
 * evidence does not establish it. A reader's adapter binds its own answer
 * budget when it hands `range` to a replay. */
export interface ErgoRangeVerifier {
  readonly identity: Uint8Array;
  lag(): bigint;
  witnessedIndex(): bigint;
  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined;
}
/** §13.2 over the reader's retained evidence. The headers are the reader's
 * own chain: each is read once into an owned copy, a malformed one is a
 * programming failure, and headers that are not one contiguous linked
 * chain containing the block after the profile's anchor (the header whose
 * parent is the anchor, which is index 0) give no verifier; so do headers
 * that do not yet reach index 0 under the depth. Headers at or below the
 * anchor are linkage only and hold no index. Blocks may come from any
 * supplier: a block supplies the section of an index only where it is a
 * well-formed view, belongs to an indexed header of the chain and reproduces
 * that header's transaction
 * root from the ids of the unsigned bytes; any other block is passed
 * over, so no supplier can deny every read by adding a block, and an index
 * whose section is missing leaves only the ranges through it unresolved.
 * There is no answer for a range not yet witnessed under the depth or for
 * an index without its section. Every field of the profile, of each
 * header, block, transaction and output, and of each request is read once
 * into an owned copy before it is judged; only the two evidence arrays are
 * read as containers, and every element of the array that is iterated is
 * owned. */
export function ergoRangeVerifier(profile: ErgoProfile, evidence: ErgoRangeEvidence): ErgoRangeVerifier | undefined {
  const owned = ownErgoProfile(profile);
  if (evidence === null || typeof evidence !== "object" || !Array.isArray(evidence.headers) || !Array.isArray(evidence.blocks)) {
    throw new EncodingError("invalid Ergo range evidence");
  }
  const headers = evidence.headers.map(ownHeader);
  if (headers.some(header => header === undefined)) throw new EncodingError("invalid Ergo header view");
  const identity = ergoProfileIdentity(owned), depth = owned.depth;
  const byId = new Map<string, ErgoHeaderView>();
  let origin: bigint | undefined;
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!, previous = headers[i - 1];
    if (header.version > 255n || byId.has(bytesToHex(header.id))) return undefined;
    if (previous !== undefined && (header.height !== previous.height + 1n || compareBytes(header.parentId, previous.id) !== 0)) return undefined;
    // The anchor's child is index 0. A linked chain names that parent once unless
    // it also carries the anchor's id at some height, which no authenticated source
    // does; two candidates for index 0 give no verifier rather than the later one.
    if (compareBytes(header.parentId, owned.anchor) === 0) {
      if (origin !== undefined) return undefined;
      origin = header.height;
    }
    byId.set(bytesToHex(header.id), header);
  }
  if (origin === undefined) return undefined;
  const tip = (headers[headers.length - 1] as ErgoHeaderView).height;
  if (tip < origin + depth) return undefined;
  const sectionAt = new Map<bigint, readonly AttributedObject[]>();
  for (const supplied of evidence.blocks) {
    if (supplied === null || typeof supplied !== "object") continue;
    const { headerId, transactions } = supplied;
    if (!isBytes(headerId, 32) || !Array.isArray(transactions)) continue;
    // The header is found, from an owned copy of its id, before any transaction is read. Sections at or below the
    // anchor hold no index and are not read, nor is a second section for one index. Every header version has its
    // section: the node checks a block's version only at a voting epoch's first block, so a gate on it would let any
    // miner deny every range through its block.
    const header = byId.get(bytesToHex(copyBytes(headerId)));
    if (header === undefined || header.height < origin || sectionAt.has(header.height - origin)) continue;
    const objects = attributeOwnedSection(owned, transactions, header.transactionsRoot);
    if (objects !== undefined) sectionAt.set(header.height - origin, objects);
  }
  // Index `i` is height `origin + i`; index `i` is witnessed once the tip is at `origin + i + depth`.
  const witnessed = tip - depth - origin;
  return Object.freeze({
    get identity() { return copyBytes(identity); },
    lag: () => depth + 1n,
    witnessedIndex: () => witnessed,
    range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined {
      // The request is read once, into the reader's own copy, before anything is judged.
      let own: RangeRequest;
      try { own = copyRequest(request); } catch (error) {
        if (error instanceof EncodingError) return undefined;
        throw error;
      }
      if (compareBytes(own.venue, identity) !== 0 || own.toIndex > witnessed) return undefined;
      const entries = rangeEntries(index => sectionAt.get(index), own);
      return entries === undefined ? undefined : encodeRangeAnswer({ request: own, entries }, limits);
    },
  });
}

/** §7's entries for an owned request over the attributed sections a reader
 * holds by index: index by index, every object of the request's kind and
 * subject, for kind 4 in ordinal order carrying the ordinal, for kinds 1–3
 * with ordinal zero in ascending record-byte order. Undefined where an index
 * of the range has no section. The caller checks the venue and that
 * `toIndex` is witnessed. */
export function rangeEntries(sectionAt: (index: bigint) => readonly AttributedObject[] | undefined, request: RangeRequest): RangeEntry[] | undefined {
  const entries: RangeEntry[] = [];
  for (let index = request.fromIndex; index <= request.toIndex; index++) {
    const objects = sectionAt(index);
    if (objects === undefined) return undefined;
    const matching = objects
      .filter(object => object.kind === request.kind && compareBytes(object.subject, request.subject) === 0)
      .map(object => ({ index, ordinal: request.kind === PUBLICATION_RANGE ? object.ordinal : 0n, record: copyBytes(object.record) }));
    if (request.kind !== PUBLICATION_RANGE) matching.sort((a, b) => compareBytes(a.record, b.record));
    for (const entry of matching) entries.push(entry);
  }
  return entries;
}
