# Current work

Updated: 2026-09-28

## Goal
Active on `feat/v3-service`: loopback v3 submit/commit/publish and public-package
transport over the existing journal. Acceptance: distinct operation credentials,
bounded strict envelopes, caller-bound signed replies, complete package retrieval
followed by independent receiver fulfillment, lost-reply exact retry and fresh
service restart/fencing. Port relevant v2 HTTP/client/process cases and use the
real-proof four-output flow. Stop before payer custody, receiver invitation
transport, public deployment, restoration or v2 retirement. No normative change.

## Status
- Receiver PR #29 merged at `ee6da22`; all seven implementation jobs passed in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36379901554).
  Post-merge run `36381443864` also passed.
- Service design and independent integrated review found no blockers. All 17
  focused wire/HTTP/client tests, typecheck, build, separate-process acceptance
  and docs checks passed. Full CI and refreshed real-proof journal report owed.
  No companion branch or local job. V2 modules and wire profiles remain frozen.

## Evidence
- Service API, independent authority and interrupted-operation limits:
  [guide](docs/POOL_V3_SERVICE.md). Separate-process acceptance uses oracle proofs;
  real-proof HTTP acceptance is integrated into the journal harness for CI.
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
1. Deliver the local service, then continue slice 6: authenticated receiver
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
- Full CI and source-bound real-proof service acceptance remain pending.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
