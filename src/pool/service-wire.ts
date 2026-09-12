import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decodeCommitment, encodeCommitment, type Commitment } from "../commitment.js";
import { EncodingError } from "../bytes.js";
import { decodeStatement, encodeStatement, type Statement } from "./statement.js";
import { decodeStoredReceipt, encodeStoredReceipt } from "./store-codec.js";
import type { PoolReceipt } from "./receipt.js";

export const POOL_SERVICE_PROFILE = "pool-store/v2";
export const POOL_SERVICE_VERSION = 1;
// Supports the verifier's 131072-byte proof bound plus canonical framing.
export const MAX_POOL_SERVICE_REQUEST_BYTES = 300_000;
export const MAX_POOL_SERVICE_RESPONSE_BYTES = 65_536;
const MAX_ID = 128, MAX_STATEMENT = 135000;

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new EncodingError("expected object"); return value as Obj; }
function fields(value: Obj, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) throw new EncodingError(`missing ${key}`);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) throw new EncodingError(`unknown field ${key}`);
}
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new EncodingError(`invalid ${label}`); return value; }
function hex(value: unknown, label: string, max: number): Uint8Array {
  const s = text(value, label, max * 2);
  if (s.length % 2 !== 0 || !/^[0-9a-f]+$/.test(s)) throw new EncodingError(`invalid ${label}`);
  return hexToBytes(s);
}
function canonical(value: unknown): string { return JSON.stringify(value); }

export type PoolServiceCommand =
  | { version: 1; profile: typeof POOL_SERVICE_PROFILE; kind: "submit"; statement: string }
  | { version: 1; profile: typeof POOL_SERVICE_PROFILE; kind: "commit"; id: string }
  | { version: 1; profile: typeof POOL_SERVICE_PROFILE; kind: "publish" };

export type PoolServiceReply =
  | { version: 1; profile: typeof POOL_SERVICE_PROFILE; kind: "accepted"; receipt: string }
  | { version: 1; profile: typeof POOL_SERVICE_PROFILE; kind: "committed" | "published"; commitment: string };

export interface PoolServiceView { version: 1; profile: typeof POOL_SERVICE_PROFILE; highestSignedSequence: string; latest?: string; evidence: "omitted"; }

export function parsePoolServiceCommand(value: unknown): PoolServiceCommand {
  const r = obj(value); fields(r, ["version", "profile", "kind"], ["statement", "id"]);
  if (r.version !== POOL_SERVICE_VERSION || r.profile !== POOL_SERVICE_PROFILE) throw new EncodingError("wrong service profile");
  if (r.kind === "submit") {
    fields(r, ["version", "profile", "kind", "statement"]);
    const statement = bytesToHex(hex(r.statement, "statement", MAX_STATEMENT));
    const decoded = decodeStatement(hexToBytes(statement));
    if (bytesToHex(encodeStatement(decoded.domain, decoded.statement)) !== statement) throw new EncodingError("noncanonical statement");
    return { version: 1, profile: POOL_SERVICE_PROFILE, kind: "submit", statement };
  }
  if (r.kind === "commit") {
    fields(r, ["version", "profile", "kind", "id"]);
    const id = text(r.id, "command id", MAX_ID);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new EncodingError("invalid command id");
    return { version: 1, profile: POOL_SERVICE_PROFILE, kind: "commit", id };
  }
  if (r.kind === "publish") { fields(r, ["version", "profile", "kind"]); return { version: 1, profile: POOL_SERVICE_PROFILE, kind: "publish" }; }
  throw new EncodingError("unsupported service command");
}

export function commandStatement(command: Extract<PoolServiceCommand, { kind: "submit" }>): { readonly domain: Uint8Array; readonly statement: Statement } { return decodeStatement(hexToBytes(command.statement)); }
export function encodePoolServiceReply(reply: PoolServiceReply): string { return canonical(reply); }
export function decodePoolServiceReply(value: unknown): PoolServiceReply {
  const r = obj(value); fields(r, ["version", "profile", "kind"], ["receipt", "commitment"]);
  if (r.version !== 1 || r.profile !== POOL_SERVICE_PROFILE) throw new EncodingError("wrong service reply profile");
  if (r.kind === "accepted") { fields(r, ["version", "profile", "kind", "receipt"]); const receipt = text(r.receipt, "receipt", 4096); decodeStoredReceipt(receipt); return { version: 1, profile: POOL_SERVICE_PROFILE, kind: "accepted", receipt }; }
  if (r.kind === "committed" || r.kind === "published") { fields(r, ["version", "profile", "kind", "commitment"]); const commitment = bytesToHex(hex(r.commitment, "commitment", 136)); if (bytesToHex(encodeCommitment(decodeCommitment(hexToBytes(commitment)))) !== commitment) throw new EncodingError("noncanonical commitment"); return { version: 1, profile: POOL_SERVICE_PROFILE, kind: r.kind, commitment }; }
  throw new EncodingError("unsupported service reply");
}
export function replyReceipt(reply: Extract<PoolServiceReply, { kind: "accepted" }>): PoolReceipt { return decodeStoredReceipt(reply.receipt); }
export function encodePoolServiceView(view: PoolServiceView): string { return canonical(view); }
export function decodePoolServiceView(value: unknown): PoolServiceView {
  const r = obj(value); fields(r, ["version", "profile", "highestSignedSequence", "evidence"], ["latest"]);
  if (r.version !== 1 || r.profile !== POOL_SERVICE_PROFILE || r.evidence !== "omitted") throw new EncodingError("invalid service view");
  const highestSignedSequence = text(r.highestSignedSequence, "sequence", 20); if (!/^(0|[1-9][0-9]*)$/.test(highestSignedSequence)) throw new EncodingError("invalid sequence");
  if (BigInt(highestSignedSequence) >= (1n << 64n)) throw new EncodingError("sequence exceeds u64");
  const latest = r.latest === undefined ? undefined : bytesToHex(hex(r.latest, "latest", 136));
  if (latest !== undefined && bytesToHex(encodeCommitment(decodeCommitment(hexToBytes(latest)))) !== latest) throw new EncodingError("invalid latest commitment");
  if ((latest === undefined) !== (highestSignedSequence === "0") ||
      (latest !== undefined && decodeCommitment(hexToBytes(latest)).sequence !== BigInt(highestSignedSequence))) throw new EncodingError("inconsistent latest sequence");
  return { version: 1, profile: POOL_SERVICE_PROFILE, highestSignedSequence, ...(latest === undefined ? {} : { latest }), evidence: "omitted" };
}
export function replyFromReceipt(receipt: PoolReceipt): PoolServiceReply { return { version: 1, profile: POOL_SERVICE_PROFILE, kind: "accepted", receipt: encodeStoredReceipt(receipt) }; }
export function replyFromCommitment(kind: "committed" | "published", commitment: Commitment): PoolServiceReply { return { version: 1, profile: POOL_SERVICE_PROFILE, kind, commitment: bytesToHex(encodeCommitment(commitment)) }; }
