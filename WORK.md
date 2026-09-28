# Current work

Updated: 2026-09-28

## Goal
Slice 6f, retire v2, on `feat/retire-v2` (no companion branch or normative change;
[decision and case map](decisions/2026-09.md#2026-09-28--retire-v2-against-a-case-map-of-its-checks)).
M1, delivered by this branch's PR: every remaining v2 wallet, service, real-proof, crash
and store check mapped by behavior to a v3 case, a v2-only mechanism or a later slice,
and the gaps ported. M2, next: delete v2 (Next 1). Acceptance for the slice: `npm run
check` and CI `check:pool:v3 -- --ergo` pass without v2, docs agree, the `ErgoVenue`
face removal reviewed. Stop boundary: no transparent-path retirement, multi-backing or adoption.

## Status
- M1 commits: `765a6e4` (journal crash drill `check:pool:v3-journal`, receipt crash
  boundary, journal refusals, truthy-verifier and cross-backing cases, verifier test on
  the shared module) and `a020215` (range opcodes on all six relations, ten type-escape
  attacks with the range-removed control, malformed proofs through `proofVerifier`).
- Local: typecheck, focused vitest files, the fourteen-exit wallet and six-exit journal
  drills, and `scripts/pool/v3/check.mjs` (335 checks, 18 recorded proofs) pass. The six
  current reports still match their bound sources. Tests and tooling only: focused
  self-review of the delegated circuit port; no runtime source changed. Full vitest: 2246
  pass (exit 1 only from the low-memory worker-RPC flake). **Open:** PR #36 CI was pending
  when the run's watcher was reaped for low memory; next run: `gh pr checks 36`, merge if
  green (fix and push if not), delete the branch, then start M2 on a fresh branch.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md) (reproof resolves unpredicted handovers),
  [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json) and
  [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json).
  Live recovery is historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal at `2c6b20c`; header and mainnet reader reports at `6e4cea8`.

## Next
1. M2, delete v2 (one branch, then review of the ErgoVenue change):
   - `scripts/pool/v3/check.mjs`: read toolchain and helper pins from
     `candidate-manifest.json`, not `src/pool/circuits/manifest.json`; keep
     `scripts/pool/{constraints,fixtures,prepare-crs}.mjs`; fix the comment in
     `src/pool/proof-verifier.ts` naming `scripts/pool/check.mjs`.
   - Delete `src/pool/` except `field`, `poseidon2`, `notes`, `note-tree`,
     `scope`, `schedule`, `proof-verifier`, `v3/` and `circuits/vendor/`; the
     v2 tests (`pool-*` without v3 successors, `pool-support.ts`,
     `pool-record-support.ts`, `model/pool-fault-evidence.test.ts`); v2 scripts
     (`pool/{check,admission,compile,store-crash*}`, `browser`, `service`,
     `wallet`, `local`, `delivery`, `spent-set`, `scripts/compile-noir.mjs`);
     their package scripts, CI `pool` job and device-storage step.
   - Keep v3's bytes distinct from v2's in `pool-v3-headers`/`records` tests by
     tag, not by the v2 decoder. `ErgoVenue` drops its transparent `Venue` face
     (`ergo-venue.test.ts` PoolAuthorityView cases, `ergo-publisher.test.ts` type).
   - Package: root barrel exports the shared primitives; v3 stays on subpaths;
     `check-package.mjs` imports `pool/v3/store`; `files` keeps the vendor helper.
   - Docs: retire the v2 guides (POOL_{SERVICE,STORE,WALLET*,LOCAL_PROFILE,RECEIPTS})
     and v2 reports as permalinks at `a020215`; update README, AGENTS.md (v2 freeze,
     check table), IMPLEMENTATION_STATUS, architecture map, PROTOCOL_RULES rows,
     PRODUCTION_REQUIREMENTS. `backing.ts`/`contexts.ts` keep v2 names (transparent
     path, reserved tags). Same-segment repair and cancellation stay in item 6.
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
