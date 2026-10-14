// The part of node:crypto the library uses, in a browser engine (slice 39), for the browser bundle
// (scripts/browser/build.mjs substitutes this module for node:crypto). Each function keeps Node's signature and
// result for the uses the library makes of it, and refuses the rest by name rather than answering otherwise:
// - randomness from the platform's cryptographic generator (`crypto.getRandomValues`), as Node's own;
// - SHA-256, HMAC-SHA-256 and HKDF-SHA-256 from @noble/hashes, which the library already uses beside them;
// - AES-256-GCM from @noble/ciphers, one `update` a cipher, as every caller makes: a cipher's ciphertext comes from
//   its update and its tag after `final`; a decipher's plaintext comes from its update once its tag is set, and a
//   failed authentication throws at `final`, as Node's does, with no unauthenticated plaintext returned.
// test/browser-host.test.ts holds it to node:crypto; the equivalence run (vitest.browser-host.config.ts) runs the
// capsule and lit wallet-key suites over it, and the browser check (scripts/browser/check.mjs) the capsule suite.
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes as platformBytes } from "@noble/hashes/utils.js";

type Input = string | ArrayBufferView;
type Encoding = "hex" | "base64" | "buffer" | undefined;

const unsupported = (what: string): Error => Object.assign(new Error(`a browser host's node:crypto has no ${what}`), { code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" });
const bytesOf = (data: Input): Uint8Array => typeof data === "string" ? new TextEncoder().encode(data)
  : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
const sha = (algorithm: string): void => { if (algorithm.toLowerCase() !== "sha256") throw unsupported(`${algorithm} hash`); };
function encoded(bytes: Uint8Array, encoding: Encoding): Buffer | string {
  if (encoding === undefined || encoding === "buffer") return Buffer.from(bytes);
  if (encoding === "hex") return bytesToHex(bytes);
  if (encoding === "base64") return Buffer.from(bytes).toString("base64");
  throw unsupported(`${String(encoding)} encoding`);
}

export function randomBytes(size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError("The \"size\" argument is out of range");
  return Buffer.from(platformBytes(size));
}

/** An integer in [min, max), uniform, as Node's: the range below 2^48, drawn by rejection from 48 random bits. */
export function randomInt(min: number, max?: number): number {
  if (max === undefined) { max = min; min = 0; }
  const range = max - min;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || range <= 0 || range > 2 ** 48) {
    throw new RangeError("The value of \"max - min\" is out of range");
  }
  const limit = 2 ** 48 - (2 ** 48 % range);
  for (;;) {
    const b = platformBytes(6);
    const x = b[0]! * 2 ** 40 + b[1]! * 2 ** 32 + b[2]! * 2 ** 24 + b[3]! * 2 ** 16 + b[4]! * 2 ** 8 + b[5]!;
    if (x < limit) return min + (x % range);
  }
}

export function randomUUID(): string {
  const b = platformBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Digester {
  update(data: Input): Digester;
  digest(encoding?: Encoding): Buffer | string;
}
function digester(state: { update(bytes: Uint8Array): unknown; digest(): Uint8Array }): Digester {
  let done = false;
  const self: Digester = {
    update(data) { if (done) throw unsupported("update after digest"); state.update(bytesOf(data)); return self; },
    digest(encoding) { if (done) throw unsupported("second digest"); done = true; return encoded(state.digest(), encoding); },
  };
  return self;
}

export function createHash(algorithm: string): Digester { sha(algorithm); return digester(sha256.create()); }

export function hash(algorithm: string, data: Input, outputEncoding: Encoding = "hex"): Buffer | string {
  sha(algorithm);
  return encoded(sha256(bytesOf(data)), outputEncoding);
}

export function createHmac(algorithm: string, key: ArrayBufferView): Digester {
  sha(algorithm);
  return digester(hmac.create(sha256, bytesOf(key)));
}

export function hkdfSync(digest: string, ikm: ArrayBufferView, salt: ArrayBufferView, info: ArrayBufferView, keylen: number): ArrayBuffer {
  sha(digest);
  const out = hkdf(sha256, bytesOf(ikm), bytesOf(salt), bytesOf(info), keylen);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = bytesOf(a), y = bytesOf(b);
  if (x.length !== y.length) throw Object.assign(new RangeError("Input buffers must have the same byte length"), { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" });
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

interface GcmOptions { readonly authTagLength?: number }
function gcmArguments(algorithm: string, key: ArrayBufferView, iv: ArrayBufferView, options?: GcmOptions) {
  if (algorithm.toLowerCase() !== "aes-256-gcm") throw unsupported(`${algorithm} cipher`);
  const k = Uint8Array.from(bytesOf(key)), n = Uint8Array.from(bytesOf(iv)), tag = options?.authTagLength ?? 16;
  if (k.length !== 32) throw new RangeError("Invalid key length");
  if (n.length !== 12) throw unsupported("AES-GCM nonce other than 96 bits");
  if (tag !== 16) throw unsupported("AES-GCM tag other than 128 bits");
  return { k, n };
}

export function createCipheriv(algorithm: string, key: ArrayBufferView, iv: ArrayBufferView, options?: GcmOptions) {
  const { k, n } = gcmArguments(algorithm, key, iv, options);
  let aad: Uint8Array | undefined, tag: Uint8Array | undefined, stage: "open" | "updated" | "final" = "open";
  return {
    setAAD(data: ArrayBufferView) { if (stage !== "open") throw unsupported("AAD after update"); aad = Uint8Array.from(bytesOf(data)); return this; },
    update(data: ArrayBufferView): Buffer {
      if (stage !== "open") throw unsupported("second AES-GCM update");
      stage = "updated";
      const sealed = gcm(k, n, aad).encrypt(bytesOf(data));
      tag = sealed.subarray(sealed.length - 16);
      return Buffer.from(sealed.subarray(0, sealed.length - 16));
    },
    final(): Buffer {
      if (stage === "final") throw unsupported("second final");
      if (stage === "open") { const sealed = gcm(k, n, aad).encrypt(new Uint8Array(0)); tag = sealed; }
      stage = "final";
      return Buffer.alloc(0);
    },
    getAuthTag(): Buffer {
      if (stage !== "final" || tag === undefined) throw Object.assign(new Error("Invalid state for operation getAuthTag"), { code: "ERR_CRYPTO_INVALID_STATE" });
      return Buffer.from(tag);
    },
  };
}

export function createDecipheriv(algorithm: string, key: ArrayBufferView, iv: ArrayBufferView, options?: GcmOptions) {
  const { k, n } = gcmArguments(algorithm, key, iv, options);
  let aad: Uint8Array | undefined, tag: Uint8Array | undefined, failed = false, stage: "open" | "updated" | "final" = "open";
  const open = (ciphertext: Uint8Array): Uint8Array | undefined => {
    if (tag === undefined) throw unsupported("AES-GCM decryption before its tag is set");
    const sealed = new Uint8Array(ciphertext.length + 16);
    sealed.set(ciphertext); sealed.set(tag, ciphertext.length);
    try { return gcm(k, n, aad).decrypt(sealed); } catch { return undefined; }
  };
  return {
    setAAD(data: ArrayBufferView) { if (stage !== "open") throw unsupported("AAD after update"); aad = Uint8Array.from(bytesOf(data)); return this; },
    setAuthTag(data: ArrayBufferView) {
      if (stage === "final") throw Object.assign(new Error("Invalid state for operation setAuthTag"), { code: "ERR_CRYPTO_INVALID_STATE" });
      const own = Uint8Array.from(bytesOf(data));
      if (own.length !== 16) throw unsupported("AES-GCM tag other than 128 bits");
      tag = own; return this;
    },
    update(data: ArrayBufferView): Buffer {
      if (stage !== "open") throw unsupported("second AES-GCM update");
      stage = "updated";
      const plaintext = open(bytesOf(data));
      if (plaintext === undefined) { failed = true; return Buffer.alloc(0); }
      return Buffer.from(plaintext);
    },
    final(): Buffer {
      if (stage === "final") throw unsupported("second final");
      if (stage === "open" && open(new Uint8Array(0)) === undefined) failed = true;
      stage = "final";
      if (failed) throw new Error("Unsupported state or unable to authenticate data");
      return Buffer.alloc(0);
    },
  };
}

/** The platform's Web Crypto, which Node also gives as `webcrypto`. */
export const webcrypto = globalThis.crypto;

export default { webcrypto, randomBytes, randomInt, randomUUID, createHash, hash, createHmac, hkdfSync, timingSafeEqual, createCipheriv, createDecipheriv };
