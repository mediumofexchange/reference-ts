# Ergo range-source feasibility

Private offline probe; no runtime exports, node connection or transaction submission.
Use Node 24, then from the repository root:

```powershell
npm --prefix experiments/ergo-range ci --ignore-scripts --no-audit --no-fund
npm run check:ergo:range
```

The [deployment evidence](../../docs/POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
records source pins, observed coverage, counterexamples and the next source gate.
The fixture manifest pins the original public response bytes before parsing;
Git attributes preserve those raw responses, including trailing whitespace.
Do not expose this probe as an arbitrary-file or network verification API.

The command runs both the block-root/Fleet experiment and the
[full binary decoder experiment](../../docs/POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility).
`decoder-check.mjs` launches the fixed corpus in a child process with a 30-second
deadline and 1 MiB output cap. The corpus checks fixture pins, all output
fields/IDs, every proper transaction prefix, trailing bytes, nonminimal counts
and JSON field-boundary aliases. Input budgets are experimental refusal limits;
there is no hard process/WASM memory cap and no production decoder selection.

The separate Windows x64 / PowerShell 7 containment probe is run explicitly:

```powershell
pwsh -NoProfile -File experiments/ergo-range/contained-check.ps1
pwsh -NoProfile -File experiments/ergo-range/contained-check.ps1 -LaunchMode detached
```

It requires Windows 10 or newer for creation-time job assignment. Run only
this supervisor, never `contained-worker.mjs` directly: the worker includes
memory-growth, infinite CPU/output and descendant-process controls. Each
worker joins a Job Object at creation, remains suspended until membership
and limits are read back, and has bounded captured output and a wall deadline.
The default `no-window` mode uses `CREATE_NO_WINDOW`; `detached` substitutes
`DETACHED_PROCESS`, with identical budgets and inherited handles. Each result
records the mode and creation flags. Run the two commands sequentially without
concurrent repository checks when comparing resource measurements. Detached
launch does not prevent the process from allocating a console later.
This controls resources for fixed trusted code; it does not isolate file or
network access. No arbitrary files or hostile parser inputs are accepted.

The [no-window result](../../docs/ergo-containment-verification.json) and
[detached result](../../docs/ergo-detached-containment-verification.json) retain
both launch observations. Both exit **2**, unresolved: no-window reports
excess memory/CPU and extra associated processes; detached samples only Node
and stays below the memory limit but still exceeds the CPU threshold.
Independent process counters, bounded process inventories and whole-job
cleanup readback distinguish those observations.
The extra console host does not establish a permissible memory allowance.
The commands are deliberately outside the default checks/CI until the
acceptance gate can be met. Exit 0 would establish only these fixed controls
and the old corpus; it would still not establish hostile-parser containment
or node equivalence.
`-StartupOnly` runs just the low-cost launch/readback control, not acceptance.
`-EvidenceOnly` checks eight resource-report regressions without executing a worker,
including a quota exit with excessive CPU that the earlier check accepted.
See the [comparison and limits](../../docs/POOL_DEPLOYMENT_PROBES.md#windows-process-containment-feasibility).
