// Local application envelopes. Protocol records keep their construction's bytes;
// JSON is never signed and package metadata is never verification authority.
// One profile serves either construction (slice 14 M14g3): the records,
// receipts and packages it carries are the journal's construction's, read
// through its codecs, and every one names its configuration domain.
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { POOL_V3, type Construction } from "./construction.js";
import type { EvidencePart, TrailTip } from "./evidence-store.js";
import type { ServedEvidence, ServedPackage } from "./store.js";

export const V3_SERVICE_PROFILE = "pool-store/v3";
export const MAX_V3_SERVICE_REQUEST_BYTES = 300_000;
export const MAX_V3_SERVICE_REPLY_BYTES = 4096;
const MAX_RECORD_BYTES = 135_000;
/** A receipt's bytes: pool-v3's are 355, lit-v1's 290; the construction's decoder takes its exact length. */
const MAX_RECEIPT_BYTES = 512;
const v3 = POOL_V3 as Construction;
type Obj = Record<string, unknown>;
function object(value: unknown): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EncodingError("expected object");
  return { ...value };
}
function fields(value: Obj, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new EncodingError("unexpected service fields");
  }
}
function envelope(value: unknown): Obj {
  const r = object(value);
  if (r.version !== 1 || r.profile !== V3_SERVICE_PROFILE) throw new EncodingError("wrong service profile");
  return r;
}
function hex(value: unknown, max: number, exact = false): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > max * 2 || value.length % 2 !== 0 ||
      (exact && value.length !== max * 2) || !/^[0-9a-f]+$/.test(value)) throw new EncodingError("invalid service hex");
  return hexToBytes(value);
}

export type V3ServiceCommand =
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "submit"; record: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "commit"; id: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "publish" };
export type V3ServiceReply =
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "accepted"; receipt: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "committed" | "published"; commitment: string };

/** A command, its record of `construction` (pool-v3's by default). */
export function parseV3ServiceCommand(value: unknown, construction: Construction = v3): V3ServiceCommand {
  const r = envelope(value);
  if (r.kind === "submit") {
    fields(r, ["version", "profile", "kind", "record"]);
    const bytes = hex(r.record, MAX_RECORD_BYTES), record = construction.decode(bytes);
    if (construction.kind(record) === 7) throw new EncodingError("a request is not a segment admission");
    if (bytesToHex(construction.journal.encode(record)) !== r.record) throw new EncodingError("noncanonical record");
    return { version: 1, profile: V3_SERVICE_PROFILE, kind: "submit", record: bytesToHex(bytes) };
  }
  if (r.kind === "commit") {
    fields(r, ["version", "profile", "kind", "id"]);
    if (typeof r.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(r.id)) throw new EncodingError("invalid command id");
    return { version: 1, profile: V3_SERVICE_PROFILE, kind: "commit", id: r.id };
  }
  if (r.kind === "publish") {
    fields(r, ["version", "profile", "kind"]); return { version: 1, profile: V3_SERVICE_PROFILE, kind: "publish" };
  }
  throw new EncodingError("unsupported service command");
}

/** A reply, its receipt of `construction` (pool-v3's by default). */
export function decodeV3ServiceReply(value: unknown, construction: Construction = v3): V3ServiceReply {
  const r = envelope(value);
  if (r.kind === "accepted") {
    fields(r, ["version", "profile", "kind", "receipt"]);
    const bytes = hex(r.receipt, MAX_RECEIPT_BYTES), codec = construction.journal.receipts;
    if (bytesToHex(codec.encode(codec.decode(bytes))) !== r.receipt) throw new EncodingError("noncanonical receipt");
    return { version: 1, profile: V3_SERVICE_PROFILE, kind: "accepted", receipt: bytesToHex(bytes) };
  }
  if (r.kind === "committed" || r.kind === "published") {
    fields(r, ["version", "profile", "kind", "commitment"]);
    const bytes = hex(r.commitment, 136, true);
    if (bytesToHex(encodeCommitment(decodeCommitment(bytes))) !== r.commitment) throw new EncodingError("noncanonical commitment");
    return { version: 1, profile: V3_SERVICE_PROFILE, kind: r.kind, commitment: bytesToHex(bytes) };
  }
  throw new EncodingError("unsupported service reply");
}

export function replyFromReceipt(bytes: Uint8Array, construction: Construction = v3): V3ServiceReply {
  return decodeV3ServiceReply({ version: 1, profile: V3_SERVICE_PROFILE, kind: "accepted", receipt: bytesToHex(bytes) }, construction);
}
export function replyFromCommitment(kind: "committed" | "published", commitment: Commitment): V3ServiceReply {
  return decodeV3ServiceReply({ version: 1, profile: V3_SERVICE_PROFILE, kind, commitment: bytesToHex(encodeCommitment(commitment)) });
}

// Served evidence is a byte stream, not JSON: a history has no size to cap (§14).
//   served = "pool-store/v3/served" || domain[32] || venue[32] || backing[32] || operator[32] || u64 sequence || root[32]
//            || u32 n || package[n] || part* || u8 0
//   part   = u8 1 || u32 n || package[n]
//          | u8 2 || u8 0 || u64 size || bytes[size]
//          | u8 2 || u8 1 || segment[32] || u64 position || evidence[32] || u64 size || bytes[size]
// The first package holds the read's own items; each part is an EvidencePart. Integers are big-endian. The
// frame carries existing v3 bytes and adds none: a receiver's evidence store authenticates what it keeps.
const SERVED = utf8ToBytes("pool-store/v3/served");
/** The read's own package: a configuration and one commitment. */
const MAX_OWN_PACKAGE_BYTES = 65_536;
/** One package part: a supplier sends objects in parts of about 1 MiB, and one object is at most 1 MiB. */
export const MAX_V3_SERVED_PART_BYTES = 4_194_304;
const u32 = (value: number): Uint8Array => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, false); return out; };
const u64 = (value: bigint): Uint8Array => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, false); return out; };

/** A journal's served evidence as the bytes a transport sends, in chunks: one part, or one piece of a trail, at a time. */
export async function* servedFrames(served: ServedEvidence): AsyncIterable<Uint8Array> {
  const s = served.selection, fixed = (value: Uint8Array): Uint8Array => {
    if (!(value instanceof Uint8Array) || value.length !== 32) throw new EncodingError("expected a 32-byte service identity");
    return value;
  };
  if (typeof s.sequence !== "bigint" || s.sequence < 1n || s.sequence >= 1n << 64n) throw new EncodingError("invalid service sequence");
  if (served.package.length > MAX_OWN_PACKAGE_BYTES) throw new EncodingError("served package too large");
  yield concatBytes(SERVED, fixed(s.domain), fixed(s.venue), fixed(s.backing), fixed(s.operator), u64(s.sequence), fixed(s.root),
    u32(served.package.length), served.package);
  for await (const part of served.parts) {
    if ("package" in part) {
      if (part.package.length > MAX_V3_SERVED_PART_BYTES) throw new EncodingError("served package part too large");
      yield concatBytes(Uint8Array.of(1), u32(part.package.length), part.package);
      continue;
    }
    const { after, size } = part.trail;
    yield after === undefined ? concatBytes(Uint8Array.of(2, 0), u64(size)) :
      concatBytes(Uint8Array.of(2, 1), fixed(after.segment), u64(after.position), fixed(after.evidence), u64(size));
    let sent = 0n;
    for await (const chunk of part.trail.chunks) { sent += BigInt(chunk.length); yield chunk; }
    // The stated size framed what follows: a trail that read back otherwise leaves the stream unusable.
    if (sent !== size) throw new EncodingError("a served trail is not its stated size");
  }
  yield Uint8Array.of(0);
}

/** Reads a byte stream by exact counts. */
class Pull {
  readonly #source: AsyncIterator<Uint8Array>;
  #held: Uint8Array = new Uint8Array(0);
  #at = 0;
  constructor(source: AsyncIterable<Uint8Array>) { this.#source = source[Symbol.asyncIterator](); }
  async #more(): Promise<boolean> {
    while (this.#at >= this.#held.length) {
      const next = await this.#source.next();
      if (next.done === true) return false;
      if (!(next.value instanceof Uint8Array)) throw new EncodingError("served evidence is not bytes");
      this.#held = next.value; this.#at = 0;
    }
    return true;
  }
  /** Exactly `n` bytes, copied. */
  async take(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    for (let got = 0; got < n;) {
      if (!await this.#more()) throw new EncodingError("truncated served evidence");
      const piece = this.#held.subarray(this.#at, this.#at + (n - got));
      out.set(piece, got); got += piece.length; this.#at += piece.length;
    }
    return out;
  }
  /** Exactly `n` bytes as they arrive, not copied: the receiver copies what it keeps. */
  async *pieces(n: bigint): AsyncIterable<Uint8Array> {
    for (let left = n; left > 0n;) {
      if (!await this.#more()) throw new EncodingError("truncated served evidence");
      const available = this.#held.length - this.#at, want = left < BigInt(available) ? Number(left) : available;
      const piece = this.#held.subarray(this.#at, this.#at + want);
      this.#at += want; left -= BigInt(want);
      yield piece;
    }
  }
  async ended(): Promise<boolean> { return !await this.#more(); }
}

/**
 * Framing only. Reads a served stream: the selection and the read's own package, then each part as it
 * arrives, to the end mark and the exact end of the stream. `take` is given the selection first, so it can
 * refuse another context before any part, and then the parts (an evidence store's `take` keeps them).
 * Metadata never selects a reader's authority, and the independent reader verifies all kept evidence.
 * A trail's bytes that `take` leaves unread are skipped. EncodingError for a stream that does not frame.
 */
export async function readServed<T>(source: AsyncIterable<Uint8Array>, take: (served: ServedPackage, parts: AsyncIterable<EvidencePart>) => Promise<T>):
  Promise<{ readonly served: ServedPackage; readonly taken: T }> {
  const pull = new Pull(source), view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const head = await pull.take(SERVED.length + 172), at = SERVED.length;
  if (bytesToHex(head.subarray(0, at)) !== bytesToHex(SERVED)) throw new EncodingError("wrong service profile");
  const sequence = view(head).getBigUint64(at + 128, false);
  if (sequence === 0n) throw new EncodingError("invalid service sequence");
  const length = view(head).getUint32(at + 168, false);
  if (length > MAX_OWN_PACKAGE_BYTES) throw new EncodingError("served package too large");
  const served: ServedPackage = { selection: { domain: head.slice(at, at + 32), venue: head.slice(at + 32, at + 64), backing: head.slice(at + 64, at + 96),
    operator: head.slice(at + 96, at + 128), sequence, root: head.slice(at + 136, at + 168) }, package: await pull.take(length) };
  let ended = false;
  const parts = async function* (): AsyncIterable<EvidencePart> {
    for (;;) {
      const [tag] = await pull.take(1);
      if (tag === 0) break;
      if (tag === 1) {
        const n = view(await pull.take(4)).getUint32(0, false);
        if (n > MAX_V3_SERVED_PART_BYTES) throw new EncodingError("served package part too large");
        yield { package: await pull.take(n) };
      } else if (tag === 2) {
        const [based] = await pull.take(1);
        if (based !== 0 && based !== 1) throw new EncodingError("unsupported served part");
        let after: TrailTip | undefined;
        if (based === 1) {
          const tip = await pull.take(72);
          after = { segment: tip.slice(0, 32), position: view(tip).getBigUint64(32, false), evidence: tip.slice(40, 72) };
        }
        const size = view(await pull.take(8)).getBigUint64(0, false);
        let left = size;
        const chunks = async function* (): AsyncIterable<Uint8Array> {
          for await (const piece of pull.pieces(size)) { left -= BigInt(piece.length); yield piece; }
        };
        yield { trail: { after, size, chunks: chunks() } };
        for await (const _ of pull.pieces(left)) left -= BigInt(_.length);
      } else throw new EncodingError("unsupported served part");
    }
    if (!await pull.ended()) throw new EncodingError("trailing served bytes");
    ended = true;
  };
  const taken = await take(served, parts());
  if (!ended) throw new EncodingError("served evidence was not read to its end");
  return { served, taken };
}
