# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Merged into `main`: `7a382e9`, from `feat/pool-directory-descent` (base
  `0e6b1dd`). Implementation, independent source review and full verification
  are complete. Next is whole-scope checkpoint validation.
- `readPoolPredecessor` selects one backing's candidate relative to an exact
  held child, using bounded held-record reads through historical operator terms.
  Same-index lower sequences are eligible only for the child's operator;
  reappointment preserves intervening terms and sparse sequences need no probes.
- Each skipped eligible record proves directory absence or public whole-scope
  lapse. A snapshot preimage authenticates the full header before signed scope
  terms and witnessed replacement links can establish lapse at the record index.
  Selective carriage cannot finalize a segment but can authenticate its scope.
- Missing directory/scope evidence stops as unavailable; malformed evidence
  returns invalid. A live candidate is selected before replay, even if its
  history is invalid or withheld. No older candidate can substitute for it.
- `PoolAuthorityView.termForLink` exposes copied historical/announced term bounds;
  a known link is not evidence that its term has started. The adversarial model
  now expresses authenticated directory descent and its failure departures.
- Companion specification remains `main` at `ba8fe21`. No normative or circuit
  changes. Bounded venue predecessor reads landed previously in `f777da9`.

## Evidence

- Focused verification passed: 78 tests across pool descent, scope authority and
  the authority model (31 new runtime descent cases, 38 total model cases).
  Full `npm run check` passed: 66 files / 1,197 tests, docs, typecheck, build,
  installed tarball consumer (including descent export) and crash/restart pilot.
- Independent adversarial source review found no blockers in rank, historical
  bounds, authenticated lapse, refusal to fall back, copying or termination.
  Its scope-name lookup efficiency suggestion was applied. Review ran no tests.
- Coverage includes exact child identity, genesis, same-index absence, sparse
  sequences through 2^64−1, missing evidence, authenticated invalid scope,
  future terms, altered snapshot preimages, selective-directory lapse,
  same-key reappointment, live replay failure and inconsistent venue indices.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs in `docs/pool-v2-verification.json`. Circuits were not changed or rerun.

## Next

1. Build whole-scope checkpoint validation and transitive canonical import
   checks (C2.10.3–5), applying candidate selection to each backing before
   replay. Integrate canonical opening construction for new segments; this
   slice's reader is relative to an already held child, not a signing service.
2. Integrate receipt classification and durable admission/receipt/commitment
   journaling, then port the experiment's crash/retry cases. Presentation,
   note delivery and wallet sync follow their specified objects.

## Open questions

- No protocol choice was needed. Candidate selection does not establish replay,
  canonical imported ancestry, checkpoint finality or a durable pool sequencer.
- Existing Ergo latest/exact readers can expose a partially fetched refresh;
  the new bounded predecessor reader refuses unsettled views. Keep using it
  before exact-index lookup; adapter snapshot isolation remains future work.
- A clock change inside PoolAuthorityView construction currently becomes an
  invalid result through PoolError; other changed-view paths throw VenueError.
  Both refuse descent; consistent error typing is inherited follow-up work.
- Full C2 re-derivation against the directory remains owed. Setup assumptions,
  authenticated parameter distribution/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
