# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. Adopted fault classification, snapshot clock
and segment continuity; next model exact admitted evidence and its receipts
before fixing any v3 bytes.

## Status

- Implementation: `main`, with `feat/pool-fault-contract` merged as `1fc4209`.
  `FaultWorld` uses the snapshot clock and last-valid continuation without
  policy switches. Rejected policies remain in a test-only historical helper.
- Companion: `spec/pool-fault-contract` merged to `main` and pushed as
  `56f8a92`, adopting `pool-fault.md` and amending Construction, authority
  and recovery. The maintainer authorized choices, merge and push on 2026-09-08.
- Selected: authenticated exclusion; snapshot clock (D); continuation from the
  last valid prefix (R7′); existing receipt precedence. The duration prices a
  dropped backing as darkness. Independent review clarified evidence-bound
  receipt comparisons, immutable evidence only for valid prefixes, adopted
  statement exceptions and the limits of cross-scope independence.
- Runtime remains pinned v2; PoolStore refuses silence clauses. No runtime,
  circuit or wire changes. Recovery/fault rules remain executable ideal models.
- Keep the frozen private-payment fixture until receiver/invoice and audit
  crash/retry cases move to the pool/wallet. Retain offline Ergo probe and
  build/browser/setup caches in ignored `scratch/`.

## Evidence

- Model suite: 14 files / 251 tests; typecheck passes. Final reader cleanup
  also passed 27 reader tests. Rejected policies preserve the old counterexamples.
- Independent contract review: all findings resolved and read back. Independent
  model review: no blockers; six focused files / 88 tests pass. Verified
  last-valid continuity, honest tail retention, occupied excluded sequences,
  unresolved-evidence refusal, receipt precedence and same-index silence.
- Full `npm run check` passes: 86 files / 1,619 tests, typecheck, build,
  installed package, pilot and pool-store crash checks. It required permitted
  access after sandboxed Vitest could not load its configuration; no check was
  changed or weakened. Links pass across all four repositories (36 files).
- Selected rules and costs: [decision](decisions/2026-09.md#2026-09-08--authenticated-faults-preserve-the-last-valid-state-and-the-clock-reads-its-snapshot).
  [Fault recovery](docs/POOL_FAULT_RECOVERY.md) owns model limits and next evidence cases.

## Next

1. Model C2.10.10's separate evidence chain and exact receipt proof/signature
   digest comparisons: alternate valid proofs, substituted/withheld bytes,
   committed bad evidence, valid-prefix immutability, repaired unfinalized
   positions and evidence-mismatched receipt contradiction. Independently
   review that model before a v3 byte layout. Ideal proof identities do not
   yet establish this contract.
2. Continue [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md): target phone,
   authenticated note delivery/restoration, independently available evidence
   and pinned-node publication. Offline sizes do not establish node acceptance.

## Open questions

- No protocol selection or independent review is outstanding for this slice.
  The exact evidence-chain model and later layout still need their own review.
- Missing committed evidence remains unresolved; intrinsic exclusion supplies
  no availability guarantee. Measure suffix/ancestry retention and cold reads.
  Cached verdicts do not replace evidence or current record snapshots.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
