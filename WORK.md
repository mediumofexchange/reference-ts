# Current work

Updated: 2026-09-24

## Goal

Next slice: decoder equivalence over the own mainnet node's blocks. The driver
finished 2026-09-24 00:07 (five chunks, heights 1,830,001–1,879,100, all exit
0; `scratch/equivalence/`, cache `scratch/ergo-chain-own/`). A review found that
chain-cost only rebuilds bytes, checks roots and checks non-refusal; it never
compares the decoder's id, output trees and registers with the node JSON. Add
that comparison as an offline post-pass over the cached transactions, count and
sample differences, and make `passed` require none. Bind the post-pass and the
driver's exact command in the summary, and link chunks by header id rather
than height. Then write `docs/ergo-decoder-equivalence-verification.json`.
Acceptance: report, probes/decoder decision updated, one review, merged with
CI green. Stop boundary: no decoder or profile selection, no spec or runtime
change.

## Status

- Review pass (merged 2026-09-24, each branch independently reviewed): v2
  ingestion reads caller objects once (admission, journal rows, wallet
  checkpoints/notes, species-safe `copyBytes`); refusals keep the loaded
  journal; retained evidence and true proof answers are reused; internal
  change IDs get no public request, token or invitation. v3 replay charges
  imports, clocks and publications once; report sources come from the import
  graph and lockfiles, spec pin in `scripts/pool/v3/provenance.mjs`. Ergo
  tooling fixes: decoder corpus, publish, nodes.mjs, latency. The
  contained-node harness is retired to Git history (permalinks at c85af7b).
- A13 replay cost, served-trail prefixes (spec 786f962) and A10 inclusion
  latency are merged and reviewed; numbers live in
  [probes](docs/POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet)
  and the retained reports. No depth is selected.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced (5.4 / 17.5 GB);
  after a reboot run `nodes.mjs start` and `watch 10`. Header source
  reviewed and merged: `docs/ergo-own-node-verification.json`.
- Decoder pin: vendored reproducible release build of sigma-rust 2f840d3
  (`experiments/ergo-range/vendor/`, decision 2026-09-23), merged; the npm
  alpha was a debug build. Rust 1.87 + wasm-bindgen 0.2.128 installed
  (`~/.cargo`, `scratch/rust-toolchain`, source cache `scratch/sigma-rust-src`).
- Metered decoder: `metered-check.mjs --week` decodes the P4 window; the own
  decoder stays (decision 2026-09-23); adversarial bounds and a budget are open.
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (about
  19,999.99 tERG), a copy kept outside the repository; testnet transactions
  need no further approval; sweep boxes back and spend only fees.

## Evidence

- Own node headers, P2 testnet and replay cost: see the linked reports.

## Next

1. Decoder equivalence (Goal): add the tree/register comparison post-pass,
   then `equivalence-summary.mjs --out docs/ergo-decoder-equivalence-verification.json`.
   The node prunes to its last 50,000 full blocks; chunks start at 1,830,001.
   Chain-cost and equivalence-summary still duplicate helpers other Ergo
   scripts have (parse, fetch/retry, model compile); share them only when a
   report is re-recorded anyway, since each move changes bound hashes.
2. Deferred review items: classify bb.js verifier throws (truncated,
   past-modulus, off-curve proof, destroyed backend) before narrowing
   `barretenberg.ts`'s catch-all; retire the v1 store-codec path if no v1
   journal must load; shared v3 fixture/byte helpers across the check
   scripts; scope replay resumes only under the same selected backing.
3. Later: a Linux or CI reproducible build of the decoder pin; the note
   tree's Poseidon2 on Barretenberg wasm (about 6x); a reader budget.

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
  Keep `scratch/equivalence/` and `scratch/ergo-chain-own/` until the
  equivalence report is retained.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-22: the venue cost is measured and small and P2 is done on the
testnet; selection still needs an authenticated header source and decoder
containment. Runtime integration, selected venue/decoder, qualified custody
and continuous wallet operation dominate remaining effort.
