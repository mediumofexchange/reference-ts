# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer explicitly authorized pushing and merging reviewed, verified work.

## Status

- Active branch: `feat/venue-predecessor-read`, based on main `378b71d`.
  Implementation and full verification are complete; final independent review
  is pending before push and merge.
- `Venue.previousFor(operator, beforeSequence, asOf?)` now locates the greatest
  held sequence below an exclusive sequence bound and at or before an inclusive
  witnessed index. The bound need not itself be held. Same-index predecessors
  remain reachable; bigint sequence gaps require no probes.
- Local and Ergo adapters use binary search over the monotone held record for
  predecessor, historical latest and exact-sequence reads. Returned commitment
  bytes are copied. The pilot wire view and lagging test adapter expose the API;
  custom Venue adapters must implement this new required method.
- Ergo predecessor reads require a settled, successfully synced snapshot and
  per-key coverage. A partially fetched refresh or failed frontier refuses,
  including for a zero sequence bound. A failed height read before replacement
  leaves the previous coherent snapshot readable after the refresh settles.
- Companion specification remains `main` at `ba8fe21`; no normative changes or
  construction/circuit identity changes. Prior scope authority and scheduling
  are on main (`7619918`, `fdc8ad2`), following the v2 claim layer (`9a93cb8`).

## Evidence

- `npm run check` passed: 65 files / 1,158 tests, including all 17 predecessor
  cases and the deferred multi-operator refresh regression; docs, typecheck,
  build, tarball consumer and crash/restart pilot passed. Final typecheck also
  passed after the review fix.
- Independent adversarial review identified the partial-refresh edge; the new
  API now refuses it. Final source verdict is pending.
- Coverage includes same-index descent, inclusive/exclusive boundaries, sparse
  sequences above 2^53 through 2^64−1, holes, per-operator isolation, copied
  outputs, finalized versus unfinalized records, invalid signatures, rejected
  nonextensions, unavailable reads, refresh failure/retry and the pilot binding.
- Prior unchanged circuit evidence: 153 circuit/proof checks and 24 real ZK
  proofs in `docs/pool-v2-verification.json`. Circuits were not changed or rerun.

## Next

1. Extend `model/pool-authority.ts` for exact directory descent, then build
   canonical opening descent and whole-scope checkpoint validation (C2.7,
   C2.10.3–4) using the bounded predecessor read. Authenticate candidate scope
   data before using public whole-scope lapse to pass it. Present-but-invalid
   or withheld history must block fallback.
2. Integrate receipt classification and durable admission/receipt/commitment
   journaling, then port the experiment's crash/retry cases. Presentation,
   note delivery and wallet sync follow their specified objects.

## Open questions

- No protocol choice was needed. Locating a held commitment proves neither
  directory carriage nor canonical opening nor whole-scope finality. No pool
  sequencer is claimed.
- Existing Ergo latest/exact readers can answer a fetched operator after a
  multi-operator refresh fails later in its frontier. They are used internally
  during sync and cannot simply take the new predecessor's settled-view guard.
  Address snapshot isolation when rewriting the adapter; pool descent must use
  a settled view. The predecessor API added here refuses this partial state.
- Full C2 re-derivation against the directory remains owed. Setup assumptions,
  authenticated parameter distribution/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
- Windows sandbox blocked esbuild's parent-directory resolution and GitHub
  networking; approved escalated test/fetch commands were needed. Routine
  workspace saves and local branch creation worked without escalation.
