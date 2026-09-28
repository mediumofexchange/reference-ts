# Current work

Updated: 2026-09-28

## Goal
Slice 6c delivered by PR #32 from `feat/v3-reproof` (no companion branch or
normative change): a pending `V3Wallet` payment whose segment stopped being
canonical (term end or silence lapse) is re-proven by `reprove` in the canonical
successor with the same input nullifiers, outputs, capsules and order (pool-fees
C1.2.5, C4.4), so its reservation resolves instead of staying permanent. Final or
failed payments resolve without proving; superseded records and receipts
(including one racing the reproof) are kept; a lagging venue view is refused.
Preparation and reproof refuse an ended term (`CONFLICT`) or a silence clock
that closes admission (`SILENCE`, the journal's own rule). Stop boundary kept:
no cancellation/release with other outputs, same-segment tail repair,
multi-backing, transport or backup. Wallet profile is now `moe/wallet/v3/2`.

## Status
- Commits `b963013` (reproof, silence refusal, crash case, docs) and `ff5bbdb`
  (review fixes). Independent adversarial review found no blocker/major; four
  minor findings (racing receipt dropped, lagging view could move a record back,
  no venue recheck before proving, stuck payments looked live) were fixed with
  tests; the lagging-view test fails with its guard disabled.
- Oracle tests: 16 payer and 11 receiver cases; `check:pool:v3-wallet` passes
  eight abrupt exits including reproof before/after COMMIT. Reproof is not run
  under real proofs; the succession check proves a successor-segment spend of
  inherited notes, which is the same relation instance shape.
- Local full `npm run check` and real-proof re-recording were not run (host at
  ~0.9 of 15.9 GB free, 5.8 GB held by the archive node). PR #32 at `ff5bbdb`:
  all seven jobs passed in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36397521221);
  the journal report is its Linux `--ergo` artifact and all six current reports
  match their bound sources. The delivery commit changes only docs and that report.

## Evidence
- Wallet API, custody preconditions, reproof and payment limits: [guide](docs/POOL_V3_WALLET.md).
  Published-but-not-yet-effective handovers are not predicted; reproof resolves them.
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
1. Continue slice 6: authenticated receiver invitation transport, then encrypted
   backup and restoration drills; port the remaining frozen v2 delivery/pairing/
   backup cases. Same-segment tail repair (C2.10.9a resubmission) and release of
   never-admitted inputs stay with cancellation in item 6 until a gate needs them.
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
Payer custody and reproof add the ordinary payment path, within that rounding;
configuration adoption, transport/backup, multi-backing runtime,
qualified deployment storage and mainnet remain.
