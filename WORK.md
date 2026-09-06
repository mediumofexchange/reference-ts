# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer asked to continue under the prior authorization to merge and
push reviewed, verified work.

## Status

- `feat/pool-record-authority` is merged and pushed to `main`: `7619918`
  (model) and `fdc8ad2` (reviewed runtime authority and scheduling integration).
  The preceding v2 claim layer and calendar scheduler are merged/pushed:
  `9a93cb8` and `00101d7`. Companion specification remains main `ba8fe21`;
  no normative change or new construction/circuit identities in this slice.
- `pool/authority.ts` now reads an immutable scope-authority view from signed
  backing terms and the witnessed replacement chain. It reuses `successionAhead`
  rather than adding another election mechanism. Every backing must declare
  the same venue and construction domain. Scope links distinguish repeated
  appointments of the same operator key.
- The view checks claimed header authority at historical witnessed indices,
  derives the current scope in canonical name order, and integrates the
  scheduler with record-derived term boundaries and operator-wide signing state.
  Later record indices require a new view. This is not a cached permission
  to admit, authenticate a header, establish finality or discard a tail.
- `model/pool-authority.ts` now exposes current-scope boundaries and tests
  pending deadlines, historical authority and same-key reappointment.

## Evidence

- Final `npm run check` passed: 64 files / 1,141 tests, docs/links,
  typecheck, build, tarball consumer and crash/restart pilot. The authority
  runtime suite passed 9 cases and its model suite passed 30 cases.
- Independent adversarial source review found no blocking defects. Suggested
  regressions for a venue advancing during the read and a successor's header
  before force are added. Review covered ownership, signed terms, venue/domain,
  full scope, term identity, scheduling argument isolation and VenueError.
- Ported cases cover both replacement signatures, the exact 2*lag+1 floor,
  pending/arrived handover, revocation/supersession, same-index hash ties,
  unsigned twins, reappointment, historical bounds, copied inputs/outputs,
  wrong or undeclared venue, missing terms, and unavailable venue records.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs, recorded in `docs/pool-v2-verification.json`; prior full check:
  63 files / 1,131 tests plus docs, package consumer and crash/restart pilot.

## Next

1. Build canonical opening descent and whole-scope checkpoint validation
   (C2.7, C2.10.3–4). The existing Venue interface can locate an exact sequence's
   index but cannot return the previous held commitment below a sequence at
   the same index. Add that bounded predecessor-read capability before descent;
   do not scan absent sequence numbers or skip same-index predecessors.
2. Authenticate candidate scope data before using public whole-scope lapse
   to pass it. Present-but-invalid or withheld history must block fallback.
   Extend the model for exact directory descent before its runtime reader.
3. Integrate receipt classification and durable admission/receipt/commitment
   journaling, then port the experiment's crash/retry cases. Presentation,
   note delivery and wallet sync follow their specified objects.

## Open questions

- No protocol choice was needed. The authority view verifies claimed authority;
  canonical openings, authenticated checkpoint scope, witnessed finality and
  durable execution remain separate required work. No pool sequencer is claimed.
- Replacement reads retain the existing Venue contract: complete finalized
  append-only records in witnessed order, with unavailable reads throwing
  VenueError. A snapshot is fixed at its read index and must be refreshed.
- Full C2 re-derivation against the directory remains owed beyond the reviewed
  claim layer, scheduling arithmetic and scope authority.
- Setup assumptions, authenticated parameter distribution/build provenance,
  target-device measurements and note delivery remain release requirements.
  Shared history retains transitive availability dependencies and scope-wide
  unfinalized tail loss at forced boundaries; no cross-venue bridge is implied.
