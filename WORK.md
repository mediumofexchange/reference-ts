# Current work

Updated: 2026-09-14

## Goal

Record-range answers (pool-v3 §13) fix the source-neutral request/answer a
venue-evidence verifier returns and the reader's held/chain/revocation/
publication rules. The local replay now derives the selected checkpoint's
record prefix, currency, original-operator force and revocation absence from a
harness-owned fixture venue instead of assuming them. Implementation: branch
`feat/v3-record-ranges`, 78978d8. Companion: `spec/v3-record-ranges`,
6272040 merged/pushed to main. No production runtime, circuit, key,
dependency or host-control change.

## Status

- Specification §13 at 6272040 fixes the frame (102 fixed + 20 bytes per
  entry; four closed kinds), completeness by exhaustion with no answer
  otherwise, the per-index sequence reading of C2.3.3, replacement identity
  as the signed-message hash and the kind-4 ordinal. Independent adversarial
  review resolved five blockers and one readback blocker; no material
  finding remains. §1/§12.1 and pool-fault §10 reference it.
- `model/pool-v3-range.ts` and `scripts/pool/v3/fixture-venue.mjs` are new;
  `local-replay.mjs` reads kinds 1–3 over `[0, t]` from the verifier the
  harness selects. Independent implementation review found three blockers
  (verdict order under an unsupported scope, in-memory answer validation,
  merge kind), all fixed and read back; no material finding remains.
- The fixture venue is a trust input, not a venue profile. Flags
  `currentRangeAuthenticated`/`termsAuthorityAuthenticated` are true only with
  `rangeEvidence: "fixture-verifier"`; `fullV3Replay`, completeness and
  spendability stay false. A later carrying checkpoint, a replacement chain
  and publications remain unsupported by the experiment.
- [Active decision](decisions/2026-09.md#2026-09-14--fix-source-neutral-record-range-answers-for-c21013).

## Evidence

- Baseline main 3ca4016: CI 34736771360 passed; both repositories at parity
  before branching; no branch protections reported.
- Final sequential `check:pool:local-replay`: 27 groups/8 proofs
  passed, including three range groups (fixture ranges; contradicted opening,
  later carrying checkpoint, missing directory, revocation before/at/after,
  replaced/unruled operator; other venue, unwitnessed index, stale answer,
  unheld selection, lesser-bytes twin, silent or absent verifier).
  [Retained report](docs/pool-v3-local-replay-verification.json):
  47,665-byte package with three directory preimages, 3 fixture venue
  records, all 22 source hashes match final files. Range audit: judging
  index 20, checkpoint index 3, one held commitment before and one after, no
  revocation; outstanding 5; fresh audit and receiver agree.
- Codec tests: 14 passed. Full `npm run check`: 1922 tests plus package, service/wallet/crash/spent
  checks passed on the final sources; typecheck and build clean.
- Circuits/configuration/keys/runtime unchanged; reuse baseline conformance.
  Delivery CI is pending; inspect the main revision's run next.

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

1. Check final main CI. Then complete dependency replay in the local
   experiment: a second checkpoint of the same segment extending the first
   (C2.10.4/12 last-valid-prefix continuity), classification of a later
   carrying checkpoint from its own trail, and the C2.5 chain walk over
   kind-2 answers (lead floor, supersession, lesser identity), reusing
   `src/replacement.ts`'s rules. Acceptance: the range reader passes or
   refuses each with its own evidence; no fixture assumption replaces it.
2. Then a venue profile candidate for §13 answers: the Ergo full-block
   verifier from `experiments/ergo-range` (attribution bound to the venue id,
   kind-4 ordinals from transaction/output order, completeness by exhaustion
   against authenticated headers). A8 is a stated trust assumption until then.
3. Configuration approval stays disabled until all adoption prerequisites
   hold; device qualification and external publication remain separate
   dependencies. Do not alter this workstation's controls.

## Open questions

- Reassessed 2026-09-14: unchanged, roughly **50% done / 50% remaining**,
  plausible range **40-60%**. Deriving the record prefix and currency from
  range answers is reusable; the venue profile behind those answers, runtime
  recovery, qualified custody and user operation remain the largest blocks.
- Switch to a fresh instance for the dependency-replay slice: this session's
  context is long and the next slice reads different rules (C2.10.4/5/12,
  C2.5). This is a context-efficiency recommendation, not measured model
  performance.
