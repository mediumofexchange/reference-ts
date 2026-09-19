// Conditional single-backing experiment, not an adopted v3 runtime.
// pool-v3 §§3,5,7,10,12,13; pool-v2 §8 host checks; pool-spent C1.2.8–9.
import { createHash } from "node:crypto";
import { compareBytes, copyBytes, EncodingError } from "../../../dist/bytes.js";
import { decodeCommitment, directoryRoot } from "../../../dist/commitment.js";
import { verifySignatureStrict } from "../../../dist/keys.js";
import { fieldToBytes, identifierOf, isValue, VALUE_BOUND } from "../../../dist/pool/field.js";
import { NoteTree, EMPTY_NOTE_ROOT, NOTE_TREE_CAPACITY } from "../../../dist/pool/note-tree.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { ownerOf, commitmentOf, nullifierOf } from "../../../dist/pool/notes.js";
import { RadixSpentSet } from "../spent-set/radix.mjs";
import { createCapsuleScanner, deriveSettlementOwnerSecret, CapsuleAssociationError, CapsuleFormatError } from "../delivery/crypto.mjs";
import { EvidenceRefusal, LIMITS, readLocalEvidence } from "../delivery/evidence-reader.mjs";
import { recoveryState, effectOf, checkRecovery, applyRecovery } from "./recovery-state.mjs";
import { receiptWalk } from "./receipt-state.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
const sha256 = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
export const PACKAGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxItems: 1024n });
export const RANGE_LIMITS = Object.freeze({ maxBytes: 1_048_576n, maxEntries: 4096n });
// Work budgets for the linear single-backing import closure, including failed replays.
export const IMPORT_LIMITS = Object.freeze({ maxCheckpoints: 128n, maxEvents: 8192n });
const flags = Object.freeze({ fullV3Replay: false, currentRangeAuthenticated: false,
  candidateConfigurationChecked: false, signedTermsAuthenticated: false,
  termsAuthorityAuthenticated: false, completenessClaim: false, noMatchesMeansZeroBalance: false,
  unresolvedCoverage: true, spendable: false, rangeEvidence: "none" });
const refused = (status, check = null) => ({ status, check, ...flags, audit: null, candidates: [] });
class ReplayRefusal extends Error {
  constructor(check) { super(check); this.check = check; }
}
const requireReplay = (value, check) => { if (!value) throw new ReplayRefusal(check); };
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

/** §13 reads against the reader's independently selected verifier over
 * [0, t]: the replacement chain (C2.5) from the kind-2 answer under the
 * venue's lag, the held commitments (C2.3.3) of every party in force within
 * its term (C2.10.13), each passed by its packaged directory (C2.4.2) or
 * listed as carrying the backing, and K's revocation (C2b.1). The clock and
 * lag are the verifier's; a supplied answer is never evidence. This view is
 * shared by the original-segment clock and the single-backing import walk.
 * Nothing here classifies a checkpoint. */
async function readRecordView(selection, terms, directories, record, codec) {
  const t = selection.judgingIndex, now = await record.witnessedIndex(), lag = await record.lag();
  if (typeof now !== "bigint" || typeof lag !== "bigint" || t > now || (selection.mode === "current-fixture" && t !== now)) {
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const ask = async (kind, subject) => {
    const request = Object.freeze({ venue: copyBytes(selection.venue), kind, subject: copyBytes(subject), fromIndex: 0n, toIndex: t });
    const bytes = await record.range(request);
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    if (!(bytes instanceof Uint8Array)) throw new EncodingError("range answer");
    return codec.decodeRangeAnswer(bytes, request, RANGE_LIMITS);
  };
  const admitted = codec.admittedReplacements(await ask(2, selection.backing), terms.replacementRule);
  const { chain } = codec.replacementChain(admitted, { backing: selection.backing, original: terms.operator, lag, now: t });
  const revokedAt = codec.revocationIndex(await ask(3, terms.obligor));
  const heldOf = new Map();
  const heldBy = async operator => {
    const key = hex(operator);
    if (!heldOf.has(key)) heldOf.set(key, codec.heldCommitments(await ask(1, operator)).held);
    return heldOf.get(key);
  };
  const termEnd = i => (i + 1 < chain.length ? chain[i + 1].from - 1n : t);
  const carries = h => {
    const directory = directories.get(hex(h.commitment.root));
    if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return directory.find(entry => same(entry.name, selection.backing));
  };
  return { t, lag, chain, revokedAt, heldBy, termEnd, carries, ask };
}

/** Original-segment selection: its opening checkpoint anchors the silence
 * boundary. Successor/import selections use classifyImports instead. */
async function readRecordRanges(selection, terms, header, directories, record, codec) {
  const { t, lag, chain, revokedAt, heldBy, termEnd, carries } = await readRecordView(selection, terms, directories, record, codec);
  const held = await heldBy(chain[0].operator);
  const at = held.findIndex(h => h.commitment.sequence === selection.sequence && same(h.commitment.root, selection.root));
  if (at < 0) throw new EvidenceRefusal("selection-mismatch");
  // Witnessed in another party's term the selection is lapsed (C2.10.11); in a
  // later term of its own key it opens a new segment (C2.10.4), unsupported here.
  const inForce = codec.linkInForce(chain, held[at].index);
  if (!same(inForce.operator, chain[0].operator)) throw new EvidenceRefusal("lapsed-selection");
  if (inForce.from !== 0n) throw new EvidenceRefusal("unsupported-scope");
  // The original's first term: past it, its commitments are not read for the backing (C2.7.1).
  const term = held.filter(h => h.index <= termEnd(0)), carrying = [];
  for (const [i, h] of term.entries()) {
    const entry = carries(h);
    if (entry === undefined) continue;
    // A carrying checkpoint is read under the experiment's one-backing scope, as the selection is.
    if (directories.get(hex(h.commitment.root)).length !== 1) throw new EvidenceRefusal("unsupported-scope");
    carrying.push({ index: h.index, sequence: h.commitment.sequence, digest: entry.digest,
      position: i < at ? "before" : i === at ? "selected" : "after" });
  }
  for (let i = 1; i < chain.length; i++) {
    for (const h of await heldBy(chain[i].operator)) {
      if (h.index < chain[i].from || h.index > termEnd(i)) continue;
      if (carries(h) !== undefined) throw new EvidenceRefusal("unsupported-scope");
    }
  }
  // The segment's opening checkpoint is the carrying checkpoint at the header's opening sequence (C2b.4.1).
  const opening = carrying.find(c => c.sequence === header.sequence)?.index;
  const openingHeld = term.some(h => h.commitment.sequence === header.sequence);
  return { judgingIndex: t, lag, checkpointIndex: held[at].index, revokedAt, heldBefore: at, heldAfter: term.length - at - 1, chain, carrying, opening, openingHeld };
}

/** Trails that decode under the budget; one that does not decode is no
 * evidence for any checkpoint (§10.1) and is not read, while the budget holds. */
function decodedTrails(trails, codec) {
  const decoded = [];
  for (const bytes of trails) {
    try { decoded.push(codec.decodeTrail(bytes, LIMITS)); } catch (error) {
      if (!(error instanceof EncodingError || error instanceof codec.CodecEncodingError)) throw error;
    }
  }
  return decoded;
}

/** One checkpoint's trail under the segment's scope and terms. A
 * deterministic failure throws ReplayRefusal with its check; an unsupported
 * record kind throws EvidenceRefusal; the verifier's own failures propagate.
 * `lastValid` is the segment's last valid checkpoint before this one: the
 * trail must reach its length and reproduce its evidence and history hashes
 * there (C2.10.12, pool-v3 §7.1), the evidence before any verification. */
async function replayTrail({ selection, terms, header, verifier, codec, contextReceipt }, snapshot, trail,
  { index, revokedAt, lastValid, imported, block = [], openingIndex, isOpening = false }) {
  const issuerKey = terms.obligor, scope = new ScopeTree(header.entries).root();
  const tree = new NoteTree(), spent = new RadixSpentSet(), anchors = new Set(imported?.anchors ?? [EMPTY_NOTE_ROOT]);
  const nullifiers = new Set(imported?.nullifiers), outputsSeen = new Set(imported?.outputsSeen);
  for (const nf of nullifiers) spent.insert(fieldToBytes(nf));
  const statements = new Set(), outputPositions = new Map(imported?.outputPositions), scanOutputs = [...(imported?.scanOutputs ?? [])];
  const recovery = recoveryState(imported), eventIndices = [];
  if (!isOpening) requireReplay(trail.records.length >= block.length, "ADOPTION");
  let issued = imported?.issued ?? 0n, burned = imported?.burned ?? 0n, position = 0n, receiptEvent;
  let history = codec.genesisHistoryHash(snapshot.segment), evidence = codec.genesisEvidenceHash(snapshot.segment);
  for (const bytes of trail.records) {
    const record = codec.decodeRecord(bytes), p = record.publicInputs, kind = record.kind;
    if (![1, 2, 3, 4, 5, 6].includes(kind)) throw new EvidenceRefusal("unsupported-scope");
    const adopted = block[Number(position)];
    // Exact admitted bytes, including proof and authorization, survive adoption.
    if (adopted !== undefined) requireReplay(same(bytes, adopted.bytes), "ADOPTION");
    else {
      requireReplay(same(record.domain, selection.domain) && same(identifierOf(p[2], p[3]), snapshot.segment), "CONTEXT");
      requireReplay(p[4] === scope, "SCOPE");
    }
    const at = adopted?.index ?? lastValid?.eventIndices?.[Number(position)] ?? index;
    if (kind >= 4 && at === undefined) throw new EvidenceRefusal("unsupported-scope");
    const identity = codec.statementHash(record), id = hex(identity);
    requireReplay(!statements.has(id), "REPEATED_STATEMENT");
    evidence = codec.nextEvidenceHash(evidence, codec.evidenceHashes(record), position + 1n);
    if (lastValid !== undefined && position + 1n === lastValid.position) requireReplay(same(evidence, lastValid.evidenceHash), "CONTINUITY");
    // Issuance witnessed at or after K's revocation is void (C2b.1). A position
    // the last valid checkpoint finalized was witnessed at its index, not here.
    if (kind === 1 && index !== undefined && (lastValid === undefined || position + 1n > lastValid.position)) {
      requireReplay(revokedAt === undefined || revokedAt > index, "REVOKED");
    }
    if (adopted === undefined && kind !== 5) requireReplay(await verifier.verify(kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
    if (kind !== 2 && kind !== 5) {
      requireReplay(same(identifierOf(p[5], p[6]), selection.backing), "BACKING");
      if (kind === 1) {
        requireReplay(verifySignatureStrict(record.authorization, codec.statementBytes(record), issuerKey), "SIGNATURE");
        requireReplay(issued + p[7] < VALUE_BOUND, "SUPPLY");
      } else if (kind === 3) requireReplay(p[7] <= issued - burned, "SUPPLY");
    }
    const { nfs, roots, outputs } = effectOf(record);
    if (adopted === undefined) {
      requireReplay(roots.every(root => anchors.has(root)), "ANCHOR");
      checkRecovery(record, recovery, { codec, check: requireReplay, backing: selection.backing, issuer: issuerKey, at });
    }
    requireReplay(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !spent.has(fieldToBytes(nf))), "SPENT");
    requireReplay(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !outputsSeen.has(cm)), "OUTPUT");
    requireReplay(tree.size + BigInt(outputs.length) <= NOTE_TREE_CAPACITY && position + 1n < VALUE_BOUND, "CAPACITY");
    // All guards read the same pre-state. This local state is never returned
    // on failure, including a verifier rejection later in the supplied trail.
    const positions = tree.appendAll(outputs);
    outputs.forEach((cm, i) => {
      outputsSeen.add(cm); outputPositions.set(cm, { leaf: positions[i], tree });
      scanOutputs.push(kind === 6 ? { cm, settlement: record } : { cm, capsule: record.capsules[i] });
    });
    nfs.forEach(nf => { spent.insert(fieldToBytes(nf)); nullifiers.add(nf); });
    applyRecovery(record, recovery, codec); eventIndices.push(at);
    if (kind === 1) issued += p[7];
    if (kind === 3) burned += p[7];
    position += 1n;
    anchors.add(tree.root()); statements.add(id);
    history = codec.nextHistoryHash(history, identity, tree.root(), spent.root(), position);
    if (contextReceipt?.position === position && same(contextReceipt.segment, snapshot.segment)) {
      receiptEvent = { position, statementHash: identity, historyHash: history, ...codec.evidenceHashes(record) };
    }
    if (lastValid !== undefined && position === lastValid.position) requireReplay(same(history, lastValid.historyHash), "CONTINUITY");
  }
  requireReplay(lastValid === undefined || position >= lastValid.position, "CONTINUITY");
  requireReplay(same(history, snapshot.historyHash) && issued === snapshot.issued && burned === snapshot.burned, "SNAPSHOT");
  return { tree, spent, issued, burned, position, history, scanOutputs, outputPositions, anchors, nullifiers, outputsSeen,
    ...recovery, receiptEvent, eventIndices, adoptionIndex: isOpening ? imported?.adoptionIndex ?? 0n : openingIndex ?? 0n };
}

/** C2.10.11 over the original operator's carrying checkpoints in held order,
 * each at its own record prefix. Lapse by term is settled by the chain; lapse
 * by silence is read here (C2b.6.1, C2b.4.1): under a declared clause, c(i)
 * is the last valid carrying checkpoint strictly before index i, the gap is
 * open at i where i − c(i) exceeds the duration, the segment's silence
 * boundary is the first index strictly after its opening at which the gap
 * is open, and a non-opening checkpoint of this segment witnessed while the
 * gap is open or after the boundary is lapsed for its whole scope: held,
 * its snapshot resolved to establish the segment but its trail neither
 * resolved nor replayed, closing nothing. Otherwise each is valid, excluded
 * or unresolved from its own snapshot and trail, and the segment continues
 * from its last valid checkpoint (C2.10.12). A carrying checkpoint of
 * another segment contradicts the header's empty opening before the
 * selection (C2.7.3) and is an unsupported segment after it, whatever the
 * clock says. A valid later checkpoint supersedes the selection (C2.7.5);
 * an excluded or lapsed one is passed. Unresolved evidence anywhere in the
 * order stops the read. The clock at the judging index follows from the
 * same walk; a lapsed selection refuses with the clock record proving the
 * lapse; without a clause there is no gap. */
async function classifyCarrying(context, ranges, evidence) {
  const { selection, header, terms, codec } = context, { snapshot, trail, snapshots } = evidence;
  const trails = decodedTrails(evidence.trails, codec), carrying = [];
  const duration = terms.silence?.noCommitmentDuration, opening = ranges.opening, later = (a, b) => (a > b ? a : b);
  // The segment's opening checkpoint carries every scoped backing (C2b.4.1, C2.10.9a), clause or not: a held
  // commitment at the opening sequence carrying nothing for the backing contradicts the header; an opening
  // sequence the record does not hold is missing evidence.
  if (opening === undefined) {
    if (ranges.openingHeld) throw new ReplayRefusal("OPENING");
    throw new EvidenceRefusal("unresolved-evidence");
  }
  const clockRecord = (at, snapshotIndex, boundaryAt) => ({ duration: duration.toString(), snapshotIndex: snapshotIndex.toString(),
    gap: (at - snapshotIndex).toString(), open: at - snapshotIndex > duration, boundary: boundaryAt === undefined ? null : boundaryAt.toString(),
    opening: opening.toString() });
  let lastValid, state, latestValid = 0n, closing = 0n, currentIndex = -1n, boundary;
  for (const c of ranges.carrying) {
    // c(i) reads only checkpoints strictly before i: two at one index do not close each other's gap.
    if (c.index !== currentIndex) { closing = latestValid; currentIndex = c.index; }
    let s = snapshot, tr = trail;
    if (c.position !== "selected") {
      // The record pins an earlier state of this operator that the header's empty opening denies.
      if (c.sequence < header.sequence) throw new ReplayRefusal("OPENING");
      const bytes = snapshots.find(x => same(sha256(x), c.digest));
      if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
      s = codec.decodeSnapshot(bytes);
      if (!same(s.segment, snapshot.segment) || !same(s.backing, selection.backing)) {
        if (c.position === "before") throw new ReplayRefusal("OPENING");
        throw new EvidenceRefusal("unsupported-scope");
      }
    }
    // Lapse by silence (C2b.4.1): a non-opening checkpoint of this segment witnessed while the gap is open or past the boundary.
    if (duration !== undefined && c.sequence !== header.sequence) {
      const open = c.index - closing > duration;
      if (open && boundary === undefined && c.index > opening) boundary = later(closing + duration + 1n, opening + 1n);
      if (open || (boundary !== undefined && boundary < c.index)) {
        carrying.push({ sequence: c.sequence.toString(), index: c.index.toString(), class: "lapsed" });
        if (c.position === "selected") throw Object.assign(new EvidenceRefusal("lapsed-selection"), { clock: clockRecord(c.index, closing, boundary) });
        continue;
      }
    }
    if (c.position !== "selected") {
      // Its trail is the one that authenticates its committed evidence (§10.1); two distinct ones cannot.
      const expected = { backing: selection.backing, segment: s.segment, digest: c.digest };
      const matching = trails.filter(x => codec.verifyTrailEvidence(expected, s, x, LIMITS));
      if (matching.length !== 1) throw new EvidenceRefusal(matching.length === 0 ? "unresolved-evidence" : "unsupported-scope");
      tr = matching[0];
      const own = tr.terms[0];
      if (!same(codec.rootTermsName(own.terms), selection.backing) || !codec.verifyRootTermsSignature(own.terms, own.signature)) {
        throw new EvidenceRefusal("unresolved-evidence");
      }
    }
    let verdict;
    try {
      const replayed = await replayTrail(context, s, tr, { index: c.index, revokedAt: ranges.revokedAt, lastValid });
      verdict = { class: "valid" }; lastValid = { position: replayed.position, historyHash: s.historyHash, evidenceHash: s.evidenceHash,
        eventIndices: replayed.eventIndices };
      latestValid = c.index;
      if (c.position === "selected") state = replayed;
    } catch (error) {
      if (!(error instanceof ReplayRefusal) || c.position === "selected") throw error;
      verdict = { class: "excluded", check: error.check };
    }
    carrying.push({ sequence: c.sequence.toString(), index: c.index.toString(), ...verdict });
    if (verdict.class === "valid" && c.position === "after") throw new EvidenceRefusal("superseded-selection");
  }
  let clock = null;
  if (duration !== undefined) {
    // The gap at the judging index t: c(t) is the last valid carrying checkpoint strictly before t.
    const t = ranges.judgingIndex, snapshotIndex = latestValid < t ? latestValid : closing;
    if (t - snapshotIndex > duration && boundary === undefined && t > opening) boundary = later(snapshotIndex + duration + 1n, opening + 1n);
    clock = clockRecord(t, snapshotIndex, boundary);
  }
  return { carrying, state, clock };
}

/** C2.10.3–7 for a single backing. Its canonical
 * ancestry is linear: each new segment imports the last valid checkpoint's
 * closure once. Every checkpoint is classified at its own prefix, and every
 * continuation replays from its segment's fixed opening base. No union of
 * raw trails, recursion, or replica-provided finality is involved. */
async function classifyImports(context, directories, record, evidence) {
  const { selection, terms, codec } = context;
  const view = await readRecordView(selection, terms, directories, record, codec);
  const { chain, heldBy, termEnd, carries, revokedAt, t, lag } = view;
  const duration = terms.silence?.noCommitmentDuration;
  let publications = duration === undefined ? [] : context.receiptBytes === undefined ?
    (await view.ask(4, selection.backing)).entries : undefined;
  const selectedHeld = (await heldBy(selection.operator)).find(h => h.commitment.sequence === selection.sequence && same(h.commitment.root, selection.root));
  if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
  if (!same(codec.linkInForce(chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  const trails = decodedTrails(evidence.trails, codec), segments = new Map(), clocks = new Map(), carrying = [];
  const walk = context.receiptBytes === undefined ? undefined :
    await receiptWalk(context.receiptBytes, context, view, trails, evidence.snapshots);
  context.receiptWalk = walk;
  context.contextReceipt = walk?.receipt;
  const matches = (a, b) => a !== undefined && b !== undefined && a.sequence === b.sequence && same(a.operator, b.operator) && same(a.root, b.root);
  let canonical, selectedState, selectedClock, checkpoints = 0n, events = 0n, heldBefore = 0, heldAfter = 0;
  let publicationAt = 0;
  const force = [], publicationVerdicts = [];
  const charge = () => { if (++events > IMPORT_LIMITS.maxEvents) throw new EvidenceRefusal("resource-refusal"); };
  // At one index the whole publication group is read BEFORE any checkpoint.
  // Effects change recovery state but never extend the snapshot's forest.
  const publishThrough = async through => {
    // Receipt inclusion before any gap needs no later publication evidence.
    if (publications === undefined) {
      if (canonical === undefined || through - canonical.index <= duration) return;
      publications = (await view.ask(4, selection.backing)).entries;
    }
    while (publicationAt < publications.length && publications[publicationAt].index <= through) {
      const entry = publications[publicationAt++], item = { index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
      publicationVerdicts.push(item); charge();
      let publication;
      try { publication = codec.decodePublication(entry.record); }
      catch (error) {
        if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) continue;
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
        applyRecovery(record, state, codec);
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
        checkRecovery(record, state, { codec, check: requireReplay, backing: selection.backing, issuer: terms.obligor,
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
      if (++checkpoints > IMPORT_LIMITS.maxCheckpoints) throw new EvidenceRefusal("resource-refusal");
      const c = held.commitment, selected = matches(c, selection);
      if (!selected) { if (selectedState === undefined) heldBefore++; else heldAfter++; }
      const entry = carries(held);
      if (entry === undefined) { walk?.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      if (directories.get(hex(c.root)).length !== 1) throw new EvidenceRefusal("unsupported-scope");
      const bytes = evidence.snapshots.find(x => same(sha256(x), entry.digest));
      if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const snapshot = codec.decodeSnapshot(bytes);
      const matching = trails.filter(tr => codec.verifyTrailEvidence({ backing: selection.backing, segment: snapshot.segment, digest: entry.digest }, snapshot, tr, LIMITS));
      if (matching.length !== 1) throw new EvidenceRefusal(matching.length === 0 ? "unresolved-evidence" : "unsupported-scope");
      const trail = matching[0], header = codec.decodeSegmentHeader(trail.header);
      if (header.entries.length !== 1) throw new EvidenceRefusal("unsupported-scope");
      const scoped = header.entries[0], signed = trail.terms[0];
      if (!same(codec.rootTermsName(signed.terms), selection.backing) || !codec.verifyRootTermsSignature(signed.terms, signed.signature)) {
        throw new EvidenceRefusal("unresolved-evidence");
      }
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
          // C2b.4.1's return imports the strictly-before snapshot. Generic
          // same-index elective openings have broader C2.10.4 ranks; this
          // bounded silence path does not decide that distinction, including
          // whether a claimed earlier import is a conflict.
          if (duration !== undefined && canonical?.index === held.index) throw new EvidenceRefusal("unsupported-scope");
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
        if (c.sequence === header.sequence) requireReplay(trail.records.length === 0, "OPENING");
        events += BigInt(trail.records.length);
        if (events > IMPORT_LIMITS.maxEvents) throw new EvidenceRefusal("resource-refusal");
        const state = await replayTrail({ ...context, header }, snapshot, trail,
          { index: held.index, revokedAt, lastValid: segment.lastValid, imported: segment.imported,
            block: c.sequence === header.sequence ? [] : segment.block, openingIndex: segment.openingIndex, isOpening: c.sequence === header.sequence });
        segment.lastValid = { position: state.position, historyHash: snapshot.historyHash, evidenceHash: snapshot.evidenceHash, eventIndices: state.eventIndices };
        canonical = { commitment: c, index: held.index, segment: snapshot.segment, scope: new ScopeTree(header.entries).root(), state };
        latestValid = held.index;
        carrying.push({ ...item, class: "valid" });
        const verdict = walk?.checkpoint(held, snapshot.segment, state, header, "valid");
        if (verdict !== undefined) return { receipt: verdict };
        if (selectedState !== undefined && !walk) throw new EvidenceRefusal("superseded-selection");
        if (selected) { selectedState = state; selectedClock = clock; }
      } catch (error) {
        if (!(error instanceof ReplayRefusal) || (selected && !walk)) throw error;
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
  return { state: selectedState, carrying, clock,
    ranges: { judgingIndex: t, lag, checkpointIndex: selectedHeld.index, revokedAt, heldBefore, heldAfter, chain, publications: publicationVerdicts } };
}

/** verifier.configuration is independently selected and its six keys checked
 * by the harness. Issuer identity comes from signed scoped terms (§11).
 * With a fixture venue and verifier.record, §13 ranges fix the chain, the
 * checkpoint's record prefix and currency against that fixture only, and
 * every carrying checkpoint of the segment is classified from its own trail.
 * No approved configuration or authenticated-chain finality verdict.
 * State reads expose nothing until every terminal assertion passes. A single
 * receipt instead returns its conditional verdict at the deciding checkpoint
 * or boundary; an unavailable suffix retains already proven liability facts. */
export async function replayLocalPackage(input, verifier, codec) {
  let context;
  const failure = (status, check = null) => ({ ...refused(status, check),
    ...(context?.receiptWalk === undefined ? {} : { receiptEvidence: context.receiptWalk.evidence() }) });
  try {
    if (input === null || typeof input !== "object") throw new EncodingError("invalid replay input");
    const fields = Object.keys(input).sort().join(",");
    // The chosen synchronous record factory must own venue evidence before
    // returning, under its own byte/work
    // limits before any await. Cloning it here would allocate unbounded raw
    // blocks (or unused backing buffers) before the adapter can check them.
    const { venue, ...source } = input;
    const owned = ownInputs(source);
    const { selection, package: supplied, seed } = owned;
    // Do not silently keep the retired issuer override as an alternate input.
    requireReplay(INPUT_SHAPES.includes(fields), "INPUT_FIELDS");
    requireReplay(codec.verifyConfiguration(supplied?.configuration, verifier.configuration), "CONFIGURATION");
    const domain = codec.configurationHash(codec.decodeConfiguration(supplied.configuration));
    requireReplay(selection?.domain instanceof Uint8Array && same(domain, selection.domain), "CONFIGURATION");
    const { snapshot, trail, header } = readLocalEvidence(selection, supplied, codec, { allowImports: venue !== undefined });
    const signed = trail.terms[0], terms = codec.decodeRootTerms(signed.terms);
    requireReplay(codec.verifyRootTermsSignature(signed.terms, signed.signature), "TERMS_SIGNATURE");
    requireReplay(same(codec.rootTermsName(signed.terms), header.entries[0].backing), "TERMS_NAME");
    requireReplay(same(terms.configuration, domain) && same(terms.venue, header.venue), "TERMS_CONTEXT");
    // Empty-opening selections retain the original-operator scope. Imports
    // instead require the term-by-term record walk below.
    const imports = header.entries[0].opening !== undefined;
    if (!imports) requireReplay(same(terms.operator, header.operator) && same(header.entries[0].link, selection.backing), "TERMS_INITIAL_SCOPE");
    context = { selection, terms, header, verifier, codec, receiptBytes: supplied.receipt };
    if (supplied.receipt !== undefined && (seed !== undefined || venue === undefined)) throw new EvidenceRefusal("unsupported-scope");
    let ranges = null, carrying = null, clock = null, state, rangeEvidence = "none";
    if (venue !== undefined) {
      if (typeof verifier.record !== "function") throw new EvidenceRefusal("unresolved-evidence");
      const record = verifier.record(venue);
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
      if (imports || supplied.receipt !== undefined) {
        const result = await classifyImports(context, directories, record, { snapshots, trails });
        if (result.receipt !== undefined) return { ...refused("receipt-status"), receipt: result.receipt, rangeEvidence,
          candidateConfigurationChecked: true, signedTermsAuthenticated: true, termsAuthorityAuthenticated: true,
          currentRangeAuthenticated: selection.mode !== "historical-fixture" };
        ({ carrying, state, clock, ranges } = result);
      } else {
        ranges = await readRecordRanges(selection, terms, header, directories, record, codec);
        ({ carrying, state, clock } = await classifyCarrying(context, ranges, { snapshot, trail, snapshots, trails }));
      }
    } else {
      // A silence clause needs the clock (C2b.6.1), which is read from the record ranges alone.
      if (terms.silence !== undefined) throw new EvidenceRefusal("unsupported-scope");
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
        requireReplay(same(note.opening.backing, selection.backing), "BACKING");
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
      ...flags, candidateConfigurationChecked: true, signedTermsAuthenticated: true,
      ...(ranges === null ? {} : { currentRangeAuthenticated: !historical, termsAuthorityAuthenticated: true, rangeEvidence }),
      audit: { records: position.toString(), issued: issued.toString(), burned: burned.toString(),
        outstanding: (issued - burned).toString(), noteRoot: tree.root().toString(), spentRoot: hex(spent.root()),
        historyHash: hex(history), evidenceHash: hex(snapshot.evidenceHash),
        range: ranges === null ? null : { judgingIndex: ranges.judgingIndex.toString(), lag: ranges.lag.toString(), checkpointIndex: ranges.checkpointIndex.toString(),
          revokedAt: ranges.revokedAt === undefined ? null : ranges.revokedAt.toString(),
          heldBefore: ranges.heldBefore, heldAfter: ranges.heldAfter,
          chain: ranges.chain.map(link => ({ operator: hex(link.operator), from: link.from.toString(), link: hex(link.link) })),
          carrying, clock, ...(ranges.publications === undefined ? {} : { publications: ranges.publications }) } }, candidates };
  } catch (error) {
    if (error instanceof ReplayRefusal) return failure("invalid-local-replay", error.check);
    // A lapsed selection carries the clock record proving the lapse (C2b.4.1) beside the refusal.
    if (error instanceof EvidenceRefusal) return { ...failure(error.status), ...(error.clock === undefined ? {} : { clock: error.clock }) };
    if (error instanceof codec.TrailLimitError || error instanceof codec.RangeLimitError) return failure("resource-refusal");
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError ||
      error instanceof CapsuleFormatError || error instanceof CapsuleAssociationError) return failure("unresolved-evidence");
    throw error;
  }
}

/** Portable §12 boundary for the bounded local experiment. Select exactly one
 * configuration and commitment; the selection's snapshot is the one its
 * directory names for the backing and its trail the one that authenticates
 * it (§10.1), both by hash, so no first-match lookup can silently discard
 * conflicting evidence. Every other directory, snapshot and trail is a
 * dependency the §13 range/import read may need. One kind-10 receipt selects
 * a receipt query; fault/range witnesses and other kinds require a later reader.
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
    if (items.some(item => ![...kinds, 10].includes(item.kind)) || [1, 2, 10].some(kind => items.filter(item => item.kind === kind).length > 1)) {
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
    const trailBytes = payloads(6).filter(payload => decodedTrails([payload], codec).some(t => codec.verifyTrailEvidence(expected, snapshot, t, LIMITS)));
    if (trailBytes.length !== 1) return refused(trailBytes.length === 0 ? "unresolved-evidence" : "unsupported-scope");
    const others = directories.filter(entries => entries !== directory);
    const snapshots = payloads(4).filter(payload => payload !== snapshotBytes), trails = payloads(6).filter(payload => payload !== trailBytes[0]);
    if (others.length + snapshots.length + trails.length > 0 && input.venue === undefined) return refused("unsupported-scope");
    return await replayLocalPackage({ ...owned, package: { configuration: payloads(1)[0], commitment: payloads(2)[0],
      directory, directories: others, snapshot: snapshotBytes, snapshots, trail: trailBytes[0], trails,
      ...(payloads(10).length === 0 ? {} : { receipt: payloads(10)[0] }) } }, verifier, codec);
  } catch (error) {
    if (error instanceof ReplayRefusal) return refused("invalid-local-replay", error.check);
    if (error instanceof codec.PackageLimitError || error instanceof codec.TrailLimitError) return refused("resource-refusal");
    if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) return refused("unresolved-evidence");
    throw error;
  }
}
