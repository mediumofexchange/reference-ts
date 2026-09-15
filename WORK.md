# Current work

Updated: 2026-09-15

## Goal

A venue profile candidate behind pool-v3 §13 answers: the Ergo full-block
verifier, with attribution bound to the venue identity, kind-4 ordinals from
transaction then output order, and completeness by exhaustion over
root-checked block sections behind a linked header chain. Delivered to main
at 1d8f735 (feature 4cd9e56, review fixes 6f4e1e7 and 1d8f735). No
specification change: §13 still selects no profile. No runtime, circuit,
key, dependency or host-control change; the experiment's check script gains
a third step and pins the mainnet genesis header as a fixture.

## Status

- Delivered result: for a request naming the candidate identity, the
  verifier answers from the reader's headers and decoded block sections
  exactly the objects at the kind's location with the profile's shape, at
  their inclusion height and venue order, or returns no answer where the
  evidence does not cover the range, is above the witnessed index, or is
  not one linked chain; a malformed, foreign, duplicate or root-failing
  block is passed over. [Candidate profile](docs/ERGO_VENUE_PROFILE.md);
  [decision](decisions/2026-09.md#2026-09-15--candidate-ergo-venue-profile-full-block-exhaustion-behind-13-answers).
- `model/pool-v3-ergo-profile.ts`: identity over genesis, depth and four
  exact ErgoTrees; `R4` subject and `R5` bytes as `Coll[Byte]` constants;
  kinds 1–3 at exact length, kind 4 as one transaction's maximal run of
  adjacent same-subject outputs; ordinal `position · 2^32 + index`; roots
  recomputed from decoder ids; profile, evidence and requests owned on
  ingestion. `copyRequest` in the range model now reads each field once.
- Independent adversarial review: four blockers and five optional findings
  resolved; the readback found one residual blocker (evidence not owned)
  and one optional (malformed block denial), both fixed; the second
  readback confirmed no material finding remains. Dispositions are in the
  decision entry.
- Findings recorded, not resolved: the kind-4 bound (131914 bytes) exceeds
  the pinned node's 98304-byte mempool policy, so the largest kind-6 record
  has no location under the one-transaction run rule; one node-valid
  transaction the reader's decoder refuses denies every range through its
  height until the decoder is repaired; chain and revocation reads from
  index zero are a genesis scan on a real chain.

## Evidence

- Baseline main 559bfdf: CI 34900291794 passed. Delivery main 1d8f735:
  CI 34958100723 queued at handoff; check its result before building on it.
- `test/pool-v3-ergo-profile.test.ts`: 9 tests passed; full `npm test`
  1934 passed on 6f4e1e7 (the later change touched only the model, its
  test and the experiment, rerun on the final sources); typecheck clean;
  `npm run check:docs` OK.
- `npm run check:ergo:range` on the final sources: block-root and decoder
  reports regenerated (manifest and package hashes changed);
  [profile report](docs/ergo-range-profile-verification.json): 242 checks;
  the pinned genesis header (height 1, zero parent) anchors an empty answer
  for index 0; synthetic chain 15 transactions, 11,896 serialized bytes;
  answers 1,038 (commitments, five held of six carried), 355 (replacement,
  successor pending), 334 (revocation at first witnessing), 8,284
  (publications in venue order); fixture roots reproduced for versions 1
  and 3, 65 outputs scanned, 57 real register constants agreeing with
  sigma-rust's decoder.

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

1. Record CI 34958100723's result for 1d8f735.
2. Decide the kind-4 bound question with P2 (publication on a node): runs
   across transactions in the profile, or a smaller kind-6 record in
   pool-v3 §6; then P4's real-chain cost of exhaustion from index zero and
   a possible start-index rule. Decoder node equivalence is a selection
   prerequisite beside containment.
3. Remaining local-experiment dependencies: the C2b.6.1 clock over the
   classified carrying checkpoints, and a successor's or scope-changed
   segment with its C2.10.5 imports; then wire the profile verifier into
   the local replay in place of the fixture venue through an adapter that
   binds the reader's budget.
4. Configuration approval stays disabled until all adoption prerequisites
   hold; device qualification and external publication remain separate
   dependencies. Do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-15: unchanged, roughly **50% done / 50% remaining**,
  plausible range **40-60%**. The profile candidate is reusable behind the
  answers, but header authentication, a node-equivalent contained decoder,
  publication on a node, runtime recovery, qualified custody and user
  operation remain the largest blocks.
- Switch to a fresh instance for the next slice: the kind-4 bound and P2
  work read pool-v3 §6 sizes and the node's transaction limits, not this
  slice's sources, and this session's context is long. This is a
  context-efficiency recommendation, not measured model performance.
