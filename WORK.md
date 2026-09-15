# Current work

Updated: 2026-09-15

## Goal

A venue profile candidate behind pool-v3 §13 answers: the Ergo full-block
verifier, with attribution bound to the venue identity, kind-4 ordinals from
transaction then output order, and completeness by exhaustion over
root-checked block sections behind a linked header chain. Implementation:
branch `feat/v3-ergo-venue-profile`. No specification change: §13 still
selects no profile. No runtime, circuit, key, dependency or host-control
change; the experiment's check script gains a third step.

## Status

- Expected result: for a request naming the candidate identity, the verifier
  answers from the reader's headers and decoded block sections exactly the
  objects at the kind's location with the profile's shape, at their inclusion
  height and venue order, or returns no answer where the evidence does not
  cover the range, is unlinked, fails a root, is above the witnessed index
  or refuses to decode. [Candidate profile](docs/ERGO_VENUE_PROFILE.md);
  [active decision](decisions/2026-09.md#2026-09-15--candidate-ergo-venue-profile-full-block-exhaustion-behind-13-answers).
- `model/pool-v3-ergo-profile.ts`: identity over genesis, depth and four
  exact ErgoTrees; `R4` subject and `R5` bytes as `Coll[Byte]` constants;
  kinds 1–3 at exact length, kind 4 as one transaction's maximal run of
  adjacent same-subject outputs; ordinal `position · 2^32 + index`; roots
  recomputed from decoder ids under the pinned node's rule.
- `experiments/ergo-range/profile-check.mjs` drives the model through Fleet
  and sigma-rust on a twelve-height synthetic chain and the three fixture
  blocks; `npm run check:ergo:range` runs it third.
- Findings recorded, not resolved: the kind-4 bound (131914 bytes) exceeds
  the pinned node's 98304-byte mempool transaction limit, so the largest
  kind-6 record has no location under the one-transaction run rule; chain
  and revocation reads from index zero are a scan from the genesis on a
  real chain.
- Independent adversarial review: in progress; findings and their
  disposition go in the decision entry before merge.

## Evidence

- Baseline main 559bfdf: CI passed for 8b0dadc (34899459533).
- `test/pool-v3-ergo-profile.test.ts`: 8 tests passed; full `npm test`
  1933 passed; `npm run typecheck` clean; `npm run check:docs` OK.
- `npm run check:ergo:range` on the committed sources: block-root and
  decoder reports regenerated (only the package hash changed);
  [profile report](docs/ergo-range-profile-verification.json): 121 checks;
  synthetic chain 15 transactions, 11,896 serialized bytes; answers 1,038
  (commitments, five held of six carried), 355 (replacement, successor
  pending), 334 (revocation at first witnessing), 8,284 (publications in
  venue order); fixture roots reproduced for versions 1 and 3, 65 outputs
  scanned, empty answers of 102 bytes.

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

1. Close the review, merge and push, check CI for the delivery commit.
2. Decide the kind-4 bound question with P2 (publication on a node): runs
   across transactions in the profile, or a smaller kind-6 record in
   pool-v3 §6; then P4's real-chain cost of exhaustion from index zero and
   a possible start-index rule.
3. Remaining local-experiment dependencies: the C2b.6.1 clock over the
   classified carrying checkpoints, and a successor's or scope-changed
   segment with its C2.10.5 imports; then wire the profile verifier into
   the local replay in place of the fixture venue.
4. Configuration approval stays disabled until all adoption prerequisites
   hold; device qualification and external publication remain separate
   dependencies. Do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-15: unchanged, roughly **50% done / 50% remaining**,
  plausible range **40-60%**. The profile candidate is reusable behind the
  answers, but header authentication, decoder containment, publication on
  a node, runtime recovery, qualified custody and user operation remain
  the largest blocks.
- Stay with the current instance for the review close and delivery; switch
  to a fresh instance for the kind-4 bound and P2 work, which reads
  pool-v3 §6 sizes and the node's transaction limits rather than this
  slice's sources. This is a context-efficiency recommendation, not
  measured model performance.
