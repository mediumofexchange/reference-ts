// Canonical lit statements, records, signed objects and publications (lit-v1
// §§2–4, a draft until adopted). Decoding establishes structure, key encodings
// and positive values only: no membership, spentness, locks, time, finality or
// admission. The derived values and arithmetic below are state-free functions
// of one statement (and, for a settlement, its demand).
import { sha256 } from "@noble/hashes/sha2.js";
import { arrayLength, byteLength, ByteReader, ByteWriter, compareBytes, copyArray, copyBytes, EncodingError } from "../bytes.js";
import {
  LIT_ACCEPTANCE_CONTEXT as ACCEPTANCE, LIT_PUBLICATION_CONTEXT as PUBLICATION, LIT_RELEASE_CONTEXT as RELEASE,
  LIT_STATEMENT_CONTEXT as STATEMENT,
} from "../contexts.js";
import { verifySignatureStrict } from "../keys.js";
import { MAX_INPUTS, MAX_OUTPUTS } from "./configuration.js";
import {
  field32, issueRho, key32, noteCommitment, noteNullifier, OPENING_BYTES, type Opening, type Output, OUTPUT_BYTES,
  ownOpening, ownOutput, positive, spendRho, writeOpening, writeOutput,
} from "./notes.js";

const MAX_U64 = (1n << 64n) - 1n;
export type Kind = 1 | 2 | 3 | 4 | 5 | 6 | 7;
interface Framed { readonly domain: Uint8Array }
export interface Issue extends Framed {
  readonly kind: 1; readonly segment: Uint8Array; readonly backing: Uint8Array; readonly quantity: bigint;
  readonly owner: Uint8Array; readonly nonce: Uint8Array;
}
export interface Spend extends Framed {
  readonly kind: 2; readonly segment: Uint8Array; readonly inputs: readonly Opening[]; readonly outputs: readonly Output[];
}
export interface Burn extends Framed {
  readonly kind: 3; readonly segment: Uint8Array; readonly quantity: bigint; readonly inputs: readonly Opening[];
  readonly outputs: readonly Output[];
}
export interface Demand extends Framed {
  readonly kind: 4; readonly segment: Uint8Array; readonly inputs: readonly Opening[]; readonly presenter: Uint8Array;
  readonly instant: bigint; readonly deadline: bigint;
}
export interface Withdraw extends Framed { readonly kind: 5; readonly segment: Uint8Array; readonly demand: Uint8Array }
export interface Settle extends Framed {
  readonly kind: 6; readonly segment: Uint8Array; readonly demand: Uint8Array; readonly owner: Uint8Array;
}
export interface Request extends Framed { readonly kind: 7; readonly input: Opening; readonly refresh: bigint }
export type Statement = Issue | Spend | Burn | Demand | Withdraw | Settle | Request;
export interface LitRecord {
  readonly statement: Statement;
  readonly authorization: Uint8Array;
}

/** The 53 bytes before a statement's body: context, configuration hash and kind. */
export const STATEMENT_PREFIX_BYTES = STATEMENT.length + 33;
const SETTLEMENT_AUTHORIZATION_BYTES = 136;

function object(value: unknown, what: string): asserts value is { readonly [key: string]: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EncodingError(`invalid ${what}`);
}
function u64(value: unknown, what: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) throw new EncodingError(`${what} outside u64`);
  return value;
}
/** Length read once and bounded before any element is read; elements read once each, never through an iterator. */
function list<T>(value: unknown, min: number, max: number, own: (item: unknown) => T, what: string): readonly T[] {
  if (!Array.isArray(value)) throw new EncodingError(`invalid ${what}`);
  const n = arrayLength(value);
  if (n < min || n > max) throw new EncodingError(`wrong ${what} count`);
  const copy = copyArray(value as readonly unknown[], own, max);
  if (copy.length < min) throw new EncodingError(`wrong ${what} count`);
  return Object.freeze(copy);
}
const inputs = (value: unknown): readonly Opening[] => list(value, 1, MAX_INPUTS, ownOpening, "input");

/** An owned, checked, frozen statement; every field is read once. */
export function ownStatement(value: Statement): Statement {
  object(value, "statement");
  const s = value as unknown as { readonly [key: string]: unknown };
  const domain = field32(s.domain, "domain"), kind = s.kind;
  switch (kind) {
    case 1: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), backing: field32(s.backing, "backing"),
      quantity: positive(s.quantity, "quantity"), owner: key32(s.owner, "owner"), nonce: field32(s.nonce, "nonce") });
    case 2: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), inputs: inputs(s.inputs),
      outputs: list(s.outputs, 1, MAX_OUTPUTS, ownOutput, "output") });
    case 3: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), quantity: positive(s.quantity, "quantity"),
      inputs: inputs(s.inputs), outputs: list(s.outputs, 0, 1, ownOutput, "output") });
    case 4: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), inputs: inputs(s.inputs),
      presenter: key32(s.presenter, "presenter"), instant: u64(s.instant, "instant"), deadline: u64(s.deadline, "deadline") });
    case 5: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), demand: field32(s.demand, "demand") });
    case 6: return Object.freeze({ domain, kind, segment: field32(s.segment, "segment"), demand: field32(s.demand, "demand"),
      owner: key32(s.owner, "owner") });
    case 7: return Object.freeze({ domain, kind, input: ownOpening(s.input), refresh: u64(s.refresh, "refresh") });
    default: throw new EncodingError("unknown statement kind");
  }
}

function writeStatement(w: ByteWriter, s: Statement): void {
  w.context(STATEMENT); w.key32(s.domain, "domain"); w.u8(s.kind);
  if (s.kind !== 7) w.key32(s.segment, "segment");
  switch (s.kind) {
    case 1: writeOutput(w, { backing: s.backing, value: s.quantity, owner: s.owner }); w.key32(s.nonce, "nonce"); break;
    case 2: case 3:
      if (s.kind === 3) w.u64(s.quantity);
      w.u8(s.inputs.length); for (const input of s.inputs) writeOpening(w, input);
      w.u8(s.outputs.length); for (const output of s.outputs) writeOutput(w, output);
      break;
    case 4:
      w.u8(s.inputs.length); for (const input of s.inputs) writeOpening(w, input);
      w.key32(s.presenter, "presenter"); w.u64(s.instant); w.u64(s.deadline); break;
    case 5: w.key32(s.demand, "demand"); break;
    case 6: w.key32(s.demand, "demand"); w.key32(s.owner, "owner"); break;
    case 7: writeOpening(w, s.input); w.u64(s.refresh); break;
  }
}
export function statementBytes(s: Statement): Uint8Array {
  const w = new ByteWriter(); writeStatement(w, ownStatement(s)); return w.finish();
}
export function statementHash(s: Statement): Uint8Array { return sha256(statementBytes(s)); }

function readOutput(r: ByteReader): Output { return { backing: r.raw(32), value: r.u64(), owner: r.raw(32) }; }
function readOpening(r: ByteReader): Opening { return { ...readOutput(r), rho: r.raw(32) }; }
function readCount(r: ByteReader, min: number, max: number): number {
  const n = r.u8();
  if (n < min || n > max) throw new EncodingError("wrong input or output count");
  return n;
}
function readStatement(r: ByteReader): Statement {
  if (compareBytes(r.raw(STATEMENT.length), STATEMENT) !== 0) throw new EncodingError("wrong statement context");
  const domain = r.raw(32), kind = r.u8();
  if (kind < 1 || kind > 7) throw new EncodingError("unknown statement kind");
  if (kind === 7) return ownStatement({ domain, kind, input: readOpening(r), refresh: r.u64() });
  const segment = r.raw(32);
  let s: Statement;
  switch (kind) {
    case 1: { const o = readOutput(r); s = { domain, kind, segment, backing: o.backing, quantity: o.value, owner: o.owner, nonce: r.raw(32) }; break; }
    case 2: case 3: {
      const quantity = kind === 3 ? r.u64() : 0n;
      const ins = Array.from({ length: readCount(r, 1, MAX_INPUTS) }, () => readOpening(r));
      const outs = Array.from({ length: readCount(r, kind === 2 ? 1 : 0, kind === 2 ? MAX_OUTPUTS : 1) }, () => readOutput(r));
      s = kind === 2 ? { domain, kind, segment, inputs: ins, outputs: outs } : { domain, kind, segment, quantity, inputs: ins, outputs: outs };
      break;
    }
    case 4: {
      const ins = Array.from({ length: readCount(r, 1, MAX_INPUTS) }, () => readOpening(r));
      s = { domain, kind, segment, inputs: ins, presenter: r.raw(32), instant: r.u64(), deadline: r.u64() }; break;
    }
    case 5: s = { domain, kind, segment, demand: r.raw(32) }; break;
    default: s = { domain, kind: 6, segment, demand: r.raw(32), owner: r.raw(32) }; break;
  }
  return ownStatement(s);
}
/** The exact statement frame (§3); no trailing byte, alternate spelling or optional field. */
export function decodeStatement(bytes: Uint8Array): Statement {
  const r = new ByteReader(bytes), s = readStatement(r); r.expectEnd(); return s;
}

/** §3's authorization length for a statement: K, an owner per input, the presenter key, or a settlement's 136 bytes. */
export function authorizationLength(s: Statement): number {
  switch (s.kind) {
    case 2: case 3: case 4: return 64 * s.inputs.length;
    case 6: return SETTLEMENT_AUTHORIZATION_BYTES;
    default: return 64;
  }
}
function ownRecord(value: LitRecord): LitRecord {
  object(value, "record");
  const { statement: statementIn, authorization: authorizationIn } = value;
  const statement = ownStatement(statementIn);
  let authorization: Uint8Array;
  try { authorization = copyBytes(authorizationIn); } catch { throw new EncodingError("invalid authorization"); }
  if (authorization.length !== authorizationLength(statement)) throw new EncodingError("wrong authorization length");
  return Object.freeze({ statement, authorization });
}
/** `u32 statementLength || statement || u32 authorizationLength || authorization` (§3). */
export function encodeRecord(record: LitRecord): Uint8Array {
  const r = ownRecord(record), w = new ByteWriter();
  w.lengthPrefixed(statementBytes(r.statement)); w.lengthPrefixed(r.authorization);
  return w.finish();
}
/** A record's two fields, split without decoding; refuses unless `8 + statementLength + authorizationLength`
 * is its whole length. The fields are the evidence a chain hashes, whether or not they decode. */
export function splitRecord(bytes: Uint8Array): { readonly statement: Uint8Array; readonly authorization: Uint8Array } {
  const r = new ByteReader(bytes);
  const statement = r.lengthPrefixed(Number.MAX_SAFE_INTEGER), authorization = r.lengthPrefixed(Number.MAX_SAFE_INTEGER);
  r.expectEnd();
  return Object.freeze({ statement, authorization });
}
/** Strict canonical inverse of encodeRecord: proves neither signatures nor admission. */
export function decodeRecord(bytes: Uint8Array): LitRecord {
  const { statement, authorization } = splitRecord(bytes);
  return ownRecord({ statement: decodeStatement(statement), authorization });
}

export interface EvidencePair {
  readonly statementHash: Uint8Array;
  readonly signatureHash: Uint8Array;
}
/** §5's digests of the ACTUAL fields, whatever their validity or length; every valid kind has an authorization,
 * so an empty one hashes as itself, never as a sentinel. */
export function hashEvidenceFields(statement: Uint8Array, authorization: Uint8Array): EvidencePair {
  let s: Uint8Array, a: Uint8Array;
  try { s = copyBytes(statement); a = copyBytes(authorization); } catch { throw new EncodingError("missing evidence bytes"); }
  return Object.freeze({ statementHash: sha256(s), signatureHash: sha256(a) });
}
export function evidencePair(record: LitRecord): EvidencePair {
  const r = ownRecord(record);
  return hashEvidenceFields(statementBytes(r.statement), r.authorization);
}

/** Each input's nullifier, in input order (§2), of a spend, burn or demand. */
export function inputNullifiers(s: Spend | Burn | Demand): readonly Uint8Array[] {
  const own = ownStatement(s);
  if (own.kind !== 2 && own.kind !== 3 && own.kind !== 4) throw new EncodingError("not a spend, burn or demand");
  return Object.freeze(own.inputs.map(input => noteNullifier(noteCommitment(own.domain, input))));
}
/** A demand's derived backing and quantity (§3): its inputs' common backing and summed value, a u64; refuses mixed
 * backings and a sum past a u64. */
export function demandClaim(demand: Demand): { readonly backing: Uint8Array; readonly quantity: bigint } {
  const d = ownStatement(demand);
  if (d.kind !== 4) throw new EncodingError("not a demand");
  const backing = d.inputs[0]!.backing;
  if (d.inputs.some(input => compareBytes(input.backing, backing) !== 0)) throw new EncodingError("demand inputs of several backings");
  const quantity = d.inputs.reduce((sum, input) => sum + input.value, 0n);
  if (quantity > MAX_U64) throw new EncodingError("demand quantity outside u64");
  return Object.freeze({ backing: Uint8Array.from(backing), quantity });
}
/** The outputs a statement creates, each with its derived rho (§2); a settlement's needs its demand, whose
 * identity must be the one the settlement names. Kinds 4, 5 and 7 create none. */
export function derivedOutputs(statement: Statement, demand?: Demand): readonly Opening[] {
  const s = ownStatement(statement);
  switch (s.kind) {
    case 1: {
      const output = { backing: s.backing, value: s.quantity, owner: s.owner };
      return Object.freeze([Object.freeze({ ...output, rho: issueRho(output, s.nonce) })]);
    }
    case 2: case 3: {
      const nullifiers = inputNullifiers(s);
      return Object.freeze(s.outputs.map((output, j) => Object.freeze({ ...output, rho: spendRho(nullifiers, j) })));
    }
    case 6: {
      if (demand === undefined) throw new EncodingError("a settlement's output needs its demand");
      const d = ownStatement(demand);
      if (d.kind !== 4 || compareBytes(d.domain, s.domain) !== 0 || compareBytes(statementHash(d), s.demand) !== 0) {
        throw new EncodingError("not the settlement's demand");
      }
      const { backing, quantity } = demandClaim(d);
      return Object.freeze([Object.freeze({ backing, value: quantity, owner: s.owner, rho: spendRho(inputNullifiers(d), 0) })]);
    }
    default: return Object.freeze([]);
  }
}

/** The statement's own arithmetic (§§6–7): its inputs are distinct notes; a spend's outputs name input backings and
 * balance per backing; a burn's inputs share one backing that any output names, and sum to quantity plus change; a
 * demand's inputs share a backing and sum to a u64. Widened sums never wrap. True for kinds with no arithmetic; false
 * for a malformed statement. */
export function arithmeticHolds(statement: Statement): boolean {
  let s: Statement;
  try { s = ownStatement(statement); } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
  if (s.kind !== 2 && s.kind !== 3 && s.kind !== 4) return true;
  // Equal openings are the one way to equal nullifiers (§2): two inputs naming one note.
  if (s.inputs.length === 2 && compareBytes(openingKey(s.inputs[0]!), openingKey(s.inputs[1]!)) === 0) return false;
  const sums = new Map<string, bigint>();
  const key = (b: Uint8Array): string => Buffer.from(b).toString("hex");
  for (const input of s.inputs) sums.set(key(input.backing), (sums.get(key(input.backing)) ?? 0n) + input.value);
  if (s.kind === 4) return sums.size === 1 && sums.values().next().value! <= MAX_U64;
  if (s.kind === 3) {
    if (sums.size !== 1) return false;
    const total = sums.values().next().value!, change = s.outputs[0];
    if (change !== undefined && !sums.has(key(change.backing))) return false;
    return total === s.quantity + (change?.value ?? 0n);
  }
  for (const output of s.outputs) {
    const k = key(output.backing), left = sums.get(k);
    if (left === undefined) return false;
    sums.set(k, left - output.value);
  }
  return [...sums.values()].every(left => left === 0n);
}

function openingKey(o: Opening): Uint8Array {
  const w = new ByteWriter(); writeOpening(w, o); return w.finish();
}

/** Strict verification of the owner signature of every input of a spend, burn, demand or request, each over the
 * statement bytes in input order (§3). False for any other kind or a malformed record; no state is read. */
export function ownerSignaturesVerify(record: LitRecord): boolean {
  let r: LitRecord;
  try { r = ownRecord(record); } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
  const s = r.statement;
  if (s.kind !== 2 && s.kind !== 3 && s.kind !== 4 && s.kind !== 7) return false;
  const message = statementBytes(s), owners = s.kind === 7 ? [s.input.owner] : s.inputs.map(input => input.owner);
  return owners.every((owner, i) => verifySignatureStrict(r.authorization.subarray(64 * i, 64 * i + 64), message, owner));
}
/** Strict verification of a one-signature authorization under a key the caller resolves: K for an issue, the demand's
 * presenter for a withdrawal (§3). False for any other kind or a malformed record. */
export function statementSignatureVerifies(record: LitRecord, key: Uint8Array): boolean {
  let r: LitRecord;
  try { r = ownRecord(record); } catch (error) {
    if (error instanceof EncodingError) return false;
    throw error;
  }
  if (r.statement.kind !== 1 && r.statement.kind !== 5) return false;
  return verifySignatureStrict(r.authorization, statementBytes(r.statement), key);
}

export interface Acceptance {
  readonly domain: Uint8Array;
  readonly demand: Uint8Array;
  readonly owner: Uint8Array;
  readonly deadline: bigint;
}
export interface SignedAcceptance extends Acceptance { readonly signature: Uint8Array }
function ownAcceptance(value: Acceptance): Acceptance {
  object(value, "acceptance");
  const { domain, demand, owner, deadline } = value;
  return Object.freeze({ domain: field32(domain, "domain"), demand: field32(demand, "demand"), owner: key32(owner, "owner"),
    deadline: u64(deadline, "deadline") });
}
/** `"moe/lit/v1/acceptance" || configHash || demand || owner || u64 deadline` (125 bytes), signed by K. */
export function acceptanceBytes(acceptance: Acceptance): Uint8Array {
  const a = ownAcceptance(acceptance), w = new ByteWriter();
  w.context(ACCEPTANCE); w.key32(a.domain, "domain"); w.key32(a.demand, "demand"); w.key32(a.owner, "owner"); w.u64(a.deadline);
  return w.finish();
}
export function acceptanceId(acceptance: Acceptance): Uint8Array { return sha256(acceptanceBytes(acceptance)); }
/** `"moe/lit/v1/release" || configHash || demand || acceptanceId || settlementHash` (146 bytes), signed by the presenter key. */
export function releaseBytes(domain: Uint8Array, demand: Uint8Array, acceptance: Uint8Array, settlement: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.context(RELEASE);
  for (const [value, what] of [[domain, "domain"], [demand, "demand"], [acceptance, "acceptance"], [settlement, "settlement"]] as const) {
    w.key32(field32(value, what), what);
  }
  return w.finish();
}
/** The settlement's 136-byte authorization frame (§3); verifies nothing. */
export function encodeSettlementAuthorization(deadline: bigint, acceptanceSignature: Uint8Array, releaseSignature: Uint8Array): Uint8Array {
  const w = new ByteWriter(); w.u64(u64(deadline, "deadline"));
  w.fixed(acceptanceSignature, 64, "acceptance signature"); w.fixed(releaseSignature, 64, "release signature");
  return w.finish();
}
/** The exact messages a settlement's two signatures are over, reconstructed from its own demand, owner and
 * authorization (§4). The caller verifies the acceptance under K and the release under the demand's presenter key,
 * and resolves the demand, terms, state and time; this grants no authority. */
export function settlementAuthorization(record: LitRecord): {
  readonly acceptance: SignedAcceptance; readonly acceptanceMessage: Uint8Array;
  readonly releaseMessage: Uint8Array; readonly releaseSignature: Uint8Array;
} {
  const r = ownRecord(record), s = r.statement;
  if (s.kind !== 6) throw new EncodingError("not a settlement");
  const a = new ByteReader(r.authorization), deadline = a.u64(), signature = a.raw(64), releaseSignature = a.raw(64);
  a.expectEnd();
  const acceptance = Object.freeze({ domain: Uint8Array.from(s.domain), demand: Uint8Array.from(s.demand),
    owner: Uint8Array.from(s.owner), deadline, signature });
  return Object.freeze({ acceptance, acceptanceMessage: acceptanceBytes(acceptance),
    releaseMessage: releaseBytes(s.domain, s.demand, acceptanceId(acceptance), statementHash(s)), releaseSignature });
}

export type Publication = { readonly domain: Uint8Array; readonly backing: Uint8Array } & (
  | { readonly kind: 2; readonly acceptance: SignedAcceptance }
  | { readonly kind: 1 | 3 | 4 | 5; readonly record: LitRecord }
);
/** A publication kind's record kind (pool-v3 §6): 1 a demand, 3 a settlement, 4 a withdrawal, 5 a request. */
const PUBLICATION_STATEMENT = { 1: 4, 3: 6, 4: 5, 5: 7 } as const;
const recordBound = (statement: number, authorization: number): number => 8 + STATEMENT_PREFIX_BYTES + statement + authorization;
/** Each kind's largest valid body; kind 1's, a demand over two notes, is §4's 478-byte bound. */
const BODY_BOUNDS = {
  1: recordBound(81 + OPENING_BYTES * MAX_INPUTS, 64 * MAX_INPUTS),
  2: ACCEPTANCE.length + 104 + 64,
  3: recordBound(96, SETTLEMENT_AUTHORIZATION_BYTES),
  4: recordBound(64, 64),
  5: recordBound(OPENING_BYTES + 8, 64),
} as const;
/** The largest publication (§4's 569 bytes). */
export const MAX_PUBLICATION_BYTES = PUBLICATION.length + 69 + Math.max(...Object.values(BODY_BOUNDS));
function requireKind(kind: unknown): asserts kind is Publication["kind"] {
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4 && kind !== 5) throw new EncodingError("unknown publication kind");
}
/** Owned and routed where the body alone decides: a demand's or request's backing is its own inputs'. An acceptance's,
 * a settlement's and a withdrawal's routing is checkable only beside the demand (§4). */
function ownPublication(value: Publication): Publication {
  object(value, "publication");
  const { domain: domainIn, backing: backingIn, kind } = value;
  requireKind(kind);
  const domain = field32(domainIn, "domain"), backing = field32(backingIn, "backing");
  if (kind === 2) {
    const signed = (value as { readonly acceptance: unknown }).acceptance;
    object(signed, "acceptance");
    const a = ownAcceptance(signed as unknown as Acceptance);
    let signature: Uint8Array;
    try { signature = copyBytes(signed.signature as Uint8Array); } catch { throw new EncodingError("invalid signature"); }
    if (signature.length !== 64) throw new EncodingError("wrong signature length");
    if (compareBytes(a.domain, domain) !== 0) throw new EncodingError("inconsistent domain");
    return Object.freeze({ domain, backing, kind, acceptance: Object.freeze({ ...a, signature }) });
  }
  const record = ownRecord((value as { readonly record: LitRecord }).record), s = record.statement;
  if (s.kind !== PUBLICATION_STATEMENT[kind]) throw new EncodingError("wrong publication body kind");
  if (compareBytes(s.domain, domain) !== 0) throw new EncodingError("inconsistent domain");
  if (s.kind === 4 && compareBytes(demandClaim(s).backing, backing) !== 0) throw new EncodingError("wrong routing backing");
  if (s.kind === 7 && compareBytes(s.input.backing, backing) !== 0) throw new EncodingError("wrong routing backing");
  return Object.freeze({ domain, backing, kind, record });
}
function body(p: Publication): Uint8Array {
  if (p.kind !== 2) return encodeRecord(p.record);
  const w = new ByteWriter(); w.context(acceptanceBytes(p.acceptance)); w.fixed(p.acceptance.signature, 64, "signature");
  return w.finish();
}
/** `"moe/lit/v1/publication" || configHash || backing || u8 kind || u32 bodyLength || body` (§4). */
export function encodePublication(publication: Publication): Uint8Array {
  const p = ownPublication(publication), w = new ByteWriter();
  w.context(PUBLICATION); w.key32(p.domain, "domain"); w.key32(p.backing, "backing"); w.u8(p.kind); w.lengthPrefixed(body(p));
  return w.finish();
}
export function publicationId(publication: Publication): Uint8Array { return sha256(encodePublication(publication)); }
/** Bounds the body by its kind's largest valid body before copying it. Kinds 2, 3 and 4 still need their demand
 * to check their routing. */
export function decodePublication(bytes: Uint8Array): Publication {
  if (byteLength(bytes) > MAX_PUBLICATION_BYTES) throw new EncodingError("publication too long");
  const r = new ByteReader(bytes);
  if (compareBytes(r.raw(PUBLICATION.length), PUBLICATION) !== 0) throw new EncodingError("wrong publication context");
  const domain = r.raw(32), backing = r.raw(32), kind = r.u8(); requireKind(kind);
  const bytesIn = r.lengthPrefixed(BODY_BOUNDS[kind]); r.expectEnd();
  if (kind !== 2) return ownPublication({ domain, backing, kind, record: decodeRecord(bytesIn) });
  const b = new ByteReader(bytesIn);
  if (compareBytes(b.raw(ACCEPTANCE.length), ACCEPTANCE) !== 0) throw new EncodingError("wrong acceptance context");
  const acceptance = { domain: b.raw(32), demand: b.raw(32), owner: b.raw(32), deadline: b.u64(), signature: b.raw(64) };
  b.expectEnd();
  return ownPublication({ domain, backing, kind, acceptance });
}
