# Current work

Updated: 2026-09-24

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Reader-verified headers (2026-09-24, branch `feat/ergo-header-verifier`,
  merged): `model/pool-v3-ergo-headers.ts` is the profile's header source
  run by the reader: canonical header bytes from any supplier, id, EIP-37
  difficulty, Autolykos v2 work, heaviest chain, rooted at the anchor with
  1,024 context headers authenticated by linkage; its best chain feeds the
  unchanged range verifier. `supply-header.mjs` copies header JSON to bytes
  ([decision](decisions/2026-09.md#2026-09-24--verify-ergo-headers-in-the-reader-from-the-pinned-anchor),
  [rules](docs/ERGO_VENUE_PROFILE.md#header-source)). One independent
  review: no divergence from the node; sweep coverage made strict, anchor
  pinned, byte-array checks hardened; side-branch difficulty lowering
  recorded as a limit (Next 4). No decoder on the reader or supplier side.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced;
  after a reboot or stop run `nodes.mjs start` and `watch 10` via WMI
  `Win32_Process.Create` (nodes started from an app's terminal die with it).
- Signing library: vendored release build of sigma-rust 2f840d3, only for
  `publish.mjs` and fixture trees (Windows-reproducible; Rust 1.87 +
  wasm-bindgen 0.2.128 in `~/.cargo`, `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.98
  tERG, copy outside the repo); testnet transactions need no approval;
  `--resume` on `scratch/ergo-testnet/run-framer.json` re-reads P2 unsubmitted.

## Evidence

- [Header verification](docs/ergo-header-verification.json) (09-24, offline
  from `scratch/ergo-headers/`): 6,940 headers from the P4 anchor verified,
  three nodes' chains equal, all 8,091 EIP-37 recalculations equal, 16,198
  swept headers' work valid, nine real-byte refusals
  ([probe](docs/POOL_DEPLOYMENT_PROBES.md#reader-verified-headers)).
- Current: [P4](docs/ergo-chain-cost-verification.json), [hostile framer probe](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2 read-back](docs/ergo-publication-verification.json), [local v3 replay](docs/pool-v3-local-replay-verification.json).

## Next

1. Venue-profile selection proposal: what a specification decision would
   pin for Ergo (identity and attribution rules, header store rules and
   suppliers consulted, depth from the A10 latency data), following the
   protocol-change procedure in AGENTS.md; then the runtime's adoption in
   place of the v2 materialized view.
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
4. Side paths: a supplier policy bounding what a header supplier may add
   (future-timestamp side branches halve their difficulty each epoch after
   ~256 blocks of work; the store keeps them); testnet header rules; a
   faster Blake2b (the work check is ~21 ms a header in pure JavaScript);
   pin a real fixture with a multi-entry context extension; probe
   node/framer agreement under block-version 1–3 contexts.
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
  full heights null/unresolved. Keep the cached node responses of P4
  (`scratch/ergo-chain/`) and of the header verification
  (`scratch/ergo-headers/`); their digests are in the reports.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and external publication
  remain separate dependencies.

## Open questions

None.

Roughly **52% done / 48% remaining**, plausible range **42–62%**, reassessed
2026-09-24: the venue path now needs neither a decoder nor a node, and a
reader authenticates headers and sections itself; selection still needs a
specification decision. Runtime integration, selected venue, qualified
custody and continuous wallet operation dominate.
