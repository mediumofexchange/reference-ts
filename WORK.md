# Current work

Updated: 2026-09-09

## Goal

Completed repository presentation cleanup at `eea69bd` on `main`, with
companion specification commit `01387a4` on `main`: concise entry points, neutral
decision records and preserved technical evidence. Website README commit `326a3f6`
is merged/pushed to `main`; its authorized GitHub Pages deployment succeeded.
The protocol continuation below remains the next implementation task.

Completed portable v3 fault-evidence records on reference
`feat/pool-v3-fault-evidence` and companion `spec/pool-v3-fault-evidence`.
Acceptance: exact target statement/proof/authorization fields and their
consecutive evidence suffix authenticate against an expected signed-directory
snapshot, including committed invalid bytes; substitutions and false contexts
fail. Bound parsing before payload allocation/hashing, retain byte ownership,
and keep local resource refusal distinct from operator fault. This proves
neither complete-opening state nor an exclusion verdict.

## Status

- Specification `322bcae` passed fresh independent normative review, was
  committed before dependent code, and is merged/pushed to `main` with clean
  status and remote parity. Pool-v3 §9 now fixes this evidence-opening frame.
- `model/pool-v3-fault-evidence.ts` implements encoding, preflight decoding
  and evidence verification outside the runtime. Explicit suffix budgets
  fail with `FaultEvidenceLimitError`; malformed data fails encoding/decoding
  or returns false from verification. Neither outcome classifies a checkpoint.
- Each raw target field is at most 131072 bytes; valid statement/proof/auth
  bounds are unchanged. Cost is 250 fixed bytes plus target bytes and 96 per
  later event. No new protocol suffix cap is introduced; budgets are local.
- All 10 focused hostile tests and typecheck pass. Fresh independent code
  review found no material issues and independently passed all ten tests.
  Full project checks pass. Implementation `0d2464e` is merged to `main`;
  the delivery handoff `d2edf1b` passes all seven
  [CI jobs](https://github.com/mediumofexchange/reference-ts/actions/runs/34383194240).
- Prior header delivery `a23d8c9` / handoff `edbb5b1` passes all seven
  [CI jobs](https://github.com/mediumofexchange/reference-ts/actions/runs/34380754806),
  including Node 20/24 Linux, Node 24 Windows and both platforms' real proofs.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Configuration, complete trails, certificate dependencies and adoption are
  not supplied by this evidence record. Missing dependencies stay unresolved.
- Decision: [exact target bytes](decisions/2026-09.md#2026-09-09--carry-exact-target-bytes-in-fault-evidence).
  Integration order and assumptions: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).

## Evidence

- Presentation: docs/index checks pass (88 decisions), links across 46 Markdown
  files pass, and 22 cross-repository links resolve against files/pinned Git objects.
  Focused history review preserved uncertainty, review limits and pending statuses.
  Presentation `eea69bd` passes [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/34385966935).
- Specification review checked raw-vs-strict framing, empty-field hashes,
  exact 250+fields+96*(n-i) size, context/position checks, external expectations,
  local budgets and the distinction between authentication and exclusion.
- The focused suite covers independent bytes/hashes, signed directories,
  malformed committed targets, seed/context/suffix substitutions, all
  truncations, raw-field/u64 boundaries, explicit resource refusals, sparse
  inputs and Buffer ownership. A 65,537-entry suffix authenticates under its
  exact reader budget; no unreviewed fixed suffix cap is introduced.
- Full `npm run check` passes: 95 files / 1,785 tests, typecheck, build,
  installed-package consumer, pilot, pool-store crash probes and ten spent-set
  groups. No runtime, circuit, relation, key or configuration change.
- Existing v3 real-proof evidence remains 304 checks / 18 proofs of 14,656
  bytes, all 81 public scalars and hostile controls. [Report](docs/pool-v3-conformance-verification.json).
  These are synthetic-domain observations, not approved configuration pins.
- Specification links and diff checks pass. Both repositories report no
  effective main rules; no protections or access controls were changed.

## Next

1. Check CI for this handoff update; presentation and runtime CI are verified above.
2. Define served-trail framing and complete certificate dependency evidence,
   then complete-opening verification. Name companion branches first.
   Acceptance: a signed directory authenticates a complete bounded opening,
   missing dependencies remain unresolved, and substitutions fail. Neither
   header nor portable fault-evidence conformance fulfills that acceptance.
3. Fix replay/import/adoption order and final configuration/artifact pins in
   `pool-v3.md`, then implement one v3 runtime/recovery path and wallet;
   repeat the six real-proof relations on the final configuration domain.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. Evidence
  formats reduce integration work but close no runtime/product gate. Largest
  work: complete evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- A8: no selected authenticated complete-range Ergo source. Missing required
  evidence remains unresolved, never zero balance or an older current state.
- Proof-mutation rejection is backend evidence, not a general nonmalleability
  proof or presenter participation. Parsing establishes no authority, demand
  standing or force. Copied journals, rollback, same-index venue order,
  setup/build provenance, phone budgets and publication remain gates.
- Larger malformed target fields and faults requiring capsule or other
  omitted dependency evidence are outside this record's coverage. Resource
  failure is never exclusion. Protocol deployment, releases, access changes and
  funds remain unauthorized. Existing probes/caches remain; no new dependency trees or
  disposable repository copies were created.
