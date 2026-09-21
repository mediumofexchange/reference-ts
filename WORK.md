# Current work

Updated: 2026-09-21

## Goal

Completed slice: compact intrinsic exclusion at target positions after a returned
segment's adopted block (§9.1 items 3–4) in the single-backing import walk, the
receipt walk and the shared-scope walk. Inside-block targets stay unsupported.

Acceptance: a compact proof/issue-K fault after the record-derived block excludes
the continuation and agrees with the complete trail on state, classification,
clocks, receipts and candidates; an inside-block fault returns unresolved evidence
with no audit, also beside an after-block record for another checkpoint; the block
comes from the valid opening's publication range, including the receipt walk's
lazily read range; exclusion never advances state or resets a clock. Real-proof
portable/fresh-process checks and independent adversarial review passed. Stop
boundary: conditional v3 replay only; no opening/inside-block coverage, other
fault class, runtime or adoption expansion.

## Status

- Delivered in this slice's commit on `main`, based on `b308eae` (exact-head CI
  `35622782838` passed). Companion `main` stays at `183c09f`: §9.1 already states
  the block derivation and position condition, so no specification edit.
- [Decision](decisions/2026-09.md#2026-09-21--bound-compact-exclusion-by-the-record-derived-adopted-block)
  records the position bound, the per-position fault cache, the rejected
  alternatives and the review probes.
- The fault cache retains `{position, check}` per authenticated §9 record and
  requires an explicit block length; the import and scope classifiers pass the
  opening's block length, the original single-segment path passes zero. Lapse,
  opening, sibling, continuity and range dependencies are unchanged.
- Independent adversarial review found no blocker; its four notes (required
  block-length argument, a discriminating receipt-walk case, tracked
  two-record/cross-checkpoint groups, status wording) are applied.

## Evidence

- Oracle probes (ideal proof membership, real hashes/signatures):
  `scratch/adopted-recovery-oracle.log` (55 groups),
  `scratch/adopted-scope-recovery-oracle.log` (32), full regression after the
  review fixes `scratch/adopted-full-oracle.log` (172), portable agreement with
  deterministic fact order `scratch/adopted-portable-probe.log`. Review probes:
  `scratch/review-adopted-*` (30 groups incl. lazy-range receipt walk, same-index
  returns, clock retention, suppressed sibling ranges).
- Final `check:pool:ergo-replay` passed 222 replay groups / 65 real
  proofs, including portable and fresh-process checks
  (`scratch/adopted-block-real.log`). The
  [report](docs/pool-v3-local-replay-verification.json) binds 55 source hashes
  and matches the delivered files. Docs/link checks pass. Baseline `b308eae`
  hosted CI covers the unchanged runtime/package checks; only isolated v3 replay
  scripts and documentation change.
- No complete-certificate, adopted configuration, live-chain authentication or
  production spendability claim. Compact exclusion cannot fill missing ancestors,
  ranges or inside-block positions.

## Next

1. Push, then verify remote parity and exact-head CI.
2. §9.1's supported compact contexts are implemented (non-opening targets after
   any adopted block; proof and issue-K). Widening to other fault classes or
   inside-block positions needs a specification decision first.
3. Candidate next capability: the Ergo venue evidence path — the full-block
   verifier as the local replay's §13.2 verifier for kind-1/4 ranges (P2 node
   publication and P4 real-chain exhaustion remain open). First falsify that its
   kind-4 answers preserve per-index venue order and ordinals across backing
   subjects, which C2b.4.2's block union depends on. Alternatively continue the
   wallet/custody boundaries below. Review protocol choices before dependent code.

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
  full heights null/unresolved. P2 node publication, P4 real-chain exhaustion,
  decoder equivalence and authenticated venue evidence remain open.
- Legacy Temp/moeclean worktree points at a different Claude_local checkout;
  preserve it. Configuration approval stays disabled. Device qualification and
  external publication remain separate dependencies.

## Open questions

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-21. This slice completes §9.1's conditional compact coverage; it remains
conditional evidence with no runtime or release gate closed. Runtime integration,
selected venue/decoder, qualified custody and continuous wallet operation
dominate remaining effort. No rounded estimate change.

Switch to a fresh instance for the next capability: the compact-exclusion series
is closed with a bounded handoff, and the venue-evidence or wallet work centers
on different sources than this context holds.
