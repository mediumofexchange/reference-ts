# Current work

Updated: 2026-09-25

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- v2 proof-relation audit (2026-09-25, `test/v2-circuit-refusals`): circuits
  match pool-v2 §7. `check:pool` now requires ACIR range checks on every
  integer/boolean input and names each hostile witness's refused constraint
  (`scripts/pool/constraints.mjs`); before, noir_js's encoder refused them.
  Segment, store and readers refuse any configuration but §1's helper and the
  verifier's circuits ([decision](decisions/2026-09.md#2026-09-25--serve-and-read-v2-only-under-the-pinned-helper-and-the-verifiers-circuits)).
- Reader-verified headers (2026-09-24, merged): `model/pool-v3-ergo-headers.ts`
  ([decision](decisions/2026-09.md#2026-09-24--verify-ergo-headers-in-the-reader-from-the-pinned-anchor),
  [rules](docs/ERGO_VENUE_PROFILE.md#header-source)); side-branch
  difficulty lowering is a recorded limit (Next 4).
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

- [Header verification](docs/ergo-header-verification.json) (09-24, offline
  from `scratch/ergo-headers/`; [probe](docs/POOL_DEPLOYMENT_PROBES.md#reader-verified-headers)).
- [v2 circuits](docs/pool-v2-verification.json) (09-25): 187 checks, 89 named refusals, 7 refused hostile proofs.
- Current: [P4](docs/ergo-chain-cost-verification.json), [hostile framer probe](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2 read-back](docs/ergo-publication-verification.json), [local v3 replay](docs/pool-v3-local-replay-verification.json).

## Next

1. Venue-profile selection proposal: what a specification decision would
   pin for Ergo (identity and attribution rules, header store rules and
   suppliers consulted, depth from the A10 latency data), following the
   protocol-change procedure in AGENTS.md; then the runtime's adoption in
   place of the v2 materialized view.
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
   ~256 blocks of work; the store keeps them); testnet header rules; a
   faster Blake2b (the work check is ~21 ms a header in pure JavaScript);
   pin a real fixture with a multi-entry context extension; probe
   node/framer agreement under block-version 1–3 contexts.
5. Audit follow-ups: v3, fees and delivery circuit checks accept any refusal
   (`scripts/pool/v3/check.mjs:121`, `fees/check.mjs:158`,
   `delivery/binding/check.mjs:89`): use `constraints.mjs`. `ByteReader`
   trusts a Uint8Array subclass's `length` (`src/bytes.ts`): copy on entry.
   v2 `bytecode(k)` hashes gzip output (§2); v3 should hash canonical ACIR.
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
  approval stays disabled; device qualification and external publication
  remain separate dependencies.

## Open questions

None.

Roughly **52% done / 48% remaining**, plausible range **42–62%**, reassessed
2026-09-24: the venue path needs neither a decoder nor a node; selection
still needs a specification decision. Runtime integration, selected venue,
qualified custody and continuous wallet operation dominate.
