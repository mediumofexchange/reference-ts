# Current work

Updated: 2026-09-22

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

- Branch `feat/a10-mainnet-latency`: `latency.mjs` written, 6-minute smoke
  run passed, method reviewed (opus lane: no restart-level finding; window
  lower bound, pessimistic naming, censoring, reorg re-read, chain check,
  provenance and save retry fixed in 9e01858/a4021a4; readback running).
  24-hour run from a4021a4 started 2026-09-22 19:22 UTC as a detached
  process (`--hours 24 --tail-minutes 60 --out scratch/ergo-latency/report.json`),
  state `scratch/ergo-latency/run.json` with the collector hash inside;
  `--resume` continues it, `--report-only` recomputes the report and
  checks the chain. A pre-review run was stopped after 5 minutes
  (`scratch/ergo-latency/aborted-prereview.*`). Also on the branch: the P2
  text corrected to the window bound `k <= depth + 2`.
- Own nodes (approved 2026-09-22; same branch): `experiments/ergo-range/nodes.mjs`
  runs official v6.0.6 mainnet (UTXO-snapshot bootstrap, full headers) and
  testnet (archive + extra index) nodes from `scratch/ergo-nodes/`, APIs
  127.0.0.1:9053/9052; started 19:31 UTC, `watch 10` samples sync into
  `scratch/ergo-nodes/status.jsonl`. After a reboot run `nodes.mjs start`
  (and `watch`). Upstream hardcodes CORS `*` (setting ignored). Logs at
  WARN since the INFO log grew ~400 MB/h; testnet archive ~4 GB at 126k.
- Previous slice P2 delivered on main 2e71db3 (CI green): testnet
  publication accepted and read back, A11 closed.
- Throwaway testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json`
  (about 19,999.99 tERG); a byte-identical copy is kept outside the
  repository. Testnet transactions need no further approval; sweep boxes
  back and spend only fees.

## Evidence

- Smoke window 1878882-1878884: pool fell from 43 to 7 with one
  44-transaction block; a coinbase-only block followed while the pool held
  transactions; the second node agreed on every header.
- P2 testnet: seven transactions at k = 2 (two correlated observations).

## Next

1. When the run ends: read the report, update A10/probes/profile/guide,
   retain the report as `docs/ergo-latency-verification.json`, review, merge.
2. Header source done on the branch (54a87f7 onward): own node validated
   headers from genesis in 1 h 53 min; fixtures and the P4 window stand on its
   best chain (`docs/ergo-own-node-verification.json`); profile, A8,
   probes, status and guide updated. Review it together with A10.
3. Then decoder containment or the wallet/custody boundaries below.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  venue/digest authentication are modeled. Offline handoff freezes the source
  and binds one destination; old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): preflight fails;
  qualified hardware, theft/power-loss/backup drills and continuous recovery
  require separate provisioning authority.
- Ergo node is stopped. Retain the detached 20 GiB image
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
