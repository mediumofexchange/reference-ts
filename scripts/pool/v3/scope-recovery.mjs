// Conditional C2b.3.1–4.2 reads. Snapshots exclude the entire publication index;
// canonical opening predecessors additionally include lower same-key sequences.
import { compareBytes, EncodingError } from "../../../dist/bytes.js";
import { identifierOf } from "../../../dist/pool/field.js";
import { ScopeTree } from "../../../dist/pool/scope.js";
import { EvidenceRefusal } from "../delivery/evidence-reader.mjs";
import { recoveryState, effectOf, checkRecovery, applyRecovery } from "./recovery-state.mjs";

const hex = bytes => Buffer.from(bytes).toString("hex");
const same = (a, b) => compareBytes(a, b) === 0;
export const venueOrder = (a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 :
  a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0;

export function scopeRecovery({ context, viewFor, latest, check, charge, ReplayRefusal }) {
  const { selection, codec, verifier } = context;
  const answers = new Map(), cached = new Map(), positions = new Map();
  const snapshotAt = (backing, terms, index) => latest(backing, terms, { index, strict: true });
  const publications = async (backing, terms) => {
    const name = hex(backing);
    if (!answers.has(name)) answers.set(name, (async () => {
      const view = await viewFor(backing, terms), answer = await view.ask(4, backing);
      for (const entry of answer.entries) {
        charge(1n);
        const position = `${entry.index}:${entry.ordinal}`;
        if (positions.has(position)) throw new EvidenceRefusal("unresolved-evidence");
        positions.set(position, name);
      }
      return answer.entries;
    })());
    return answers.get(name);
  };
  const forces = async (backing, terms, through) => {
    const name = hex(backing), key = `${name}:${through}`;
    if (cached.has(key)) return cached.get(key);
    const pending = (async () => {
      const force = [], verdicts = [], duration = terms.silence?.noCommitmentDuration;
      if (duration === undefined) return { force, verdicts };
      // Earlier receipt inclusion must not depend on publication availability
      // after the first gap. Strict-prefix clock reads descend in index here.
      if (context.receiptBytes !== undefined && (await clock(backing, terms, 0n, through)).boundary === undefined) return { force, verdicts };
      const view = await viewFor(backing, terms);
      for (const entry of await publications(backing, terms)) {
        if (entry.index > through) break;
        charge(1n);
        const item = { backing: name, index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
        verdicts.push(item);
        let publication;
        try { publication = codec.decodePublication(entry.record); }
        catch (error) {
          if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) continue;
          throw error;
        }
        if (!same(publication.domain, selection.domain) || !same(publication.backing, backing) ||
            publication.kind === 2 || publication.kind === 5) continue;
        const snapshot = await snapshotAt(backing, terms, entry.index);
        if (snapshot === undefined || entry.index - snapshot.index <= duration) continue;
        const source = snapshot.state;
        const state = { ...recoveryState(source), nullifiers: new Set(source.nullifiers), outputsSeen: new Set(source.outputsSeen) };
        for (const prior of force) if (prior.index > (source.adoptionIndices.get(name) ?? 0n)) {
          charge(1n); applyRecovery(prior.record, state, codec);
          const effect = effectOf(prior.record);
          effect.nfs.forEach(nf => state.nullifiers.add(nf)); effect.outputs.forEach(cm => state.outputsSeen.add(cm));
        }
        const record = publication.record, p = record.publicInputs;
        try {
          check(same(identifierOf(p[2], p[3]), snapshot.segment) && p[4] === new ScopeTree(snapshot.header.entries).root(), "CONTEXT");
          if (record.kind !== 5) check(same(identifierOf(p[5], p[6]), backing), "BACKING");
          if (record.kind !== 5) check(await verifier.verify(record.kind, [...p], new Uint8Array(record.proof)) === true, "PROOF");
          const { roots, nfs, outputs } = effectOf(record);
          check(roots.every(root => source.anchors.has(root)), "ANCHOR");
          check(new Set(nfs).size === nfs.length && nfs.every(nf => nf !== 0n && !state.nullifiers.has(nf)), "SPENT");
          check(new Set(outputs).size === outputs.length && outputs.every(cm => cm !== 0n && !state.outputsSeen.has(cm)), "OUTPUT");
          checkRecovery(record, state, { codec, check, backing, issuer: terms.obligor, at: entry.index, lag: view.lag, publication: true });
          force.push({ backing: name, index: entry.index, ordinal: entry.ordinal, record, bytes: codec.encodeRecord(record) });
          item.force = true;
        } catch (error) {
          if (!(error instanceof ReplayRefusal)) throw error;
          item.check = error.check;
        }
      }
      return { force, verdicts };
    })();
    cached.set(key, pending);
    return pending;
  };
  const clock = async (backing, terms, opening, through) => {
    const duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return null;
    const view = await viewFor(backing, terms), points = new Set([through]);
    // A reset is a breakpoint even if the gap's first index has no record.
    for (let i = 0; i < view.chain.length; i++) for (const held of await view.heldBy(view.chain[i].operator)) {
      charge(1n);
      if (held.index > opening && held.index <= through && held.index >= view.chain[i].from && held.index <= view.termEnd(i)) points.add(held.index);
    }
    let boundary, last = 0n;
    for (const at of [...points].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      last = (await snapshotAt(backing, terms, at))?.index ?? 0n;
      if (at > opening && at - last > duration && boundary === undefined) {
        const first = last + duration + 1n;
        boundary = first > opening ? first : opening + 1n;
      }
    }
    return { duration, snapshotIndex: last, gap: through - last, open: through - last > duration, boundary, opening };
  };
  return { forces, clock };
}
