# Current work

Updated: 2026-09-29

## Goal
Slice 8 (adoption), M5b: every party's memory independent of history
([storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
*Acceptance (whole M5b):* memory flat on a ≥10⁵-statement stub run; resumed and
incremental verdicts equal full replay, and corrupt kept state falls back; real proofs past
the old ceiling through journal, wallet sync and offline-operator recovery; first sync
measured against 24 h; reports re-recorded. *Stop:* M5b.6 (milestones in the decision).

**Next: M5b.3 streamed evidence** (evidence file, streamed trails/packages, windowed ranges,
per-object budgets, u64 codec, runtime pin to spec `97ff964`; acceptance: a ≥10⁵-statement
stub replay with memory flat against history). Start from the probe's evidence schema and
`replay-store.ts` (probe baseline measures it); rework the one walk too: it recurses and caches every verdict per read ([decision](decisions/2026-09.md#2026-09-29--read-every-scope-with-one-reader-walk)).

## Status
- One reader walk (PR #48): `scope-reader.ts` reads every scope; the other walks and entries are gone;
  review-found fixes: excluded openings found their segment, lapse before validity, clock on lapse.
- M5b.2 (PR #47): reads, journal and wallet replay into `replay-store.ts` ("M5b.2 as built/review"),
  in memory per read or journal until M5b.4, records in event rows until M5b.3.
- M5b.1: design and [probe](docs/POOL_DEPLOYMENT_PROBES.md#replay-state-storage); kept exclusions need §14 text in M5b.4.
  [M5](decisions/2026-09.md#2026-09-29--verify-pool-lifetimes-by-complete-streamed-and-resumed-replay): complete replay, streamed and resumed; u64 §12 items; [budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets)
  10⁶ statements over three years, memory ≤ 1 GiB, first sync ≤ 24 h. Runtime pins spec `85655a5` until M5b.3.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption. **M5b.3** (above), then M5b.4–M5b.6 as the
   [storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)
   orders them; M5b.4 names the verifier by circuit identities in the replay identity. Then M6 Next 5(i) (confirm a host
   rule), M4 certificates/kind-11 fitted to this retention, M7 one-transaction condition, M8 adoption (one
   manifest holding §11.1's parameter identities too, now `BN254_PARAMETERS`), every report re-recorded,
   live two-backing drill. Mainnet needs separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and
   supply reader from a packed install (`bin`), fresh processes and data directories,
   issue → pay → receive → fulfill → redeem and an offline-operator recovery past the
   old 67-statement ceiling. Close Next 5 (a)–(c), (e) before its drill. Retire the pilot CLI
   and, against a case map, the transparent path in or right after it.
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements
   spending several backings from the wallet; single-backing openings over-reserve by |E|.
4. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller
   ownership; Ergo section versus transaction charging; served-trail caller-object cache; drop the explicit `vite` dev pin (served the
   retired browser probe) at the next dependency change. Untested on v3: a second
   commit refused while one is in flight (`store.ts` `ready`; a probe traced it holding).
   One setup module for the store-check family (~100 shared lines) and one `receiptFields` for the two receipt
   checks (the copies drifted); retire `header-verify`, `testnet-header-check`, `publisher-check` (historical
   reports; tests cover their rules) unless the headers re-record or a mainnet slice needs them.
5. Review findings deferred 2026-09-28: (a) `guard.ts` accepts a testnet-context profile
   anchored on a mainnet header until the next epoch boundary (<=127 blocks; `testnet.mjs`
   checks `/info`, so only a new caller is exposed); fix by a difficulty bound. (b) `store.ts` `package()` serves a
   published commitment never held after the lag (C2.4.3). (c) `store.ts` `submit` may
   return an old-segment receipt for an adopted forced record (traced only).
   (e) ErgoVenue's side-branch quota never resets. (f) Wallet `prepare`/`reprove` read
   `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit. (h) Runtime
   package-reader refusals drop the receipt walk's contradictions and fault facts.
   (i) (M6) A settlement publishes its output opening (C3.5), so a backer seeing it before witnessing can
   issue the same `cm_out` first; it is refused `OUTPUT` (`state.ts`) and the acceptance may read as the
   holder's lapse (C3.8). A retry needs a fresh `rho_out` and release; the wallet builds no settlements yet.
   (j) Verify-only parties could take identity-checked key bytes, needing no G1 file.
6. Only when a gate needs them: cancellation, batching, venue-moving
   record, slowest-supplier clock, multi-entry extension fixture, Poseidon2 on Barretenberg,
   sponsored holder funding, operator fee quotes, a text/QR request frame, C4.5 pending-
   acceptance receipt handoff, store-check's request through the frame, same-segment rescoping.
   Phone-first wallet: first a venue range source proportional to the subject's records
   (index-free box source, a new venue identity; M5), then a succinct relation if needed.
7. Harness as a second package reader: `local-replay.mjs`/`evidence-reader.mjs` open packages beside
   `package-reader.ts`. After 5(h), read every `local-check` group through `readPackage`/`readFrontier`, keep
   the no-venue trail replay, delete `{compact,scope}-runtime-check.mjs` once both pass on every group.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-09-29: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/`
  bundles, `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch.
- Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`
  and `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Archive node `C:\Users\Bob\ergo-node` (outside this project): synced with its index, stopped 2026-09-29; nothing uses it. Delete
  slice scratch after delivery; preserve legacy Temp/moeclean. Node management is authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous
  recovery need separate provisioning authority. Configuration/mainnet remain disabled.

## Open questions
- Non-blocking: server timeout then eventual journal completion has source review only;
  physical custody is a separate boundary.
- Non-blocking deletions (merged branches; maintainer-only in unattended runs): `git branch -d chore/one-reader-walk docs/one-walk-handoff;
  git push origin --delete chore/one-reader-walk docs/one-walk-handoff feat/m5b2-stored-reader-state`.

Roughly **57% done / 43% remaining**, range **47–66%**, reassessed 2026-09-29 after M5b.2 (every
party's state now in storage; streaming, kept state, first sync, adoption, qualified storage, mainnet remain).
