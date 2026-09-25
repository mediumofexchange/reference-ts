// Public scope authentication is independent of the committed event chain.
// A partial trail is only a bounded carrier for existing header/term bytes.
// A checkpoint's served trail is the runtime's (src/pool/v3/served-trail.ts).
import { createHash } from "node:crypto";
import { compareBytes } from "../../../dist/bytes.js";
import { EvidenceRefusal } from "../../../dist/pool/v3/refusals.js";
import { servedTrail } from "../../../dist/pool/v3/served-trail.js";

const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");

/** pool-v3 §12.1: each scoped signed-terms field is resolved by its backing
 * name from any supplied trail of the segment whose field reproduces the name
 * and verifies strictly; a failing field is ignored, never conflicting. */
// One resolution per supplied trail list, segment, position and name, so a
// read verifies each field at most once however many checkpoints ask.
const resolved = new WeakMap();
export function resolveTerms(codec, trails, segment, entry, index) {
  if (!resolved.has(trails)) resolved.set(trails, new Map());
  const memo = resolved.get(trails), key = `${hex(segment)}:${index}:${hex(entry.backing)}`;
  if (memo.has(key)) return memo.get(key);
  let found;
  for (const trail of trails) {
    if (!same(hash(trail.header), segment)) continue;
    const signed = trail.terms[index];
    if (signed !== undefined && codec.verifyRootTermsSignature(signed.terms, signed.signature) &&
        same(codec.rootTermsName(signed.terms), entry.backing)) { found = signed; break; }
  }
  memo.set(key, found);
  return found;
}

/** The decoded terms of a field resolveTerms returned, decoded once per
 * field. Resolution already verified its signature and name strictly, so
 * callers pass these through instead of verifying the field again. */
const decodedTerms = new WeakMap();
export function rootTermsOf(codec, signed) {
  if (!decodedTerms.has(codec)) decodedTerms.set(codec, new WeakMap());
  const memo = decodedTerms.get(codec);
  if (!memo.has(signed)) memo.set(signed, codec.decodeRootTerms(signed.terms));
  return memo.get(signed);
}

/** The segment's header with every scoped field resolved (`terms[i]` for
 * `header.entries[i]`) and decoded (`rootTerms[i]`). */
export function authenticatedScope(trails, segment, codec) {
  const carrier = trails.find(trail => same(hash(trail.header), segment));
  if (carrier === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = codec.decodeSegmentHeader(carrier.header);
  const terms = header.entries.map((entry, i) => resolveTerms(codec, trails, segment, entry, i));
  if (terms.some(signed => signed === undefined)) throw new EvidenceRefusal("unresolved-evidence");
  return { header, terms, rootTerms: terms.map(signed => rootTermsOf(codec, signed)) };
}

export function checkpointScope(trails, backing, digest, snapshot, codec) {
  if (!same(snapshot.backing, backing) || !same(codec.snapshotDigest(snapshot), digest)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const scope = authenticatedScope(trails, snapshot.segment, codec);
  if (!scope.header.entries.some(entry => same(entry.backing, backing))) throw new EvidenceRefusal("unresolved-evidence");
  let full;
  const result = { ...scope, fullTrail() {
    if (full !== undefined) return full;
    const served = servedTrail({ backing, segment: snapshot.segment, digest }, snapshot, trails);
    if (served === undefined) throw new EvidenceRefusal("unresolved-evidence");
    full = served; return full;
  } };
  // A compact certificate can replace absent/inconclusive event evidence only.
  // Resource failures must remain refusals.
  return { ...result, classificationEvidence(intrinsic) {
    try { return { trail: result.fullTrail() }; }
    catch (error) {
      if (!(error instanceof EvidenceRefusal) || error.status !== "unresolved-evidence" || intrinsic === undefined) throw error;
      return { intrinsic };
    }
  } };
}
