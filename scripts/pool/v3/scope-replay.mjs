// Conditional C2.10.3–7 finalized scope replay. No recovery/adoption support.
import { createHash } from "node:crypto";
import { compareBytes } from "../../../dist/bytes.js";
import { identifierOf, VALUE_BOUND } from "../../../dist/pool/field.js";
import { EMPTY_NOTE_ROOT } from "../../../dist/pool/note-tree.js";
import { EvidenceRefusal, LIMITS } from "../delivery/evidence-reader.mjs";
import { effectOf } from "./recovery-state.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => compareBytes(a, b) === 0;
const hash = bytes => hex(createHash("sha256").update(bytes).digest());
const keyOf = c => `${hex(c.operator)}:${c.sequence}:${hex(c.root)}`;
const matches = (a, b) => a !== undefined && b !== undefined && keyOf(a) === keyOf(b);
const before = (held, child) => child === undefined || held.index < child.index ||
  (held.index === child.index && same(held.commitment.operator, child.commitment.operator) &&
    held.commitment.sequence < child.commitment.sequence);

// Imported roots retain their original trees. Repeated events agree by
// statement identity, while distinct events may never share effects.
export function mergeFinalizedPrefixes(parents, { check, chargeEvents }) {
  const result = { events: new Map(), totals: new Map(), nullifiers: new Set(), outputsSeen: new Set(),
    anchors: new Set([EMPTY_NOTE_ROOT]), scanOutputs: [], outputPositions: new Map(),
    demands: new Map(), effective: new Set(), spentTags: new Set() };
  const scans = new Map();
  for (const parent of new Set(parents)) {
    if (parent === undefined) continue;
    for (const [id, event] of parent.state.events) {
      chargeEvents(1n);
      const prior = result.events.get(id);
      if (prior !== undefined) { check(prior.identity === event.identity, "CONTINUITY"); continue; }
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
    if (terms.silence !== undefined || terms.nonService !== undefined) throw new EvidenceRefusal("unsupported-scope");
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
    const cacheKey = `${hex(backing)}:${child === undefined ? "current" : keyOf(child.commitment)}`;
    if (latestCache.has(cacheKey)) return latestCache.get(cacheKey);
    const pending = (async () => {
      const view = await viewFor(backing, terms);
      for (let i = view.chain.length - 1; i >= 0; i--) {
        const term = view.chain[i];
        if (child !== undefined && (term.from > child.index ||
            (term.from === child.index && !same(term.operator, child.commitment.operator)))) continue;
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
      const matching = trails.filter(trail => codec.verifyTrailEvidence({ backing, segment: snapshot.segment,
        digest: entry.digest }, snapshot, trail, LIMITS));
      if (matching.length !== 1) throw new EvidenceRefusal(matching.length === 0 ? "unresolved-evidence" : "unsupported-scope");
      const trail = matching[0], header = codec.decodeSegmentHeader(trail.header), scopedTerms = new Map(), scopeViews = new Map();
      // Required scope is discovered only after its header is authenticated.
      for (let i = 0; i < header.entries.length; i++) {
        const scoped = header.entries[i], signed = trail.terms[i];
        if (signed === undefined || !same(codec.rootTermsName(signed.terms), scoped.backing) ||
            !codec.verifyRootTermsSignature(signed.terms, signed.signature)) throw new EvidenceRefusal("unresolved-evidence");
        const terms = codec.decodeRootTerms(signed.terms);
        if (terms.silence !== undefined || terms.nonService !== undefined) throw new EvidenceRefusal("unsupported-scope");
        scopedTerms.set(hex(scoped.backing), terms);
      }
      for (const bytes of trail.records) if (codec.decodeRecord(bytes).kind >= 4) throw new EvidenceRefusal("unsupported-scope");
      const base = { commitment: c, index: held.index, segment: snapshot.segment, header, snapshot };
      try {
        check(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
          same(header.operator, c.operator) && header.sequence <= c.sequence, "CONTEXT");
        check(directory.length === header.entries.length && header.entries.every(scoped =>
          directory.some(item => same(item.name, scoped.backing))), "SCOPE");
        let lapsed = false;
        for (const scoped of header.entries) {
          const terms = scopedTerms.get(hex(scoped.backing));
          check(same(terms.configuration, selection.domain) && same(terms.venue, selection.venue), "TERMS_CONTEXT");
          const view = await viewFor(scoped.backing, terms); scopeViews.set(hex(scoped.backing), view);
          const own = view.chain.find(term => same(term.link, scoped.link));
          check(own !== undefined && same(own.operator, c.operator), "TERMS_SCOPE");
          const current = codec.linkInForce(view.chain, held.index);
          if (own.from < current.from) lapsed = true;
          else check(same(own.link, current.link), "TERMS_SCOPE");
        }
        if (lapsed) return { ...base, class: "lapsed" };
        const scopedSnapshots = header.entries.map(scoped => {
          const s = snapshotFor(directory.find(item => same(item.name, scoped.backing)).digest);
          check(same(s.backing, scoped.backing) && same(s.segment, snapshot.segment) &&
            same(s.historyHash, snapshot.historyHash) && same(s.evidenceHash, snapshot.evidenceHash), "SNAPSHOT");
          return s;
        });
        const parents = [];
        for (const scoped of header.entries) parents.push(await latest(scoped.backing, scopedTerms.get(hex(scoped.backing)), held));
        let imported, lastValid;
        const opening = c.sequence === header.sequence;
        if (opening) {
          check(trail.records.length === 0, "OPENING");
          for (let i = 0; i < header.entries.length; i++) {
            const scoped = header.entries[i], parent = parents[i];
            check(parent === undefined ? scoped.opening === undefined : matches(scoped.opening, parent.commitment), "IMPORT");
            if (parent !== undefined && !same(parent.commitment.operator, c.operator)) {
              const view = scopeViews.get(hex(scoped.backing));
              check(parent.index < codec.linkInForce(view.chain, held.index).from, "IMPORT_RANK");
            }
          }
          imported = mergeFinalizedPrefixes(parents, { check, chargeEvents });
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
          check(parents.every(parent => parent !== undefined && same(parent.segment, snapshot.segment) &&
            matches(parent.commitment, parents[0].commitment)), "CONTINUITY");
          imported = opened.state;
          const previous = parents[0];
          lastValid = { position: previous.state.position, historyHash: previous.snapshot.historyHash,
            evidenceHash: previous.snapshot.evidenceHash, eventIndices: previous.state.eventIndices };
        }
        chargeEvents(BigInt(trail.records.length));
        const selectedTerms = scopedTerms.get(hex(backing)), revocations = new Map([...scopeViews].map(([name, view]) => [name, view.revokedAt]));
        const state = await replayTrail({ ...context, selection: { ...selection, backing }, terms: selectedTerms, header, scopedTerms },
          snapshot, trail, { index: held.index, revocations, lastValid, imported, isOpening: opening });
        for (const s of scopedSnapshots) {
          const total = state.totals.get(hex(s.backing)) ?? { issued: 0n, burned: 0n };
          check(s.issued === total.issued && s.burned === total.burned, "SNAPSHOT");
        }
        return { ...base, state, class: "valid" };
      } catch (error) {
        if (!(error instanceof ReplayRefusal)) throw error;
        return { ...base, class: "excluded", check: error.check };
      }
    })();
    verified.set(id, pending);
    return pending;
  };
  const view = await viewFor(selection.backing, context.terms);
  const selectedHeld = (await view.heldBy(selection.operator)).find(held => matches(held.commitment, selection));
  if (selectedHeld === undefined) throw new EvidenceRefusal("selection-mismatch");
  if (!same(codec.linkInForce(view.chain, selectedHeld.index).operator, selection.operator)) throw new EvidenceRefusal("lapsed-selection");
  const selected = await classify(selectedHeld, selection.backing);
  if (selected.class === "lapsed") throw new EvidenceRefusal("lapsed-selection");
  check(selected.class === "valid", selected.check);
  const current = await latest(selection.backing, context.terms);
  if (!matches(current?.commitment, selection)) throw new EvidenceRefusal("superseded-selection");
  const results = await Promise.all(verified.values());
  const carrying = results.sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 :
    a.commitment.sequence < b.commitment.sequence ? -1 : a.commitment.sequence > b.commitment.sequence ? 1 : 0)
    .map(item => ({ operator: hex(item.commitment.operator), sequence: item.commitment.sequence.toString(), index: item.index.toString(),
      class: item.class, ...(item.check === undefined ? {} : { check: item.check }) }));
  return { state: selected.state, carrying, clock: null, ranges: { judgingIndex: view.t, lag: view.lag,
    checkpointIndex: selectedHeld.index, revokedAt: view.revokedAt, chain: view.chain,
    heldBefore: results.filter(item => before(item, selectedHeld)).length,
    heldAfter: results.filter(item => before(selectedHeld, item)).length } };
}
