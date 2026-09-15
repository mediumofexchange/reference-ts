// Ergo venue-profile candidate for pool-v3 §13 answers.
//
// A venue is named with its finality rule and lag (C2.3.2, C2.3.5), and §13.1
// makes the attribution rule part of that name: how an object at the venue is
// assigned to a record kind and subject and how its exact bytes are
// reassembled. This candidate fixes all three for an Ergo chain and reads the
// record from full blocks: every output of every transaction of every block in
// the range, each block's transaction section checked against its header's
// transaction root, so absence is proven by exhaustion (§13.2). It applies no
// signature, sequence, kind or content rule; the reader's §13.3 rules do.
// The header chain is the reader's own authenticated header source, checked
// here only for contiguity, linkage and the genesis anchor. No specification
// selects this profile and no runtime path reads it; `src/ergo.ts` remains
// the v2 materialized view with its own identity.
import { blake2b } from "@noble/hashes/blake2b.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ByteWriter, compareBytes, copyBytes, EncodingError } from "../src/bytes.js";
import { utf8Encoder } from "../src/contexts.js";
import { copyRequest, encodeRangeAnswer, MAX_RANGE_RECORD_BYTES, PUBLICATION_RANGE,
  type RangeEntry, type RangeLimits, type RangeRequest, type RecordKind } from "./pool-v3-range.js";

export const ERGO_PROFILE_CONTEXT = "moe/venue/ergo/v2";
export const RECORD_KINDS: readonly RecordKind[] = Object.freeze([1, 2, 3, 4]);
const MAX_U64 = (1n << 64n) - 1n, MAX_U32 = 0xffff_ffffn, COLL_BYTE_TYPE = 0x0e, GENESIS_HEIGHT = 1n;
const ZERO32 = new Uint8Array(32);
const u64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= MAX_U64;
const isBytes = (v: unknown, width?: number): v is Uint8Array =>
  v instanceof Uint8Array && !(v.buffer instanceof SharedArrayBuffer) && (width === undefined || v.length === width);

/** What the venue identity names: the chain by its genesis header, the
 * finality depth, and one location (an exact ErgoTree) per record kind. */
export interface ErgoProfile {
  readonly genesis: Uint8Array;
  readonly depth: bigint;
  readonly scripts: Readonly<Record<RecordKind, Uint8Array>>;
}
/** The profile is read once and owned: the identity is hashed over, and every
 * output attributed by, the same bytes (§13.1: two attribution rules are two venues). */
function ownProfile(profile: ErgoProfile): ErgoProfile {
  if (profile === null || typeof profile !== "object") throw new EncodingError("invalid Ergo profile");
  const { genesis, depth, scripts } = profile;
  if (!isBytes(genesis, 32) || !u64(depth) || depth === MAX_U64 || scripts === null || typeof scripts !== "object") {
    throw new EncodingError("invalid Ergo profile");
  }
  const owned: Partial<Record<RecordKind, Uint8Array>> = {};
  for (const kind of RECORD_KINDS) {
    const script = scripts[kind];
    if (!isBytes(script) || script.length === 0) throw new EncodingError("invalid Ergo profile script");
    owned[kind] = copyBytes(script);
  }
  // One location attributes to one kind; two kinds at one script would make one object two objects.
  for (const kind of RECORD_KINDS) {
    for (const other of RECORD_KINDS) {
      if (other < kind && compareBytes(owned[other]!, owned[kind]!) === 0) throw new EncodingError("two kinds at one location");
    }
  }
  return Object.freeze({ genesis: copyBytes(genesis), depth, scripts: Object.freeze(owned as Record<RecordKind, Uint8Array>) });
}
/** Naming the venue is agreeing the chain, the depth and the attribution rule (C2.3.2, §13.1). */
export function ergoProfileIdentity(profile: ErgoProfile): Uint8Array {
  const owned = ownProfile(profile), w = new ByteWriter();
  w.lengthPrefixed(utf8Encoder.encode(ERGO_PROFILE_CONTEXT));
  w.key32(owned.genesis, "genesis header id");
  w.u64(owned.depth);
  for (const kind of RECORD_KINDS) w.lengthPrefixed(owned.scripts[kind]);
  return sha256(w.finish());
}
/** C2.3.5: a transaction submitted at clock `c` lands at height `c + depth + 1` at the earliest. */
export function ergoLag(profile: ErgoProfile): bigint {
  return ownProfile(profile).depth + 1n;
}

/** Header fields the verifier reads; the reader's header source authenticates them. */
export interface ErgoHeaderView {
  readonly id: Uint8Array;
  readonly parentId: Uint8Array;
  readonly height: bigint;
  readonly version: bigint;
  readonly transactionsRoot: Uint8Array;
}
/** One output as the reader's own decoder derived it from the transaction's
 * exact bytes: the ErgoTree bytes and each present register's serialized constant. */
export interface ErgoOutputView { readonly ergoTree: Uint8Array; readonly registers: Readonly<Record<string, Uint8Array>> }
/** A transaction's id (32 bytes), its 31-byte witness id and its outputs in order. */
export interface ErgoTransactionView { readonly id: Uint8Array; readonly witnessId: Uint8Array; readonly outputs: readonly ErgoOutputView[] }
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
/** Block versions above 1 commit to all transaction ids followed by all
 * witness ids; version 1 to the ids alone, as the pinned node reads them. */
export function transactionsRoot(version: bigint, transactions: readonly ErgoTransactionView[]): Uint8Array {
  const ids = transactions.map(transaction => transaction.id);
  return merkleRoot(version > 1n ? [...ids, ...transactions.map(transaction => transaction.witnessId)] : ids);
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
function attributeOwned(profile: ErgoProfile, transactions: readonly ErgoTransactionView[]): readonly AttributedObject[] {
  if (!Array.isArray(transactions)) throw new EncodingError("invalid Ergo transactions");
  const objects: AttributedObject[] = [];
  transactions.forEach((transaction, position) => {
    if (transaction === null || typeof transaction !== "object" || !Array.isArray(transaction.outputs)) throw new EncodingError("invalid Ergo transaction view");
    const { outputs } = transaction;
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
/** Every view is read once, field by field, into an owned frozen copy
 * before anything is judged, so no accessor can pass one value to a check
 * and another to a use. A malformed view is undefined. */
function ownOutput(output: ErgoOutputView): ErgoOutputView | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const { ergoTree, registers } = output;
  if (!isBytes(ergoTree) || registers === null || typeof registers !== "object") return undefined;
  // A null prototype, so a register named like a prototype property is an own entry like any other.
  const ownedRegisters: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [name, value] of Object.entries(registers)) {
    if (!isBytes(value)) return undefined;
    ownedRegisters[name] = copyBytes(value);
  }
  return Object.freeze({ ergoTree: copyBytes(ergoTree), registers: Object.freeze(ownedRegisters) });
}
function ownTransaction(transaction: ErgoTransactionView): ErgoTransactionView | undefined {
  if (transaction === null || typeof transaction !== "object") return undefined;
  const { id, witnessId, outputs } = transaction;
  if (!isBytes(id, 32) || !isBytes(witnessId, 31) || !Array.isArray(outputs)) return undefined;
  const ownedOutputs: ErgoOutputView[] = [];
  for (const output of outputs) {
    const owned = ownOutput(output);
    if (owned === undefined) return undefined;
    ownedOutputs.push(owned);
  }
  return Object.freeze({ id: copyBytes(id), witnessId: copyBytes(witnessId), outputs: Object.freeze(ownedOutputs) });
}
function ownBlock(block: ErgoBlockView): ErgoBlockView | undefined {
  if (block === null || typeof block !== "object") return undefined;
  const { headerId, transactions } = block;
  if (!isBytes(headerId, 32) || !Array.isArray(transactions)) return undefined;
  const ownedTransactions: ErgoTransactionView[] = [];
  for (const transaction of transactions) {
    const owned = ownTransaction(transaction);
    if (owned === undefined) return undefined;
    ownedTransactions.push(owned);
  }
  return Object.freeze({ headerId: copyBytes(headerId), transactions: Object.freeze(ownedTransactions) });
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
 * longer than the kind's bound is no object. */
export function attributeBlock(profile: ErgoProfile, transactions: readonly ErgoTransactionView[]): readonly AttributedObject[] {
  const owned = ownProfile(profile);
  if (!Array.isArray(transactions)) throw new EncodingError("invalid Ergo transactions");
  const ownedTransactions = transactions.map(ownTransaction);
  if (ownedTransactions.some(transaction => transaction === undefined)) throw new EncodingError("invalid Ergo transaction view");
  return attributeOwned(owned, ownedTransactions as ErgoTransactionView[]);
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
 * chain, or a chain starting at height 1 that does not start at the
 * profile's genesis, give no verifier. Blocks may come from any supplier:
 * a block supplies the section of a height only where it is a well-formed
 * view, belongs to a header of the chain and reproduces that header's
 * transaction root; any other block is passed over, so no supplier can deny
 * every read by adding a block, and a height whose section is missing
 * leaves only the ranges through it unresolved. There is no answer for a
 * range not yet witnessed under the depth, for a height without its
 * section, or for heights below the first header unless the chain is
 * anchored at the genesis, below which nothing exists. Every field of the
 * profile, of each header, block, transaction and output, and of each
 * request is read once into an owned copy before it is judged; only the two
 * evidence arrays are read as containers, and every element of the array
 * that is iterated is owned. */
export function ergoRangeVerifier(profile: ErgoProfile, evidence: ErgoRangeEvidence): ErgoRangeVerifier | undefined {
  const owned = ownProfile(profile);
  if (evidence === null || typeof evidence !== "object" || !Array.isArray(evidence.headers) || !Array.isArray(evidence.blocks)) {
    throw new EncodingError("invalid Ergo range evidence");
  }
  const headers = evidence.headers.map(ownHeader);
  if (headers.some(header => header === undefined)) throw new EncodingError("invalid Ergo header view");
  const identity = ergoProfileIdentity(owned), depth = owned.depth;
  const first = headers[0];
  if (first === undefined || first.height < GENESIS_HEIGHT) return undefined;
  if (first.height === GENESIS_HEIGHT && (compareBytes(first.parentId, ZERO32) !== 0 || compareBytes(first.id, owned.genesis) !== 0)) return undefined;
  const byId = new Map<string, ErgoHeaderView>();
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!, previous = headers[i - 1];
    if (header.version < 1n || header.version > 255n || byId.has(bytesToHex(header.id))) return undefined;
    if (previous !== undefined && (header.height !== previous.height + 1n || compareBytes(header.parentId, previous.id) !== 0)) return undefined;
    byId.set(bytesToHex(header.id), header);
  }
  const sectionAt = new Map<bigint, readonly AttributedObject[]>();
  for (const supplied of evidence.blocks) {
    const block = ownBlock(supplied);
    if (block === undefined) continue;
    const header = byId.get(bytesToHex(block.headerId));
    if (header === undefined || sectionAt.has(header.height) || block.transactions.length === 0 ||
        compareBytes(transactionsRoot(header.version, block.transactions), header.transactionsRoot) !== 0) continue;
    try {
      sectionAt.set(header.height, attributeOwned(owned, block.transactions));
    } catch (error) {
      if (error instanceof EncodingError) continue;
      throw error;
    }
  }
  const firstHeight = first.height, tip = (headers[headers.length - 1] as ErgoHeaderView).height, witnessed = tip > depth ? tip - depth : 0n;
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
      const low = own.fromIndex < GENESIS_HEIGHT ? GENESIS_HEIGHT : own.fromIndex;
      if (low < firstHeight) return undefined;
      const entries: RangeEntry[] = [];
      for (let height = low; height <= own.toIndex; height++) {
        const objects = sectionAt.get(height);
        if (objects === undefined) return undefined;
        const matching = objects
          .filter(object => object.kind === own.kind && compareBytes(object.subject, own.subject) === 0)
          .map(object => ({ index: height, ordinal: own.kind === PUBLICATION_RANGE ? object.ordinal : 0n, record: copyBytes(object.record) }));
        if (own.kind !== PUBLICATION_RANGE) matching.sort((a, b) => compareBytes(a.record, b.record));
        for (const entry of matching) entries.push(entry);
      }
      return encodeRangeAnswer({ request: own, entries }, limits);
    },
  });
}
