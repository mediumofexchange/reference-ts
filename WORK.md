# Current work

Updated: 2026-09-28

## Goal
Review-code pass over main since `3b9db9f` plus slice 6f's v2 deletion (PR #37,
merged `8cf66cb`; slice 6f delivered). Acceptance: each confirmed defect fixed with a
regression test on `fix/review-code-2026-09-28`, independently reviewed, CI green, seven
current v3 reports re-recorded from CI, deferred findings in Next. No new features.

## Status
- Six read-only lanes reviewed Ergo reading, Ergo publishing, v3 state/reader, the
  operator journal, wallet/service and evidence/spec agreement. Fixed, with tests: a
  supplier repeating the anchor made the durable Ergo view unopenable (`ergo.ts`); one
  supplier claiming every transaction stopped resends to honest nodes
  (`ergo-publisher.ts`); a committed kind-7 record left reads unresolved instead of
  failing replay (`state.ts`, check `KIND`); sync throws and caller errors in the
  publish path; stale Ergo, v2 and wallet docs. Refuted: wrong-length proofs verify false.
- **Open:** after the fix review and CI, `gh run download <run> -n
  pool-v3-reports-ubuntu-latest -D scratch/ci-artifact`; copy `scratch/pool-v3-results.json`,
  `pool-v3-store-results.json` and `pool-v3-local-replay-results.json` to
  `docs/pool-v3-{conformance,store,local-replay}-verification.json` and the four `docs/`
  recovery/succession ones as they are; `npm run build && npm run check:evidence` must
  show all seven current; commit, CI, merge, delete the branch/worktree/`scratch/review-*`.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md),
  [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
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
   retired browser probe) at the next dependency change. Untested on v3: a second
   commit refused while one is in flight (`store.ts` `ready`; a probe traced it holding);
   `IMPORT_RANK` holds by construction (held commitments arrive in order).
5. Review findings deferred 2026-09-28: (a) `guard.ts` accepts a testnet-context
   profile anchored on a mainnet header, which the header store follows until the next
   epoch boundary (<=127 blocks); `testnet.mjs` checks `/info` network, so only a new
   caller is exposed; fix by a difficulty bound like the synthetic one or a testnet
   context long enough to check its last boundary. (b) `store.ts` `package()` serves a
   published commitment never held after the lag (C2.4.3). (c) `store.ts` `submit` may
   return an old-segment receipt for an adopted forced record (traced only). (d) Ergo
   reports bind pool-v3 `786f962` but no `venue-ergo.md` revision; the CRS is unbound.
   (e) ErgoVenue's side-branch quota never resets. (f) Wallet `prepare`/`reprove` read
   `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit.
6. Only when a gate needs them: cancellation, batching, index-free box source,
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
- 2026-09-28, non-blocking: `site/index.html` says the wallet and external witness
  write side "remain to be built"; the v3 wallet, single-backing recovery and Ergo
  publication exist as unadopted candidates. A site push is live deployment, so it
  needs authorization: edit that sentence to e.g. "Single-backing recovery, a
  seed-restorable wallet and Ergo publication run as unadopted candidates;
  configuration adoption and multi-backing remain." and push `site` main.
- No service delivery blocker remains. Server timeout followed by eventual
  journal completion has source review, without a direct timed acceptance case.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-28.
The single-backing wallet path is complete and v2 is retired, within that rounding;
configuration adoption, multi-backing runtime, qualified deployment storage and mainnet remain.
