# Current work

Updated: 2026-09-19

## Goal

Completed C2b.5.2 non-service counting on `feat/v3-non-service-count` from
5aff3a7, for delivery on `main`. Companion specification remains `main` at
3ed1800; existing signed terms/configuration and request relation suffice.

Acceptance: seedless real-proof counts read the last canonical state strictly
before the judging index; bind the signed grade and candidate configuration;
preserve first request identity indices and distinct tags across handover;
exclude spent/locked notes; refuse missing dependencies; agree in fresh processes.
No live-chain or configuration-adoption claim.

## Status

- Main 5aff3a7 hosted CI 35455624167 passed; upstream fetched, clean baseline.
- Implemented the count using existing signed terms, kind-7 proofs and the
  classified checkpoint/import walk. Identity windows survive handover;
  canonical spent tags and deadline-sensitive locks determine service.
- Independent source review and hostile helper probes found no material
  issues. Final real-proof acceptance passed; delivery target is `main`.

## Evidence

- Reuse main 5aff3a7's passing hosted runtime/circuit/dependency baseline;
  runtime, circuits, keys and dependencies are unchanged.
- Final `npm run check:pool:ergo-replay`: 104 groups / 37 real proofs pass,
  including seedless count agreement through the package in a fresh process.
  Coverage includes identity/proof variants, both window endpoints, refresh,
  canonical lock expiry/spend, handover, missing evidence and verifier failure.
- Documentation, syntax and focused diff checks pass. The [retained report](docs/pool-v3-local-replay-verification.json)
  has all source hashes verified against final files. Final main hosted CI
  must be checked separately. No protection or required rulesets exist;
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

1. Check final main CI, then close same-index fresh silence openings. Resolve
   C2.10.4/C2b.4.1's predecessor distinction with independent review before
   changing dependent code; demonstrate the currently refused case with real
   proofs while preserving silence retirement and exact adopted publications.
2. Same-index fresh silence openings with a same-index predecessor and
   multi-backing closure remain unsupported. Import lapse requires full trails.
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

A fresh instance is recommended for the next predecessor-boundary slice;
the completed count is handed off, and that rule needs fresh source review.
