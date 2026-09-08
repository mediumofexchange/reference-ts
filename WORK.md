# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Bring recovery and device/venue evidence
forward before freezing v3. This slice compares clock alternatives and
prepares material decisions; it does not select normative recovery policy.

## Status

- Implementation: `test/pool-fault-clock-choice`, based on `a8e68d8`
  (`fix/pool-fault-readers`); `main` remains at `6de607b`.
- Companion specification: `main` at `3676757`, unchanged. No v3 bytes fixed.
- Runtime remains v2. No `src/` behavior changed; PoolStore refuses silence
  clauses and recovery/presentation/wallet remain unimplemented there.
- **New safety blocker:** an unrelated non-carrying commitment can close X's
  gap and let its old segment finalize a spend already settled at the venue.
  Reproduced in the base recovery model and both fault-clock choices.
- [Decision proposal](docs/POOL_RECOVERY_RETURN_DECISION.md) gives the exact
  trace, conflicting specification passages, repair direction and costs,
  clock comparison and R6/R7 receipt/segment recommendations. None selected.
- The [fault proposal](docs/POOL_FAULT_RECOVERY_PROPOSAL.md) suspends adoption
  of A″ and corrects its prior unconditional receipt-abandonment claim.

## Completed

- Reader repair at `a8e68d8`: fresh evidence-relative validation, immutable
  original prefixes, per-read memoization, shared import/receipt/service
  checks and independent ideal observation. See [reader contract](docs/POOL_FAULT_READERS.md).
- Added opt-in `nonCarryingSilenceClosesInterval`: non-carrying checkpoints
  ignore silence lapse for the clock while retaining term lapse. Defaults
  unchanged. It removes R1's Y fault-history dependency but lets a stale Y
  stream suppress X's silence recovery; count and authorized replacement
  remain available. The option can affect later checkpoint finality.
- Preserved the inherited unsafe return and the alternative's additional
  lapsed-reset trigger as permanent counterexamples, with proper new-segment
  adoption controls. These passing counterexamples prove the bug exists.
- Independent design review recommends historical silence retirement plus
  the existing at-checkpoint gap guard; missing interval evidence must
  refuse. A new opening adopts through its own index. No repair implemented.
- R6 recommendation: retain existing receipt boundaries and separate fault
  evidence, accepting possibly indefinite pending. R7 recommendation:
  explicitly terminate the entire faulted segment, including stale twins,
  preserving earlier finality. Both require a maintainer decision.

## Evidence

- `model/pool-fault-clock.test.ts`: 13/13 focused comparisons passed.
- `model/pool-recovery-return.test.ts`: 8/8 focused cases passed: three unsafe
  valid-reset traces, three proper-return controls and two lapsed-reset cases.
- Independent adversarial review discovered and reproduced the safety bug
  with five probes, then reviewed the source option, comparisons and decision
  proposal. No additional blocker in that bounded review; no safety approval.
- Full `npm run check` passed: 81 files / 1,564 tests, docs/links, typecheck,
  build, installed package, pilot and pool-store crash checks. Final docs
  and diff checks passed. Disposable review probes were removed after
  capture in permanent tests and the decision proposal.
- No push, merge or PR is authorized in this session.

## Next

1. Obtain the maintainer's choice on the proposed intervening-silence rule.
   It should retire old continuation even after a non-carrying reset, retain
   the same-index gap guard, preserve earlier finality and require a new
   opening/adopted block. Specify receipt consequences at the same time.
2. Amend the normative contracts first on a named companion branch, then
   model the selected rule and independently review hostile continuation,
   same-index order, selective evidence, replacement and repeated gaps.
3. Revisit the clock and R6/R7 choices only after the return is safe. Do not
   consolidate FaultWorld into RecoveryWorld or fix v3 bytes before selection.
4. Continue deployment evidence: target phone benchmark, authenticated note
   delivery/restoration, complete evidence availability and pinned-node
   publication. Offline sizing in `docs/POOL_DEPLOYMENT_PROBES.md` is distinct
   from node acceptance. Then settle bounds/layouts and v3.

## Open questions

- Historical silence retirement and receipt consequences; clock dependency
  versus suppression cost; segment fault and receipt precedence; R8's fault
  certificate layouts and proof-variant continuity.
- Withheld preimages remain unresolved; retain proofs, issuance signatures,
  terms, ancestry and recoverable note openings. Interval completeness and
  scalable reader evidence are not solved by an ideal finite-record model.
- SQLite assumes one journal per key/venue; copied journals, rollback and
  custody/backup remain open. Custom synchronous venues lack a same-index
  generation token. Provenance, C2 re-derivation, history scaling, retention,
  note delivery, wallet restore and venue write acceptance remain gates.
