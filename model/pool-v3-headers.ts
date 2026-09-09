// Byte conformance for pool-v3 §8 at 061f87e. No adopted configuration,
// opening replay, key authentication, checkpoint classification or finality.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, compareBytes, EncodingError } from "../src/bytes.js";

const CONTEXT = new TextEncoder().encode("moe/pool/v3/segment");
const PREFIX_BYTES = 127, ENTRY_BYTES = 136;
export const MAX_ENTRIES = 65536;
export const MAX_HEADER_BYTES = PREFIX_BYTES + ENTRY_BYTES * MAX_ENTRIES;
const MAX_U64 = (1n << 64n) - 1n;

export interface OpeningCheckpoint {
  readonly operator: Uint8Array;
  readonly sequence: bigint;
  readonly root: Uint8Array;
}
export interface SegmentEntry {
  readonly backing: Uint8Array;
  readonly link: Uint8Array;
  /** Absent asserts an empty opening; the record must establish that assertion. */
  readonly opening?: OpeningCheckpoint;
}
export interface SegmentHeader {
  readonly domain: Uint8Array;
  readonly venue: Uint8Array;
  readonly operator: Uint8Array;
  readonly sequence: bigint;
  readonly entries: readonly SegmentEntry[];
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const bytes32 = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.length === 32;
const positiveU64 = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n && v <= MAX_U64;

/** Structural checks only. Key bytes are authenticated by strict signature
 * verification against the expected commitment, never by this predicate. */
export function isWellFormedHeader(h: unknown): h is SegmentHeader {
  if (!object(h) || !bytes32(h["domain"]) || !bytes32(h["venue"]) || !bytes32(h["operator"]) ||
      !positiveU64(h["sequence"])) return false;
  const entries = h["entries"];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES) return false;
  for (let i = 0; i < entries.length; i++) {
    const e: unknown = entries[i];
    if (!object(e) || !bytes32(e["backing"]) || !bytes32(e["link"])) return false;
    if (i > 0 && compareBytes((entries[i - 1] as SegmentEntry).backing, e["backing"]) >= 0) return false;
    const o = e["opening"];
    if (o === undefined) continue;
    if (!object(o) || !bytes32(o["operator"]) || !positiveU64(o["sequence"]) || !bytes32(o["root"])) return false;
    if (compareBytes(o["operator"], h["operator"]) === 0 && o["sequence"] >= h["sequence"]) return false;
  }
  return true;
}

export function segmentBytes(header: SegmentHeader): Uint8Array {
  if (!isWellFormedHeader(header)) throw new EncodingError("malformed v3 segment header");
  // Fixed-size output avoids an expanding per-byte JS array at maximum scope.
  const out = new Uint8Array(PREFIX_BYTES + ENTRY_BYTES * header.entries.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  const put = (b: Uint8Array): void => { out.set(b, offset); offset += b.length; };
  const u64 = (n: bigint): void => { view.setBigUint64(offset, n, false); offset += 8; };
  put(CONTEXT); put(header.domain); put(header.venue); put(header.operator); u64(header.sequence);
  view.setUint32(offset, header.entries.length, false); offset += 4;
  for (const entry of header.entries) {
    put(entry.backing); put(entry.link);
    if (entry.opening === undefined) offset += 72; // Allocated zero sentinel.
    else { u64(entry.opening.sequence); put(entry.opening.operator); put(entry.opening.root); }
  }
  return out;
}

export function segmentIdentity(header: SegmentHeader): Uint8Array { return sha256(segmentBytes(header)); }

/** Owns decoded byte fields, including when the input is a Node Buffer.
 * Refusal is a structural error, never an operator-fault verdict. */
export function decodeSegmentHeader(bytes: Uint8Array): SegmentHeader {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX_BYTES + ENTRY_BYTES || bytes.length > MAX_HEADER_BYTES) {
    throw new EncodingError("v3 segment header byte bound");
  }
  const r = new ByteReader(bytes);
  if (compareBytes(r.raw(CONTEXT.length), CONTEXT) !== 0) throw new EncodingError("wrong segment context");
  const domain = r.raw(32), venue = r.raw(32), operator = r.raw(32), sequence = r.u64(), count = r.u32();
  if (count < 1 || count > MAX_ENTRIES || bytes.length !== PREFIX_BYTES + ENTRY_BYTES * count) {
    throw new EncodingError("v3 segment count or length mismatch");
  }
  const entries: SegmentEntry[] = [];
  for (let i = 0; i < count; i++) {
    const backing = r.raw(32), link = r.raw(32), openingSequence = r.u64();
    const openingOperator = r.raw(32), openingRoot = r.raw(32);
    if (openingSequence === 0n) {
      if (openingOperator.some(b => b !== 0) || openingRoot.some(b => b !== 0)) {
        throw new EncodingError("nonzero empty opening fields");
      }
      entries.push(Object.freeze({ backing, link }));
    } else {
      entries.push(Object.freeze({ backing, link, opening: Object.freeze({
        sequence: openingSequence, operator: openingOperator, root: openingRoot,
      }) }));
    }
  }
  r.expectEnd();
  const header = Object.freeze({ domain, venue, operator, sequence, entries: Object.freeze(entries) });
  if (!isWellFormedHeader(header)) throw new EncodingError("malformed v3 segment header");
  return header;
}
