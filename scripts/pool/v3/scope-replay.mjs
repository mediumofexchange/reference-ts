// Conditional C2.10.3–7 / C2b.4 finalized scope replay. Not runtime support.
import { createHash } from "node:crypto";
import { compareBytes } from "../../../dist/bytes.js";
import { identifierOf, VALUE_BOUND } from "../../../dist/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../../../dist/pool/note-tree.js";
import { EvidenceRefusal } from "../delivery/evidence-reader.mjs";
import { effectOf, applyRecovery } from "./recovery-state.mjs";
import { scopeRecovery, venueOrder } from "./scope-recovery.mjs";
import { receiptWalk } from "./receipt-state.mjs";
import { countNonService } from "./non-service.mjs";
import { authenticatedScope, checkpointScope } from "./scope-evidence.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => hex(createHash("sha256").update(bytes).digest());
const keyOf = c => `${hex(c.operator)}:${c.sequence}:${hex(c.root)}`;
const matches = (a, b) => a !== undefined && b !== undefined && keyOf(a) === keyOf(b);
const before = (held, child) => child === undefined || held.index < child.index ||
  (held.index === child.index && !child.strict && same(held.commitment.operator, child.commitment.operator) &&
    held.commitment.sequence < child.commitment.sequence);

// Imported roots retain their original trees. Repeated events agree by
// statement identity, while distinct events may never share effects.
export function mergeFinalizedPrefixes(parents, { check, chargeEvents, codec }) {
  const result = { events: new Map(), totals: new Map(), nullifiers: new Set(), outputsSeen: new Set(),
    anchors: new Set([EMPTY_NOTE_ROOT]), scanOutputs: [], outputPositions: new Map(),
    demands: new Map(), effective: new Set(), spentTags: new Set(), adoptionIndices: new Map() };
  const scans = new Map(), touched = new Map();
  const precedes = (a, b) => a.segment !== undefined && b.segment !== undefined &&
    (a.segment === b.segment ? a.position < b.position : (b.ancestry?.get(a.segment) ?? 0n) >= a.position);
  for (const parent of new Set(parents)) {
    if (parent === undefined) continue;
    for (const [id, event] of parent.state.events) {
      chargeEvents(1n);
      const prior = result.events.get(id);
      if (prior !== undefined) { check(prior.identity === event.identity, "CONTINUITY"); continue; }
      for (const key of [...(event.tags ?? []).map(tag => `tag:${tag}`), ...(event.demand === undefined ? [] : [`demand:${event.demand}`])]) {
        const previous = touched.get(key) ?? [];
        for (const other of previous) { chargeEvents(1n); check(precedes(other, event) || precedes(event, other), "RECOVERY_CONFLICT"); }
        previous.push(event); touched.set(key, previous);
      }
      const { nfs, outputs } = effectOf(event.record);
      check(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !result.nullifiers.has(nf)), "SPENT");
      check(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !result.outputsSeen.has(cm)), "OUTPUT");
      nfs.forEach(nf => result.nullifiers.add(nf)); outputs.forEach(cm => result.outputsSeen.add(cm));
      const { kind, publicInputs: p } = event.record;
      if (kind === 1 || kind === 3) {
        const backing = hex(identifierOf(p[5], p[6])), total = result.totals.get(backing) ?? { issued: 0n, burned: 0n };
        if (kind === 1) total.issued += p[7]; else total.burned += p[7];
        result.totals.set(backing, total);
      }
      result.events.set(id, event);
      if (codec !== undefined) {
        if (event.record.kind >= 4) check(!result.effective.has(event.identity), "REPEATED_STATEMENT");
        applyRecovery(event.record, result, codec);
      }
    }
    for (const root of parent.state.anchors) result.anchors.add(root);
    for (const output of parent.state.scanOutputs) if (!scans.has(output.cm)) scans.set(output.cm, output);
    for (const [cm, path] of parent.state.outputPositions) {
      const previous = result.outputPositions.get(cm);
      if (previous === undefined || path.tree.size > previous.tree.size) result.outputPositions.set(cm, path);
    }
  }
  for (const total of result.totals.values()) check(total.burned <= total.issued && total.issued < VALUE_BOUND, "SUPPLY");
  result.scanOutputs = [...scans.values()];
  return result;
}

export async function classifyScopes(context, directories, record, evidence, helpers) {
  const { selection, codec } = context;
  const { readRecordView, decodedTrails, replayTrail, requireReplay: check, ReplayRefusal, IMPORT_LIMITS } = helpers;
  const trails = decodedTrails(evidence.trails, codec), snapshots = new Map(evidence.snapshots.map(bytes => [hash(bytes), bytes]));
  const views = new Map(), verified = new Map(), heldSeen = new Set(), latestCache = new Map();
  let eventWork = 0n;
  const chargeEvents = amount => {
    eventWork += amount;
    if (eventWork > IMPORT_LIMITS.maxEvents) throw new EvidenceRefusal("resource-refusal");
  };
  const inspect = held => {
    heldSeen.add(keyOf(held.commitment));
    if (BigInt(heldSeen.size) > IMPORT_LIMITS.maxCheckpoints) throw new EvidenceRefusal("resource-refusal");
  };
  const viewFor = async (backing, terms) => {
    const id = hex(backing);
    if (!views.has(id)) views.set(id, readRecordView({ ...selection, backing }, terms, directories, record, codec));
    return views.get(id);
  };
  const snapshotFor = digest => {
    const bytes = snapshots.get(hex(digest));
    if (bytes === undefined) throw new EvidenceRefusal("unresolved-evidence");
    return codec.decodeSnapshot(bytes);
  };
  // Descend authenticated carriage in reverse rank order. A valid candidate
  // recursively resolves its own predecessors; unrelated old trails are not read.
  const latest = async (backing, terms, child) => {
    const cacheKey = `${hex(backing)}:${child === undefined ? "current" : child.strict ? `before:${child.index}` : keyOf(child.commitment)}`;
    if (latestCache.has(cacheKey)) return latestCache.get(cacheKey);
    const pending = (async () => {
      const view = await viewFor(backing, terms);
      for (let i = view.chain.length - 1; i >= 0; i--) {
        const term = view.chain[i];
        if (child !== undefined && (term.from > child.index ||
            (term.from === child.index && (child.strict || !same(term.operator, child.commitment.operator))))) continue;
        const held = await view.heldBy(term.operator);
        for (let j = held.length - 1; j >= 0; j--) {
          const candidate = held[j];
          inspect(candidate);
          if (candidate.index < term.from || candidate.index > view.termEnd(i) || !before(candidate, child)) continue;
          if (view.carries(candidate) === undefined) continue;
          const result = await classify(candidate, backing);
          if (result.class === "valid") return result;
        }
      }
      return undefined;
    })();
    latestCache.set(cacheKey, pending);
    return pending;
  };
  const recovery = scopeRecovery({ context, viewFor, latest, check, charge: chargeEvents, ReplayRefusal });
  const classify = async (held, backing) => {
    const id = keyOf(held.commitment);
    if (verified.has(id)) return verified.get(id);
    const pending = (async () => {
      inspect(held);
      const c = held.commitment, directory = directories.get(hex(c.root));
      if (directory === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const entry = directory.find(item => same(item.name, backing));
      if (entry === undefined) throw new EvidenceRefusal("unresolved-evidence");
      const snapshot = snapshotFor(entry.digest);
      const scope = checkpointScope(trails, backing, entry.digest, snapshot, codec), { header } = scope;
      await context.faults.inspect(held, directory, scope);
      const scopedTerms = new Map(), scopeViews = new Map();
      // Required scope is discovered only after its header is authenticated.
      for (let i = 0; i < header.entries.length; i++) {
        const scoped = header.entries[i], signed = scope.terms[i];
        if (signed === undefined || !same(codec.rootTermsName(signed.terms), scoped.backing) ||
            !codec.verifyRootTermsSignature(signed.terms, signed.signature)) throw new EvidenceRefusal("unresolved-evidence");
        const terms = codec.decodeRootTerms(signed.terms);
        scopedTerms.set(hex(scoped.backing), terms);
      }
      const base = { commitment: c, index: held.index, segment: snapshot.segment, header, snapshot };
      try {
        check(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
          same(header.operator, c.operator) && header.sequence <= c.sequence, "CONTEXT");
        let lapsed = false, termsInForce = true;
        for (const scoped of header.entries) {
          const terms = scopedTerms.get(hex(scoped.backing));
          check(same(terms.configuration, selection.domain) && same(terms.venue, selection.venue), "TERMS_CONTEXT");
          const view = await viewFor(scoped.backing, terms); scopeViews.set(hex(scoped.backing), view);
          const own = view.chain.find(term => same(term.link, scoped.link));
          const current = codec.linkInForce(view.chain, held.index);
          if (own !== undefined && same(own.operator, c.operator) && own.from < current.from) lapsed = true;
          if (own === undefined || !same(own.operator, c.operator) || !same(own.link, current.link)) termsInForce = false;
        }
        if (lapsed) return { ...base, class: "lapsed" };
        check(termsInForce, "TERMS_SCOPE");
        const durations = [...scopedTerms.values()].map(terms => terms.silence?.noCommitmentDuration);
        check(durations.every(duration => duration === durations[0]), "SILENCE_SCOPE");
        const parents = [];
        for (const scoped of header.entries) parents.push(await latest(scoped.backing, scopedTerms.get(hex(scoped.backing)), held));
        let imported, lastValid, block = [], openingIndex;
        const opening = c.sequence === header.sequence;
        if (opening) {
          check(scope.fullTrail().records.length === 0, "OPENING");
          for (let i = 0; i < header.entries.length; i++) {
            const scoped = header.entries[i], parent = parents[i];
            check(parent === undefined ? scoped.opening === undefined : matches(scoped.opening, parent.commitment), "IMPORT");
            if (parent !== undefined && !same(parent.commitment.operator, c.operator)) {
              const view = scopeViews.get(hex(scoped.backing));
              check(parent.index < codec.linkInForce(view.chain, held.index).from, "IMPORT_RANK");
            }
          }
          imported = mergeFinalizedPrefixes(parents, { check, chargeEvents, codec });
          for (let i = 0; i < header.entries.length; i++) {
            const scoped = header.entries[i], name = hex(scoped.backing);
            imported.adoptionIndices.set(name, parents[i]?.state.adoptionIndices.get(name) ?? 0n);
            const published = await recovery.forces(scoped.backing, scopedTerms.get(name), held.index);
            block.push(...published.force.filter(event => event.index > imported.adoptionIndices.get(name)));
          }
          block.sort(venueOrder); openingIndex = held.index;
        } else {
          const firstView = scopeViews.values().next().value;
          const openingHeld = (await firstView.heldBy(c.operator)).find(item => item.commitment.sequence === header.sequence);
          if (openingHeld === undefined) throw new EvidenceRefusal("unresolved-evidence");
          check(before(openingHeld, held), "IMPORT_RANK");
          const openingDirectory = directories.get(hex(openingHeld.commitment.root));
          if (openingDirectory === undefined) throw new EvidenceRefusal("unresolved-evidence");
          check(openingDirectory.some(item => same(item.name, backing)), "OPENING");
          const opened = await classify(openingHeld, backing);
          check(opened.class === "valid" && same(opened.segment, snapshot.segment), "OPENING");
          for (const scoped of header.entries) {
            const clock = await recovery.clock(scoped.backing, scopedTerms.get(hex(scoped.backing)), opened.index, held.index);
            if (clock !== null && (clock.open || (clock.boundary !== undefined && clock.boundary < held.index))) return { ...base, class: "lapsed" };
          }
          check(parents.every(parent => parent !== undefined && same(parent.segment, snapshot.segment) &&
            matches(parent.commitment, parents[0].commitment)), "CONTINUITY");
          imported = opened.state;
          block = opened.block; openingIndex = opened.index;
          const previous = parents[0];
          lastValid = { position: previous.state.position, historyHash: previous.snapshot.historyHash,
            evidenceHash: previous.snapshot.evidenceHash, eventIndices: previous.state.eventIndices };
        }
        // One carried snapshot authenticates the full scope for lapse even
        // when this directory omits a sibling. Complete carriage and matching
        // sibling snapshots are finalization conditions, checked after lapse.
        check(directory.length === header.entries.length && header.entries.every(scoped =>
          directory.some(item => same(item.name, scoped.backing))), "SCOPE");
        const scopedSnapshots = header.entries.map(scoped => {
          const s = snapshotFor(directory.find(item => same(item.name, scoped.backing)).digest);
          check(same(s.backing, scoped.backing) && same(s.segment, snapshot.segment) &&
            same(s.historyHash, snapshot.historyHash) && same(s.evidenceHash, snapshot.evidenceHash), "SNAPSHOT");
          return s;
        });
        const trail = scope.fullTrail();
        chargeEvents(BigInt(trail.records.length));
        const selectedTerms = scopedTerms.get(hex(backing)), revocations = new Map([...scopeViews].map(([name, view]) => [name, view.revokedAt]));
        const state = await replayTrail({ ...context, selection: { ...selection, backing }, terms: selectedTerms, header, scopedTerms },
          snapshot, trail, { index: held.index, revocations, lastValid, imported, isOpening: opening,
            block: opening ? [] : block, openingIndex, chargeEvents });
        for (const s of scopedSnapshots) {
          const total = state.totals.get(hex(s.backing)) ?? { issued: 0n, burned: 0n };
          check(s.issued === total.issued && s.burned === total.burned, "SNAPSHOT");
        }
        return { ...base, state, block, scopedTerms, openingIndex, class: "valid" };
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        scope.fullTrail(); // Header-only faults are not exclusion certificates.
        return { ...base, class: "excluded", check: error.check };
      }
    })();
    verified.set(id, pending);
    return pending;
  };
  const view = await viewFor(selection.backing, context.terms);
  const selectedHeld = (await view.heldBy(selection.operator)).find(held => matches(held.commitment, selection));
  if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
  if (context.receiptBytes !== undefined) {
    const receipt = codec.decodeReceipt(context.receiptBytes);
    const original = authenticatedScope(trails, receipt.segment, codec);
    const { header } = original, scopeViews = new Map(), termsByBacking = new Map();
    for (let i = 0; i < header.entries.length; i++) {
      const scoped = header.entries[i], signed = original.terms[i];
      if (signed === undefined || !same(codec.rootTermsName(signed.terms), scoped.backing) ||
          !codec.verifyRootTermsSignature(signed.terms, signed.signature)) throw new EvidenceRefusal("unresolved-evidence");
      const terms = codec.decodeRootTerms(signed.terms);
      if (!same(terms.configuration, selection.domain) || !same(terms.venue, selection.venue)) throw new EvidenceRefusal("invalid-receipt");
      termsByBacking.set(hex(scoped.backing), terms);
      scopeViews.set(hex(scoped.backing), await viewFor(scoped.backing, terms));
    }
    const walk = await receiptWalk(context.receiptBytes, context, view, trails, evidence.snapshots, scopeViews);
    // A fallback can already have established contradictions. Keep these facts
    // if a newly required complete-scope dependency refuses the repeated walk.
    const prior = context.receiptWalk;
    context.receiptWalk = { evidence: () => {
      const facts = [...(prior?.evidence().contradictedAt ?? []), ...walk.evidence().contradictedAt];
      return { contradictedAt: facts.filter((fact, i) => facts.findIndex(other =>
        other.operator === fact.operator && other.sequence === fact.sequence) === i) };
    } };
    context.contextReceipt = walk.receipt;
    let openingIndex;
    const boundary = async at => {
      if (openingIndex === undefined) return;
      const through = walk.termBoundary !== undefined && walk.termBoundary < at ? walk.termBoundary : at;
      let earliest;
      for (const scoped of header.entries) {
        const clock = await recovery.clock(scoped.backing, termsByBacking.get(hex(scoped.backing)), openingIndex, through);
        if (clock?.boundary !== undefined && (earliest === undefined || clock.boundary < earliest)) earliest = clock.boundary;
      }
      return walk.boundary(at, { boundary: earliest });
    };
    for (const held of await view.heldBy(header.operator)) {
      if (held.commitment.sequence < header.sequence) continue;
      inspect(held);
      const ended = await boundary(held.index);
      if (ended !== undefined) return { receipt: ended };
      const scoped = header.entries.find(entry => scopeViews.get(hex(entry.backing)).carries(held) !== undefined);
      if (scoped === undefined) { walk.checkpoint(held, undefined, undefined, undefined, "other"); continue; }
      const result = await classify(held, scoped.backing);
      const verdict = walk.checkpoint(held, result.segment, result.state, result.header, result.class);
      if (result.class === "valid" && same(result.segment, receipt.segment) && held.commitment.sequence === header.sequence) openingIndex = held.index;
      if (verdict !== undefined) return { receipt: verdict };
    }
    return { receipt: await boundary(view.t) ?? walk.finish() };
  }
  if (!same(codec.linkInForce(view.chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  const selected = await classify(selectedHeld, selection.backing);
  if (selected.class === "lapsed") throw new EvidenceRefusal("lapsed-selection");
  check(selected.class === "valid", selected.check);
  const current = await latest(selection.backing, context.terms);
  if (!matches(current?.commitment, selection)) throw new EvidenceRefusal("superseded-selection");
  const publications = [], clocks = [];
  for (const scoped of selected.header.entries) {
    const terms = selected.scopedTerms.get(hex(scoped.backing));
    publications.push(...(await recovery.forces(scoped.backing, terms, selection.judgingIndex)).verdicts);
    clocks.push(await recovery.clock(scoped.backing, terms, selected.openingIndex, selection.judgingIndex));
  }
  const selectedClock = clocks[selected.header.entries.findIndex(entry => same(entry.backing, selection.backing))];
  if (selectedClock !== null) for (const scopedClock of clocks) {
    if (scopedClock.boundary !== undefined && (selectedClock.boundary === undefined || scopedClock.boundary < selectedClock.boundary)) selectedClock.boundary = scopedClock.boundary;
  }
  const clock = selectedClock === null ? null : Object.fromEntries(Object.entries(selectedClock).map(([key, value]) =>
    [key, typeof value === "bigint" ? value.toString() : value ?? null]));
  publications.sort((a, b) => venueOrder({ index: BigInt(a.index), ordinal: BigInt(a.ordinal) }, { index: BigInt(b.index), ordinal: BigInt(b.ordinal) }));
  // The audit may select a checkpoint at t; C2b.5.2 instead reads the whole
  // canonical scope strictly before t. Unadopted force never mutates it.
  const nonService = context.terms.nonService === undefined ? undefined : await countNonService(context, view,
    await latest(selection.backing, context.terms, { index: view.t, strict: true }),
    await recovery.publications(selection.backing, context.terms), () => chargeEvents(1n));
  const results = await Promise.all(verified.values());
  const carrying = results.sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 :
    a.commitment.sequence < b.commitment.sequence ? -1 : a.commitment.sequence > b.commitment.sequence ? 1 : 0)
    .map(item => ({ operator: hex(item.commitment.operator), sequence: item.commitment.sequence.toString(), index: item.index.toString(),
      class: item.class, ...(item.check === undefined ? {} : { check: item.check }) }));
  return { state: selected.state, carrying, clock, ranges: { judgingIndex: view.t, lag: view.lag,
    checkpointIndex: selectedHeld.index, revokedAt: view.revokedAt, chain: view.chain,
    heldBefore: results.filter(item => before(item, selectedHeld)).length,
    heldAfter: results.filter(item => before(selectedHeld, item)).length, publications,
    ...(nonService === undefined ? {} : { nonService }) } };
}
