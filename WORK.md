# Current work

Updated: 2026-09-28

## Goal
The first v3 receiver capability (C4.1–5) is accepted: durable exact requests
through independently verified final fulfillment. Delivery is
[PR #29](https://github.com/mediumofexchange/reference-ts/pull/29), implementation
`ce888e7` from `9e7d430`. Random request identifiers persist before disclosure;
current canonical replay checks exact output/capsule and recovery spend/lock
effects before durable once-only acceptance. Exact request retry and historical
fulfillment lookup survive reopening. This is a local library capability;
authenticated transport, payer custody, backup/restoration and v2 retirement
remain later slice-6 milestones. Stop before those components or live operation.

## Status
- Persistence slice 5 merged as `9e7d430` (PR #28); all seven post-merge jobs
  passed in [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36352595201).
- Receiver design reviewed; no specification change or companion branch.
  The wallet rechecks every used venue range before its durable write, including
  same-index changes. Final fulfillment includes current forced spends and locks.
- Eleven focused receiver tests, typecheck, build and four abrupt COMMIT-boundary
  crash cases passed. Independent integrated adversarial review found no blocker.
- All seven full reference and v2/v3 proof jobs passed for `ce888e7` in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36379901554),
  including Node 20/24 Linux and Node 24 Windows full checks. The real-proof
  four-output payment uses the receiver's saved request and final fulfillment.
- The journal report is refreshed from the passing Linux artifact; all six
  current runtime reports' source bindings match. Final changes retain evidence
  and documentation only; runtime/check inputs reuse the passing baseline.
  Inspect PR #29 for merge revision and post-merge CI when resuming.
- V2 request/transport bytes remain frozen. This receiver does not retire them.

## Evidence
- Receiver API, caller obligations and test boundaries: [guide](docs/POOL_V3_WALLET.md).
  Local plaintext custody, one active copy, authenticated request delivery and
  independent evidence retention are preconditions; no physical-storage claim.
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

## Next
1. Continue slice 6: authenticated
   requests, payer reservations and exact pending statements, four-output selection
   with fees/funding disclosure, service, holder recovery, restoration and backup.
   Stay with this instance for the next adjacent wallet/service capability.
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
- No unresolved receiver review blocker; full wallet/service migration remains open.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
