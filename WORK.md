# Current work

Updated: 2026-09-19

## Goal

Receipt finality across silence/return on `feat/v3-receipt-finality` from
dfc4dbc, for delivery on `main`. Companion specification stays `main` at
3ed1800; no normative change.

Acceptance: real-proof original and adopted receipts retain exact inclusion
and liability precedence across silence, lapse unfinished tails, distinguish
repair from abandonment, refuse missing dependencies, and agree in a fresh
process. No live-chain or configuration-adoption claim.

## Status

- Implemented a seedless single-receipt query using package kind 10 and the
  existing verified checkpoint/import walk. It authenticates the opening,
  scope and held reference, comparing all five event fields. Adopted receipts
  name the new segment and position but retain source proof/signature hashes.
- Inclusion wins immediately. Contradiction and abandonment survive later
  silence; unfinished receipts lapse at the earlier silence or term boundary.
  Excluded/noncarrying checkpoints occupy sequences without making holes.
- Missing later evidence cannot erase an already returned inclusion. Refusals
  retain proven contradictions; no receipt result exposes wallet state.
- Independent source review found one fact-preservation gap on late encoding
  or resource refusal. All expected refusal branches now retain contradictions;
  readback resolved the finding. Source and test review closed with no
  unresolved material findings; final execution passed.

## Evidence

- Main dfc4dbc hosted CI 35453949661 passed all seven jobs this session.
  Reuse its unchanged runtime/circuit/dependency baseline: 1,934 tests and
  package/service/wallet/crash/spent plus real v2/v3 proof acceptance.
- Final `npm run check:pool:ergo-replay`: 91 groups / 31 real proofs pass,
  including original and adopted receipts in fresh processes. The first run
  exposed a too-early replacement fixture; corrected under the unchanged rule.
  Syntax, docs and focused diff checks pass. The [retained report](docs/pool-v3-local-replay-verification.json)
  has source hashes verified against final files.
- Delivery target is `main`; final hosted CI must be checked separately.
  No branch protection or required rulesets exist; no safeguards changed.

## Existing local product and custody boundary

- Configured v2 supports one constant-payout backing, real-proof local payments,
  private delivery and independent public audit. Venue/digest authentication
  are locally modeled. No real funds or host controls changed.
- Offline handoff freezes source and binds one destination. Mark paper export
  historical before activating the matching unfrozen restore; lost replies stay
  with that destination. Old exports cannot resume after activity.
- [Device contract](docs/POOL_WALLET_DEVICE.md) and
  [observations](docs/pool-wallet-device-verification.json): automatic preflight
  fail; directory ACL refused, BitLocker/PIN and Secure Boot unavailable.
  Physical theft, cross-account, power-loss, backup isolation and continuous
  recovery qualification need separately authorized test hardware/provisioning.
- Ergo node stopped; [continuation report](docs/ergo-node-sync-resume-verification.json)
  (headers 97,923, full heights null, unresolved). Retain the detached 20 GiB
  image scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd;
  do not delete it or allocate another. No sync run is active.

## Next

1. Read final main hosted CI, then implement the non-service count and its
   signed terms/configuration dependencies as the next complete recovery path.
2. Same-index fresh silence openings with a same-index predecessor and
   multi-backing closure remain unsupported. Import lapse requires full trails.
   Authenticated venue evidence remains open; receipt queries retain the same
   conditional fixture boundary as checkpoint replay.
3. P2 confirms the measured 24-piece transaction on a node; P4 measures
   exhaustion from index zero on a real chain. Decoder node equivalence is a
   selection prerequisite; a decoder refusal denies ranges through its height.
4. Configuration approval stays disabled until adoption prerequisites hold.
   Device qualification and external publication remain separate dependencies.
5. Workflow opportunity: cache ignored real-proof fixtures by exact source and
   configuration hashes for replay-only iteration. Repeated fixture corrections
   currently regenerate unchanged proofs; retain separate generation checks.

## Open questions

Reassessed from existing evidence: roughly **50% done / 50% remaining**,
plausible range **40-60%**. Reusable recovery logic has advanced; selected
venue/decoder, complete recovery, qualified custody and user operation remain
the largest blocks. No percentage change is warranted.

A fresh instance is recommended for the non-service count: it begins a
separate terms/configuration slice, with this receipt work fully handed off.
