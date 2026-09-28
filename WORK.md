# Current work

Updated: 2026-09-28

## Goal
Continue slice 6 after the accepted loopback v3 service: authenticated receiver
request delivery, payer custody and complete ordinary payment. The service now
transports submit/commit/publish and published evidence over the existing journal;
independent receiver replay establishes fulfillment. Payer reservations, receiver
invitations, restoration, public deployment and v2 retirement remain outside this
delivered capability. No normative change or companion branch.

## Status
- Service PR #30: implementation `b0622b1`, final timeout assertion `3ceb307`.
  All seven jobs passed in [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36383083132):
  Node 20/24 checks and Linux/Windows real-proof suites. Independent design and
  integrated adversarial review found no blockers. Focused tests and separate
  processes cover changed-proof retry, lost completed reply, restart and fencing.
- The delivery commit changes only this handoff, specification links and the
  retained Linux journal report; it reuses that unchanged runtime/test baseline.
  All six current reports match their bound sources. No local job remains.
  Inspect the latest main CI on resume; delivery does not preclaim its result.
  V2 modules and wire profiles remain frozen.

## Evidence
- Service API, independent authority and interrupted-operation limits:
  [guide](docs/POOL_V3_SERVICE.md). Separate-process acceptance uses oracle proofs;
  real-proof HTTP acceptance passed through the journal harness on both platforms.
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
1. Continue slice 6: authenticated receiver requests, payer reservations and exact
   pending statements, four-output selection with fees/funding disclosure, holder
   recovery, restoration and backup. Start with the authenticated request and
   saved payer-statement boundary; port relevant frozen v2 cases.
   Stay with this instance for the next adjacent payer/receiver capability.
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
- No service delivery blocker remains. Server timeout followed by eventual
  journal completion has source review, without a direct timed acceptance case.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
