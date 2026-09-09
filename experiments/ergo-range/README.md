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
do not expose this probe as an arbitrary-file or network verification API.
