// Canonical byte conformance for pool-v3 §§5–7 at 4a58fdc. No adopted
// configuration, proof verifier, admission or replay. Move this codec and its
// tests into the single runtime path only after final v3 configuration review.
import { sha256 } from "@noble/hashes/sha2.js";
import { ByteReader, ByteWriter, compareBytes, EncodingError } from "../src/bytes.js";
import { bytesToField, fieldToBytes, identifierOf, isField, isValue } from "../src/pool/field.js";

export type Kind = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const COUNTS = [0, 11, 15, 15, 16, 7, 17, 7] as const;
const AUTH_LENGTHS = [0, 64, 0, 0, 0, 64, 136, 0] as const;
const CAPSULE_COUNTS = [0, 1, 4, 1, 0, 0, 0, 0] as const;
const MAX_PROOF = 131072;
const context = (name: string): Uint8Array => new TextEncoder().encode(`moe/pool/v3/${name}`);
const STATEMENT = context("statement"), ACCEPTANCE = context("acceptance"),
  RELEASE = context("release"), WITHDRAWAL = context("withdrawal"),
  PUBLICATION = context("publication"), DELIVERY = context("delivery");

export interface Statement {
  readonly domain: Uint8Array;
  readonly kind: Kind;
  readonly publicInputs: readonly bigint[];
}
export interface Record extends Statement {
  readonly proof: Uint8Array;
  readonly authorization: Uint8Array;
  readonly capsules: readonly Uint8Array[];
}
export interface Acceptance {
  readonly domain: Uint8Array;
  readonly demand: Uint8Array;
  readonly owner: bigint;
  readonly deadline: bigint;
}
export interface SignedAcceptance extends Acceptance { readonly signature: Uint8Array }
export type Publication = {
  readonly domain: Uint8Array;
  readonly backing: Uint8Array;
} & (
  | { readonly kind: 2; readonly acceptance: SignedAcceptance }
  | { readonly kind: 1 | 3 | 4 | 5; readonly record: Record }
);

function requireObject(value: unknown): void {
  if (typeof value !== "object" || value === null) throw new EncodingError("not an object");
}
function requireBytes(value: unknown, length: number): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new EncodingError("wrong byte type or length");
}
function fixed(w: ByteWriter, value: Uint8Array, length = 32): void {
  requireBytes(value, length);
  w.fixed(value, length, "fixed field");
}
function same(a: Uint8Array, b: Uint8Array): void {
  if (compareBytes(a, b) !== 0) throw new EncodingError("inconsistent domain, backing or digest");
}
function requireKind(value: unknown): asserts value is Kind {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 7) {
    throw new EncodingError("unknown statement kind");
  }
}
function readContext(r: ByteReader, tag: Uint8Array): void { same(r.raw(tag.length), tag); }
function pair(p: readonly bigint[], i: number): Uint8Array {
  return identifierOf(p[i]!, p[i + 1]!);
}

/** Ranges are checked even on proofless withdrawal and external encoder inputs. */
function requireStatement(s: Statement): void {
  requireObject(s);
  requireBytes(s.domain, 32);
  requireKind(s.kind);
  const p = s.publicInputs;
  if (!Array.isArray(p) || p.length !== COUNTS[s.kind]) throw new EncodingError("wrong public-input count");
  for (let i = 0; i < p.length; i++) if (!isField(p[i])) throw new EncodingError("noncanonical public input");
  same(s.domain, pair(p, 0));
  if (s.kind === 7) {
    pair(p, 2);
    if (!isValue(p[6])) throw new EncodingError("refresh outside u64");
    return;
  }
  pair(p, 2); // segment
  if (s.kind === 5) { pair(p, 5); return; }
  if (s.kind !== 2) {
    pair(p, 5); // backing
    if (!isValue(p[7]) || p[7] === 0n) throw new EncodingError("quantity outside positive u64");
  }
  if (s.kind <= 3) pair(p, p.length - 2); // delivery digest
  if (s.kind === 4) {
    pair(p, 12); // presenter
    if (!isValue(p[14]) || !isValue(p[15])) throw new EncodingError("time outside u64");
  }
  if (s.kind === 6) pair(p, 15); // demand
}

export function statementBytes(s: Statement): Uint8Array {
  requireStatement(s);
  const w = new ByteWriter();
  w.context(STATEMENT); fixed(w, s.domain); w.u8(s.kind); w.u32(s.publicInputs.length);
  for (const p of s.publicInputs) fixed(w, fieldToBytes(p));
  return w.finish();
}
export function statementHash(s: Statement): Uint8Array { return sha256(statementBytes(s)); }

/** C4.4's digest preimage uses public commitments; capsules do not repeat them. */
export function deliveryHash(domain: Uint8Array, outputs: readonly bigint[], capsules: readonly Uint8Array[]): Uint8Array {
  requireBytes(domain, 32);
  if (!Array.isArray(outputs) || !Array.isArray(capsules) ||
      (outputs.length !== 1 && outputs.length !== 4) || capsules.length !== outputs.length) {
    throw new EncodingError("wrong delivery vector count");
  }
  const w = new ByteWriter(); w.context(DELIVERY); fixed(w, domain); w.u32(outputs.length);
  for (let i = 0; i < outputs.length; i++) {
    fixed(w, fieldToBytes(outputs[i]!));
    requireBytes(capsules[i], 89);
    if (capsules[i]![0] !== 1) throw new EncodingError("unsupported capsule profile");
    fixed(w, capsules[i]!, 89);
  }
  return sha256(w.finish());
}

function requireRecord(s: Record): void {
  requireStatement(s);
  if (!(s.proof instanceof Uint8Array) || (s.kind === 5 ? s.proof.length !== 0 :
      s.proof.length === 0 || s.proof.length > MAX_PROOF || s.proof.length % 32 !== 0)) {
    throw new EncodingError("wrong proof length");
  }
  requireBytes(s.authorization, AUTH_LENGTHS[s.kind]);
  if (!Array.isArray(s.capsules) || s.capsules.length !== CAPSULE_COUNTS[s.kind]) {
    throw new EncodingError("wrong capsule count");
  }
  if (s.capsules.length) {
    const p = s.publicInputs;
    const outputs = s.kind === 1 ? [p[8]!] : s.kind === 2 ? p.slice(9, 13) : [p[12]!];
    same(pair(p, p.length - 2), deliveryHash(s.domain, outputs, s.capsules));
  }
}

export function encodeRecord(s: Record): Uint8Array {
  requireRecord(s);
  const w = new ByteWriter();
  w.context(statementBytes(s)); w.lengthPrefixed(s.proof); w.lengthPrefixed(s.authorization);
  w.u32(s.capsules.length);
  for (const capsule of s.capsules) fixed(w, capsule, 89);
  return w.finish();
}

/** Strict canonical inverse; returned arrays never alias input bytes, including Buffer. */
export function decodeRecord(bytes: Uint8Array): Record {
  const r = new ByteReader(bytes); readContext(r, STATEMENT);
  const domain = r.raw(32), kind = r.u8(); requireKind(kind);
  const count = r.u32();
  if (count !== COUNTS[kind]) throw new EncodingError("wrong public-input count");
  const publicInputs = Array.from({ length: count }, () => bytesToField(r.raw(32)));
  requireStatement({ domain, kind, publicInputs });
  const proof = r.lengthPrefixed(kind === 5 ? 0 : MAX_PROOF);
  const authorization = r.lengthPrefixed(AUTH_LENGTHS[kind]);
  const capsuleCount = r.u32();
  if (capsuleCount !== CAPSULE_COUNTS[kind]) throw new EncodingError("wrong capsule count");
  const capsules = Array.from({ length: capsuleCount }, () => r.raw(89));
  r.expectEnd();
  const result = Object.freeze({ domain, kind, publicInputs: Object.freeze(publicInputs),
    proof, authorization, capsules: Object.freeze(capsules) });
  requireRecord(result);
  return result;
}

export interface EvidenceDigests {
  readonly statementHash: Uint8Array;
  readonly proofHash: Uint8Array;
  readonly signatureHash: Uint8Array;
}

/** pool-v3 §7.1: hash ACTUAL supplied fields, even with invalid lengths or
 * signatures. Never replace unavailable/unparseable data with empty bytes.
 * This does not validate record shape, proof, authorization or state. */
export function hashEvidenceFields(statement: Uint8Array, proof: Uint8Array, authorization: Uint8Array): EvidenceDigests {
  requireBytes(statement, 32);
  if (!(proof instanceof Uint8Array) || !(authorization instanceof Uint8Array)) throw new EncodingError("missing evidence bytes");
  return Object.freeze({ statementHash: Uint8Array.from(statement),
    proofHash: proof.length ? sha256(proof) : new Uint8Array(32),
    signatureHash: authorization.length ? sha256(authorization) : new Uint8Array(32) });
}

/** Convenience for a canonical record; raw failing fields use hashEvidenceFields. */
export function evidenceHashes(s: Record): EvidenceDigests {
  requireRecord(s);
  return hashEvidenceFields(statementHash(s), s.proof, s.authorization);
}

export function acceptanceBytes(a: Acceptance): Uint8Array {
  requireObject(a);
  if (!isField(a.owner) || a.owner === 0n || !isValue(a.deadline)) throw new EncodingError("invalid acceptance owner or deadline");
  const w = new ByteWriter(); w.context(ACCEPTANCE);
  fixed(w, a.domain); fixed(w, a.demand); fixed(w, fieldToBytes(a.owner)); w.u64(a.deadline);
  return w.finish();
}
export function acceptanceId(a: Acceptance): Uint8Array { return sha256(acceptanceBytes(a)); }
export function releaseBytes(domain: Uint8Array, demand: Uint8Array, acceptance: Uint8Array, settlement: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(RELEASE);
  for (const id of [domain, demand, acceptance, settlement]) fixed(w, id);
  return w.finish();
}
export function withdrawalBytes(s: Statement): Uint8Array {
  requireStatement(s);
  if (s.kind !== 5) throw new EncodingError("not a withdrawal");
  const w = new ByteWriter(); w.context(WITHDRAWAL); fixed(w, s.domain); fixed(w, statementHash(s));
  return w.finish();
}

/** Reconstruct exact signing messages; the caller must verify both signatures
 * and resolve the demand/terms/state/time. This function grants no authority. */
export function settlementAuthorization(s: Record): {
  acceptance: SignedAcceptance; acceptanceMessage: Uint8Array; releaseMessage: Uint8Array; releaseSignature: Uint8Array;
} {
  requireRecord(s);
  if (s.kind !== 6) throw new EncodingError("not a settlement");
  const r = new ByteReader(s.authorization);
  const deadline = r.u64(), signature = r.raw(64), releaseSignature = r.raw(64); r.expectEnd();
  const acceptance: SignedAcceptance = { domain: Uint8Array.from(s.domain), demand: pair(s.publicInputs, 15),
    owner: s.publicInputs[8]!, deadline, signature };
  return { acceptance, acceptanceMessage: acceptanceBytes(acceptance),
    releaseMessage: releaseBytes(s.domain, acceptance.demand, acceptanceId(acceptance), statementHash(s)), releaseSignature };
}

const PUBLICATION_STATEMENT = { 1: 4, 3: 6, 4: 5, 5: 7 } as const;
function requirePublicationKind(value: unknown): asserts value is Publication["kind"] {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 5) throw new EncodingError("unknown publication kind");
}
function bodyBound(kind: Publication["kind"]): number {
  if (kind === 2) return 190;
  const k = PUBLICATION_STATEMENT[kind];
  return 58 + 32 * COUNTS[k] + 12 + (k === 5 ? 0 : MAX_PROOF) + AUTH_LENGTHS[k] + 89 * CAPSULE_COUNTS[k];
}
function requireRouting(p: Publication): void {
  requireObject(p); requirePublicationKind(p.kind);
  requireBytes(p.domain, 32); requireBytes(p.backing, 32);
  if (p.kind === 2) {
    requireObject(p.acceptance); requireBytes(p.acceptance.domain, 32);
    same(p.domain, p.acceptance.domain);
  } else {
    requireRecord(p.record);
    if (p.record.kind !== PUBLICATION_STATEMENT[p.kind]) throw new EncodingError("wrong publication body kind");
    same(p.domain, p.record.domain);
    if (p.kind !== 4) same(p.backing, pair(p.record.publicInputs, p.kind === 5 ? 2 : 5));
  }
  // Acceptance/withdrawal require a resolved demand to check routing. This
  // codec deliberately returns no evidence/force/first-index classification.
}
export function encodePublication(p: Publication): Uint8Array {
  requireRouting(p);
  let body: Uint8Array;
  if (p.kind === 2) {
    const w = new ByteWriter(); w.context(acceptanceBytes(p.acceptance)); fixed(w, p.acceptance.signature, 64); body = w.finish();
  } else body = encodeRecord(p.record);
  const w = new ByteWriter(); w.context(PUBLICATION); fixed(w, p.domain); fixed(w, p.backing); w.u8(p.kind);
  w.lengthPrefixed(body); return w.finish();
}
export function publicationId(p: Publication): Uint8Array { return sha256(encodePublication(p)); }

/** Kinds 2 and 4 still need their demand to validate backing routing after decoding. */
export function decodePublication(bytes: Uint8Array): Publication {
  const r = new ByteReader(bytes); readContext(r, PUBLICATION);
  const domain = r.raw(32), backing = r.raw(32), kind = r.u8(); requirePublicationKind(kind);
  const body = r.lengthPrefixed(bodyBound(kind)); r.expectEnd();
  let result: Publication;
  if (kind === 2) {
    const b = new ByteReader(body); readContext(b, ACCEPTANCE);
    const acceptance = Object.freeze({ domain: b.raw(32), demand: b.raw(32), owner: bytesToField(b.raw(32)),
      deadline: b.u64(), signature: b.raw(64) }); b.expectEnd(); acceptanceBytes(acceptance);
    result = { domain, backing, kind, acceptance };
  } else result = { domain, backing, kind, record: decodeRecord(body) };
  requireRouting(result);
  return Object.freeze(result);
}
