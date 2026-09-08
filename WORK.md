# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Historical-silence return and its receipt
consequences are repaired in the specification and model; runtime and v3 remain next.
The maintainer approved the recommendation and authorized merge/push.

## Status

- Implementation: `main`, fast-forwarded through `0464e38` from
  `fix/pool-silence-retirement`, based on `fc343e4`.
- Companion: `main` at `c5f5464` (rule `60af631`), merged and pushed from
  `spec/pool-silence-retirement`. The normative contract was committed first.
- [Decision](decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts):
  C2b.4.1/3 retires continuation at the first scoped gap strictly after the
  witnessed opening. Later clock resets cannot restore it. A same-index
  non-opening checkpoint still lapses in a current gap.
- Receipt walks end at the earlier actual silence/term boundary. Earlier
  inclusion, contradiction and abandonment survive; other receipts lapse,
  including held, unheld and post-gap references. No signing time is inferred.
- Return requires a fresh opening and complete adoption through its own index.
  New ordinary and adopted admissions refuse retired segments. Exact receipt
  retry and historical finalized imports remain available.
- Runtime remains v2: no `src/`, circuit, layout or dependency changes.
  PoolStore still refuses silence clauses. Fault-clock alternatives and R6/R7
  remain unselected research policies; this slice does not adopt FaultWorld.

## Evidence

- Affected suite passed: 7 files / 200 tests, including 19 silence-boundary
  cases and 16 return cases across the base and both fault-clock choices.
- Original unsafe returns remain under `forgetSilence`; corrected controls
  reject the settled note's old spend and preserve proper return adoption.
- Independent design/adversarial review found a delayed-adoption bypass after
  a second gap. Fixed and captured permanently, including historical import
  and exact receipt retry. No remaining blocker in the bounded model/spec review.
- Independent interval oracle compared 96 reset schedules against exhaustive
  gap-index evaluation; 3/3 probes passed and disposable probes were removed.
- Full `npm run check` passed: 82 files / 1,591 tests, typecheck, build,
  installed package, pilot and pool-store crash checks. Documentation and
  diff checks passed in both repositories. Vitest required Windows sandbox
  escalation for esbuild configuration access.

## Next

1. Revisit invalid-checkpoint recovery, clock dependencies/suppression and
   R6/R7 fault receipt/segment policy. Do not consolidate FaultWorld into the
   normative model or freeze v3 bytes before those choices are resolved.
2. Continue deployment evidence: target phone benchmark, authenticated note
   delivery/restoration, complete evidence availability and pinned-node
   publication. Offline sizes are not node acceptance; see
   [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md).

## Open questions

- Authenticated complete interval evidence and scalable historical reads are
  still required in production; the ideal finite model supplies neither.
- Fault certificate layouts, proof-variant continuity, withheld preimages,
  replica retention, note delivery and wallet restoration remain open.
- SQLite assumes one journal per key/venue; copied journals, rollback and
  custody/backup remain open. Custom synchronous venues lack a same-index
  generation token. Provenance, C2 re-derivation and venue write acceptance
  remain release gates.
