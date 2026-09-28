# Current work

Updated: 2026-09-28

## Goal
Active: first v3 wallet capability on `feat/v3-wallet-receive`: durable exact
receiver requests through independently verified final fulfillment (C4.1–5).
Acceptance: persist random request identifiers before disclosure, exact retry
after reopen, no secret in payer requests, exact capsule/output matching,
current canonical replay including recovery force, duplicate-credit refusal,
owner fencing and durable evidence/fulfillment before acknowledgment. Port
hostile v2 receiver cases and exercise the real-proof journal flow. This is a
local library capability; authenticated transport, payer reservations/selection,
backup/restoration and v2 retirement remain later slice-6 milestones. Stop at
verified receiver acceptance; no live operation or physical-custody claim.

## Status
- Persistence slice 5 merged as `9e7d430` (PR #28); all seven post-merge jobs
  passed in [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36352595201).
- Receiver design reviewed; no specification change or companion branch.
  The wallet rechecks every used venue range before its durable write, including
  same-index changes. Final fulfillment includes current forced spends and locks.
- Eleven focused receiver tests, typecheck, build and four abrupt COMMIT-boundary
  crash cases passed. Independent integrated adversarial review found no blocker.
  Real-proof integration added; full CI and real-proof execution remain pending.
- V2 request/transport bytes remain frozen. This receiver does not retire them.

## Evidence
- Design, rejected alternatives, review correction and scalability plan:
  [persistence decision](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox).
  Usage/limits: [venue guide](docs/ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher).
- Full checkpoints rewrite/revalidate retained history. Raw sections stay in
  memory; retainedBytes still bounds objects only. Supplier quotas reset on process
  restart. Streaming disk rows and complete-index cursors retaining non-held
  records are planned scalability work. Uncertain writes poison the instance;
  reopen can recover an earlier committed view. Malicious rollback is not covered.
- Current reports: [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json),
  [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json) and
  [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json).
  They prove the existing runtime flows; process persistence is separate synthetic
  crash evidence. Live recovery remains historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  prior live journal/publisher at `2c6b20c`. Header and real-mainnet reader reports
  are historical at `6e4cea8` after their bound modules changed.
- Slice 4 merged at `6e4cea8`; all seven post-merge jobs passed in `36349234692`.

## Next
1. Finish receiver acceptance/review/delivery, then continue slice 6: authenticated
   requests, payer reservations and exact pending statements, four-output selection
   with fees/funding disclosure, service, holder recovery, restoration and backup.
2. Retire v2 only after its wallet/service cases pass on v3; then
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
- Full CI/real-proof acceptance and delivery remain pending.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
