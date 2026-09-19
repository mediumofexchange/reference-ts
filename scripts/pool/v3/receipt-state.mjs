// Conditional complete-scope receipt walk: C2.10.9a–c and C2b.4.3.
// Checkpoint validity and clock boundaries come only from local-replay.
import { createHash } from "node:crypto";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { EvidenceRefusal } from "../delivery/evidence-reader.mjs";

const same = (a, b) => Buffer.compare(a, b) === 0;
const hash = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");
const requireReceipt = condition => { if (!condition) throw new EvidenceRefusal("invalid-receipt"); };

export async function receiptWalk(bytes, context, view, trails, snapshots, scopeViews) {
  const { codec, selection } = context, receipt = codec.decodeReceipt(bytes);
  const trail = trails.find(tr => same(hash(tr.header), receipt.segment));
  if (trail === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = codec.decodeSegmentHeader(trail.header);
  if (header.entries.length !== 1 && scopeViews === undefined) throw new EvidenceRefusal("unsupported-scope");
  requireReceipt(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
    header.entries.some(scope => same(scope.backing, selection.backing)) && receipt.after >= header.sequence &&
    codec.verifyReceipt({ domain: selection.domain, segment: hash(trail.header),
      scopeRoot: new ScopeTree(header.entries).root(), operator: header.operator }, receipt));
  let termBoundary;
  for (const scope of header.entries) {
    const scopedView = scopeViews?.get(hex(scope.backing)) ?? view;
    const termIndex = scopedView.chain.findIndex(link => same(link.link, scope.link) && same(link.operator, header.operator));
    requireReceipt(termIndex >= 0);
    const end = scopedView.chain[termIndex + 1]?.from;
    if (end !== undefined && (termBoundary === undefined || end < termBoundary)) termBoundary = end;
  }
  const held = await view.heldBy(header.operator), reference = held.find(h => h.commitment.sequence === receipt.after);
  const movedPast = reference === undefined && held.some(h => h.commitment.sequence > receipt.after);
  // A held reference must belong to this segment, even after the boundary.
  // Its authenticated snapshot establishes that relation; no signing time is inferred.
  if (reference !== undefined) {
    const entry = view.carries(reference);
    requireReceipt(entry !== undefined);
    const snapshot = snapshots.find(s => same(hash(s), entry.digest));
    if (snapshot === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const decoded = codec.decodeSnapshot(snapshot);
    requireReceipt(same(decoded.segment, receipt.segment) && same(decoded.backing, selection.backing));
  }
  const contradictedAt = [];
  let opened = false, lastSegment = receipt.after, passedOver = 0n;
  const finish = (status, detail = {}) => ({ status, sequence: reference ? "held" : movedPast ? "moved-past" : "not-reached",
    includedAt: [], contradictedAt: [...contradictedAt], ...detail });
  const lapse = (kind, at) => finish(contradictedAt.length ? "contradicted" : "lapsed",
    contradictedAt.length ? {} : { lapse: { kind, ...(at === undefined ? {} : { at: at.toString() }) } });
  return {
    receipt, header, termBoundary,
    evidence: () => ({ contradictedAt: [...contradictedAt] }),
    boundary(at, clock) {
      if (!opened) return;
      const silence = clock?.boundary;
      const end = termBoundary === undefined ? silence : silence === undefined ? termBoundary :
        termBoundary < silence ? termBoundary : silence;
      if (end !== undefined && at >= end) return lapse(end === silence ? "silence" : "scope-boundary", end);
    },
    checkpoint(held, segment, state, checkpointHeader, classification) {
      const c = held.commitment, own = segment !== undefined && same(segment, receipt.segment);
      const fact = { operator: hex(c.operator), sequence: c.sequence.toString(), index: held.index.toString() };
      if (classification === "valid" && own) {
        if (c.sequence === header.sequence) opened = true;
        requireReceipt(opened);
        const event = state.receiptEvent;
        if (event !== undefined && codec.receiptMatchesEvent(receipt, event)) {
          return finish("final", { includedAt: [fact] });
        }
        if (c.sequence > receipt.after ? reference !== undefined : event !== undefined) contradictedAt.push(fact);
      }
      if (!same(c.operator, receipt.operator) || c.sequence <= receipt.after) return;
      if (own) { lastSegment = c.sequence; passedOver = 0n; return; }
      if (classification !== "valid" || segment === undefined) { passedOver++; return; }
      if (!opened) throw new EvidenceRefusal("unresolved-evidence");
      if (contradictedAt.length) return finish("contradicted");
      if (movedPast) return lapse("moved-past");
      const hole = c.sequence - lastSegment - 1n > passedOver;
      if (c.sequence === checkpointHeader.sequence && state.position === 0n && hole) return lapse("repair", held.index);
      return finish("abandoned", { abandonedAt: fact });
    },
    finish() {
      if (!opened) throw new EvidenceRefusal("unresolved-evidence");
      return contradictedAt.length ? finish("contradicted") : movedPast ? lapse("moved-past") : finish("pending");
    },
  };
}
