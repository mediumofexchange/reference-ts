# Current work

Updated: 2026-10-08

## Goal
**Proposed next: slice 15, the design point's two edges** (Next 4 (ay), (az); [M13h](docs/POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h)), the only budgets
M13h found at their edge. Must achieve: a statement's admission stays within ≤ 1 s while `serve` reads its own newly held checkpoint,
and a wallet's sync memory stops growing with its holdings. Acceptance: (ay) after comparing the smallest alternatives (the journal's
read skips verifying statements whose receipts it signed; that read off the admission queue; Poseidon2 on Barretenberg), a 10⁵ profile
of `serve` (M13h's probe at [51ea592](https://github.com/mediumofexchange/reference-ts/tree/51ea592/scripts/pool/v3/design-point-rerun), restored to scratch) shows no admission waiting on that read past 1 s;
(az) a wallet sync over about 10⁵ holdings stays near a reader's memory, its outputs unchanged. Stop: both merged with adversarial review
(journal read, wallet state), CI green. Change the proposal if something else brings release closer, and say why.

**Slice 13, release assurance, is done** (Next 6; [2026-10-03](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance) item 3): (a) M13a #143 ([release record](docs/RELEASE.md), CI's
`reproducible-release`); (b) M13c #145 ([separate installs](docs/RELEASE.md#separate-installs)); (c) M13d #146, spec #19 (a restored operator returns past
silence at a skipped sequence) and M13e #147 (`wallet restore --copy`, copied views audited, `moe venue audit`); (d) M13b #144, M13f (spec C3.5
114799e: `rho_out` reads the acceptance, `FORKED`, lit's paid-request refusal) and M13g #152 (every open Next 4 letter fixed or
dispositioned, spec #21); (e) M13h #153: the 10⁵ rerun. The external security review stays outside (Open questions).

## Status
- **Slices 10–14 done** (slice 12: transport, replica, relay, #136–#140) (PRs in #69–#111 and #117; decisions M10a–M11b12 in [2026-10](decisions/2026-10.md)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands) run from an `npm pack`
  install with real proofs on the synthetic node and live on the testnet; the Ergo view in SQLite rows, caught up in bounded passes; every budget
  holds to 10⁵ statements ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h)), the operator's memory levelling off near 600 MB; at the edge only (ay) and (az).
- **Audits**: area 27 (state machine, [decision](decisions/2026-10.md#2026-10-03--hold-the-note-trees-last-leaf-and-judge-7s-position-bound-first-audit-area-27)); area 29 (wallet, [decision](decisions/2026-10.md#2026-10-04--fail-a-payment-whose-output-another-statement-created-and-fail-no-act-with-a-pending-receipt-by-the-doors-times-audit-area-29)); area 31 (readers): a continuation whose opening the record moved past is excluded, or lapsed in a gap, and a receipt reads a term end and a moved-past `after` without its opening ([decision](decisions/2026-10.md#2026-10-06--exclude-a-continuation-whose-opening-the-record-moved-past-and-read-a-receipts-term-end-without-its-segments-opening-audit-area-31)); the journal not yet; area 30 (transport): a source's mark moves only past an answer that delivers its selection, and a stream's minimum rate is charged to the peer alone, on both sides ([decision](decisions/2026-10.md#2026-10-07--move-a-sources-mark-only-past-an-answer-that-delivers-its-selection-and-charge-a-streams-rate-to-the-peer-alone-audit-area-30)). Review-code 2026-10-06 (`3a240f6..582d6fc`, six lanes): resumed kept walks recheck scope; a truncated `wallet.db` refuses; no failed act is published; Node floor 24.21.0. Simplify 2026-10-07: one evidence chain for both constructions (#133); the store checks' live testnet modes retired (#134).

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
   spent between two reads is never held. M13h ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-operator-apart-and-the-wallet-at-depth-m13h)), the Goal's slice: (ay) `serve`'s read of its own newly held
   checkpoint verifies and replays its statements again while admissions queue in its one journal turn (about 1 s at 28 statements);
   (az) a wallet's sync holds about 6 KB a holding (1 GiB near 1.2·10⁵ unspent notes).
5. Slice 11 leftovers (the 10⁵ rerun is M13h: `serve`'s memory levels off near 600 MB, its JavaScript heap near 7 MB). M11a's view: store each side row's meeting height (pruning re-judges protected side rows each sync); sections
   asked of several suppliers at once (if a first-sync budget needs it); a heavier fork more than about 10,000 headers below the tip is
   never reached (step-back doubling overruns the fetch budget on known headers; pre-existing); a node POST (`unspentBoxes`, `submit`) on
   a connection the node closed as idle is not sent again (M11b9 sends GETs once more; availability only, the publisher resends exact
   bytes). Levers (Poseidon2 on Barretenberg, a 10⁶ first-sync run) only if a budget fails.
6. **Slice 13**, release assurance: done but for the external review. Security reviews until the external review (once the product is complete, 2026-10-01):
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
- Non-blocking, local machine: a live re-run of the command drill (its report predates slice 13), the 10⁶ design-point run (budgets extrapolate from curves flat to 10⁵; [2026-10-03 direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance) item 1), and a live Tor run of M12a's onion route an M12b replica and an M12c relay behind their own onion names (latency, isolation by credential, Tor's refusal of internal addresses). Runs review and merge through other instances (maintainer's direction 2026-10-07).
- Non-blocking, maintainer (2026-10-08): the external security review, release assurance's one remaining item; commissioning it lies
  outside the standing authorization. Slice 13's own part is done; rolling AI reviews continue meanwhile (Next 6).
- Deletion list (2026-10-07): none open.

Roughly **75% done / 25% remaining** (range 65–82%), reassessed 2026-10-08 (M13h): slice 13 delivered release records, separate installs,
restore drills and every open finding dispositioned, and the design point holds at 10⁵ but for two edges; the external review and its
findings, the edges (ay), (az), qualified storage and custody, and mainnet remain.
