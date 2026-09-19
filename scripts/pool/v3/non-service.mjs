// Conditional C2b.5.1–2 count, over the reader's classified snapshot and record.
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { locked } from "./recovery-state.mjs";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");

/** Publications and canonical state are strictly before t (pool-recovery §1).
 * First identity indices include invalid proof variants; any verifying variant
 * in that prefix can establish the request, without moving its window. The
 * snapshot alone supplies spent tags and locks: unadopted publications do not
 * alter C2b.5.2's canonical state. No supplied index, terms or key is trusted. */
export async function countNonService(context, view, canonical, publications, charge) {
  const { selection, terms, codec, verifier } = context, { t, chain } = view;
  const { duration, count: threshold, window } = terms.nonService;
  const identities = new Map(), tags = new Set();
  for (const entry of publications) {
    charge();
    if (entry.index >= t) continue;
    let publication;
    try { publication = codec.decodePublication(entry.record); }
    catch (error) {
      if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) continue;
      throw error;
    }
    if (publication.kind !== 5 || !same(publication.domain, selection.domain) ||
        !same(publication.backing, selection.backing)) continue;
    // decodePublication checks both inner domain and proof-named backing.
    const record = publication.record, identity = hex(codec.statementHash(record));
    const first = identities.get(identity);
    if (first === undefined) identities.set(identity, { at: entry.index, records: [record] });
    else first.records.push(record);
  }
  if (canonical !== undefined) {
    const state = canonical.state;
    for (const { at, records } of identities.values()) {
      const p = records[0].publicInputs, anchor = p[4], tag = p[5];
      if (at < t - window || at > t - duration || tags.has(tag) ||
          !state.anchors.has(anchor) || state.spentTags.has(tag) || locked(state, tag, t)) continue;
      for (const record of records) {
        charge();
        if (await verifier.verify(7, [...record.publicInputs], new Uint8Array(record.proof)) === true) {
          tags.add(tag); break;
        }
      }
    }
  }
  const count = BigInt(tags.size);
  return { duration: duration.toString(), threshold: threshold.toString(), window: window.toString(),
    count: count.toString(), fires: count >= threshold, incumbent: hex(codec.linkInForce(chain, t).operator),
    snapshotIndex: canonical?.index.toString() ?? null };
}
