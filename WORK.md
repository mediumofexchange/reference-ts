# Current work

Updated: 2026-09-19

## Goal

Completed same-index fresh silence openings on `feat/v3-same-index-openings`
from cfa91a5. Companion `spec/same-index-return-predecessor` is delivered on
specification `main` at fb7dd07, committed before dependent code.

Acceptance: fresh openings import the latest valid child-relative predecessor,
including lower same-operator sequences at the same index; stale imports fail.
Real-proof recovery keeps strict-before publication force, exact ordered adoption,
inherited adoption indices and old segment retirement; fresh readers agree.
No live-chain or configuration-adoption claim.

## Status

- Main cfa91a5 hosted CI 35458301811 passed; upstream fetched, clean baseline.
- Fresh openings reuse C2.10.4–5 while preserving the strict-before snapshot
  for publication force and clocks. Independent normative and patch reviews
  found no material blockers. Real-proof acceptance passed; delivery target
  is implementation `main`.

## Evidence

- Reuse main cfa91a5's passing hosted runtime/circuit/dependency baseline;
  runtime, circuits, keys and dependencies are unchanged.
- Final `npm run check:pool:ergo-replay`: 106 groups / 37 real proofs pass,
  including repeated-return seedless and issuer restoration in fresh processes.
  New cases
  cover repeated open/closed-gap openings, nonempty same-index predecessors,
  stale imports, exclusions, missing trails, exact adoption and retirement.
- Documentation, syntax and focused diff checks pass. The [retained report](docs/pool-v3-local-replay-verification.json)
  has all source hashes checked against final files. Final main
  hosted CI must be checked separately. No protection or required rulesets exist;
  no safeguards changed.

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

1. Check final main CI. Next product slice: two-backing finalized import
   closure under C2.10.3–7; prove shared events count once and one stale/missing
   scoped predecessor prevents whole-checkpoint finality.
2. Multi-backing closure remains unsupported. Import lapse requires full trails.
   Authenticated venue evidence remains open; counts and receipts retain the same
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

A fresh instance is recommended for the next multi-backing closure slice because it
expands the replay model beyond this resolved single-backing boundary.
