// C3.8's reading over the pool: what one demand's record says at a reader's
// judging index t, from the canonical history and the venue record a frontier
// read holds (pool-recovery C3.4, C3.8; Construction §C3). Each event counts
// from the index it was witnessed at: a statement in history at the earliest
// canonical checkpoint holding it (the index replay judged it at), a
// publication at its own index. So the reading at any index is the record
// through that index, and a later end never erases what an earlier index read
// (the void is prospective; Extensions' latch reads withdrawals alike). Pure:
// no venue, store write or wallet state.
import { bytesToHex as hex } from "@noble/hashes/utils.js";
import { compareBytes } from "../../bytes.js";
import { verifySignatureStrict } from "../../keys.js";
import { acceptanceBytes, acceptanceId, decodeRecord, type Record } from "./records.js";
import { effectOf, recoveryEffect, tagOf, type Demand } from "./recovery.js";
import { EvidenceRefusal } from "./refusals.js";
import type { StoredEvent } from "./replay-store.js";
import type { FrontierResult } from "./scope-reader.js";

const same = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** An acceptance of the demand that verifies under K and is due no later than the demand, at the first index the
 * venue witnessed it, alone or in a release. It answers for the lapse reading where its deadline is later than that
 * index by more than the lag (C3.4, `timely`); `taken` where a release of it was taken by another demand's settlement. */
export interface WitnessedAcceptance {
  readonly id: Uint8Array;
  readonly owner: bigint;
  readonly deadline: bigint;
  readonly witnessed: bigint;
  readonly timely: boolean;
  readonly taken: boolean;
}
/** One demand's C3.8 reading at the judging index. Its outcome there is `ended?.by`, else `overdue?.reading`,
 * else standing (at or before its deadline). */
export interface Presentation {
  readonly demand: Uint8Array;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly deadline: bigint;
  /** The index the demand was first witnessed at, in history or by its publication with force. */
  readonly witnessed: bigint;
  /** Its end and the index that end was witnessed at: its own settlement, its withdrawal, or a void (a tag of it
   * spent otherwise than by its own settlement, in history or by a settlement with force). */
  readonly ended: { readonly by: "settlement" | "withdrawal" | "void"; readonly at: bigint } | undefined;
  /** The indices past its deadline at which it stood unended, through the judging index: the backer's visible failure
   * (`dishonour`), or the holder's lapse (`lapse`) where a timely acceptance stood unreleased. */
  readonly overdue: { readonly reading: "dishonour" | "lapse"; readonly from: bigint; readonly through: bigint } | undefined;
  readonly acceptances: readonly WitnessedAcceptance[];
}

/** The index an event was witnessed at; a reader that cannot place it draws no reading (C2.10.13). */
function placed(event: StoredEvent): bigint {
  if (event.index === undefined) throw new EvidenceRefusal("unresolved-evidence");
  return event.index;
}
const settlementDemand = (record: Record): string | undefined => record.kind === 6 ? recoveryEffect(record).ended : undefined;

/**
 * C3.8 for `demand` (its identity) over `backing`, whose terms name `obligor` as K, at the frontier read's judging
 * index. The read must list the backing's witnessed answers (`answers`). Undefined where the record through that
 * index holds no such demand of this backing: an acceptance is evidence only beside the demand it names, so a demand
 * of another scoped backing is read with that backing's terms.
 */
export function readPresentation(frontier: Pick<FrontierResult, "canonical" | "force" | "answers" | "ranges">, backing: Uint8Array,
  obligor: Uint8Array, demand: Uint8Array): Presentation | undefined {
  const id = hex(demand), t = frontier.ranges.judgingIndex, lag = frontier.ranges.lag, state = frontier.canonical?.state;
  const kept = state?.presented(id);
  let notice: Demand | undefined = kept?.demand, witnessed = kept === undefined ? undefined : placed(kept.event);
  type End = NonNullable<Presentation["ended"]>;
  const ends: End[] = [];
  const end = (by: End["by"], at: bigint): void => { ends.push({ by, at }); };
  if (kept?.end !== undefined) end(kept.end.kind === 6 ? "settlement" : "withdrawal", placed(kept.end));
  // Forced publications through t, in venue order: the demand itself, its end, and settlements of other demands.
  for (const forced of frontier.force) {
    const effect = recoveryEffect(forced.record);
    if (effect.demand?.id === id) {
      notice ??= effect.demand.value;
      if (witnessed === undefined || forced.index < witnessed) witnessed = forced.index;
    } else if (effect.ended === id) end(forced.record.kind === 6 ? "settlement" : "withdrawal", forced.index);
  }
  if (notice === undefined || witnessed === undefined || !same(notice.backing, backing)) return undefined;
  // C3.8's void: a tag of it spent otherwise than by its own settlement, from the index that spend was witnessed at.
  const tags = notice.tags.filter(tag => tag !== 0n);
  for (const tag of tags) {
    for (const event of state?.tagSpends(tag) ?? []) {
      if (event.kind === 6 && settlementDemand(decodeRecord(event.settlement!)) === id) continue;
      end("void", placed(event));
    }
  }
  for (const forced of frontier.force) {
    if (forced.record.kind !== 6 || settlementDemand(forced.record) === id) continue;
    if (effectOf(forced.record).nfs.some(nf => tags.includes(tagOf(nf)))) end("void", forced.index);
  }
  // Its acceptances: K's strict signature, due no later than the demand, each at its first witnessed index.
  const found = new Map<string, WitnessedAcceptance>();
  for (const answer of frontier.answers) {
    const a = answer.acceptance;
    if (!same(a.demand, demand) || a.deadline > notice.deadline || !verifySignatureStrict(a.signature, acceptanceBytes(a), obligor)) continue;
    const key = hex(acceptanceId(a)), prior = found.get(key), taken = answer.release?.check === "TAKEN";
    if (prior === undefined) {
      found.set(key, { id: acceptanceId(a), owner: a.owner, deadline: a.deadline, witnessed: answer.index,
        timely: a.deadline - answer.index > lag, taken });
    } else if (taken && !prior.taken) found.set(key, { ...prior, taken });
  }
  const acceptances = [...found.values()];
  // The earliest end; at one index a settlement or withdrawal is named before a void.
  const ended = ends.reduce<End | undefined>((first, e) => first === undefined || e.at < first.at ? e : first, undefined);
  // Past the deadline and not yet ended: the holder's lapse where a timely acceptance stood unreleased, else the
  // backer's failure. Every timely acceptance is witnessed, and any release of it taken, by the deadline.
  const from = notice.deadline + 1n, through = ended === undefined || ended.at - 1n > t ? t : ended.at - 1n;
  const overdue = through >= from ? { reading: acceptances.some(a => a.timely && !a.taken) ? "lapse" as const : "dishonour" as const,
    from, through } : undefined;
  return { demand: new Uint8Array(demand), backing: new Uint8Array(notice.backing), quantity: notice.quantity, deadline: notice.deadline,
    witnessed, ended, overdue, acceptances };
}
