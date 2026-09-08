# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Historical-silence retirement is repaired;
the next contract is invalid-checkpoint recovery with authenticated evidence.
The maintainer authorized continued work and merge/push.

## Status

- Implementation: `main`, incorporating the reviewed
  `test/pool-fault-evidence` slice based on `6e54ba9`. This adds research tests
  and a recommendation only.
- Companion: `money-from-first-principles` main `c5f5464`, unchanged in this
  slice. Historical-silence rule `60af631` was committed before model `0464e38`;
  both are already merged and pushed.
- [Evidence review](docs/POOL_FAULT_EVIDENCE_REVIEW.md): A″ has transitive
  dependencies across three disjoint scopes; historical lapse can reintroduce
  old fault-proof dependencies after a fresh reset.
- Recommend term-only non-carrying resets with explicit stale-signing
  suppression costs. Fresh valid unrelated openings can suppress silence
  under either clock; neither guarantees redemption against every faulty
  operator without usable replacement authority and available evidence.
- Recommend preserving receipt boundaries (fault alone pending, later repair
  abandonment or genuine boundary lapse) and faulting future segment service
  while retaining earlier finality, including after a stale twin.
- Real v2 tests demonstrate that invalid replacement proof/signature bytes,
  even separately receipt-attested, do not prove an earlier checkpoint bound
  them. Semantic history inclusion differs from exact evidence attribution.
  V3 must define checkpoint evidence binding and proof-variant continuity.
- Runtime remains v2: no `src/`, circuit, layout or dependency changes.
  PoolStore still refuses silence clauses. Fault clocks and R6/R7 remain
  research choices pending one coherent normative/evidence contract.

## Evidence

- Fifteen new regression cases: six clock dependency/suppression controls,
  four fault receipt/stale-twin cases, five actual-v2 evidence cases.
  Focused checks passed. Real cryptographic hashes/signatures are used in
  the v2 cases; proofs use the existing test oracle.
- Independent adversarial review confirmed the v2 binding counterexamples.
  Corrected the hostile ideal receipt fixture to reference the actual fault
  sequence and explicitly distinguish it from authenticated receipt bytes.
- Final design review checked the recommendation and suppression controls.
  Corrected stale claims about non-carrying resets, snapshot/clock evidence
  equivalence and the strict silence-duration boundary in the older proposal.
- Full `npm run check` passed: 85 files / 1,606 tests, documentation,
  typecheck, build, installed package, pilot and pool-store crash checks.
  Vitest and process checks required Windows sandbox escalation.

## Next

1. Draft a coherent specification proposal for term-only non-carrying resets,
   R6/R7, exact checkpoint-evidence continuity, verification-failure
   classification and authenticated complete-range retrieval. Check C0a;
   do not consolidate FaultWorld or freeze v3 bytes before these contracts.
2. Continue deployment evidence: target phone benchmark, authenticated note
   delivery/restoration, complete evidence availability and pinned-node
   publication. Offline sizes are not node acceptance; see
   [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md).

## Open questions

- The finite ideal model is not a production retrieval or scaling result.
  Suffix/ancestry retention and cold reads need measurement; local cached
  verdicts do not replace retained authenticated evidence or fresh snapshots.
- SQLite assumes one journal per key/venue; copied journals, rollback and
  custody/backup remain open. Custom synchronous venues lack a same-index
  generation token. Provenance, C2 re-derivation and venue write acceptance
  remain release gates.
