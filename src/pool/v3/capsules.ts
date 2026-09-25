// Receiver-prepared exact outputs and seed recovery, pool-delivery at 02d911c:
// profile-1 master keys and rejection-sampled derivation (C4.2), one 89-byte
// AES-256-GCM capsule per output (C4.3), the scan C4.6 runs over authenticated
// records, and the lit settlement owner secret (C4.7). The ordered delivery
// digest (C4.4) is the record codec's `deliveryHash`. A scan finds candidates;
// it authenticates no record and proves no balance.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import { commitmentOf, nullifierOf, ownerOf, type NoteOpening } from "../notes.js";
import { FIELD_MODULUS, VALUE_BOUND, fieldToBytes } from "../field.js";

export const PROFILE = 1;
export const CAPSULE_BYTES = 89;

const REQUEST_ID_BYTES = 32;
const IDENTIFIER_BYTES = 32;
const PLAINTEXT_BYTES = 72;
const TAG_BYTES = 16;
const NONCE = new Uint8Array(12);
// The intrinsic getter: a subclass cannot misreport a fixed width.
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object, "length")!.get!;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const SPEND_INFO = ascii("moe/wallet/recovery/v1/spend");
const RHO_INFO = ascii("moe/wallet/recovery/v1/rho");
const RECOVERY_INFO = ascii("moe/wallet/recovery/v1/recovery");
const SETTLEMENT_INFO = ascii("moe/wallet/recovery/v1/settlement");
const CAPSULE_INFO_PREFIX = ascii("moe/wallet/recovery/v1/capsule");
const AAD_PREFIX = ascii("moe/wallet/recovery/v1/aad");

export class CapsuleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleFormatError";
  }
}

export class CapsuleAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleAssociationError";
  }
}

export interface MasterKeys {
  readonly spendKey: Uint8Array;
  readonly rhoKey: Uint8Array;
  readonly recoveryKey: Uint8Array;
  readonly settlementKey: Uint8Array;
}
export interface FieldDerivation { readonly value: bigint; readonly attempt: number }
interface Derived {
  readonly secret: bigint;
  readonly opening: NoteOpening;
  readonly cm: bigint;
  readonly nf: bigint;
  readonly attempts: { readonly spend: number; readonly rho: number };
}
export interface PreparedOutput extends Derived {
  readonly requestId: Uint8Array;
  readonly capsule: Uint8Array;
}
export interface RecoveredOutput extends Derived {
  readonly requestId: Uint8Array;
  readonly backing: Uint8Array;
  readonly value: bigint;
}
export interface CapsuleScanner {
  tryRecover(commitment: bigint, capsule: Uint8Array): RecoveredOutput | null;
  stats(): { readonly trials: number; readonly matches: number };
}

/** An owned copy of exactly `length` bytes, read through the intrinsic length. */
function bytes(value: unknown, length: number, what: string): Uint8Array {
  let actualLength: unknown;
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError("not Uint8Array");
    actualLength = TYPED_ARRAY_LENGTH.call(value);
  } catch {
    throw new CapsuleFormatError(`${what} must be ${length} bytes`);
  }
  if (actualLength !== length) throw new CapsuleFormatError(`${what} must be ${length} bytes`);
  const out = new Uint8Array(length);
  Uint8Array.prototype.set.call(out, value as Uint8Array);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CapsuleFormatError("u32 value out of range");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64be(value: unknown): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= VALUE_BOUND) {
    throw new CapsuleFormatError("value must be a u64");
  }
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function bigintFromBytes(input: Uint8Array): bigint {
  let out = 0n;
  for (const byte of input) out = (out << 8n) | BigInt(byte);
  return out;
}

function readU64be(input: Uint8Array): bigint {
  return bigintFromBytes(bytes(input, 8, "u64"));
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", ikm, salt, info, 32));
}

/** Derive the four independent profile-1 wallet master keys. */
export function deriveMasterKeys(seed: Uint8Array, domain: Uint8Array): MasterKeys {
  const root = bytes(seed, 32, "wallet root seed");
  const context = bytes(domain, 32, "domain");
  return Object.freeze({
    spendKey: hkdf(root, context, SPEND_INFO),
    rhoKey: hkdf(root, context, RHO_INFO),
    recoveryKey: hkdf(root, context, RECOVERY_INFO),
    settlementKey: hkdf(root, context, SETTLEMENT_INFO),
  });
}

/** C4.2 HMAC rejection sampling; the attempt is exposed so tests can pin retry vectors. */
export function deriveNonzeroFieldWithAttempt(key: Uint8Array, preimage: Uint8Array): FieldDerivation {
  const hmacKey = bytes(key, 32, "HMAC key");
  if (!(preimage instanceof Uint8Array)) {
    throw new CapsuleFormatError("field preimage must be bytes");
  }
  for (let attempt = 0; attempt <= 0xffff_ffff; attempt += 1) {
    const digest = createHmac("sha256", hmacKey).update(preimage).update(u32be(attempt)).digest();
    const value = bigintFromBytes(digest);
    if (value !== 0n && value < FIELD_MODULUS) return { value, attempt };
  }
  throw new CapsuleFormatError("field rejection sampling exhausted u32 attempts");
}

export function deriveNonzeroField(key: Uint8Array, preimage: Uint8Array): bigint {
  return deriveNonzeroFieldWithAttempt(key, preimage).value;
}

function capsuleKey(recoveryKey: Uint8Array, domain: Uint8Array, commitment: bigint): Uint8Array {
  return hkdf(
    bytes(recoveryKey, 32, "recovery key"),
    fieldToBytes(commitment),
    concat(CAPSULE_INFO_PREFIX, bytes(domain, 32, "domain")),
  );
}

function capsuleAad(domain: Uint8Array, commitment: bigint): Uint8Array {
  return concat(AAD_PREFIX, Uint8Array.of(PROFILE), bytes(domain, 32, "domain"), fieldToBytes(commitment));
}

function plaintextOf(requestId: Uint8Array, backing: Uint8Array, value: bigint): Uint8Array {
  return concat(
    bytes(requestId, REQUEST_ID_BYTES, "request identifier"),
    bytes(backing, IDENTIFIER_BYTES, "backing"),
    u64be(value),
  );
}

function parsePlaintext(plaintext: Uint8Array): { requestId: Uint8Array; backing: Uint8Array; value: bigint } {
  const canonical = bytes(plaintext, PLAINTEXT_BYTES, "capsule plaintext");
  return {
    requestId: canonical.slice(0, 32),
    backing: canonical.slice(32, 64),
    value: readU64be(canonical.slice(64, 72)),
  };
}

// Intentionally private: callers cannot select a commitment independently of
// the plaintext. prepareExactOutput computes both before invoking encryption.
function encryptComputedCapsule(recoveryKey: Uint8Array, domain: Uint8Array, commitment: bigint,
  plaintext: Uint8Array): Uint8Array {
  const key = capsuleKey(recoveryKey, domain, commitment);
  const cipher = createCipheriv("aes-256-gcm", key, NONCE, { authTagLength: TAG_BYTES });
  cipher.setAAD(capsuleAad(domain, commitment), { plaintextLength: PLAINTEXT_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return concat(Uint8Array.of(PROFILE), ciphertext, cipher.getAuthTag());
}

function requireCapsule(capsule: unknown): Uint8Array {
  const framed = bytes(capsule, CAPSULE_BYTES, "profile-1 capsule");
  if (framed[0] !== PROFILE) {
    throw new CapsuleFormatError("unsupported recovery capsule profile");
  }
  return framed;
}

function decryptCapsule(recoveryKey: Uint8Array, domain: Uint8Array, commitment: bigint,
  capsule: unknown): Uint8Array | null {
  const framed = requireCapsule(capsule);
  const ciphertext = framed.slice(1, 1 + PLAINTEXT_BYTES);
  const tag = framed.slice(1 + PLAINTEXT_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", capsuleKey(recoveryKey, domain, commitment), NONCE,
    { authTagLength: TAG_BYTES });
  decipher.setAAD(capsuleAad(domain, commitment), { plaintextLength: PLAINTEXT_BYTES });
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    return null;
  }
}

function openingFromRequest(keys: MasterKeys, domain: Uint8Array, requestId: Uint8Array,
  backing: Uint8Array, value: bigint): Derived {
  const secretDerivation = deriveNonzeroFieldWithAttempt(keys.spendKey, requestId);
  const rhoDerivation = deriveNonzeroFieldWithAttempt(keys.rhoKey, concat(requestId, backing, u64be(value)));
  const owner = ownerOf(secretDerivation.value);
  const opening = Object.freeze({ backing, value, owner, rho: rhoDerivation.value });
  const cm = commitmentOf(domain, opening);
  const nf = nullifierOf(domain, cm, secretDerivation.value);
  return {
    secret: secretDerivation.value,
    opening,
    cm,
    nf,
    attempts: Object.freeze({ spend: secretDerivation.attempt, rho: rhoDerivation.attempt }),
  };
}

/** Prepare the one exact output whose plaintext determines its commitment and key. */
export function prepareExactOutput(seed: Uint8Array, domain: Uint8Array, requestId: Uint8Array,
  backing: Uint8Array, value: bigint): PreparedOutput {
  const canonicalDomain = bytes(domain, 32, "domain");
  const canonicalRequestId = bytes(requestId, 32, "request identifier");
  const canonicalBacking = bytes(backing, 32, "backing");
  const canonicalValue = readU64be(u64be(value));
  const keys = deriveMasterKeys(seed, canonicalDomain);
  const prepared = openingFromRequest(keys, canonicalDomain, canonicalRequestId, canonicalBacking, canonicalValue);
  const plaintext = plaintextOf(canonicalRequestId, canonicalBacking, canonicalValue);
  const capsule = encryptComputedCapsule(keys.recoveryKey, canonicalDomain, prepared.cm, plaintext);
  if (capsule.length !== CAPSULE_BYTES) throw new CapsuleFormatError("wrong capsule length");
  return Object.freeze({ requestId: canonicalRequestId, ...prepared, capsule });
}

function recoverWithKeys(keys: MasterKeys, domain: Uint8Array, commitment: bigint,
  capsule: unknown): RecoveredOutput | null {
  const plaintext = decryptCapsule(keys.recoveryKey, domain, commitment, capsule);
  if (plaintext === null) return null;
  const decoded = parsePlaintext(plaintext);
  const recovered = openingFromRequest(keys, domain, decoded.requestId, decoded.backing, decoded.value);
  if (recovered.cm !== commitment) {
    throw new CapsuleAssociationError("authenticated capsule plaintext does not recompute the declared commitment");
  }
  return Object.freeze({ ...decoded, ...recovered });
}

/** Recover an opening and immutable nullifier from only seed, domain, cm and capsule. */
export function recoverCapsule(seed: Uint8Array, domain: Uint8Array, commitment: bigint,
  capsule: Uint8Array): RecoveredOutput | null {
  const canonicalDomain = bytes(domain, 32, "domain");
  return recoverWithKeys(deriveMasterKeys(seed, canonicalDomain), canonicalDomain, commitment, capsule);
}

/** Cache only domain-separated master keys for a bulk local scan. */
export function createCapsuleScanner(seed: Uint8Array, domain: Uint8Array): CapsuleScanner {
  const canonicalDomain = bytes(domain, 32, "domain");
  const keys = deriveMasterKeys(seed, canonicalDomain);
  let trials = 0;
  let matches = 0;
  return Object.freeze({
    tryRecover(commitment: bigint, capsule: Uint8Array): RecoveredOutput | null {
      trials += 1;
      const recovered = recoverWithKeys(keys, canonicalDomain, commitment, capsule);
      if (recovered !== null) matches += 1;
      return recovered;
    },
    stats() {
      return Object.freeze({ trials, matches });
    },
  });
}

/** C4.7: the lit settlement output's owner secret, from the demand and its acceptance deadline. */
export function deriveSettlementOwnerSecret(seed: Uint8Array, domain: Uint8Array,
  demandStatementHash: Uint8Array, acceptanceDeadline: bigint): FieldDerivation {
  const canonicalDomain = bytes(domain, 32, "domain");
  const demand = bytes(demandStatementHash, 32, "demand statement hash");
  const deadline = u64be(acceptanceDeadline);
  const keys = deriveMasterKeys(seed, canonicalDomain);
  return deriveNonzeroFieldWithAttempt(keys.settlementKey, concat(demand, deadline));
}
