// C2b.5.1–2 over a classified canonical snapshot and independently read venue. A request is read through its
// construction (construction.ts `request`): pool-v3's proof and anchor, lit-v1 §7's owner signature and input.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { linkInForce, type RangeEntry } from "../../record-range.js";
import type { Construction, RequestView } from "./construction.js";
import type { ReaderSelection, RecordView, ReplayResult } from "./reader.js";
import { locked } from "./recovery.js";
import type { ProofCheck } from "./state.js";
import type { RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface NonServiceCount {
  readonly duration: string; readonly threshold: string; readonly window: string;
  readonly count: string; readonly fires: boolean; readonly incumbent: string;
  readonly snapshotIndex: string | null;
}
export interface CountContext {
  readonly construction: Construction; readonly selection: Pick<ReaderSelection, "domain" | "backing">; readonly terms: RootTerms; readonly verifier: ProofCheck;
}

/** Unadopted publications never change the canonical state's locks or spent tags.
 * First identity indices include invalid proof variants; any verifying variant
 * strictly before t can establish that identity, without refreshing its window. */
export async function countNonService(context: CountContext, view: Pick<RecordView, "t" | "chain">,
  canonical: { readonly index: bigint; readonly state: ReplayResult } | undefined,
  publications: Iterable<RangeEntry>): Promise<NonServiceCount> {
  const { construction, selection, terms, verifier } = context, { t, chain } = view;
  if (terms.nonService === undefined) throw new TypeError("non-service requires its declared clause");
  const { duration, count: threshold, window } = terms.nonService;
  const identities = new Map<string, { at: bigint; requests: RequestView[] }>(), tags = new Set<bigint>();
  for (const entry of publications) {
    if (entry.index >= t) continue;
    let request: RequestView;
    try {
      const publication = construction.reader.publication(entry.record);
      if (publication.kind !== 5 || !same(publication.domain, selection.domain) || !same(publication.backing, selection.backing)) continue;
      request = construction.reader.request(publication.record!);
    } catch (error) { if (error instanceof EncodingError) continue; throw error; }
    const first = identities.get(request.identity);
    if (first === undefined) identities.set(request.identity, { at: entry.index, requests: [request] });
    else first.requests.push(request);
  }
  if (canonical !== undefined) {
    const state = canonical.state;
    for (const { at, requests } of identities.values()) {
      // Variants of one statement name one tag and one input.
      const first = requests[0]!, tag = first.tag;
      if (at < t - window || at > t - duration || tags.has(tag) || !first.reads(state) ||
          state.hasSpentTag(tag) || locked(state, tag, t)) continue;
      for (const request of requests) {
        if (await request.holds(verifier) === true) { tags.add(tag); break; }
      }
    }
  }
  const count = BigInt(tags.size);
  return { duration: duration.toString(), threshold: threshold.toString(), window: window.toString(), count: count.toString(),
    fires: count >= threshold, incumbent: hex(linkInForce(chain, t).operator), snapshotIndex: canonical?.index.toString() ?? null };
}
