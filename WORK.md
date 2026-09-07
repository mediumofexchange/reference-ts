# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

- Implementation merged into `main`: `41fc808` from
  `feat/pool-receipt-repair-lapse`, base `41adc1b`.
- Companion specification merged/pushed to `main`: `bdd3599` from
  `spec/pool-receipt-repair-lapse`.
  The maintainer approved lapse after proven failed-publication repair.
  C2.10.9a is committed first and the README pins that specification revision.
- `readPoolReceiptRepair` proves one supplied repair boundary: held after in
  the receipt segment, first held different-segment checkpoint is a canonical
  empty opening, immediate preceding sequence absent and greater than after,
  original scope terms live at the boundary. Canonical replay validates the
  complete held interval and required ancestry without enumerating holes.
- Inclusion and contradiction remain independent. An occupied conflicting
  position at after contradicts too; absence there does not. Only neither
  permits lapse. Invalid/unavailable evidence never establishes lapse.
- This is a verdict at the supplied boundary, not a global current verdict.
  Later final inclusion remains independently meaningful. Same-index lower
  sequences are retained. The reader owns inputs and callback references.
- The private authority model now covers stale signed-state repair and the
  boundary classifier. PoolStore behavior, signed frames and circuits are
  unchanged; the actual durable-store regression now checks the lapse verdict.
- Durable rationale: decisions/2026-09.md and docs/POOL_RECEIPT_REPAIR_GAP.md.
  Pool-v2 §7.4 still excludes silence redemption and venue-nullifier adoption.

## Evidence

- Independent adversarial review approved the normative predicate after adding
  occupied-position conflict at after, and approved runtime logic after fixing
  venue/verifier reference replacement through callbacks.
- Full npm run check passed: 73 files / 1,419 tests (including 63 private-model
  and 23 repair-reader cases), docs, typecheck, build, installed tarball
  consumer, pilot and pool-store crash harness. The package check verifies
  the new reader through both the package root and its subpath.
- Windows esbuild requires execution outside the restricted sandbox. Real
  circuits are unchanged; pinned evidence is docs/pool-v2-verification.json.

## Next

1. Build global receipt classification from these bounded facts: exact reference
   carriage, unheld references, actual scope boundaries, historical inclusion
   and contradictions, and chronological segment transitions. Do not turn an
   old boundary lapse into a permanent verdict that suppresses later inclusion.
2. Specify later-version silence/presentation objects before implementing
   recovery, presentation, delivery, wallet synchronization and service transport.

## Open questions

- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before compaction or immutable read caches. Complete
  evidence retention and pre-service validation add storage/replay cost.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
