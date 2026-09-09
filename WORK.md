# Current work

Updated: 2026-09-09

## Goal

Next: fix the final v3 configuration and record formats before runtime
adoption. Acceptance: explicit delivery-profile encoding, six ordered
bytecode/key identities, helper and bounds, canonical statement/authorization
and publication bytes, evidence/snapshot/replay commitments, independent
review and a specification commit before dependent runtime changes. Repeat
proof evidence on the final build/domain; observed hashes are not pins.

## Status

- Active slice: `feat/pool-v3-proof-conformance`, base `5ba6099`. Six retained
  relations share one notes helper and the pinned Poseidon2 source under
  `scripts/pool/v3/`; `npm run check:pool:v3` runs their combined conformance
  suite from a clean checkout, without the inherited scratch probes.
- Companion `spec/pool-v3-proof-layouts` is merged/pushed to `main` at
  `d57ddb0`, before dependent tooling was retained. It fixes public-input
  orders/counts 11/15/15/16/17/7 and explicitly forbids adopting the incomplete
  v3 construction. No final configuration or approved artifact pins exist.
- Issue/burn bind delivery, spend has four ordinary outputs, demand alone
  requires zero padding anchors, and request binds its final u64 refresh.
  The runtime remains v2, refuses silence clauses and exports no pool wallet.
- Independent normative review cleared the relation semantics, layouts and
  no-adoption boundary. Implementation review/readback cleared the retained
  sources and added distinct-anchor/hostile-reproof controls. Final measured
  retained run passes. Neither reviewer independently reran proofs.
- Separate Linux/Windows CI jobs run the v3 suite. Existing v2 jobs remain.
  Decision and remaining configuration choices are in
  [the decision](decisions/2026-09.md#2026-09-09--fix-the-six-successor-proof-layouts-before-configuration-adoption)
  and [the recovery map](docs/POOL_V3_RECOVERY_MAP.md#26-contract-to-constraint-audit).

## Evidence

- `npm run check` passes: 90 files / 1,689 tests, package consumer, pilot,
  store crash checks and ten spent-set groups. The first sandboxed attempt
  failed in esbuild directory resolution; the authorized unrestricted run
  passed. No test or gate was weakened.
- Final `npm run check:pool:v3` passes: 304 checks / 18 real proofs, each
  14,656 bytes. It checks all 81 public scalars,
  equal-count spend/burn key substitution both ways, independently provable
  metadata, unchanged-ACIR range guards and recomputed hostile witnesses.
  Distinct anchors prevent equal fixture values from masking ordering errors.
  [Report](docs/pool-v3-conformance-verification.json) captures source/helper,
  bytecode/key and harness hashes; these are observations, not config pins.
- Documentation and companion links pass. Audit base `5ba6099` GitHub CI
  passed, including unchanged v2/F3/F4 real-proof evidence. The specification
  has no listed CI run; local link/diff checks passed before its push.

## Next

1. Inspect GitHub CI for this slice's delivered main revision, including the
   new Linux/Windows v3 jobs. All required local checks pass.
2. Define the remaining config preimage and delivery-profile identity/encoding
   in `pool-v3.md`, together with records/bounds and observed artifact pins.
   Create/name companion branches here before coordinated changes.
3. Implement v3 runtime/recovery and wallet after final normative pins. Carry
   these conformance sources/cases into the runtime path; retire this separate
   tooling only once its evidence and cases are preserved there.

## Open questions

- About 45% done / 55% remaining, plausible done range 35-55%. The six-relation
  implementation reduces remaining circuit work but closes no runtime/product
  gate. Largest work: final configuration/records, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- Proof mutation tests are selected-backend evidence, not a general
  nonmalleability proof or presenter-key participation. Synthetic capsules
  test opaque-vector hashing, not receiver decryption or restoration.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  evidence remains unresolved, never zero balance or an older current state.
- Real holders can make dishonest in-kind allegations; public outcomes do not
  prove external non-payment. Copied journals, rollback, same-index venue
  order, setup/build provenance, phone budgets and actual publication remain
  release gates. No release, deployment, access change or real funds authorized.
- Retain existing Ergo/pool-v3 probes and parameter caches. New duplicate
  six-build scratch sources were removed after capture in the retained suite.
