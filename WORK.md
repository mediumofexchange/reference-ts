# Current work

Updated: 2026-09-28

## Goal
Slice 6e delivered by PR #35 from `feat/v3-wallet-backup` (no companion branch or
normative change): the v3 wallet's two restoration paths
([decision](decisions/2026-09.md#2026-09-28--restore-the-v3-wallet-from-its-seed-or-an-encrypted-handoff-that-freezes-its-source),
[guide](docs/POOL_V3_WALLET.md#backup-and-restoration)). `V3Wallet.restoreSeed` (C4.6)
finds the same holdings, change included, with no local state (C4.2).
`exportBackup`/`restoreBackup` move the complete local state under a random key
and an independently kept digest (AES-256-GCM, domain and venue as associated data).
The export freezes the source in the same transaction. A restore is staged and then
hard-linked to a new destination. Acceptance: the v2 backup cases ported and passing,
continuation after restore (retries, reservations, submit, sync, reprove after takeover),
and export/import crash boundaries in `check:pool:v3-wallet`. Stop boundary: no
continuous backup, rollback protection, password KDF, streaming beyond 64 MiB,
physical custody or v2 retirement.

## Status
- Commits `d79df25` (feature, tests, crash drill), `881038e` (docs, decision),
  `b1e0c60` and `39a3c63` (review fixes). Independent adversarial review found no
  blocker or major issue. Its minor findings were resolved and read back: staged restore
  with link, options read once, freeze rechecked before proving, exact-DDL export check,
  wording, and zeroing. Remaining noted limits: hard links required, and a crash can
  leave a plaintext staging copy that must be deleted.
- Local: 44 wallet/payer/backup cases, typecheck and the twelve-exit crash drill pass.
  CI: all seven jobs passed at `39a3c63` ([run](https://github.com/mediumofexchange/reference-ts/actions/runs/36415773501));
  the journal report is its Linux artifact (only wallet sources changed) and all six current
  reports match their bound sources. Local full `npm run check` was not run; CI ran it.

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
1. Finish slice 6 by retiring v2. First inventory every remaining v2 wallet,
   service, real-proof, crash and store check against its v3 counterpart
   (backup, pairing and delivery are now mapped or ported). Port the gaps, then
   delete v2's `src/pool` modules, tests, scripts and reports (the plan's slice 6
   acceptance). Same-segment tail repair (C2.10.9a) and release of never-admitted
   inputs stay with cancellation in item 6 until a gate needs them.
2. Multi-backing, including compact fault orchestration (slice 7).
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
   Poseidon2 on Barretenberg and sponsored holder funding; operator fee quotes,
   a text/QR form of the request frame, receipt handoff for C4.5 pending
   acceptance, and routing store-check's request through the frame.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/`, `jdk/` and `ergo-headers/` under scratch.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- The separate archive node (`C:\Users\Bob\ergo-node`, outside this project) keeps
  syncing as a background job: 3 GB heap, below-normal priority (2026-09-28).
- Keep active verification logs until retained. Delete slice scratch after delivery;
  preserve legacy Temp/moeclean. Node management remains authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous
  recovery need separate provisioning authority. Configuration/mainnet remain disabled.

## Open questions
- No service delivery blocker remains. Server timeout followed by eventual
  journal completion has source review, without a direct timed acceptance case.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-28.
Payer custody, reproof, request exchange and backup/restoration complete the
single-backing wallet path, within that rounding; v2 retirement, configuration
adoption, multi-backing runtime, qualified deployment storage and mainnet remain.
