import { bytesToHex as hex } from "@noble/hashes/utils.js";
import type { ReplayResult } from "../src/pool/v3/reader.js";

/** What a replayed checkpoint's state holds, comparable across stores and reads. */
export function describeState(state: ReplayResult) {
  return {
    position: state.position, history: hex(state.history), evidence: hex(state.evidence), noteRoot: state.noteRoot(), spentRoot: hex(state.spentRoot()),
    issued: state.issued, burned: state.burned, adoptionIndex: state.adoptionIndex, adoptionIndices: [...state.adoptionIndices],
    totals: [...state.totals()], nullifiers: state.nullifiers(), outputs: [...state.outputs()].map(output => output.cm),
    events: [...state.events()].map(event => [event.segment, event.position, hex(event.identity), event.index, hex(event.history)]),
    demands: state.demands().map(([id]) => id), identity: hex(state.identity).length,
  };
}
