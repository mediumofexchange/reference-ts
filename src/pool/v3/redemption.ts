// The holder's own redemption values (pool-recovery C3.3 and C3.5), each
// derived from the wallet seed like every other blinding value (invariant 26),
// so a retry or a wallet rebuilt from its seed names the same objects. The
// labels are local: none enters a statement, a signature or the specification,
// and each keys one HMAC so no two derivations share a preimage space.
import { createHmac, hkdfSync } from "node:crypto";
import { copyBytes, EncodingError } from "../../bytes.js";
import { fieldToBytes, isValue } from "../field.js";
import { deriveNonzeroField } from "./capsules.js";

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const PRESENTER_INFO = ascii("moe/wallet/v3/presenter"), PADDING_INFO = ascii("moe/wallet/v3/padding"),
  RHO_OUT_INFO = ascii("moe/wallet/v3/settlement-rho");

function key(seed: Uint8Array, domain: Uint8Array, info: Uint8Array): Uint8Array {
  if (!(seed instanceof Uint8Array) || seed.length !== 32 || !(domain instanceof Uint8Array) || domain.length !== 32) {
    throw new EncodingError("expected a 32-byte seed and domain");
  }
  return new Uint8Array(hkdfSync("sha256", copyBytes(seed), copyBytes(domain), info, 32));
}
const u64 = (value: bigint): Uint8Array => {
  if (!isValue(value)) throw new EncodingError("expected a u64");
  const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value); return out;
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** C3.3: the demand's fresh presenter signing secret, fixed by the notice it
 * signs for: the tags in position order, the instant and the deadline. A
 * demand is one notice, so one notice has one presenter; another notice over
 * the same notes has another. A rebuilt wallet finds it again from the
 * demand's public inputs and its own notes' tags. */
export function presenterSecret(seed: Uint8Array, domain: Uint8Array, tags: readonly bigint[], instant: bigint, deadline: bigint): Uint8Array {
  if (tags.length !== 2) throw new EncodingError("a demand has two positions");
  const preimage = concat(...tags.map(fieldToBytes), u64(instant), u64(deadline));
  return new Uint8Array(createHmac("sha256", key(seed, domain, PRESENTER_INFO)).update(preimage).digest());
}

/** The request identifier of the zero note padding a one-note demand and its
 * settlement, fixed by the real note's nullifier: the settlement re-proves the
 * demand's positions, and `rho_out` reads both nullifiers. */
export function paddingRequestId(seed: Uint8Array, domain: Uint8Array, nf: bigint): Uint8Array {
  return new Uint8Array(createHmac("sha256", key(seed, domain, PADDING_INFO)).update(fieldToBytes(nf)).digest());
}

/** C3.5: `rho_out` from the seed, the settlement's input nullifiers in
 * position order, the segment identity and the disclosure count. */
export function settlementRho(seed: Uint8Array, domain: Uint8Array, nfs: readonly bigint[], segment: Uint8Array, count: bigint): bigint {
  if (nfs.length !== 2 || !(segment instanceof Uint8Array) || segment.length !== 32) throw new EncodingError("invalid settlement context");
  return deriveNonzeroField(key(seed, domain, RHO_OUT_INFO), concat(...nfs.map(fieldToBytes), copyBytes(segment), u64(count)));
}
