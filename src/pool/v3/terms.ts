// Candidate root-terms bytes for pool-v3 §§11.2–11.3 at 916bffb.
// Identity/signature evidence supplies no registration, currentness or adoption.
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bigintToMinimalBytes, ByteReader, ByteWriter, compareBytes, copyUnshared,
  EncodingError, MAX_QUANTITY_BYTES, minimalBytesToBigint, validateQuantity,
} from "../../bytes.js";
import { BACKING_SIGNATURE_CONTEXT, TERMS_MAGIC as MAGIC, utf8Decoder, utf8Encoder } from "../../contexts.js";
import { isValidPublicKey, verifySignatureStrict } from "../../keys.js";

export const MAX_ROOT_TERMS_BYTES = 1305;
const CONSTRUCTION = utf8Encoder.encode("moe/pool/v3");
const MAX_U64 = (1n << 64n) - 1n;

export interface RootTerms {
  readonly obligor: Uint8Array;
  readonly payout: {
    readonly thing: string;
    readonly quantumExponent: number;
    readonly perUnit: bigint;
  };
  readonly operator: Uint8Array;
  readonly configuration: Uint8Array;
  readonly venue: Uint8Array;
  readonly interval: bigint;
  readonly silence?: { readonly noCommitmentDuration: bigint; readonly challengeWindow: bigint };
  readonly replacementRule?: Uint8Array;
  readonly nonService?: { readonly duration: bigint; readonly count: bigint; readonly window: bigint };
}

/** An owned copy, never over shared memory, judged by its own length. */
function own(bytes: Uint8Array, max: number, what: string, exact = false): Uint8Array {
  const copy = copyUnshared(bytes);
  if (copy.length > max || (exact && copy.length !== max)) throw new EncodingError(`invalid ${what} bytes`);
  return copy;
}
function key(bytes: Uint8Array, what: string): Uint8Array {
  const result = own(bytes, 32, what, true);
  if (!isValidPublicKey(result)) throw new EncodingError(`invalid ${what} key`);
  return result;
}
function object(value: unknown, what: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EncodingError(`invalid ${what}`);
  }
}
function unsigned(value: bigint, max: bigint, what: string): void {
  if (typeof value !== "bigint" || value < 0n || value > max) throw new EncodingError(`invalid ${what}`);
}

/** Emits only the constant-payout, empty-reliance v3 profile. */
export function encodeRootTerms(fields: RootTerms): Uint8Array {
  // Every field is read once; the checks and the writes below use those reads.
  object(fields, "root terms");
  const payout = fields.payout;
  object(payout, "payout");
  if ("backing" in payout || "reliance" in fields) throw new EncodingError("unsupported root terms shape");
  const obligor = key(fields.obligor, "obligor"), operator = key(fields.operator, "operator");
  const configuration = own(fields.configuration, 32, "configuration", true);
  const venue = own(fields.venue, 32, "venue", true);
  const { thing, quantumExponent, perUnit } = payout;
  // A code-unit bound prevents an oversized string allocation before UTF-8 encoding.
  if (typeof thing !== "string" || thing.length === 0 || thing.length > 1024 || !thing.isWellFormed()) {
    throw new EncodingError("invalid payout thing");
  }
  const thingBytes = utf8Encoder.encode(thing);
  if (thingBytes.length > 1024) throw new EncodingError("payout thing too long");
  if (!Number.isInteger(quantumExponent) || quantumExponent < -128 || quantumExponent > 127) {
    throw new EncodingError("invalid quantum exponent");
  }
  validateQuantity(perUnit, "payout per unit");
  const interval = fields.interval;
  unsigned(interval, MAX_U64, "witness interval");
  const { silence: silenceField, nonService: nonServiceField, replacementRule: ruleField } = fields;
  let silence: { noCommitmentDuration: bigint; challengeWindow: bigint } | undefined;
  if (silenceField !== undefined) {
    object(silenceField, "silence clause");
    const { noCommitmentDuration, challengeWindow } = silenceField;
    unsigned(noCommitmentDuration, MAX_U64, "no-commitment duration");
    unsigned(challengeWindow, MAX_U64, "challenge window");
    silence = { noCommitmentDuration, challengeWindow };
  }
  const replacementRule = ruleField === undefined ? undefined : key(ruleField, "replacement");
  let nonService: { duration: bigint; count: bigint; window: bigint } | undefined;
  if (nonServiceField !== undefined) {
    object(nonServiceField, "non-service clause");
    const { duration, count, window } = nonServiceField;
    unsigned(duration, MAX_U64, "non-service duration");
    unsigned(count, 0xffff_ffffn, "non-service count");
    unsigned(window, MAX_U64, "non-service window");
    nonService = { duration, count, window };
  }
  const w = new ByteWriter();
  w.fixed(MAGIC, 4, "magic"); w.u8(1); w.u8(1); w.key32(obligor, "obligor");
  w.u8(1); w.lengthPrefixed(thingBytes); w.i8(quantumExponent);
  w.lengthPrefixed(bigintToMinimalBytes(perUnit)); w.u32(0);
  w.u8(5); w.key32(operator, "operator");
  w.u32(2 + Number(silence !== undefined) + Number(replacementRule !== undefined) + Number(nonService !== undefined));
  if (silence !== undefined) { w.u8(1); w.u64(silence.noCommitmentDuration); w.u64(silence.challengeWindow); }
  w.u8(2); w.key32(venue, "venue"); w.u64(interval);
  if (replacementRule !== undefined) { w.u8(3); w.key32(replacementRule, "replacement"); }
  if (nonService !== undefined) { w.u8(4); w.u64(nonService.duration); w.u32(Number(nonService.count)); w.u64(nonService.window); }
  w.u8(5); w.lengthPrefixed(CONSTRUCTION); w.key32(configuration, "configuration");
  return w.finish();
}

/** Strict, bounded decoding; every returned byte field owns its buffer. */
export function decodeRootTerms(bytes: Uint8Array): RootTerms {
  const r = new ByteReader(own(bytes, MAX_ROOT_TERMS_BYTES, "root terms"));
  if (compareBytes(r.raw(4), MAGIC) !== 0 || r.u8() !== 1 || r.u8() !== 1) {
    throw new EncodingError("unsupported root terms prefix");
  }
  const obligor = r.raw(32);
  if (r.u8() !== 1) throw new EncodingError("unsupported payout");
  const thingBytes = r.lengthPrefixed(1024);
  let thing: string;
  try { thing = utf8Decoder.decode(thingBytes); }
  catch { throw new EncodingError("invalid payout UTF-8"); }
  const payout = { thing, quantumExponent: r.i8(), perUnit: minimalBytesToBigint(r.lengthPrefixed(MAX_QUANTITY_BYTES)) };
  if (r.u32() !== 0) throw new EncodingError("unsupported reliance");
  if (r.u8() !== 5) throw new EncodingError("unsupported evidence");
  const operator = r.raw(32), count = r.u32();
  if (count < 2 || count > 5) throw new EncodingError("invalid clause count");
  let previous = 0;
  let venue: Uint8Array | undefined, interval: bigint | undefined, configuration: Uint8Array | undefined;
  let silence: RootTerms["silence"], replacementRule: Uint8Array | undefined, nonService: RootTerms["nonService"];
  for (let i = 0; i < count; i++) {
    const tag = r.u8();
    if (tag <= previous) throw new EncodingError("noncanonical clause order");
    previous = tag;
    switch (tag) {
      case 1: silence = { noCommitmentDuration: r.u64(), challengeWindow: r.u64() }; break;
      case 2: venue = r.raw(32); interval = r.u64(); break;
      case 3: replacementRule = r.raw(32); break;
      case 4: nonService = { duration: r.u64(), count: BigInt(r.u32()), window: r.u64() }; break;
      case 5:
        if (compareBytes(r.lengthPrefixed(CONSTRUCTION.length), CONSTRUCTION) !== 0) {
          throw new EncodingError("unsupported construction");
        }
        configuration = r.raw(32); break;
      default: throw new EncodingError("unsupported clause");
    }
  }
  r.expectEnd();
  if (venue === undefined || interval === undefined || configuration === undefined) throw new EncodingError("missing required clause");
  const fields: RootTerms = {
    obligor, payout: Object.freeze(payout), operator, configuration, venue, interval,
    ...(silence === undefined ? {} : { silence: Object.freeze(silence) }),
    ...(replacementRule === undefined ? {} : { replacementRule }),
    ...(nonService === undefined ? {} : { nonService: Object.freeze(nonService) }),
  };
  // Reuse constructor validation for key, quantity and field semantics.
  encodeRootTerms(fields);
  return Object.freeze(fields);
}

export function rootTermsName(bytes: Uint8Array): Uint8Array {
  const snapshot = own(bytes, MAX_ROOT_TERMS_BYTES, "root terms");
  decodeRootTerms(snapshot);
  return sha256(snapshot);
}
export function rootTermsSignatureMessage(bytes: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  w.context(BACKING_SIGNATURE_CONTEXT); w.key32(rootTermsName(bytes), "backing name");
  return w.finish();
}
/** A true result authenticates terms only; no current authority is inferred. */
export function verifyRootTermsSignature(bytes: Uint8Array, signature: Uint8Array): boolean {
  try {
    const snapshot = own(bytes, MAX_ROOT_TERMS_BYTES, "root terms");
    const sig = own(signature, 64, "signature", true);
    const fields = decodeRootTerms(snapshot);
    return verifySignatureStrict(sig, rootTermsSignatureMessage(snapshot), fields.obligor);
  } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
}
