// C2b.5.1–2 over a classified canonical snapshot and independently read venue.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes, EncodingError } from "../../bytes.js";
import { linkInForce, type RangeEntry } from "../../record-range.js";
import type { ReaderSelection, RecordView, ReplayResult } from "./reader.js";
import { decodePublication, statementHash, type Record } from "./records.js";
import { locked } from "./recovery.js";
import type { ProofCheck } from "./state.js";
import type { RootTerms } from "./terms.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;
export interface NonServiceCount {
  readonly duration: string; readonly threshold: string; readonly window: string;
  readonly count: string; readonly fires: boolean; readonly incumbent: string;
  readonly snapshotIndex: string | null;
}
export interface CountContext { readonly selection: ReaderSelection; readonly terms: RootTerms; readonly verifier: ProofCheck }

/** Unadopted publications never change the canonical state's locks or spent tags.
 * First identity indices include invalid proof variants; any verifying variant
 * strictly before t can establish that identity, without refreshing its window. */
export async function countNonService(context: CountContext, view: RecordView,
  canonical: { readonly index: bigint; readonly state: ReplayResult } | undefined,
  publications: readonly RangeEntry[], charge: (amount?: bigint) => void): Promise<NonServiceCount> {
  const { selection, terms, verifier } = context, { t, chain } = view;
  if (terms.nonService === undefined) throw new TypeError("non-service requires its declared clause");
  const { duration, count: threshold, window } = terms.nonService;
  const identities = new Map<string, { at: bigint; records: Record[] }>(), tags = new Set<bigint>();
  for (const entry of publications) {
    if (entry.index >= t) continue;
    let publication;
    try { publication = decodePublication(entry.record); }
    catch (error) { if (error instanceof EncodingError) continue; throw error; }
    if (publication.kind !== 5 || !same(publication.domain, selection.domain) || !same(publication.backing, selection.backing)) continue;
    const record = publication.record, identity = hex(statementHash(record)), first = identities.get(identity);
    if (first === undefined) identities.set(identity, { at: entry.index, records: [record] });
    else first.records.push(record);
  }
  if (canonical !== undefined) {
    const state = canonical.state;
    for (const { at, records } of identities.values()) {
      const p = records[0]!.publicInputs, anchor = p[4]!, tag = p[5]!;
      if (at < t - window || at > t - duration || tags.has(tag) || !state.anchors.has(anchor) ||
          state.spentTags.has(tag) || locked(state, tag, t)) continue;
      for (const record of records) {
        charge();
        if (await verifier.verify(7, [...record.publicInputs], new Uint8Array(record.proof)) === true) { tags.add(tag); break; }
      }
    }
  }
  const count = BigInt(tags.size);
  return { duration: duration.toString(), threshold: threshold.toString(), window: window.toString(), count: count.toString(),
    fires: count >= threshold, incumbent: hex(linkInForce(chain, t).operator), snapshotIndex: canonical?.index.toString() ?? null };
}
