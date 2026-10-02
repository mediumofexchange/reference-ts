# Current work

Updated: 2026-10-02

## Goal
**Slice 10: installable commands on the testnet** ([direction](decisions/2026-10.md#2026-10-01--build-redemption-into-the-wallet-before-packaging-commands-and-give-the-design-point-and-release-assurance-slices-of-their-own) item 3).
Acceptance: from a packed install (`npm pack` tarball in a fresh directory), `bin` commands for the holder wallet (with the backer
role), the operator service and the supply reader, in fresh processes on separate data directories, complete issue → pay → receive →
fulfill → demand → accept → settle → burn and an offline-operator recovery past the old 67-statement ceiling, on the local and synthetic
Ergo venues and then live on the testnet; the pilot CLI, the harness's second package reader (Next 7) and, against a case map, the
transparent path retire. Milestones: **M10a** shipped relations and required verifier identities (below); **M10b** the command surface
(commands, data directories, key custody and backup, configuration, venue clients, verifier sizing, Next 2's privacy duties), decided and
reviewed before code; **M10c** the commands and a packed-install drill on the local and synthetic Ergo venues; **M10d** the live testnet
drill (needs the local machine: Open questions); **M10e** the retirements. Stop boundary: all five delivered.
Earlier: slice 9 (redemption in the wallet, PRs #69–#77) and the [visibility matrix](docs/POOL_V3_VISIBILITY.md) (PR #78) are done;
pool-v3 is adopted with one configuration (spec e7f7f24, §11.4), and a byte, identity or verdict change is pool-v4.

## Status
- **M10a** (branch `claude/m10a-artifacts`, [decision](decisions/2026-10.md#2026-10-02--ship-the-six-compiled-relations-in-the-package-and-require-every-readers-verifier-to-name-them-slice-10-m10a)):
  `src/pool/v3/programs.json` ships the six relations; `adoptedPrograms`/`openV3Verifier` check them against the manifest and
  `openV3Prover(api)` takes no artifacts; `check:pool:v3-programs` requires the sources to compile to the file exactly. Readers, journal
  and wallet require a `DeclaredVerifier` naming the configuration's six circuits; the undeclared per-object name and in-memory fallback are gone.
- Audit area 11 (PR #75): reports binding `record-range.ts`/`ergo-check.mjs` are stale until re-recorded.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [who sees what](docs/POOL_V3_VISIBILITY.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md) (its durable view: Next 5).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 9 done (Goal); the numbering below is kept for its references.
2. Privacy duties the [visibility matrix](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) finds, for slice 10's wallet:
   spend a presented note (withdrawn, expired or failed demand) to a fresh one before any reuse (§C1.5, C3.1; `prepare`, `demand`
   and `burn` select it today); keep gap-publication funding apart from identified coins (a key per demand, or a relay); a
   transport and service credential that do not identify the holder, and syncs that do not tie an address to the backing it
   spends (replica, every scoped backing, or unlinkable transport); the user-facing explanations.
3. Slice 10 (Goal). For M10b: size verifier instances against about 85 MB each and destroy the key-deriving instance after building the
   verifier (M5b.6); whether commands accept only verifiers `openV3Verifier` built (a declaration is the caller's claim, and every
   accepted verifier names kept state alike: M10a review); no Ergo view rebuild is needed (recent testnet anchor, persisted reference view).
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
