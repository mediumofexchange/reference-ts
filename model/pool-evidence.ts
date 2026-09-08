// C2.10.10's evidence binding, for the executable model only. These framed
// encodings and tags are NOT the successor's normative bytes or v3 layout.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { bigintToMinimalBytes, ByteWriter, EncodingError } from "../src/bytes.js";
import type { Event, Lit, Statement } from "./pool-authority.js";

/** Exact bytes use one immutable spelling. Empty signatures represent the
 * absence of the issue signature; proof/signature validity is oracle work. */
export interface Evidence { readonly proof: string; readonly signature: string }
export interface EvidenceHashes { readonly proofHash: string; readonly signatureHash: string }

function bytes(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/.test(hex)) throw new EncodingError("noncanonical evidence hex");
  return hexToBytes(hex);
}

/** Copy at ingestion: callers cannot replace a retained proof or signature. */
export function copyEvidence(evidence: Evidence): Evidence {
  const { proof, signature } = evidence;
  bytes(proof); bytes(signature);
  return Object.freeze({ proof, signature });
}

export function evidenceHashes(evidence: Evidence): EvidenceHashes {
  return Object.freeze({ proofHash: bytesToHex(sha256(bytes(evidence.proof))),
    // C2.10.10 retains pool-v2 §9's absent-obligor-signature sentinel.
    signatureHash: evidence.signature === "" ? "00".repeat(32) : bytesToHex(sha256(bytes(evidence.signature))) });
}

export function evidenceEqual(left: Evidence, right: Evidence): boolean {
  const a = evidenceHashes(left), b = evidenceHashes(right);
  return a.proofHash === b.proofHash && a.signatureHash === b.signatureHash;
}

const encoder = new TextEncoder();
function text(w: ByteWriter, value: string): void {
  // TextEncoder replaces lone surrogates; reject them to preserve injectivity.
  if (typeof value !== "string" || !value.isWellFormed()) throw new EncodingError("noncanonical model text");
  w.lengthPrefixed(encoder.encode(value));
}
function list(w: ByteWriter, values: readonly string[]): void {
  w.u64(BigInt(values.length));
  for (const value of values) text(w, value);
}
function integer(w: ByteWriter, value: bigint): void {
  if (typeof value !== "bigint") throw new EncodingError("non-bigint model quantity");
  // Commit invalid negative values too: failed public relations still need
  // attributable evidence. This does not authorize them as valid statements.
  w.u8(value < 0n ? 1 : 0);
  w.lengthPrefixed(bigintToMinimalBytes(value < 0n ? -value : value));
}
function optional<T>(w: ByteWriter, value: T | undefined, write: (value: T) => void): void {
  w.u8(value === undefined ? 0 : 1);
  if (value !== undefined) write(value);
}
function litBytes(w: ByteWriter, lit: Lit): void {
  text(w, lit.backing); integer(w, lit.quantity);
  optional(w, lit.tags, value => list(w, value));
  optional(w, lit.presenter, value => text(w, value));
  optional(w, lit.instant, value => integer(w, value));
  optional(w, lit.deadline, value => integer(w, value));
  optional(w, lit.demand, value => text(w, value));
  optional(w, lit.owner, value => text(w, value));
  optional(w, lit.acceptance, value => {
    text(w, value.demand); text(w, value.owner); integer(w, value.deadline);
    if (typeof value.signedByK !== "boolean") throw new EncodingError("non-boolean model acceptance");
    w.u8(value.signedByK ? 1 : 0);
  });
  optional(w, lit.tag, value => text(w, value));
}

/** Complete public statement identity, independent of proof and signature.
 * The ideal id is included but never substitutes for binding public fields. */
export function statementDigest(statement: Statement): string {
  const w = new ByteWriter();
  text(w, "moe/model/statement/v1");
  text(w, statement.id); text(w, statement.kind); text(w, statement.domain);
  text(w, statement.segment); text(w, statement.scope);
  list(w, statement.anchors); list(w, statement.nullifiers); list(w, statement.outputs);
  optional(w, statement.lit, value => litBytes(w, value));
  return bytesToHex(sha256(w.finish()));
}

/** One fixed tag and framed inputs for both seed and recurrence, C2.10.10. */
function chainHash(fields: readonly Uint8Array[]): string {
  const w = new ByteWriter();
  text(w, "moe/model/evidence/v1");
  w.u64(BigInt(fields.length));
  for (const field of fields) w.lengthPrefixed(field);
  return bytesToHex(sha256(w.finish()));
}

export function evidenceChain(segment: string,
  events: readonly (Pick<Event, "statement"> & { readonly evidence?: Evidence })[]): string {
  const segmentBytes = new ByteWriter();
  text(segmentBytes, segment);
  let hash = chainHash([segmentBytes.finish()]);
  for (const event of events) {
    if (event.evidence === undefined) throw new EncodingError("missing admitted evidence");
    const { proofHash, signatureHash } = evidenceHashes(event.evidence);
    hash = chainHash([bytes(hash), bytes(statementDigest(event.statement)), bytes(proofHash), bytes(signatureHash)]);
  }
  return hash;
}
