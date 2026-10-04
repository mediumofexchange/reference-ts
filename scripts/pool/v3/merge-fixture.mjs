// Deliberately conflicting parent states for probing mergeFinalizedPrefixes
// directly: named segments whose records are written to a replay store
// without judgment, each importing named earlier segments by reference. A
// conflict probe, not evidence that canonical scopes can finalize one.
import { createHash } from "node:crypto";
import { identifierOf } from "../../../dist/pool/field.js";
import { encodeRecord, evidenceHashes, statementHash } from "../../../dist/pool/v3/records.js";
import { effectOf, recoveryEffect, tagOf } from "../../../dist/pool/v3/recovery.js";
import { ReplayResult } from "../../../dist/pool/v3/reader.js";
import { ReplayStore } from "../../../dist/pool/v3/replay-store.js";
import { nextHistoryHash } from "../../../dist/pool/v3/commitments.js";
import { mergeFinalizedPrefixes } from "../../../dist/pool/v3/scope-reader.js";

const sha = bytes => new Uint8Array(createHash("sha256").update(bytes).digest());
const hex = bytes => Buffer.from(bytes).toString("hex");

export function mergeFixture() {
  const store = new ReplayStore(), built = new Map();
  let namespaces = 0;
  /** Segment `name` holding `records`, importing `ancestry` ([name, position] pairs) by reference. `keys: false`
   * writes no tag or demand keys, isolating the spent and output checks from C2.10.6's ordering check. */
  const segment = (name, records, ancestry = [], { keys = true } = {}) => {
    const id = sha(Buffer.from(name)), imports = new Map();
    for (const [other, upto] of ancestry) {
      const source = built.get(other);
      for (const [segmentName, entry] of store.imports(source)) imports.set(segmentName, entry);
      imports.set(hex(sha(Buffer.from(other))), { ns: source, upto });
    }
    const genesis = { history: sha(Buffer.from(`genesis ${name}`)), evidence: new Uint8Array(32) };
    const ns = store.open(id, sha(Buffer.from(`fixture ${++namespaces}`)), { segments: imports, totals: new Map() }, genesis);
    for (const record of records) {
      const tip = store.tip(ns), p = record.publicInputs, kind = record.kind, identity = statementHash(record);
      const { nfs, outputs } = effectOf(record), { demand, ended } = recoveryEffect(record);
      const demandId = kind === 5 || kind === 6 ? hex(identifierOf(p[kind === 5 ? 5 : 15], p[kind === 5 ? 6 : 16])) : undefined;
      const standing = demandId === undefined ? undefined : store.demand(ns, tip.position, demandId);
      const tags = kind === 4 ? p.slice(10, 12).filter(tag => tag !== 0n) : kind === 5 ? standing?.tags.filter(tag => tag !== 0n) ?? [] : nfs.map(tagOf);
      const touched = kind === 4 ? hex(identity) : demandId, backing = kind === 1 || kind === 3 ? hex(identifierOf(p[5], p[6])) : undefined;
      const { proofHash, signatureHash } = evidenceHashes(record);
      store.append(ns, { identity, kind, index: 1n, record: encodeRecord(record), proofHash, signatureHash, evidence: new Uint8Array(32),
        supply: backing === undefined ? undefined : { backing, issued: kind === 1 ? p[7] : 0n, burned: kind === 3 ? p[7] : 0n },
        nullifiers: nfs.map(nf => ({ nf, tag: tagOf(nf) })),
        outputs: outputs.map((cm, i) => ({ cm, capsule: kind === 6 ? undefined : record.capsules[i], settlement: kind === 6, witness: undefined })),
        demand, ended, keys: keys ? [...tags.map(tag => `tag:${tag}`), ...(touched === undefined ? [] : [`demand:${touched}`])] : [],
        history: (noteRoot, spentRoot) => nextHistoryHash(tip.history, identity, noteRoot, spentRoot, tip.position + 1n) });
    }
    built.set(name, ns);
    const position = store.tip(ns).position;
    return { state: new ReplayResult(store, ns, position, { issued: 0n, burned: 0n, adoptionIndices: new Map(), identity: new Uint8Array(32) }) };
  };
  const merge = parents => mergeFinalizedPrefixes(store, parents);
  /** What a segment opened over `merged` sees: its standing demands, effective recovery statements and outputs. */
  const opened = merged => {
    const ns = store.open(sha(Buffer.from(`merged ${++namespaces}`)), new Uint8Array(32), merged.frontier,
      { history: new Uint8Array(32), evidence: new Uint8Array(32) });
    const events = [...store.events(ns, 0n)];
    return { events: events.length, demands: store.demands(ns, 0n).length, effective: events.filter(event => event.kind >= 4).length, outputs: [...store.outputs(ns, 0n)].length };
  };
  return { segment, merge, opened };
}
