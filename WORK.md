# Current work

Updated: 2026-10-01

## Goal
Slice 8 (adoption). Pool-v3 is adopted with one configuration (spec e7f7f24, §11.4: configHash `7ddbb7e8…a618`, the candidate's
identities unchanged; [decision](decisions/2026-10.md#2026-10-01--adopt-pool-v3-with-one-configuration-and-hold-its-manifest-in-the-runtime-m8a)).
Fixed by its name: a byte, identity or verdict change (C3.8's residual too) is pool-v4. Open: the Ergo view (Next 7), C3.8 reader (Next 1).
Slice 8 is complete with M8b. **Next: slice 9** (Next 1): state its goal, acceptance and stop here before building.

## Status
- M8b live two-backing drill (2026-10-01): `scope-store-check.mjs --testnet --authorized-testnet` passed all four groups on the own
  testnet node (split, takeover, elective rejoin, wallet payment in the rejoined scope; 7 real proofs, 12 transactions, 0.01434984 tERG,
  69 min; [report at 8ca96cd](https://github.com/mediumofexchange/reference-ts/blob/8ca96cd/docs/pool-v3-scope-store-testnet-verification.json),
  bundle `scratch/pool-v3-scope-testnet-reader/` re-read). `scripts/pool/v3/drill.mjs` now owns proving, the local/synthetic/live venues,
  waits and fresh readers for the recovery, succession and scope drills (their three copies removed; leaf-diff equivalent to main's
  reports, synthetic reports gain `funding`); `testnet-budget.mjs` (was `recovery-testnet.mjs`) caps each live drill. Review applied:
  live inclusion index checked against the replacement lead floor, live waits in steps of 8 indices, `--worker --testnet` only where offered.
- M8a adoption (PR #67, spec e7f7f24, the runtime pin): `POOL_V3_MANIFEST` in `src/pool/v3/configuration.ts` holds every identity;
  journal, readers, wallet and prover take no configuration; the guard (`ReferenceVenueError`) still refuses mainnet.
- Earlier slice 8: M7 (PR #66), area 28 (PR #65), M4/M6, M5b.6 [first sync](docs/POOL_DEPLOYMENT_PROBES.md#verification-ahead-and-the-first-sync-m5b6), M5b PRs #50–#62.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md) (its durable view: Next 7).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 9, installable commands on the testnet: ship the compiled artifacts with a loader checked against the manifest (drops `programs`);
   holder wallet, operator service and supply reader from a packed install (`bin`), fresh processes and data directories,
   issue → pay → receive → fulfill → redeem and an offline-operator recovery past the old 67-statement ceiling. Close Next 4 (a)–(c), (e)
   and Next 7 before its drill. Size verifier instances against about 85 MB each and destroy the key-deriving instance after building
   the verifier (M5b.6). Wallet settlements derive `rho_out` per segment and disclosure counter (C3.5). A v3 dishonour reader (C3.8) for redeem: demand void by a spent tag, the holder's lapse, releases taken by another
   demand's settlement (keep each output's inserting demand); a settle refused under service reads as unreleased (C3.8's adopted limit; counting a
   release witnessed outside a gap would be pool-v4). Retire the pilot CLI and, against a case map, the transparent path in or right after it. Require declared verifier identities ([decision](decisions/2026-09.md#2026-09-30--bound-evidence-storage-by-its-rows-and-bind-reader-verifiers-to-the-configuration)).
2. Multi-backing leftovers: adding an original-term backing to a live scope; statements spending several backings from the wallet; single-backing openings over-reserve by |E|.
3. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging; served-trail
   caller-object cache; drop the explicit `vite` dev pin at the next dependency change. Untested on v3: a second commit refused while one is in flight
   (`store.ts` `ready`). Move `store-check.mjs` and `history-store-check.mjs` onto `drill.mjs` (its live budget too) and one `receiptFields` for the two receipt checks; retire `header-verify` and `testnet-header-check` unless a mainnet slice needs them (`publisher-check` carries §8's live capacity run).
   `package.ts`'s `EvidenceItem` comment still names kinds 5, 8, 9, 11 (unassigned since M4; reports bind the file). `openV3Prover`
   proves under any domain, and the exported walks (`classifyScopes`, `replayTrail`) trust `selection.domain` (M8a review, minor).
4. Review findings deferred: (a) `guard.ts` accepts a testnet-context profile anchored on a mainnet header until the next
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
   subtree completes (at most 32 times), and drop spent notes' witnesses. (j) Verify-only parties could take identity-checked key bytes, needing no G1 file.
   From review-code 2026-09-30: (o) `store.ts` `parts()` keeps one trail top per segment, so a taken predecessor segment whose snapshots lie on two
   forks serves only the longer trail and the other checkpoint stays unresolved for readers; a fix needs an ancestor test without a walk per snapshot
   (a fork-aware try cost N·L walks on an honest takeover). (p) `package-reader.ts` setup reads the selection through its own backing's entry before the
   walk, so a malformed selection's refusal reason differs per backing; a lapsed row's clock record and `inspectRefused` follow the first-read backing.
   (q) `scope-reader.ts` `forces` reuses kept publication verdicts without their snapshot dependencies: a kept replay store read with a smaller evidence
   store answers where a fresh read is unresolved. (r) CONTEXT, TERMS_CONTEXT, TERMS_SCOPE, SILENCE_SCOPE are judged before silence lapse (label, or an
   answer where lapse is unresolved). (s) Journal: an older own segment's lost trail is skipped silently when serving; each wallet GET `/evidence` takes
   the journal's turn and a write transaction (commands answer BUSY); `adopt` lets a ReplayRefusal escape unnamed. `client.package()` peaks near
   3× `maxBytes`; `closeWalk` errors in a `finally` can replace a read's result.
5. Only when a gate needs them: cancellation, batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, Poseidon2 on
   Barretenberg (0.12 against 1.14 ms a node hash, the replay's largest cost; if load takes a first sync past 24 h), a 10⁶ first-sync run to
   attribute the 10⁵ run's ~45 MB rise in process memory, sponsored holder funding, operator fee quotes, a kind-4 fee by length (fee-per-byte nodes rank a long run at the default fee last
   once a pool fills; C3 deadlines), a text/QR request frame, C4.5 pending-acceptance receipt handoff, store-check's request
   through the frame, same-segment rescoping. Against hostile evidence growth (M4): a per-supply bound tied to what the venue newly
   holds; serving a reader only the segments its backing's checkpoints name (the journal serves every segment its directories name). Phone-first wallet: first a venue range source proportional to the subject's records (a new venue identity), then a succinct relation.
6. Harness as a second package reader: `local-replay.mjs`/`evidence-reader.mjs` open packages beside `package-reader.ts`. After 4(h), read every `local-check`
   group through `readPackage`/`readFrontier`, keep the no-venue trail replay, delete `{compact,scope}-runtime-check.mjs` once both pass on every group; retire `verifyTrailEvidence` (stricter than `served()`). To cut CI failures, run the harness's proof-free cases in vitest with stand-in proofs, and consider a real-proof job only for PRs marked ready.
7. Ergo view at the design point, its own slice (area 28 audit, synthetic chain): `ErgoVenue` holds ~2.3 KB of heap per block since the anchor (1.8 GB
   at three years), each sync copies the whole best chain (`store.best()`, snapshot slice), a range from index zero walks every index, and a restart
   re-syncs from the anchor (~4.5 h of header work at three years); `ErgoVenueJournal`'s one JSON checkpoint of every raw section passes V8's 512 MiB
   string limit after ~10 weeks of mainnet. Rebuild on append-only per-index SQLite rows (headers, objects, raw sections for §13.2), a header window of
   the difficulty lookback below the pin with cumulative scores (keeping the pin's burial headers), sparse sections and a (kind, subject) index: flat memory and sync work, restart without
   re-verifying. Also protect a pass stopped by a failure, cap side/protected headers durably, and ask sections of more than one supplier at a time.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-09-29: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/`, `pool-v3-recovery-testnet-reader/` and `pool-v3-scope-testnet-reader/`
  bundles, `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch.
- Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`
  and `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Archive node `C:\Users\Bob\ergo-node` (outside this project): synced with its index, stopped 2026-09-29; nothing uses it. Delete
  slice scratch after delivery; preserve legacy Temp/moeclean. Node management is authorized.
- Qualified custody, theft/power-loss/backup drills and continuous recovery need separate provisioning authority. Mainnet stays disabled.

## Open questions
- None.

Roughly **66% done / 34% remaining**, range **57–72%**, reassessed 2026-10-01 after M8b: the adopted configuration runs live with two
backings; the Ergo view's growth with venue age (Next 7), installable commands, qualified storage and mainnet remain.
