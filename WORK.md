# Current work

Updated: 2026-10-05

## Goal
**Slice 11 (the design point) is done**; the next slice is proposed, not begun. Proposed: the lit construction's layouts (Next 10):
a `moe/lit/v1` document in the specification carrying the [design](decisions/2026-10.md#2026-10-05--make-the-transparent-profile-lit-notes-under-the-pools-rules-with-each-output-named-by-the-statement-that-creates-it-design-slice-next-10)'s
item 2 requirements (records, terms, authorization encoding, output derivation as a validity rule), independently reviewed, before
any lit code. Write its acceptance and stop boundary here when it starts. Slice 12 (transport) follows or interleaves; its first
probe needs a SOCKS5 proxy the cloud may not allow.

## Status
- **Slice 10 done but M10d** (PRs #69–#91, decisions [M10a](decisions/2026-10.md#2026-10-02--ship-the-six-compiled-relations-in-the-package-and-require-every-readers-verifier-to-name-them-slice-10-m10a)–[M10e2](decisions/2026-10.md#2026-10-03--read-every-replay-harness-package-through-the-runtime-reader-and-drop-the-no-venue-replay-slice-10-m10e2)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands)
  run from an `npm pack` install with real proofs on the synthetic node; pilot, transparent path, second reader retired. M10d needs the local machine.
- **M11a done** (PR #92, be87544): the Ergo view in SQLite rows ([decision](decisions/2026-10.md#2026-10-03--keep-the-ergo-view-in-append-only-sqlite-rows-and-reopen-it-without-re-verifying-slice-11-m11a)): flat heap, reopen 192 ms (was 74 s).
- **M11b done** (PRs #93–#99, #102–#105): (n) record cost flat in notes; (l) an index past the answer budget asked again; (m) trails
  served forward; (k) kept walk, spec `dc51baf` ([decision](decisions/2026-10.md#2026-10-04--resume-a-kept-walk-so-a-later-read-judges-only-new-checkpoints-slice-11-m11b4-next-4k)); (s) `serve` takes no journal turn; (w) `moe reader` keeps `replay.db`;
  M11b7–8 marks keep nullifier, opening, tag ([M11b8](decisions/2026-10.md#2026-10-04--keep-each-witnessed-notes-tag-with-its-mark-so-a-wallets-read-hashes-none-slice-11-m11b8)); M11b9 resends a GET on a closed idle connection; M11b10 drops the carrying listing from journal reads.
- **M11c1 done** (PR #101, [results](docs/POOL_DEPLOYMENT_PROBES.md#the-commands-over-a-thousand-statements-m11c1)): at 10³ statements every budget holds (admission ~85 ms, restart 3.1 s).
- **M11c2 done** (PR #106, [results](docs/POOL_DEPLOYMENT_PROBES.md#the-runtime-at-depth-m11c2)): first sync flat (~28 ms a statement, <620 MB); admission failed at 10⁶ via (v),
  fixed by **M11b12** (PR #109, [decision](decisions/2026-10.md#2026-10-05--record-a-kept-files-digest-from-the-pages-its-keep-point-changed-slice-11-m11b12-next-4v), page-tree digest); a view reached the tip one budget a command, fixed by **M11b11** (PR #108, `syncCaughtUp`).
- **M11c3 done** ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)): to 10⁵ admission is flat (first after a block = others, 125 ms on a
  slow host; was 343), a fresh reader reaches the tip in one command and first sync stays flat (~8–12 h extrapolated to 10⁶ on 4 cores),
  steady state and restart hold; the commands add a fixed ~2 s a first sync, <0.5 s a read, ≤ ~20 ms an admission. Gaps: the operator's own memory at depth (Next 5); the wallet's
  10⁵ points, lost to a container restart. Probes retired. **Slice 11 closed.**
- **Profile design done** (PR #110, spec `29fc585`): the transparent profile is lit notes; AGENTS.md states the approved order (Next 10).
- **Audits**: area 27 (state machine) made the 2^32-th leaf and §7's bound verdicts ([decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); journal/readers not yet.
  Area 29 (wallet): a payment whose output another statement made fails; no act with a pending receipt fails by door times ([decision](decisions/2026-10.md#2026-10-04--fail-a-payment-whose-output-another-statement-created-and-fail-no-act-with-a-pending-receipt-by-the-doors-times-audit-area-29)).

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [who sees what](docs/POOL_V3_VISIBILITY.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 9 done (Goal); the numbering below is kept for its references.
2. [Visibility](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) duties: `freshen`, relay, explanations landed (M10c2). **Slice 12** ([direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)):
   duties 2–3 (transport, a credential not per holder, syncs, gap funding); first probe: clients through a SOCKS5 proxy such as Tor.
3. M10c2 leftovers: synthetic index lag knob; testnet context has no difficulty floor (M10d); read the budget's boxes before
   readiness (review); the relay judges no gap itself; drill `EARLY`, `CONFIGURATION`, a relay `BUDGET` and `UNWITNESSED`.
4. Review findings deferred; slice 11 takes (k)–(n), (s), the rest when their files are touched ((a)–(c), (e), (q) closed in M9c2; (f) in
   audit 29). (g) `journal-crash.mjs` covers only open, submit and commit, and arms no failure inside a transaction. (h) closed in M10e2.
   (j) Verify-only parties could take identity-checked key bytes, needing no G1 file. (k) closed (M11b4). (l) closed (M11b2). (m) closed (M11b3; `cli/reader.ts` refuses an evidence.db of another layout with an uncoded TypeError). `sync` takes no deadline or abort signal; the stream's minimum rate is untested. (n) closed (M11b1); a spent note's witness stays kept.
   (o) `store.ts` `parts()` keeps one trail top per segment, so a taken predecessor segment whose snapshots lie on two forks serves only
   the longer trail (a fix needs an ancestor test without a walk per snapshot). (p) `package-reader.ts` reads the selection through its own
   backing's entry before the walk, so a malformed selection's refusal reason differs per backing. (r) CONTEXT, TERMS_CONTEXT, TERMS_SCOPE, SILENCE_SCOPE are judged before silence lapse (label, or an answer where lapse is unresolved). (s) closed in M11b5 (Status). (t) A settle or `presentation` read decodes every acceptance and release of the backing; count inside the read if slice 11 shows it.
   (u) Each `readRecordView` and journal `chain()` re-verifies every kept replacement (two Ed25519 checks each); cache by record bytes if slice 11 shows it.
   (v) closed in M11b12 (Status); its review left the opening check's window (another process committing between the hash
   and the store's connection; inherited): check under the store's own `BEGIN IMMEDIATE` and refuse a moved `data_version`. (w) closed in M11b6. Audit 29: (y) a restored handoff starts
   `seen` at 0, so it may build from a view older than its source synced at (refusals, not loss; carry `seen` at the next profile change);
   (z) pool-delivery C4.7's venue-created output awaiting adoption is not reported at all (only never as spendable).
5. Slice 11 leftovers. Measure `moe operator serve` as its own process at 10⁵ (the depth probe's process, which held the synthetic
   node's whole chain, grew 778 → 857 MB from 10⁴ to 10⁵; a line from there passes 1 GiB near 3·10⁵), and find the growth if it is the journal's. M11a's view: store each side row's meeting height (pruning re-judges protected side rows each
   sync, about 0.9 s at a hostile 20,000-header quota); sections asked of several suppliers at once (first-sync time, if M11c shows
   the need); a heavier fork more than about 10,000 headers below the tip is never reached (step-back doubling overruns the fetch
   budget on known headers; pre-existing); a node POST (`unspentBoxes`, `submit`) on a connection the node closed as idle is not sent again (M11b9 sends GETs once more; availability only, the publisher resends exact bytes); `moe venue audit` for restored views (release assurance's backup drills). Levers
   (Poseidon2 on Barretenberg at 0.12 against 1.14 ms a node hash, a 10⁶ first-sync run) only if a budget fails.
6. **Slice 13**, release assurance, after 12 (Next 4's open correctness findings close in it at the latest): reproducible builds of the
   package and its artifacts, installed-package interoperability, backup and restore drills within the standing authority. Security reviews
   until then: separate AI instances (fresh reviewers, rolling audits); the external review once the product is complete (2026-10-01).
7. The harness's second reader retired (M10e2). Left: run its proof-free cases in vitest with stand-in proofs and consider a real-proof
   job only for ready PRs (CI time); narrow the still-optional stored event indices (`StoredEvent.index`, `judgedIndex`) when touched.
8. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging;
   served-trail caller-object cache; drop the explicit `vite` dev pin at the next dependency change; test a second commit refused while one is in
   flight (`store.ts` `ready`). Move `store-check.mjs`/`history-store-check.mjs` onto `drill.mjs` and one `receiptFields` (re-records two reports).
   CLI: one `venue create` body, `READ` flags and `commitmentOf` shared; `openProver` refuses absent parameters as `PARAMETERS` (exits 3 now); one atomic writer.
9. Only when a gate needs them: cancellation (also closes C3.5's late-witnessed release; pool-v4 could bind the acceptance in `rho_out`), batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, sponsored
   holder funding, operator fee quotes, a kind-4 fee by length (fee-per-byte nodes rank a long run last once a pool fills; C3 deadlines), a
   text/QR request frame, C4.5 pending-acceptance receipt handoff, same-segment rescoping; against hostile evidence growth (M4) a per-supply bound
   tied to what the venue newly holds and serving a reader only the segments its checkpoints name. Past the smallest profile: statements
   spending several backings, adding an original-term backing to a live scope, single-backing openings' |E| over-reserve; a phone-first wallet
   (a venue range source proportional to the subject's records, a new venue identity, then a succinct relation).
10. **Claim-layer profiles** beside the pool, chosen per backing ([direction](decisions/2026-10.md#2026-10-05--build-extensions-claim-layer-profiles-beside-the-shielded-pool-each-chosen-per-backing)). Design done and reviewed
   ([decision](decisions/2026-10.md#2026-10-05--make-the-transparent-profile-lit-notes-under-the-pools-rules-with-each-output-named-by-the-statement-that-creates-it-design-slice-next-10)): the transparent profile is lit notes under the pool's rules. Next, after slice 11: the `moe/lit/v1`
   layouts in the specification (item 2's requirements), then the implementation through the shared seams, before slice 13; offline, accumulator, Chaumian after release.

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
- Non-blocking (2026-10-03): needs the local machine: M10d, the live testnet drill of the `moe` commands (own testnet node,
  a funded testnet funding key under a spend budget); the synthetic drill (`command-drill.mjs`) is its rehearsal. Also local: a 10⁶ design-point run.
- Non-blocking (2026-10-02): needs the local machine: M9c2 (a)'s testnet anchor bound rests on sampled mainnet headers. With the own
  mainnet node running, record the least mainnet difficulty from height 1,025 (lowest `nBits` per header) in the M9c2 decision; nothing waits on it.

Roughly **62% done / 38% remaining** (range 52–72%), reassessed 2026-10-05: the design point's admission lever landed, and the transparent
profile joins the release; the live drill, M11c3, the profile design, release assurance, holder transport, qualified storage and mainnet remain.
