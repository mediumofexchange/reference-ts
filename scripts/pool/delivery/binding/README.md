# Delivery digest binding probe

This disposable candidate check derives a spend circuit from the pinned current
source, adds two public `u128` limbs after its eleven public inputs, and measures
their constraint and proof cost. It writes generated source, build products and
the report only to `scratch/pool-delivery-binding/`.

Run from the repository root:

```sh
node scripts/pool/delivery/binding/check.mjs
```

The check compiles a fresh baseline and requires its bytecode to match the
pinned manifest before comparing the candidate. Its hostile range test changes
only the candidate ABI description to `Field`, leaving ACIR unchanged, so an
out-of-range failure cannot be attributed to ordinary `u128` input encoding.
