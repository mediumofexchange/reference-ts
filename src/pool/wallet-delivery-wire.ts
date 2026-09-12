// Private transport envelope only. Protocol signatures still cover their
// existing binary frames; a stored acknowledgement is not payment finality.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { EncodingError } from "../bytes.js";
import { isNoteOpening } from "./notes.js";
import { decodeStatement, encodeStatement, parsePublicInputs } from "./statement.js";
import { decodeStoredReceipt, encodeStoredReceipt } from "./store-codec.js";
import type { WalletDelivery } from "./wallet-store.js";

export const MAX_WALLET_DELIVERY_BYTES = 300_000;
export const WALLET_DELIVERY_PROFILE = "wallet-delivery/v2";
const invalid = (): never => { throw new EncodingError("invalid wallet delivery"); };
function hex(value: unknown, size?: number): Uint8Array {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value) || (size !== undefined && value.length !== size * 2)) return invalid();
  return hexToBytes(value);
}
function decimal(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) return invalid();
  return BigInt(value);
}

export function encodeWalletDelivery(requestId: string, domain: Uint8Array, delivery: WalletDelivery): string {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId) ||
      !(domain instanceof Uint8Array) || domain.length !== 32 || !isNoteOpening(delivery.opening)) return invalid();
  const domainHex = bytesToHex(domain);
  if (bytesToHex(parsePublicInputs(delivery.statement.kind, delivery.statement.publicInputs).domain) !== domainHex) return invalid();
  const opening = delivery.opening;
  const result = JSON.stringify({ version: 1, profile: WALLET_DELIVERY_PROFILE, requestId, domain: domainHex,
    statement: bytesToHex(encodeStatement(domain, delivery.statement)),
    opening: { backing: bytesToHex(opening.backing), value: opening.value.toString(), owner: opening.owner.toString(), rho: opening.rho.toString() },
    receipt: encodeStoredReceipt(delivery.receipt) });
  if (Buffer.byteLength(result, "utf8") > MAX_WALLET_DELIVERY_BYTES) return invalid();
  return result;
}

export function decodeWalletDelivery(text: string): { requestId: string; domain: Uint8Array; delivery: WalletDelivery } {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_WALLET_DELIVERY_BYTES) return invalid();
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value === null || Array.isArray(value) || value.version !== 1 || value.profile !== WALLET_DELIVERY_PROFILE) return invalid();
    const domain = hex(value.domain, 32), decoded = decodeStatement(hex(value.statement));
    if (bytesToHex(decoded.domain) !== bytesToHex(domain)) return invalid();
    const opening = value.opening as Record<string, unknown>;
    if (opening === null || typeof opening !== "object" || Array.isArray(opening) || typeof value.receipt !== "string") return invalid();
    const delivery = { statement: decoded.statement,
      opening: { backing: hex(opening.backing, 32), value: decimal(opening.value), owner: decimal(opening.owner), rho: decimal(opening.rho) },
      receipt: decodeStoredReceipt(value.receipt) };
    const requestId = value.requestId as string;
    // Full reconstruction rejects unknown fields, duplicate keys, reordered
    // keys, whitespace, escapes, and noncanonical nested receipt/frame bytes.
    if (encodeWalletDelivery(requestId, domain, delivery) !== text) return invalid();
    return { requestId, domain, delivery };
  } catch { return invalid(); }
}

export function walletDeliveryHash(canonicalFrame: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalFrame)));
}
