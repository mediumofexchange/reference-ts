# Current work

Updated: 2026-09-27

## Goal
Slice 3 of the [plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
is active on `feat/v3-recovery`, from merged slice 2 `2c6b20c` ([PR #23](https://github.com/mediumofexchange/reference-ts/pull/23)).
Acceptance: real-proof redemption under service, disappearance with force from a holder's
package and venue alone, return with exact adoption, non-service counting, and missing-evidence
refusal. Run ported hostile cases, independent review, full checks and source-bound acceptance.
The [reviewed design](decisions/2026-09.md#2026-09-27--preserve-complete-recovery-evidence-and-share-the-force-transition)
retains complete bounded ancestry; imports do not reset lifetime evidence budgets.
Stop: no replacement drills, persistence, wallet custody, multi-backing or configuration adoption.
Live recovery needs a concrete plan and separate authorization; slice 2's seven authorized
testnet transactions are exhausted. No new live transactions have been made.

## Status
- Runtime: demand/withdrawal/settlement admission and witnesses; fixed-anchor publication force;
  promoted import/package/receipt/non-service readers; journal witnessed retirement, empty return,
  actual-opening-index adoption and complete evidence packages; kind-4 Ergo output runs.
- Integrated adversarial review and critical-fix readback passed. Fixes reserve checkpoint/event
  work including imported ancestry and known future request counts; adoption budgets current
  evidence while deriving the historical exact block; return reserves two checkpoints.
  Publisher rejects signed transactions over the pinned node's 98,304-byte ceiling.
- Focused force, witness, recovery journal, publisher and request-work tests passed. The
  128-checkpoint journal regression now restores 128 genuine signatures and passes; the
  separate reader regression walks all 128 held checkpoints. Full verification remains open.
- Earlier full runs had superseded fixture failures/RPC timeouts. Corrected checkpoint fixture
  passes. `run-v3-clean.ps1` (PID 17652) has an unchanged sequencing-model timeout under CPU
  contention; await `v3-clean.exit`. No Java priority was changed: busiest node is outside workspace.
- Final job `scratch/run-v3-serial.ps1` (PID 7504, `v3-serial.log/.exit`) waits for that exit,
  then runs every full-check stage with one Vitest worker (same assertions/timeouts), real-proof
  v3, restoration and GET-only runtime venue refresh. Earlier delivery/focused/final/acceptance
  jobs ended. No complete final pass or real-proof recovery report yet.
- Real-proof recovery acceptance is `scripts/pool/v3/recovery-store-check.mjs`, local and
  `--ergo`; its reports are not yet generated. No live acceptance claim.
- Gated live mode and narrow optional submission-budget callback passed independent source
  review; offline guard awaits rebuilt dist. Preliminary plan: ten transactions,
  total funding cap 0.05 tERG; confirm against measured synthetic results before authorization.
- No companion branch or normative change. No commits or push of this patch yet.

## Evidence
- Slice 2 reports are historical at `2c6b20c` where recovery changes touch their source bindings:
  [live journal](docs/pool-v3-testnet-verification.json), [bundle readback](docs/pool-v3-testnet-reader-verification.json),
  [publisher](docs/ergo-publisher-verification.json). Earlier CI at
  [acc1ab7](https://github.com/mediumofexchange/reference-ts/actions/runs/36318895153) does not cover this patch.
- Re-record affected current [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json) and
  [runtime venue](docs/ergo-runtime-venue-verification.json); run `check:evidence`.
- Unchanged [testnet header](docs/ergo-testnet-header-verification.json) evidence pins upstream
  `23aabead`, legacy 45 s predictor, signed-Int overflow and terminal reset; no EIP-37 clamps.

## Next
1. Finish focused regression, real-proof local/synthetic and full acceptance; resolve failures,
   refresh reports/docs and review live runner. Then present exact live plan for authorization.
2. Complete live single-backing recovery and holder-only readback after separate authorization.
   Deliver slice only after acceptance, reviewed final patch, CI and merge verification.
3. Succession/hostile operator: replacement/takeover, equivocation, key compromise.
4. Persistence: venue headers/objects beyond retainedBytes, prune side branches, publisher outbox,
   restart drills; replace journal full-range reads per operation with a cursor.
5. V3 wallet/service (C4.1–2 requests/funding disclosure), retire v2; multi-backing recovery/counts.
6. Configuration adoption: parameter provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate funds authority.
7. Complete trails currently permit roughly 67 repeated spend-sized records in 1 MiB with existing
   dependencies (size-only probe); lifetime streaming verification remains a separate design.
8. On touching affected files: local byte predicates → bytes.ts; hand-parsed v3 codecs →
   ByteReader/Writer; verify caller ownership; Ergo section-vs-transaction byte charging;
   applyRecord history check follows effects; served-trail caller-object cache;
   heldCommitments hides a twin at held sequence (slice 4). Check v3 successors for v2 intake issues.
9. Only when a gate needs them: abandoned publication cancellation, batching, index-free box
   source, venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes remain running under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up; slice 2 ~19,999.88 tERG), public
  `scratch/pool-v3-testnet-reader/` bundle, `testnet-header-probe/`, `private-payment-crs/`,
  `jdk/` and `ergo-headers/`. Node management remains authorized.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Keep active verification logs until results are retained. Delete slice scratch only after
  delivery and only inside ignored scratch; preserve legacy Temp/moeclean.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority. Configuration approval and mainnet stay disabled.

## Open questions
- Live recovery authorization outstanding; runtime acceptance and final delivery still open.
- No blockers from independent runtime source review; test/proof evidence remains required.

Roughly **55% done / 45% remaining**, plausible range **45–65%**, reassessed 2026-09-27 (slice 2).
Runtime recovery verification, configuration adoption, persistence, wallet custody and mainnet
remain consequential; reassess after accepted slice 3 evidence, not implementation alone.
