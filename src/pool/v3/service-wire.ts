// Local application envelopes. Protocol records keep their existing v3 bytes;
// JSON is never signed and package metadata is never verification authority.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../../bytes.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../../venue-records.js";
import { decodeReceipt, encodeReceipt } from "./commitments.js";
import { decodeRecord, encodeRecord } from "./records.js";
import type { ServedPackage } from "./store.js";

export const V3_SERVICE_PROFILE = "pool-store/v3";
export const MAX_V3_SERVICE_REQUEST_BYTES = 300_000;
export const MAX_V3_SERVICE_RESPONSE_BYTES = 2_100_000;
export const MAX_V3_SERVICE_REPLY_BYTES = 4096;
const MAX_RECORD_BYTES = 135_000, MAX_PACKAGE_BYTES = 1_048_576;
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
function sequence(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) >= 1n << 64n) {
    throw new EncodingError("invalid service sequence");
  }
  return BigInt(value);
}

export type V3ServiceCommand =
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "submit"; record: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "commit"; id: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "publish" };
export type V3ServiceReply =
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "accepted"; receipt: string }
  | { version: 1; profile: typeof V3_SERVICE_PROFILE; kind: "committed" | "published"; commitment: string };

export function parseV3ServiceCommand(value: unknown): V3ServiceCommand {
  const r = envelope(value);
  if (r.kind === "submit") {
    fields(r, ["version", "profile", "kind", "record"]);
    const bytes = hex(r.record, MAX_RECORD_BYTES), record = decodeRecord(bytes);
    if (record.kind === 7) throw new EncodingError("a request is not a segment admission");
    if (bytesToHex(encodeRecord(record)) !== r.record) throw new EncodingError("noncanonical record");
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

export function decodeV3ServiceReply(value: unknown): V3ServiceReply {
  const r = envelope(value);
  if (r.kind === "accepted") {
    fields(r, ["version", "profile", "kind", "receipt"]);
    const bytes = hex(r.receipt, 355, true);
    if (bytesToHex(encodeReceipt(decodeReceipt(bytes))) !== r.receipt) throw new EncodingError("noncanonical receipt");
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

/** Framing only: the independent reader must verify all returned evidence. */
export function decodeV3ServicePackage(value: unknown): ServedPackage {
  const r = envelope(value); fields(r, ["version", "profile", "kind", "selection", "package"]);
  if (r.kind !== "package") throw new EncodingError("unexpected service package");
  const s = object(r.selection); fields(s, ["domain", "venue", "backing", "operator", "sequence", "root"]);
  return { selection: { domain: hex(s.domain, 32, true), venue: hex(s.venue, 32, true), backing: hex(s.backing, 32, true),
    operator: hex(s.operator, 32, true), sequence: sequence(s.sequence), root: hex(s.root, 32, true) },
    package: hex(r.package, MAX_PACKAGE_BYTES) };
}
export function replyFromReceipt(bytes: Uint8Array): V3ServiceReply {
  return decodeV3ServiceReply({ version: 1, profile: V3_SERVICE_PROFILE, kind: "accepted", receipt: bytesToHex(bytes) });
}
export function replyFromCommitment(kind: "committed" | "published", commitment: Commitment): V3ServiceReply {
  return decodeV3ServiceReply({ version: 1, profile: V3_SERVICE_PROFILE, kind, commitment: bytesToHex(encodeCommitment(commitment)) });
}
export function packageReply(served: ServedPackage) {
  const s = served.selection;
  const reply = { version: 1, profile: V3_SERVICE_PROFILE, kind: "package", selection: {
    domain: bytesToHex(s.domain), venue: bytesToHex(s.venue), backing: bytesToHex(s.backing),
    operator: bytesToHex(s.operator), sequence: s.sequence.toString(), root: bytesToHex(s.root),
  }, package: bytesToHex(served.package) };
  decodeV3ServicePackage(reply); return reply;
}
