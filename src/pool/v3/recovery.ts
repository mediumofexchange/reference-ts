// Single-backing C3.7/C2b.3.2 recovery over pool-v3 §5 records: standing
// demands, effective recovery statements and spent tags. Pure guards over a
// read-only view and the effects a record would write; no venue, clock or
// finality authority.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { identifierOf } from "../field.js";
import { poseidon2Hash } from "../poseidon2.js";
import { statementHash, type Record } from "./records.js";
import type { StatementView } from "./construction.js";
import type { Demand } from "./replay-store.js";

export type { Demand } from "./replay-store.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** What recovery guards read: standing demands by identity and tag, effective recovery statements, spent tags. */
export interface RecoveryView {
  demand(id: string): Demand | undefined;
  demandsWithTag(tag: bigint): readonly (readonly [string, Demand])[];
  isEffective(id: string): boolean;
  hasSpentTag(tag: bigint): boolean;
}
/** A record's note effect: nullifiers spent, outputs created, anchors read. */
export interface Effect {
  readonly nfs: readonly bigint[];
  readonly outputs: readonly bigint[];
  readonly roots: readonly bigint[];
}
/** What a record changes in recovery state; its nullifiers' tags are spent besides. */
export interface RecoveryEffect {
  readonly demand: { readonly id: string; readonly value: Demand } | undefined;
  readonly ended: string | undefined;
}

export const tagOf = (nf: bigint): bigint => poseidon2Hash([1007n, nf]);

/** Whether a standing demand other than `except` locks `tag` at index `at`. */
export function locked(view: Pick<RecoveryView, "demandsWithTag">, tag: bigint, at: bigint, except?: string): boolean {
  return view.demandsWithTag(tag).some(([id, demand]) => id !== except && demand.deadline >= at);
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
  /** The publication's own index, or the checkpoint's index in replay. */
  readonly at: bigint;
  readonly lag?: bigint;
  /** Admission at the horizon or publication force at its own index: C3.8's door deadlines apply. */
  readonly door?: boolean;
}

/** Pure guards, before any mutation, over a record's view (construction.ts) in every construction. The caller
 * verifies the statement check, context and inputs. Door deadlines are checked at admission and force, never in
 * replay. A demand's notes are unspent through their tags (C3.7): a spent tag refuses as `LOCKED`. */
export function checkRecovery(view: StatementView, state: RecoveryView, { check, backing, issuer, at, lag, door = false }: RecoveryCheck): void {
  const kind = view.kind, id = hex(view.identity), { nfs, tags: nfTags } = view;
  if (door && lag === undefined) throw new TypeError("a door is judged at an index under the venue's lag");
  if (kind >= 4) check(!state.isEffective(id), "REPEATED_STATEMENT");
  if (kind === 4) {
    const stood = view.demand!.value, tags = stood.tags.filter(tag => tag !== 0n);
    check(tags.length > 0 && new Set(tags).size === tags.length, "TAGS");
    check(tags.every(tag => !state.hasSpentTag(tag) && !locked(state, tag, at)), "LOCKED");
    if (door) check(stood.instant >= at - 2n * lag! && stood.instant <= at - lag! && stood.deadline > at, "DEADLINE");
  } else if (kind === 5 || kind === 6) {
    const demandId = view.ended!, demand = state.demand(demandId);
    check(demand !== undefined && same(demand.backing, backing), "DEMAND");
    if (kind === 5) {
      check(view.withdrawalSigned(demand!.presenter), "SIGNATURE");
    } else {
      check(view.quantity === demand!.quantity, "QUANTITY");
      const settlement = view.settlement();
      check(settlement.deadline <= demand!.deadline, "DEADLINE");
      check(settlement.signed(issuer, demand!.presenter), "SIGNATURE");
      // The demand's deadline is at or after the acceptance's, so this bounds both.
      if (door) check(settlement.deadline >= at, "DEADLINE");
      check(nfs.every((_, i) => demand!.tags[i] === 0n || demand!.tags[i] === nfTags[i]), "TAGS");
      check(nfTags.every(tag => !locked(state, tag, at, demandId)), "LOCKED");
    }
  } else if (kind === 2 || kind === 3) {
    check(nfTags.every(tag => !locked(state, tag, at)), "LOCKED");
  }
}

/** The demand a kind-4 record stands up, or the one a kind-5/6 record ends. Replay and force share these effects. */
export function recoveryEffect(record: Record): RecoveryEffect {
  const p = record.publicInputs;
  if (record.kind === 4) {
    return { demand: { id: hex(statementHash(record)), value: { backing: identifierOf(p[5]!, p[6]!), quantity: p[7]!, tags: p.slice(10, 12),
      presenter: identifierOf(p[12]!, p[13]!), instant: p[14]!, deadline: p[15]! } }, ended: undefined };
  }
  if (record.kind === 5 || record.kind === 6) {
    const i = record.kind === 5 ? 5 : 15;
    return { demand: undefined, ended: hex(identifierOf(p[i]!, p[i + 1]!)) };
  }
  return { demand: undefined, ended: undefined };
}
