# Current work

Updated: 2026-09-06

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
The maintainer approved preserving private spends and independent per-backing
operator replacement, and authorized merge/push when satisfied.

## Status

- Implementation feat/pool-authority-model is merged and pushed to main as
  7f96262. Companion spec/pool-authority is merged and pushed to specification
  main b9f8beb; normative contract f842335 through a219aad. The reference
  slice is reviewed and checked; the next work is the new construction layout.
- The new pool-authority.md contract defines immutable construction domains,
  private membership in public service scopes, whole-scope finality, exact
  canonical predecessor imports, deduplicated shared history and a forest of
  certified roots with combined spentness. Elective scope changes finish live
  receipts; forced lapse retains historical evidence. See the 2026-09-06
  decision in DECISIONS.md for alternatives, costs and scope limits.
- model/pool-authority.ts models these rules with ideal proof/signature/hash
  tokens, one venue, valid replacement chains and local journal ownership.
  The host/replayer never read hidden backing labels to route spends.
  Counterexample switches remove six individual guards. This is a bounded
  executable abstraction, not a formal proof, circuit or production service.
- The older model/sequencing.ts remains the timing/election/drop/silence
  evidence; its public backing labels and separate histories do not establish
  shared-pool compatibility. The new model does not implement its full timer,
  election conflicts, receipt classification or redemption logic.
- Existing src/pool/ remains the historical fixed-operator v1 implementation,
  with claim-layer admission/replay and receipt envelopes (main 53c9719).
  Runtime specification pin stays 81516ba; new contract pin is a219aad.
  New layouts/circuits/keys are required before implementing PoolSequencer.

## Evidence

- npm run check passed: 59 files / 1,108 tests, including 29 authority-model
  tests; docs/links, typecheck, build, tarball consumer and local pilot passed.
- Cases cover split/rejoin, mixed anchors, unchanged nullifiers, shared
  issuance/burn accounting, padding/domain/issuance authority, replay,
  abandoned roots, withheld ancestors, invalid carriage, signed token copying,
  restarts and retired journals. Six departure switches produce counterexamples;
  16 deterministic spend-order patterns each exercise four split/rejoin rounds.
- Independent authority/history design reviews addressed scope membership,
  imported ancestry, per-backing descent, same-index predecessors, lapse across
  all state readers, and live receipt continuity. Independent source review
  found journal retirement, mutable signed inputs, immutable header replay and
  invalid-scope/lapse ordering defects; regressions cover the repairs. Final
  focused review found no remaining defects. Reviewers did not execute tests.
- Specification links passed across 8 files; spec git diff --check passed.
- Prior unchanged runtime evidence: npm run check passed 58 files / 1,079 tests;
  check:pool passed 111 checks and 17 real proofs, recorded in
  docs/pool-v1-verification.json. No claim that v1 implements the new relations.

## Next

1. Specify the replacement-capable construction's exact configuration, scope,
   segment, multi-anchor statement, receipt, history/import and snapshot frames.
   Pin circuit relations and test vectors before changing runtime code. Existing
   v1 objects retain their original meaning; do not patch operator checks alone.
2. Implement new claim relations and replay, then integrate C2.6 scheduling,
   receipt classification, exact directory descent and local durable journaling.
   Port frozen-path cases, never its retired opening claims/whole-state exhibits.
3. Receiver acceptance, note delivery and wallet sync follow. Cross-operator
   presentation/exchange and snapshot adoption require complete specified objects.

## Open questions

- No authority choice remains for this slice. New construction layout/version,
  circuit artifacts and setup provenance remain unpinned; it is not deployable.
- Shared history creates permanent transitive availability dependencies and
  scope-wide tail loss at forced boundaries. The contract states these costs;
  independent replacement does not promise independent historic data access.
- Full C2 re-derivation review against the directory remains owed beyond this
  slice; the reviews here cover C2.10 and its affected state readers.
- Performance/device measurements and note delivery remain future work.
  Cross-venue movement requires a separate bridge, not index comparison.
