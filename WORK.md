# Current work

Updated: 2026-09-30

## Goal
Slice 8 (adoption), M5b: every party's memory independent of history
([storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
*Acceptance (whole M5b):* memory flat on a ≥10⁵-statement stub run; resumed and
incremental verdicts equal full replay, and corrupt kept state falls back; real proofs past
the old ceiling through journal, wallet sync and offline-operator recovery; first sync
measured against 24 h; reports re-recorded. *Stop:* M5b.6 (milestones in the decision). M5b.5 runs as 5a, 5b.1 (both
delivered), 5b.2 and 5c.

**Next: M5b.5b.2, incremental and streamed serving.** The journal serves new objects plus, per segment, a trail head
and the records after the reader's checkpoint (`EvidenceStore.importTrail`), streamed from rows; lift the 1 MiB caps in
`service-wire.ts`/`service-http.ts`/`service-client.ts` (hex JSON today); `assemble` holds the package whole, and a taking
`rescope` copies it in memory. Notes: a `chain` row's `size` gives a trail's frame length before it is streamed; honor a
reader's stated position only where the walk back from the served top reaches it, else serve the whole trail;
`journal_taken` rows carry no sequence to serve only new ones by. *Acceptance:* a second sync over HTTP fetches only new
bytes; memory flat while serving. *Stop:* the wallet.
**Then M5b.5c, the wallet:** sync from a kept replay file and retained evidence, a scan cursor and kept witnesses (kept
stores refuse witnesses today); its view check still re-asks whole answers (`CHANGED_VIEW`). *Acceptance (closes
M5b.5):* real proofs past the old 67-statement ceiling through the journal, wallet sync and offline-operator recovery.

## Status
- M5b.5b.1 (PR #56): the journal keeps its venue answers in its database and reads only the windows after them; a
  command is judged by its view while the venue's clock stands; [5,001 checkpoints at flat cost](docs/POOL_DEPLOYMENT_PROBES.md#the-journals-venue-view-by-kept-windows-m5b5b1).
- M5b.5a (PR #55): the journal's database holds its admission state, records and served evidence, one transaction per
  command; it reopens from rows, reads its history through the public reader with a kept file beside it (`<db>.reads`),
  copies imports in, and `audit` re-verifies. Earlier: M5b.4b (PR #54) retained evidence, `importTrail`, kept §13
  answers; M5b.4a (PR #52, spec 8d48b25) kept classes; M5b.3 (PRs #50, #51) streamed evidence, one forward walk.
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
1. Slice 8, adoption. **M5b.5b**, **M5b.5c** (above), then M5b.6 as the
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
4. On touching affected files: fold `fulfill` into `sync` and take its canonical header from the reader's evidence (not a
   re-decode); shared byte helpers/caller ownership; Ergo section versus transaction charging; served-trail caller-object
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
- Non-blocking: server timeout then eventual journal completion has source review only;
  physical custody is a separate boundary.

Roughly **60% done / 40% remaining**, range **50–69%**, reassessed 2026-09-30 after M5b.5a, unchanged by M5b.5b.1 (the journal's
storage is rows and its venue reads are kept; incremental serving, the wallet's kept sync, first sync, adoption, qualified storage, mainnet remain).
