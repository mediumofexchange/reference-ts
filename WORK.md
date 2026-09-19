# Current work

Updated: 2026-09-19

## Goal

Candidate Ergo profile adapter completed in implementation commit 6ce9dc4,
from `feat/v3-ergo-replay-adapter` for delivery on `main`. Companion specification
stays `main` at 3ed1800 (no normative change).

Acceptance: the existing replacement/import/payment/burn trace replays from
exact synthetic Ergo transaction bytes through the profile's checked block
roots and bounded range answers, including portable-package seedless audit
and receiver restoration in fresh processes. Missing, tampered, undecodable,
wrong-venue and over-budget evidence returns no partial state. Headers remain
an explicitly trusted synthetic fixture; no live chain or adoption claim.

## Status

- Design review: reuse the existing sigma-rust round-trip decoder and bind
  the profile and limits independently of package contents. No new parser,
  venue format, construction decision or protocol rule is needed.
- Implemented: each intrinsic byte view is charged before its immediate copy;
  all evidence is owned before decoding and proof awaits. Results explicitly
  name the candidate Ergo profile with trusted synthetic headers.
- Independent adversarial review reproduced disguised length/shared-storage
  and later-getter resize bypasses. Intrinsic checks and immediate copies fix
  them; regression execution and independent readback closed all findings.
- No runtime, circuit, key, dependency, device-control or specification change.
  Silence-bearing imports, multi-backing closure and adoption remain unsupported.
  Import term-lapse currently requires full trail evidence; header-only lapse
  is a recorded availability improvement.

## Evidence

- Base main 5e51cbb: CI 35438845448 passed all seven jobs (confirmed remotely).
- Final `npm run check:pool:ergo-replay`: 48 groups / 14 real proofs passed,
  including fresh seedless/receiver processes, decodable root mismatch,
  missing/undecodable sections, profile/header substitution and raw budgets.
  The imported payment/burn trace uses 21 blocks / 3,764 raw transaction bytes.
  [Retained report](docs/pool-v3-local-replay-verification.json).
  Replay and profile report source hashes match the final files.
- `npm run check:ergo:range`: 342 block, 14,874 decoder and 247 profile checks
  pass. `npm run check` passes all 1,934 tests plus package, service, wallet,
  crash-recovery and spent-set acceptance; docs/typecheck pass. Vitest required
  approved escalation after its sandbox loader was denied workspace access.
- CI now includes the adapter in both v3 proof jobs. Read the final main
  revision's hosted run before resuming; the baseline run above is separate.
- No normative change; [decision](decisions/2026-09.md#2026-09-19--bound-raw-ergo-evidence-before-local-proof-replay).

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

1. Next product slice: single-backing silence-bearing imports. State the clock,
   retirement and exact predecessor rules from existing specification, review
   independently, then demonstrate fresh public audit/receiver restoration and
   refusal of stale or withheld closure. Multi-backing remains separate.
2. P2 (publication on a node) confirms the measured 24-piece transaction;
   P4 measures exhaustion from index zero on a real chain; decoder node
   equivalence is a selection prerequisite. A decoder-refused transaction
   currently denies every range through its height.
3. Configuration approval stays disabled until all adoption prerequisites hold;
   device qualification and external publication remain separate dependencies.
   Do not alter this workstation's controls.

## Open questions

- Reassessed from current evidence: roughly **50% done / 50% remaining**,
  plausible range **40-60%**. Single-backing imports advance the experiment;
  selected venue/decoder, complete recovery, qualified custody and user
  operation remain the largest blocks. No percentage change is warranted.
- Switch to a fresh instance after delivery for silence-bearing imports: the
  next slice needs a focused review of clock/retirement semantics, while this
  adapter's evidence and remaining boundaries are captured here.
