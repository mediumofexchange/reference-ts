// Single-backing C3.7/C2b.3.2 recovery state over pool-v3 §5 records:
// standing demands, effective recovery statements and spent tags. Pure
// guards and effects; no venue, clock or finality authority.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import { identifierOf } from "../field.js";
import { poseidon2Hash } from "../poseidon2.js";
import { settlementAuthorization, statementHash, withdrawalBytes, type Record } from "./records.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** A standing kind-4 demand, by its statement identity. */
export interface Demand {
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly tags: readonly bigint[];
  readonly presenter: Uint8Array;
  readonly deadline: bigint;
}
export interface RecoveryState {
  readonly demands: Map<string, Demand>;
  readonly effective: Set<string>;
  readonly spentTags: Set<bigint>;
}
/** A record's note effect: nullifiers spent, outputs created, anchors read. */
export interface Effect {
  readonly nfs: readonly bigint[];
  readonly outputs: readonly bigint[];
  readonly roots: readonly bigint[];
}

export const tagOf = (nf: bigint): bigint => poseidon2Hash([1007n, nf]);

/** A copy of `source`'s recovery state, or an empty one. */
export function recoveryState(source?: Partial<RecoveryState>): RecoveryState {
  return { demands: new Map(source?.demands), effective: new Set(source?.effective), spentTags: new Set(source?.spentTags) };
}

/** Whether a standing demand other than `except` locks `tag` at index `at`;
 * nothing locks where no index was witnessed (a read without venue answers). */
export function locked(state: Pick<RecoveryState, "demands">, tag: bigint, at: bigint | undefined, except?: string): boolean {
  if (at === undefined) return false;
  for (const [id, demand] of state.demands) {
    if (id !== except && demand.deadline >= at && demand.tags.includes(tag)) return true;
  }
  return false;
}

export function effectOf(record: Record): Effect {
  const p = record.publicInputs;
  switch (record.kind) {
    case 1: return { nfs: [], outputs: [p[8]!], roots: [] };
    case 2: return { nfs: p.slice(7, 9), outputs: p.slice(9, 13), roots: p.slice(5, 7) };
    case 3: return { nfs: p.slice(10, 12), outputs: [p[12]!], roots: p.slice(8, 10) };
    case 4: return { nfs: [], outputs: [], roots: p.slice(8, 10).filter((_, i) => p[10 + i] !== 0n) };
    case 5: return { nfs: [], outputs: [], roots: [] };
    case 6: return { nfs: p.slice(12, 14), outputs: [p[14]!], roots: p.slice(10, 12) };
    default: throw new Error("unsupported recovery record kind");
  }
}

export interface RecoveryCheck {
  readonly check: (condition: boolean, name: string) => void;
  readonly backing: Uint8Array;
  readonly issuer: Uint8Array;
  /** The publication's own index, or the checkpoint's index in replay; undefined without venue answers. */
  readonly at: bigint | undefined;
  readonly lag?: bigint;
  /** A publication judged for force: its door deadlines apply (C2b.3.2). */
  readonly publication?: boolean;
}

/** Pure guards, before any mutation. The caller verifies proofs, context and
 * roots. Door deadlines are checked only for publications, never in replay. */
export function checkRecovery(record: Record, state: RecoveryState, { check, backing, issuer, at, lag, publication = false }: RecoveryCheck): void {
  const p = record.publicInputs, kind = record.kind, id = hex(statementHash(record));
  const { nfs } = effectOf(record);
  if (publication && (at === undefined || lag === undefined)) throw new Error("a publication is judged at its own index under the venue's lag");
  if (kind >= 4) check(!state.effective.has(id), "REPEATED_STATEMENT");
  if (kind === 4) {
    const tags = p.slice(10, 12).filter(tag => tag !== 0n);
    check(tags.length > 0 && new Set(tags).size === tags.length, "TAGS");
    check(tags.every(tag => !state.spentTags.has(tag) && !locked(state, tag, at)), "LOCKED");
    if (publication) check(p[14]! >= at! - 2n * lag! && p[14]! <= at! - lag! && p[15]! > at!, "DEADLINE");
  } else if (kind === 5 || kind === 6) {
    const demandId = hex(identifierOf(p[kind === 5 ? 5 : 15]!, p[kind === 5 ? 6 : 16]!));
    const demand = state.demands.get(demandId);
    check(demand !== undefined && same(demand.backing, backing), "DEMAND");
    if (kind === 5) {
      check(verifySignatureStrict(record.authorization, withdrawalBytes(record), demand!.presenter), "SIGNATURE");
    } else {
      check(p[7] === demand!.quantity, "QUANTITY");
      const auth = settlementAuthorization(record);
      check(auth.acceptance.deadline <= demand!.deadline, "DEADLINE");
      check(verifySignatureStrict(auth.acceptance.signature, auth.acceptanceMessage, issuer) &&
        verifySignatureStrict(auth.releaseSignature, auth.releaseMessage, demand!.presenter), "SIGNATURE");
      if (publication) check(demand!.deadline >= at! && auth.acceptance.deadline >= at!, "DEADLINE");
      check(nfs.every((nf, i) => demand!.tags[i] === 0n || demand!.tags[i] === tagOf(nf)), "TAGS");
      check(nfs.every(nf => !locked(state, tagOf(nf), at, demandId)), "LOCKED");
    }
  } else if (kind === 2 || kind === 3) {
    check(nfs.every(nf => !locked(state, tagOf(nf), at)), "LOCKED");
  }
}

/** Called only after every guard. Replay and force share these effects. */
export function applyRecovery(record: Record, state: RecoveryState): void {
  const p = record.publicInputs, id = hex(statementHash(record));
  if (record.kind === 4) {
    state.demands.set(id, { backing: identifierOf(p[5]!, p[6]!), quantity: p[7]!, tags: p.slice(10, 12),
      presenter: identifierOf(p[12]!, p[13]!), deadline: p[15]! });
  } else if (record.kind === 5 || record.kind === 6) {
    const i = record.kind === 5 ? 5 : 15;
    state.demands.delete(hex(identifierOf(p[i]!, p[i + 1]!)));
  }
  if (record.kind >= 4) state.effective.add(id);
  for (const nf of effectOf(record).nfs) state.spentTags.add(tagOf(nf));
}
