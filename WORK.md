# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

- Completed branch: `feat/pool-durable-validation-evidence`, base `5bb9c12`.
  Independently reviewed and fully verified; merge and push are next.
- Successful descent, checkpoint and opening readers now return their used
  evidence: authenticated directory/scope steps and replayed histories,
  including same-segment predecessors. Unselected history and uncheckpointed
  tails are excluded. Replayed snapshots derive from verified prefixes.
- Version 2 local opening envelopes retain this complete evidence. New service
  after restart revalidates imports against the record; held openings under
  valid scopes also revalidate their canonical descent. Later checkpoints
  carrying proven pre-revocation issuance remain importable and usable.
- Validation gates new admission/signing after exact retry lookup. Structural
  replay still verifies saved proofs, signatures and receipts. Original replies,
  unclassified history and durable publication retries remain accessible even
  when same-index revocation later invalidates an imported checkpoint.
- Missing evidence blocks new service with UNAVAILABLE; silence recovery remains
  unsupported. Version 1 envelopes remain readable, reconstructing snapshots
  from their imports, but cannot fabricate missing canonical predecessors.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, signed-byte, receipt-envelope, circuit or proof-key changes.
  This implements C2.10.3–5/8–9 and C2b.1. Pool-v2 §7.4 still excludes silence
  redemption and venue-nullifier adoption.

## Evidence

- Full npm run check passed: 72 files / 1,379 tests, docs, typecheck, build,
  installed tarball consumer, pilot and pool-store crash harness.
- Regressions cover pre-revocation predecessors through restart and movement,
  history-free absence/lapse, scope expansion enriching cached evidence,
  deleted proof material, exact historical replies after same-index revocation,
  append races, retained-prefix ownership and strict v1/v2 codec framing.
- Independent adversarial review found two issues, both fixed and regression
  tested: cached partial evidence shadowed newly supplied fields; unconditional
  finality checks blocked retrieval of historical signed replies. Focused final
  re-review found no remaining blockers.
- Windows esbuild requires execution outside the restricted sandbox. Real
  circuits are unchanged and were not rerun; pinned evidence remains
  docs/pool-v2-verification.json.

## Next

1. Merge and push the completed branch as authorized.
2. Extend the model and build global receipt classification: authenticate the
   held after commitment's segment and check historical inclusion and
   live-scope contradictions before lapse. Keep missing evidence distinct.
3. Specify later-version silence/presentation objects before implementing
   recovery, presentation, delivery, wallet synchronization and service transport.

## Open questions

- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before designing compaction or immutable read caches.
  Complete evidence retention and pre-service validation add storage/replay cost.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
