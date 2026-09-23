# Current work

Updated: 2026-09-23

## Goal

Active slice: recovery-map A10, inclusion latency against C3.3 window.
Authorized at tip `T` with the instant at the latest witnessed index, a
publication has force when included at `T + k` with `1 <= k <= depth + 2`.
Measure k on the **mainnet** passively: `experiments/ergo-range/latency.mjs`
polls a public node pool (ids only) and blocks, GET only, no key and no
submission, never run by `check` or CI. Acceptance: a retained report of
one 24-hour window with k bracketed per sighting (node height at the
sighting and at the round before), dropped/pending counted as misses, the
fraction within the window for depths 0-20, strata by size and fee per
byte, block intervals and empty blocks, and a second node header
agreement; recovery map A10, probes, profile and guide state the result and
what it implies for the declared depth. One independent review; merged and
pushed with CI green. Evidence limits: one node pool, the population is not
a kind-4 publication, one day. Stop boundary: no depth selection, no
specification or runtime change, no mainnet submission or real funds.

## Status

- Branch `feat/a10-mainnet-latency` (merged to main through e370581, CI
  green): `latency.mjs` reviewed and read back; 24-hour run from a4021a4
  since 2026-09-22 19:22 UTC, detached, state `scratch/ergo-latency/run.json`
  (`--resume`; `--report-only` recomputes and checks the chain). A second
  run against the own node (`own-run.json`) ends at the same time.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, full headers, 127.0.0.1:9053) and testnet (archive + index,
  127.0.0.1:9052) from `scratch/ergo-nodes/`, both synced (5.4 / 17.5 GB);
  after a reboot run `nodes.mjs start` and `watch 10`. Header source
  reviewed and merged: `docs/ergo-own-node-verification.json`.
- Decoder stack (2026-09-23, on the branch, review owed): the pinned alpha is
  a debug build; a node-valid tx (block 1,827,841 #1) and depth-110
  constants overflow the default stack and poison the WASM instance.
  `decoder.mjs` now needs `--stack-size=4000` and treats traps as fatal;
  `stack-check.mjs`, `docs/ergo-decoder-stack-verification.json`, decision
  2026-09-23. Equivalence over the own node's 51k blocks
  (`scratch/equivalence-driver.mjs`, then `equivalence-summary.mjs`) is
  paused so the node stays idle during the latency runs.
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (about
  19,999.99 tERG), a copy kept outside the repository; testnet transactions
  need no further approval; sweep boxes back and spend only fees.

## Evidence

- Own node: 1.88 M headers from genesis in 6,863 s; fixtures and the P4
  week on its best chain. Stack probe: pinned build 1,173 KB for the fixture
  tx, 11.8 KB a nesting level (1,339 KB at the node cap 110); 0.28.0 71 KB.
- P2 testnet: seven transactions at k = 2 (two correlated observations).

## Next

1. After ~20:25 UTC: reports for both latency runs (`--pair` the two
   states), retain `docs/ergo-latency-verification.json`, update A10,
   probes, profile and guide.
2. Resume the equivalence driver, summarize into
   `docs/ergo-decoder-equivalence-verification.json`.
3. One review of stack + equivalence + A10; merge and push with CI green.

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
  [Sync handoff](docs/ergo-node-sync-resume-verification.json): headers 97,923;
  full heights null/unresolved. The week's cached node responses
  (`scratch/ergo-chain/`, digest in the report), `scratch/sigma-alpha/` and
  the `scratch/sigma-0.28.0/` control can be regenerated; keep the cache.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-22: the venue cost is measured and small and P2 is done on the
testnet; selection still needs an authenticated header source and decoder
containment. Runtime integration, selected venue/decoder, qualified custody
and continuous wallet operation dominate remaining effort.
