# Current work

Updated: 2026-09-09

## Goal

Next A22: select a set-determined spent-set shape before v3 freezes its roots.
Acceptance: compare the current trie with a canonical compressed sparse/radix
candidate; identical roots across insertion/import orders, efficient updates
per statement, hostile key/boundary cases, measured replay cost, independent
review, specification committed before dependent code, checks and delivery.
Do not use an insertion-ordered indexed tree or a full sorted-set hash that
costs O(N) at every statement. Preserve the pinned v2 representation.

## Status

- F4 is reviewed and verified on `feat/pool-fee-shape` (base `17a9f1e`),
  for integration into main. The latest F4 commit carries the retained probe,
  source-pinned report and Linux/Windows CI integration.
- Companion `spec/pool-fee-shape` is merged/pushed to main at `37cbd40`;
  normative selection and review preceded retained probe code.
- F4 selects two inputs/four ordinary outputs. Payment/change in A and
  fee/change in B fit one statement; same-backing or sponsored flows pad
  unused positions with distinct payer-owned zero notes and F3 capsules.
- No fee kind, privileged debit or protocol price schedule. Exact retry,
  local pending roots, finality, lapse and recovery treat fees ordinarily.
  A fee quote cannot change public validity, counted requests or remedies.
- F3 is merged at `17a9f1e`: receiver-prepared exact outputs, 89-byte capsules
  and two public digest limbs. Notes and nullifiers stay unchanged.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  No pinned v2 circuit, configuration or key changes in this candidate slice.

## Evidence

- F4 `npm run check:pool:fees` passes: 17 positive checks, 35 rejections,
  five verified proofs, all 14,656 bytes. The
  [report](docs/pool-fees-verification.json) pins the retained source hashes.
  Selected fee/change: 4.22 s proving, 92 ms verification on this desktop.
- Gates: v2 19,034; F3 2x2 19,050; 2x3 19,256; selected 2x4 19,465.
  All use subgroup 32,768. Four adds 209 gates and 121 record bytes over
  three, plus one leaf/scan trial on every spend, including padding.
- Independent adversarial review resolved pending-fee semantics, fee-payee
  privacy, unpaid requests and isolated extra-output/range witnesses.
- Final `npm run check` passes: 90 files / 1,686 tests, package, pilot and
  store crashes. Final retained sources/report passed independent readback.
  F3: 22 host checks and real digest binding; 153 v2 checks / 24 real proofs.
  GitHub Actions supplies the exact delivery revision's CI result.

## Next

1. Take A22 from the
   [recovery map](docs/POOL_V3_RECOVERY_MAP.md#8-unresolved-assumptions-and-choices).
   Compare shapes against set-determined roots and per-statement updates;
   record reproducible measurements rather than optimizing hash code again.
2. Resolve signed-attributable C3 presentment wording versus unsigned pool
   demand/fresh presenter key, then close v3 layouts/circuit identities.
3. Build the v3 runtime/recovery path and pool wallet against those contracts.

## Open questions

- About 44% done / 56% remaining, plausible done range 34–54%. Largest work:
  v3 circuits/runtime, wallet/transport, authenticated complete-range reads,
  witness publication, custody and deployment assurance.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  evidence is unresolved, never zero balance or an older current state.
- A22: spent roots must remain set-determined and recomputable per statement.
- Fee payees learn their opening/statement association; same-backing fees
  reveal payment backing. Sponsored service avoids direct-fee disclosure.
  Private pricing cannot cure unpaid counted-request grief.
- Copied journals, rollback, same-index venue order, setup/build provenance,
  phone budgets and real publication acceptance remain release gates.
- Retain existing Ergo/pool-v3 probes and parameter caches. No release,
  deployment, access-control change or real funds are authorized.
