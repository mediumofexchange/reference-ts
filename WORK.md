# Current work

Updated: 2026-09-10

## Goal

Verified slice: compare fixed `DETACHED_PROCESS` and `CREATE_NO_WINDOW` launches
on `test/windows-detached-containment`, based on `53ff092`. Preserve identical
256 MiB, process, CPU, output and wall budgets, suspended creation-time job
assignment and whole-job cleanup. Acceptance: retain both launch reports,
identify helper/accounting differences, preserve all resource failures, pass
focused regressions and `npm run check`, obtain independent adversarial review,
then merge/push. No hostile parser cases or runtime adoption in this slice.
No specification change; companion `money-from-first-principles` remains
`main` at `7ea0ee8`.

## Status

- Baseline CI [34402013200](https://github.com/mediumofexchange/reference-ts/actions/runs/34402013200)
  passed at `53ff092`; upstream main is unchanged. Main has no branch
  protection or rulesets. No safeguards changed.
- Both final launch reports return exit 2. Detached samples only Node, with
  job/process/private peaks agreeing and the growing-memory peak below 256 MiB.
  No-window still samples Node plus `conhost.exe` and exceeds job memory.
  Both CPU controls exceed their one-second threshold on quota exits.
  Hard containment remains FAILED. See the
  [analysis](docs/POOL_DEPLOYMENT_PROBES.md#windows-process-containment-feasibility).

## Evidence

- Fixed launch selection records exact mode/flags; uppercase input is normalized.
  Worker-free resource regressions pass (8 cases). Detached startup exits 0
  as a diagnostic only. Independent code review and final report/hash,
  resource-predicate and numeric-claim readback found no material defect.
- Full `npm run check` passed: 96 files / 1,795 tests, build, installed package,
  pilot, crash and spent-set checks. The known esbuild parent-directory denial
  required running outside the sandbox. Final docs and companion links pass.
- Final controls ran sequentially after checks: no-window then `DETACHED`.
  Both reports recover 14,874 assertions / 24 transactions / 65 outputs;
  all 16 jobs clean up. Both reports' six source hashes match working/index
  bytes and budgets are identical. No-window growing-memory job peak is
  273,985,536 bytes; detached is 267,730,944 (limit 268,435,456).
  CPU target/final job seconds are 1.1875/1.203125 and 5.859375/5.859375.
  Earlier failed reports remain linked at immutable revisions.

## Next

1. Finish authorized delivery and record remote parity/latest CI. Local checks,
   independent review and source-hash verification passed.
2. Choose a justified resource contract and mechanism for bounded decoder
   computation and memory. Compare metered execution with OS containment;
   measure the smallest viable candidate before selecting a dependency.
   Exact user-CPU limits are not supplied by periodic Windows job checks.
   Do not enlarge timeouts or repeat launch controls seeking a passing sample.
   A fresh primary is recommended at this completed investigation/design
   boundary; the handoff carries the evidence needed for that next slice.
3. Hard containment gates hostile depth/count/declared-size parser cases.
   Then probe a dedicated keyless validating node with exact artifact,
   validation/history/bootstrap config and sync-state evidence; reproduce
   fixture fields/order/roots with bounded GET reads. No local node ran here.
4. Authenticate complete contiguous ranges and publication order, then replay/
   import/adoption, openings and certificate dependencies. The
   [range-source-first decision](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging)
   and [recovery map](docs/POOL_V3_RECOVERY_MAP.md) still govern integration.
5. Fix final v3 configuration/artifact pins, build one v3 runtime and wallet,
   then rerun all six real-proof relations on that configuration.

## Open questions

- Runtime remains v2, refuses silence clauses and exports no pool wallet.
  Authenticated headers/ranges, chain/finality, A8/A9, node equivalence,
  publication force and custody remain open. No product gate closed here.
- The Windows supervisor is fixed trusted experiment code, not file/network
  isolation. Run only its PowerShell supervisor, never the worker directly.
- About **45% done / 55% remaining**, plausible done range **35–55%**.
  Largest work: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody assurance.
- Deployment, public releases, access changes and real funds remain outside
  authorization. No dependency, node installation or live publication added.
