# Current work

Updated: 2026-10-07

## Goal
**Slice 13: release assurance** (Next 6; [2026-10-03](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance) item 3; release gate in [production requirements](docs/PRODUCTION_REQUIREMENTS.md#release-gates)).
Must achieve: anyone can check that a release's installed code is exactly what its reviewed commit builds and tests, and that
the parties' stores survive the backups and restores an owner would make, before the external review. Acceptance: (a) a release
record: the package tarball rebuilds byte-identically on Linux and Windows, and installs from it with every dependency pinned by
integrity to the tested tree, checked in CI; (b) installed-package interoperability: operator, replica, relay and wallet from
separate installs of that tarball; (c) backup and restore drills of each role's store (an operator restored from an older copy
signs nothing conflicting), `moe venue audit` for restored views; (d) Next 4's open correctness findings fixed or dispositioned,
(au) first; (e) Next 5's 10⁵ rerun. Stop: (a)–(e) merged, CI green; the 10⁶ run, live Tor and the external review stay outside.
- **Done:** (a) M13a #143 ([release record](docs/RELEASE.md), CI's `reproducible-release`); (b) M13c #145 ([separate installs](docs/RELEASE.md#separate-installs)); (d)'s (au) M13b #144, (av)–(ax) M13f ([decision](decisions/2026-10.md#2026-10-07--bind-a-settlements-output-to-its-acceptance-fence-a-wallet-that-sees-another-instance-of-its-seed-act-and-refuse-a-lit-request-the-seed-already-paid-slice-13-m13f), spec C3.5 114799e): `rho_out` reads the acceptance, a wallet seeing another instance of its seed act refuses `FORKED`, lit `pay` refuses a request the seed already paid.
- **(c):** M13d #146, spec #19 ([decision](decisions/2026-10.md#2026-10-07--restore-an-operator-journal-by-a-return-at-a-skipped-sequence-once-silence-is-witnessed-slice-13-m13d)): a restored operator returns past silence at a skipped sequence (`moe operator restore`). M13e
  ([decision](decisions/2026-10.md#2026-10-07--restore-a-wallet-directory-from-a-copy-by-a-recorded-restoration-and-audit-copied-views-slice-13-m13e), #147): `wallet restore --copy` marks open requests (`fulfill` `RESTORED` unless
  `--uncredited`) and exposes a lit window; copied replay files are read again, copied views audited; `moe venue audit`. **Next:** (d)'s other open Next 4 letters (fix, or disposition with the reason), then (e).

## Status
- **Slices 10–12 and 14 done** (slice 12: transport, replica, relay, #136–#140) (PRs in #69–#111 and #117; decisions M10a–M11b12 in [2026-10](decisions/2026-10.md)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands) run from an `npm pack`
  install with real proofs on the synthetic node and live on the testnet; the Ergo view in SQLite rows, caught up in bounded passes; every budget
  holds to 10⁵ statements ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)) except the operator's own memory at depth and the wallet's 10⁵ points, lost to a restart (Next 5).
- **Audits**: area 27 (state machine, [decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); area 29 (wallet, [decision](decisions/2026-10.md#2026-10-04--fail-a-payment-whose-output-another-statement-created-and-fail-no-act-with-a-pending-receipt-by-the-doors-times-audit-area-29)); area 31 (readers): a continuation whose opening the record moved past is excluded, or lapsed in a gap, and a receipt reads a term end and a moved-past `after` without its opening ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)); the journal not yet; area 30 (transport): a source's mark moves only past an answer that delivers its selection, and a stream's minimum rate is charged to the peer alone, on both sides ([decision](decisions/2026-10.md#2026-10-07--move-a-sources-mark-only-past-an-answer-that-delivers-its-selection-and-charge-a-streams-rate-to-the-peer-alone-audit-area-30)). Review-code 2026-10-06 (`3a240f6..582d6fc`, six lanes): resumed kept walks recheck scope; a truncated `wallet.db` refuses; no failed act is published; Node floor 24.21.0. Simplify 2026-10-07: one evidence chain for both constructions (#133); the store checks' live testnet modes retired (#134).

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [who sees what](docs/POOL_V3_VISIBILITY.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json), [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json), [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json), [live commands](docs/pool-v3-command-testnet-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. (Item numbers and letters are stable: AGENTS.md and decisions cite them.)
2. [Visibility](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) duties: all landed (M10c2, M12a–c), each with its limits. M12c levers if a deployment needs them: a relay budget per window of witnessed indices, a check that a release names a witnessed demand.
3. M10c2 leftovers: synthetic index lag knob; read the budget's boxes before
   readiness (review); the relay judges no gap itself; drill `EARLY`, `CONFIGURATION`, a relay `BUDGET` and `UNWITNESSED`.
4. Deferred review findings, taken when their files are touched (closed letters are in their decisions). (g) `journal-crash.mjs` covers
   only open, submit and commit, and arms no failure inside a transaction. (j) Verify-only parties could take identity-checked key bytes,
   needing no G1 file. (m) left: `cli/reader.ts` refuses an evidence.db of another layout with an uncoded TypeError; `sync` takes no
   abort signal. (n) left: a spent note's witness stays kept.
   (o) `store.ts` `parts()` keeps one trail top per segment, so a taken predecessor segment whose snapshots lie on two forks serves only
   the longer trail (a fix needs an ancestor test without a walk per snapshot). (p) `package-reader.ts` reads the selection through its own
   backing's entry before the walk, so a malformed selection's refusal reason differs per backing. (r) CONTEXT, TERMS_CONTEXT, TERMS_SCOPE,
   SILENCE_SCOPE are judged before silence lapse (label, or an answer where lapse is unresolved). (t) A settle or `presentation` read decodes
   every acceptance and release of the backing; count inside the read if a budget needs it. (u) Each `readRecordView` and journal `chain()`
   re-verifies every kept replacement (two Ed25519 checks each); cache by record bytes if a budget needs it. (v) left: the opening check's
   window (another process committing between the hash and the store's connection; inherited): check under the store's own
   `BEGIN IMMEDIATE` and refuse a moved `data_version`. Audit 29: (y) a restored handoff starts `seen` at 0, so it may build from a view
   older than its source synced at (refusals, not loss; carry `seen` at the next profile change); (z) pool-delivery C4.7's venue-created
   output awaiting adoption is not reported at all (only never as spendable). Review 2026-10-06: (aa) the testnet drill sweeps funding keys
   in-process only (no signal handler or `--sweep <dir>`; boxes above the indexed height read as dust); (ab) no command prints a saved
   acceptance's absolute deadline for an exact `accept --deadline +n` retry; (ac) `keepContext`'s throwaway views keep `:memory:` journals
   open; (ad) a mainnet anchor has no difficulty floor (CLI takes test profiles only); (ae) `venue-ergo.md` §1 names transparent operations. M14f review: (af) reopening finds no deleted nullifier row (a later generic error). M14g1 review: (al) a keyed scan's identity names every held backing's window (one replay of every held scope per new backing or grown window; old namespaces kept). M14g2: (an) left: a remade lit burn takes a new change index. M14g4: (ao) a reader whose operator does not answer reads only a `--package` file (no kept fallback as the wallet's; slice 12's replica).
   M13f limits (accepted, decision): a lost instance's statement in flight at a restoration lands beside a retry (the fence then names it); a note another instance received and spent between two reads is never held.
   Audit 31 ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)): (ag) the package reader's scope from the selected snapshot (§7.1); (ah) own snapshot before term lapse; (ai) an undecodable committed snapshot surfaces as `EncodingError`; (aj) the non-service count rereads every publication and keeps every request; (ak) the replay identity names the backing, so a sibling's read replays again. Audit 30 (decision above): (ap) a terms field a replica learns later is never served past a mark; (aq) a hostile upstream's junk is indexed and served on by a replica; (ar) a backing whose canonical sequence lags another's is never kept by a replica; (as) one `serveParts` for the journal's and the replica's §14 parts (closes (o)); (at) `relayRefusal` reads `VenueError` text.
5. Slice 11 leftovers. One design-point rerun, in slice 13 at the latest: `moe operator serve` as its own process at 10⁵, and the wallet's first sync and steady state at 10⁵ (the depth probe's process, which also held the synthetic
   node's chain, would pass 1 GiB near 3·10⁵: [design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)), and find the growth
   if it is the journal's. M11a's view: store each side row's meeting height (pruning re-judges protected side rows each sync); sections
   asked of several suppliers at once (if a first-sync budget needs it); a heavier fork more than about 10,000 headers below the tip is
   never reached (step-back doubling overruns the fetch budget on known headers; pre-existing); a node POST (`unspentBoxes`, `submit`) on
   a connection the node closed as idle is not sent again (M11b9 sends GETs once more; availability only, the publisher resends exact
   bytes). Levers (Poseidon2 on Barretenberg, a 10⁶ first-sync run) only if a budget fails.
6. **Slice 13**, release assurance: the Goal above. Security reviews until the external review (once the product is complete, 2026-10-01):
   separate AI instances (fresh reviewers, rolling audits).
7. CI's real-proof checks run in five parallel groups (12 min, not 43) and skip for report/unread-doc commits ([decision](decisions/2026-10.md#2026-10-06--run-cis-real-proof-checks-in-parallel-groups-and-skip-them-only-for-unread-changes-tooling)); lever: split the drill
   or local replay. M10e2 left: the harness's proof-free cases in vitest with stand-in proofs; narrow the optional `StoredEvent.index`/`judgedIndex` when touched.
   Root-cause a Windows hang: PR #114 run 37350884943 attempt 1 timed out (30 s, vitest worker RPC too) in `pool-v3-replay-store` keep-point tests and `cli.test.mjs:158`; green on re-run.
8. On touching affected files (simplify survey 2026-10-07): wallet-store's pool and keyed `reprove`/`keyedResign`, supersede and `superseded` blocks; one CLI profile per construction for `wallet.ts`'s `keyed ? lit : pool` branches; lit's §2 output derivation once (`litView`, `litScanOutput`, `derivedOutputs`);
   one `moe` harness for the two command drills; one fixture `foldSegment` (`receiptFields`; re-records local replay); `store-check`/`history-store-check` onto `drill.mjs` with a `drill.serve`; reports written to `docs/` directly; CLI `commitmentOf`/`READ` shared; `openProver` refuses absent parameters as
   `PARAMETERS` (exits 3 now). Also shared byte helpers; Ergo section versus transaction charging; served-trail caller-object cache; drop the `vite` dev pin at the next dependency change; test a second commit refused while one is in flight (`store.ts` `ready`).
   Not worth it: `fulfill` into `sync` (its credit-once exit contract) and a second atomic writer (replay-store's `replaceFile`, only with its next change).
9. Only when a gate needs them: cancellation (also closes C3.5's late-witnessed release; pool-v4 could bind the acceptance in `rho_out`), batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, sponsored
   holder funding, operator fee quotes, a kind-4 fee by length (fee-per-byte nodes rank a long run last once a pool fills; C3 deadlines), a
   text/QR request frame, C4.5 pending-acceptance receipt handoff, same-segment rescoping; against hostile evidence growth (M4) a per-supply bound
   tied to what the venue newly holds and serving a reader only the segments its checkpoints name. Past the smallest profile: statements
   spending several backings, adding an original-term backing to a live scope, single-backing openings' |E| over-reserve; a phone-first wallet
   (a venue range source proportional to the subject's records, a new venue identity, then a succinct relation).
10. **Claim-layer profiles** beside the pool ([direction](decisions/2026-10.md#2026-10-05--build-extensions-claim-layer-profiles-beside-the-shielded-pool-each-chosen-per-backing)), each only where it serves a function no other does ([2026-10-08](decisions/2026-10.md#2026-10-08--build-a-claim-layer-profile-only-where-it-serves-a-function-no-other-profile-serves)): pool the default; lit notes (slice 14, adopted) for links carrying only tiny packets: measure its frames against a mesh packet budget, size cuts are lit-v2 candidates; offline after release; accumulator and Chaumian only if a comparison shows a function of their own.
11. **Agent-first surfaces** (AGENTS.md direction): every command, wallet and service answer serves agents managing backings and wallets and autonomous AIs (one JSON object and coded exits exist, M10b); check each new lit command against it.
12. **Venues and assets.** [Research](docs/VENUE_ALTERNATIVES.md) (2026-10-05) agrees with the [2026-08-27 direction](decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it):
   Ergo fits best but one address mined 51% of 700 blocks; Bitcoin is second. Probe: OP_RETURN outputs over 83 bytes by pool over 2,016
   blocks (read-only), then a week's exhaustion read; before release assurance; BTC/XMR as chain-asset terms.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-10-06: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/`, `pool-v3-recovery-testnet-reader/` and `pool-v3-scope-testnet-reader/`
  bundles (their readers retired; re-read with the scripts at `09534a8`), `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch. The PC's Node is 24.21.0 (installed 2026-10-06).
- Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`, `node-startup/`, `sync-preparation/`;
  allocate no other. Archive node `C:\Users\Bob\ergo-node` (outside): synced, stopped, unused. Preserve legacy Temp/moeclean. Node management is authorized.
- Qualified custody, theft/power-loss/backup drills and continuous recovery need separate provisioning authority. Mainnet stays disabled.

## Open questions
- Non-blocking, local machine: the 10⁶ design-point run (budgets extrapolate from curves flat to 10⁵; [2026-10-03 direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance) item 1), and a live Tor run of M12a's onion route an M12b replica and an M12c relay behind their own onion names (latency, isolation by credential, Tor's refusal of internal addresses). Runs review and merge through other instances (maintainer's direction 2026-10-07).
- Deletion list (2026-10-07): none open.

Roughly **72% done / 28% remaining** (range 62–79%), reassessed 2026-10-07 (M12c): lit notes adopted, holders reach operators over Tor,
read a replica's evidence while an operator is down and have a third party's relay fund their gap acts; release assurance, qualified storage and mainnet remain.
