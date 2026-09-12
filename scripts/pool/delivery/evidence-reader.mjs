// Experiment only: pool-delivery C4.6 and pool-v3 §§5,7,8,10 at 7ea0ee8.
// Authenticate LOCAL evidence, then recover candidates. This is not replay.
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot, verifyCommitment } from "../../../dist/commitment.js";
import { identifierOf, isValue } from "../../../dist/pool/field.js";
import { CapsuleAssociationError, CapsuleFormatError, createCapsuleScanner } from "./crypto.mjs";

export const LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxEvents: 1024n });
const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => compareBytes(a, b) === 0;

export async function loadEvidenceCodecs(buildUrl) {
  const [trail, records, headers, snapshots, bytes] = await Promise.all([
    import(new URL("model/pool-v3-trail.js", buildUrl)),
    import(new URL("model/pool-v3-records.js", buildUrl)),
    import(new URL("model/pool-v3-headers.js", buildUrl)),
    import(new URL("model/pool-v3-commitments.js", buildUrl)),
    import(new URL("src/bytes.js", buildUrl)),
  ]);
  return { ...trail, ...records, ...headers, ...snapshots, CodecEncodingError: bytes.EncodingError };
}

export class EvidenceRefusal extends Error {
  constructor(status) { super(status); this.status = status; }
}
function requireEvidence(condition, status = "unresolved-evidence") {
  if (!condition) throw new EvidenceRefusal(status);
}

/** Authenticate owned local evidence without a wallet seed. No replay verdict. */
export function readLocalEvidence(selection, supplied, codec) {
  for (const key of ["domain", "venue", "backing", "operator", "root"]) {
    requireEvidence(selection?.[key] instanceof Uint8Array && selection[key].length === 32);
  }
  requireEvidence(isValue(selection.sequence) && selection.sequence > 0n && isValue(selection.judgingIndex));
  requireEvidence(selection.mode === "current-fixture" || selection.mode === "historical-fixture");
  requireEvidence(supplied?.commitment instanceof Uint8Array && supplied?.snapshot instanceof Uint8Array &&
    supplied?.trail instanceof Uint8Array && Array.isArray(supplied?.directory));
  requireEvidence(supplied.directory.length === 1, "unsupported-scope");
  const commitment = decodeCommitment(supplied.commitment);
  requireEvidence(verifyCommitment(commitment));
  requireEvidence(same(commitment.operator, selection.operator) && commitment.sequence === selection.sequence &&
    same(commitment.root, selection.root), "selection-mismatch");
  requireEvidence(same(directoryRoot(supplied.directory), commitment.root));
  const entry = supplied.directory[0];
  requireEvidence(same(entry.name, selection.backing));
  const snapshot = codec.decodeSnapshot(supplied.snapshot);
  const trail = codec.decodeTrail(supplied.trail, LIMITS);
  const header = codec.decodeSegmentHeader(trail.header);
  requireEvidence(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
    same(header.operator, selection.operator) && header.sequence <= selection.sequence);
  requireEvidence(header.entries.length === 1 && header.entries[0].opening === undefined, "unsupported-scope");
  requireEvidence(codec.verifyTrailEvidence({ backing: selection.backing, segment: snapshot.segment,
    digest: entry.digest }, snapshot, trail, LIMITS));
  return { snapshot, trail, header };
}

/** selection is an independent TEST FIXTURE input, never a replica assertion.
 * Its judging index is a label, not authenticated venue evidence. Even success
 * has unresolved coverage and supplies no certified path or spending authority.
 * seed and package are memory-only; there is no request journal input. */
export function inspectRestorationEvidence(seed, selection, supplied, codec) {
  const result = (status, candidates = [], stats = null) => ({
    status, candidates, stats,
    evidenceScope: "selected-local-v3-trail-only",
    selectionSource: "independent-test-fixture",
    authenticatedFullV3Finality: false,
    completenessClaim: false,
    noMatchesMeansZeroBalance: false,
    unresolvedCoverage: true,
    spendable: false,
  });
  try {
    const { snapshot, trail } = readLocalEvidence(selection, supplied, codec);

    // Read only authenticated records. A replica cannot supply a separate spent
    // list, output list or finality marker. Still no proof/authorization replay.
    const outputs = [], spent = new Set();
    let scopeRoot;
    for (const bytes of trail.records) {
      const record = codec.decodeRecord(bytes), p = record.publicInputs;
      requireEvidence([1, 2, 3].includes(record.kind), "unsupported-scope");
      requireEvidence(same(record.domain, selection.domain) && same(identifierOf(p[2], p[3]), snapshot.segment));
      scopeRoot ??= p[4];
      requireEvidence(p[4] === scopeRoot);
      if (record.kind !== 2) requireEvidence(same(identifierOf(p[5], p[6]), selection.backing));
      const cms = record.kind === 1 ? [p[8]] : record.kind === 2 ? p.slice(9, 13) : [p[12]];
      const nfs = record.kind === 1 ? [] : record.kind === 2 ? p.slice(7, 9) : p.slice(10, 12);
      for (const nf of nfs) spent.add(nf);
      cms.forEach((cm, i) => outputs.push({ cm, capsule: record.capsules[i] }));
    }
    const scanner = createCapsuleScanner(seed, selection.domain), candidates = new Map();
    for (const output of outputs) {
      const note = scanner.tryRecover(output.cm, output.capsule);
      if (note === null) continue;
      requireEvidence(same(note.opening.backing, selection.backing));
      if (note.opening.value > 0n && !spent.has(note.nf)) {
        candidates.set(note.nf, { cm: note.cm.toString(), nf: note.nf.toString(),
          backing: hex(note.opening.backing), value: note.opening.value.toString(),
          observedAt: selection.judgingIndex.toString(), spendable: false });
      }
    }
    return result(selection.mode === "historical-fixture" ? "historical-candidates" : "selected-evidence-candidates",
      [...candidates.values()], scanner.stats());
  } catch (error) {
    if (error instanceof EvidenceRefusal) return result(error.status);
    if (error instanceof codec.TrailLimitError) return result("resource-refusal");
    // Compiled model and runtime each have their own EncodingError class.
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError ||
      error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return result("unresolved-evidence");
    throw error;
  }
}
