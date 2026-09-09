# Current work

Updated: 2026-09-09

## Goal

Next: build and prove all six successor relations together from the audited
proposal before freezing v3. Acceptance: delivery-bearing issue/burn,
four-output spend, corrected demand/request, exact public-input orders and
full binding/range/hostile tests, including equal-count spend/burn cross-key
rejection. Review and commit the normative layouts/configuration identities
before dependent retained code. Runtime integration follows that gate.

## Status

- Audit slice: `docs/pool-v3-conformance-audit`, base `8deadf5`. The
  [recovery map §2.6](docs/POOL_V3_RECOVERY_MAP.md#26-contract-to-constraint-audit)
  now owns the six-relation layout proposal, constraint inventory and exact
  remaining proof/runtime gates. Independent review found no material
  blockers after inspecting the actual probes, results and source hashes.
- Companion specification is unchanged on `main` at `923ee46`; no companion
  branch or new normative decision was needed for this audit. When pinning
  final v3 layouts, create and name companion branches here first.
- Scratch corrections enforce demand's zero padding anchor and add request's
  public `u64 refresh`. The shared helper/settlement retain the intentionally
  free padding anchor. Retained changes are documentation/evidence only;
  production source, v2 circuits/keys/configuration and runtime are unchanged.
- Runtime is v2, refuses silence clauses and exports no pool wallet. A22
  compressed roots, F3 delivery, F4 ordinary fee outputs and C3.3a presentment
  attribution remain selected contracts/candidate or model evidence.

## Evidence

- Original P1 rerun: 47 checks / 5 real proofs pass, including the obsolete
  nonzero padding anchor and six-input request. Do not pin those sources.
- Corrected scratch run: 62 checks / 6 real proofs pass; demand/settle/request
  counts 16/17/7, proofs 14,656 bytes. Focused cases reject nonzero padding
  anchors in both positions and reusing proofs with independently valid
  notice/refresh alternatives. Unchanged-ACIR tests establish range guards
  for segment/presenter limbs, instant/deadline and refresh. Every public
  input mutation rejects. [Observed identities and limits](docs/pool-v3-conformance-verification.json).
- Read-only issue/spend/burn inventory identifies absent D-bearing issue/burn
  evidence, F4's untested prefix binding and the untested 15-input spend/burn
  cross-key case. P1's count-filtered cross-key loop runs zero comparisons.
- `npm run check:docs`, companion link checks and `git diff --check` pass.
  No retained executable code changed, so prior runtime/real-proof evidence
  carries forward. Delivered base `8deadf5` GitHub CI passed; final audit CI
  must be inspected after push.
- Independent reviewer checked report/result correspondence and source/helper
  preservation; it did not rerun proving. Audit scratch copies were removed
  after capture; §2.6 records the corrections to the retained original P1.

## Next

1. Inspect GitHub CI for this audit's delivered main revision. No runtime
   merge gate is waived by this audit.
2. Generate one scratch six-relation build from §2.6, incorporating delivery
   on issue/burn and all four spend outputs. Repeat final proof binding on
   every input and range controls below the ABI encoder. Prove both equal-
   count cross-key substitutions fail. Keep hostile fixtures otherwise valid.
3. Review/commit `pool-v3.md` with source/helper/toolchain/bytecode/key and
   configuration identities together; port evidence into retained tests only
   after that specification commit. Then implement v3 runtime/recovery/wallet.

## Open questions

- About 44% done / 56% remaining, plausible done range 34-54%. This audit
  removes conformance uncertainty but closes no runtime/product gate. Largest
  work: v3 circuits/runtime, wallet/transport, authenticated complete-range
  reads, witness publication, custody and deployment assurance.
- Real proof mutation tests are selected-backend evidence, not a general
  nonmalleability proof or proof of presenter-key participation. Real holders
  can still make dishonest in-kind allegations; public outcomes do not prove
  external non-payment.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  evidence remains unresolved, never zero balance or an older current state.
- Copied journals, rollback, same-index venue order, setup/build provenance,
  phone budgets and actual publication acceptance remain release gates.
- Retain existing Ergo/pool-v3 probes and parameter caches. No release,
  deployment, access-control change or real funds are authorized.
