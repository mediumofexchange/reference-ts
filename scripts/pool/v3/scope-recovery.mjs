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
const byIndex = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function scopeRecovery({ context, viewFor, latest, check, charge, ReplayRefusal }) {
  const { selection, codec, verifier } = context;
  const answers = new Map(), progress = new Map(), positions = new Map(), heldIndices = new Map(), clocks = new Map();
  const snapshotAt = (backing, terms, index) => latest(backing, terms, { index, strict: true });
  // Each publication is charged once, when its answer is read; forces and
  // counts then pass over the same entries without charging them again.
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
  // A publication's verdict depends on its own index, the snapshot strictly
  // before it and the force of earlier publications, never on how far a caller
  // reads. Each backing's publications are therefore classified once, in venue
  // order, and a read through an index returns that prefix.
  const forces = async (backing, terms, through) => {
    const name = hex(backing), duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return { force: [], verdicts: [] };
    // Earlier receipt inclusion must not depend on publication availability
    // after the first gap. Strict-prefix clock reads descend in index here.
    if (context.receiptBytes !== undefined && (await clock(backing, terms, 0n, through)).boundary === undefined) return { force: [], verdicts: [] };
    const view = await viewFor(backing, terms), entries = await publications(backing, terms);
    if (!progress.has(name)) progress.set(name, { force: [], verdicts: [], next: 0, busy: false });
    const read = progress.get(name), { force, verdicts } = read;
    while (read.next < entries.length && entries[read.next].index <= through) {
      // Nested reads come from snapshots strictly before the entry in progress.
      if (read.busy) throw new Error("publication prefix order");
      read.busy = true;
      try {
        const entry = entries[read.next];
        const item = { backing: name, index: entry.index.toString(), ordinal: entry.ordinal.toString(), force: false };
        verdicts.push(item);
        await classifyPublication(backing, terms, view, duration, entry, item, force);
      } finally { read.busy = false; }
      read.next++;
    }
    const after = verdicts.findIndex(item => BigInt(item.index) > through);
    return { force: force.filter(event => event.index <= through),
      verdicts: verdicts.slice(0, after < 0 ? verdicts.length : after).map(item => ({ ...item })) };
  };
  const classifyPublication = async (backing, terms, view, duration, entry, item, force) => {
    const name = hex(backing);
    let publication;
    try { publication = codec.decodePublication(entry.record); }
    catch (error) {
      if (error instanceof EncodingError || error instanceof codec.CodecEncodingError) return;
      throw error;
    }
    if (!same(publication.domain, selection.domain) || !same(publication.backing, backing) ||
        publication.kind === 2 || publication.kind === 5) return;
    const snapshot = await snapshotAt(backing, terms, entry.index);
    if (snapshot === undefined || entry.index - snapshot.index <= duration) return;
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
  };
  // Every held index within its own term, scanned and charged once per backing.
  const termIndices = (backing, terms) => {
    const name = hex(backing);
    if (!heldIndices.has(name)) heldIndices.set(name, (async () => {
      const view = await viewFor(backing, terms), indices = new Set();
      for (let i = 0; i < view.chain.length; i++) for (const held of await view.heldBy(view.chain[i].operator)) {
        charge(1n);
        if (held.index >= view.chain[i].from && held.index <= view.termEnd(i)) indices.add(held.index);
      }
      return [...indices].sort(byIndex);
    })());
    return heldIndices.get(name);
  };
  // One clock per backing, opening and index; each caller receives its own copy.
  const clock = async (backing, terms, opening, through) => {
    const duration = terms.silence?.noCommitmentDuration;
    if (duration === undefined) return null;
    const key = `${hex(backing)}:${opening}:${through}`;
    if (!clocks.has(key)) clocks.set(key, (async () => {
      // A reset is a breakpoint even if the gap's first index has no record.
      const points = new Set([through]);
      for (const at of await termIndices(backing, terms)) if (at > opening && at <= through) points.add(at);
      let boundary, last = 0n;
      for (const at of [...points].sort(byIndex)) {
        last = (await snapshotAt(backing, terms, at))?.index ?? 0n;
        if (at > opening && at - last > duration && boundary === undefined) {
          const first = last + duration + 1n;
          boundary = first > opening ? first : opening + 1n;
        }
      }
      return { duration, snapshotIndex: last, gap: through - last, open: through - last > duration, boundary, opening };
    })());
    return { ...await clocks.get(key) };
  };
  return { forces, clock, publications };
}
