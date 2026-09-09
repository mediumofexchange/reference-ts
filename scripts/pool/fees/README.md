# F4 fee-output feasibility probe

This probe derives 2×2+delivery, 2×3+delivery and 2×4+delivery spend
circuits mechanically from the pinned v2 spend. Generated sources, programs,
and the report stay in ignored `scratch/pool-fees/`. It does not change the v2
runtime, manifest, keys, admission, finality, or the normative specification.

Run from the repository root after `npm run build`:

```sh
node scripts/pool/fees/check.mjs
```

The check reuses `scratch/private-payment-crs`, runs Barretenberg single-threaded,
and writes its measurements and source identities to `scratch/pool-fees/report.json`.
