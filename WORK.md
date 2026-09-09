# Current work

Updated: 2026-09-09

## Goal

Demonstrate full-block Ergo transaction-root verification in a reproducible
offline probe on `feat/ergo-block-commitment-probe`. Acceptance: retained real
block fixtures reproduce transaction IDs and version-specific witness roots;
omissions, reordering and committed-field mutations fail. Pin upstream algorithms and capture
parser limitations before choosing an authenticated complete-range reader.
This is source feasibility evidence, not a new venue profile or runtime API;
header consensus, finality and untrusted transaction parsing remain gates.
Companion specification main `7ea0ee8` is unchanged in this experimental slice.

## Status

- Independent adversarial review found no unresolved material findings and
  reproduced the exact retained report. Full project checks and a clean
  experiment install pass. Commit/merge/push and CI readback remain.
- Independent dependency review places authenticated range-source feasibility
  (A8/A9) before replay/configuration and certificate packaging. Raw outputs
  cannot acquire held-commitment status or publication force from root checks.
- Decision: [range source before packaging](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging).
  Integration order: [recovery map](docs/POOL_V3_RECOVERY_MAP.md).
- Prior served-trail implementation `8833e07` and specification `7ea0ee8`
  are merged/pushed. Main handoff `a9fb874` passes all seven
  [CI jobs](https://github.com/mediumofexchange/reference-ts/actions/runs/34390115096).
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Complete certificate dependencies, configuration and adoption remain open.

## Evidence

- `npm run check:ergo:range`: 342 assertions; all 24 transaction IDs and
  three roots match pinned fixtures, covering 65 outputs and versions 1/3/3.
  Raw fixture JSON: 138,228 bytes; signed transactions: 14,450 bytes.
  [Report](docs/ergo-range-verification.json) records source and input hashes.
- Fleet 0.11.0 decodes 11/24 transactions; all three blocks contain valid
  scripts it cannot parse. JSON field-boundary aliases preserve transaction
  bytes while changing claimed output fields. Short reads can pass EOF.
  The probe decodes only hash-pinned fixtures and is not an untrusted API.
- Baseline: Ergo v6.1.5, sigma-state v6.0.6, scrypto v3.1.1 and exact Fleet
  source revisions; matches the existing publication probe's node baseline.
- Current full `npm run check`: 96 files / 1,795 tests plus typecheck, build,
  installed-package consumer, pilot, crash probes and ten spent-set groups.
  The sandbox run failed at esbuild's parent-directory read; the unchanged
  approved run outside the sandbox passed. Final docs and links also pass.
- Existing v3 real-proof evidence remains 304 checks / 18 proofs of 14,656
  bytes, all 81 public scalars and hostile controls. [Report](docs/pool-v3-conformance-verification.json).
  These are synthetic-domain observations, not approved configuration pins.

## Next

1. Complete the required checks; deliver the independently reviewed probe under
   standing merge/push authority and read back remote parity and CI.
2. Evaluate a pinned maintained full transaction decoder or local validating
   node boundary. Acceptance: all fixture outputs reproduce their IDs; hostile
   bytes cannot yield substituted fields or exceed explicit reader budgets.
3. Build authenticated contiguous-range reads and stable publication order,
   then replay/import/adoption, complete openings and certificate dependencies.
   Missing or unsupported evidence remains unresolved.
4. Fix final configuration/artifact pins in `pool-v3.md`, then implement one
   v3 runtime/recovery path and wallet; repeat all six real-proof relations
   on the final configuration domain.

## Open questions

- About 45% done / 55% remaining, plausible done range 35–55%. The source
  experiment reduces uncertainty but closes no runtime/product gate. Largest
  blocks: complete evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated complete-range reads, witness publication and custody assurance.
- A8/A9 remain open: fixtures are noncontiguous and their headers were not
  independently authenticated. Version 1 roots do not authenticate witnesses.
  Raw output discovery supplies no held commitment or publication force.
- Proof rejection is backend evidence, not general nonmalleability or presenter
  participation. Rollback, finality, setup/build provenance, phone budgets and
  publication remain gates. Resource failure is never exclusion.
- Protocol deployment, releases, access changes and funds remain unauthorized.
  The private experiment has a separate pinned install; no root dependency
  tree or disposable repository copies are added. This slice's scratch source
  downloads and duplicate fixtures were removed after evidence and review.
