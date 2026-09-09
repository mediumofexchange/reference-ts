# Current work

Updated: 2026-09-09

## Goal

Delivered slice: Windows job accounting and resource-evidence checks at
`8938c77`, merged and pushed to `main` and `test/windows-containment-accounting`.
Both remote refs verified at that commit; based on `8f29a4a`.
Observable result: identify extra job processes, independently measure private
commit, reject observed CPU/process overages and verify whole-job cleanup.
No specification change; companion `money-from-first-principles` remains
`main` at `7ea0ee8`. Hard containment remains FAILED; no hostile parser cases
or runtime boundary adoption are authorized by this evidence.

## Status

- Fixed controls identify both Node and `C:\Windows\System32\conhost.exe` in
  sampled job inventories. There is one accounting entry before resume and
  two lifetime entries after it. The former one-process premise is false.
  Associated IDs do not by themselves prove simultaneous execution or an
  exemption from configured process/memory limits.
- Independent sampled private-commit peaks match the job's process peaks.
  The growing-memory control still reports job commit above 256 MiB. A single
  refused 256 MiB WASM growth retains one page and does not inflate the job
  peak by the requested allocation. Aggregate enforcement remains unexplained.
- Microsoft documents periodic user-CPU checks without a maximum overshoot;
  exact CPU containment cannot be inferred. Target and final job overages now
  remain unresolved even on quota exit. Kernel CPU is a separate measurement.
- Cleanup terminates the job and reads back zero active accounting entries,
  in addition to the existing direct target fallback and wait. Samples can
  retain a console helper after target exit; cleanup covers that interval.

## Evidence

- `contained-check.ps1 -EvidenceOnly`: eight worker-free regressions pass.
  `-StartupOnly` emits unresolved status and exit 2 for observed overages.
- Independent review inspected native layouts, cleanup, worker and report
  predicates. It found a false-green startup-only exit and missing checks on
  accounting snapshots; both fixes and nearby variants were read back.
  No unresolved material code findings for negative-evidence delivery.
  Final report hashes, resource issues and numeric documentation also passed
  independent readback; all six staged source hashes match the report.
- Full `npm run check` passed: 96 files / 1,795 tests, build, package consumer,
  pilot, crash and spent-set checks. It ran outside the sandbox after the
  known esbuild parent-directory denial. Final docs and companion links pass.
- Final controls ran after checks: exit 2, eight clean job shutdowns, corpus
  14,874 assertions / 24 transactions / 65 outputs. Job memory 274,014,208
  bytes exceeds 268,435,456; CPU quota exit follows 6.59375 seconds user CPU
  at a one-second threshold. All six report source hashes match.
- Baseline CI [34399693641](https://github.com/mediumofexchange/reference-ts/actions/runs/34399693641)
  passed at `8f29a4a`; upstream fetched with no intervening main change.
  Main has no branch protection or rulesets. No safeguards were changed.
- [Current report](docs/ergo-containment-verification.json) and
  [analysis](docs/POOL_DEPLOYMENT_PROBES.md#windows-process-containment-feasibility)
  retain evidence limits. Old report remains at immutable `8f29a4a`.

## Next

1. Read CI for the latest main/handoff revision. Local checks, independent
   review and implementation delivery passed; new remote CI is pending.
2. Compare a fixed `DETACHED_PROCESS` launch with this `CREATE_NO_WINDOW`
   launch, or evaluate another boundary with explicit aggregate resource
   semantics. Keep 256 MiB limits and record helper behavior; do not subtract
   an empirical allowance. Exact user-CPU limits require a different mechanism
   or an explicitly justified resource contract, not a larger timeout.
   This change of launch/resource design is a useful fresh-primary boundary
   and requires independent adversarial review. Tell the user at that boundary.
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
