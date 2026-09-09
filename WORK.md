# Current work

Updated: 2026-09-09

## Goal

Delivered canonical served-trail transport and local evidence authentication
at reference `8833e07` and companion specification `7ea0ee8`, both merged/pushed
to `main` with verified remote parity. Branches: `feat/pool-v3-served-trail`
and `spec/pool-v3-served-trail`.
Acceptance: bounded framing carries the header, every scoped term/signature
and exact ordered records; local event evidence authenticates against an
externally authenticated snapshot. Substitutions/truncation fail; resource
refusal stays distinct. This is a prerequisite to complete opening verification,
not a claim that terms, imports, record ranges or state have been verified.
The independently reviewed specification was committed before dependent code.

## Status

- Both repositories entered clean; upstream fetches show no new changes.
  Reference main `c5cf164` passes [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/34386666427).
  Companion main is `01387a4`. Repository presentation work is delivered.
- Specification `7ea0ee8` composes existing headers, scoped terms/signatures and
  raw record bytes. Independent normative review found no material blocker;
  the specification was committed before code and is merged/pushed to main.
- `model/pool-v3-trail.ts` implements bounded outer framing and local event
  authentication. Ten independently authored hostile tests and typecheck pass.
  Fresh independent review found no unresolved material findings and passed
  five related suites / 96 tests. Full project checks pass; implementation
  `8833e07` is merged/pushed. The final delivery handoff needs its CI readback.
- Decision: [served trails](decisions/2026-09.md#2026-09-09--frame-served-trails-without-granting-opening-validity).
  Integration order: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).
- Prior fault-evidence specification `322bcae` and implementation `0d2464e`
  are merged/pushed; handoff `d2edf1b` passes all seven
  [CI jobs](https://github.com/mediumofexchange/reference-ts/actions/runs/34383194240).
  Header specification `061f87e` and implementation `a23d8c9` are delivered.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Complete certificate dependencies, configuration and adoption remain open.

## Evidence

- Specification links pass across all 15 Markdown files; both new distinct
  pinned links resolve against the committed Git object. Reference docs pass.
- Current full `npm run check`: 96 files / 1,795 tests, typecheck, build,
  installed-package consumer, pilot, pool-store crash probes and ten spent-set
  groups. Independent adversarial review is complete with no material findings.
  The initial sandbox run failed before tests at esbuild configuration loading;
  the unchanged approved run outside the restricted sandbox passed.
- Existing v3 real-proof evidence remains 304 checks / 18 proofs of 14,656
  bytes, all 81 public scalars and hostile controls. [Report](docs/pool-v3-conformance-verification.json).
  These are synthetic-domain observations, not approved configuration pins.
- Prior fault-evidence tests authenticate exact malformed bytes, all positions,
  independent hash/byte oracles, real signed directories and buffer ownership.
  A 65,537-entry suffix authenticates under an exact local reader budget.
  This neither proves a complete opening nor classifies a checkpoint.

## Next

1. Read CI for the latest main handoff; implementation local checks pass.
   Both repositories have no effective main rules or branch protection;
   no safeguards changed.
2. Define complete certificate dependency framing, then complete-opening
   verification: a signed directory authenticates a complete bounded opening,
   missing dependencies remain unresolved and substitutions fail.
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
- Malformed fields beyond transport bounds need other evidence. Resource
  failure is never exclusion. Protocol deployment, releases, access changes
  and funds remain unauthorized. Existing probes/caches remain; no new
  dependency trees or disposable repository copies were created.
