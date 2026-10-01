# Current work

Updated: 2026-10-01

## Goal
Slice 8 (adoption). M5b is closed for the pool's own state: every party's replay and evidence memory is independent of history and a
reader's first sync fits 24 h at the design point ([storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
The Ergo view is not yet (Next 8, measured by the area 28 audit). M6 and M4 are decided. **Next: M7**, venue-ergo §8's one-transaction
condition checked against the configuration: state its goal, acceptance and stop here before building. No v3 reader of C3.8's dishonour exists yet (Next 2).

## Status
- Audit area 28, venue core and Ergo view/publisher (PR #65, spec b964ee3, [decision](decisions/2026-10.md#2026-10-01--keep-an-ergo-index-witnessed-while-the-best-chain-keeps-its-block-and-replace-a-publication-only-on-a-suppliers-answer)):
  an index stays witnessed while the best chain keeps its block (a durable view now reopens on a heavier, shorter chain); a publication is
  replaced only on a supplier's answer, never beside one it replaced that a supplier holds, at most 8 per record; settling asks no supplier;
  a slow or lying supplier costs a timeout or two; node bodies bounded; held records indexed; read-once intake (FixtureVenue, venue records,
  proof verifier). Ledger: `C:\Users\Bob\moe-autorun\state\audit-ledger.md`.
- M4 (spec 5584732): no certificate encoding, §12 kinds 5, 8, 9, 11 unassigned, retained evidence replaced, never pruned by use. M6 (spec
  740adaa, PR #63): a gap release taken by another demand's settlement releases its acceptance (C3.8). Decisions in [2026-10](decisions/2026-10.md).
- M5b.6 (PR #62): proofs verified ahead on a verifier pool; [first sync](docs/POOL_DEPLOYMENT_PROBES.md#verification-ahead-and-the-first-sync-m5b6)
  10⁵ statements at 52.7 ms each, peak 543 MB, 10⁶ extrapolated to 15.5–16 h here. [Budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets):
  10⁶ statements, ≤ 1 GiB, first sync ≤ 24 h. Earlier: review-code PR #61 (Next 5(o)–(s)), M5b PRs #50–#60.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md) (its durable view: Next 8).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption. M7 one-transaction condition (the publisher's kind-4 pieces reserve a 3-byte output index: 3,980 bytes, not
   §8's 3,981, so 95,544 bytes take 25 outputs; its fee is flat whatever the size), then M8 adoption (one manifest holding §11.1's parameter identities too, now
   `BN254_PARAMETERS`), every report re-recorded, live two-backing drill. Mainnet needs separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and supply reader from a packed install (`bin`), fresh processes and data
   directories, issue → pay → receive → fulfill → redeem and an offline-operator recovery past the old 67-statement ceiling. Close Next 5 (a)–(c), (e)
   and Next 8 before its drill. Size verifier instances against about 85 MB each and destroy the key-deriving instance after building
   the verifier (M5b.6). Wallet settlements derive `rho_out` per segment and disclosure counter (C3.5). A v3 dishonour reader (C3.8) for redeem: demand void by a spent tag, the holder's lapse, releases taken by another
   demand's settlement (keep each output's inserting demand); residual: a settle refused under service reads as unreleased (a release witnessed
   at the venue outside a gap could count, as the backer can relay it, but needs a judging state; decide first). Retire the pilot CLI and, against a case map, the transparent path in or right after it. Require declared verifier identities ([decision](decisions/2026-09.md#2026-09-30--bound-evidence-storage-by-its-rows-and-bind-reader-verifiers-to-the-configuration)).
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements spending several backings from the wallet; single-backing openings over-reserve by |E|.
4. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging; served-trail
   caller-object cache; drop the explicit `vite` dev pin at the next dependency change. Untested on v3: a second commit refused while one is in flight
   (`store.ts` `ready`). One setup module for the store-check family and one `receiptFields` for the two receipt checks; retire `header-verify`, `testnet-header-check`, `publisher-check` unless a mainnet slice needs them.
   `package.ts`'s `EvidenceItem` comment still names kinds 5, 8, 9, 11 (unassigned since M4; reports bind the file).
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
6. Only when a gate needs them: cancellation, batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, Poseidon2 on
   Barretenberg (0.12 against 1.14 ms a node hash, the replay's largest cost; if load takes a first sync past 24 h), a 10⁶ first-sync run to
   attribute the 10⁵ run's ~45 MB rise in process memory, sponsored holder funding, operator fee quotes, a text/QR request frame, C4.5 pending-acceptance receipt handoff, store-check's request
   through the frame, same-segment rescoping. Against hostile evidence growth (M4): a per-supply bound tied to what the venue newly
   holds; serving a reader only the segments its backing's checkpoints name (the journal serves every segment its directories name). Phone-first wallet: first a venue range source proportional to the subject's records (a new venue identity), then a succinct relation.
7. Harness as a second package reader: `local-replay.mjs`/`evidence-reader.mjs` open packages beside `package-reader.ts`. After 5(h), read every `local-check`
   group through `readPackage`/`readFrontier`, keep the no-venue trail replay, delete `{compact,scope}-runtime-check.mjs` once both pass on every group; retire `verifyTrailEvidence` (stricter than `served()`). To cut CI failures, run the harness's proof-free cases in vitest with stand-in proofs, and consider a real-proof job only for PRs marked ready.
8. Ergo view at the design point, its own slice (area 28 audit, synthetic chain): `ErgoVenue` holds ~2.3 KB of heap per block since the anchor (1.8 GB
   at three years), each sync copies the whole best chain (`store.best()`, snapshot slice), a range from index zero walks every index, and a restart
   re-syncs from the anchor (~4.5 h of header work at three years); `ErgoVenueJournal`'s one JSON checkpoint of every raw section passes V8's 512 MiB
   string limit after ~10 weeks of mainnet. Rebuild on append-only per-index SQLite rows (headers, objects, raw sections for §13.2), a header window of
   the difficulty lookback below the pin with cumulative scores, sparse sections and a (kind, subject) index: flat memory and sync work, restart without
   re-verifying. Also protect a pass stopped by a failure, cap side/protected headers durably, and ask sections of more than one supplier at a time.

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
None.

Roughly **63% done / 37% remaining**, range **54–71%**, reassessed 2026-10-01 after the area 28 audit found the Ergo view's memory, sync
work and restart grow with venue age (Next 8, a slice of its own); the pool's own state stores, serves, syncs and recovers without bounds on
history, and adoption, installable commands, qualified storage and mainnet remain.
