# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Bring device/venue feasibility and recovery
evidence forward before freezing v3. The maintainer asked to continue with
pending reviews and decisions. Production remains specification → adversarial
model → implementation, with immutable verifier authority and independent
replacement.

## Status

- Implementation: `docs/pool-fault-review`, based on `main` at `6de607b`.
  This slice is review/documentation only; no model or runtime changes.
- Companion specification: `main` at `3676757`, unchanged. No v3 bytes fixed.
- Runtime remains v2. PoolStore refuses silence clauses; recovery,
  presentation and the wallet are not implemented in `src/`.
- The previously owed independent review is complete:
  [fault review](decisions/archive/2026-09-08-pool-fault-review.md).
  Two independent lanes, with a second check of the key design finding.
- The [proposal](docs/POOL_FAULT_RECOVERY_PROPOSAL.md) now suspends its
  recommendation to adopt A″. No protocol alternative has been selected.

## Findings and decisions still open

- **R1:** A″ can require another scope's fault evidence to prove that a
  non-carrying checkpoint lapsed during silence. The model hides that
  dependency by trusting cached lapse status. The claim of no new dependency
  on other scopes is false; C2b.4.1 must be included in the rule/cost analysis.
- **R2–R4:** evidence absent at first validation stays unresolved after it
  arrives; imports and some finality paths bypass the candidate's dependency
  classification; the non-carrying clock branch lacks authenticated absence.
  Separate witnessed records, reader evidence and retained validation before
  relying on the model as an oracle.
- **R5:** an excluded receipt `after`, or excluded carrying checkpoint of a
  different segment, still blocks classification after valid repair.
- **R6:** the proposal's unconditional fault abandonment is not implemented.
  A later signed-sequence hole gives repair lapse; a later term end gives
  scope-boundary lapse. Choose the decisive boundary and precedence explicitly.
- **R7:** a stale twin's later invalid signature ends the whole segment's
  future service under the candidate, preserving earlier finality. This is a
  defensible conservative choice, not something C2.10.6 alone requires.
- **R8:** the fault-certificate suffix is not one 32-byte link per statement.
  The proposal now prices all recurrence inputs conditionally and leaves v3
  layout, evidence-variant continuity and receipt binding to be specified.

## Evidence

- Existing model checks rerun on Node 24.6.0 / Vitest 3.2.7:
  `npm test -- model/pool-fault.test.ts model/pool-fault-boundary.test.ts
  model/pool-recovery.test.ts model/pool-authority.test.ts` — 4 files /
  134 tests passed.
- Primary agent inspected and reran the review probes: 5/5 receipt cases;
  dependency traces reproduced R1–R4 and the receipt base-comparison variant.
  They demonstrate current defects/choices, not candidate correctness.
  Traces are retained in the review; temporary probes were removed.
- Prior implementation milestone: `3e7ff72` / `4587de9`, merged and pushed
  with maintainer approval; full `npm run check` then passed 78 files /
  1,516 tests plus docs, typecheck, build, package, pilot and crash checks.
- This documentation slice: `npm run check:docs` and `git diff --check`
  passed; final diff self-reviewed. No push or merge is authorized here.

## Next

1. Repair the research model's reader abstraction. Exercise two readers on
   one immutable signed record with evidence missing on first examination,
   arriving later and retained selectively; distinguish term and silence
   lapses. Add permanent regression cases from R1–R5.
2. Compare the complete dependencies of intrinsic exclusion with a changed
   clock/lapse rule, without silently changing whole-scope lapse. Present the
   costed choice and R6/R7 for the maintainer's decision. Do not amend the
   normative contracts or fold FaultWorld into RecoveryWorld yet.
3. After that choice, specify/model the coordinated rules including C2b.4.1,
   then independently review the critical changes before any merge.
4. Continue deployment evidence: named target phone benchmark, authenticated
   note delivery/restoration, complete evidence availability and pinned-node
   publication. The offline Ergo sizing remains in
   `docs/POOL_DEPLOYMENT_PROBES.md`; it is not node acceptance.
5. Settle statement bounds and layouts on that evidence, freeze v3, then
   implement recovery. Keep companion specification/implementation branches
   named here when normative work begins.

## Open questions

- Withheld preimages still block recovery. Availability must retain proofs,
  issuance signatures, terms, ancestry and recoverable note openings.
- SQLite ownership assumes one journal per operator key/venue; copied
  journals, rollback and custody/backup procedures remain open.
- Scope authority assumes complete stable venue snapshots; custom synchronous
  adapters have no generation token against same-index mutation.
- Setup/build provenance, full C2 re-derivation, history scaling, retention,
  note delivery, wallet restore and venue write acceptance remain gates.
