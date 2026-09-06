# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Merged into `main`: `862d92e`, from `fix/pool-record-snapshots` (base
  `36a4004`). Record snapshot isolation is implemented, independently reviewed
  and fully verified. Durable activation/admission/signing remains next.
- Ergo refresh builds a private candidate. Every public record/clock read
  refuses from the start of refresh until the complete operator frontier is
  fetched. The new clock, records and coverage become visible together.
- Failed refreshes preserve the previous complete snapshot at its original
  index and its admitted-replacement memo. Failed first syncs remain unavailable.
  Successful refreshes invalidate the old memo; malformed indexed heights fail.
- `PoolAuthorityView` owns all requested backing terms and signatures before
  calling the adapter. Index, lag and venue identity changes raise `VenueError`,
  including when another input validation failure interrupts construction.
- Previously merged opening construction (`1bf2453`) remains unchanged:
  canonical current imports, empty local history, operator-wide durable signed
  sequence assertion, no signing or tail-discard authority.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, signed-byte, circuit or proof-key changes.

## Evidence

- Full `npm run check` passed: 68 files / 1,277 tests, docs, typecheck, build,
  installed tarball consumer, crash/restart pilot and witness retry checks.
- Focused suite passed: 5 files / 159 tests, covering Ergo, pool authority,
  opening, checkpoint and descent. Full verification also covers predecessor
  reads; two existing post-failure tests now assert the retained old snapshot.
- New regression coverage: all public record APIs and pool authority refuse
  across height/publication/revocation/frontier fetches; first-sync and refresh
  success/failure; exact error identity, retry, old snapshot/memo retention,
  malformed node heights, whole-request callback mutation and changed-view
  classification on both successful and interrupted authority reads.
- Independent adversarial source review found no protocol/security blockers.
  The reviewer ran no tests. Focused self-review and `git diff --check` passed.
  Windows esbuild requires running checks outside the restricted sandbox to
  read the existing Vitest configuration.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs in `docs/pool-v2-verification.json`. Circuits were not rerun locally.

## Next

1. Build durable pool activation/admission/signing around prepared openings,
   current record authority and the schedule. Elective scope changes must
   witness their live tail and latest signed commitment; restart is no reset.
   Journal the operator-wide signed counter and one in-flight commitment before
   exposing signatures or receipts; preserve the restart lag and writer ownership.
2. Reuse the SQLite command transaction pattern from `pilot-store.ts` and
   canonical segment/header/statement/commitment encodings. Recover through
   `Segment.replay`, retaining original receipt bytes and exact admitted evidence.
   Port the experiment's crash-before/after-commit, retry, racing-writer,
   identity, corruption and response-replay cases; do not add a second framework.
3. Integrate receipt classification/recovery, then presentation, note delivery
   and wallet synchronization over their specified objects.

## Open questions

- The snapshot fix preserves an older successful read after refresh failure;
  callers must handle the failed refresh and must not treat it as fresh evidence.
  Pool authority remains a synchronous snapshot, not a durable admission capability.
- Same-index replacement appends during custom adapter callbacks are a pre-existing
  limitation of the clock-only authority guard. The replacement lead floor keeps
  current authority safe; refresh the view before acting on later record state.
- Per-backing descent still repeats evidence copies and authority reads. Shared
  checkpoint roots verify once in a batch; profile large histories before adding
  a reusable immutable read context.
- Full C2 re-derivation against the directory, authenticated setup/build
  provenance, target measurements, note delivery and transitive history
  availability remain release requirements.
