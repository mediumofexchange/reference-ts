# Current work

Updated: 2026-09-27

## Goal
Slice 3 of the [plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
has completed acceptance on `feat/v3-recovery`, from slice 2 `2c6b20c` ([PR #23](https://github.com/mediumofexchange/reference-ts/pull/23)).
Acceptance: real-proof redemption under service, disappearance with force from a holder's
package and venue alone, return with exact adoption, non-service counting, and missing-evidence
refusal. Run ported hostile cases, independent review, full checks and source-bound acceptance.
The [reviewed design](decisions/2026-09.md#2026-09-27--preserve-complete-recovery-evidence-and-share-the-force-transition)
retains complete bounded ancestry; imports do not reset lifetime evidence budgets.
Stop: no replacement drills, persistence, wallet custody, multi-backing or configuration adoption.
The authorized live recovery drill passed within its ten-transaction, 0.011 tERG fee
and 0.05 tERG total caps. Its allowance and slice 2's separate allowance are exhausted.

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
  separate reader regression walks all 128 held checkpoints. All seven CI jobs passed at
  `74eade8`: full checks on Node 20/24 and real-proof v2/v3 checks on Linux and Windows.
- Earlier local full runs had fixture/host-contention timeouts. Duplicate single-worker run
  was stopped after CI passed. No Java priority was changed and no verification job remains active.
- Local `run-v3-reports.ps1` completed: fourteen restoration checks and fresh GET-only runtime
  venue verification passed; both source-bound reports are refreshed and current.
- Real-proof local and synthetic recovery acceptance passed; reports retain the complete
  package and transaction measurements. Fresh public readers verify force and exact adoption.
- Gated live mode and narrow optional submission-budget callback passed independent source
  review and rebuilt offline hostile guard checks. The [live plan](docs/POOL_DEPLOYMENT_PROBES.md#reference-operator-journal)
  ran successfully within its caps; [live report](docs/pool-v3-recovery-store-testnet-verification.json)
  binds unchanged reviewed sources. A fresh process verified the retained public reader bundle.
- Reviewed implementation is `74eade8`, delivered through [PR #24](https://github.com/mediumofexchange/reference-ts/pull/24).
  [CI at a34a046](https://github.com/mediumofexchange/reference-ts/actions/runs/36328998544) passed all seven jobs.
  Delivery follow-up changes reports/docs only; docs/links and current source bindings passed.

## Evidence
- Slice 2 reports are historical at `2c6b20c` where recovery changes touch their source bindings:
  [live journal](docs/pool-v3-testnet-verification.json), [bundle readback](docs/pool-v3-testnet-reader-verification.json),
  [publisher](docs/ergo-publisher-verification.json). Earlier CI at
  [acc1ab7](https://github.com/mediumofexchange/reference-ts/actions/runs/36318895153) does not cover this patch.
- Refreshed current [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json) and
  [runtime venue](docs/ergo-runtime-venue-verification.json). Recovery reports:
  [local](docs/pool-v3-recovery-store-verification.json), [synthetic Ergo](docs/pool-v3-recovery-store-ergo-verification.json).
- Unchanged [testnet header](docs/ergo-testnet-header-verification.json) evidence pins upstream
  `23aabead`, legacy 45 s predictor, signed-Int overflow and terminal reset; no EIP-37 clamps.

## Next
1. Finish delivery through PR #24 after final CI; verify
   merge/main parity and remove merged branch and disposable slice scratch. No live job remains.
2. Begin slice 4 only after delivery. Prefer a fresh instance for the distinct succession scope;
   this handoff and the linked plan are sufficient startup context.
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
  `scratch/pool-v3-testnet-reader/` and `scratch/pool-v3-recovery-testnet-reader/` public bundles,
  `testnet-header-probe/`, `private-payment-crs/`,
  `jdk/` and `ergo-headers/`. Node management remains authorized.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Keep active verification logs until results are retained. Delete slice scratch only after
  delivery and only inside ignored scratch; preserve legacy Temp/moeclean.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority. Configuration approval and mainnet stay disabled.

## Open questions
- Live recovery and independent bundle acceptance passed; final merge/delivery remains open.
- No unresolved review findings; local/synthetic acceptance and required CI passed.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27:
single-backing recovery now shares reviewed runtime transitions and independent real-proof readers.
Replacement, configuration adoption, persistence, wallet custody and mainnet remain.
