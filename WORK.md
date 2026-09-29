# Current work

Updated: 2026-09-29

## Goal
Slice 8 (adoption), ordered by the [direction check](decisions/2026-09.md#2026-09-29--decide-lifetime-evidence-before-adoption-then-ship-installable-commands)
and M5. Next run: **M5b streaming evidence** (Next 1); restate its acceptance here.

## Status
- [M5](decisions/2026-09.md#2026-09-29--verify-pool-lifetimes-by-complete-streamed-and-resumed-replay) (docs/spec only): complete replay, streamed and resumed; no seventh relation,
  configuration unchanged. Pool-v3 §12 items take a u64 length (u32 capped a trail near
  276,000 spends); §14 consolidates replay and retention. [Budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets):
  10⁶ statements over three years, memory ≤ 1 GiB independent of history, reader first
  sync ≤ 24 h. The runtime still pins spec `85655a5` (u32 codec) until M5b.
- M3 (PR #46) pinned final circuit text at spec `85655a5`; M2 (PR #45) hash-checks
  parameters. Reports from CI run 36519561119.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json). Historical: live recovery
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption. **M5b streaming evidence** ([M5](decisions/2026-09.md#2026-09-29--verify-pool-lifetimes-by-complete-streamed-and-resumed-replay)):
   reader, wallet and journal keep evidence (per-segment records, venue evidence) and
   replay state (note-tree frontier, spent set, tags, standing demands) on disk, read
   input under pool-v3 §14's one-set-of-bytes rule, resume from checked kept state, and
   sync only records after their position. u64 package codec, pin move; per-object
   bounds replace the 1 MiB totals. *Acceptance:* memory flat against history on a
   stub-verifier run of at least 10⁵ statements; resumed/incremental verdicts equal full
   replay, corrupt kept state falls back; real proofs past the old ceiling through
   journal, wallet sync and offline-operator recovery; first sync measured against its
   budget (Barretenberg Poseidon2 if over); reports re-recorded. Then M6 Next 5(i) (confirm a host
   rule), M4 certificates/kind-11 fitted to this retention, M7 one-transaction
   condition, M8 adoption (one manifest holding §11.1's parameter identities too, now
   `BN254_PARAMETERS`), every report re-recorded, live two-backing drill. Mainnet needs
   separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and
   supply reader from a packed install (`bin`), fresh processes and data directories,
   issue → pay → receive → fulfill → redeem and an offline-operator recovery past the
   old 67-statement ceiling. Close Next 5 (a)–(c), (e) before its drill. Retire the pilot CLI
   and, against a case map, the transparent path in or right after it.
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements
   spending several backings from the wallet; single-backing openings over-reserve by |E|.
4. On touching affected files: `local-replay.mjs` candidates should call
   `holdings.ts` (re-records six reports); fold `fulfill` into `sync`; shared
   byte helpers/caller ownership; Ergo section versus transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache; drop the explicit `vite` dev pin (served the
   retired browser probe) at the next dependency change. Untested on v3: a second
   commit refused while one is in flight (`store.ts` `ready`; a probe traced it holding);
   `IMPORT_RANK` holds by construction (held commitments arrive in order).
5. Review findings deferred 2026-09-28: (a) `guard.ts` accepts a testnet-context profile
   anchored on a mainnet header until the next epoch boundary (<=127 blocks; `testnet.mjs`
   checks `/info`, so only a new caller is exposed); fix by a difficulty bound. (b) `store.ts` `package()` serves a
   published commitment never held after the lag (C2.4.3). (c) `store.ts` `submit` may
   return an old-segment receipt for an adopted forced record (traced only).
   (e) ErgoVenue's side-branch quota never resets. (f) Wallet `prepare`/`reprove` read
   `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit. (h) Runtime
   package-reader refusals drop the receipt walk's contradictions and fault facts.
   (i) (M6) A settlement publishes its output opening (C3.5), so a backer seeing it before
   witnessing can issue the same `cm_out` first; it is refused `OUTPUT` (`state.ts`) and the
   acceptance may read as the holder's lapse (C3.8). A retry needs a fresh `rho_out` and
   release; each pre-emption costs a visible issuance. The wallet builds no settlements yet.
   (j) Verify-only parties could take identity-checked key bytes, needing no G1 file.
6. Only when a gate needs them: cancellation, batching, venue-moving
   record, slowest-supplier clock, multi-entry extension fixture, Poseidon2 on Barretenberg,
   sponsored holder funding, operator fee quotes, a text/QR request frame, C4.5 pending-
   acceptance receipt handoff, store-check's request through the frame, same-segment rescoping.
   Phone-first wallet: first a venue range source proportional to the subject's records
   (index-free box source, a new venue identity; M5), then a succinct relation if needed.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch.
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
- No service delivery blocker remains. Server timeout followed by eventual journal
  completion has source review, without a direct timed acceptance case.
- Physical custody remains a separate boundary.

Roughly **55% done / 45% remaining**, range **45–65%**, reassessed 2026-09-29 (lifetime evidence
and installable commands were missing from the remainder; adoption, qualified storage, mainnet remain).
