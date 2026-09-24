# Current work

Updated: 2026-09-24

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Copy supplier (2026-09-24, branch `feat/copy-supply`, merged): neither the
  candidate Ergo reader nor its supplier decodes. `supply.mjs` copies each
  transaction's unsigned bytes from the node's JSON (order-keeping strict
  parser, no constant parsed) and leaves a copy that misses the stated id
  unsupplied; the model finds a block's header before reading it and frames
  only sections whose root holds
  ([decision](decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)).
  Decoder tooling retired (scripts at 0453955, reports kept in `docs/`). One
  independent review: no safety defect; quadratic token lookup fixed.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced;
  after a reboot or stop run `nodes.mjs start` and `watch 10` via WMI
  `Win32_Process.Create` (nodes started from an app's terminal die with it).
  Header source: `docs/ergo-own-node-verification.json`.
- Signing library: vendored release build of sigma-rust 2f840d3, only for
  `publish.mjs` and fixture trees (Windows-reproducible; Rust 1.87 +
  wasm-bindgen 0.2.128 in `~/.cargo`, `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.98
  tERG, copy outside the repo); testnet transactions need no approval;
  `--resume` on `scratch/ergo-testnet/run-framer.json` re-reads P2 unsubmitted.

## Evidence

- Re-recorded 09-24 on the final code: [P4](docs/ergo-chain-cost-verification.json)
  (all 28,196 supplied, 5,040 roots, 4,707 framed equal); [hostile framer
  probe](docs/ergo-framer-hostile-equivalence-verification.json) (48,865 node
  readings, 15,202 framed, 0 differing, 0 uncompared); [P2 read-back](docs/ergo-publication-verification.json);
  profile check; [local v3 replay](docs/pool-v3-local-replay-verification.json).

## Next

1. Authenticated header source a reader can run without a full node, the
   main gap before selecting the venue (ERGO_VENUE_PROFILE "Before
   selection"): compare NiPoPoW/light-client headers from the own node,
   several independent public sources, and the own full node as the
   profile's required source; measure what a reader keeps and checks.
2. Evidence binding: `check:evidence` checks only file-named keys, so no
   report binds `ergo_lib_wasm_bg.wasm` by that path (P2 asserts its hash);
   `ergo-own-node-verification.json` binds the P4 report and drifts
   (re-run `header-check.mjs` on the own node); replay-cost report drifts
   (`bytes.ts`, `scope.ts`): re-record.
3. Deferred review items: `inspectNotes`, replay's `statements.slice` and
   `activate`'s snapshots and history still read caller data twice (copies
   owned); a verifier throw in `submit` reloads the whole journal; retire the
   v1 store-codec path; shared v3 fixture/byte helpers; v3 harness verifiers
   reuse one instance.
4. Side paths from the copy-supplier review: pin one real fixture with a
   multi-entry context extension (from the P4 cache) so CI covers real key
   order; probe node/framer agreement under block-version 1–3 contexts.
5. Later: note tree Poseidon2 on Barretenberg wasm (~6x); a warmed spare
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
  full heights null/unresolved. Keep the week's cached node responses
  (`scratch/ergo-chain/`, digest in the P4 report).
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication
  remain separate dependencies.

## Open questions

- 2026-09-24, non-blocking, deletions awaiting approval (retained data, so
  not removed unasked): after the decoder's retirement nothing reads
  `scratch/equivalence/` and `scratch/ergo-chain-own/` (they reproduce the
  retired equivalence report offline), `scratch/sigma-alpha/`,
  `scratch/sigma-0.28.0/` (decoder controls) or `scratch/metering-python/`
  (Wasmtime probe install). To free them: `rm -rf scratch/equivalence
  scratch/ergo-chain-own scratch/sigma-alpha scratch/sigma-0.28.0
  scratch/metering-python` from `reference-ts/`. Nothing is blocked.

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-24: the venue path now carries no decoder on either side, and its
cost is measured and small; selection still needs an authenticated header
source. Runtime integration, selected venue, qualified custody and
continuous wallet operation dominate.
