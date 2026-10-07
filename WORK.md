# Current work

Updated: 2026-10-07

## Goal
**Slice 14: the lit implementation** (Next 10; order 14, 12, 13; spec `lit-v1.md`, a draft until adopted;
[layouts decision](decisions/2026-10.md#2026-10-05--fix-the-lit-constructions-bytes-outputs-derived-by-every-reader-owner-signatures-over-the-statement-the-pools-frames-without-a-proof-digest-next-10)).
Acceptance: lit trails replay through the shared seams with lit-v1's verdicts (hostile cases), vectors bind every layout; an operator
journal and a wallet run lit backings through the `moe` commands, failure path included (gap route, return and adoption, C3.8's reading);
then a decision adopts `moe/lit/v1`. Stop: adoption ([M14f decision](decisions/2026-10.md#2026-10-06--serve-a-lit-scope-from-the-one-operator-journal-the-construction-an-option-slice-14-m14f) item 4; [direction 2026-10-07](decisions/2026-10.md#2026-10-07--exercise-lits-failure-path-and-settle-7s-acceptance-owner-before-adoption-and-give-evidence-availability-a-replica-in-slice-12)).
- **Done and merged (2026-10-07; decisions M14a–M14g3 in [2026-10](decisions/2026-10.md)):** M14a–b bytes and frames, M14c state machine (#116),
  M14d reader (#120), M14e conformance (#122), M14f journal (#123), M14g1 wallet notes, keys and payments (#125), M14g2 acts and the window
  move (#126), M14g3 service wire, server and client through the construction, one receipt codec per construction (#127); spec #15–#16 (`3af6abe`).
- **Next:** M14g4 `moe` dispatch on the terms' construction (operator journal, wallet, client `construction`),
  accepted by a synthetic-node drill of a lit backing: every act and a supply read, then the gap route with the operator stopped (relay
  publish, force read) and a return and adoption. M14g5: settle (am) as a lit-v1 draft clarification (spec first, fresh review), then lit
  `presentation` (C3.8). M14h adoption, once nothing can move a byte or verdict.

## Status
- **Slices 10–11 done** (PRs in #69–#111 and #117; decisions M10a–M11b12 in [2026-10](decisions/2026-10.md)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands) run from an `npm pack`
  install with real proofs on the synthetic node and live on the testnet; the Ergo view in SQLite rows, caught up in bounded passes; every budget
  holds to 10⁵ statements ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)) except the operator's own memory at depth and the wallet's 10⁵ points, lost to a restart (Next 5).
- **Audits**: area 27 (state machine, [decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); area 29 (wallet, [decision](decisions/2026-10.md#2026-10-04--fail-a-payment-whose-output-another-statement-created-and-fail-no-act-with-a-pending-receipt-by-the-doors-times-audit-area-29)); area 31 (readers): a continuation whose opening the record moved past is excluded, or lapsed in a gap, and a receipt reads a term end and a moved-past `after` without its opening ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)); the journal not yet. Review-code 2026-10-06 (`3a240f6..582d6fc`, six lanes): resumed kept walks recheck scope; a truncated `wallet.db` refuses; no failed act is published; Node floor 24.21.0.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [who sees what](docs/POOL_V3_VISIBILITY.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json), [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json), [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json), [live commands](docs/pool-v3-command-testnet-verification.json). Historical: live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. (Item numbers and letters are stable: AGENTS.md and decisions cite them.)
2. [Visibility](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) duties: `freshen`, relay, explanations landed (M10c2). **Slice 12** ([direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)), after 14:
   duties 2–3 (transport, a credential not per holder, syncs, gap funding); first probe: clients through a SOCKS5 proxy such as Tor. Also
   a replica ([2026-10-07](decisions/2026-10.md#2026-10-07--exercise-lits-failure-path-and-settle-7s-acceptance-owner-before-adoption-and-give-evidence-availability-a-replica-in-slice-12)): an evidence-only role serving kept, verified evidence through the one wire; the operator-offline drill syncs from it.
3. M10c2 leftovers: synthetic index lag knob; read the budget's boxes before
   readiness (review); the relay judges no gap itself; drill `EARLY`, `CONFIGURATION`, a relay `BUDGET` and `UNWITNESSED`.
4. Deferred review findings, taken when their files are touched (closed letters are in their decisions). (g) `journal-crash.mjs` covers
   only open, submit and commit, and arms no failure inside a transaction. (j) Verify-only parties could take identity-checked key bytes,
   needing no G1 file. (m) left: `cli/reader.ts` refuses an evidence.db of another layout with an uncoded TypeError; `sync` takes no
   deadline or abort signal; the stream's minimum rate is untested. (n) left: a spent note's witness stays kept.
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
   open; (ad) a mainnet anchor has no difficulty floor (CLI takes test profiles only); (ae) `venue-ergo.md` §1 names transparent operations. M14f review: (af) reopening finds no deleted nullifier row (a later generic error). M14g1 review: (al) a keyed scan's identity names every held backing's window (one replay of every held scope per new backing or grown window; old namespaces kept). M14g2: (am) lit-v1 §7 question: an acceptance whose owner is the holder's key (the presenter, an input owner, or any key K links) reads as answered under C3.8, so K escapes dishonour; M14g5 chooses (no answer for keys a reader can tell, or the owner key's signature in the acceptance, a byte change); (an) no lit gap-route act or `presentation` yet (M14g4–g5); a remade lit burn takes a new change index.
   Audit 31 ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)): (ag) the package reader's scope from the selected snapshot (§7.1); (ah) own snapshot before term lapse; (ai) an undecodable committed snapshot surfaces as `EncodingError`; (aj) the non-service count rereads every publication and keeps every request; (ak) the replay identity names the backing, so a sibling's read replays again.
5. Slice 11 leftovers. One design-point rerun, in slice 13 at the latest: `moe operator serve` as its own process at 10⁵, and the wallet's first sync and steady state at 10⁵ (the depth probe's process, which also held the synthetic
   node's chain, would pass 1 GiB near 3·10⁵: [design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)), and find the growth
   if it is the journal's. M11a's view: store each side row's meeting height (pruning re-judges protected side rows each sync); sections
   asked of several suppliers at once (if a first-sync budget needs it); a heavier fork more than about 10,000 headers below the tip is
   never reached (step-back doubling overruns the fetch budget on known headers; pre-existing); a node POST (`unspentBoxes`, `submit`) on
   a connection the node closed as idle is not sent again (M11b9 sends GETs once more; availability only, the publisher resends exact
   bytes); `moe venue audit` for restored views (release assurance's backup drills). Levers (Poseidon2 on Barretenberg, a 10⁶
   first-sync run) only if a budget fails.
6. **Slice 13**, release assurance, after 12 (Next 4's open correctness findings close in it at the latest): reproducible builds of the
   package and its artifacts, installed-package interoperability, backup and restore drills within the standing authority. Security reviews
   until then: separate AI instances (fresh reviewers, rolling audits); the external review once the product is complete (2026-10-01).
7. CI's real-proof checks run in five parallel groups (12 min, not 43) and skip for report/unread-doc commits ([decision](decisions/2026-10.md#2026-10-06--run-cis-real-proof-checks-in-parallel-groups-and-skip-them-only-for-unread-changes-tooling)); lever: split the drill
   or local replay. M10e2 left: the harness's proof-free cases in vitest with stand-in proofs; narrow the optional `StoredEvent.index`/`judgedIndex` when touched.
   Root-cause a Windows hang: PR #114 run 37350884943 attempt 1 timed out (30 s, vitest worker RPC too) in `pool-v3-replay-store` keep-point tests and `cli.test.mjs:158`; green on re-run.
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
10. **Claim-layer profiles** beside the pool ([direction](decisions/2026-10.md#2026-10-05--build-extensions-claim-layer-profiles-beside-the-shielded-pool-each-chosen-per-backing)): lit notes first (slice 14, Goal); offline, accumulator, Chaumian after release.
11. **Agent-first surfaces** (AGENTS.md direction): every command, wallet and service answer serves agents managing backings and wallets and autonomous AIs (one JSON object and coded exits exist, M10b); check each new lit command against it.
12. **Venues and assets.** [Research](docs/VENUE_ALTERNATIVES.md) (2026-10-05) agrees with the [2026-08-27 direction](decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it):
   Ergo fits best but one address mined 51% of 700 blocks; Bitcoin is second. Probe: OP_RETURN outputs over 83 bytes by pool over 2,016
   blocks (read-only), then a week's exhaustion read; before release assurance; BTC/XMR as chain-asset terms.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-10-06: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/`, `pool-v3-recovery-testnet-reader/` and `pool-v3-scope-testnet-reader/`
  bundles, `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch. The PC's Node is 24.21.0 (installed 2026-10-06).
- Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`, `node-startup/`, `sync-preparation/`;
  allocate no other. Archive node `C:\Users\Bob\ergo-node` (outside): synced, stopped, unused. Preserve legacy Temp/moeclean. Node management is authorized.
- Qualified custody, theft/power-loss/backup drills and continuous recovery need separate provisioning authority. Mainnet stays disabled.

## Open questions
- Non-blocking, local machine: the 10⁶ design-point run (budgets extrapolate from curves flat to 10⁵; [2026-10-03 direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance) item 1). Runs review and merge through other instances (maintainer's direction 2026-10-07).

Roughly **65% done / 35% remaining** (range 55–74%), reassessed 2026-10-07 (direction check): the lit service wire is merged; the lit commands,
failure path and adoption, an evidence replica (not counted before), holder transport, release assurance, qualified storage and mainnet remain.
