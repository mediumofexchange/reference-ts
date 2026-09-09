# Current work

Updated: 2026-09-09

## Goal

Next: bring the six successor proof relations and statement layouts into
agreement with the selected contracts before freezing v3 configuration.
Start with a contract-to-constraint audit and the known demand padding-anchor
and request-refresh gaps. Acceptance: exact public-input orders, all unsigned
fields bound by the selected proof system, hostile witnesses otherwise valid,
F3 delivery/F4 output shape included, reviewed specification before retained
code, source/key evidence and required checks. Runtime integration follows.

## Status

- Presentment attribution is delivered at `8ae22ed`, from
  `feat/pool-presentment-attribution` (base `7edc0c8`), merged/pushed to main.
  This handoff is the following documentation commit. Companion
  `spec/pool-presentment-attribution` is merged/pushed at `923ee46`.
  Normative review and commit preceded the dependent test edits.
- C3.3a keeps the unsigned holding-proof demand. A proof authorizes notes and
  binds the notice; it does not prove presenter-key participation, publisher
  identity or a person's reputation. A wallet controls and retains its fresh
  presenter key for release/withdrawal. See the
  [decision](decisions/2026-09.md#2026-09-09--pool-demands-authorize-notes-without-identifying-the-demander).
- Construction and the paper now state actual disclosure and attribution
  limits. Other profiles retain their signed notices/time fallback; the pool
  retains its named-instant window. No demand signature or identity gate added.
- A22 is merged at `c955798` (specification `78f8a8c`); final delivery
  `7edc0c8` passed GitHub CI. F3/F4 are merged at `17a9f1e`/`fcf532c`.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  This slice changes no runtime source, circuit, key, configuration or bytes.

## Evidence

- Independent normative review resolved preservation of non-pool time rules
  and distinguished first relay admission from repeated locks. Final readback
  cleared the explicit proof-system binding obligation in C3.2.
- Three C3.3a tests cover unsigned demand/unrelated presenter, copied evidence,
  metadata rebinding with independently valid alternatives, wrong exits, first
  relay admission and retry after withdrawal/deadline without recreating locks.
  Focused run and independent patch readback: 41/41 recovery-file tests pass;
  no material finding. These are ideal proof/signature/state boundaries.
- Final `npm run check` passes: 90 files / 1,689 tests, package consumer,
  pilot, pool-store crashes and ten A22 groups. Final documentation and
  companion-link checks pass. Existing v2/F3/F4 real-proof results carry
  forward because this slice changes no circuit or configuration.
- A22 comparison: 100k keys, v2 157.29 s vs compressed candidate 15.80 s;
  [report](docs/pool-spent-verification.json). Accumulator-only evidence.

## Next

1. Inspect GitHub CI for the final delivered main revision; local checks pass.
2. Audit all six v3 relations against the contracts and record the final layout
   proposal. `scratch/pool-v3/circuits/demand.nr` does not constrain padding
   anchors to zero; `request.nr` lacks the refresh field. Current P1 scratch
   sources are not final conformance evidence and must not be pinned as-is.
3. Prove the completed relations, review and pin layouts/identities together,
   then build v3 runtime/recovery and the pool wallet.

## Open questions

- About 44% done / 56% remaining, plausible done range 34-54%. Largest work:
  v3 circuits/runtime, wallet/transport, authenticated complete-range reads,
  witness publication, custody and deployment assurance. This clarification
  closes a specification contradiction, not a runtime or product gate.
- Real v3 proof binding needs its own evidence: range constraints and an ideal
  model alone cannot establish nonmalleability for an arbitrary proof system.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  evidence is unresolved, never zero balance or an older current state.
- Real holders can make dishonest in-kind allegations; fresh keys supply no
  identity restraint. Public record outcomes do not prove external non-payment.
- Copied journals, rollback, same-index venue order, setup/build provenance,
  phone budgets and actual publication acceptance remain release gates.
- Retain existing Ergo/pool-v3 probes and parameter caches. No release,
  deployment, access-control change or real funds are authorized.
