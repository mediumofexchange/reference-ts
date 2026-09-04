# Current work

Updated: 2026-09-04

This file is the operational handoff. Replace stale status; do not append a session diary or durable design rationale here.

## Goal

Whole-project review for practicality, simplicity and security is complete.
Choose the next implementation slice from its findings; no redesign was selected.

## Status

- Review branch: `review/project-practicality-2026-09-04`, from `b384a07`.
- Slice 39 remains merged and verified on `main`.
- Review: [docs/PROJECT_REVIEW_2026-09-04.md](docs/PROJECT_REVIEW_2026-09-04.md).
- Specification reviewed at companion `money-from-first-principles` main
  `e3dfeb7`; no specification branch or behavioral changes in this review.
- All four local main heads matched live GitHub at review start.
- One security-review subtask's final turn was stopped by an automated content
  filter. Earlier findings are recorded; this is not a completed audit.

## Evidence

- `npm run check`: passed docs, typecheck, 48 test files / 962 tests, and build.
- `npm pack --dry-run`: passed; `npm audit --json`: zero known vulnerabilities.
- Independent Ergo overlap probe, rerun by the primary reviewer: an older
  refresh overwrites a newer commitment while retaining its clock, falsely
  changing `isSilent` from false to true. Reproducer is in the review appendix.
- Public npm query for `@mediumofexchange/reference` returned E404 despite
  advertised installation commands.

## Next

1. Fix cached backing identity at signature/ledger boundaries and overlapping
   Ergo refreshes; include mutable Ergo results in the boundary review.
2. Execute the existing compact commitment framing decision before persistence
   makes the layout a compatibility burden. Spec first; independent review.
3. Build a durable transparent pilot: two clients, operator, independent payment
   verification, witness publication, crash/restart and idempotent retries.
4. Correct public installation/status docs and add a package-consumer test.

## Open questions

- Per-backing checkpoints could replace costly cross-backing evidence. Compact
  proofs alone do not establish continuity or data availability; see review.
- Durable highest-signed sequence, receipts, publication outbox and writer
  fencing are required before real operation. Venue lag cannot recover facts
  about signatures the venue never observed.
- Clarify prevention versus detectable fault versus recovery in C4; extract
  C2's explicit transition specification before extending it further.
- The platform Ed25519 verifier remains recommended only after demonstrating
  equivalent acceptance/rejection semantics; it is not the main deployment gap.

## Improvement opportunities

- Keep unresolved security findings visible until disposition, rather than only
  in monthly decision logs. The review gives priorities, scope and fix directions.
- Pin specification revisions and name the implemented transparent profile.
- Use a built-package, multi-process acceptance scenario to guide coherent
  slices; retain independent adversarial review for critical changes.

## Relevant decisions

- `DECISIONS.md`: Slice 39 verification — exact sequence reads and pending receipts.
- `DECISIONS.md`: Four recommendations decided — platform verifier and root framing next.
