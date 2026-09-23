// Public scope authentication is independent of the committed event chain.
// A partial trail is only a bounded carrier for existing header/term bytes.
import { createHash } from "node:crypto";
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { EvidenceRefusal, LIMITS } from "../delivery/evidence-reader.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");

// A decoded trail's evidence chain depends only on its own header and records
// (pool-v3 §7), so one read computes it once per trail object: position i
// holds evidenceHash_i, over the longest prefix whose records decode under §5.
const chains = new WeakMap();
function cacheFor(codec) {
  if (!chains.has(codec)) chains.set(codec, new WeakMap());
  return chains.get(codec);
}
export function trailEvidenceChain(codec, trail) {
  const cached = cacheFor(codec);
  if (cached.has(trail)) return cached.get(trail).chain;
  const chain = [codec.genesisEvidenceHash(hash(trail.header))];
  for (const [i, bytes] of trail.records.entries()) {
    let record;
    try { record = codec.decodeRecord(bytes); } catch (error) {
      if (!(error instanceof EncodingError || error instanceof codec.CodecEncodingError)) throw error;
      break;
    }
    chain.push(codec.nextEvidenceHash(chain[i], codec.evidenceHashes(record), BigInt(i) + 1n));
  }
  cached.set(trail, { chain });
  return chain;
}
function positionOf(codec, trail, evidenceHash) {
  trailEvidenceChain(codec, trail);
  const entry = cacheFor(codec).get(trail);
  entry.positions ??= new Map(entry.chain.map((value, i) => [hex(value), i]));
  return entry.positions.get(hex(evidenceHash));
}
/** The trail cut at n: its header and terms with its first n records (§10). */
function prefixOf(codec, trail, n) {
  if (n === trail.records.length) return trail;
  const entry = cacheFor(codec).get(trail);
  entry.prefixes ??= new Map();
  if (!entry.prefixes.has(n)) {
    const prefix = Object.freeze({ header: trail.header, terms: trail.terms, records: Object.freeze(trail.records.slice(0, n)) });
    cacheFor(codec).set(prefix, { chain: entry.chain.slice(0, n + 1) });
    entry.prefixes.set(n, prefix);
  }
  return entry.prefixes.get(n);
}
/** pool-v3 §12.1: a checkpoint's served trail is the prefix of any supplied
 * trail of its segment whose decodable first n records reproduce the
 * snapshot's evidence hash (at n = 0, the seed); later records are not its
 * evidence. Matching prefixes share header and records, so the first one is
 * the dependency, and it still passes the full §10.1 check. Terms are
 * resolved separately by backing name (resolveTerms). */
export function servedTrail(codec, expected, snapshot, trails) {
  for (const trail of trails) {
    // Another segment's trail fails §10.1 before any record is decoded.
    if (!same(hash(trail.header), expected.segment)) continue;
    const n = positionOf(codec, trail, snapshot.evidenceHash);
    if (n === undefined) continue;
    const prefix = prefixOf(codec, trail, n);
    if (codec.verifyTrailEvidence(expected, snapshot, prefix, LIMITS)) return prefix;
  }
  return undefined;
}

/** pool-v3 §12.1: each scoped signed-terms field is resolved by its backing
 * name from any supplied trail of the segment whose field reproduces the name
 * and verifies strictly; a failing field is ignored, never conflicting. */
export function resolveTerms(codec, trails, segment, entry, index) {
  for (const trail of trails) {
    if (!same(hash(trail.header), segment)) continue;
    const signed = trail.terms[index];
    if (signed !== undefined && codec.verifyRootTermsSignature(signed.terms, signed.signature) &&
        same(codec.rootTermsName(signed.terms), entry.backing)) return signed;
  }
  return undefined;
}

export function authenticatedScope(trails, segment, codec) {
  const carrier = trails.find(trail => same(hash(trail.header), segment));
  if (carrier === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = codec.decodeSegmentHeader(carrier.header);
  const terms = header.entries.map((entry, i) => resolveTerms(codec, trails, segment, entry, i));
  if (terms.some(signed => signed === undefined)) throw new EvidenceRefusal("unresolved-evidence");
  return { header, terms };
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
    const served = servedTrail(codec, { backing, segment: snapshot.segment, digest }, snapshot, trails);
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
