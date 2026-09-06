# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

- Active branch: `test/pool-receipt-repair-gap`, base `d42a9ea`.
  Investigating global receipt classification found a material normative gap.
  The regression and diagnostic are verified and ready to merge/push.
- Global classification must not label every new segment under live terms an
  elective violation. A receipt can name held sequence 1, then be included in
  signed-but-unwitnessed sequence 2, then be dropped by permitted stale repair
  at sequence 3. The receipt's after is still held and its scope is still live.
- The actual PoolStore reproduces this case at lag 2, preserves the original
  receipt through restart, and reports the expected separate record/inclusion
  facts. No runtime behavior or normative rule has been changed.
- Decision requested from maintainer: explicitly permit those unfinalized
  receipts to lapse after canonical failed-publication repair (recommended,
  preserves existing repair), or require continuity and change the repair
  mechanism. Either choice must preserve prior inclusion and historical
  contradiction evidence. Details: docs/POOL_RECEIPT_REPAIR_GAP.md.
- The private authority model must gain the stale signed-state repair case
  together with that clarified rule. Its current open guard permits only a
  finalized live tail or an actual scope ending. The older sequencing model
  checks only an exact next held sequence; it avoids one false accusation but
  is not a complete lapse classifier.
- Latest completed runtime work remains `a07cf0f`, merged/pushed with handoff
  `d42a9ea`: complete used checkpoint evidence retained through restart,
  pre-service canonical revalidation, and historical replies kept accessible.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, signed-byte, receipt-envelope, circuit or proof-key changes.
  Pool-v2 §7.4 still excludes silence redemption and venue-nullifier adoption.

## Evidence

- Focused regression passed: `failed checkpoint repair can leave a live-scope
  receipt's after sequence held` in test/pool-store.test.ts (1 passed).
  Full npm run check passed: 72 files / 1,380 tests, docs, typecheck, build,
  installed tarball consumer, pilot and pool-store crash harness.
- Independent protocol review confirmed the gap and corrected the proposed
  blanket elective-transition accusation. A missing sequence is a known
  record gap, not missing history evidence and not proof of its hidden contents
  or timing. No fault/lapse verdict for that gap is implemented.
- Windows esbuild requires execution outside the restricted sandbox. Real
  circuits are unchanged; pinned evidence is docs/pool-v2-verification.json.

## Next

1. Finish verification and commit/merge/push the regression and diagnostic.
2. Resolve the maintainer's receipt-repair choice in the companion specification
   first, then extend the adversarial model and build global receipt
   classification. Authenticate held after-segment identity; preserve inclusion
   and historical contradictions as independent facts; missing evidence stops.
3. Specify later-version silence/presentation objects before implementing
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
