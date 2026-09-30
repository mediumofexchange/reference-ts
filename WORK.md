# Current work

Updated: 2026-09-30

## Goal
Slice 8 (adoption), M5b: every party's memory independent of history
([storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
*Acceptance (whole M5b):* memory flat on a ≥10⁵-statement stub run; resumed and
incremental verdicts equal full replay, and corrupt kept state falls back; real proofs past
the old ceiling through journal, wallet sync and offline-operator recovery; first sync
measured against 24 h; reports re-recorded. *Stop:* M5b.6 (milestones in the decision).

**Next: M5b.5c.2, real proofs past the old ceiling** (closes M5b.5). One real-proof acceptance (a new check in
`check:pool:v3`, or `store-check`/`recovery-store-check` extended) in which a journal admits more than 67 real
statements, a wallet syncs by `supply(client.sync)` and pays from kept witnesses (the circuits then check its paths),
and an offline operator is recovered (silence, force, return, adoption) over that history; record proof count, time
and memory. Spend proofs take about 3 s in CI. Owed tests from the M5b.5c.1 review (decision): kept against fresh
paths inside the wallet suite, a second handle during a read, a crash between the evidence, replay and digest commits.
*Stop:* M5b.6. Open beside it: a taking `rescope` takes its evidence as bytes in memory; a successor's journal
serves its readers the predecessor's trails again.

## Status
- M5b.5c.1 (PR #59): `V3Wallet` reads over its own evidence file (`supply`) and kept replay file with its notes'
  witnesses; the view is held by the venue's clock; [10⁴ statements at flat heap, a second read costs its new records](docs/POOL_DEPLOYMENT_PROBES.md#the-wallet-on-its-kept-files-m5b5c1).
- M5b.5b.2 (PR #58): the journal serves by parts from rows, `GET /evidence` streams them and `sync` keeps them in
  the reader's evidence file; [a second sync fetches only new bytes](docs/POOL_DEPLOYMENT_PROBES.md#serving-by-stream-and-incrementally-m5b5b2).
- Earlier: M5b.5b.1 (PR #56) the journal's kept venue answers; M5b.5a (PR #55) its storage and `audit`; M5b.4 (PRs #52,
  #54, spec 8d48b25) kept classes, retained evidence; M5b.3 (PRs #50, #51) streamed evidence, one forward walk.
  [Budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets): 10⁶ statements over three years, ≤ 1 GiB, first sync ≤ 24 h.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption. **M5b.5c.2** (above), then M5b.6 as the
   [storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)
   orders them; pruning retained evidence no read used is open (decision limits). Then M6 Next 5(i) (confirm a host
   rule), M4 certificates/kind-11 fitted to this retention, M7 one-transaction condition, M8 adoption (one
   manifest holding §11.1's parameter identities too, now `BN254_PARAMETERS`), every report re-recorded,
   live two-backing drill. Mainnet needs separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and supply reader from a
   packed install (`bin`), fresh processes and data directories, issue → pay → receive → fulfill → redeem and an
   offline-operator recovery past the old 67-statement ceiling. Close Next 5 (a)–(c), (e) before its drill. Retire the
   pilot CLI and, against a case map, the transparent path in or right after it. Require declared verifier identities
   ([decision](decisions/2026-09.md#2026-09-30--bound-evidence-storage-by-its-rows-and-bind-reader-verifiers-to-the-configuration)).
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements
   spending several backings from the wallet; single-backing openings over-reserve by |E|.
4. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging; served-trail caller-object
   cache; drop the explicit `vite` dev pin at the next dependency change. Untested on v3: a second commit refused while one
   is in flight (`store.ts` `ready`). One setup module for the store-check family and one `receiptFields` for the two
   receipt checks; retire `header-verify`, `testnet-header-check`, `publisher-check` unless a mainnet slice needs them.
5. Review findings deferred: (a) `guard.ts` accepts a testnet-context profile anchored on a mainnet header until the next
   epoch boundary (<=127 blocks); fix by a difficulty bound. (b) `store.ts` `package()` serves a published commitment
   never held after the lag (C2.4.3). (c) `store.ts` `submit` may return an old-segment receipt for an adopted forced
   record (traced only). (e) ErgoVenue's side-branch quota never resets. (f) Wallet `prepare`/`reprove` read `signed.terms`
   twice. (g) `journal-crash.mjs` covers only open, submit and commit, and arms no failure inside a transaction.
   (h) Runtime package-reader refusals drop the receipt walk's contradictions and fault facts. (k) A read under a silence
   or non-service clause judges every held checkpoint again at each admission (persisting the walk's cursors would bound
   it). (l) One index holding more objects under one subject than an answer's budget (4,096 entries, 1 MiB)
   refuses every read of that subject and every journal command; size the one-index budget from the venue's block bound.
   (m) Serving a trail walks back over every record served before its first byte (7.5 µs each, blocking); read a
   segment forward by position. `sync` takes no deadline or abort signal; the stream's minimum rate is untested.
   (n) A replay rewrites every kept witness of its segment at each record with outputs, so a wallet's cost per record
   grows with the notes it ever held (an operator's fee wallet: with history); update a witness only when a sibling
   subtree completes (at most 32 times), and drop spent notes' witnesses.
   (j) Verify-only parties could take
   identity-checked key bytes, needing no G1 file. (i) (M6) A settlement publishes its output opening (C3.5), so a backer
   seeing it before witnessing can issue the same `cm_out` first; it is refused `OUTPUT` and the acceptance may read as
   the holder's lapse (C3.8). A retry needs a fresh `rho_out` and release; the wallet builds no settlements yet.
6. Only when a gate needs them: cancellation, batching, venue-moving record, slowest-supplier clock, multi-entry extension
   fixture, Poseidon2 on Barretenberg, sponsored holder funding, operator fee quotes, a text/QR request frame, C4.5
   pending-acceptance receipt handoff, store-check's request through the frame, same-segment rescoping. Phone-first
   wallet: first a venue range source proportional to the subject's records (a new venue identity), then a succinct relation.
7. Harness as a second package reader: `local-replay.mjs`/`evidence-reader.mjs` open packages beside `package-reader.ts`.
   After 5(h), read every `local-check` group through `readPackage`/`readFrontier`, keep the no-venue trail replay, delete
   `{compact,scope}-runtime-check.mjs` once both pass on every group; retire `verifyTrailEvidence` (stricter than `served()`).

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
- Non-blocking: server timeout then eventual journal completion has source review only; physical custody is a separate boundary.

Roughly **62% done / 38% remaining**, range **52–71%**, reassessed 2026-09-30 after M5b.5c.1 (journal and wallet store,
read, serve and sync without bounds on history; real proofs past the ceiling, first sync, adoption, qualified storage, mainnet remain).
