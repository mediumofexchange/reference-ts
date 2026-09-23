// Public scope authentication is independent of the committed event chain.
// A partial trail is only a bounded carrier for existing header/term bytes.
import { createHash } from "node:crypto";
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { EvidenceRefusal, LIMITS } from "../delivery/evidence-reader.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

// A decoded trail's evidence chain depends only on its own header and records
// (pool-v3 §7), so one read computes it once per trail object: position i
// holds evidenceHash_i. null where §5 cannot decode a record, where §10.1
// authentication would return false in any case.
const chains = new WeakMap();
export function trailEvidenceChain(codec, trail) {
  if (!chains.has(codec)) chains.set(codec, new WeakMap());
  const cached = chains.get(codec);
  if (cached.has(trail)) return cached.get(trail);
  let chain = [codec.genesisEvidenceHash(hash(trail.header))];
  try {
    trail.records.forEach((bytes, i) => chain.push(codec.nextEvidenceHash(chain[i], codec.evidenceHashes(codec.decodeRecord(bytes)), BigInt(i) + 1n)));
  } catch (error) {
    if (!(error instanceof EncodingError || error instanceof codec.CodecEncodingError)) throw error;
    chain = null;
  }
  cached.set(trail, chain);
  return chain;
}
/** §10.1 for one checkpoint. The cached terminal hash only skips trails that
 * cannot authenticate; every candidate still passes the full check. */
export function trailAuthenticates(codec, expected, snapshot, trail) {
  // Another segment's trail fails §10.1 before any record is decoded.
  if (!same(hash(trail.header), expected.segment)) return false;
  const chain = trailEvidenceChain(codec, trail);
  return chain !== null && same(chain.at(-1), snapshot.evidenceHash) && codec.verifyTrailEvidence(expected, snapshot, trail, LIMITS);
}

export function authenticatedScope(trails, segment, codec) {
  for (const trail of trails) {
    if (!same(hash(trail.header), segment)) continue;
    const header = codec.decodeSegmentHeader(trail.header);
    if (!header.entries.every((entry, i) => {
      const signed = trail.terms[i];
      return signed !== undefined && codec.verifyRootTermsSignature(signed.terms, signed.signature) &&
        same(codec.rootTermsName(signed.terms), entry.backing);
    })) continue;
    return { header, terms: trail.terms };
  }
  throw new EvidenceRefusal("unresolved-evidence");
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
    const matching = trails.filter(trail => trailAuthenticates(codec, { backing, segment: snapshot.segment, digest }, snapshot, trail));
    if (matching.length !== 1) throw new EvidenceRefusal(matching.length === 0 ? "unresolved-evidence" : "unsupported-scope");
    full = matching[0]; return full;
  } };
  // A compact certificate can replace absent/inconclusive event evidence only.
  // Resource failures and conflicting complete trails must remain refusals.
  return { ...result, classificationEvidence(intrinsic) {
    try { return { trail: result.fullTrail() }; }
    catch (error) {
      if (!(error instanceof EvidenceRefusal) || error.status !== "unresolved-evidence" || intrinsic === undefined) throw error;
      return { intrinsic };
    }
  } };
}
