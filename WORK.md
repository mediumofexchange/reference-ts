# Current work

Updated: 2026-10-05

## Goal
**Slice 14: the lit implementation** (Next 10; numbered after 13 but before it; spec `lit-v1.md`, a draft until adopted;
[layouts decision](decisions/2026-10.md#2026-10-05--fix-the-lit-constructions-bytes-outputs-derived-by-every-reader-owner-signatures-over-the-statement-the-pools-frames-without-a-proof-digest-next-10)).
Acceptance: the reference replays a lit trail through the shared seams (records, `state.ts`'s validity seam, frames, reader) with
lit-v1's verdicts, hostile cases included, and conformance vectors bind every byte layout; then a decision adopts `moe/lit/v1`.
Stop boundary: adoption; wallet commands and venue drills for lit backings are later slices.
- **M14a–b done** ([decision](decisions/2026-10.md#2026-10-05--implement-the-lit-byte-layer-and-close-four-readings-lit-v1-left-open-slice-14-m14a), spec `1bf5bfc`): `src/lit/` bytes for §§2–6, 8–9 with oracle vectors;
  §6 frames through pool-v3's codecs parameterized by construction (no v3 change, review differential); each reviewed, read-back clean.
- **M14c next: the validity seam.** Design first, reviewed before code: `state.ts`/`replay-store.ts` generalized over a construction
  (v3's field nf/cm and note tree versus lit's bytes, no tree) or a lit machine over one store; then a hostile lit trail replay.

## Status
- **Slice 10 done but M10d** (PRs #69–#91, decisions [M10a](decisions/2026-10.md#2026-10-02--ship-the-six-compiled-relations-in-the-package-and-require-every-readers-verifier-to-name-them-slice-10-m10a)–[M10e2](decisions/2026-10.md#2026-10-03--read-every-replay-harness-package-through-the-runtime-reader-and-drop-the-no-venue-replay-slice-10-m10e2)): the `moe` [commands](docs/POOL_V3_WALLET.md#commands)
  run from an `npm pack` install with real proofs on the synthetic node; pilot, transparent path, second reader retired. M10d needs the local machine.
- **Slice 11 done** (PRs #92–#95, #97–#99, #101–#106, #108, #109, #111; decisions M11a–M11b12 in [2026-10](decisions/2026-10.md)): the Ergo view in SQLite rows, Next 4's
  (k)–(n), (s), (v), (w) closed, a view caught up in bounded passes; every budget holds to 10⁵ statements ([design point](docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)).
  Gaps: the operator's own memory at depth (Next 5); the wallet's 10⁵ points, lost to a container restart.
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
1. (Item numbers and letters are stable: AGENTS.md and decisions cite them.)
2. [Visibility](docs/POOL_V3_VISIBILITY.md#what-the-reference-does-not-do-yet) duties: `freshen`, relay, explanations landed (M10c2). **Slice 12** ([direction](decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)):
   duties 2–3 (transport, a credential not per holder, syncs, gap funding); first probe: clients through a SOCKS5 proxy such as Tor.
3. M10c2 leftovers: synthetic index lag knob; testnet context has no difficulty floor (M10d); read the budget's boxes before
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
   output awaiting adoption is not reported at all (only never as spendable).
5. Slice 11 leftovers. Measure `moe operator serve` as its own process at 10⁵ (the depth probe's process, which also held the synthetic
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
7. The harness's second reader retired (M10e2). Left: run its proof-free cases in vitest with stand-in proofs and consider a real-proof
   job only for ready PRs (CI time); narrow the still-optional stored event indices (`StoredEvent.index`, `judgedIndex`) when touched.
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
10. **Claim-layer profiles** beside the pool, chosen per backing ([direction](decisions/2026-10.md#2026-10-05--build-extensions-claim-layer-profiles-beside-the-shielded-pool-each-chosen-per-backing)). Design done and reviewed
   ([decision](decisions/2026-10.md#2026-10-05--make-the-transparent-profile-lit-notes-under-the-pools-rules-with-each-output-named-by-the-statement-that-creates-it-design-slice-next-10)): the transparent profile is lit notes under the pool's rules. Layouts done
   (`lit-v1.md`, draft until adopted); next the implementation through the shared seams, before slice 13; offline, accumulator, Chaumian after release.

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
  a funded testnet funding key under a spend budget); the synthetic drill (`command-drill.mjs`) is its rehearsal. Also local: a 10⁶ design-point run;
  re-record `testnet-reader-check.mjs`'s readback from the retained bundle (its report binds sources retired since `2fd0f08`), or retire both.
- Non-blocking (2026-10-02): needs the local machine: M9c2 (a)'s testnet anchor bound rests on sampled mainnet headers. With the own
  mainnet node running, record the least mainnet difficulty from height 1,025 (lowest `nBits` per header) in the M9c2 decision; nothing waits on it.

Roughly **64% done / 36% remaining** (range 54–74%), reassessed 2026-10-05: the design point holds to 10⁵ and the profile design is
settled; the live drill, the lit profile (layouts, code), release assurance, holder transport, qualified storage and mainnet remain.
