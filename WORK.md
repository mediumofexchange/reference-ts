# Current work

Updated: 2026-09-10

## Goal

Delivered slice: fixed-artifact metered decoder feasibility on `main` and
`test/metered-decoder-feasibility`, based on `6fae48d`.
Acceptance: pin a disposable engine, demonstrate fuel exhaustion and memory
growth refusal, measure canonical fixture decoding and preserve refusals.
Implementation, independent review and final report hash readback passed.
No normative or runtime change; companion `money-from-first-principles`
remains `main` at `7ea0ee8`.

## Status

- Baseline CI [34414321259](https://github.com/mediumofexchange/reference-ts/actions/runs/34414321259)
  passed at `6fae48d`; fetched upstream had no intervening commits. No branch
  protection or rulesets; no safeguards changed.

## Evidence

- Disposable Wasmtime 48.0.0 Windows x64 wheel is hash-pinned outside production
  dependencies. The runner checks the native DLL hash before import and exact
  loaded package/DLL paths, preventing global-install fallback.
- At fixed 10,000,000 fuel / 16 MiB guest memory per fresh Store, 23/24 valid
  transactions and all 60 corresponding output fields match after an exact
  byte round trip. The 2,163-byte transaction `745e1997...ee9ac1c` consumes its
  budget during parsing; its five outputs remain unresolved. Runner exit 2
  preserves this distinction. No hostile parser mutations were run.
- Zero/one/1,000/100,000-fuel infinite loops exhaust exactly; memory/table
  growth accepts the exact cap and refuses overages; recursion traps. The
  one-fuel valid transaction also traps. All 56 host imports refuse without
  guest-memory reads or a JS object bridge. This measures guest resource
  refusal, not exact CPU seconds or total process memory.
- Independent adversarial review found a global-import provenance gap and
  ambiguous zero exit on incomplete decoding; both fixed and read back.
  Source inspection confirms limiter refusal precedes growth allocation.
  Four worker-free provenance regressions pass. No material finding remains.
- `npm run check` passed: 96 files / 1,795 tests, build, installed package,
  pilot, crash and spent-set checks. The known esbuild parent-directory denial
  required running outside the sandbox. Final harness and docs checks follow
  the review fixes; no circuits or runtime sources changed.
- Current evidence and reproduction instructions:
  [analysis](docs/POOL_DEPLOYMENT_PROBES.md#metered-decoder-feasibility),
  [report](docs/ergo-metering-verification.json),
  [runner](experiments/ergo-range/README.md).
- Final readback: seven source hashes match working/index bytes; all 36 engine
  hashes and the native DLL/WASM pins match. Disposable engine and intermediate
  reports removed after capture; the pinned installation command reproduces them.

## Next

1. Read CI for the latest main revision. Local checks, independent review and
   final report readback passed; new remote CI is pending at handoff.
2. Explain the refused valid transaction's parser cost and measure host overhead
   before proposing a supported metering budget/embedding. Keep the original
   trial budget/evidence; do not raise it just to get all fixtures through.
   Acceptance: evidence-backed resource contract for guest and host work,
   complete fixture support or an explicit justified alternative boundary.
   Continuing in the same primary instance is reasonable for this directly
   related slice; switch at a component boundary or if context causes rework.
3. Hard containment still gates hostile depth/count/declared-size parser cases.
   Then probe a dedicated keyless validating node with exact artifact,
   validation/history/bootstrap configuration and sync-state evidence; reproduce
   fixture fields/order/roots with bounded GET reads. No local node ran here.
4. Authenticate complete contiguous ranges and publication order, then replay,
   import/adoption, openings and certificate dependencies. The
   [range-source-first decision](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging)
   and [recovery map](docs/POOL_V3_RECOVERY_MAP.md) still govern integration.
5. Fix final v3 configuration/artifact pins, build one v3 runtime and wallet,
   then rerun all six real-proof relations on that configuration.

## Open questions

- Windows job CPU containment remains failed; no old report or budget changed.
  Guest fuel/linear memory do not bound compilation, bulk-operation cost,
  host callbacks/copies/JSON parsing or total process memory. No product gate
  closed here. Runtime remains v2, refuses silence clauses and has no pool wallet.
- About **45% done / 55% remaining**, plausible done range **35–55%**.
  Largest work: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody assurance.
- Deployment, public releases, access changes and real funds remain outside
  authorization. No node installation or live publication added.
