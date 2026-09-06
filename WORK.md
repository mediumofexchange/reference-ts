# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Merged into `main`: `1bf2453`, from `feat/pool-opening-construction` (base
  `4d9fe64`). Canonical opening construction is implemented, independently
  reviewed and fully verified. Durable activation/admission/signing is next.
- `preparePoolOpening` derives current scope and exact opening checkpoints
  before a child commitment exists, validates all required histories, and
  returns a computed Segment with empty local history and imported spentness.
- `readPoolCurrent` shares exact descent with held-child reads, including every
  eligible same-index held sequence and excluding ended historical terms.
  `readPoolCheckpoints` plans multiple roots before any verifier callback and
  verifies shared ancestry once. Historical single-checkpoint behavior stays
  unchanged; malformed outer arguments still return invalid.
- The next sequence is the durable operator-wide highest signed plus one,
  including declined publications. A counter behind any held sequence or one
  exhausted at u64 is refused. The venue cannot certify an unwitnessed counter.
- Clock/view changes and same-index operator publications during proof replay
  refuse preparation. Backend exceptions retain their identity; caller-owned
  input mutation cannot rewrite another root or its required ancestry.
- Preparation does not reserve a sequence, discard a live tail, sign, publish
  or authorize admission. Durable activation still owes currency/authority and
  schedule checks, one in-flight commitment, and opening commit before receipts.
- Companion specification: `money-from-first-principles/main` at `ba8fe21`.
  No normative, circuit or proof-key changes. The authority model now uses
  current evidence descent when constructing openings (C2.7.3/C2.10.4–7).

## Evidence

- Full `npm run check` passed: 68 files / 1,253 tests, docs, typecheck, build,
  installed tarball consumer (including all new exports), crash/restart pilot
  and witness retry checks. The updated handoff also passed `check:docs`.
- Focused suite passed: 4 files / 121 tests; full verification includes four
  additional malformed-argument regression cases from independent review.
- Independent adversarial source review found no protocol/security blockers in
  bounds, scope authority, shared planning, input ownership or backend failures.
  Its malformed-wrapper regression finding was fixed and independently rechecked.
  Reviewer ran no tests; review is complete.
- 28 opening/batch cases cover genesis, current same-index state, durable signed
  counters, omitted/lapsed sequence consumption, u64 boundaries, missing/invalid
  ancestry, selective scope, replacement force, split/rejoin and reappointment,
  imported spentness, live-tail preservation, all-root callback mutation,
  same-index publication races, malformed arguments and venue/backend failures.
- Existing 27 checkpoint cases and 31 descent cases run unchanged in the focused
  suite; shared record fixtures now live in `test/pool-record-support.ts`.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs in `docs/pool-v2-verification.json`. Circuits were not rerun.

## Next

1. Build durable pool activation/admission/signing around prepared openings,
   record currency, scope authority and the schedule. An elective scope change
   must finish its live tail and latest signed commitment first; restart is not
   a scope reset. Journal the operator-wide signed counter and one in-flight
   commitment before exposing signatures or receipts.
2. Integrate receipt classification and recovery, then port the experiment's
   crash/retry cases. Presentation, note delivery and wallet sync follow their
   specified objects.

## Open questions

- No protocol choice or independent review remains unresolved for this slice.
- Existing Ergo latest/exact reads may expose partially fetched refreshes;
  bounded predecessor reads refuse unsettled views. Snapshot isolation and
  consistent changed-view errors in standalone PoolAuthorityView remain owed.
- Per-backing descent still repeats evidence copies and authority reads. Shared
  checkpoint roots now verify once in a batch; profile large histories before
  introducing a reusable immutable read context for further optimization.
- Full C2 re-derivation against the directory, authenticated setup/build
  provenance, target measurements, note delivery and transitive history
  availability remain release requirements.
