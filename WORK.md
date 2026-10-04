# Current work

Updated: 2026-10-04

## Goal
**Slice 11: the design point** ([direction](decisions/2026-10.md#2026-10-01--build-redemption-into-the-wallet-before-packaging-commands-and-give-the-design-point-and-release-assurance-slices-of-their-own) item 4; [M11c's method](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
Acceptance: through the `moe` commands on the synthetic node, measured against the [declared budgets](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets):
operator admission at peak, reader first sync and wallet steady state, with memory independent of history length and restarts
that resume without re-verifying retained history; Next 4 (k)–(n), (s), (w) closed. Milestones: **M11a** the Ergo view on append-only
SQLite rows (flat heap and per-sync work over a long synthetic chain, reopen without PoW/root re-checks, same verdicts and answers);
M11b the scale findings; M11c the measurements and report: commands with real proofs at ~10³ statements, the runtime with stand-in
records under real verification load at 10⁴/10⁵ (10⁶ local only; no stand-in path in the product). Stop: all three; a failing budget names its lever.
Slice 10 waits only on M10d (live testnet drill, local machine). Earlier: slices 9–10 (PRs #69–#91). pool-v3 adopted (spec e7f7f24, §11.4).

## Status
- **Slice 10 done but M10d** (PRs #79–#91; decisions from [M10a](decisions/2026-10.md#2026-10-02--ship-the-six-compiled-relations-in-the-package-and-require-every-readers-verifier-to-name-them-slice-10-m10a)
  to [M10e2](decisions/2026-10.md#2026-10-03--read-every-replay-harness-package-through-the-runtime-reader-and-drop-the-no-venue-replay-slice-10-m10e2)):
  the `moe` wallet, operator, reader and relay [commands](docs/POOL_V3_WALLET.md#commands) run from an `npm pack` install with real proofs
  on the synthetic node; pilot, transparent path (`8d207eb`), second reader retired. M10d (live drill) needs the local machine.
- **M11a done** (PR #92, be87544): the Ergo view in SQLite rows ([decision](decisions/2026-10.md#2026-10-03--keep-the-ergo-view-in-append-only-sqlite-rows-and-reopen-it-without-re-verifying-slice-11-m11a)):
  flat heap, reopen in 192 ms (was 74 s at 10⁴ blocks). A vitest setup yields a turn per test (60 s worker RPC timeout on Windows).
- **M11b done** (PR #99, M11b6): (n) M11b1 #93 (record cost flat in notes, [probe](docs/POOL_DEPLOYMENT_PROBES.md#a-wallets-witnesses-kept-at-completion-m11b)); (l) M11b2 #94
  (an index past the answer budget asked again under `indexLimits`); (m) M11b3 #95 (trails served forward); (k) M11b4 #97, spec `dc51baf`
  (kept walk, [decision](decisions/2026-10.md#2026-10-04--resume-a-kept-walk-so-a-later-read-judges-only-new-checkpoints-slice-11-m11b4-next-4k), [probe](docs/POOL_DEPLOYMENT_PROBES.md#an-admission-under-a-silence-clause-m11b4): admission ≤0.18 s at 320 checkpoints).
  (s) M11b5 #98 ([decision](decisions/2026-10.md#2026-10-04--serve-evidence-without-the-journals-turn-and-refuse-the-journals-own-damage-by-name-slice-11-m11b5-next-4s)):
  `serve` takes no journal turn and refuses the journal's own damage by name.
  (w) M11b6 #99: `moe reader` keeps `replay.db` (+ digest) as the wallet does, discarding kept state read through a later index
  than the view's; the drill compares kept and full reads after the bulk issues (2.8 against 5.4 s at 78 statements locally),
  a return and a `presentation`. One review, nothing blocking, four low findings fixed. No verdict code changed. Next: M11c.
- **Audit area 27 (state machine)**: the note tree's 2^32-th leaf and §7's position bound made verdicts ([decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); journal/readers not yet audited.

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
4. Review findings deferred; slice 11 takes (k)–(n), (s), the rest when their files are touched ((a)–(c), (e), (q) closed in M9c2). (f) Wallet
   `prepare`/`reprove` read `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit, and arms no failure inside a
   transaction. (h) closed in M10e2. (j) Verify-only parties could take
   identity-checked key bytes, needing no G1 file. (k) closed (M11b4, kept walk). (l) closed (M11b2; a fixture venue declares no
   index bound, its records being its owner's).
   (m) closed (M11b3; `cli/reader.ts` refuses an evidence.db of another layout with an uncoded TypeError). `sync` takes no deadline or abort signal; the stream's minimum rate is untested. (n) closed (M11b1); a spent note's witness stays kept.
   (o) `store.ts` `parts()` keeps one trail top per segment, so a taken
   predecessor segment whose snapshots lie on two forks serves only the longer trail (a fix needs an ancestor test without a walk per snapshot).
   (p) `package-reader.ts` reads the selection through its own backing's entry before the walk, so a malformed selection's refusal reason
   differs per backing. (r) CONTEXT, TERMS_CONTEXT, TERMS_SCOPE, SILENCE_SCOPE are judged
   before silence lapse (label, or an answer where lapse is unresolved). (s) closed in M11b5 (Status). (t) A settle or `presentation` read decodes every acceptance and release of the backing; count inside the read if slice 11 shows it.
   (u) Each `readRecordView` and journal `chain()` re-verifies every kept replacement (two Ed25519 checks each); cache by record bytes if slice 11 shows it.
   (v) A read at a new venue index changes kept answers, so its close hashes the whole replay file (≈7 s at 10⁶): the operator's first
   admission per block; M11c measures it, then an incremental root or the hot rows in a file of their own. (w) closed in M11b6.
5. Slice 11 (Goal): M11a's view leaves for M11b/M11c: store each side row's meeting height (pruning re-judges protected side rows each
   sync, about 0.9 s at a hostile 20,000-header quota); sections asked of several suppliers at once (first-sync time, if M11c shows
   the need); a heavier fork more than about 10,000 headers below the tip is never reached (step-back doubling overruns the fetch
   budget on known headers; pre-existing); `moe venue audit` for restored views (release assurance's backup drills). Levers
   (Poseidon2 on Barretenberg at 0.12 against 1.14 ms a node hash, a 10⁶ first-sync run) only if a budget fails.
6. **Slice 13**, release assurance, after 12 (Next 4's open correctness findings close in it at the latest): reproducible builds of the
   package and its artifacts, installed-package interoperability, backup and restore drills within the standing authority. Security reviews
   until then: separate AI instances (fresh reviewers, rolling audits); the external review once the product is complete (2026-10-01).
7. The harness's second reader retired (M10e2). Left: run its proof-free cases in vitest with stand-in proofs and consider a real-proof
   job only for ready PRs (CI time); narrow the still-optional stored event indices (`StoredEvent.index`, `judgedIndex`) when touched.
8. On touching affected files: fold `fulfill` into `sync`; shared byte helpers/caller ownership; Ergo section versus transaction charging;
   served-trail caller-object cache; drop the explicit `vite` dev pin at the next dependency change; test a second commit refused while one is in
   flight (`store.ts` `ready`). Move `store-check.mjs`/`history-store-check.mjs` onto `drill.mjs` and one `receiptFields`; retire `header-verify`
   and `testnet-header-check` unless a mainnet slice needs them. `package.ts`'s `EvidenceItem` comment still names kinds 5, 8, 9, 11.
9. Only when a gate needs them: cancellation (also closes C3.5's late-witnessed release; pool-v4 could bind the acceptance in `rho_out`), batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, sponsored
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
- Non-blocking (2026-10-03): needs the local machine: M10d, the live testnet drill of the `moe` commands (own testnet node,
  a funded testnet funding key under a spend budget); the synthetic drill (`command-drill.mjs`) is its rehearsal.
- Non-blocking (2026-10-02): needs the local machine: M9c2 (a)'s testnet anchor bound rests on sampled mainnet headers. With the own
  mainnet node running, record the least mainnet difficulty from height 1,025 (lowest `nBits` per header) in the M9c2 decision; nothing waits on it.

Roughly **65% done / 35% remaining** (range 55–74%), reassessed 2026-10-03: every role runs as installable commands with real proofs on the
synthetic node; the live drill, retirements, the design point, release assurance, a holder-private transport, qualified storage and mainnet remain.
