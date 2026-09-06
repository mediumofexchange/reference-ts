# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Merged into `main`: `51f8442`, from `feat/durable-pool-store` (base
  `d7ca1b9`). Node 24 SQLite pool activation, admission, signing and publication
  outbox are implemented, independently reviewed and fully verified.
- `PoolStore` atomically stores canonical openings, accepted statements,
  original signed receipts, checkpoints and publication markers. Signed
  sequences remain consumed after failed publication. Reload replays retained
  import ancestry and local history; opening the journal fences previous handles.
- Scope authority and signing deadlines are rechecked before commit. One
  commitment remains in flight during the venue lag. Restart waits a full lag;
  elective scope changes witness the live tail and latest signed checkpoint.
  Actual scope endings/staleness permit canonical reopening; old receipts survive.
- Revocation blocks new issue and active/imported issue lacking pre-revocation
  checkpoint evidence. Locally finalized value still moves. General revocation
  recovery and silence clauses remain explicitly unsupported, including silence
  in required ancestry outside the new scope; details are in `docs/POOL_STORE.md`.
- Retain only required replay-validated ancestry; return it with local
  checkpoints. Exact held publication retries avoid duplicate-sequence failures.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, signed-byte, circuit or proof-key changes.

## Evidence

- Final full `npm run check` passed: 70 files / 1,312 tests, docs, typecheck,
  build, installed tarball consumer, pilot and pool-store crash harness.
  This includes 31 store tests and 4 persistence-codec tests.
- Child-process harness passed opening, receipt and checkpoint crashes at
  applied/stored/committed phases. It checks rollback, retained original bytes,
  exact publication replies and monotonic next sequence. Integrated into `check`.
- Independent adversarial review found two original blockers: late-witnessed
  revoked issue and retention of unrelated unverified imports. Follow-up source
  review confirmed both fixed. Its admission-hex canonicalization finding is
  fixed. Review also confirmed the adapter-read ownership fence and conservative
  imported-silence refusal, with their regressions. No review blockers remain.
  Windows esbuild needs checks outside the restricted sandbox to read the
  existing configuration. Real circuits were not rerun locally; unchanged
  evidence remains `docs/pool-v2-verification.json`.

## Next

1. Build pool receipt classification and recovery against witnessed checkpoints,
   preserving prospective revocation and silence rules. Port adversarial model
   cases before enabling currently unsupported histories.
2. Add presentation, note delivery and wallet synchronization over the specified
   objects; then service transport and the external witness write side.

## Open questions

- SQLite ownership assumes exactly one journal for an operator key on its venue.
  Copied keys/databases and coordinated backup rollback need custody and backup
  procedures; SQLite cannot supply an external coordination authority.
- An imported checkpoint after revocation may contain issuance finalized by an
  earlier checkpoint of its segment. The first store slice conservatively
  refuses that case until the recovery reader can prove it.
- Durable replay currently reloads local history and retained supplied ancestry;
  profile large histories before designing compaction or immutable read caches.
- Same-index replacement appends during custom adapter callbacks are a
  clock-only authority limitation; the lead floor protects current authority.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
