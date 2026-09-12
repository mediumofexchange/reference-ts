// Local application trust bytes, never pool statement or signature bytes.
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { EncodingError } from "../bytes.js";
import { isField, isValue } from "./field.js";
import type { WalletRequest } from "./wallet-store.js";

export const WALLET_PAIRING_PROFILE = "moe/wallet-pairing/v1";
export const MAX_WALLET_PAIRING_BYTES = 16_384;
export interface WalletTlsCredentials { readonly key: string; readonly cert: string }
export interface WalletCredentialBinding { readonly generation: bigint; readonly certificateDigest: string }
export interface WalletPairing {
  readonly profile: typeof WALLET_PAIRING_PROFILE;
  readonly domain: string;
  readonly request: { readonly id: string; readonly backing: string; readonly value: string; readonly owner: string };
  readonly generation: string;
  readonly endpoint: string;
  readonly token: string;
  readonly cert: string;
}
const invalid = (): never => { throw new EncodingError("invalid wallet pairing or credentials"); };
const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
function certificate(pem: string): X509Certificate {
  if (typeof pem !== "string" || pem.length > 8_192) invalid();
  const cert = new X509Certificate(pem);
  if (cert.toString() !== pem || cert.issuer !== cert.subject || !cert.verify(cert.publicKey)) invalid();
  return cert;
}
export function walletCertificateDigest(pem: string): string {
  return createHash("sha256").update(certificate(pem).raw).digest("hex");
}
/** Structural validation is also usable for expired credentials during recovery. */
export function validateWalletTls(tls: WalletTlsCredentials, usable = true): void {
  if (!tls || typeof tls.key !== "string" || tls.key.length > 8_192) invalid();
  const cert = certificate(tls.cert), key = createPrivateKey(tls.key);
  if (!cert.checkPrivateKey(key)) invalid();
  if (usable && !(Date.now() >= Date.parse(cert.validFrom) && Date.now() < Date.parse(cert.validTo))) invalid();
}
export function sameWalletTlsKey(a: string, b: string): boolean {
  return certificate(a).publicKey.equals(certificate(b).publicKey);
}
export function walletRequestText(request: WalletRequest): WalletPairing["request"] {
  return { id: request.id, backing: Buffer.from(request.backing).toString("hex"), value: request.value.toString(), owner: request.owner.toString() };
}
export function encodeWalletPairing(pair: WalletPairing): string {
  const frame = JSON.stringify({ profile: pair.profile, domain: pair.domain,
    request: { id: pair.request.id, backing: pair.request.backing, value: pair.request.value, owner: pair.request.owner },
    generation: pair.generation, endpoint: pair.endpoint, token: pair.token, cert: pair.cert });
  decodeWalletPairing(frame); return frame;
}
export function decodeWalletPairing(frame: string): WalletPairing {
  try {
    if (typeof frame !== "string" || Buffer.byteLength(frame) > MAX_WALLET_PAIRING_BYTES) invalid();
    const p = JSON.parse(frame) as WalletPairing, r = p.request;
    if (p.profile !== WALLET_PAIRING_PROFILE || !hex(p.domain) || !r || typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(r.id) ||
      !hex(r.backing) || typeof r.value !== "string" || !/^[1-9][0-9]{0,19}$/.test(r.value) || !isValue(BigInt(r.value)) ||
      typeof r.owner !== "string" || !/^[1-9][0-9]{0,76}$/.test(r.owner) || !isField(BigInt(r.owner)) ||
      typeof p.generation !== "string" || !/^[1-9][0-9]{0,19}$/.test(p.generation) || BigInt(p.generation) >= 1n << 64n || !hex(p.token)) invalid();
    const url = new URL(p.endpoint);
    if (url.href !== p.endpoint || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== `/delivery/${r.id}`) invalid();
    const cert = certificate(p.cert), hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!(isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname, { subject: "never", wildcards: false }))) invalid();
    const canonical = JSON.stringify({ profile: p.profile, domain: p.domain,
      request: { id: r.id, backing: r.backing, value: r.value, owner: r.owner },
      generation: p.generation, endpoint: p.endpoint, token: p.token, cert: p.cert });
    if (canonical !== frame) invalid();
    return p;
  } catch { return invalid(); }
}
/** Must be compared with a digest received independently from the receiver. */
export function walletPairingDigest(frame: string): string {
  decodeWalletPairing(frame);
  return createHash("sha256").update(frame, "utf8").digest("hex");
}
