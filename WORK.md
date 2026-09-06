# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer authorized final v2 review, a following slice, and merge/push
when satisfied in this session.

## Status

- Implementation `feat/pool-v2-claim-layer` is merged and pushed to `main`:
  `00101d7` (calendar model), `9a93cb8` (reviewed v2 and scheduling).
  Companion `spec/pool-v2` is merged and pushed to specification `main`
  `ba8fe21` (layout `d0f2413`, reviewed pins `ba8fe21`). README pins it.
- v2 replaces the historical v1 runtime: immutable construction domain,
  private scope membership, segment-bound statements, two input anchors,
  finalized imports with shared-history deduplication, whole-scope directory,
  signed receipts and replay. Circuits, keys and configuration are pinned.
- Final review repaired replay's asynchronous ownership of later statements
  and ancestor evidence, and refused checkpoints predating the segment's
  first commitment sequence in both import paths. External histories enter
  through `Segment.replay`; constructor prefixes are trusted computed state.
- Following slice: `pool/schedule.ts` implements the earliest scope boundary,
  operator-wide commitment-in-flight wait, preservation of the last signing
  clock and restart lag using bigint. It supplies time checks only; it does
  not establish authority, sign, publish, discard tails or classify receipts.
  `model/pool-schedule.ts` enumerates future signing clocks independently.

## Evidence

- Final `npm run check` passed after review repairs and scheduling: 63 files /
  1,131 tests, docs/links, typecheck, build, tarball consumer and crash/restart
  pilot. The focused import suite also passed all 9 cases after the repairs.
- `npm run check:pool` passed after replay repairs: 153 checks and 24 real
  ZK proofs. Report: `docs/pool-v2-verification.json`. All source, bytecode,
  verification-key and configuration hashes match specification §15.
- Independent circuit/frame/receipt review found no blocking defects.
  Independent replay review reproduced input mutation and checkpoint-order
  defects against the old build, then reviewed the repairs; no findings remain.
- Independent scheduling review found no runtime defect. It identified model
  gaps for restart and no pending boundary; both are corrected with differential
  cases. Calendar traces preserve the last signing clock; ignoring the earliest
  backing boundary produces a counterexample. All seven scheduling/model
  tests passed, including bounded differential calendars.
- Specification links passed across 9 files; specification diff check passed.
  This is source review and executable evidence, not a completed security audit.

## Next

1. Build record-derived pool scope authority and exact directory descent
   (C2.7, C2.10.3–4), integrate scheduling with whole-scope finality and receipt
   classification, then durable admission/receipt/commitment journaling. Extend
   the model first and port frozen transparent cases without retired mechanisms.
2. Port crash/retry cases from the private-payment experiment and retire it
   when the pool has equivalent durable execution. Presentation, receiver
   acceptance, note delivery and wallet sync follow their specified objects.

## Open questions

- No new protocol choice was needed. The claim layer still relies on the
  sequencer to establish canonical openings, witnessed finality and current
  scope authority. The scheduling helper alone does not establish these.
- Full C2 re-derivation against the directory remains owed beyond the reviewed
  claim layer and bounded scheduling arithmetic.
- Setup assumptions, authenticated parameter distribution/build provenance,
  target-device measurements, durable execution and note delivery remain release
  requirements. No deployment or live-value compatibility is claimed.
- Shared history retains permanent transitive availability dependencies and
  scope-wide unfinalized tail loss at forced boundaries. Cross-venue movement
  requires a separate bridge, never comparison of different venue indices.
