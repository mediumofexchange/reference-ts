# Current work

Updated: 2026-09-07

## Goal

Build the shielded-pool protocol: specification → adversarial model → claim
layer → sequencing/recovery/presentation → wallet → witness write side.
This slice specified and modelled pool-v2 §7.4's excluded objects —
presentation, the non-service count, snapshot redemption at the venue and
the return from silence — before any implementation. The recovery policy
(C2b.3a–c) was approved on 2026-09-07 and is not reopened.

## Status

- Implementation branch: `feat/pool-recovery-model`, base `6e99772` (main).
- Companion specification: `spec/pool-recovery-contract` at `3676757`
  (`820cd51` before review), base `dcce2dc` (main). `pool-recovery.md`
  defines C3.1–8, C2b.5.1–2, C2b.6.1, C2b.3.1–3 and C2b.4.1–2 for
  `moe/pool/v3`; Construction §C2b/§C3, pool-v2 §7.4, the spec AGENTS and
  README point to it. v2 bytes are unchanged.
- `model/pool-recovery.ts` (`RecoveryWorld` over the authority model): the
  no-commitment clock, the snapshot, the adoption index, the recovery state,
  force at the venue, the adopted block, the return, the count, and
  `recoveryViolations` (holdings equal supply, a note settles once and is
  never spent again, every settlement pays the backer under K's acceptance).
- `model/pool-authority.ts` gained the demand, withdraw, settle and request
  kinds, `tagOf`, the pending-lock set and standing demands in `State`,
  `Service.adopt`, and the hooks `adoptable`, `passedByRule` (used by
  `include` and descent alike), `replayed`, `serving` and `discardable`.
- 29 new cases in `model/pool-recovery.test.ts`, with counterexamples under
  eleven departures: `ignoreAcceptance`, `countUnproven`, `resetOnHandover`,
  `lapsedClosesGap`, `anyAnchor`, `bareNullifiers`, `forceOutsideGap`,
  `settleTwice`, `skipSameIndex`, `serveBeforeAdoption`, `continueThroughGap`;
  six of them exercise the review's findings (label binding, the lock's
  bound, the instant window, one clause per scope, a drop, adoption at the
  publication's own index).
- The decision entry (2026-09-07, contract) lists the choices made under the
  maintainer's "continue … merge and push" authority and not individually
  confirmed: whole-note demands by tag, the lit settlement with a public
  owner, no attempt timeout with the lock bounded by the demand's deadline,
  the segment-free request, the instant window, one no-commitment duration
  per scope, force once at the publication's own index, the return as a new
  segment, the adoption index, and invalid live evidence blocking recovery
  and the count as it blocks descent.
- No `src/` change. PoolStore still refuses silence clauses; the runtime is
  v2 and carries none of these objects.

## Evidence

- `npx vitest run model/`: 4 files / 130 tests passed (89 before this slice,
  8 boundary cases, 29 contract cases, plus schedule).
- `npm run typecheck` clean; spec links pass across both repositories.
- Full `npm run check` on Node 24.6 after the review fixes: 76 files / 1,498
  tests, docs, typecheck, build, installed package, payment pilot and
  pool-store crash checks passed; `git diff --check` clean.
- Independent adversarial review (one bounded, read-only reviewer lane over
  the contract, the model and the tests) returned twelve findings, two high
  soundness holes among them; all twelve are adopted in spec `3676757` and
  in the model and tests. Dispositions are in the decision entry. The
  review certifies no circuit, byte layout or implementation.
- The pending slice merged before this one: `6e99772` on main after a full
  `npm run check` (76 files / 1,469 tests) on 2026-09-07.

## Next

1. Byte layouts for `moe/pool/v3` in a new `pool-v3.md`: `T_TAG`, the holding
   proof (both forms), the settle statement and its public-input order,
   statement kinds 4–6 in the history and receipt, the five publication
   frames and their identities, the adoption block in replay, and what **E**'s
   clause fields bind. Circuits follow from the pinned v2 sources.
2. Implement over `src/pool/` rule by rule with the model as oracle: locks in
   `Segment` admission and replay, the request and count reader, the gap
   reader over the venue record, `PoolStore` adoption on return (lifting the
   silence-clause refusal), then wallet-side presentation and re-proof.
3. Port the frozen transparent cases (`c2b-redemption-legs`, `c2b-return-
   from-silence`, `c2b-non-service`, `c3-*`) as each rule lands over notes.

## Open questions

- Whether the maintainer confirms the choices above, in particular whole-note
  demands and the always-new-segment return.
- What remedy a backing has against an operator whose last carrying
  checkpoint is provably invalid: it blocks recovery, the count and any
  successor's descent alike (C2.10.3), and neither contract defines a way
  past it beyond the fault proof and E's replacement rule.
- SQLite ownership assumes one journal per operator key on its venue. Copied
  keys/databases and coordinated backup rollback need custody/backup procedures.
- Scope authority assumes a complete, stable venue snapshot; same-index mutation
  during synchronous custom adapter callbacks has no generation token.
- Profile large histories before compaction or immutable read caches.
- Full C2 re-derivation, authenticated setup/build provenance, target measurements,
  note delivery and transitive history availability remain release requirements.
