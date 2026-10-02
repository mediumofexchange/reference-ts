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
 * else standing (at or before its deadline) or, for a demand witnessed only once its deadline had come, no reading. */
export interface Presentation {
  readonly demand: Uint8Array;
  readonly backing: Uint8Array;
  readonly quantity: bigint;
  readonly deadline: bigint;
  /** The index the demand was first witnessed at, in history or by its publication with force. */
  readonly witnessed: bigint;
  /** Whether its deadline is strictly ahead of that index (C3.3). A demand first witnessed at or after its deadline
   * sets no term no acceptance could meet, a manufactured verdict (Construction §C3), so it reads neither dishonour
   * nor lapse; an operator that admits it at its door and witnesses it late cannot make one against K. */
  readonly inTerm: boolean;
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
  // Each end with its order within its index: a history event's namespace and position, a publication's venue order.
  const ends: (End & { readonly order: readonly bigint[] })[] = [];
  const history = (by: End["by"], event: StoredEvent): void => { ends.push({ by, at: placed(event), order: [0n, BigInt(event.ns), event.position] }); };
  const venue = (by: End["by"], at: bigint, i: number): void => { ends.push({ by, at, order: [1n, BigInt(i)] }); };
  if (kept?.end !== undefined) history(kept.end.kind === 6 ? "settlement" : "withdrawal", kept.end);
  // Forced publications through t, in venue order: the demand itself, its end, and settlements of other demands.
  for (const [i, forced] of frontier.force.entries()) {
    const effect = recoveryEffect(forced.record);
    if (effect.demand?.id === id) {
      notice ??= effect.demand.value;
      if (witnessed === undefined || forced.index < witnessed) witnessed = forced.index;
    } else if (effect.ended === id) venue(forced.record.kind === 6 ? "settlement" : "withdrawal", forced.index, i);
  }
  if (notice === undefined || witnessed === undefined || !same(notice.backing, backing)) return undefined;
  // C3.8's void: a tag of it spent otherwise than by its own settlement, from the index that spend was witnessed at.
  const tags = notice.tags.filter(tag => tag !== 0n);
  for (const tag of tags) {
    for (const event of state?.tagSpends(tag) ?? []) {
      if (event.kind === 6 && settlementDemand(decodeRecord(event.settlement!)) === id) continue;
      history("void", event);
    }
  }
  for (const [i, forced] of frontier.force.entries()) {
    if (forced.record.kind !== 6 || settlementDemand(forced.record) === id) continue;
    if (effectOf(forced.record).nfs.some(nf => tags.includes(tagOf(nf)))) venue("void", forced.index, i);
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
  // The earliest end: by index, then by its order there (history before the venue's publications at one index).
  const earlier = (a: (typeof ends)[number], b: (typeof ends)[number]): boolean => {
    if (a.at !== b.at) return a.at < b.at;
    for (let k = 0; k < a.order.length && k < b.order.length; k++) if (a.order[k] !== b.order[k]) return a.order[k]! < b.order[k]!;
    return false;
  };
  const first = ends.reduce<(typeof ends)[number] | undefined>((e, x) => e === undefined || earlier(x, e) ? x : e, undefined);
  const ended: End | undefined = first === undefined ? undefined : { by: first.by, at: first.at };
  // Past the deadline and not yet ended: the holder's lapse where a timely acceptance stood unreleased, else the
  // backer's failure. Every timely acceptance is witnessed, and any release of it taken, by the deadline.
  const inTerm = notice.deadline > witnessed;
  const from = notice.deadline + 1n, through = ended === undefined || ended.at - 1n > t ? t : ended.at - 1n;
  const overdue = inTerm && through >= from ? { reading: acceptances.some(a => a.timely && !a.taken) ? "lapse" as const : "dishonour" as const,
    from, through } : undefined;
  return { demand: new Uint8Array(demand), backing: new Uint8Array(notice.backing), quantity: notice.quantity, deadline: notice.deadline,
    witnessed, inTerm, ended, overdue, acceptances };
}
