import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";

import {
  commitmentOf,
  nullifierOf,
  ownerOf,
} from "../../../dist/pool/notes.js";
import {
  FIELD_MODULUS,
  VALUE_BOUND,
  fieldToBytes,
} from "../../../dist/pool/field.js";

export const PROFILE = 1;
export const CAPSULE_BYTES = 89;
export const SYNTHETIC_VIEW = "prevalidated-synthetic-view";

const REQUEST_ID_BYTES = 32;
const IDENTIFIER_BYTES = 32;
const PLAINTEXT_BYTES = 72;
const TAG_BYTES = 16;
const NONCE = new Uint8Array(12);
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "length",
).get;

const SPEND_INFO = ascii("moe/wallet/recovery/v1/spend");
const RHO_INFO = ascii("moe/wallet/recovery/v1/rho");
const RECOVERY_INFO = ascii("moe/wallet/recovery/v1/recovery");
const SETTLEMENT_INFO = ascii("moe/wallet/recovery/v1/settlement");
const CAPSULE_INFO_PREFIX = ascii("moe/wallet/recovery/v1/capsule");
const AAD_PREFIX = ascii("moe/wallet/recovery/v1/aad");
const DELIVERY_PREFIX = ascii("moe/pool/v3/delivery");

export class CapsuleFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapsuleFormatError";
  }
}

export class CapsuleAssociationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapsuleAssociationError";
  }
}

function ascii(text) {
  return new TextEncoder().encode(text);
}

function bytes(value, length, what) {
  let actualLength;
  try {
    if (!(value instanceof Uint8Array)) throw new TypeError("not Uint8Array");
    actualLength = TYPED_ARRAY_LENGTH.call(value);
  } catch {
    throw new CapsuleFormatError(`${what} must be ${length} bytes`);
  }
  if (actualLength !== length) throw new CapsuleFormatError(`${what} must be ${length} bytes`);
  const out = new Uint8Array(length);
  Uint8Array.prototype.set.call(out, value);
  return out;
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u32be(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CapsuleFormatError("u32 value out of range");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

export function u64be(value) {
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

function readU64be(input) {
  const value = bytes(input, 8, "u64");
  let out = 0n;
  for (const byte of value) out = (out << 8n) | BigInt(byte);
  return out;
}

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

function bigintFromBytes(input) {
  let out = 0n;
  for (const byte of input) out = (out << 8n) | BigInt(byte);
  return out;
}

function hkdf(ikm, salt, info) {
  return new Uint8Array(hkdfSync("sha256", ikm, salt, info, 32));
}

/** Derive the four independent profile-1 wallet master keys. */
export function deriveMasterKeys(seed, domain) {
  const root = bytes(seed, 32, "wallet root seed");
  const context = bytes(domain, 32, "domain");
  return Object.freeze({
    spendKey: hkdf(root, context, SPEND_INFO),
    rhoKey: hkdf(root, context, RHO_INFO),
    recoveryKey: hkdf(root, context, RECOVERY_INFO),
    settlementKey: hkdf(root, context, SETTLEMENT_INFO),
  });
}

/** C4.2 HMAC rejection sampling, exposed so the probe can inspect retry vectors. */
export function deriveNonzeroFieldWithAttempt(key, preimage) {
  const hmacKey = bytes(key, 32, "HMAC key");
  if (!(preimage instanceof Uint8Array)) {
    throw new CapsuleFormatError("field preimage must be bytes");
  }
  for (let attempt = 0; attempt <= 0xffff_ffff; attempt += 1) {
    const digest = createHmac("sha256", hmacKey)
      .update(preimage)
      .update(u32be(attempt))
      .digest();
    const value = bigintFromBytes(digest);
    if (value !== 0n && value < FIELD_MODULUS) return { value, attempt };
  }
  throw new CapsuleFormatError("field rejection sampling exhausted u32 attempts");
}

export function deriveNonzeroField(key, preimage) {
  return deriveNonzeroFieldWithAttempt(key, preimage).value;
}

function capsuleKey(recoveryKey, domain, commitment) {
  return hkdf(
    bytes(recoveryKey, 32, "recovery key"),
    fieldToBytes(commitment),
    concat(CAPSULE_INFO_PREFIX, bytes(domain, 32, "domain")),
  );
}

function capsuleAad(domain, commitment) {
  return concat(
    AAD_PREFIX,
    Uint8Array.of(PROFILE),
    bytes(domain, 32, "domain"),
    fieldToBytes(commitment),
  );
}

function plaintextOf(requestId, backing, value) {
  return concat(
    bytes(requestId, REQUEST_ID_BYTES, "request identifier"),
    bytes(backing, IDENTIFIER_BYTES, "backing"),
    u64be(value),
  );
}

function parsePlaintext(plaintext) {
  const canonical = bytes(plaintext, PLAINTEXT_BYTES, "capsule plaintext");
  return {
    requestId: canonical.slice(0, 32),
    backing: canonical.slice(32, 64),
    value: readU64be(canonical.slice(64, 72)),
  };
}

// Intentionally private: callers cannot select a commitment independently of
// the plaintext. prepareExactOutput computes both before invoking encryption.
function encryptComputedCapsule(recoveryKey, domain, commitment, plaintext) {
  const key = capsuleKey(recoveryKey, domain, commitment);
  const cipher = createCipheriv("aes-256-gcm", key, NONCE, { authTagLength: TAG_BYTES });
  cipher.setAAD(capsuleAad(domain, commitment), { plaintextLength: PLAINTEXT_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return concat(Uint8Array.of(PROFILE), ciphertext, tag);
}

function requireCapsule(capsule) {
  const framed = bytes(capsule, CAPSULE_BYTES, "profile-1 capsule");
  if (framed[0] !== PROFILE) {
    throw new CapsuleFormatError("unsupported recovery capsule profile");
  }
  return framed;
}

function decryptCapsule(recoveryKey, domain, commitment, capsule) {
  const framed = requireCapsule(capsule);
  const ciphertext = framed.slice(1, 1 + PLAINTEXT_BYTES);
  const tag = framed.slice(1 + PLAINTEXT_BYTES);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    capsuleKey(recoveryKey, domain, commitment),
    NONCE,
    { authTagLength: TAG_BYTES },
  );
  decipher.setAAD(capsuleAad(domain, commitment), { plaintextLength: PLAINTEXT_BYTES });
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    return null;
  }
}

function openingFromRequest(keys, domain, requestId, backing, value) {
  const secretDerivation = deriveNonzeroFieldWithAttempt(keys.spendKey, requestId);
  const rhoDerivation = deriveNonzeroFieldWithAttempt(
    keys.rhoKey,
    concat(requestId, backing, u64be(value)),
  );
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
export function prepareExactOutput(seed, domain, requestId, backing, value) {
  const canonicalDomain = bytes(domain, 32, "domain");
  const canonicalRequestId = bytes(requestId, 32, "request identifier");
  const canonicalBacking = bytes(backing, 32, "backing");
  const canonicalValue = readU64be(u64be(value));
  const keys = deriveMasterKeys(seed, canonicalDomain);
  const prepared = openingFromRequest(
    keys,
    canonicalDomain,
    canonicalRequestId,
    canonicalBacking,
    canonicalValue,
  );
  const plaintext = plaintextOf(canonicalRequestId, canonicalBacking, canonicalValue);
  const capsule = encryptComputedCapsule(keys.recoveryKey, canonicalDomain, prepared.cm, plaintext);
  if (capsule.length !== CAPSULE_BYTES) throw new CapsuleFormatError("wrong capsule length");
  return Object.freeze({
    requestId: canonicalRequestId,
    ...prepared,
    capsule,
  });
}

function recoverWithKeys(keys, domain, commitment, capsule) {
  const plaintext = decryptCapsule(keys.recoveryKey, domain, commitment, capsule);
  if (plaintext === null) return null;
  const decoded = parsePlaintext(plaintext);
  const recovered = openingFromRequest(
    keys,
    domain,
    decoded.requestId,
    decoded.backing,
    decoded.value,
  );
  if (recovered.cm !== commitment) {
    throw new CapsuleAssociationError("authenticated capsule plaintext does not recompute the declared commitment");
  }
  return Object.freeze({ ...decoded, ...recovered });
}

/** Recover an opening and immutable nullifier from only seed, domain, cm and capsule. */
export function recoverCapsule(seed, domain, commitment, capsule) {
  const canonicalDomain = bytes(domain, 32, "domain");
  const keys = deriveMasterKeys(seed, canonicalDomain);
  return recoverWithKeys(keys, canonicalDomain, commitment, capsule);
}

/** Cache only domain-separated master keys for a bulk local scan. */
export function createCapsuleScanner(seed, domain) {
  const canonicalDomain = bytes(domain, 32, "domain");
  const keys = deriveMasterKeys(seed, canonicalDomain);
  let trials = 0;
  let matches = 0;
  return Object.freeze({
    tryRecover(commitment, capsule) {
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

/** SHA256 over the exact ordered C4.4 output vector. */
export function deliveryHash(domain, outputs) {
  const canonicalDomain = bytes(domain, 32, "domain");
  if (!Array.isArray(outputs)) throw new CapsuleFormatError("delivery output vector is missing");
  if (outputs.length > 0xffff_ffff) throw new CapsuleFormatError("too many delivery outputs");
  const hash = createHash("sha256");
  hash.update(DELIVERY_PREFIX);
  hash.update(canonicalDomain);
  hash.update(u32be(outputs.length));
  for (const output of outputs) {
    if (typeof output !== "object" || output === null) {
      throw new CapsuleFormatError("malformed delivery output");
    }
    hash.update(fieldToBytes(output.cm));
    hash.update(requireCapsule(output.capsule));
  }
  return new Uint8Array(hash.digest());
}

export function requireDeliveryVector(domain, outputs, claimedHash) {
  const claimed = bytes(claimedHash, 32, "delivery hash");
  const actual = deliveryHash(domain, outputs);
  if (!equalBytes(actual, claimed)) throw new CapsuleAssociationError("delivery hash mismatch");
  return actual;
}

export function deriveSettlementOwnerSecret(seed, domain, demandStatementHash, acceptanceDeadline) {
  const canonicalDomain = bytes(domain, 32, "domain");
  const demand = bytes(demandStatementHash, 32, "demand statement hash");
  const deadline = u64be(acceptanceDeadline);
  const keys = deriveMasterKeys(seed, canonicalDomain);
  return deriveNonzeroFieldWithAttempt(keys.settlementKey, concat(demand, deadline));
}

function fieldIdentity(value, what) {
  try {
    return fieldToBytes(value);
  } catch {
    throw new CapsuleFormatError(`${what} must be a canonical field element`);
  }
}

function fieldSet(values, what) {
  if (!Array.isArray(values)) throw new CapsuleFormatError(`${what} is missing`);
  return new Set(values.map((value) => Buffer.from(fieldIdentity(value, what)).toString("hex")));
}

function unspentPositive(recovered, spent) {
  return recovered.opening.value > 0n && !spent.has(Buffer.from(fieldToBytes(recovered.nf)).toString("hex"));
}

/**
 * Exercise only the cryptographic seam over a caller-declared, prevalidated
 * synthetic public view. This function does not authenticate records, prove
 * finality, establish range completeness, or discover venues/backings.
 */
export function restoreSyntheticView({
  viewKind,
  seed,
  domain,
  statements,
  spentNullifiers,
  settlements,
}) {
  if (viewKind !== SYNTHETIC_VIEW) {
    throw new CapsuleFormatError("restore requires the explicitly prevalidated synthetic view marker");
  }
  const canonicalDomain = bytes(domain, 32, "domain");
  if (!Array.isArray(statements)) throw new CapsuleFormatError("statement list is missing");
  if (!Array.isArray(settlements)) throw new CapsuleFormatError("settlement list is missing");
  const spent = fieldSet(spentNullifiers, "spent nullifier");
  const scanner = createCapsuleScanner(seed, canonicalDomain);
  const recoveredByNullifier = new Map();
  const pendingAdoptionByNullifier = new Map();

  for (const statement of statements) {
    if (typeof statement !== "object" || statement === null) {
      throw new CapsuleFormatError("malformed statement");
    }
    requireDeliveryVector(canonicalDomain, statement.outputs, statement.deliveryHash);
    for (const output of statement.outputs) {
      const recovered = scanner.tryRecover(output.cm, output.capsule);
      if (recovered !== null && unspentPositive(recovered, spent)) {
        recoveredByNullifier.set(Buffer.from(fieldToBytes(recovered.nf)).toString("hex"), {
          source: "capsule",
          ...recovered,
        });
      }
    }
  }

  let settlementTrials = 0;
  let settlementMatches = 0;
  for (const settlement of settlements) {
    if (typeof settlement !== "object" || settlement === null) {
      throw new CapsuleFormatError("malformed settlement output");
    }
    if (settlement.createdBy !== "prevalidated-canonical-finalized-settlement" &&
        settlement.createdBy !== "prevalidated-force-created-awaiting-adoption") {
      throw new CapsuleFormatError("settlement output lacks a prevalidated canonical creation marker");
    }
    settlementTrials += 1;
    const secretDerivation = deriveSettlementOwnerSecret(
      seed,
      canonicalDomain,
      settlement.demandStatementHash,
      settlement.acceptanceDeadline,
    );
    const owner = ownerOf(secretDerivation.value);
    if (owner !== settlement.owner) continue;
    const opening = Object.freeze({
      backing: bytes(settlement.backing, 32, "settlement backing"),
      value: readU64be(u64be(settlement.value)),
      owner,
      rho: settlement.rho,
    });
    const cm = commitmentOf(canonicalDomain, opening);
    if (cm !== settlement.cm) {
      throw new CapsuleAssociationError("settlement public opening does not recompute its commitment");
    }
    const nf = nullifierOf(canonicalDomain, cm, secretDerivation.value);
    const recovered = Object.freeze({
      source: "settlement",
      demandStatementHash: bytes(settlement.demandStatementHash, 32, "demand statement hash"),
      acceptanceDeadline: settlement.acceptanceDeadline,
      secret: secretDerivation.value,
      opening,
      cm,
      nf,
      attempts: Object.freeze({ settlement: secretDerivation.attempt }),
    });
    settlementMatches += 1;
    if (unspentPositive(recovered, spent)) {
      const key = Buffer.from(fieldToBytes(nf)).toString("hex");
      if (settlement.createdBy === "prevalidated-force-created-awaiting-adoption") {
        pendingAdoptionByNullifier.set(key, Object.freeze({
          ...recovered,
          spendable: false,
          status: "awaiting-canonical-adoption-and-certified-path",
        }));
      } else {
        recoveredByNullifier.set(key, recovered);
      }
    }
  }

  return Object.freeze({
    holdings: Object.freeze([...recoveredByNullifier.values()]),
    pendingAdoption: Object.freeze([...pendingAdoptionByNullifier.values()]),
    stats: Object.freeze({ ...scanner.stats(), settlementTrials, settlementMatches }),
    evidenceScope: SYNTHETIC_VIEW,
    authenticatedFullV3Finality: false,
    completenessClaim: false,
    noMatchesMeansZeroBalance: false,
    unresolvedCoverage: true,
  });
}
