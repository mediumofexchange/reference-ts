# Current work

Updated: 2026-09-25

## Goal

No slice is open. Take Next 1 and state its acceptance here before starting.

## Status

- Ergo (2026-09-25, [guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue)): `ErgoVenue`
  reads under the selected profile, verifying headers and sections itself
  ([decision](decisions/2026-09.md#2026-09-25--read-ergo-in-the-runtime-only-under-the-selected-profile),
  spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)),
  and publishes kind 1–3 records through `ErgoPublisher` (one funding key,
  one remembered transaction per record, proveDlog on `@noble/curves`)
  ([decision](decisions/2026-09.md#2026-09-25--publish-kind-13-records-on-ergo-from-the-runtimes-own-wallet)).
  Testnet only; nothing persisted across restarts.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Vendored sigma-rust 2f840d3 release build, only for `publish.mjs`, fixture
  trees and cross-checks (Windows-reproducible; Rust 1.87 + wasm-bindgen
  0.2.128 in `~/.cargo`, `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.97
  tERG, copy outside the repo); testnet transactions need no approval;
  `--resume` on `scratch/ergo-testnet/run-framer.json` re-reads P2 unsubmitted.

## Evidence

- [Publisher on the testnet](docs/ergo-publisher-verification.json) (09-25): three records
  chained, corrupted proofs refused, a lost answer retried without a second transaction.
- [Runtime venue on the mainnet](docs/ergo-runtime-venue-verification.json) (09-25):
  300 real headers and 290 sections, same answers from a public node alone.
- Re-recorded 09-25: [headers](docs/ergo-header-verification.json), [range](docs/ergo-range-profile-verification.json),
  [P4](docs/ergo-chain-cost-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2](docs/ergo-publication-verification.json), [v3 replay](docs/pool-v3-local-replay-verification.json), [v2](docs/pool-v2-verification.json).

## Next

Direction ([2026-09-25](decisions/2026-09.md#2026-09-25--direct-the-next-work-at-the-v3-runtime-and-its-failure-path)):
the release runs v3, which alone carries the failure path, so the claim layer,
store and wallet move to it next, single-backing first. v2-only fixes wait for
that move; review and audit runs favor code that carries forward.

1. v3 runtime plan (own slice, reviewed before code): map `model/pool-v3-*`
   and `scripts/pool/v3/` onto `src/`; replace `src/pool` or run beside it
   until v2 freezes as an oracle; order slices so issue→pay→receive→redeem
   and the failure path run on `ErgoVenue` early; guard the unadopted
   candidate; give each pool-v3 §1 adoption item (identities, complete
   certificates, replay/import rules, resource bounds) its closing slice.
   Acceptance: reviewed plan, decision entry, this list rewritten as slices.
2. v3 core in the runtime: issue, spend with fee outputs and delivery
   capsules, burn; store, wallet and service on the local venue and
   `ErgoVenue`; shared v3 fixture/byte helpers.
3. Failure path in the runtime, single-backing first: demand, settle,
   request, silence clock and lapse, snapshot redemption and return, kind-4
   runs on Ergo; a testnet drill with the operator offline and an independent
   reader (needs testnet header rules). Then multi-backing recovery.
4. Persistence: `ErgoVenue` headers and objects (spill past `retainedBytes`, prune side
   branches below the clock); unsettled publications, preferably in the store's outbox.
5. v3 adoption: circuit checks name refusals via `constraints.mjs`
   (`v3/check.mjs:121`, `fees/check.mjs:158`, `delivery/binding/check.mjs:89`);
   canonical ACIR identities; the approvals pool-v3 §1 lists.
6. Hygiene when touching the files: `check:evidence` binds only file-named
   keys (P2's wasm hash) and skips vanished files; generators should hash
   sources at start; own-node and replay-cost reports drift. `ByteReader`
   trusts a subclass's `length`; readers re-read `args.configuration`/`verifier`.
   v2 items (`inspectNotes`, replay `statements.slice`, `activate`, `submit`
   journal reload, v1 store codec, `bytecode(k)` gzip): fix in code that carries forward.
7. Later, off the release path: cancelling an abandoned publication, batched
   records, an index-free box source, a venue-moving record (C2.3.1), the
   slowest-supplier clock, devnet mid-epoch versions, faster Blake2b, a
   multi-entry extension fixture, Poseidon2 on Barretenberg, a warmed
   verifier. Mainnet publication needs a funded key (real funds).

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  digest authentication is modeled; offline handoff freezes the source.
- [Device contract](docs/POOL_WALLET_DEVICE.md), [observations](docs/pool-wallet-device-verification.json):
  preflight fails; qualified hardware, theft/power-loss/backup drills and
  continuous recovery require separate provisioning authority.
- Retain the stopped contained-sync node’s detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches; do not delete it or allocate another. Keep the cached node
  responses of P4 (`scratch/ergo-chain/`) and headers (`scratch/ergo-headers/`); reports hold their digests.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and mainnet publication too.

## Open questions

None.

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-25 (direction check): the runtime reads and publishes on a witness it
verifies itself; moving claims, store and wallet to v3, runtime recovery,
adoption, persistence, custody and mainnet operation dominate.
