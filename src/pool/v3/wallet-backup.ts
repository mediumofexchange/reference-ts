// Local offline custody envelope for the v3 wallet: never protocol bytes, a
// seed-restoration capsule or a signed message. The caller keeps the random key
// and the exact digest independently of the encrypted bytes.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { copyUnshared, EncodingError } from "../../bytes.js";

/** An application frame's tag, like the request frame's; its test checks it
 * against contexts.ts for prefix freedom. */
export const WALLET_V3_BACKUP_CONTEXT = new TextEncoder().encode("moe/wallet/v3/backup");
const HEADER = Buffer.from(WALLET_V3_BACKUP_CONTEXT), NONCE = 12, TAG = 16, OVERHEAD = HEADER.length + NONCE + TAG;
/** Bounds memory: export and restore hold the whole plaintext and envelope. */
export const MAX_WALLET_BACKUP_BYTES = 64 * 1024 * 1024;
export const WALLET_BACKUP_OVERHEAD = OVERHEAD;
const invalid = (): never => { throw new EncodingError("invalid wallet backup or recovery credentials"); };

export function createWalletBackupKey(): Uint8Array { return Uint8Array.from(randomBytes(32)); }
function keyBytes(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.length !== 32) invalid();
  return Buffer.from(key);
}
function identity(domain: Uint8Array, venue: Uint8Array): Buffer {
  const d = copyUnshared(domain), v = copyUnshared(venue);
  if (d.length !== 32 || v.length !== 32) invalid();
  return Buffer.concat([HEADER, d, v]);
}
function framed(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.length < OVERHEAD || bytes.length > MAX_WALLET_BACKUP_BYTES) invalid();
  return Buffer.from(copyUnshared(bytes));
}
/** SHA-256 of the exact envelope as 64 lowercase hex digits: an identity of
 * this export, not evidence that it is the latest or only copy. */
export function walletBackupDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(framed(bytes)).digest("hex");
}
/** AES-256-GCM under a random 96-bit nonce; the tag, domain and venue are the
 * associated data, so an envelope opens only for the wallet it came from. */
export function sealWalletBackup(plaintext: Uint8Array, key: Uint8Array, domain: Uint8Array, venue: Uint8Array): Uint8Array {
  if (!(plaintext instanceof Uint8Array) || plaintext.length + OVERHEAD > MAX_WALLET_BACKUP_BYTES) invalid();
  const aad = identity(domain, venue), ownedKey = keyBytes(key);
  try {
    const nonce = randomBytes(NONCE), cipher = createCipheriv("aes-256-gcm", ownedKey, nonce, { authTagLength: TAG });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Uint8Array.from(Buffer.concat([HEADER, nonce, ciphertext, cipher.getAuthTag()]));
  } finally { ownedKey.fill(0); }
}
/** Opens only the exact envelope named by the independently kept digest;
 * unauthenticated plaintext is never returned. */
export function openWalletBackup(bytes: Uint8Array, key: Uint8Array, domain: Uint8Array, venue: Uint8Array,
  expectedDigest: string): Uint8Array {
  const frame = framed(bytes), aad = identity(domain, venue);
  if (typeof expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(expectedDigest) ||
    createHash("sha256").update(frame).digest("hex") !== expectedDigest) invalid();
  const ownedKey = keyBytes(key);
  let plaintext: Buffer | undefined, final: Buffer | undefined, joined: Buffer | undefined;
  try {
    if (!frame.subarray(0, HEADER.length).equals(HEADER)) invalid();
    const decipher = createDecipheriv("aes-256-gcm", ownedKey, frame.subarray(HEADER.length, HEADER.length + NONCE), { authTagLength: TAG });
    decipher.setAAD(aad);
    decipher.setAuthTag(frame.subarray(frame.length - TAG));
    plaintext = decipher.update(frame.subarray(HEADER.length + NONCE, frame.length - TAG));
    final = decipher.final();
    joined = Buffer.concat([plaintext, final]);
    return Uint8Array.from(joined);
  } catch { return invalid(); }
  finally { ownedKey.fill(0); plaintext?.fill(0); final?.fill(0); joined?.fill(0); frame.fill(0); }
}

/** A stored cell: TEXT, BLOB or NULL. */
export type WalletCell = string | Uint8Array | null;
export interface WalletSnapshot {
  readonly profile: string;
  readonly seed: Uint8Array;
  /** Rows of each table in the wallet's fixed order, each in storage order. */
  readonly tables: readonly (readonly (readonly WalletCell[])[])[];
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** Exact plaintext length, so an oversized wallet refuses before encoding. */
export function cellBytes(cell: WalletCell): number {
  return cell === null ? 1 : 5 + (typeof cell === "string" ? Buffer.byteLength(cell, "utf8") : cell.length);
}
/** profile (u32 length, UTF-8) || seed[32] || per table: u32 rows, then per cell
 * a kind byte (0 NULL, 1 TEXT, 2 BLOB) and, unless NULL, u32 length and bytes. */
export function encodeWalletSnapshot(snapshot: WalletSnapshot): Uint8Array {
  const chunks: Buffer[] = [], profile = Buffer.from(snapshot.profile, "utf8");
  if (snapshot.seed.length !== 32) throw new EncodingError("wallet seed must be 32 bytes");
  chunks.push(u32(profile.length), profile, Buffer.from(snapshot.seed));
  for (const rows of snapshot.tables) {
    chunks.push(u32(rows.length));
    for (const row of rows) for (const cell of row) {
      if (cell === null) { chunks.push(Buffer.of(0)); continue; }
      const bytes = typeof cell === "string" ? Buffer.from(cell, "utf8") : Buffer.from(cell);
      chunks.push(Buffer.of(typeof cell === "string" ? 1 : 2), u32(bytes.length), bytes);
    }
  }
  const out = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  return out;
}
/** Strict inverse for the given column counts: every length is in bounds,
 * text is canonical UTF-8, and no byte trails. */
export function decodeWalletSnapshot(bytes: Uint8Array, columns: readonly number[]): WalletSnapshot {
  const data = Buffer.from(copyUnshared(bytes));
  let offset = 0;
  const take = (n: number): Buffer => {
    if (n > data.length - offset) throw new EncodingError("truncated wallet snapshot");
    const out = Buffer.from(data.subarray(offset, offset + n)); offset += n; return out;
  };
  const count = (): number => take(4).readUInt32BE();
  const text = (b: Buffer): string => {
    let s: string;
    try { s = utf8.decode(b); } catch { throw new EncodingError("wallet snapshot text is not UTF-8"); }
    if (!Buffer.from(s, "utf8").equals(b)) throw new EncodingError("wallet snapshot text is not canonical");
    return s;
  };
  try {
    const profile = text(take(count())), seed = Uint8Array.from(take(32));
    const tables = columns.map(width => {
      const rows: WalletCell[][] = [];
      for (let n = count(); n > 0; n--) {
        // Each row takes at least one byte per cell, so a false count fails as truncation.
        const row: WalletCell[] = [];
        for (let c = 0; c < width; c++) {
          const kind = take(1)[0];
          if (kind === 0) { row.push(null); continue; }
          if (kind !== 1 && kind !== 2) throw new EncodingError("invalid wallet snapshot cell");
          const value = take(count());
          row.push(kind === 1 ? text(value) : Uint8Array.from(value));
        }
        rows.push(row);
      }
      return rows;
    });
    if (offset !== data.length) throw new EncodingError("trailing wallet snapshot bytes");
    return { profile, seed, tables };
  } finally { data.fill(0); }
}
