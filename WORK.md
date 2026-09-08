# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Bring recovery and device/venue evidence
forward before freezing v3. The maintainer approved continuing after the
fault-candidate review. This slice repairs the research readers without
selecting new clock/lapse or receipt-accountability policy.

## Status

- Implementation: `fix/pool-fault-readers`, based on review commit `fce0132`
  (`docs/pool-fault-review`); `main` remains at `6de607b`.
- Companion specification: `main` at `3676757`, unchanged. No v3 bytes fixed.
- Runtime remains v2. No `src/` behavior changed; PoolStore refuses silence
  clauses and recovery/presentation/wallet remain unimplemented there.
- [Reader contract](docs/POOL_FAULT_READERS.md) explains the separation of
  witnessing, evidence, fresh validation, retention and the ideal observer.
- The [proposal](docs/POOL_FAULT_RECOVERY_PROPOSAL.md) still suspends adoption
  of A″. No protocol alternative or new receipt precedence was selected.

## Completed

- World validation is separate from witnessing. FaultWorld evaluates each
  held checkpoint against its original prefix, with only earlier indices
  and lower same-operator sequences at its index; per-read memoization never
  makes an unresolved verdict permanent.
- `reader()` snapshots record facts and reader-local evidence. Independent
  readers preserve ideal proof/signature identities, not cached verdicts.
  New record facts, including same-index revocation, need a fresh snapshot.
- R1 is now visible: silence-lapse evidence can depend on another scope's
  fault, so the affected clock refuses until that evidence arrives. Term
  lapse can still be proved without event history. This does not eliminate
  the dependency or select a different lapse rule.
- R2–R5 are repaired: late evidence resolves; import/opening/receipt checks
  share validation; non-carrying steps authenticate absence and lapse;
  both receipt readers pass exclusions without inventing sequence holes.
- Review also fixed restored service readiness, ideal observation of newly
  resolved checkpoints, malformed authenticated header descent, and the
  supplied repair reader's dependence on raw/evaluated object identity.
- R6/R7 remain explicit tests of current unadopted policy: fault alone leaves
  the tail pending; later real holes/term ends can lapse it; a stale twin
  faults future service but preserves earlier finalized inclusion.

## Evidence

- `model/pool-fault-reader.test.ts`: 27/27 focused regression tests passed,
  including arrival orders, selective retention, same-index rank, scope and
  directory evidence, term/silence lapse, both receipt readers and revocation.
- Independent adversarial review of the implementation found four further
  gaps; all fixed and independently verified with seven targeted probes.
  No remaining blocker was found in those reviewed paths. Disposable probes
  were removed after their results were captured in permanent tests/docs.
- Full `npm run check` passed on Node 24.6.0: 79 files / 1,543 tests,
  docs/links, typecheck, build, installed package, pilot and pool-store crash
  checks. Final typecheck and diff checks also passed.
- No push, merge or PR is authorized in this session.

## Next

1. Compare the complete dependencies of intrinsic exclusion with a changed
   clock/lapse rule. The current A″ requires Y's fault evidence to pass a
   Y-only silence-lapsed checkpoint in X's clock. A possible alternative
   would let a non-carrying silence-lapsed commitment close X's interval,
   while retaining term lapse; that changes C2b.4.1/C2b.6.1 and must be
   modelled and adversarially checked before recommending it.
2. Present that costed choice and R6/R7 for the maintainer's decision. R6
   needs an exact abandonment boundary and precedence over later repair or
   term-end lapse. R7 must explicitly include stale twins if retained.
3. After selection, amend the normative contracts first, including C2b.4.1,
   then consolidate the candidate model and independently review the changes.
   Do not fold FaultWorld into RecoveryWorld or fix v3 bytes before selection.
4. Continue deployment evidence: named target phone benchmark, authenticated
   note delivery/restoration, complete evidence availability and pinned-node
   publication. Offline sizing is in `docs/POOL_DEPLOYMENT_PROBES.md` and
   remains distinct from node acceptance. Then settle bounds/layouts and v3.

## Open questions

- A″'s dependency/cost choice, segment-wide fault and receipt precedence;
  authenticated fault-certificate layouts and proof-variant continuity (R8).
- Withheld preimages remain unresolved. Availability must retain proofs,
  issuance signatures, terms, ancestry and recoverable note openings.
- SQLite assumes one journal per operator key/venue; copied journals,
  rollback and custody/backup procedures remain open.
- Custom synchronous venue adapters lack a same-index generation token.
- Setup/build provenance, full C2 re-derivation, history scaling, retention,
  note delivery, wallet restore and venue write acceptance remain gates.
