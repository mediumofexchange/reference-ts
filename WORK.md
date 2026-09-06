# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized merging and pushing completed work.

## Status

- Merged into `main`: `40e9484`, from `feat/pool-receipt-record` (base
  `03dca8f`). Receipt record facts and exact source-checkpoint inclusion are
  independently reviewed and fully verified.
- `readPoolReceiptRecord` authenticates the complete header and signed scope
  terms, resolves exact held/not-reached/moved-past sequences, and reports
  current scope term bounds. Reappointment never revives an old link.
- `readPoolReceiptCheckpoint` compares position, statement and history identity
  against one exact source checkpoint after canonical whole-scope replay.
  Inclusion survives later term endings; missing history stays unavailable.
  Checkpoint results expose owned local replay admission records as `accepted`.
- These are separate record facts, not a global receipt classifier. They do
  not authorize discard, accuse fault or establish recovery-valid value.
  API boundaries are in `docs/POOL_RECEIPTS.md`.
- The durable store from `51f8442` remains unchanged: openings, admissions,
  original receipts, signed sequences and publication outbox survive restart;
  earlier handles are fenced, restart waits the lag, elective scope changes
  preserve live tails. Revocation/silence restrictions remain in force.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, sequencing-rule, signed-byte, circuit or proof-key changes.

## Evidence

- Full `npm run check` passed: 71 files / 1,337 tests, docs, typecheck, build,
  installed tarball consumer, pilot and pool-store crash harness. This includes
  24 new receipt-record tests and the accepted-record ownership regression.
- Independent adversarial source review found no blockers. Its two notes are
  addressed: replay evidence hashes are documented separately from original
  receipt attribution, and output ownership has a direct regression.
- Pilot and pool-store child-process checks passed all applied/stored/committed
  crash phases, original-byte retries, rollback and monotonic signed counters.
- Windows esbuild still requires checks outside the restricted sandbox to read
  its existing configuration. Real circuits are unchanged and were not rerun
  locally; pinned evidence remains `docs/pool-v2-verification.json`.

## Next

1. Extend the pool authority model and build the global receipt/recovery
   classifier: check historical inclusion and live-scope contradictions before
   lapse, preserve prospective revocation, validate silence recovery. Bind a
   held `after` commitment to its segment before treating it as an operative era.
2. Recognize imported issuance finalized before revocation even when carried
   by a later checkpoint; then enable only histories the recovery reader proves.
3. Add presentation, note delivery and wallet synchronization; then service
   transport and the external witness write side.

## Open questions

- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback require custody and backup
  procedures; SQLite cannot provide an external coordination authority.
- General revocation recovery and silence clauses remain unsupported by the
  store, including required shared ancestry outside the new scope.
- Profile large retained histories before designing compaction or read caches.
- Same-index replacement appends in custom adapter callbacks remain a
  clock-only snapshot limitation; adapters must expose complete stable records.
- Full C2 re-derivation, authenticated setup/build provenance, target
  measurements, note delivery and transitive history availability remain
  release requirements.

## Improvement opportunities

- Additional repository security scans could complement protocol review;
  evaluate Codex Security access/cost before adding it. Existing Git/gh,
  repository instructions and npm checks cover this slice without a new MCP.
