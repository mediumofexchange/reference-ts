# Current work

Updated: 2026-09-08

## Goal

Build the shielded-pool protocol. C2.10.10's evidence chain, receipt comparison
and recovery adoption are modeled and reviewed; next define v3 layouts.

## Status

- Implementation: `main`, with `feat/pool-evidence-model` merged as `16da1de`.
- Companion: `spec/pool-adopted-evidence` merged to `main` as `a15381a`.
  Normative commit `23af0f5` preceded code and requires exact forceful
  publication evidence through adoption; the later commit updates coverage.
- The maintainer authorized recommendations, decisions, merge and push on
  2026-09-08. Independent protocol and adversarial implementation review cleared.
- FaultWorld hashes explicit proof/signature bytes into a separate chain,
  compares receipt digests in both readers, preserves valid-prefix evidence,
  and retains witnessed evidence through adoption. Replica substitutions
  remain unresolved; authenticated bad evidence can be excluded and repaired.
- Runtime remains pinned v2; PoolStore refuses silence clauses. No runtime,
  circuit or wire changes. Real model hashes do not replace ideal proof and
  authentication oracles or specify v3 encoding.
- Keep the frozen private-payment fixture until receiver/invoice and audit
  crash/retry cases move to the pool/wallet. Retain offline Ergo probe and
  build/browser/setup caches in ignored `scratch/`. Review probes were removed.

## Evidence

- Independent final review: no remaining blockers; 3 new files / 55 focused
  tests pass. Covers exact bytes, receipt comparisons, adoption, mutation,
  replica event IDs and lapse shape, zero absent-signature digest, and fresh
  oracle outputs that cannot retroactively validate earlier guessed bytes.
- Full `npm run check` passes: 89 files / 1,674 tests, including all 306 model
  tests; typecheck, build, installed package, pilot and pool-store crash checks.
  The new copy boundary preserves the historical return counterexamples.
  Vitest/integration checks required permitted access; no check was weakened.
- Docs checks and cross-repository links pass (36 files); diff whitespace clean.
- [Adoption decision](decisions/2026-09.md#2026-09-08--adoption-retains-witnessed-proof-evidence)
  records the choice and retention cost. [Fault recovery](docs/POOL_FAULT_RECOVERY.md)
  owns model coverage, review dispositions and remaining evidence work.

## Next

1. Define v3 statement, recovery and evidence layouts and circuit relations;
   specify authenticated record-range and evidence-retention requirements.
   Reuse the adopted contract and retain adversarial cases while implementing.
2. Continue [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md): target phone,
   authenticated note delivery/restoration, independently available evidence
   and pinned-node publication. Offline sizes do not establish node acceptance.

## Open questions

- No protocol selection, check or independent review remains outstanding for
  this slice. Production layouts and their implementation need their own review.
- Missing committed evidence remains unresolved; intrinsic exclusion supplies
  no availability guarantee. Measure suffix/ancestry retention and cold reads.
  Cached verdicts do not replace evidence or current record snapshots.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
