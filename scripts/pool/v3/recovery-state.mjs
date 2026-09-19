// Conditional single-backing C3.7/C2b.3.2 state. No venue or finality authority.
import { compareBytes } from "../../../dist/bytes.js";
import { identifierOf } from "../../../dist/pool/field.js";
import { poseidon2Hash } from "../../../dist/pool/poseidon2.js";
import { verifySignatureStrict } from "../../../dist/keys.js";

const same = (a, b) => compareBytes(a, b) === 0;
const hex = bytes => Buffer.from(bytes).toString("hex");
export const tagOf = nf => poseidon2Hash([1007n, nf]);
export function recoveryState(source) {
  return { demands: new Map(source?.demands), effective: new Set(source?.effective),
    spentTags: new Set(source?.spentTags) };
}
export function locked(state, tag, at, except) {
  for (const [id, demand] of state.demands) {
    if (id !== except && demand.deadline >= at && demand.tags.includes(tag)) return true;
  }
  return false;
}
export function effectOf(record) {
  const p = record.publicInputs;
  switch (record.kind) {
    case 1: return { nfs: [], outputs: [p[8]], roots: [] };
    case 2: return { nfs: p.slice(7, 9), outputs: p.slice(9, 13), roots: p.slice(5, 7) };
    case 3: return { nfs: p.slice(10, 12), outputs: [p[12]], roots: p.slice(8, 10) };
    case 4: return { nfs: [], outputs: [], roots: p.slice(8, 10).filter((_, i) => p[10 + i] !== 0n) };
    case 5: return { nfs: [], outputs: [], roots: [] };
    case 6: return { nfs: p.slice(12, 14), outputs: [p[14]], roots: p.slice(10, 12) };
    default: throw new Error("unsupported recovery record kind");
  }
}
/** Pure guards, before any mutation. The caller verifies proofs/context and
 * roots, and supplies the original publication index or checkpoint index.
 * Door deadlines are checked only for publications, never ordinary replay. */
export function checkRecovery(record, state, { codec, check, backing, issuer, at, lag, publication = false }) {
  const p = record.publicInputs, kind = record.kind, id = hex(codec.statementHash(record));
  const { nfs } = effectOf(record);
  if (kind >= 4) check(!state.effective.has(id), "REPEATED_STATEMENT");
  if (kind === 4) {
    const tags = p.slice(10, 12).filter(tag => tag !== 0n);
    check(tags.length > 0 && new Set(tags).size === tags.length, "TAGS");
    check(tags.every(tag => !state.spentTags.has(tag) && !locked(state, tag, at)), "LOCKED");
    if (publication) {
      check(p[14] >= at - 2n * lag && p[14] <= at - lag && p[15] > at, "DEADLINE");
    }
  } else if (kind === 5 || kind === 6) {
    const demandId = hex(identifierOf(p[kind === 5 ? 5 : 15], p[kind === 5 ? 6 : 16]));
    const demand = state.demands.get(demandId);
    check(demand !== undefined && same(demand.backing, backing), "DEMAND");
    if (kind === 5) {
      check(verifySignatureStrict(record.authorization, codec.withdrawalBytes(record), demand.presenter), "SIGNATURE");
    } else {
      check(p[7] === demand.quantity, "QUANTITY");
      const auth = codec.settlementAuthorization(record);
      check(auth.acceptance.deadline <= demand.deadline, "DEADLINE");
      check(verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
        verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, demand.presenter), "SIGNATURE");
      if (publication) check(demand.deadline >= at && auth.acceptance.deadline >= at, "DEADLINE");
      check(nfs.every((nf, i) => demand.tags[i] === 0n || demand.tags[i] === tagOf(nf)), "TAGS");
      check(nfs.every(nf => !locked(state, tagOf(nf), at, demandId)), "LOCKED");
    }
  } else if (kind === 2 || kind === 3) {
    check(nfs.every(nf => !locked(state, tagOf(nf), at)), "LOCKED");
  }
}
/** Called only after all guards. Effects are shared by replay and force. */
export function applyRecovery(record, state, codec) {
  const p = record.publicInputs, id = hex(codec.statementHash(record));
  if (record.kind === 4) {
    state.demands.set(id, { backing: identifierOf(p[5], p[6]), quantity: p[7], tags: p.slice(10, 12),
      presenter: identifierOf(p[12], p[13]), deadline: p[15] });
  } else if (record.kind === 5 || record.kind === 6) {
    const i = record.kind === 5 ? 5 : 15;
    state.demands.delete(hex(identifierOf(p[i], p[i + 1])));
  }
  if (record.kind >= 4) state.effective.add(id);
  for (const nf of effectOf(record).nfs) state.spentTags.add(tagOf(nf));
}
