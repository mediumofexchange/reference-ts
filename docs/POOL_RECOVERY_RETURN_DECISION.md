# Recovery return: safety finding and decisions to make

Status: historical-silence retirement and its receipt consequences approved
on 2026-09-08 and implemented in the model. The [durable decision](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)
records C2b.4.1/3 in companion specification `60af631`. Old continuation and
new adopted admissions lapse/refuse after intervening silence; earlier
finality and receipt liability survive. The old unsafe trace below now runs
under the explicit `forgetSilence` departure, beside repaired controls.
Fault-clock alternatives and R6/R7 remain unselected; runtime remains v2.

## Original investigation before the repair

The remainder preserves the original findings, proposal and verification
at the pre-repair revision. References below to an unselected return rule
or an unimplemented repair describe that earlier investigation.
The companion specification
is `money-from-first-principles` at `3676757` on `main`; runtime remains v2.
This investigation adds comparisons and counterexamples, not a recovery fix
or authority to deploy one. It follows the [fault review](../decisions/archive/2026-09-08-pool-fault-review.md)
and [reader repair](POOL_FAULT_READERS.md).

## A recovery interval can close without retiring the old segment

Independent adversarial review reproduced this trace in `RecoveryWorld`,
default `FaultWorld` (A″), and the new non-carrying silence-clock alternative.
All signatures and proofs are valid; no checkpoint exclusion is needed.

| Venue index | Event and observed result |
|---|---|
| 1 | P's X-only segment opens. X and Y separately declare a no-commitment duration of 5. |
| 2 | The X segment finalizes issuance of a note worth 10. It accepts an ordinary spend into its unfinalized tail. |
| 8 | X's gap is open. A valid demand and release settle that same note at the venue; both have force. |
| 9 | P opens an unrelated Y-only segment. Its valid commitment closes X's interval while importing and adopting nothing for X. |
| 10 | A hostile copy of the original X segment signs its old tail. The checkpoint finalizes the ordinary spend of the settled note. |

`model/pool-recovery-return.test.ts` preserves these **counterexamples to the
current rules**, including the semantic observer's `settled note spent again`
verdict. Passing a counterexample test demonstrates the bug; it does not
demonstrate safety. The segments must be disjoint: beginning with XY and then
changing to Y can make the old XY continuation stale for Y, hiding this bug.

There is also a differential case: open Y at 3, settle X at 9, publish a
silence-lapsed Y continuation at 10, then the old X continuation at 11. A″
passes the Y lapse and leaves X open, so the X continuation lapses. The new
clock alternative resets X and finalizes the conflicting spend. It expands
the trigger even though a valid unrelated opening already breaks the base.

## The exact specification conflict

In `pool-recovery.md`, C2b.6.1 says a non-carrying commitment:

> closes `b`'s interval while adopting nothing for it

C2b.4.1 says:

> An open gap is closed only by the **opening checkpoint** of a new segment

and defines the lapse condition as:

> Any other checkpoint witnessed while the gap of a backing in its scope is open is **lapsed for its whole scope**

C2b.3.2 promises:

> Force, once had, is not revoked by a later commitment

The literal current-index lapse check permits the trace after X's gap closes.
`RecoveryWorld.passedByRule` checks only the continuation's witnessing index.
`World.validateCheckpoint` still finds the last X finalized prefix current,
because Y carries no X. `RecoveryWorld.block` and `replayed` require adoption
only through the original X opening's index, so they omit the later release.
C2.10.9b's retirement after another segment carries a scoped backing does not
apply to the disjoint Y commitment.

The failure concerns finality, not merely the local service's refusal to
sign. A validator must reject the hostile continuation from the public
record. Closing the clock must not restore an authority to ignore force.

## Repair direction requiring a maintainer decision

The recommended invariant is: **once a scoped backing enters silence after
a segment's opening, that segment cannot resume canonical continuation;
return requires a new segment adopting the recovery block, even if an
unrelated commitment has since closed the clock.** Preserve every finalized
prefix before that boundary. A gap that already exists at a new opening's
own index is handled by its adopted block and must not retire the new opening
itself.

More precisely, keep the existing gap-at-checkpoint guard and additionally
lapse a non-opening checkpoint if some scoped backing had an open gap at an
index strictly after its segment's witnessed opening and strictly before
the candidate. The existing guard still matters for a continuation at the
opening's own index: it must lapse if the gap is open there, even though
the historical interval is empty. This predicate is proposed text to model,
not an approved rule.

This would generalize C2b.4.1's existing return requirement from the gap at
the checkpoint's index to an intervening gap. It needs an exact rule for
opening-index order, whole-scope lapse, imported state and reader evidence.
It changes no signed bytes in this slice. No implementation of that proposed
rule has been adopted or verified here.

Costs to resolve before adoption:

- Readers must establish whether an intervening gap occurred, including the
  authenticated clock evidence needed to prove resets. A cached local flag
  is insufficient; missing evidence must yield unresolved. Production must
  use authenticated record ranges rather than assume an unbounded scan.
- A gap retires the segment even if nobody published a release. A resumed
  operator must re-open and re-prove any unfinalized work for its whole scope.
- Receipt treatment must explicitly account for the silence boundary; the
  checkpoint-fault receipt recommendation below does not settle it.

Another direction is to allow continuation only after incorporating all
intervening publications with force. That would replace the fixed opening
adoption boundary with a moving one and require new ordering, replay and
proof rules. It is a larger change than enforcing the existing new-segment
return. Checking only for a release misses standing demands and withdrawals
that also have force. Forbidding every non-carrying clock reset is another
material change to the operator-wide clock; it should not be introduced as
an incidental fix.

The next approved slice should specify and adversarially model the selected
return rule before revisiting the clock choice or changing runtime code.

## Clock comparison after the reader repair

`model/pool-fault-clock.test.ts` contains 13 comparisons. The alternative
sets `nonCarryingSilenceClosesInterval`; default A″ is unchanged. Both still
exclude evidenced invalid carrying checkpoints and preserve term lapse.

| Question | A″ | Non-carrying silence reset alternative |
|---|---|---|
| XY opening 1, Y opening 2, bad Y checkpoint 3, Y continuation 8 | At 9, X's last reset is 3; Y's continuation lapses. | At 9, X's last reset is 8; Y's continuation still lapses canonically. |
| Withhold the bad Y proof | X's lapse/clock read is unresolved. | X's clock resolves without that history. |
| Withhold or mismatch the non-carrying scope/directory evidence | Unresolved. | Unresolved. The alternative still checks absence, scope and terms. |
| Term-lapsed non-carrying checkpoint | Does not reset X. | Does not reset X, even though event history is unnecessary. |
| Repeated silence-lapsed Y continuations | Do not reset X. | Can keep X's gap shut indefinitely; the request count remains available, but replacement still needs E's authority. |
| A release already having force before reset | Remains effective in a proper new-segment return. | Same. A later release outside the gap has no force. |
| Hostile original-segment return after a valid unrelated reset | Unsafe. | Unsafe; the alternative also permits a lapsed reset to trigger the failure. |

The comparisons also check strict-before clock indices, the duration's exact
threshold, adoption on a new XY opening, preservation of Y holdings, and a
second silence without duplicate settlement. These controls establish the
tested proper-return behavior, not the safety of arbitrary returns.

Neither clock option is recommended for adoption before the return repair.
The alternative removes the demonstrated other-scope silence dependency;
this is not a proof that every reader dependency is now bounded or isolated.

## Separate fault and receipt decisions

For R7, retain the proposed whole-segment fault rule explicitly including
stale twins: an authenticated excluded checkpoint ends future continuation
of that segment, preserving earlier finalized prefixes. This favors one
segment/one history over continued service by a healthy process sharing the
same segment with the faulty signer. It requires scope-wide restart and
reproof of unfinalized work. C2.10.6 alone does not select this rule.

For R6, the recommended first implementation retains C2.10.9a/b receipt
boundaries and treats the signed checkpoint fault as separate durable
evidence. Remove the earlier proposal's promise of immediate permanent
abandonment. A held excluded checkpoint still consumes its sequence; it is
not an inclusion, contradiction, canonical carrying transition or repair
hole. Missing evidence supplies no verdict.

| Trace after a receipt's referenced checkpoint | Existing-boundary result |
|---|---|
| Authenticated excluded checkpoint only | Pending receipt; separate signed fault evidence. |
| Later canonical carrying opening, no sequence hole | Abandoned at the carrying transition. |
| A real missing sequence before canonical repair | Lapsed under the repair rule. |
| A scoped term ends first | Lapsed at that boundary. |
| Earlier finalized inclusion | Finality remains; the later fault cannot reverse it. |

This costs accountability: a receipt may remain pending forever even though
its terminated segment can never finalize it. Lapse excuses the receipt's
unfinalized era, not the key's separately evidenced checkpoint fault. The
September 7 elective-scope decision rejected permanent pending there; this
tradeoff must be accepted explicitly rather than presented as a free repair.

Permanent fault abandonment is possible only with additional definitions.
Receipts have no witnessed signing timestamp; `after` may name the fault,
a later excluded checkpoint, or an unheld sequence. A proposed boundary
must specify its relation to earlier inclusion, contradiction, moved-past
lapse, repair and term end. An unconditional all-receipts rule does not do
so. Neither fault decision has been selected by this investigation.

## Verification of this research slice

Independent adversarial review reproduced the five unsafe/differential
traces, reviewed the clock option and comparisons, and checked the proposed
historical retirement predicate with its separate same-index guard. The
eight permanent return cases include three proper-return controls. No repair
was implemented, and review is not a safety approval for either clock.

Full `npm run check` passed: 81 test files / 1,564 tests, documentation links,
typecheck, build, installed-package checks, local pilot and pool-store crash
checks. The clock comparisons passed 13/13 and the return cases 8/8.
Disposable independent probes were removed after these results were captured.
