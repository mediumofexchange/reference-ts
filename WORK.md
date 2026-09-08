# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. The maintainer approved continuing the
checked design review's recommendations: bring device/venue feasibility and
recovery evidence forward before freezing v3. Production remains specification
→ adversarial model → implementation. Preserve immutable verifier authority,
independent replacement and one shielded production path.

## Status

- Implementation: `main`, fast-forwarded from `feat/pool-deployment-probes` on
  2026-09-08 with the maintainer's approval: `3e7ff72` reproduced the F2
  blockage and measured browser proving; `4587de9` models the remedy
  candidate and sizes venue publication; the recommendation is recorded.
- Companion specification: `main` at `3676757`; unchanged. No v3 bytes fixed.
- Runtime remains v2. PoolStore refuses silence clauses; nothing of recovery,
  presentation or the wallet is in `src/`.
- Review and check: `decisions/archive/2026-09-08-whole-project-design-review*.md`.
  Continuing investigation is approved; no protocol alternative is selected.

## This slice

- `model/pool-fault.ts`: candidate A of the
  [fault proposal](docs/POOL_FAULT_RECOVERY_PROPOSAL.md) over the recovery
  model. One classification (valid / excluded on evidence / unresolved)
  drives snapshot, count, clock, descent and receipt reader; an excluded
  checkpoint faults its segment; an excluded carrying commitment does not
  close the interval; a non-carrying one closes it as today. Switches model
  the stricter clock (A) and C2b.6.1 as written (A′); departures model
  reading unavailable bytes as fault or as valid.
- `model/pool-fault.test.ts`, nine cases: evidenced exclusion repairs
  snapshot, count and descent and lets a successor open; withheld bytes give
  no verdict, no rollback and no successor; a faulted segment repairs as a
  new segment with its tail's receipts abandoned; a garbage stream cannot
  shut the gap; a settled note survives a second silence; the departures
  yield a reversed verdict and `settled note spent again`; A's clock needs
  the other scope's evidence and protects only against garbage a valid
  commitment would replace.
- Base models: `Recorded.reason`; hooks `excluded`, `blocking`, `admissible`
  (after the public lapse conditions); `classify` lets an excluded
  same-segment checkpoint consume its sequence; `count` reads through
  `snapshot` (C2b.5.2's coupling), which flipped one assertion in the
  boundary test's snapshot-only thought experiment.
- The proposal records the modelled result, compares A″ (recommended), A,
  A′, prospective fault publication and venue-side validation, sketches the
  fault certificate F2's history binding enables, and names the residue: a
  commitment whose preimage nobody serves stays unresolved, as today.
- Ergo sizing, offline (`docs/POOL_DEPLOYMENT_PROBES.md`): constants verified
  at ergo `v6.1.5`; a release publication fits one 6-output transaction of
  20,724 bytes for about 0.0086 ERG; no node acceptance claimed.

## Evidence

- Model suite: 6 files / 148 tests passed on Node 24.6.0; typecheck passed.
- Full `npm run check` passed on Node 24.6.0: 78 files / 1,516 tests, docs,
  links, typecheck, build, installed package, pilot and pool-store crash checks.
- Merged to `main` and pushed on 2026-09-08 with the maintainer's approval
  ("what is ready can be merged", "you may push too").
- Review owed: the candidate touches finality, recovery and receipt
  semantics and needs independent adversarial review before any of it
  becomes specification text (a bounded read-only opus lane worked on
  2026-09-07). Questions for it: should an excluded checkpoint fault its
  whole segment even for a stale twin's checkpoint; is "abandoned" the right
  receipt class for a faulted tail; does any read still draw a positive
  verdict from an unresolved dependency.

## Next

1. Maintainer choice among A″ / A′ / B / C (the proposal's approval
   boundary). A″ is recommended: it repairs the reproduced failure with no
   new frame, party or venue cost and no new dependency between scopes.
2. If A″: amend pool-recovery.md C2b.3.1, C2b.5.2, C2b.6.1 and
   pool-authority.md C2.10.3–4, C2.10.9b on a spec branch with the model as
   oracle; fold `FaultWorld` into `RecoveryWorld`; specify the fault
   certificate in `pool-v3.md` with `proofHash`/`signatureHash` in
   `historyHash_i`.
3. The residue is an availability question: compare an attestation rule
   with full venue publication using F10's measured costs and the sizes above.
4. Run the browser benchmark on the named target phone; prototype
   authenticated note delivery/restoration; publish through a pinned node;
   then settle statement bounds, freeze v3 and implement recovery.

## Open questions

- `model/pool-recovery.ts` implements the approved C3/C2b contract over ideal
  cryptography; the candidate in `model/pool-fault.ts` is not part of it.
- Data availability must include proofs, issuance signatures, terms, ancestry
  and recoverable openings. Public inputs alone do not establish valid state.
- SQLite ownership assumes one journal per operator key/venue; copied journals,
  coordinated rollback and custody/backup procedures remain open.
- Scope authority assumes complete stable venue snapshots; same-index mutation
  during custom synchronous adapter callbacks has no generation token.
- Setup/build provenance, full C2 re-derivation, history scaling, retention,
  note delivery, wallet restore and venue write-side acceptance remain gates.
