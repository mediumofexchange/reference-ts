# Current work

Updated: 2026-09-24

## Goal

No slice is open. Pick the next from Next below and state its acceptance
here before starting.

## Status

- Proof verifier failures (merged 2026-09-24, reviewed): bb.js 5.2.0's five
  malformed-proof throws verify as `false`, other failures are rethrown,
  and the verifier verifies only on its own instance, replaced after every
  throw (a reused instance fails every call after 89 throws)
  ([decision](decisions/2026-09.md#2026-09-24--answer-false-only-for-malformed-proofs-and-never-verify-on-an-instance-that-threw)).
- Contained decoder (merged 2026-09-24, reviewed): the reader's replay
  adapter, v3 Ergo check and profile check decode through
  `contained-decoder.mjs`, a fresh instance per transaction of a metered
  derivation (`wasm-meter.mjs`: fuel, memory/table caps, call-depth ceiling)
  under a budget linear in its length; all 342,253 corpus, week and retained
  transactions decode with the node's fields
  ([probe](docs/POOL_DEPLOYMENT_PROBES.md#contained-decoder)). `decoder.mjs`
  stays the unmetered reference the older reports bind.
- Decoder node equivalence (merged 2026-09-24, reviewed): over the own
  node's 49,100 retained blocks the release decoder reads all 314,028
  transactions with the node's id, witness id, trees and registers
  ([probe](docs/POOL_DEPLOYMENT_PROBES.md#decoder-node-equivalence-over-the-retained-blocks));
  `equivalence-driver.mjs` → `equivalence-fields.mjs` → `equivalence-summary.mjs`.
- A13 replay cost, served-trail prefixes (spec 786f962) and A10 inclusion
  latency are merged and reviewed; numbers live in
  [probes](docs/POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet)
  and the retained reports. No depth is selected.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced (5.4 / 17.5 GB);
  after a reboot or a stop run `nodes.mjs start` and `watch 10`, launched
  through WMI `Win32_Process.Create`: nodes started from an app's terminal
  died with it on 2026-09-24. Header source: `docs/ergo-own-node-verification.json`.
- Decoder pin: vendored reproducible release build of sigma-rust 2f840d3
  (`experiments/ergo-range/vendor/`, decision 2026-09-23), merged; the npm
  alpha was a debug build. Rust 1.87 + wasm-bindgen 0.2.128 installed
  (`~/.cargo`, `scratch/rust-toolchain`, source cache `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (about
  19,999.99 tERG), a copy kept outside the repository; testnet transactions
  need no further approval; sweep boxes back and spend only fees.

## Evidence

- Own node headers, P2 testnet and replay cost: see the linked reports.

## Next

1. Node equivalence for hostile inputs (the contained decoder bounds cost,
   not agreement with the node on bytes it refuses or reads differently).
   When chain-cost's report is next re-recorded: move its decoder to
   `contained-decoder.mjs`, fix `decoder.mjs`'s header comment, bind the vendored JS glue
   (`vendor/.../ergo_lib_wasm.js`, as `equivalence-fields.mjs` does) and share
   its helpers (exact-text split, fetch/retry, model compile) with the
   equivalence scripts; each move changes bound hashes.
2. Deferred review items: retire the v1 store-codec path if no v1 journal
   must load; shared v3 fixture/byte helpers across the check scripts. (A
   v3 replay resumes only under its selected backing already: the resume
   key carries it, `local-replay.mjs` `resumeKeyOf`.)
3. Later: a Linux or CI reproducible build of the decoder pin; the note
   tree's Poseidon2 on Barretenberg wasm (about 6x); a per-read host-memory
   budget for the contained decoder; a warmed spare verifier instance if
   admission's ~1.1 s per malformed proof matters.

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
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-24: the venue cost is measured and small, P2 is done on the testnet
and the reader's decoder is contained under a budget; selection still needs
an authenticated header source and hostile-input node equivalence. Runtime integration, selected venue/decoder, qualified custody
and continuous wallet operation dominate remaining effort.
