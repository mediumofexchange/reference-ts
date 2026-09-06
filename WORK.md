# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

- Active branch: `fix/pool-prospective-revocation`, base `49395d8` on `main`.
  Independently reviewed and fully verified; ready to merge and push.
- Canonical checkpoint replay now enforces C2b.1: newly finalized local ISSUE
  must be witnessed strictly before its obligor's revocation. Already validated
  same-segment prefixes and imported events retain their original finality.
  Exact prefix comparison prevents rewriting earlier positions to launder
  issuance. Invalid live history blocks the candidate; missing evidence stops
  validation, with no filtering, repair or fallback.
- Revocation cutoffs are read for every required scope, including shared
  ancestors outside the requested scope, before proof callbacks. Final checks
  detect same-index cutoff changes. Venue/proof callback failures propagate.
- Opening preparation and receipt inclusion inherit this check. The pool
  authority model uses an independent first-inclusion oracle, with a departure
  demonstrating that ignoring revocation creates invalid supply.
- The store keeps its conservative import restriction. `requiredImports`
  retains header import references but omits same-segment predecessor evidence
  and other descent evidence. The reader can now validate later checkpoints
  carrying old issuance; safely enabling them in the journal needs that full
  proof retained across restart, not an asserted cutoff stored as metadata.
- Receipt record facts/inclusion from `40e9484` and durable sequencing from
  `51f8442` remain the base. Global receipt classification is still next.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, signed-byte, circuit or proof-key changes. Pool-v2 §7.4
  explicitly excludes silence redemption and venue-nullifier adoption;
  those objects must be specified together in a later construction version.

## Evidence

- New model cases cover pre-revocation value, late/tied batches, same-index
  record updates, shared obligor keys, withheld proof and an unsafe departure.
- Runtime regressions cover continued spend/burn, replacement imports, prefix
  rewriting, missing predecessors, invalid out-of-scope ancestry, receipt and
  opening reads, cutoff races, wrong indices and callback failures.
- Independent adversarial review found no blockers. Sequential reads cannot
  provide an atomic generation token for deliberately mutating custom venue
  callbacks; stable adapter records remain a trust requirement.
- Full `npm run check` passed: 72 files / 1,365 tests, docs, typecheck, build,
  installed tarball consumer, pilot and pool-store crash harness. This includes
  20 new runtime revocation tests and 8 new model cases.
- A store regression now expects `UNAVAILABLE`
  because invalid late issuance is rejected during canonical opening validation,
  before the store's older `UNSUPPORTED` guard is reached.
- Windows esbuild requires execution outside the restricted sandbox. Real
  circuits are unchanged and were not rerun locally; pinned evidence remains
  `docs/pool-v2-verification.json`.

## Next

1. Commit, merge and push this reviewed and verified slice.
2. Retain the complete canonical validation evidence needed by each durable
   opening, including same-segment predecessors and descent directory/scope
   evidence. Revalidate on restart; then lift the conservative import refusal.
3. Extend the model and build global receipt classification: authenticate the
   held `after` commitment's segment and check historical inclusion and
   live-scope contradictions before lapse. Keep missing evidence distinct.
4. Specify later-version silence/presentation objects before implementing
   recovery, presentation, delivery, wallet synchronization and service transport.

## Open questions

- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority still assumes a complete, stable venue snapshot; same-index
  mutation during synchronous custom adapter callbacks has no generation token.
- Profile large histories before designing compaction or immutable read caches.
- Full C2 re-derivation, authenticated setup/build provenance, target
  measurements, note delivery and transitive history availability remain
  release requirements.
