# Current work

Updated: 2026-09-05

## Goal

A finished, working protocol whose claim layer is Construction's shielded pool
(§C1.2), built in this order: specification → executable adversarial model of
§C2/§C2b/§C3 over notes → the pool's claim layer → sequencing, recovery and
presentation over notes → wallet → witness venue write side. No release
deadline; each step is done when its rule, its model check and its adversarial
tests agree.

## Status

- The 2026-09-05 meta review is applied: decision "The finished protocol: the
  shielded pool is the core, the lit settings are profiles, and C2 is
  re-derived against the directory" (`DECISIONS.md`).
- Implementation branch `chore/pooled-core-scope`, on top of
  `research/private-payment-architecture` → `feat/durable-transparent-pilot`
  → `review/project-practicality-2026-09-04`. All local, unmerged.
- Companion specification branch `spec/pooled-core` at `8d5055e`, on top of
  `spec/private-payment-architecture` → `spec/durable-transparent-pilot`.
  The README pins `8d5055e`. Merge order when authorized: spec first, then
  reference-ts, then `site` and `orgprofile` (`docs/durable-pilot`).
- The transparent path is frozen (banner at each module head); `ergo.ts` is
  no longer exported from the root barrel; the pilot is a harness; the
  experiment stays until the layouts are pinned.
- Decision log: 15 session/round entries archived to `decisions/archive/`;
  66 decisions indexed. `docs/PROJECT_REVIEW_2026-09-04.md` removed; its
  findings live in `docs/PRODUCTION_REQUIREMENTS.md`.
- No push, merge, publication or PR authorized.

## Evidence

- `npm run check` on Node 24.6.0 (2026-09-05): docs OK, typecheck, 50 files /
  1000 tests, build, installed-package consumer, pilot crash scenario.
- `npm run check:privacy`: 9 real proofs, 38 named checks, 8 journal tests;
  572 MiB peak RSS.
- Markdown links and anchors checked across both repositories
  (`scratch/check-links.mjs`, disposable).
- Construction §C2 rewritten as numbered rules; every guarantee recorded in
  decisions 2026-08-29 … 2026-09-04 maps to a rule or is retired in the
  Appendix with its cost.

## Next

1. **Spec slice:** pin the pool's concrete statement layouts, hash functions,
   spent-set accumulator with non-membership, multi-input shape, and what
   **E** declares (§C1.2–C1.4), from `experiments/private-payment/RESEARCH.md`.
   Clear §C0a; independent adversarial review (statement layouts are
   parser- and circuit-sensitive).
2. **Adversarial model:** executable model of §C2, §C2b and §C3 over notes —
   two operators, two backings, a holder, delayed and dropped publications,
   replacement, restart, incomplete views; safety and progress checked
   separately; counterexamples kept as regression vectors.
3. **Pool claim layer** in `src/`, promoting the experiment's circuits to the
   normative layouts; then rules over notes, porting cases from the frozen
   suite as each lands.

## Open questions

- Review still owed: the C2 re-derivation against the directory (C2.4.5,
  C2.7) was written by one author; it is protocol-sensitive and needs an
  independent adversarial read before code depends on it.
- Spent-set accumulator choice and its proof cost on a phone.
- Flat directory or tree with logarithmic proofs in the pool profile (§C0b
  leaves it to the profile).
- Proof backend and setup provenance are provisional (Noir/Barretenberg
  pinned in the experiment; Halo2/snarkjs remain alternatives).
- Branches `feat/durable-transparent-pilot` and
  `review/project-practicality-2026-09-04` are ancestors of the work branch;
  delete after merge. Remote merged branches need the maintainer's push.
