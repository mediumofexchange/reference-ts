# Current work

Updated: 2026-09-28

## Goal
Slice 6f, retire v2 (no companion branch or normative change;
[decision and case map](decisions/2026-09.md#2026-09-28--retire-v2-against-a-case-map-of-its-checks)).
M1 (PR #36, merged `0182d36`) mapped every v2 check and ported the gaps. M2, on
`feat/delete-v2`: delete v2. Acceptance: `npm run check` and CI `check:pool:v3 -- --ergo`
pass without v2, docs agree, the `ErgoVenue` face removal independently reviewed, the six
current v3 reports re-recorded. Stop boundary: no transparent-path retirement,
multi-backing or adoption.

## Status
- `9c8b353` deletes the v2 runtime, circuits, tests, harnesses, package scripts, CI `pool`
  job and device-storage step; `ErgoVenue` keeps only `RecordVenue`/`RecordPublisher`
  and its tests read range answers through `record-range.ts`; the package ships `dist`
  only; `scripts/pool/v3/check.mjs` reads `candidate-manifest.json`; the evidence reader
  moved to `scripts/pool/v3/`. A docs commit retires the v2 guides and five v2 reports as
  permalinks at `a020215` and updates README (runtime pin `01d8db2`), AGENTS.md, status,
  architecture, rules, requirements and fault guide.
- Local: typecheck and the affected tests (156) pass; low memory (~2 GB) rules out a full
  local run, so CI is the acceptance run.
- Review: an independent adversarial review of `9c8b353` found nothing blocking; its doc,
  comment and test notes are applied in the docs commit.
- **Open:** PR #37 CI was pending when its watcher was reaped for low memory. Next run:
  `gh pr checks 37`; fix any failure; when green, `gh run download <run> -n
  pool-v3-reports-ubuntu-latest -D scratch/ci-artifact`, copy `scratch/pool-v3-store-results.json`
  and `pool-v3-local-replay-results.json` to `docs/pool-v3-store-verification.json` and
  `docs/pool-v3-local-replay-verification.json`, take the four recovery/succession
  `docs/` reports as they are, confirm with `npm run check:evidence` that the six match,
  commit, wait for CI, merge, delete the branch and `scratch/ci-artifact`.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md),
  [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json) and
  [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json).
  Live recovery is historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal at `2c6b20c`; header and mainnet reader reports at `6e4cea8`.
  Pool-v2 and its guides/reports: [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Multi-backing, including compact fault orchestration (slice 7).
2. Configuration adoption: provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
3. Complete trails fit roughly 67 repeated spend-sized records in 1 MiB with
   existing dependencies (size-only probe); lifetime streaming is separate design.
4. On touching affected files: `local-replay.mjs` candidates should call
   `holdings.ts` (re-records six reports); fold `fulfill` into `sync`; shared
   byte helpers/caller ownership; Ergo section versus transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache; drop the explicit `vite` dev pin (served the
   retired browser probe) at the next dependency change. Untested on v3 (source holds
   them): a second commit refused while one is in flight (`store.ts` `ready`), and
   `IMPORT_RANK` (`import-reader.ts`).
5. Only when a gate needs them: cancellation, batching, index-free box source,
   venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding; operator fee quotes,
   a text/QR form of the request frame, receipt handoff for C4.5 pending
   acceptance, routing store-check's request through the frame, and same-segment
   repair/rescoping.

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
The single-backing wallet path is complete and v2 is retired, within that rounding;
configuration adoption, multi-backing runtime, qualified deployment storage and mainnet remain.
