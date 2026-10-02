# Current work

Updated: 2026-10-02

## Goal
**Slice 9 done: redemption in the wallet** ([direction](decisions/2026-10.md#2026-10-01--build-redemption-into-the-wallet-before-packaging-commands-and-give-the-design-point-and-release-assurance-slices-of-their-own)):
`V3Wallet` owns both redemption roles ([guide](docs/POOL_V3_WALLET.md#redeeming-and-issuing)); a settle refused under service reads as unreleased
(adopted limit; more is pool-v4). **M9a** (PRs #69, #71) acts under service; **M9b1** (PR #70) gap acts, `publish`, disclosure count; **M9b2**
(PR #72) seed-found demands, locks, acts of an ended segment made again; **M9c1** (PR #73, [decision](decisions/2026-10.md#2026-10-01--read-c38-per-witnessed-index-from-the-record-a-frontier-read-holds-and-tell-a-taken-release-apart-at-force))
C3.8 per witnessed index, `TAKEN`; **M9c2** (PR #74, [decision](decisions/2026-10.md#2026-10-02--close-five-deferred-review-findings-kept-force-testnet-anchor-side-branch-quota-served-lag-and-adopted-receipts-m9c2)) findings (a)–(c), (e), (q);
**M9d1** (PR #76) `prepare-crs.mjs` falls back to Ignition's transcript00 (same hashes), `redemption-store-check.mjs` real-proof issue to burn
through wallet processes over the HTTP service, gap demand and settlement by publication; **M9d2** (PR #77) `wallet-crash.mjs` exits at the
COMMIT of demand, accept, settle, withdraw and burn; the real-proof drill adds a seed-restored wallet settling and withdrawing standing
demands, a late gap release (`DEADLINE`, then a new `rho_out`), a timely forged presenter signature (`SIGNATURE`) and a `TAKEN` release read
as dishonour; other hostile C3.4–C3.8 cases stay stand-in (wallet guide). No runtime change in M9d; fresh review of M9d1+M9d2: no blocker, four
findings fixed (rho asserted, timely forgery, wording, scope). Slice 8 done: pool-v3 adopted, one configuration (spec e7f7f24, §11.4); a byte,
identity or verdict change (C3.8's residual too) is pool-v4. **Next: Next 2** (visibility table), then slice 10.

## Status
- Audit area 11 (PR #75, merged b101869, [decision](decisions/2026-10.md#2026-10-02--count-a-replacement-identity-at-its-first-entry-in-the-walk-itself-and-drop-the-range-helpers-the-runtime-does-not-use-audit-area-11)): the replacement walk counts an identity at its
  first entry itself; unused range helpers dropped. Reports binding `record-range.ts`/`ergo-check.mjs` are stale until re-recorded.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md) (its durable view: Next 5).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 9 done (Goal); the numbering below is kept for its references.
2. Profile visibility table (docs/spec, any time before slice 10's wallet text): pool-v3 on Ergo per party and per issuer/operator/witness
   collusion, with traffic (service connections, publication timing, node queries) and small-pool inference (§C1.4 asks profiles for their own).
3. Slice 10, installable commands on the testnet: ship the compiled artifacts with a loader checked against the manifest (drops `programs`);
   require declared verifier identities ([decision](decisions/2026-09.md#2026-09-30--bound-evidence-storage-by-its-rows-and-bind-reader-verifiers-to-the-configuration));
   holder wallet (with the backer role), operator service and supply reader from a packed install (`bin`), fresh processes and data directories,
   the full path of Next 1 and an offline-operator recovery past the old 67-statement ceiling, live. Size verifier instances against about 85 MB
   each and destroy the key-deriving instance after building the verifier (M5b.6). Retire the pilot CLI, the harness's second package reader
   (Next 7) and, against a case map, the transparent path. It needs no Ergo view rebuild (recent testnet anchor, persisted reference view).
4. Review findings deferred; slice 11 takes (k)–(n), (s), the rest when their files are touched ((a)–(c), (e), (q) closed in M9c2). (f) Wallet
   `prepare`/`reprove` read `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit, and arms no failure inside a
   transaction. (h) Runtime package-reader refusals drop the receipt walk's contradictions and fault facts. (j) Verify-only parties could take
   identity-checked key bytes, needing no G1 file. (k) A read under a silence or non-service clause judges every held checkpoint again at each
   admission (persisting the walk's cursors would bound it). (l) One index holding more objects under one subject than an answer's budget
   (4,096 entries, 1 MiB) refuses every read of that subject and every journal command; size the one-index budget from the venue's block bound.
   (m) Serving a trail walks back over every record served before its first byte (7.5 µs each, blocking); read a segment forward by position.
   `sync` takes no deadline or abort signal; the stream's minimum rate is untested. (n) A replay rewrites every kept witness of its segment at
   each record with outputs, so a wallet's cost per record grows with the notes it ever held; update a witness only when a sibling subtree
   completes (at most 32 times), and drop spent notes' witnesses. (o) `store.ts` `parts()` keeps one trail top per segment, so a taken
   predecessor segment whose snapshots lie on two forks serves only the longer trail (a fix needs an ancestor test without a walk per snapshot).
   (p) `package-reader.ts` reads the selection through its own backing's entry before the walk, so a malformed selection's refusal reason
   differs per backing. (r) CONTEXT, TERMS_CONTEXT, TERMS_SCOPE, SILENCE_SCOPE are judged
   before silence lapse (label, or an answer where lapse is unresolved). (s) Journal: an older own segment's lost trail is skipped silently when serving; each wallet GET `/evidence` takes the
   journal's turn and a write transaction (commands answer BUSY); `adopt` lets a ReplayRefusal escape unnamed; `client.package()` peaks near
   3× `maxBytes`; `closeWalk` errors in a `finally` can replace a read's result. M8a minor: `openV3Prover` proves under any domain, and the
   exported walks (`classifyScopes`, `replayTrail`) trust `selection.domain`. (t) A settle or `presentation` read decodes every acceptance and release of the backing; count inside the read if slice 11 shows it.
   (u) Each `readRecordView` and journal `chain()` re-verifies every kept replacement (two Ed25519 checks each); cache by record bytes if slice 11 shows it.
5. Slice 11, the design point: measure operator admission at peak, reader first sync and wallet steady state through the commands against the
   [declared budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets), with Next 4 (k)–(n), (s), and rebuild the Ergo view on
   append-only SQLite rows (its limits and plan: the [direction](decisions/2026-10.md#2026-10-01--build-redemption-into-the-wallet-before-packaging-commands-and-give-the-design-point-and-release-assurance-slices-of-their-own)'s
   decision 4). Levers (Poseidon2 on Barretenberg at 0.12 against 1.14 ms a node hash, a 10⁶ first-sync run) only if a budget fails.
6. Release assurance: reproducible builds of the package and its artifacts, installed-package interoperability, backup and restore drills
   within the standing authority. Security reviews until then are done by separate AI instances (fresh reviewers, the rolling audits);
   the external independent review comes only once the product is complete (answered 2026-10-01).
7. Harness as a second package reader (retires in slice 10): `local-replay.mjs`/`evidence-reader.mjs` open packages beside `package-reader.ts`.
   After 4(h), read every `local-check` group through `readPackage`/`readFrontier`, keep the no-venue trail replay, delete
   `{compact,scope}-runtime-check.mjs`; retire `verifyTrailEvidence`. Run the harness's proof-free cases in vitest with stand-in proofs; consider a real-proof job only for ready PRs.
8. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging;
   served-trail caller-object cache; drop the explicit `vite` dev pin at the next dependency change; test a second commit refused while one is in
   flight (`store.ts` `ready`). Move `store-check.mjs`/`history-store-check.mjs` onto `drill.mjs` and one `receiptFields`; retire `header-verify`
   and `testnet-header-check` unless a mainnet slice needs them. `package.ts`'s `EvidenceItem` comment still names kinds 5, 8, 9, 11.
9. Only when a gate needs them: cancellation, batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, sponsored
   holder funding, operator fee quotes, a kind-4 fee by length (fee-per-byte nodes rank a long run last once a pool fills; C3 deadlines), a
   text/QR request frame, C4.5 pending-acceptance receipt handoff, same-segment rescoping; against hostile evidence growth (M4) a per-supply bound
   tied to what the venue newly holds and serving a reader only the segments its checkpoints name. Past the smallest profile: statements
   spending several backings, adding an original-term backing to a live scope, single-backing openings' |E| over-reserve; a phone-first wallet
   (a venue range source proportional to the subject's records, a new venue identity, then a succinct relation).

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-09-29: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/`, `pool-v3-recovery-testnet-reader/` and `pool-v3-scope-testnet-reader/`
  bundles, `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch.
- Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`
  and `node-startup/`, `sync-preparation/` caches; do not allocate another. Archive node `C:\Users\Bob\ergo-node` (outside this project): synced,
  stopped 2026-09-29, unused. Delete slice scratch after delivery; preserve legacy Temp/moeclean. Node management is authorized.
- Qualified custody, theft/power-loss/backup drills and continuous recovery need separate provisioning authority. Mainnet stays disabled.

## Open questions
- Non-blocking (2026-10-02): needs the local machine: M9c2 (a)'s testnet anchor bound rests on sampled mainnet headers. With the own
  mainnet node running, record the least mainnet difficulty from height 1,025 (lowest `nBits` per header) in the M9c2 decision; nothing waits on it.

Roughly **62% done / 38% remaining**, range **52–72%**, reassessed 2026-10-02 (slice 9 done): redemption's operations now run through the
wallet with real proofs; the visibility table, installable commands, the design point, release assurance, qualified storage and mainnet remain.
