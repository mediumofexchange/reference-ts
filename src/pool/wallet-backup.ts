// Local offline custody envelope; never protocol bytes or a seed restoration
// capsule. The caller keeps the random key and exact digest independently.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ByteWriter, EncodingError } from "../bytes.js";
import { fieldToBytes } from "./field.js";
import { copySegmentAuthority, type SegmentAuthority } from "./statement.js";

const HEADER = Buffer.from("moe/wallet-offline/v1", "ascii");
const OVERHEAD = HEADER.length + 12 + 16;
export const MAX_WALLET_BACKUP_BYTES = 16 * 1024 * 1024;
const invalid = (): never => { throw new EncodingError("invalid wallet backup or recovery credentials"); };
export function createWalletBackupKey(): Uint8Array { return Uint8Array.from(randomBytes(32)); }
/** Fixed bytes also pin the local database's exact configured authority. */
export function walletAuthorityBytes(authority: SegmentAuthority): Uint8Array {
  const a = copySegmentAuthority(authority), w = new ByteWriter();
  w.key32(a.domain, "wallet domain"); w.key32(a.segment, "wallet segment");
  w.key32(a.operator, "wallet operator"); w.key32(fieldToBytes(a.scopeRoot), "wallet scope");
  return w.finish();
}
function keyBytes(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.length !== 32) invalid();
  return Buffer.from(key);
}
/** Digest is an identity, not evidence that this is the latest/only copy. */
export function walletBackupDigest(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length < OVERHEAD || bytes.length > MAX_WALLET_BACKUP_BYTES) invalid();
  return createHash("sha256").update(bytes).digest("hex");
}
export function sealWalletBackup(plaintext: Uint8Array, key: Uint8Array, authority: SegmentAuthority): Uint8Array {
  if (!(plaintext instanceof Uint8Array) || plaintext.length + OVERHEAD > MAX_WALLET_BACKUP_BYTES) invalid();
  const ownedKey = keyBytes(key);
  try {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", ownedKey, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.concat([HEADER, walletAuthorityBytes(authority)]));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Uint8Array.from(Buffer.concat([HEADER, nonce, ciphertext, cipher.getAuthTag()]));
  } finally { ownedKey.fill(0); }
}
export function openWalletBackup(bytes: Uint8Array, key: Uint8Array, authority: SegmentAuthority, expectedDigest: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length < OVERHEAD || bytes.length > MAX_WALLET_BACKUP_BYTES) invalid();
  const frame = Buffer.from(bytes);
  if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedDigest) || walletBackupDigest(frame) !== expectedDigest) invalid();
  const ownedKey = keyBytes(key);
  let plaintext: Buffer | undefined;
  try {
    if (!frame.subarray(0, HEADER.length).equals(HEADER)) invalid();
    const decipher = createDecipheriv("aes-256-gcm", ownedKey, frame.subarray(HEADER.length, HEADER.length + 12), { authTagLength: 16 });
    decipher.setAAD(Buffer.concat([HEADER, walletAuthorityBytes(authority)]));
    decipher.setAuthTag(frame.subarray(frame.length - 16));
    plaintext = decipher.update(frame.subarray(HEADER.length + 12, frame.length - 16));
    const final = decipher.final(); // Never expose unauthenticated plaintext.
    return Uint8Array.from(Buffer.concat([plaintext, final]));
  } catch { return invalid(); }
  finally { ownedKey.fill(0); plaintext?.fill(0); }
}
