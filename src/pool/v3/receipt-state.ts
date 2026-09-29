// C2.10.9a–c and C2b.4.3. Classification and clock boundaries come from the reader.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import type { HeldCommitment } from "../../record-range.js";
import { ScopeTree } from "../scope.js";
import { decodeReceipt, decodeSnapshot, receiptMatchesEvent, verifyReceipt, type Receipt } from "./commitments.js";
import { decodeSegmentHeader, type SegmentHeader } from "./headers.js";
import type { ReaderSelection, RecordView, ReplayResult } from "./reader.js";
import { EvidenceRefusal } from "./refusals.js";
import type { ServedTrail } from "./trail.js";
const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
function requireReceipt(condition: boolean): asserts condition { if (!condition) throw new EvidenceRefusal("invalid-receipt"); }
export interface ReceiptFact { readonly operator: string; readonly sequence: string; readonly index: string }
export interface ReceiptVerdict {
  readonly status: "final" | "contradicted" | "lapsed" | "abandoned" | "pending";
  readonly sequence: "held" | "moved-past" | "not-reached";
  readonly includedAt: readonly ReceiptFact[]; readonly contradictedAt: readonly ReceiptFact[];
  readonly lapse?: { readonly kind: string; readonly at?: string };
  readonly abandonedAt?: ReceiptFact;
}
export interface ReceiptWalk {
  readonly receipt: Receipt; readonly header: SegmentHeader; readonly termBoundary: bigint | undefined;
  evidence(): { contradictedAt: ReceiptFact[] };
  boundary(at: bigint, clock: { readonly boundary?: bigint | undefined } | undefined): ReceiptVerdict | undefined;
  checkpoint(held: HeldCommitment, segment: Uint8Array | undefined, state: ReplayResult | undefined,
    header: SegmentHeader | undefined, classification: string): ReceiptVerdict | undefined;
  finish(): ReceiptVerdict;
}
export async function receiptWalk(bytes: Uint8Array, context: { readonly selection: ReaderSelection }, view: RecordView,
  trails: readonly ServedTrail[], snapshots: readonly Uint8Array[], scopeViews?: ReadonlyMap<string, RecordView>): Promise<ReceiptWalk> {
  const { selection } = context, receipt = decodeReceipt(bytes);
  const trail = trails.find(tr => same(sha256(tr.header), receipt.segment));
  if (trail === undefined) throw new EvidenceRefusal("unresolved-evidence");
  const header = decodeSegmentHeader(trail.header);
  if (header.entries.length !== 1 && scopeViews === undefined) throw new EvidenceRefusal("unsupported-scope");
  requireReceipt(same(header.domain, selection.domain) && same(header.venue, selection.venue) &&
    header.entries.some(scope => same(scope.backing, selection.backing)) && receipt.after >= header.sequence &&
    verifyReceipt({ domain: selection.domain, segment: sha256(trail.header), scopeRoot: new ScopeTree(header.entries).root(), operator: header.operator }, receipt));
  let termBoundary: bigint | undefined;
  for (const scope of header.entries) {
    const scopedView = scopeViews?.get(hex(scope.backing)) ?? view;
    const termIndex = scopedView.chain.findIndex(link => same(link.link, scope.link) && same(link.operator, header.operator));
    requireReceipt(termIndex >= 0);
    const end = scopedView.chain[termIndex + 1]?.from;
    if (end !== undefined && (termBoundary === undefined || end < termBoundary)) termBoundary = end;
  }
  const held = await view.heldBy(header.operator), reference = held.find(h => h.commitment.sequence === receipt.after);
  const movedPast = reference === undefined && held.some(h => h.commitment.sequence > receipt.after);
  if (reference !== undefined) {
    const entry = view.carries(reference); requireReceipt(entry !== undefined);
    const snapshot = snapshots.find(s => same(sha256(s), entry.digest));
    if (snapshot === undefined) throw new EvidenceRefusal("unresolved-evidence");
    const decoded = decodeSnapshot(snapshot);
    requireReceipt(same(decoded.segment, receipt.segment) && same(decoded.backing, selection.backing));
  }
  const contradictedAt: ReceiptFact[] = [];
  let opened = false, lastSegment = receipt.after, passedOver = 0n;
  const finish = (status: ReceiptVerdict["status"], detail: Partial<ReceiptVerdict> = {}): ReceiptVerdict => ({ status,
    sequence: reference ? "held" : movedPast ? "moved-past" : "not-reached", includedAt: [], contradictedAt: [...contradictedAt], ...detail });
  const lapse = (kind: string, at?: bigint): ReceiptVerdict => finish(contradictedAt.length ? "contradicted" : "lapsed",
    contradictedAt.length ? {} : { lapse: { kind, ...(at === undefined ? {} : { at: at.toString() }) } });
  return { receipt, header, termBoundary, evidence: () => ({ contradictedAt: [...contradictedAt] }),
    boundary(at, clock) {
      if (!opened) return;
      const silence = clock?.boundary;
      const end = termBoundary === undefined ? silence : silence === undefined ? termBoundary : termBoundary < silence ? termBoundary : silence;
      if (end !== undefined && at >= end) return lapse(end === silence ? "silence" : "scope-boundary", end);
    },
    checkpoint(held, segment, state, checkpointHeader, classification) {
      const c = held.commitment, own = segment !== undefined && same(segment, receipt.segment);
      const fact = { operator: hex(c.operator), sequence: c.sequence.toString(), index: held.index.toString() };
      if (classification === "valid" && own) {
        if (c.sequence === header.sequence) opened = true;
        requireReceipt(opened);
        const event = state!.receiptEvent(receipt.position);
        if (event !== undefined && receiptMatchesEvent(receipt, event)) return finish("final", { includedAt: [fact] });
        if (c.sequence > receipt.after ? reference !== undefined : event !== undefined) contradictedAt.push(fact);
      }
      if (!same(c.operator, receipt.operator) || c.sequence <= receipt.after) return;
      if (own) { lastSegment = c.sequence; passedOver = 0n; return; }
      if (classification !== "valid" || segment === undefined) { passedOver++; return; }
      if (!opened) throw new EvidenceRefusal("unresolved-evidence");
      if (contradictedAt.length) return finish("contradicted");
      if (movedPast) return lapse("moved-past");
      const hole = c.sequence - lastSegment - 1n > passedOver;
      if (c.sequence === checkpointHeader!.sequence && state!.position === 0n && hole) return lapse("repair", held.index);
      return finish("abandoned", { abandonedAt: fact });
    },
    finish() {
      if (!opened) throw new EvidenceRefusal("unresolved-evidence");
      return contradictedAt.length ? finish("contradicted") : movedPast ? lapse("moved-past") : finish("pending");
    },
  };
}
