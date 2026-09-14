# Current work

Updated: 2026-09-14

## Goal

Dependency replay in the local experiment: every carrying checkpoint of the
original operator's segment is classified from its own trail (C2.10.11) with
last-valid-prefix continuity (C2.10.12, pool-v3 §7.1), and the party in force
at every index follows C2.5's walk over the kind-2 answers under the verifier's
lag. Implementation: branch `feat/v3-dependency-replay`, d8a6649. Companion:
`spec/v3-dependency-replay`, 3ed1800 (pool-v3 §7.1 fixes the continuity
reading). No production runtime, circuit, key, dependency or host-control
change.

## Status

- Expected result: the range reader passes or refuses each carrying
  checkpoint with its own evidence. A second checkpoint of the segment that
  extends the first replays as the selection with the first classified
  valid; a stale twin, diverging evidence or a bad suffix is excluded and
  passed; a valid later checkpoint makes the selection `superseded-selection`;
  a handover in force before the selection's index makes it
  `lapsed-selection`; missing or ambiguous dependency evidence is unresolved
  before any proof. No fixture assumption replaces a read.
- `model/pool-v3-range.ts` gains `replacementChain`/`linkInForce` (C2.5.3–5
  over admitted entries, checked differentially against `successionOf`);
  `local-replay.mjs` replays each checkpoint through one `replayTrail`,
  resolves dependencies by snapshot digest and trail authentication, and
  reads every term's commitments; the fixture venue carries a lag.
- Unsupported and refused explicitly: a declared silence clause (the
  C2b.6.1 clock is not read), a successor's carrying commitment or a
  same-operator scope change (new segments, imports), recovery publications.
- Independent adversarial review found one blocker (the revocation rule
  re-judged a prefix an earlier valid checkpoint had finalized), fixed with
  cases; six optional findings adopted or recorded in the decision entry.
  The readback confirmed the fixes; no material finding remains.
- [Active decision](decisions/2026-09.md#2026-09-14--classify-same-segment-dependencies-from-their-own-trails).

## Evidence

- Baseline main 2d246bf: CI 34840706258 passed; delivery main 8b0dadc: CI
  34899459533 passed; both repositories at parity.
- Range/chain codec tests: `test/pool-v3-range.test.ts` 17 passed, including
  12 chain scenarios agreeing with the runtime walk.
- `check:pool:local-replay` on the reviewed sources: 31 groups and 9 real
  proofs passed (a fourth statement extends the segment), including the
  dependency, exclusion, evidence and chain groups. [Retained report](docs/pool-v3-local-replay-verification.json):
  47,665-byte single package, 110,054-byte dependency package (two
  checkpoints, three directory preimages); dependency audit at checkpoint
  index 7 with carrying classes valid/valid, outstanding 5; the fresh worker
  agrees on audit, receiver and dependency results.
- Full `npm run check` (1925 tests plus package, service, wallet, crash and
  spent-set checks) passed before the review fixes; those fixes touched only
  `scripts/pool/v3` (covered by the final harness run) and docs
  (`check:docs` rerun); typecheck and build clean.

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

1. A venue profile candidate for §13 answers: the Ergo full-block
   verifier from `experiments/ergo-range` (attribution bound to the venue id,
   kind-4 ordinals from transaction/output order, completeness by exhaustion
   against authenticated headers). A8 is a stated trust assumption until then.
2. Remaining local-experiment dependencies after that: the C2b.6.1 clock over
   the classified carrying checkpoints, and a successor's or scope-changed
   segment with its C2.10.5 imports.
3. Configuration approval stays disabled until all adoption prerequisites
   hold; device qualification and external publication remain separate
   dependencies. Do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-14: unchanged, roughly **50% done / 50% remaining**,
  plausible range **40-60%**. Classification with continuity and the chain
  walk are reusable; the venue profile behind the answers, runtime recovery,
  qualified custody and user operation remain the largest blocks.
- Switch to a fresh instance for the venue-profile slice: this session's
  context is long and that slice reads `experiments/ergo-range` and the
  Ergo header/block rules instead of C2.10. This is a context-efficiency
  recommendation, not measured model performance.
