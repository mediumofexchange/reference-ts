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
- Workflow: `docs/autonomous-development-workflow` in both repositories
  records standing AI decision/delivery authority, independent review and
  completion criteria in AGENTS.md. The root workspace instructions agree;
  root files are local, while repository instructions are independently usable.
  No protocol, runtime, CI or permission configuration changed in this slice.
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
- Workflow patch: independent review cleared with no blockers; current
  `npm run check:docs`, cross-repository links and diff checks pass. Runtime
  is unchanged; the full-check result above belongs to `16da1de`. Hosted CI
  for baseline `0026a1b` also passed. Links cover 36 files across four repos.
- [Adoption decision](decisions/2026-09.md#2026-09-08--adoption-retains-witnessed-proof-evidence)
  records the choice and retention cost. [Fault recovery](docs/POOL_FAULT_RECOVERY.md)
  owns model coverage, review dispositions and remaining evidence work.

## Next

1. Start v3 with the recovery field/relation map: public inputs, witnesses,
   state effects and exact evidence for demand, acceptance, release and
   adoption. Select one complete trace through wallet, operator and witness;
   identify required record-range/retention evidence and resource assumptions.
   Acceptance: reviewed map plus a reproducible trace/probe plan, with each
   unresolved assumption named, before committing production layouts. Then
   implement that path and port its adversarial cases, rather than expanding
   the ideal model without a runtime target.
2. Continue [deployment probes](docs/POOL_DEPLOYMENT_PROBES.md): target phone,
   authenticated note delivery/restoration, independently available evidence
   and pinned-node publication. Offline sizes do not establish node acceptance.

## Open questions

- Product estimate: about 40% done / 60% remaining; plausible done range
  30–50% as roadblocks become known. Workflow improvements do not raise it.
  Largest work: v3 runtime/circuits, wallet/transport, delivery/restoration,
  witness publication and deployment/security assurance. See
  [estimate scope](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate).
- No protocol selection, local check or independent review remains outstanding for
  this slice. Production layouts and their implementation need their own review.
- Missing committed evidence remains unresolved; intrinsic exclusion supplies
  no availability guarantee. Measure suffix/ancestry retention and cold reads.
  Cached verdicts do not replace evidence or current record snapshots.
- Copied journals, rollback, custody/backup, same-index custom-venue changes,
  setup/build provenance and external write acceptance remain release gates.
