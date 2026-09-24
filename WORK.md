# Current work

Updated: 2026-09-24

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Profile framer (2026-09-24, branch `feat/profile-framer`, merged): the
  candidate Ergo reader takes each transaction as its unsigned bytes and
  witness id and frames outputs itself; a transaction outside the grammar
  carries no record and its block keeps its section, so no decoder refusal
  denies a range; sections only for block versions 1–4
  ([decision](decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)).
  `supply.mjs` derives the bytes supplier-side. One independent review, no
  blockers; v3 Ergo replay passed in CI only (local run: memory pressure).
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced (5.4 / 17.5 GB);
  after a reboot or stop run `nodes.mjs start` and `watch 10` via WMI
  `Win32_Process.Create` (nodes started from an app's terminal die with it).
  Header source: `docs/ergo-own-node-verification.json`.
- Decoder pin: vendored reproducible release build of sigma-rust 2f840d3
  (`experiments/ergo-range/vendor/`); Rust 1.87 + wasm-bindgen 0.2.128 in
  `~/.cargo`, `scratch/rust-toolchain`, source cache `scratch/sigma-rust-src`.
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.98
  tERG, copy outside the repo); testnet transactions need no approval.

## Evidence

- Re-recorded 09-24: profile check; [P4](docs/ergo-chain-cost-verification.json)
  (5,040 roots, 4,707 framed txs equal to the node, 24.2 MB supplied);
  [hostile](docs/ergo-decoder-hostile-equivalence-verification.json) (18,382
  framed node readings, 0 differing); [P2 live](docs/ergo-publication-verification.json).

## Next

1. Owed by the framer slice, each run alone (the host ran out of memory with
   four jobs): the hostile run on unsigned seeds (`hostile-equivalence.mjs
   --jdk scratch/jdk/jdk-21.0.12.1+1 --unsigned --work scratch/hostile-unsigned
   --out docs/ergo-framer-hostile-equivalence-verification.json`, ~45 min,
   then cite it in the probe section and decision), and a local
   `npm run check:pool:ergo-replay` copying `scratch/pool-v3-local-replay-results.json`
   to `docs/pool-v3-local-replay-verification.json` (also clears that
   report's `bytes.ts`/`scope.ts` drift).
2. Fewer mechanisms: no reader path uses `contained-decoder.mjs`,
   `wasm-meter.mjs` or `contained-check.mjs` now; decide whether to retire
   them (reports bind them; keep history by permalink) or keep them as the
   supplier's decoder. The model frames every supplied block before its root
   check (frame after the root matches); `supply.mjs` throws on a
   derivation mismatch instead of counting it unsupplied.
3. Evidence binding: `check:evidence` checks only file-named keys, so no
   report binds `ergo_lib_wasm_bg.wasm`; the equivalence report (drifting on
   package.json) omits `model/pool-v3-*.ts`'s `src/` imports and
   `tsconfig.json`; `contained-range.mjs` binds no inputs; replay-cost report
   drifts (`bytes.ts`, `scope.ts`): re-record.
4. Deferred review items: `inspectNotes`, replay's `statements.slice` and
   `activate`'s snapshots and history still read caller data twice (copies
   owned); a verifier throw in `submit` reloads the whole journal; retire the
   v1 store-codec path; shared v3 fixture/byte helpers; v3 harness verifiers
   reuse one instance.
5. Later: an authenticated header source a reader can run without a full
   node; a Linux or CI reproducible build of the decoder pin; the note tree's
   Poseidon2 on Barretenberg wasm (about 6x); a warmed spare verifier
   instance if admission's ~1.1 s per malformed proof matters.

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
  full heights null/unresolved. The week's cached node responses
  (`scratch/ergo-chain/`, digest in the report), `scratch/sigma-alpha/` and
  the `scratch/sigma-0.28.0/` control can be regenerated; keep the cache.
  `scratch/equivalence/` (chunk and field reports the retained summary binds
  by hash) and its cache `scratch/ergo-chain-own/` reproduce the equivalence
  report offline; the node has since pruned their earliest blocks.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication
  remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-24: venue cost measured and small, P2 done on the testnet, and no
decoder refusal can deny a range; selection still needs an authenticated
header source. Runtime integration, selected venue, qualified custody and
continuous wallet operation dominate.
