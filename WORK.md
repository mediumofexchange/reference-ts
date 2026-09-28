# Current work

Updated: 2026-09-28

## Goal
Slice 6c on `feat/v3-reproof` (no companion branch or normative change): a
pending `V3Wallet` payment whose segment stopped being canonical (term end or
silence lapse; C1.2.5, C4.4) is re-proven in the canonical successor with the
same input nullifiers, outputs and capsules, so its reservation resolves instead
of staying permanent. Acceptance: `reprove` refuses while the saved segment is
canonical, resolves final/failed payments without proving, keeps superseded
records and receipts, and a submission racing a reproof cannot attach a stale
receipt; preparation and reproof refuse when the canonical segment's silence
clock refuses admission. Oracle tests cover takeover and silence return; the
crash check covers the reproof commit. Stop boundary: no release/cancellation
with other outputs, same-segment tail repair, multi-backing, transport or backup.
Slice 6b (PR #31) delivered paying: seed-scanned holdings, selection, exact
records with reservations, first matching receipt, final/failed `sync`.

## Status
- Commits `74f7a89` (wallet), `9ea0feb` (review fixes), `886cd1e` (concurrent
  retry fix), `b9ea5d3` (harness, docs). Independent adversarial review found two
  major issues (finality across succession, alias retry with another order) and
  five minor ones. All were fixed and read back, with regression tests that fail
  on the old code where deterministic.
- Oracle tests: 13 payer and 11 receiver cases; `check:pool:v3-wallet` passes six
  abrupt exits including payment before/after COMMIT. Real-proof `store-check.mjs`
  paid through the wallet over HTTP locally (14 checks, 5 proofs, before the last
  retry fix). Its fresh-process worker is now asynchronous: `spawnSync` blocked the
  in-process service, so an overdue keep-alive close raced the next fetch.
- PR #31 at `b9ea5d3`: all seven jobs passed in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36389184603)
  (Node 20/24 checks, v2 pool and v3 real-proof suites on Linux/Windows). A local
  re-record/`npm run check` chain was reaped under host memory pressure (2.3 of
  15.9 GB free), so the journal report is that run's Linux `--ergo` artifact; all
  six current reports match their bound sources. The delivery commit changes
  only this handoff and that report. V2 remains frozen.

## Evidence
- Wallet API, custody preconditions and payment limits: [guide](docs/POOL_V3_WALLET.md).
  Open silence clocks and published-but-not-yet-effective handovers are not
  refused before preparation; such inputs stay reserved until reproof/release.
- Service API and interrupted-operation limits: [guide](docs/POOL_V3_SERVICE.md).
- Persistence design and scalability plan:
  [decision](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox);
  full checkpoints still rewrite retained history and raw sections stay in memory.
- Current reports: [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json),
  [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json) and
  [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json).
  Live recovery is historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal at `2c6b20c`; header and mainnet reader reports at `6e4cea8`.

## Next
1. Continue slice 6: reproof of a pending payment after lapse or term end (same
   inputs and outputs in the successor segment, pool-fees C1.2.5) and an explicit
   open-silence-clock refusal before preparation. Reservations are permanent
   today; then authenticated receiver invitation transport, encrypted backup and
   restoration drills; port the remaining frozen v2 delivery/pairing/backup cases.
2. Retire v2 only after its wallet/service cases pass on v3; then
   multi-backing including compact fault orchestration (slice 7).
3. Configuration adoption: provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
4. Complete trails fit roughly 67 repeated spend-sized records in 1 MiB with
   existing dependencies (size-only probe); lifetime streaming is separate design.
5. On touching affected files: `local-replay.mjs` candidates should call
   `holdings.ts` (re-records six reports); fold `fulfill` into `sync`; shared
   byte helpers/caller ownership; Ergo section versus transaction charging; applyRecord history check follows effects;
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

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-28.
Payer custody adds the ordinary payment path, still within that rounding;
configuration adoption, reproof/transport/backup, multi-backing runtime,
qualified deployment storage and mainnet remain.
