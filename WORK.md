# Current work

Updated: 2026-10-09

## Goal
Order ([direction 2026-10-09](decisions/2026-10.md#2026-10-09--fix-the-operators-restart-replay-before-the-10-run-and-write-the-security-argument-the-external-review-needs)): **(bb) (local or cloud) and slice 19 (cloud) now → slice 18 from scratch (local, after (bb)) → (bf) before slice 19's brief is frozen → public pages.**
- **Next 4 (bb), the operator's restart read (a fix).** *Evidence:* slice 18, killed for a restart test at 12,489 statements, then failed ten restarts (first read past the client's 10 s idle bound); one restarted `serve` timed
  to the end held its turn about 5⅓ min (640 s CPU) until the restarts' 36 mined blocks put the scope past its witnessing horizon (`scratch/dp6/restart-probe.log`, `run/serve.log`). Matches (bb)'s symptom; cause unconfirmed (slice 15's restart at 10⁵ took 1.5 s).
  *Acceptance:* first reproduce on `scratch/dp6/run` (or a smaller history) and confirm (bb)'s mechanism, else file a new letter; a restarted `serve`, after an abrupt stop too, reads only what it has not kept: its first admission costs what slice 15 measured
  (about 1–1.5 s at 42 a checkpoint, the accepted exception), whatever the history length; a regression test at a depth where a whole replay shows (fails on main); journal adversarial review. *Stop:* the fix and its evidence.
- **Slice 18, the 10⁶ design-point run, from scratch (local machine)**, on (bb)'s fixed revision. *Goal:* the [design point](docs/PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets) itself: admission during the journal's own read
  (about 0.6–1.7 s extrapolated, against ≤ 1 s), a reader's memory (about 800–900 MB, against 1 GiB), and a restart's first admission at 10⁵ and 10⁶. *Method:* `scratch/dp6/` ([slice 15's](docs/POOL_DEPLOYMENT_PROBES.md#the-design-points-two-edges-slice-15) driver for Windows):
  marks at 10⁵ and 10⁶, holdings capped at 25,000 ((az)), above-normal priority, host CPU beside serve's; `keep.mjs` restarts a failed driver, `launch.cmd` starts it detached. Before relaunch: move the worktree `scratch/wt/dp6` to the fixed revision and build it;
  delete `scratch/dp6/run/` and `exit.txt`, rename `driver.log`/`keep-out.log` aside; set the driver's `SILENCE` far beyond any restart's mined blocks (it already waits through a client timeout without mining);
  re-create the Startup entry `moe-dp6.vbs` from `launch.cmd`'s comment; a short smoke run with a forced restart. About 2–3 days of awake time; keep the PC light meanwhile (no local real-proof, full or measurement runs; ports 39053–39056).
  *Acceptance:* `run/report.json` done (bands of 10⁴; both marks' first, steady-state and nothing-new reads; the restarts); a probes section against each budget; the gate row and design-point text updated; the tooling committed at one revision, then deleted. *Stop:* measure and record; a failed budget becomes a Next item with its lever.
  *Limits:* stand-in proofs, synthetic blocks, one backing, one run, a 2-core laptop CPU (i7-5500U, 16 GB) below the declared hardware.
- **Slice 19, readiness for the external review (cloud, now).** (a) `docs/SECURITY_ARGUMENT.md`: the release's claims (supply, payment soundness and privacy, holder authorization, compartmentalized failure and recovery), each claim's assumptions
  (the proof system and Barretenberg's code, one honest parameter contributor and genuine powers, Poseidon2, SHA-256, Ed25519, AES-GCM/HKDF capsules, the venue's honest majority) and why the checks imply it, building on Construction §C4, pool-v3's soundness note, the [visibility matrix](docs/POOL_V3_VISIBILITY.md) and the [protocol rules](docs/PROTOCOL_RULES.md);
  residual risks (Ergo's [concentration](docs/VENUE_ALTERNATIVES.md), C3.5's late release); a fresh adversarial reviewer. (b) A review brief: scope, pinned release record, reproduce commands, dispositioned findings, out of scope. (c) The human authentication channel: the digest argument with its limit, or Next 9's text frame.
  (d) Reconcile each gate's standing: an owner or a correction for every open item (Adversarial model's runtime integration and availability evidence, Public supply's "supported product", Defined profile's deployment choices).
- **Then the public pages:** the site's reference line (it still names multi-backing statements as remaining; no commands, lit, replica or release record) and the organization profile (formats now adopted by name), under the site's push double-check. Last delivered: Next 4 (bd) (#161). **Slice 13, release assurance, is done** (M13a–M13h, #143–#153: [release record](docs/RELEASE.md)); the external security review stays outside (Open questions).

## Status
- **Slices 10–14 done** (slice 12: transport, replica, relay, #136–#140) (PRs in #69–#111 and #117; decisions M10a–M11b12 in [2026-10](decisions/2026-10.md)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands) run from an `npm pack`
  install with real proofs on the synthetic node and live on the testnet; the Ergo view in SQLite rows, caught up in bounded passes; every budget
  holds to 10⁵ statements ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h)), the operator's memory levelling off near 600 MB; slice 15 brought (ay) within budget and reduced (az).
- **Audits**: area 27 (state machine, [decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); area 29 (wallet, [decision](decisions/2026-10.md#2026-10-04--fail-a-payment-whose-output-another-statement-created-and-fail-no-act-with-a-pending-receipt-by-the-doors-times-audit-area-29)); area 31 (readers): a continuation whose opening the record moved past is excluded, or lapsed in a gap, and a receipt reads a term end and a moved-past `after` without its opening ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)); the journal not yet; area 30 (transport): a source's mark moves only past an answer that delivers its selection, and a stream's minimum rate is charged to the peer alone, on both sides ([decision](decisions/2026-10.md#2026-10-07--move-a-sources-mark-only-past-an-answer-that-delivers-its-selection-and-charge-a-streams-rate-to-the-peer-alone-audit-area-30)). Review-code 2026-10-06 (`3a240f6..582d6fc`, six lanes): resumed kept walks recheck scope; a truncated `wallet.db` refuses; no failed act is published; Node floor 24.21.0. Review-code 2026-10-08 (`582d6fc..f4cf083`, five lanes, #154, [decision](decisions/2026-10.md#2026-10-08--close-the-code-review-of-slices-1214-a-fenced-backups-restoration-spacing-a-settlement-to-the-holders-own-owner-and-a-release-check-bound-to-its-record)): a fenced backup's restoration draws a fresh spacing; pool `settle` refuses an owner of the holder's own (`OWN_KEY`); `release.mjs --verify` binds to its record. Simplify 2026-10-07: one evidence chain for both constructions (#133); the store checks' live testnet modes retired (#134).

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [who sees what](docs/POOL_V3_VISIBILITY.md), [Ergo venue](docs/ERGO_VENUE_PROFILE.md).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json), [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json)/[Ergo](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json)/[Ergo](docs/pool-v3-succession-store-ergo-verification.json), [scope](docs/pool-v3-scope-store-verification.json)/[Ergo](docs/pool-v3-scope-store-ergo-verification.json), [history](docs/pool-v3-history-store-verification.json),
  [redemption](docs/pool-v3-redemption-store-verification.json)/[Ergo](docs/pool-v3-redemption-store-ergo-verification.json). Historical: live commands [de1f688](docs/pool-v3-command-testnet-verification.json) (before slice 13), live recovery [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal `2c6b20c`, header/mainnet reader `6e4cea8`, pool-v2 [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. (Item numbers and letters are stable: AGENTS.md and decisions cite them.)
2. [Visibility](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) duties: all landed (M10c2, M12a–c), each with its limits. M12c levers if a deployment needs them: a relay budget per window of witnessed indices, a check that a release names a witnessed demand.
3. M10c2 leftovers: synthetic index lag knob; read the budget's boxes before
   readiness (review); the relay judges no gap itself; drill `EARLY`, `CONFIGURATION`, a relay `BUDGET` and `UNWITNESSED`.
4. Deferred review findings: [M13g](decisions/2026-10.md#2026-10-08--judge-lapse-before-the-readers-own-snapshot-serve-every-forks-trail-and-disposition-the-rest-of-next-4-slice-13-m13g) fixed or dispositioned every letter open before it (fixed ones are in
   their decisions; new findings take letters after (ax)). Waiting, each on the trigger M13g names: performance (j), (t), (u), (aj),
   (ak), (al), (m)'s sync abort signal; replica availability (ap), (aq), (ar); their change (y) next wallet profile, (ad) mainnet,
   (z) a holder path for force-created outputs, (ao); tooling (g), (aa); accepted (n), (an), (af), (v) (directory lock). M13f limits
   (accepted): a lost instance's statement in flight at a restoration lands beside a retry; a note another instance received and
   spent between two reads is never held. Slice 15 ([edges](docs/POOL_DEPLOYMENT_PROBES.md#the-design-points-two-edges-slice-15)) fixed (ay). **(bb), next (Goal):** a journal read at an index
   below its kept reads' discards them and replays its whole history in one turn (37 s at 2.7·10³ statements in slice 15; its symptom in slice 18: a restarted `serve` held about 5⅓ min at 1.25·10⁴, cause to confirm), so a restart
   at scale can hold admission past the budget and lapse its backings; also a restarted `serve`'s first admission reads what the previous process admitted (1.0–1.5 s at 42 statements a checkpoint).
   (bf), before slice 19: an extra kept lit demand row goes unchecked. Waiting on its trigger: (az) a wallet's read holds about 2.2 KB a holding beyond a reader's (1 GiB near 1.8·10⁵ unspent notes in a first sync);
   the lever, rows and a streamed view, is taken if a holder must pass about 1.5·10⁵. (bc), (be), (bd) fixed ((bc)'s limit and levers in its decision);
   accepted (ba): a lit read re-checks every marked note (about 0.14 ms each, 14 s a read at 10⁵), within the steady state.
5. Slice 11 leftovers (the 10⁵ rerun is M13h: `serve`'s memory levels off near 600 MB, its JavaScript heap near 7 MB). M11a's view: store each side row's meeting height (pruning re-judges protected side rows each sync); sections
   asked of several suppliers at once (if a first-sync budget needs it); a heavier fork more than about 10,000 headers below the tip is
   never reached (step-back doubling overruns the fetch budget on known headers; pre-existing); a node POST (`unspentBoxes`, `submit`) on
   a connection the node closed as idle is not sent again (M11b9 sends GETs once more; availability only, the publisher resends exact
   bytes). Lever (a 10⁶ first-sync run) only if a budget fails; Barretenberg's Poseidon2 is taken (slice 15).
6. **Slice 13**, release assurance: done but for the external review. Security reviews until the external review (once the product is complete, 2026-10-01): separate AI instances (fresh reviewers, rolling audits).
7. CI's real-proof checks run in five parallel groups (12 min, not 43) and skip for report/unread-doc commits ([decision](decisions/2026-10.md#2026-10-06--run-cis-real-proof-checks-in-parallel-groups-and-skip-them-only-for-unread-changes-tooling)); lever: split the drill
   or local replay. M10e2 left: the harness's proof-free cases in vitest with stand-in proofs; narrow the optional `StoredEvent.index`/`judgedIndex` when touched.
   Root-cause a Windows hang: PR #114 run 37350884943 attempt 1 timed out (30 s, vitest worker RPC too) in `pool-v3-replay-store` keep-point tests and `cli.test.mjs:158`; green on re-run.
8. On touching affected files (simplify survey 2026-10-07): wallet-store's pool and keyed `reprove`/`keyedResign`, supersede and `superseded` blocks; one CLI profile per construction for `wallet.ts`'s `keyed ? lit : pool` branches; the wallet's pool and `keyed*` flows (`keyOf` copies, positional intents; audit area 33);
   one `moe` harness for the two command drills; one fixture `foldSegment` (`receiptFields`; re-records local replay); `store-check`/`history-store-check` onto `drill.mjs` with a `drill.serve`; reports written to `docs/` directly; CLI `commitmentOf`/`READ` shared; `openProver` refuses absent parameters as
   `PARAMETERS` (exits 3 now). Also shared byte helpers; Ergo section versus transaction charging; served-trail caller-object cache; drop the `vite` dev pin at the next dependency change; test a second commit refused while one is in flight (`store.ts` `ready`).
   Not worth it: `fulfill` into `sync` (its credit-once exit contract) and a second atomic writer (replay-store's `replaceFile`, only with its next change).
9. Only when a gate needs them (none of the smallest profile's does): cancellation (release with other outputs; also closes C3.5's late-witnessed release; pool-v4 could bind the acceptance in `rho_out`), batching, venue-moving record, slowest-supplier clock, multi-entry extension fixture, sponsored
   holder funding, operator fee quotes, a kind-4 fee by length (fee-per-byte nodes rank a long run last once a pool fills; C3 deadlines), a
   text/QR request frame, C4.5 pending-acceptance receipt handoff, same-segment rescoping; against hostile evidence growth (M4) a per-supply bound
   tied to what the venue newly holds and serving a reader only the segments its checkpoints name. Past the smallest profile: statements
   spending several backings, adding an original-term backing to a live scope, single-backing openings' |E| over-reserve; a phone-first wallet
   (a venue range source proportional to the subject's records, a new venue identity, then a succinct relation).
10. **Claim-layer profiles** beside the pool ([direction](decisions/2026-10.md#2026-10-05--build-extensions-claim-layer-profiles-beside-the-shielded-pool-each-chosen-per-backing)), each only where it serves a function no other does ([2026-10-08](decisions/2026-10.md#2026-10-08--build-a-claim-layer-profile-only-where-it-serves-a-function-no-other-profile-serves)): pool the default; lit notes (slice 14, adopted) for links carrying only tiny packets: after release, measure its frames against a mesh packet budget; size cuts and a spend salt (closing (bc)'s limit) are lit-v2 candidates; offline after release; accumulator and Chaumian only if a comparison shows a function of their own.
11. **Agent-first surfaces** (AGENTS.md direction): every command, wallet and service answer serves agents managing backings and wallets and autonomous AIs (one JSON object and coded exits exist, M10b); check each new lit command against it.
12. **Venues and assets.** [Research](docs/VENUE_ALTERNATIVES.md) (2026-10-05) agrees with the [2026-08-27 direction](decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it):
   Ergo fits best but one address mined 51% of 700 blocks; Bitcoin is second. Probes 1 and 2 (slice 16, [results](docs/VENUE_ALTERNATIVES.md#results-of-probes-1-and-2-slice-16)) keep it:
   AntPool's template group (a third of blocks) delays records over 83 B; its reader fails the declared transfer budget. Read-only
   probe 3 (slice 17, [results](docs/VENUE_ALTERNATIVES.md#results-of-read-only-probe-3-slice-17)): records reach mempool.space's mempool before mining and
   their wait sets C3.3's margin, so the depth. Next: mainnet publication of our own records once funded (Open questions); `venue-bitcoin.md`, with
   its reader's own budget line, after release (Ergo is the release's venue, its concentration a stated residual risk in slice 19). BTC/XMR as chain-asset terms.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under `scratch/ergo-nodes/`, stopped
  2026-10-06: run them (`experiments/ergo-range/nodes.mjs start|stop`) only while work uses them, allowing catch-up sync.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public `pool-v3-testnet-reader/`, `pool-v3-recovery-testnet-reader/` and `pool-v3-scope-testnet-reader/`
  bundles (their readers retired; re-read with the scripts at `09534a8`), `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch. The PC's Node is 24.21.0 (installed 2026-10-06).
- Until slice 18 is recorded: `scratch/dp6/` (driver, hooks, `restart-probe.log`, `run/`: stopped 2026-10-09 past its witnessing horizon, kept as (bb)'s evidence until the relaunch deletes it; about 70 GB at 10⁶) and the worktree `scratch/wt/dp6`. No dp6 process or Startup entry is live. Retain the stopped contained-sync node's 20 GiB `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`, `node-startup/`, `sync-preparation/`;
  allocate no other. Archive node `C:\Users\Bob\ergo-node` (outside): synced, stopped, unused. Preserve legacy Temp/moeclean. Node management is authorized.
- Qualified custody, theft/power-loss/backup drills and continuous recovery need separate provisioning authority. Mainnet stays disabled.

## Open questions
- Non-blocking, local machine: a live re-run of the command drill (its report predates slice 13; after slice 18 ends), the 10⁶ design-point run (slice 18, Goal: stopped, relaunched from scratch after (bb)), and a live Tor run of M12a's onion route an M12b replica and an M12c relay behind their own onion names (latency, isolation by credential, Tor's refusal of internal addresses). Runs review and merge through other instances (maintainer's direction 2026-10-07).
- Non-blocking, maintainer (2026-10-08): the external security review, release assurance's one remaining item; commissioning it lies
  outside the standing authorization. Slice 13's own part is done; slice 19 writes the security argument and brief it reviews; rolling AI reviews continue meanwhile (Next 6).
- Non-blocking, maintainer (2026-10-08): Bitcoin probe 3's decisive part publishes 136 B and 15.5 KB records on mainnet against
  fee (Next 12), which spends real funds outside the standing authorization: fund or authorize a small budget (under about
  100,000 sats at 1–2 sat/vB). The read-only variant is done (slice 17).
- Deletion list (2026-10-07): none open.

Roughly **72% done / 28% remaining** (range 62–80%), reassessed 2026-10-09 (direction check): the restart replay (bb) is a gate defect at scale and the
security argument is uncounted work; every budget still holds at 10⁵ otherwise. The external review and its findings, qualified storage and custody, and mainnet remain.
