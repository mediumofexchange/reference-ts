# Current work

Updated: 2026-09-27

## Goal
Slice 5's bounded process persistence acceptance is complete; delivery is
[PR #28](https://github.com/mediumofexchange/reference-ts/pull/28), implementation
`f8fb78a` from `6e4cea8`. Synthetic restarts reproduce exact witnessed ranges,
continue sync and preserve exact signed publication retries in the owning outbox.
Complete section evidence retains non-held records; deep-side pruning preserves
budget-stopped fork continuation and durable finality failure. Independent review
passed. Stop before wallet redesign or live runs.

## Status
- Runtime implemented: optional `ErgoVenueJournal`, revalidated headers/sections,
  durable pin/failure, protected incomplete forks, publisher full-state persistence
  via `V3OperatorJournal.publisherPersistence()` and one-time venue attachment.
- Independent design/integrated review passed after fixes for incomplete fork
  pruning, raw-header/ID handling and reuse of one outbox adapter by two publishers.
  No unresolved review blocker. No specification change or companion branch.
- All seven full reference and v2/v3 proof jobs passed for `f8fb78a` in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36351105871).
  This includes Node 20/24 Linux and Node 24 Windows full checks. Clean CI
  supersedes a local Vitest RPC timeout; the redundant local full run was stopped.
- `npm run check:ergo-persistence` passed 11 fresh-process synthetic stages:
  mid-sync, before/after commit, lost submission reply/exact retry and terminal
  failure. No proof, physical power-loss or live-operation claim.
- Six affected reports are refreshed from the passing Linux artifact; all their
  source bindings match. Final changes only retain reports and correct documentation;
  runtime/check inputs reuse the passing baseline. No active local job or companion
  branch. Inspect PR #28 for merge revision and post-merge CI when resuming.

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
1. Begin v3 wallet/service (C4.1–2 requests/funding disclosure) with a focused
   inventory of reusable v2 custody/transport and acceptance cases. Port a complete
   request-to-fulfillment capability, preserving reference guards and exact retry.
   Recommend a fresh instance for this new component boundary.
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
- No unresolved design/review finding; disk streaming and physical custody remain
  explicit later boundaries, not missing process-restart acceptance.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27.
Persistence adds reusable process recovery; configuration adoption, wallet custody,
multi-backing runtime, qualified deployment storage and mainnet remain.
