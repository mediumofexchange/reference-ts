# Current work

Updated: 2026-09-22

## Goal

Completed slice: P4, the cost of the candidate Ergo profile's exhaustion on
the real chain from a real anchor, measured against public nodes (the
retained node image stays stopped). Acceptance: for the last day and seven
days of recent mainnet blocks, exact transaction sections obtained from
public node JSON reproduce every header's transaction root; two independent
public nodes agree on every header of the window and the anchor; the pinned
reader decoder's coverage is counted with each refusal's cause; the model
verifier from the real anchor answers or names the unresolved indices;
header and section bytes per block/day/week and the times are in a retained
report; docs and the recovery map record the numbers and limits; independent
review of the method with its findings resolved. Evidence limits: public
nodes are a trust input (no proof-of-work or chain-selection check), no
node acceptance of our transactions (P2), no decoder equivalence, no
inclusion-latency distribution. Stop boundary: no profile selection, no
dependency pin change, no specification change, no runtime path.

## Status

- Delivered: `experiments/ergo-range/chain-cost.mjs` (explicit network
  probe, not in `check` or CI), the [retained report](docs/ergo-chain-cost-verification.json),
  the [probe record](docs/POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor),
  profile-doc costs/limits, recovery map P4/A8/A10 and implementation status.
- Findings that bind later choices: the pinned sigma-rust 0.28.0 refuses
  every transaction with an Ergo 6.0 script (ErgoTree header version 3):
  125 transactions in 58 of 5,040 blocks, so those indices have no section
  and no day- or week-long range answers under it; the npm alpha
  `0.29.0-alpha-2f840d3` (2025-08-13, measured from `scratch/sigma-alpha/`,
  not pinned) reads all of them with exact round trips, about 7× slower.
  The node's JSON yields exact bytes only as written: a parsed-and-re-emitted
  object sorts a spending-proof extension's keys and mis-serializes 12 of
  the week's transactions. Header roots bind unsigned bytes and concatenated
  proofs, not the proofs' split among inputs.
- Review (one opus lane) found eight material defects in the first draft
  (overwritten provenance, non-equivalent alternate decoder, alternate
  package leaking into the pinned measurement, aggregates over unauthenticated
  blocks, mislabelled timings, NTFS stream cache names); all fixed and
  re-measured, with the decoder copy checked against `decoder.mjs` on every
  transaction (28,196 equal) and the two builds' outputs compared (28,071
  equal).

## Evidence

- Report window: anchor 1873360, indices 0..5039 at heights
  1873361..1878400, depth 10, both nodes agree on 5,050 headers; 26.6 MB of
  sections (mean 5,286 bytes a block, median 424, max 193,531), 221-byte
  wire headers, 715.5 blocks/day over 169 hours; verifier built in 1.3 s.
- Prior slice (Ergo adapter over every replay group): `main` 55d2ab5, CI run
  35652746308; its replay/profile reports are unchanged and still bound
  (`decoder.mjs` untouched).

## Next

1. Decoder selection before profile selection: a contained, node-equivalent
   decoder that reads Ergo 6.0 scripts (an upgrade past 0.28.0, or keeping
   unparsed sized trees as exact bytes); a reviewed dependency decision.
2. P2 node publication and reassembly, which also gives A10's inclusion
   latency; or the wallet/custody boundaries below.

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
  (`scratch/ergo-chain/`, digest in the report) and `scratch/sigma-alpha/`
  can be regenerated; keep them while the decoder decision is open.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-22: the venue cost is now measured on the real chain and is small,
but selection gained a concrete prerequisite (a decoder for Ergo 6.0
scripts) and still needs P2, an authenticated header source and decoder
containment. Runtime integration, selected venue/decoder, qualified custody
and continuous wallet operation dominate remaining effort. No rounded
estimate change.
