// Conditional replay harness over the runtime's v3 reader walk (src/pool/v3/reader.ts,
// scope-reader.ts): it owns the harness input shapes, note scanning and the
// report's audit fields.
// pool-v3 §§3,5,7,10,12,13; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { createHash } from "node:crypto";
import { compareBytes, copyBytes, EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot } from "../../../dist/venue-records.js";
import { isValue } from "../../../dist/pool/field.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { CapsuleAssociationError, CapsuleFormatError } from "../../../dist/pool/v3/capsules.js";
import { ownedNotes, seedWitness } from "../../../dist/pool/v3/holdings.js";
import { ReplayStore } from "../../../dist/pool/v3/replay-store.js";
import { EvidenceStore } from "../../../dist/pool/v3/evidence-store.js";
import { RANGE_LIMITS, replayTrail } from "../../../dist/pool/v3/reader.js";
import { CandidateVenueError, referenceVenue } from "../../../dist/pool/v3/guard.js";
import { EvidenceRefusal, ReplayRefusal, requireReplay } from "../../../dist/pool/v3/refusals.js";
import { classifyScopes } from "../../../dist/pool/v3/scope-reader.js";
import { LIMITS, readLocalEvidence } from "./evidence-reader.mjs";
import { resolveTerms } from "../../../dist/pool/v3/scope-evidence.js";
import { decodeRootTerms } from "../../../dist/pool/v3/terms.js";
import { boundFaultInputs, faultObserver } from "./fault-evidence.mjs";

export { RANGE_LIMITS };

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
const sha256 = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
export const PACKAGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
// Work budgets for imported closures, including failed replays and merge work.
// Events are the records a replay actually processes: a resumed checkpoint
// charges only its positions after the last valid one, and a replay charges
// imported events only when it builds their ancestry. Copying the resumed
// state is not charged; it hashes and verifies nothing and is bounded by the
// checkpoint and event budgets together. A reader may select other local
// budgets on its verifier; they are never protocol bounds.
export const IMPORT_LIMITS = Object.freeze({ maxCheckpoints: 128n, maxEvents: 8192n });
function importLimitsOf(verifier) {
  const limits = verifier?.importLimits;
  if (limits === undefined) return IMPORT_LIMITS;
  if (limits === null || typeof limits !== "object") throw new TypeError("invalid import limits");
  // Each field is read once, so a getter cannot pass validation and then change.
  const { maxCheckpoints, maxEvents } = limits;
  if (!isValue(maxCheckpoints) || !isValue(maxEvents)) throw new TypeError("invalid import limits");
  return Object.freeze({ maxCheckpoints, maxEvents });
}
const flags = Object.freeze({ fullV3Replay: false, currentRangeAuthenticated: false,
  candidateConfigurationChecked: false, signedTermsAuthenticated: false,
  termsAuthorityAuthenticated: false, completenessClaim: false, noMatchesMeansZeroBalance: false,
  unresolvedCoverage: true, spendable: false, rangeEvidence: "none" });
const refused = (status, check = null) => ({ status, check, ...flags, audit: null, candidates: [] });
const INPUT_SHAPES = ["package,selection", "package,seed,selection", "package,selection,venue", "package,seed,selection,venue"];

function ownInputs(input) {
  const copy = structuredClone(input), pending = [copy], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    // structuredClone copies ordinary buffers but aliases shared storage.
    // Refuse it before inspecting contents or invoking an asynchronous verifier.
    if (value instanceof SharedArrayBuffer || (ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer)) {
      throw new EncodingError("shared replay input");
    }
    // Containers Object.values cannot enumerate would hide shared storage from this scan.
    if (value instanceof Map || value instanceof Set) throw new EncodingError("unsupported replay input container");
    if (!ArrayBuffer.isView(value)) pending.push(...Object.values(value));
  }
  return copy;
}
/** The harness's own trail budget over supplied trails: one that does not frame is passed over,
 * and one past the budget refuses the read as a resource limit, as before the evidence store. */
function budgeted(trails, codec) {
  return trails.filter(bytes => { try { codec.decodeTrail(bytes, LIMITS); return true; } catch (error) {
    if (error instanceof EncodingError) return false; throw error; } });
}
function byteList(value, name) {
  const list = value === undefined ? [] : value;
  if (!Array.isArray(list) || list.some(item => !(item instanceof Uint8Array))) throw new EncodingError(`invalid ${name}`);
  return list;
}
/** A reader-selected RecordVenue as the harness hands it to the reader, with
 * its provenance label. The reader asks under RANGE_LIMITS, so a harness
 * wrapper that replaces `range` may take the request alone. */
export const recordReader = (venue, evidenceKind) => ({ evidenceKind, id: venue.id,
  range: (request, limits = RANGE_LIMITS) => venue.range(request, limits),
  witnessedIndex: () => venue.witnessedIndex(), lag: () => venue.lag() });


/** verifier.configuration is independently selected and its six keys checked
 * by the harness. Issuer identity comes from signed scoped terms (§11).
 * With a fixture venue and verifier.record, §13 ranges fix the chain, the
 * checkpoint's record prefix and currency against that fixture only, and
 * every carrying checkpoint is classified from its own committed evidence.
 * No approved configuration or authenticated-chain finality verdict.
 * State reads expose nothing until every terminal assertion passes. A single
 * receipt instead returns its conditional verdict at the deciding checkpoint
 * or boundary; an unavailable suffix retains already proven liability facts. */
export async function replayLocalPackage(input, verifier, codec) {
  let context;
  const failure = (status, check = null) => ({ ...refused(status, check),
    ...context?.faults.result(),
    ...(context?.receiptWalk === undefined ? {} : { receiptEvidence: context.receiptWalk.evidence() }) });
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid replay input");
    const fields = Object.keys(input).sort().join(",");
    // The reader's record factory owns the venue evidence under its own
    // budgets (a fixture venue copies it; ErgoVenue verifies and copies what
    // its suppliers serve). Cloning it here would allocate unbounded raw
    // evidence before the venue can check it.
    const { venue, ...source } = input;
    const { faults, ...basePackage } = source.package ?? {};
    const ownedFaults = boundFaultInputs(faults);
    const owned = ownInputs({ ...source, package: basePackage });
    owned.package.faults = ownedFaults;
    const { selection, package: supplied, seed } = owned;
    // Do not silently keep the retired issuer override as an alternate input.
    requireReplay(INPUT_SHAPES.includes(fields), "INPUT_FIELDS");
    // Reference provenance belongs to the caller's verifier, never the package.
    // Own it once before asynchronous work, and guard even trail-only replay.
    const reference = structuredClone(verifier.reference);
    const expectedVenue = referenceVenue(reference);
    requireReplay(selection?.venue instanceof Uint8Array && same(selection.venue, expectedVenue.id), "VENUE_REFERENCE");
    // The reader's own budget selection is checked before any evidence.
    const importLimits = importLimitsOf(verifier);
    requireReplay(codec.verifyConfiguration(supplied?.configuration, verifier.configuration), "CONFIGURATION");
    const domain = codec.configurationHash(codec.decodeConfiguration(supplied.configuration));
    requireReplay(selection?.domain instanceof Uint8Array && same(domain, selection.domain), "CONFIGURATION");
    const { snapshot, trail, header } = readLocalEvidence(selection, supplied, codec,
      { allowImports: venue !== undefined, allowScopes: venue !== undefined });
    const selectedEntry = header.entries.findIndex(entry => same(entry.backing, selection.backing));
    // pool-v3 §12.1: each scoped field is resolved by name from any strictly
    // verifying supplied field; a failing one is ignored, and without any the
    // terms are missing evidence, so the read is unresolved.
    // The harness copies its trails into its own evidence storage, as the runtime reader does.
    const suppliedTrails = new EvidenceStore().importTrails(budgeted([supplied.trail, ...byteList(supplied.trails, "trails")], codec));
    const signedTerms = header.entries.map((entry, i) => resolveTerms(suppliedTrails, sha256(trail.header), entry, i));
    if (signedTerms.some(field => field === undefined)) throw new EvidenceRefusal("unresolved-evidence");
    // Resolution verified the selected field's signature and its name as the
    // selected backing (readLocalEvidence binds the backing to the header).
    const terms = decodeRootTerms(signedTerms[selectedEntry].terms);
    requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
    // Without venue evidence only the original scope is supported. A successor
    // empty book needs the same term-by-term descent as a nonempty import.
    const imports = header.entries.some(entry => entry.opening !== undefined);
    if (venue === undefined && !imports && header.entries.length === 1) requireReplay(same(terms.operator, header.operator) && same(header.entries[0].link, selection.backing), "TERMS_INITIAL_SCOPE");
    if (supplied.faults?.length && venue === undefined) throw new EvidenceRefusal("unsupported-scope");
    context = { store: new ReplayStore(), witness: seed === undefined ? undefined : seedWitness(seed, selection.domain),
      selection, terms, signedTerms, header, verifier, codec, reference, importLimits, receiptBytes: supplied.receipt,
      faults: faultObserver(supplied.faults, selection, verifier, codec) };
    if (supplied.receipt !== undefined && (seed !== undefined || venue === undefined)) throw new EvidenceRefusal("unsupported-scope");
    let ranges = null, carrying = null, clock = null, state, rangeEvidence = "none";
    if (venue !== undefined) {
      if (typeof verifier.record !== "function") throw new EvidenceRefusal("unresolved-evidence");
      const record = await verifier.record(venue);
      if (record === undefined) throw new EvidenceRefusal("unresolved-evidence");
      // Metadata belongs to the reader's selected verifier, never the package.
      rangeEvidence = record.evidenceKind ?? "reader-selected-verifier";
      const others = supplied.directories === undefined ? [] : supplied.directories;
      if (!Array.isArray(others)) throw new EncodingError("invalid directories");
      const directories = new Map([supplied.directory, ...others].map(entries => [hex(directoryRoot(entries)), entries]));
      // Identical bytes are one object, as the package's inventory already refuses a repeated payload (§12).
      const distinct = list => list.filter((item, i) => list.findIndex(other => same(other, item)) === i);
      const snapshots = distinct([supplied.snapshot, ...byteList(supplied.snapshots, "snapshots")]);
      const trails = distinct([supplied.trail, ...byteList(supplied.trails, "trails")]);
      const result = await classifyScopes(context, directories, record, { snapshots, trails: new EvidenceStore().importTrails(budgeted(trails, codec)) });
      if (result.receipt !== undefined) return { ...refused("receipt-status"), ...context.faults.result(), receipt: result.receipt, rangeEvidence,
        candidateConfigurationChecked: true, signedTermsAuthenticated: true, termsAuthorityAuthenticated: true,
        currentRangeAuthenticated: selection.mode !== "historical-fixture" };
      ({ carrying, state, clock, ranges } = result);
    } else {
      // Both grades need the independently answered record ranges.
      if (terms.silence !== undefined || terms.nonService !== undefined) throw new EvidenceRefusal("unsupported-scope");
      const entry = supplied.directory.find(item => same(item.name, selection.backing));
      // readLocalEvidence authenticated the whole trail as this snapshot's evidence.
      state = await replayTrail(context, snapshot, suppliedTrails.served({ backing: selection.backing, segment: snapshot.segment, digest: entry.digest }, snapshot), {});
    }
    if (state === undefined) throw new Error("the selection was not classified");
    const { issued, burned, position, history } = state;
    // Shared history can contain notes for other scoped backings owned by the
    // same seed. This query restores only its independently selected backing.
    const candidates = seed === undefined ? [] : ownedNotes(seed, selection.domain, selection.backing, state).map(note => ({
      cm: note.cm.toString(), nf: note.nf.toString(), value: note.opening.value.toString(), leaf: note.leaf.toString(), anchor: note.anchor.toString(),
      siblings: note.path.siblings.map(String), right: [...note.path.right],
      pathScope: note.local ? "replayed-local-tree-only" : "replayed-imported-tree-only", spendable: false }));
    const historical = selection.mode === "historical-fixture";
    return { status: historical ? "historical-local-replay" : "selected-local-replay",
      ...context.faults.result(),
      ...flags, candidateConfigurationChecked: true, signedTermsAuthenticated: true,
      ...(ranges === null ? {} : { currentRangeAuthenticated: !historical, termsAuthorityAuthenticated: true, rangeEvidence }),
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: state.noteRoot().toString(), spentRoot: hex(state.spentRoot()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash),
        range: ranges === null ? null : { judgingIndex: ranges.judgingIndex.toString(), lag: ranges.lag.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
          revokedAt: ranges.revokedAt === undefined ? null : ranges.revokedAt.toString(),
          heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter,
          chain: ranges.chain.map(link => ({ operator: hex(link.operator), from: link.from.toString(), link: hex(link.link) })),
          carrying, clock, ...(ranges.publications === undefined ? {} : { publications: ranges.publications }),
          ...(ranges.nonService === undefined ? {} : { nonService: ranges.nonService }) } }, candidates };
  } catch (error) {
    if (error instanceof CandidateVenueError) return failure("invalid-local-replay", "VENUE_REFERENCE");
    if (error instanceof ReplayRefusal) return failure("invalid-local-replay", error.check);
    // A lapsed selection carries the clock record proving the lapse (C2b.4.1) beside the refusal.
    if (error instanceof EvidenceRefusal) return { ...failure(error.status), ...(error.clock === undefined ? {} : { clock: error.clock }) };
    if (error instanceof codec.TrailLimitError || error instanceof codec.RangeLimitError) return failure("resource-refusal");
    if (error instanceof EncodingError ||
      error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return failure("unresolved-evidence");
    throw error;
  }
}

/** Portable §12 boundary for the bounded local experiment. Select exactly one
 * configuration and commitment; the selection's snapshot is the one its
 * directory names for the backing, by hash, and its trail the prefix of a
 * packaged trail that authenticates it (§10.1, §12.1); matching prefixes are
 * one dependency. The direct replayLocalPackage input instead takes the
 * selection's exact served trail. Every other directory, snapshot and trail is a
 * dependency the §13 range/import read may need. One kind-10 receipt selects
 * a receipt query; kind-7 facts may also support the bounded §9.1 exclusion path
 * after all its dependencies resolve. Other kinds require a later reader.
 * The same replay engine then
 * authenticates every relationship against selection and, with a fixture
 * venue, against the record ranges. */
export async function replayEvidencePackage(input, verifier, codec) {
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid package input");
    requireReplay(INPUT_SHAPES.includes(Object.keys(input).sort().join(",")), "INPUT_FIELDS");
    // Decode synchronously before ownership copying: the codec checks the byte
    // and item budgets before copying payloads. structuredClone would copy even
    // the unused backing allocation of a small subview before checking bounds.
    const items = codec.decodeEvidencePackage(input.package, PACKAGE_LIMITS);
    const source = input.selection;
    if (source === null || typeof source !== "object" ||
        Object.keys(source).sort().join(",") !== "backing,domain,judgingIndex,mode,operator,root,sequence,venue" ||
        !isValue(source.sequence) || source.sequence === 0n || !isValue(source.judgingIndex) ||
        !["current-fixture", "historical-fixture"].includes(source.mode)) throw new EncodingError("invalid selection");
    const fields = ["backing", "domain", "operator", "root", "venue"];
    const fixed = fields.map(key => source[key]);
    if (input.seed !== undefined) fixed.push(input.seed);
    if (fixed.some(value => !(value instanceof Uint8Array) || value.length !== 32 || value.buffer instanceof SharedArrayBuffer)) {
      throw new EncodingError("invalid or shared selection/seed bytes");
    }
    const selection = { mode: source.mode, sequence: source.sequence, judgingIndex: source.judgingIndex,
      ...Object.fromEntries(fields.map(key => [key, copyBytes(source[key])])) };
    const owned = { selection, ...(input.seed === undefined ? {} : { seed: copyBytes(input.seed) }),
      ...(input.venue === undefined ? {} : { venue: input.venue }) };
    const kinds = [1, 2, 3, 4, 6];
    if (items.some(item => ![...kinds, 7, 10].includes(item.kind)) || [1, 2, 10].some(kind => items.filter(item => item.kind === kind).length > 1)) {
      return refused("unsupported-scope");
    }
    if (kinds.some(kind => !items.some(item => item.kind === kind))) return refused("unresolved-evidence");
    const payloads = kind => items.filter(item => item.kind === kind).map(item => item.payload);
    const directories = payloads(3).map(payload => codec.decodeEvidenceDirectory(payload, PACKAGE_LIMITS));
    // The packaged commitment's own directory; whether it is the selection is readLocalEvidence's check.
    const root = decodeCommitment(payloads(2)[0]).root;
    const directory = directories.find(entries => same(directoryRoot(entries), root));
    const entry = directory?.find(item => same(item.name, selection.backing));
    if (entry === undefined) return refused("unresolved-evidence");
    const snapshotBytes = payloads(4).find(payload => same(sha256(payload), entry.digest));
    if (snapshotBytes === undefined) return refused("unresolved-evidence");
    const snapshot = codec.decodeSnapshot(snapshotBytes), expected = { backing: selection.backing, segment: snapshot.segment, digest: entry.digest };
    // pool-v3 §12.1: the selection's served trail may be the prefix of a longer packaged trail.
    const trailed = payloads(6).filter(payload => { try { codec.decodeTrail(payload, LIMITS); return true; } catch (error) {
      if (error instanceof EncodingError) return false; throw error; } });
    const served = new EvidenceStore().importTrails(trailed).served(expected, snapshot);
    if (served === undefined) return refused("unresolved-evidence");
    const scoped = codec.decodeSegmentHeader(served.header).entries.length;
    const encoded = codec.encodeTrail({ header: served.header, terms: Array.from({ length: scoped }, (_, i) => served.term(i)),
      records: [...served.records()] }, LIMITS);
    const trailBytes = [payloads(6).find(payload => same(payload, encoded)) ?? encoded];
    const others = directories.filter(entries => entries !== directory);
    const snapshots = payloads(4).filter(payload => payload !== snapshotBytes), trails = payloads(6).filter(payload => payload !== trailBytes[0]);
    if (others.length + snapshots.length + trails.length > 0 && input.venue === undefined) return refused("unsupported-scope");
    return await replayLocalPackage({ ...owned, package: { configuration: payloads(1)[0], commitment: payloads(2)[0],
      directory, directories: others, snapshot: snapshotBytes, snapshots, trail: trailBytes[0], trails, faults: payloads(7),
      ...(payloads(10).length === 0 ? {} : { receipt: payloads(10)[0] }) } }, verifier, codec);
  } catch (error) {
    if (error instanceof ReplayRefusal) return refused("invalid-local-replay", error.check);
    if (error instanceof codec.PackageLimitError || error instanceof codec.TrailLimitError) return refused("resource-refusal");
    if (error instanceof EncodingError) return refused("unresolved-evidence");
    throw error;
  }
}
