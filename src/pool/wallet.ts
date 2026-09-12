// Local wallet derivation, not a new protocol frame or delivery profile.
// pool-v2 §3 leaves the wallet KDF local; HMAC-SHA256 rejection sampling
// produces nonzero canonical fields without reducing biased digest values.
import { createHash, createHmac } from "node:crypto";
import { ByteWriter, EncodingError } from "../bytes.js";
import { FIELD_MODULUS, fieldToBytes, isValue } from "./field.js";

/** Application identifier only, never a protocol frame or note derivation. */
export function walletChangeRequestId(alias: string, value: bigint): string {
  if (typeof alias !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(alias) || !isValue(value) || value === 0n) {
    throw new EncodingError("invalid change request identity");
  }
  const w = new ByteWriter(); w.context(new TextEncoder().encode("moe/local-wallet/change-id"));
  w.lengthPrefixed(new TextEncoder().encode(alias)); w.u64(value);
  return "change_" + createHash("sha256").update(w.finish()).digest("hex");
}

export type WalletPurpose = "request-secret" | "issue-rho" | "output-rho" | "padding-rho" | "padding-secret";
const purposes: readonly WalletPurpose[] = ["request-secret", "issue-rho", "output-rho", "padding-rho", "padding-secret"];
/** Real input nullifiers must be sorted before calling for spend/burn. The
 * segment, anchors and proof deliberately do not participate (invariant 26).
 * Issuance uses its receiver owner; request-secret uses a durable counter. */
export function deriveWalletField(root: Uint8Array, domain: Uint8Array, purpose: WalletPurpose,
  inputs: readonly bigint[], slot = 0): bigint {
  if (!(root instanceof Uint8Array) || root.length !== 32 || !(domain instanceof Uint8Array) || domain.length !== 32 ||
      !purposes.includes(purpose) || inputs.length < 1 || inputs.length > 2 ||
      inputs.some(n => n === 0n) || (inputs.length === 2 && inputs[0]! >= inputs[1]!)) throw new EncodingError("invalid wallet derivation context");
  const w = new ByteWriter();
  w.context(new TextEncoder().encode("moe/local-wallet/v2/field")); w.key32(domain, "domain");
  w.u8(purposes.indexOf(purpose)); w.u32(slot); w.u8(inputs.length);
  for (const n of inputs) w.key32(fieldToBytes(n), "derivation input");
  const frame = w.finish();
  for (let attempt = 0; attempt <= 0xffffffff; attempt++) {
    const counter = new ByteWriter(); counter.u32(attempt);
    const digest = createHmac("sha256", root).update(frame).update(counter.finish()).digest();
    const n = BigInt("0x" + digest.toString("hex"));
    if (n > 0n && n < FIELD_MODULUS) return n;
  }
  throw new EncodingError("wallet field derivation exhausted");
}
