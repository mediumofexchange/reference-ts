// Public scope authentication is independent of the committed event chain.
// A partial trail is only a bounded carrier for existing header/term bytes.
import { createHash } from "node:crypto";
import { compareBytes } from "../../../dist/bytes.js";
import { EvidenceRefusal, LIMITS } from "../delivery/evidence-reader.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());

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
  return { ...scope, fullTrail() {
    if (full !== undefined) return full;
    const matching = trails.filter(trail => codec.verifyTrailEvidence({ backing, segment: snapshot.segment, digest }, snapshot, trail, LIMITS));
    if (matching.length !== 1) throw new EvidenceRefusal(matching.length === 0 ? "unresolved-evidence" : "unsupported-scope");
    full = matching[0]; return full;
  } };
}
