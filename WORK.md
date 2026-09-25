# Current work

Updated: 2026-09-25

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Ergo venue profile selected (2026-09-25): spec [venue-ergo.md](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/venue-ergo.md),
  pool-v3 §1/§13 ([decision](decisions/2026-09.md#2026-09-25--select-the-ergo-venue-profile-for-pool-v3-record-ranges)).
  Review changed the models: every header version byte is read (Autolykos
  v1 included) and every section under either root rule. Model only.
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

- Re-recorded 09-25 on the selected models: [header verification](docs/ergo-header-verification.json)
  (offline from `scratch/ergo-headers/`), [range profile](docs/ergo-range-profile-verification.json),
  [P4](docs/ergo-chain-cost-verification.json), [hostile framer](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2 read-back](docs/ergo-publication-verification.json), [local v3 replay](docs/pool-v3-local-replay-verification.json).
- [v2 circuits](docs/pool-v2-verification.json) (09-25): 180 checks, 89 named refusals, 7 hostile proofs refused beside valid controls.

## Next

1. Runtime adoption of the selected Ergo profile in place of the v2
   materialized view (`src/ergo.ts`): header store and range verifier behind
   the runtime venue interface, a header supplier policy (budget per supplier
   without refusing the heaviest visible chain), default depth 10, the
   grammar checked against the deployment's own publishing transactions.
2. Evidence binding: `check:evidence` checks only file-named keys (P2's
   `ergo_lib_wasm_bg.wasm` hash is unbound); `ergo-own-node-verification.json`
   drifts (re-run `header-check.mjs` on the own node); replay-cost drifts
   (`bytes.ts`, `scope.ts`, `notes.ts`, `poseidon2.ts`): re-record. Generators
   hash sources when writing, not building: hash at start (`local-check.mjs`).
3. Deferred review items: `inspectNotes`, replay's `statements.slice` and
   `activate`'s snapshots and history still read caller data twice (copies
   owned); a verifier throw in `submit` reloads the whole journal; retire the
   v1 store-codec path; shared v3 fixture/byte helpers; v3 harness verifiers
   reuse one instance.
4. Side paths: a supplier policy bounding what a header supplier may add
   (future-timestamp side branches halve their difficulty each epoch after
   ~256 blocks of work; the store keeps them); a pool-v3 record that moves
   a backing's venue (C2.3.1), so a hard fork need not force successors;
   exercise a mid-epoch odd header version and an ids-rule section on a
   devnet node (read from source only); testnet header rules; a
   faster Blake2b (the work check is ~21 ms a header in pure JavaScript);
   pin a real fixture with a multi-entry context extension; probe
   node/framer agreement under block-version 1–3 contexts.
5. Audit follow-ups: v3, fees and delivery circuit checks accept any refusal
   (`v3/check.mjs:121`, `fees/check.mjs:158`, `delivery/binding/check.mjs:89`):
   use `constraints.mjs`. `ByteReader` trusts a subclass's `length`
   (`src/bytes.ts`); readers re-read `args.configuration`/`verifier` after
   the entry check. v2 `bytecode(k)` hashes gzip output; v3: canonical ACIR.
6. Later: note tree Poseidon2 on Barretenberg wasm (~6x); a warmed spare
   verifier if ~1.1 s per malformed proof matters.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- The contained-sync node of 2026-09-12 is stopped. Retain the detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches. Do not delete the image or allocate another.
  [Sync handoff](https://github.com/mediumofexchange/reference-ts/blob/c85af7b/docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. Keep the cached node responses of P4
  (`scratch/ergo-chain/`) and of the header verification
  (`scratch/ergo-headers/`); their digests are in the reports.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication too.

## Open questions

None.

Roughly **54% done / 46% remaining**, plausible range **44–64%**, reassessed
2026-09-25: the Ergo venue profile is specified and its models conform;
runtime integration of that venue, qualified custody and continuous wallet
operation dominate.
