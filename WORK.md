# Current work

Updated: 2026-09-25

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Runtime Ergo venue (2026-09-25): `ErgoVenue` (`src/ergo.ts`) reads Ergo only
  under the selected profile, verifying headers from the anchor context and
  sections by root from untrusted suppliers (`src/ergo-supplier.ts`); the
  node-index view is retired and the profile code moved from `model/` to
  `src/` ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue),
  [decision](decisions/2026-09.md#2026-09-25--read-ergo-in-the-runtime-only-under-the-selected-profile),
  spec [venue-ergo.md at 01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md);
  [selection](decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)).
  No publishing, nothing persisted across restarts.
- v2 proof-relation audit (2026-09-25): ACIR range checks required and named
  in `check:pool`; v2 readers refuse any configuration but the pinned one
  ([decision](decisions/2026-09.md#2026-09-25--serve-and-read-v2-only-under-the-pinned-helper-and-the-verifiers-circuits)).
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Signing library: vendored release build of sigma-rust 2f840d3, only for
  `publish.mjs` and fixture trees (Windows-reproducible; Rust 1.87 +
  wasm-bindgen 0.2.128 in `~/.cargo`, `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.98
  tERG, copy outside the repo); testnet transactions need no approval;
  `--resume` on `scratch/ergo-testnet/run-framer.json` re-reads P2 unsubmitted.

## Evidence

- [Runtime venue on the mainnet](docs/ergo-runtime-venue-verification.json) (09-25):
  301 real headers and 291 sections from the own node, same block and answers
  from a public node alone, hostile suppliers passed over.
- Re-recorded 09-25 on the moved sources: [header verification](docs/ergo-header-verification.json)
  (offline from `scratch/ergo-headers/`), [range profile](docs/ergo-range-profile-verification.json),
  [P4](docs/ergo-chain-cost-verification.json), [hostile framer](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2 read-back](docs/ergo-publication-verification.json), [local v3 replay](docs/pool-v3-local-replay-verification.json),
  [v2 circuits](docs/pool-v2-verification.json).

## Next

1. Ergo publishing adapter, so one supported witness accepts the runtime's
   publications: the PoolStore outbox (and replacement/revocation records)
   written as transactions in the framer's grammar at the profile's
   locations and read back through `ErgoVenue`. Cheapest decisive probe
   first: sign a P2PK input with Ergo's proveDlog Schnorr on
   `@noble/curves` (no sigma-rust in the runtime) and have the own testnet
   node accept it. Then fees/change, minimum box values, resubmission.
2. `ErgoVenue` persistence: headers and retained objects across restarts,
   spilling past `retainedBytes`, pruning side branches below the clock.
3. Evidence binding: `check:evidence` checks only file-named keys (P2's
   `ergo_lib_wasm_bg.wasm` hash is unbound) and skips bound files that no
   longer exist; `ergo-own-node-verification.json` drifts (re-run
   `header-check.mjs` on the own node); replay-cost drifts: re-record.
   Generators hash sources when writing, not building: hash at start.
4. Deferred review items: `inspectNotes`, replay's `statements.slice`, `activate`
   read caller data twice; a verifier throw in `submit` reloads the journal;
   retire the v1 store-codec path; shared v3 fixture/byte helpers.
5. Side paths: the clock follows the slowest supplier its header budget
   stops; a pool-v3 record moving a backing’s venue (C2.3.1); a devnet check
   of mid-epoch header versions and ids-rule sections; testnet header rules;
   a faster Blake2b (~21 ms a header); a multi-entry context extension fixture.
6. Audit follow-ups: v3, fees and delivery circuit checks accept any refusal
   (`v3/check.mjs:121`, `fees/check.mjs:158`, `delivery/binding/check.mjs:89`):
   use `constraints.mjs`. `ByteReader` trusts a subclass's `length`
   (`src/bytes.ts`); readers re-read `args.configuration`/`verifier` after
   the entry check. v2 `bytecode(k)` hashes gzip output; v3: canonical ACIR.
7. Later: note tree Poseidon2 on Barretenberg wasm (~6x); a warmed verifier.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  digest authentication is modeled; offline handoff freezes the source.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Retain the stopped contained-sync node’s detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches. Do not delete the image or allocate another.
  Keep the cached node responses of P4 (`scratch/ergo-chain/`) and of the
  header verification (`scratch/ergo-headers/`); their digests are in the reports.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication too.

## Open questions

None.

Roughly **56% done / 44% remaining**, plausible range **46–66%**, reassessed
2026-09-25: the runtime reads an external witness it verifies itself;
publishing to it, qualified custody and continuous wallet operation dominate.
