// The replay harness's reports over the runtime package reader (src/pool/v3/package-reader.ts readPackage):
// the harness owns its input shapes, the venue it selects, note scanning and the report's audit fields;
// every verdict is the runtime reader's.
// pool-v3 §§3,5,7,10,12,13; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { createHash } from "node:crypto";
import { compareBytes, copyUnshared, EncodingError } from "../../../dist/bytes.js";
import { directoryRoot } from "../../../dist/venue-records.js";
import { CapsuleAssociationError, CapsuleFormatError } from "../../../dist/pool/v3/capsules.js";
import { ownedNotes, seedWitness } from "../../../dist/pool/v3/holdings.js";
import { RANGE_LIMITS } from "../../../dist/pool/v3/reader.js";
import { readPackage, refusalFacts } from "../../../dist/pool/v3/package-reader.js";
import { ReferenceVenueError, referenceVenue } from "../../../dist/pool/v3/guard.js";
import { EvidenceRefusal, ReplayRefusal, requireReplay } from "../../../dist/pool/v3/refusals.js";
import { boundFaultInputs } from "./fault-evidence.mjs";

export { RANGE_LIMITS };

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
const sha256 = bytes => createHash("sha256").update(bytes).digest();
export const PACKAGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
const flags = Object.freeze({ fullV3Replay: false, currentRangeAuthenticated: false,
  configurationChecked: false, signedTermsAuthenticated: false,
  termsAuthorityAuthenticated: false, completenessClaim: false, noMatchesMeansZeroBalance: false,
  unresolvedCoverage: true, spendable: false, rangeEvidence: "none" });
const refused = (status, check = null) => ({ status, check, ...flags, audit: null, candidates: [] });
const INPUT_SHAPES = ["package,selection", "package,seed,selection", "package,selection,venue", "package,seed,selection,venue"];

/** A reader-selected RecordVenue as the harness hands it to the reader, with
 * its provenance label. The reader asks under RANGE_LIMITS, so a harness
 * wrapper that replaces `range` may take the request alone. */
export const recordReader = (venue, evidenceKind) => ({ evidenceKind, id: venue.id,
  range: (request, limits = RANGE_LIMITS) => venue.range(request, limits),
  witnessedIndex: () => venue.witnessedIndex(), lag: () => venue.lag() });

/** The harness's object form of a package as §12 bytes: each object once, in canonical order (kind, then
 * payload hash). Encoding copies every payload synchronously, before any await. */
export function packageBytes(supplied, codec) {
  if (supplied === null || typeof supplied !== "object") throw new EncodingError("invalid package");
  const list = (value, name) => {
    const items = value === undefined ? [] : value;
    if (!Array.isArray(items)) throw new EncodingError(`invalid ${name}`);
    return items;
  };
  const items = [{ kind: 1, payload: supplied.configuration }, { kind: 2, payload: supplied.commitment },
    ...[supplied.directory, ...list(supplied.directories, "directories")].map(entries => ({ kind: 3, payload: codec.encodeEvidenceDirectory(entries, PACKAGE_LIMITS) })),
    ...[supplied.snapshot, ...list(supplied.snapshots, "snapshots")].map(payload => ({ kind: 4, payload })),
    ...[supplied.trail, ...list(supplied.trails, "trails")].map(payload => ({ kind: 6, payload })),
    ...boundFaultInputs(supplied.faults).map(payload => ({ kind: 7, payload })),
    ...(supplied.receipt === undefined ? [] : [{ kind: 10, payload: supplied.receipt }])];
  // An absent configuration or commitment is left out: the reader judges the package without it.
  const present = items.filter(item => !(item.kind <= 2 && item.payload === undefined));
  if (present.some(item => !(item.payload instanceof Uint8Array))) throw new EncodingError("invalid package item");
  const keyed = present.map(item => ({ ...item, key: sha256(item.payload) }))
    .sort((a, b) => a.kind - b.kind || Buffer.compare(a.key, b.key));
  // Identical bytes are one object (§12's inventory refuses a repeated payload).
  const distinct = keyed.filter((item, i) => i === 0 || item.kind !== keyed[i - 1].kind || !same(item.payload, keyed[i - 1].payload));
  return codec.encodeEvidencePackage(distinct.map(({ kind, payload }) => ({ kind, payload })), PACKAGE_LIMITS);
}

/** Harness object inputs: the same read as `replayEvidencePackage` over their §12 bytes. */
export async function replayLocalPackage(input, verifier, codec) {
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid replay input");
    requireReplay(INPUT_SHAPES.includes(Object.keys(input).sort().join(",")), "INPUT_FIELDS");
    const { package: supplied, ...rest } = input;
    return await replayEvidencePackage({ ...rest, package: packageBytes(supplied, codec) }, verifier, codec);
  } catch (error) { return refusal(error, codec); }
}

/** One §12 package read by the runtime reader under the harness's selected venue, reported with the harness's
 * audit fields. The configuration is the runtime manifest's (pool-v3 §11.4); issuer identity comes from signed
 * scoped terms (§11). The venue's §13 ranges fix the chain, the checkpoint's record prefix and currency against
 * the selected fixture only. A read without venue answers is unsupported: §13 ranges are its only authority.
 * A seed adds its owned notes to a state read (never to a receipt). State reads expose nothing until the reader
 * returns; a receipt read returns its conditional verdict, and a refusal what the read established before it. */
export async function replayEvidencePackage(input, verifier, codec) {
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid package input");
    requireReplay(INPUT_SHAPES.includes(Object.keys(input).sort().join(",")), "INPUT_FIELDS");
    if (!(input.package instanceof Uint8Array)) throw new EncodingError("invalid package bytes");
    const source = input.selection;
    if (source === null || typeof source !== "object") throw new EncodingError("invalid selection");
    const fields = ["backing", "domain", "operator", "root", "venue"], fixed = fields.map(key => source[key]);
    if (input.seed !== undefined) fixed.push(input.seed);
    if (fixed.some(value => !(value instanceof Uint8Array) || value.length !== 32)) throw new EncodingError("invalid selection/seed bytes");
    // Owned before any await; the reader judges the selection's shape itself.
    const bytes = copyUnshared(input.package), seed = input.seed === undefined ? undefined : copyUnshared(input.seed);
    const selection = { ...source, ...Object.fromEntries(fields.map(key => [key, copyUnshared(source[key])])) };
    // A receipt query is seedless: a seed scans a state, never a receipt.
    if (seed !== undefined && codec.decodeEvidencePackage(bytes).some(item => item.kind === 10)) throw new EvidenceRefusal("unsupported-scope");
    // Reference provenance belongs to the caller's verifier, never the package; it is judged before anything else.
    const reference = structuredClone(verifier.reference);
    requireReplay(same(selection.venue, referenceVenue(reference).id), "VENUE_REFERENCE");
    if (input.venue === undefined) throw new EvidenceRefusal("unsupported-scope");
    if (typeof verifier.record !== "function") throw new EvidenceRefusal("unresolved-evidence");
    const record = await verifier.record(input.venue);
    if (record === undefined) throw new EvidenceRefusal("unresolved-evidence");
    // Metadata belongs to the reader's selected verifier, never the package.
    const rangeEvidence = record.evidenceKind ?? "reader-selected-verifier";
    if (typeof verifier.verify !== "function" || verifier.identities === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const result = await readPackage(bytes, selection, { verifier: { verify: verifier.verify, identities: verifier.identities },
      venue: record, reference, ...(seed === undefined ? {} : { witness: seedWitness(seed, selection.domain) }) });
    const authenticated = { configurationChecked: true, signedTermsAuthenticated: true, termsAuthorityAuthenticated: true,
      currentRangeAuthenticated: selection.mode !== "historical-fixture", rangeEvidence };
    if (result.receipt !== undefined) {
      return { ...refused("receipt-status"), ...facts(result), receipt: result.receipt, ...authenticated };
    }
    const { carrying, state, clock, ranges } = result;
    const { issued, burned, position, history } = state;
    // Shared history can contain notes for other scoped backings owned by the
    // same seed. This query restores only its independently selected backing.
    const candidates = seed === undefined ? [] : ownedNotes(seed, selection.domain, selection.backing, state).map(note => ({
      cm: note.cm.toString(), nf: note.nf.toString(), value: note.opening.value.toString(), leaf: note.leaf.toString(), anchor: note.anchor.toString(),
      siblings: note.path.siblings.map(String), right: [...note.path.right],
      pathScope: note.local ? "replayed-local-tree-only" : "replayed-imported-tree-only", spendable: false }));
    // The selected snapshot the read authenticated: the one the selection's directory names for its backing.
    const items = codec.decodeEvidencePackage(bytes), directory = items.filter(item => item.kind === 3)
      .map(item => codec.decodeEvidenceDirectory(item.payload)).find(entries => same(directoryRoot(entries), selection.root));
    const digest = directory.find(entry => same(entry.name, selection.backing)).digest;
    const snapshot = codec.decodeSnapshot(items.find(item => item.kind === 4 && same(sha256(item.payload), digest)).payload);
    return { status: selection.mode === "historical-fixture" ? "historical-local-replay" : "selected-local-replay",
      ...facts(result), ...flags, ...authenticated,
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: state.noteRoot().toString(), spentRoot: hex(state.spentRoot()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash),
        range: { judgingIndex: ranges.judgingIndex.toString(), lag: ranges.lag.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
          revokedAt: ranges.revokedAt === undefined ? null : ranges.revokedAt.toString(),
          heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter,
          chain: ranges.chain.map(link => ({ operator: hex(link.operator), from: link.from.toString(), link: hex(link.link) })),
          carrying, clock, ...(ranges.publications === undefined ? {} : { publications: ranges.publications }),
          ...(ranges.nonService === undefined ? {} : { nonService: ranges.nonService }) } }, candidates };
  } catch (error) { return refusal(error, codec); }
}

const facts = result => result.faultEvidence === undefined ? {} : { faultEvidence: result.faultEvidence };

/** A refusal as the harness reports it, with what the reader established before it. */
function refusal(error, codec) {
  const read = refusalFacts(error), established = read === undefined ? {} : { ...facts(read),
    ...(read.receiptEvidence === undefined ? {} : { receiptEvidence: read.receiptEvidence }) };
  if (error instanceof ReferenceVenueError) return { ...refused("invalid-local-replay", "VENUE_REFERENCE"), ...established };
  if (error instanceof ReplayRefusal) return { ...refused("invalid-local-replay", error.check), ...established };
  // A lapsed selection carries the clock record proving the lapse (C2b.4.1) beside the refusal.
  if (error instanceof EvidenceRefusal) return { ...refused(error.status), ...established, ...(error.clock === undefined ? {} : { clock: error.clock }) };
  if (error instanceof codec.TrailLimitError || error instanceof codec.RangeLimitError || error instanceof codec.PackageLimitError) return { ...refused("resource-refusal"), ...established };
  if (error instanceof EncodingError || error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return { ...refused("unresolved-evidence"), ...established };
  throw error;
}
