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
import { encodeRangeAnswer, isWellFormedRequest, MAX_RANGE_RECORD_BYTES, PUBLICATION_RANGE,
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
function requireProfile(profile: ErgoProfile): void {
  if (profile === null || typeof profile !== "object" || !isBytes(profile.genesis, 32) || !u64(profile.depth) ||
      profile.depth === MAX_U64 || profile.scripts === null || typeof profile.scripts !== "object") {
    throw new EncodingError("invalid Ergo profile");
  }
  for (const kind of RECORD_KINDS) {
    const script = profile.scripts[kind];
    if (!isBytes(script) || script.length === 0) throw new EncodingError("invalid Ergo profile script");
    // One location attributes to one kind; two kinds at one script would make one object two objects.
    for (const other of RECORD_KINDS) {
      if (other < kind && compareBytes(profile.scripts[other], script) === 0) throw new EncodingError("two kinds at one location");
    }
  }
}
/** Naming the venue is agreeing the chain, the depth and the attribution rule (C2.3.2, §13.1). */
export function ergoProfileIdentity(profile: ErgoProfile): Uint8Array {
  requireProfile(profile);
  const w = new ByteWriter();
  w.lengthPrefixed(utf8Encoder.encode(ERGO_PROFILE_CONTEXT));
  w.key32(profile.genesis, "genesis header id");
  w.u64(profile.depth);
  for (const kind of RECORD_KINDS) w.lengthPrefixed(profile.scripts[kind]);
  return sha256(w.finish());
}
/** C2.3.5: a transaction submitted at clock `c` lands at height `c + depth + 1` at the earliest. */
export function ergoLag(profile: ErgoProfile): bigint {
  requireProfile(profile);
  return profile.depth + 1n;
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
/** Block version 1 commits to the transaction ids alone; later versions to
 * all ids followed by all witness ids, as the pinned node reads them. */
export function transactionsRoot(version: bigint, transactions: readonly ErgoTransactionView[]): Uint8Array {
  const ids = transactions.map(transaction => transaction.id);
  return merkleRoot(version === 1n ? ids : [...ids, ...transactions.map(transaction => transaction.witnessId)]);
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
 * `Coll[Byte]` (the subject) and R5 a `Coll[Byte]` (the bytes). Other
 * registers are not read. */
function attributeOutput(profile: ErgoProfile, output: ErgoOutputView): Piece | undefined {
  if (output === null || typeof output !== "object" || !isBytes(output.ergoTree) ||
      output.registers === null || typeof output.registers !== "object") throw new EncodingError("invalid Ergo output view");
  const kind = RECORD_KINDS.find(candidate => compareBytes(profile.scripts[candidate], output.ergoTree) === 0);
  if (kind === undefined) return undefined;
  const r4 = output.registers["R4"], r5 = output.registers["R5"];
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
/** Every object the profile attributes in one block's transaction section,
 * in venue order. Kinds 1–3 are one output each, at exactly the kind's
 * length. A kind-4 object is the maximal run of adjacent outputs of one
 * transaction at the kind-4 location with one subject, its record the
 * pieces' bytes in output order, its ordinal the first output's; a run
 * longer than the kind's bound is no object. */
export function attributeBlock(profile: ErgoProfile, transactions: readonly ErgoTransactionView[]): readonly AttributedObject[] {
  requireProfile(profile);
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
      at = end - 1;
    }
  });
  return Object.freeze(objects);
}

/** The shape `scripts/pool/v3/local-replay.mjs` reads: the venue's constants
 * and one §13 answer per request, or none where the evidence does not establish it. */
export interface ErgoRangeVerifier {
  readonly identity: Uint8Array;
  lag(): bigint;
  witnessedIndex(): bigint;
  range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined;
}
function requireEvidence(evidence: ErgoRangeEvidence): void {
  if (evidence === null || typeof evidence !== "object" || !Array.isArray(evidence.headers) || !Array.isArray(evidence.blocks)) {
    throw new EncodingError("invalid Ergo range evidence");
  }
  for (const header of evidence.headers) {
    if (header === null || typeof header !== "object" || !isBytes(header.id, 32) || !isBytes(header.parentId, 32) ||
        !isBytes(header.transactionsRoot, 32) || !u64(header.height) || !u64(header.version)) throw new EncodingError("invalid Ergo header view");
  }
  for (const block of evidence.blocks) {
    if (block === null || typeof block !== "object" || !isBytes(block.headerId, 32) || !Array.isArray(block.transactions)) {
      throw new EncodingError("invalid Ergo block view");
    }
    for (const transaction of block.transactions) {
      if (transaction === null || typeof transaction !== "object" || !isBytes(transaction.id, 32) || !isBytes(transaction.witnessId, 31) ||
          !Array.isArray(transaction.outputs)) throw new EncodingError("invalid Ergo transaction view");
      for (const output of transaction.outputs) {
        if (output === null || typeof output !== "object" || !isBytes(output.ergoTree) || output.registers === null ||
            typeof output.registers !== "object" || Object.values(output.registers).some(value => !isBytes(value))) {
          throw new EncodingError("invalid Ergo output view");
        }
      }
    }
  }
}
/** §13.2 over the reader's retained evidence. The headers must be one
 * contiguous linked chain; a chain starting at height 1 must start at the
 * profile's genesis; every block must belong to a header and reproduce its
 * transaction root. Otherwise there is no verifier, as there is no answer
 * for a request the evidence does not cover: a range not yet witnessed under
 * the depth, a height without its block, or heights below the first header
 * unless the chain is anchored at the genesis, below which nothing exists.
 * Evidence is read once here; nothing of the caller's is read later. */
export function ergoRangeVerifier(profile: ErgoProfile, evidence: ErgoRangeEvidence): ErgoRangeVerifier | undefined {
  requireProfile(profile);
  requireEvidence(evidence);
  const identity = ergoProfileIdentity(profile), { headers, blocks } = evidence, depth = profile.depth;
  const first = headers[0];
  if (first === undefined || first.height < GENESIS_HEIGHT) return undefined;
  if (first.height === GENESIS_HEIGHT && (compareBytes(first.parentId, ZERO32) !== 0 || compareBytes(first.id, profile.genesis) !== 0)) return undefined;
  const byId = new Map<string, ErgoHeaderView>();
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i]!, previous = headers[i - 1];
    if (header.version < 1n || header.version > 255n || byId.has(bytesToHex(header.id))) return undefined;
    if (previous !== undefined && (header.height !== previous.height + 1n || compareBytes(header.parentId, previous.id) !== 0)) return undefined;
    byId.set(bytesToHex(header.id), header);
  }
  const objectsAt = new Map<bigint, readonly AttributedObject[]>();
  for (const block of blocks) {
    const header = byId.get(bytesToHex(block.headerId));
    if (header === undefined || objectsAt.has(header.height) || block.transactions.length === 0 ||
        compareBytes(transactionsRoot(header.version, block.transactions), header.transactionsRoot) !== 0) return undefined;
    try {
      objectsAt.set(header.height, attributeBlock(profile, block.transactions));
    } catch (error) {
      if (error instanceof EncodingError) return undefined;
      throw error;
    }
  }
  const firstHeight = first.height, tip = headers[headers.length - 1]!.height, witnessed = tip > depth ? tip - depth : 0n;
  return Object.freeze({
    get identity() { return copyBytes(identity); },
    lag: () => depth + 1n,
    witnessedIndex: () => witnessed,
    range(request: RangeRequest, limits: RangeLimits): Uint8Array | undefined {
      if (!isWellFormedRequest(request) || compareBytes(request.venue, identity) !== 0 || request.toIndex > witnessed) return undefined;
      const low = request.fromIndex < GENESIS_HEIGHT ? GENESIS_HEIGHT : request.fromIndex;
      if (low < firstHeight) return undefined;
      const entries: RangeEntry[] = [];
      for (let height = low; height <= request.toIndex; height++) {
        const objects = objectsAt.get(height);
        if (objects === undefined) return undefined;
        const matching = objects
          .filter(object => object.kind === request.kind && compareBytes(object.subject, request.subject) === 0)
          .map(object => ({ index: height, ordinal: request.kind === PUBLICATION_RANGE ? object.ordinal : 0n, record: copyBytes(object.record) }));
        if (request.kind !== PUBLICATION_RANGE) matching.sort((a, b) => compareBytes(a.record, b.record));
        for (const entry of matching) entries.push(entry);
      }
      return encodeRangeAnswer({ request, entries }, limits);
    },
  });
}
