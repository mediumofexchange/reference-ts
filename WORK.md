# Current work

Updated: 2026-09-27

## Goal
Slice 5: durable reference venue and exact publisher retry on `feat/v3-persistence`,
from `6e4cea8` ([slice 4 delivery](https://github.com/mediumofexchange/reference-ts/pull/27)).
Acceptance: synthetic restart reproduces exact witnessed ranges and continues sync;
interrupted sync/publication preserves atomic snapshots and exact signed retries.
Retain reproducing sections and all objects, including non-held commitments;
prune completed deep side paths without losing budget-stopped fork continuation.
Reuse the owning journal's fenced outbox. Stop before wallet redesign or live runs.

## Status
- Runtime implemented: optional `ErgoVenueJournal`, revalidated headers/sections,
  durable pin/failure, protected incomplete forks, publisher full-state persistence
  via `V3OperatorJournal.publisherPersistence()` and one-time venue attachment.
- Independent design/integrated review passed after fixes for incomplete fork
  pruning, raw-header/ID handling and reuse of one outbox adapter by two publishers.
  No unresolved review blocker. No specification change or companion branch.
- Node 24 typecheck passes. Publisher/journal: 58 focused cases plus final
  adapter-reuse regression pass. Venue/header regression: all 74 assertions passed,
  but the test process reported a Vitest worker RPC timeout; this is not a clean
  passing run. Full final verification remains required.
- `npm run check:ergo-persistence` passed 11 fresh-process synthetic stages:
  mid-sync, before/after commit, lost submission reply/exact retry and terminal
  failure. No proof, physical power-loss or live-operation claim.
- Final verification job planned: `scratch/persistence-check.ps1`, output
  `scratch/persistence-check.log`, completion `scratch/persistence-check.exit`.
  Do not edit runtime/check inputs while it runs. No companion branch.

## Evidence
- Design, rejected alternatives, review correction and scalability plan:
  [persistence decision](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox).
  Usage/limits: [venue guide](docs/ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher).
- Full checkpoints rewrite/revalidate retained history. Raw sections stay in
  memory; retainedBytes still bounds objects only. Supplier quotas reset on process
  restart. Streaming disk rows and complete-index cursors retaining non-held
  records are planned scalability work. Uncertain writes poison the instance;
  reopen can recover an earlier committed view. Malicious rollback is not covered.
- Publisher restore verifies exact signed transaction consistency; individual
  historical input values/heights rely on local journal integrity. Corruption can
  impair rebuild availability, not alter a network-accepted payment.
- Pre-slice current reports bind `6e4cea8` or earlier inputs. Refresh affected
  reports from final passing CI, or cite their historical revision; do not describe
  old bindings as current. Live recovery remains historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  prior live journal/publisher at `2c6b20c`. Testnet header evidence is unchanged.
- Slice 3 and 4 delivered single-backing recovery, succession and compact faults;
  last full pre-slice proof baseline `ededc97` passed seven jobs in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36347810739).
  Merge `6e4cea8` post-merge run is `36349234692`; check its final status.

## Next
1. Finish final full checks, refresh affected evidence, verify review readback,
   commit/push PR, inspect required CI, merge, verify parity and clean scratch.
2. V3 wallet/service (C4.1–2 requests/funding disclosure), retire v2; then
   multi-backing including compact fault orchestration (slice 7).
3. Configuration adoption: provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
4. Complete trails fit roughly 67 repeated spend-sized records in 1 MiB with
   existing dependencies (size-only probe); lifetime streaming is separate design.
5. On touching affected files: shared byte helpers/caller ownership; Ergo section
   versus transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache. Check v3 successors for v2 intake issues.
6. Only when a gate needs them: cancellation, batching, index-free box source,
   venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/`, `jdk/` and `ergo-headers/` under scratch.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Keep active verification logs until retained. Delete slice scratch after delivery;
  preserve legacy Temp/moeclean. Node management remains authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous
  recovery need separate provisioning authority. Configuration/mainnet remain disabled.

## Open questions
- No unresolved design/review finding. Final acceptance and delivery remain open.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
