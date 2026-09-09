# Current work

Updated: 2026-09-09

## Goal

Next: resolve C3 presentment attribution before the final v3 layouts,
circuit identities and configuration domain. Acceptance: reconcile signed
attributable Construction presentment with the pool's unsigned demand and
fresh presenter key; independently review the smallest choice, commit its
specification before dependent code, update affected evidence and deliver.

## Status

- A22 is merged/pushed to main at `c955798`, from `feat/pool-spent-radix`
  (base `fcf532c`); remote parity and clean worktrees were verified.
  Companion `spec/pool-spent-radix` is merged/pushed to main
  at `78f8a8c`, after independent normative review and before retained code.
- Selected canonical compressed binary roots: full-key leaves, absolute
  first-differing-bit branches, no unary nodes or insertion-assigned positions.
  Same validated set means same root; each insert hashes at most one leaf
  plus 256 branches. Non-membership capability remains; no published proof
  encoding/parser is selected. See the
  [decision](decisions/2026-09.md#2026-09-09--spent-roots-use-a-canonical-compressed-binary-tree).
- `scripts/pool/spent-set/` retains the candidate and independent batch
  oracle outside the runtime. `check:pool:spent` is in the ordinary check/CI;
  `bench:pool:spent` regenerates the pinned-source comparison in scratch.
- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  No pinned v2 root, circuit, configuration, key or runtime source changes.
- F4 is merged/pushed at `fcf532c`, with exact-revision GitHub CI success;
  companion specification `37cbd40`. F3 is merged at `17a9f1e`.

## Evidence

- Ten A22 check groups pass: independent prefix roots, permutations/import
  grouping, all bit positions and worst-depth keys, absent-key paths, field
  boundaries, duplicates, malformed arrays and aliasing. Full statement/import
  validation and atomic updates remain v3 integration obligations.
- Final 100k-key replay: v2 157.29 s, candidate 15.80 s, 9.96x;
  1,649,737 candidate hashes (16.50/insert). Both read root after every insert.
  [Report](docs/pool-spent-verification.json) pins the retained sources.
  Independent final readback verified report equality, source pins and
  arithmetic; no unresolved material finding remains.
- Final `npm run check` passes: 90 files / 1,686 tests, package, pilot,
  pool-store crashes and ten A22 groups. Initial sandbox Vitest loading was
  blocked; the complete check passed with the required filesystem access.
  Cross-repository links and final documentation checks pass.
  Unchanged v2/F3/F4 real-proof evidence is retained; no circuit/config changes.

## Next

1. Check GitHub CI for the delivered main revision; local checks passed.
2. Resolve signed-attributable Construction C3 presentment versus unsigned
   pool demand/fresh presenter key, then close v3 layouts/circuit identities.
3. Build the v3 runtime/recovery path and pool wallet against those contracts.

## Open questions

- About 44% done / 56% remaining, plausible done range 34–54%. Largest work:
  v3 circuits/runtime, wallet/transport, authenticated complete-range reads,
  witness publication, custody and deployment assurance. A22 is accumulator
  feasibility, not an end-to-end replay or device-budget result.
- A8: no selected authenticated complete-range source for Ergo. Missing full
  evidence is unresolved, never zero balance or an older current state.
- Fee payees learn their opening/statement association; same-backing fees
  reveal payment backing. Private prices cannot cure unpaid counted requests.
- Copied journals, rollback, same-index venue order, setup/build provenance,
  phone budgets and real publication acceptance remain release gates.
- Retain existing Ergo/pool-v3 probes and parameter caches. No release,
  deployment, access-control change or real funds are authorized.
