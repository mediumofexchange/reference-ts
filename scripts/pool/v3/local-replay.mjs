// Conditional replay harness over the runtime's v3 reader (src/pool/v3/reader.ts,
// state.ts): imports, multiple backings, receipts, recovery force and
// non-service counts are read here until their slices promote them.
// pool-v3 §§3,5,7,10,12,13; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { createHash } from "node:crypto";
import { compareBytes, copyBytes, EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot } from "../../../dist/venue-records.js";
import { fieldToBytes, identifierOf, isValue } from "../../../dist/pool/field.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { ownerOf, commitmentOf, nullifierOf } from "../../../dist/pool/notes.js";
import { createCapsuleScanner, deriveSettlementOwnerSecret, CapsuleAssociationError, CapsuleFormatError } from "../../../dist/pool/v3/capsules.js";
import { classifyCarrying, decodedTrails, RANGE_LIMITS, readRecordRanges, readRecordView, replayTrail } from "../../../dist/pool/v3/reader.js";
import { EvidenceRefusal, ReplayRefusal, ScopeRequired, requireReplay } from "../../../dist/pool/v3/refusals.js";
import { recoveryState, effectOf, checkRecovery, applyRecovery } from "../../../dist/pool/v3/recovery.js";
import { servedTrail } from "../../../dist/pool/v3/served-trail.js";
import { LIMITS, readLocalEvidence } from "../delivery/evidence-reader.mjs";
import { receiptWalk } from "./receipt-state.mjs";
import { countNonService } from "./non-service.mjs";
import { classifyScopes } from "./scope-replay.mjs";
import { checkpointScope, resolveTerms, rootTermsOf } from "./scope-evidence.mjs";
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

/** C2.10.3–7 for a single backing. Its canonical
 * ancestry is linear: each new segment imports the last valid checkpoint's
 * closure once. Every checkpoint is classified at its own prefix, and every
 * continuation replays from its segment's fixed opening base. No union of
 * raw trails, recursion, or replica-provided finality is involved. */
async function classifyImports(context, directories, record, evidence) {
  const { selection, terms, codec } = context;
  const view = await readRecordView(selection, terms, directories, record);
  const { chain, heldBy, termEnd, carries, revokedAt, t, lag } = view;
  const duration = terms.silence?.noCommitmentDuration;
  const counting = terms.nonService !== undefined && context.receiptBytes === undefined;
  let publications = duration === undefined && !counting ? [] : context.receiptBytes === undefined ?
    (await view.ask(4, selection.backing)).entries : undefined;
  const selectedHeld = (await heldBy(selection.operator)).find(h => h.commitment.sequence === selection.sequence && same(h.commitment.root, selection.root));
  if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
  if (!same(codec.linkInForce(chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  const trails = decodedTrails(evidence.trails), segments = new Map(), clocks = new Map(), carrying = [];
  if (context.receiptBytes !== undefined) {
    const receipt = codec.decodeReceipt(context.receiptBytes);
    const original = trails.find(trail => same(sha256(trail.header), receipt.segment));
    if (original !== undefined && codec.decodeSegmentHeader(original.header).entries.length !== 1) throw new ScopeRequired();
  }
  const walk = context.receiptBytes === undefined ? undefined :
    await receiptWalk(context.receiptBytes, context, view, trails, evidence.snapshots);
  context.receiptWalk = walk;
  context.contextReceipt = walk?.receipt;
  const matches = (a, b) => a !== undefined && b !== undefined && a.sequence === b.sequence && same(a.operator, b.operator) && same(a.root, b.root);
  let canonical, countSnapshot, selectedState, selectedClock, checkpoints = 0n, events = 0n, heldBefore = 0, heldAfter = 0;
  let publicationAt = 0;
  const force = [], publicationVerdicts = [];
  const limits = context.importLimits;
  const charge = (amount = 1n) => { events += amount; if (events > limits.maxEvents) throw new EvidenceRefusal("resource-refusal"); };
  // Each publication is charged once, for its answer; later passes do not charge it again.
  if (publications !== undefined) charge(BigInt(publications.length));
  // At one index the whole publication group is read BEFORE any checkpoint.
  // Effects change recovery state but never extend the snapshot's forest.
  const publishThrough = async through => {
    // A non-service clause alone gives requests a count, never recovery force.
    if (duration === undefined) return;
    // Receipt inclusion before any gap needs no later publication evidence.
    if (publications === undefined) {
      if (canonical === undefined || through - canonical.index <= duration) return;
      publications = (await view.ask(4, selection.backing)).entries;
      charge(BigInt(publications.length));
    }
    while (publicationAt < publications.length && publications[publicationAt].index <= through) {
      const entry = publications[publicationAt++], item = { index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
      publicationVerdicts.push(item);
      let publication;
      try { publication = codec.decodePublication(entry.record); }
      catch (error) {
        if (error instanceof EncodingError) continue;
        throw error;
      }
      if (!same(publication.domain, selection.domain) || !same(publication.backing, selection.backing) ||
          publication.kind === 2 || publication.kind === 5 || canonical === undefined ||
          entry.index - canonical.index <= duration) continue;
      // canonical is strictly before entry.index: the group is processed once
      // before the first held checkpoint there, including non-carrying ones.
      if (canonical.index >= entry.index) throw new Error("publication prefix order");
      const source = canonical.state, state = { ...recoveryState(source), nullifiers: new Set(source.nullifiers), outputsSeen: new Set(source.outputsSeen) };
      const apply = record => {
        applyRecovery(record, state);
        const effect = effectOf(record);
        effect.nfs.forEach(nf => state.nullifiers.add(nf)); effect.outputs.forEach(cm => state.outputsSeen.add(cm));
      };
      for (const prior of force) if (prior.index > source.adoptionIndex) { charge(); apply(prior.record); }
      const record = publication.record, p = record.publicInputs;
      try {
        requireReplay(same(identifierOf(p[2], p[3]), canonical.segment) && p[4] === canonical.scope, "CONTEXT");
        if (record.kind !== 5) requireReplay(same(identifierOf(p[5], p[6]), selection.backing), "BACKING");
        if (record.kind !== 5) requireReplay(await context.verifier.verify(record.kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
        const { roots, nfs, outputs } = effectOf(record);
        requireReplay(roots.every(root => source.anchors.has(root)), "ANCHOR");
        requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !state.nullifiers.has(nf)), "SPENT");
        requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !state.outputsSeen.has(cm)), "OUTPUT");
        checkRecovery(record, state, { check: requireReplay, backing: selection.backing, issuer: terms.obligor,
          at: entry.index, lag, publication: true });
        force.push({ index: entry.index, record, bytes: codec.encodeRecord(record) }); item.force = true;
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        item.check = error.check;
      }
    }
  };
  let latestValid = 0n, closing = 0n, currentIndex = -1n;
  const advanceClock = at => {
    if (at !== currentIndex) { closing = latestValid; currentIndex = at; }
    if (duration === undefined || at - closing <= duration) return;
    // Record intervening gaps BEFORE any segment resets the backing's clock.
    // Every old boundary survives a later return, including excluded openings.
    for (const clock of clocks.values()) {
      if (clock.boundary === undefined && at > clock.opening) {
        const gap = closing + duration + 1n;
        clock.boundary = gap > clock.opening ? gap : clock.opening + 1n;
      }
    }
  };
  const clockRecord = (at, clock) => ({ duration: duration.toString(), snapshotIndex: closing.toString(),
    gap: (at - closing).toString(), open: at - closing > duration,
    boundary: clock.boundary === undefined ? null : clock.boundary.toString(), opening: clock.opening.toString() });
  for (let termIndex = 0; termIndex < chain.length; termIndex++) {
    const term = chain[termIndex];
    for (const held of await heldBy(term.operator)) {
      if (held.index < term.from || held.index > termEnd(termIndex)) continue;
      advanceClock(held.index);
      const boundary = walk?.boundary(held.index, clocks.get(hex(walk.receipt.segment)));
      if (boundary !== undefined) return { receipt: boundary };
      await publishThrough(held.index);
      if (++checkpoints > limits.maxCheckpoints) throw new EvidenceRefusal("resource-refusal");
      const c = held.commitment, selected = matches(c, selection);
      if (!selected) { if (selectedState === undefined) heldBefore++; else heldAfter++; }
      const entry = carries(held);
      if (entry === undefined) { walk?.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      if (directories.get(hex(c.root)).length !== 1) throw new ScopeRequired();
      const bytes = evidence.snapshots.find(x => same(sha256(x), entry.digest));
      if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const snapshot = codec.decodeSnapshot(bytes);
      const scope = checkpointScope(trails, selection.backing, entry.digest, snapshot, codec), { header } = scope;
      if (header.entries.length !== 1) throw new ScopeRequired();
      await context.faults.inspect(held, directories.get(hex(c.root)), scope);
      // checkpointScope resolved this one-entry scope's terms for the selected backing.
      const scoped = header.entries[0];
      const item = { operator: hex(c.operator), sequence: c.sequence.toString(), index: held.index.toString() };
      try {
        requireReplay(same(header.domain, selection.domain) && same(header.venue, selection.venue) && same(header.operator, c.operator) &&
          same(scoped.backing, selection.backing) && header.sequence <= c.sequence, "CONTEXT");
        const ownTerm = chain.find(link => same(link.link, scoped.link));
        requireReplay(ownTerm !== undefined && same(ownTerm.operator, header.operator), "TERMS_SCOPE");
        if (!same(ownTerm.link, term.link) && ownTerm.from < term.from) {
          carrying.push({ ...item, class: "lapsed" });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "lapsed");
          if (selected && !walk) throw new EvidenceRefusal("lapsed-selection");
          continue;
        }
        requireReplay(same(ownTerm.link, term.link), "TERMS_SCOPE");
        const id = hex(snapshot.segment);
        let clock = clocks.get(id);
        if (clock === undefined) {
          const openingHeld = (await heldBy(header.operator)).some(h => h.commitment.sequence === header.sequence);
          if (!openingHeld) throw new EvidenceRefusal("unresolved-evidence");
          requireReplay(c.sequence === header.sequence, "OPENING");
          clock = { opening: held.index, boundary: undefined };
          clocks.set(id, clock);
        }
        if (duration !== undefined && c.sequence !== header.sequence &&
            (held.index - closing > duration || (clock.boundary !== undefined && clock.boundary < held.index))) {
          carrying.push({ ...item, class: "lapsed" });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "lapsed");
          if (selected && !walk) throw Object.assign(new EvidenceRefusal("lapsed-selection"), { clock: clockRecord(held.index, clock) });
          continue;
        }
        let segment = segments.get(id);
        if (segment === undefined) {
          // Missing opening evidence is not an exclusion certificate. In
          // particular it cannot let a successor roll back to an older state.
          const openingHeld = (await heldBy(header.operator)).some(h => h.commitment.sequence === header.sequence);
          if (!openingHeld) throw new EvidenceRefusal("unresolved-evidence");
          // The first checkpoint carries the opening. A later first sighting
          // cannot substitute for an omitted or differently scoped opening.
          requireReplay(c.sequence === header.sequence, "OPENING");
          // C2.10.4–5 / C2b.4.1: every fresh opening imports the canonical
          // child-relative predecessor, including lower same-index sequences.
          // Publication force and the gap still use the strictly-before state;
          // an empty opening inherits the unadopted block via adoptionIndex.
          requireReplay(canonical === undefined ? scoped.opening === undefined : matches(scoped.opening, canonical.commitment), "IMPORT");
          if (canonical !== undefined) {
            requireReplay(canonical.index < held.index || (same(canonical.commitment.operator, c.operator) && canonical.commitment.sequence < c.sequence), "IMPORT_RANK");
            if (!same(canonical.commitment.operator, c.operator)) requireReplay(canonical.index < term.from, "IMPORT_RANK");
          }
          segment = { imported: canonical?.state, predecessor: canonical?.commitment, lastValid: undefined,
            openingIndex: held.index, block: force.filter(event => event.index > (canonical?.state.adoptionIndex ?? 0n)) };
          segments.set(id, segment);
        }
        // Returning to an older segment cannot abandon a valid newer segment.
        requireReplay(canonical === undefined || same(canonical.segment, snapshot.segment) || matches(segment.predecessor, canonical.commitment), "CONTINUITY");
        // §9.1: the valid opening derived this segment's adopted block from the
        // complete publication range. A compact fault excludes only a target
        // position after that block; positions inside it keep ordinary evidence.
        const intrinsic = segment.openingValid && segment.lastValid !== undefined ?
          context.faults.intrinsicFailure(held, scope, BigInt(segment.block.length)) : undefined;
        const evidence = scope.classificationEvidence(intrinsic);
        if (evidence.intrinsic !== undefined) {
          carrying.push({ ...item, class: "excluded", check: evidence.intrinsic });
          walk?.checkpoint(held, snapshot.segment, undefined, header, "excluded");
          continue;
        }
        const { trail } = evidence;
        if (c.sequence === header.sequence) requireReplay(trail.records.length === 0, "OPENING");
        const state = await replayTrail({ ...context, header }, snapshot, trail,
          { index: held.index, revokedAt, lastValid: segment.lastValid, imported: segment.imported,
            block: c.sequence === header.sequence ? [] : segment.block, openingIndex: segment.openingIndex, isOpening: c.sequence === header.sequence,
            chargeRecords: charge });
        segment.lastValid = { position: state.position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash, eventIndices: state.eventIndices, state };
        if (c.sequence === header.sequence) segment.openingValid = true;
        canonical = { commitment: c, index: held.index, segment: snapshot.segment, scope: new ScopeTree(header.entries).root(), state };
        if (held.index < t) countSnapshot = canonical;
        latestValid = held.index;
        carrying.push({ ...item, class: "valid" });
        const verdict = walk?.checkpoint(held, snapshot.segment, state, header, "valid");
        if (verdict !== undefined) return { receipt: verdict };
        if (selectedState !== undefined && !walk) throw new EvidenceRefusal("superseded-selection");
        if (selected) { selectedState = state; selectedClock = clock; }
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        scope.fullTrail(); // Other failures still require the complete event evidence.
        if (selected && !walk) throw error;
        carrying.push({ ...item, class: "excluded", check: error.check });
        walk?.checkpoint(held, snapshot.segment, undefined, header, "excluded");
      }
    }
  }
  if (selectedState === undefined && !walk) throw new EvidenceRefusal("unresolved-evidence");
  advanceClock(t);
  if (walk) return { receipt: walk.boundary(t, clocks.get(hex(walk.receipt.segment))) ?? walk.finish() };
  await publishThrough(t);
  const clock = duration === undefined ? null : clockRecord(t, selectedClock);
  const nonService = counting ? await countNonService(context, view, countSnapshot, publications, charge) : undefined;
  return { state: selectedState, carrying, clock,
    ranges: { judgingIndex: t, lag, checkpointIndex: selectedHeld.index, revokedAt, heldBefore, heldAfter, chain,
      publications: publicationVerdicts, ...(nonService === undefined ? {} : { nonService }) } };
}

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
    const suppliedTrails = [trail, ...decodedTrails(byteList(supplied.trails, "trails"))];
    const signedTerms = header.entries.map((entry, i) => resolveTerms(codec, suppliedTrails, sha256(trail.header), entry, i));
    if (signedTerms.some(field => field === undefined)) throw new EvidenceRefusal("unresolved-evidence");
    // Resolution verified the selected field's signature and its name as the
    // selected backing (readLocalEvidence binds the backing to the header).
    const terms = rootTermsOf(codec, signedTerms[selectedEntry]);
    requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
    // Empty-opening selections retain the original-operator scope. Imports
    // instead require the term-by-term record walk below.
    const imports = header.entries.some(entry => entry.opening !== undefined);
    if (!imports && header.entries.length === 1) requireReplay(same(terms.operator, header.operator) && same(header.entries[0].link, selection.backing), "TERMS_INITIAL_SCOPE");
    if (supplied.faults?.length && venue === undefined) throw new EvidenceRefusal("unsupported-scope");
    context = { selection, terms, signedTerms, header, verifier, codec, importLimits, receiptBytes: supplied.receipt,
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
      try {
        if (header.entries.length !== 1) throw new ScopeRequired();
        if (imports || supplied.receipt !== undefined || terms.nonService !== undefined) {
          const result = await classifyImports(context, directories, record, { snapshots, trails });
          if (result.receipt !== undefined) return { ...refused("receipt-status"), ...context.faults.result(), receipt: result.receipt, rangeEvidence,
            candidateConfigurationChecked: true, signedTermsAuthenticated: true, termsAuthorityAuthenticated: true,
            currentRangeAuthenticated: selection.mode !== "historical-fixture" };
          ({ carrying, state, clock, ranges } = result);
        } else {
          ranges = await readRecordRanges(selection, terms, header, directories, record);
          ({ carrying, state, clock } = await classifyCarrying(context, ranges, { snapshot, trail, snapshots, trails }));
        }
      } catch (error) {
        if (!(error instanceof ScopeRequired)) throw error;
        const result = await classifyScopes(context, directories, record, { snapshots, trails },
          { readRecordView, decodedTrails, replayTrail, requireReplay, ReplayRefusal, IMPORT_LIMITS: context.importLimits });
        if (result.receipt !== undefined) return { ...refused("receipt-status"), ...context.faults.result(), receipt: result.receipt, rangeEvidence,
          candidateConfigurationChecked: true, signedTermsAuthenticated: true, termsAuthorityAuthenticated: true,
          currentRangeAuthenticated: selection.mode !== "historical-fixture" };
        ({ carrying, state, clock, ranges } = result);
      }
    } else {
      // Both grades need the independently answered record ranges.
      if (terms.silence !== undefined || terms.nonService !== undefined) throw new EvidenceRefusal("unsupported-scope");
      state = await replayTrail(context, snapshot, trail, {});
    }
    if (state === undefined) throw new Error("the selection was not classified");
    const { tree, spent, issued, burned, position, history, scanOutputs, outputPositions } = state;
    const candidates = [];
    if (seed !== undefined) {
      const scanner = createCapsuleScanner(seed, selection.domain);
      for (const output of scanOutputs) {
        let note;
        if (output.settlement === undefined) note = scanner.tryRecover(output.cm, output.capsule);
        else {
          const record = output.settlement, p = record.publicInputs, { acceptance } = codec.settlementAuthorization(record);
          const secret = deriveSettlementOwnerSecret(seed, selection.domain, acceptance.demand, acceptance.deadline).value;
          if (ownerOf(secret) !== p[8]) continue;
          const opening = { backing: identifierOf(p[5], p[6]), value: p[7], owner: p[8], rho: p[9] };
          requireReplay(commitmentOf(selection.domain, opening) === output.cm, "OUTPUT");
          note = { opening, cm: output.cm, nf: nullifierOf(selection.domain, output.cm, secret) };
        }
        if (note === null) continue;
        // Shared history can contain notes for other scoped backings owned by
        // the same seed. This query restores only its independently selected backing.
        if (!same(note.opening.backing, selection.backing)) continue;
        if (note.opening.value > 0n && !spent.has(fieldToBytes(note.nf))) {
          const location = outputPositions.get(note.cm), { leaf } = location, path = location.tree.path(leaf);
          candidates.push({ cm: note.cm.toString(), nf: note.nf.toString(), value: note.opening.value.toString(),
            leaf: leaf.toString(), anchor: location.tree.root().toString(), siblings: path.siblings.map(String), right: [...path.right],
            pathScope: location.tree === tree ? "replayed-local-tree-only" : "replayed-imported-tree-only", spendable: false });
        }
      }
    }
    const historical = selection.mode === "historical-fixture";
    return { status: historical ? "historical-local-replay" : "selected-local-replay",
      ...context.faults.result(),
      ...flags, candidateConfigurationChecked: true, signedTermsAuthenticated: true,
      ...(ranges === null ? {} : { currentRangeAuthenticated: !historical, termsAuthorityAuthenticated: true, rangeEvidence }),
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: tree.root().toString(), spentRoot: hex(spent.root()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash),
        range: ranges === null ? null : { judgingIndex: ranges.judgingIndex.toString(), lag: ranges.lag.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
          revokedAt: ranges.revokedAt === undefined ? null : ranges.revokedAt.toString(),
          heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter,
          chain: ranges.chain.map(link => ({ operator: hex(link.operator), from: link.from.toString(), link: hex(link.link) })),
          carrying, clock, ...(ranges.publications === undefined ? {} : { publications: ranges.publications }),
          ...(ranges.nonService === undefined ? {} : { nonService: ranges.nonService }) } }, candidates };
  } catch (error) {
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
    const served = servedTrail(expected, snapshot, decodedTrails(payloads(6)));
    if (served === undefined) return refused("unresolved-evidence");
    const encoded = codec.encodeTrail(served, LIMITS), trailBytes = [payloads(6).find(payload => same(payload, encoded)) ?? encoded];
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
