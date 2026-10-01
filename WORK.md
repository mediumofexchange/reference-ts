# Current work

Updated: 2026-10-01

## Goal
Slice 8 (adoption). M5b is closed: every party's memory is independent of history and a reader's first sync fits 24 h at
the design point ([storage decision](decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
**Next: pruning retained evidence no read used** (decision limits): state its goal, acceptance and stop here before
building. M6 is decided (below); no v3 reader of C3.8's dishonour exists yet (Next 2).

## Status
- M6 (branches `feat/m6-taken-release` here and in the specification, [decision](decisions/2026-10.md#2026-10-01--read-a-gap-release-taken-by-another-demands-settlement-as-released)):
  a gap release refused only because another demand's settlement already inserted its `cm_out` releases its acceptance for C3.8,
  so a backer front-running a waiting release with its own settlement gains no holder's lapse; a disclosed output sends the holder's re-proof
  to a fresh `rho_out`. Spec-only (pool-recovery C3.4/C3.5/C3.8/§8, pool-authority C2.10.8);
  `test/pool-v3-force.test.ts` shows the taking in force. Review blocked the first proposal (acceptance naming `rho_out` with a void:
  anyone could pay the backer into the output and write its dishonour) and read back this one. Runtime pins unchanged.
- M5b.6 (PR #62, [decision](decisions/2026-10.md#2026-10-01--verify-a-trails-proofs-ahead-of-its-replay-on-a-pool-of-verifier-instances)):
  proofs verified ahead of the replay on a pool of verifier instances; [first sync](docs/POOL_DEPLOYMENT_PROBES.md#verification-ahead-and-the-first-sync-m5b6)
  10⁵ statements at 52.7 ms each, peak 543 MB, 10⁶ extrapolated to 15.5–16 h here. The ten current v3 reports are from CI run 36806514822.
- Review-code 2026-09-30 (PR #61): checkpoints judged in their directory's first entry's segment (spec 298b6f5) and fixes; deferred Next 5(o)–(s).
- Earlier M5b: M5b.5c (PRs #59, #60) the wallet on kept files and real proofs past the old package; M5b.5a–b (PRs #55, #56, #58) the
  journal's storage, kept venue answers and streamed serving; M5b.4 (PRs #52, #54) kept classes; M5b.3 (PRs #50, #51) streamed evidence.
  [Budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets): 10⁶ statements over three years, ≤ 1 GiB, first sync ≤ 24 h.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption. Pruning retained evidence no read used (decision limits). Then M4
   certificates/kind-11 fitted to this retention, M7 one-transaction condition, M8 adoption (one manifest holding §11.1's parameter identities too, now
   `BN254_PARAMETERS`), every report re-recorded, live two-backing drill. Mainnet needs separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and supply reader from a packed install (`bin`), fresh processes and data
   directories, issue → pay → receive → fulfill → redeem and an offline-operator recovery past the old 67-statement ceiling. Close Next 5 (a)–(c), (e)
   before its drill. Size verifier instances against about 85 MB each and destroy the key-deriving instance after building
   the verifier (M5b.6). Wallet settlements derive `rho_out` per segment and disclosure counter (C3.5). A v3 dishonour reader (C3.8) for redeem: demand void by a spent tag, the holder's lapse, releases taken by another
   demand's settlement (keep each output's inserting demand); residual: a settle refused under service reads as unreleased (a release witnessed
   at the venue outside a gap could count, as the backer can relay it, but needs a judging state; decide first). Retire the pilot CLI and, against a case map, the transparent path in or right after it. Require declared verifier identities ([decision](decisions/2026-09.md#2026-09-30--bound-evidence-storage-by-its-rows-and-bind-reader-verifiers-to-the-configuration)).
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements spending several backings from the wallet; single-backing openings over-reserve by |E|.
4. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging; served-trail
   caller-object cache; drop the explicit `vite` dev pin at the next dependency change. Untested on v3: a second commit refused while one is in flight
   (`store.ts` `ready`). One setup module for the store-check family and one `receiptFields` for the two receipt checks; retire `header-verify`, `testnet-header-check`, `publisher-check` unless a mainnet slice needs them.
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
   through the frame, same-segment rescoping. Phone-first wallet: first a venue range source proportional to the subject's records (a new venue identity), then a succinct relation.
7. Harness as a second package reader: `local-replay.mjs`/`evidence-reader.mjs` open packages beside `package-reader.ts`. After 5(h), read every `local-check`
   group through `readPackage`/`readFrontier`, keep the no-venue trail replay, delete `{compact,scope}-runtime-check.mjs` once both pass on every group; retire `verifyTrailEvidence` (stricter than `served()`). To cut CI failures, run the harness's proof-free cases in vitest with stand-in proofs, and consider a real-proof job only for PRs marked ready.

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
- Non-blocking (2026-09-30, site push = live deployment): site `index.html` (70034cb) says "multi-backing wallets remain", but the wallet pays one
  backing in any scope (PR #42). Proposed end of that line: "…configuration adoption and statements spending several backings remain." Push to site main.

Roughly **65% done / 35% remaining**, range **55–73%**, reassessed 2026-10-01 after M5b.6 closed M5b (every party stores,
serves, syncs and recovers without bounds on history, and a first sync at the design point fits its budget on a 2-core desktop;
adoption, installable commands, qualified storage and mainnet remain).
