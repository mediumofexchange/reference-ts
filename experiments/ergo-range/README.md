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
