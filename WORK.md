# Current work

Updated: 2026-09-04

This file is the operational handoff. Replace stale status; do not append a session diary or durable design rationale here.

## Goal

No protocol slice is currently active. Slice 39 (the blind window) is complete; begin the next security improvement from updated `main` in a new coherent branch.

## Status

- Slice 39 and its companion specification are reviewed, verified, and merged into `main` on 2026-09-04.
- The shared Claude/Codex workflow and cross-platform build command are also on `main`.
- The final verification added an exact commitment-sequence read so two commitments witnessed at one index cannot make a final receipt appear lapsed.
- There is no known blocking finding against slice 39.

## Evidence

- `npm run check`: passed, including documentation checks, typecheck, all 48 test files / 962 tests, and the package build.
- Focused venue, era, blind-window, receipt, fault, and refusal run: 6 files / 166 tests passed.
- The independent slice-39 verification probes were rerun against current source. Every kept sequence resolves to its exact witnessed index, including six commitments sharing one index.
- `v2-cheap-park.mjs` confirms the remaining indistinguishability: a sequence the record truly skipped lapses, whether its signed commitment was dropped or withheld. Such a receipt was pending, never final.

## Next

1. Fetch `main`, create a new branch, and confirm this handoff is still current.
2. Take one of the security recommendations already recorded on 2026-09-03: the platform Ed25519 verifier or commitment-root framing. Prefer the smaller coherent slice after inspecting both.
3. Update this file when that slice starts, naming its goal, branch, evidence, and next action.

## Open questions

- A future holes-per-commitment grade could make deliberate sequence gaps publicly costly; it is policy visibility, not a slice-39 correctness dependency.
- The Ergo write side remains where durable operator sequence state ultimately belongs.

## Improvement opportunities

- Build future verification probes through a small relative-path harness instead of copying repositories and dependency trees into scratch.
- Keep final review evidence concise and tracked; leave executable probes in ignored scratch rather than recording session handoffs in the decision log.
- Git push authentication works. GitHub CLI authentication should be repaired only when PR-specific automation is needed.

## Relevant decisions

- `DECISIONS.md`: Slice 39 verification — exact sequence reads and pending receipts.
- `DECISIONS.md`: Four recommendations decided — platform verifier and root framing next.
