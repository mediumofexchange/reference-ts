# Current work

Updated: 2026-09-12

## Goal

Stable Ergo v6.0.5 now passes offline storage, node startup and typed settings.
Deliver this slice, then prepare the bounded source sync using the standard
package. No custom native package, host installation or connected sync occurred.

Delivery: `main`; baseline `bd4e907`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change; original fixture provenance pins remain unchanged.

## Status

- [Stable evidence](docs/ergo-stable-verification.json) links the completed
  storage, startup and settings results and independent review/cleanup.
- Complete bundle remains at `scratch/ergo-stable/bundle/`, archive/manifest
  beside it. Node JAR hash:
  `2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588`.
- Explicit `-Stable` selects the stable package in existing prepare/startup/
  settings scripts. Historical default pins remain distinct; no auto fallback.
- Custom candidates, archives and launcher were deleted: 224 files / 55,859,988
  bytes. Historical findings and build recipes remain. Do not revive custom
  builds without a demonstrated need.

## Evidence

- Eighteen relevant source files match the prerelease fixture baseline. Stable
  LevelDB storage passed write/update/delete and fresh-process reopen/rollback.
  This is ordinary operation, not crash/disk-full or protocol recovery assurance.
- Stable startup passed: actual appVersion 6.0.5; expected genesis UTXO state;
  no peers; wallet HTTP 403; secrets empty. 74,377 ms / 341,958,656 peak job
  commit bytes / 966,600 combined file-output bytes / 287 loopback socket samples.
- Stock typed settings accepted mainnet UTXO/full validation/history with explicit
  checkpoint=null, bootstrap disabled, snapshots=0, no mining/extra index or test
  keys. Pruning override and omitted checkpoint were detected and rejected.
  Readbacks: 8,023 / 9,429 / 6,480 ms; final settings files 9,319 bytes.
- Independent review verified the actual patch, source/package/config hashes,
  six process records, empty jobs and secret directories, and both inventories.
  Temporary startup/settings directories were removed after durable capture.
- Stable extraction reproduced the exact manifest. Eighteen startup-evidence
  cases and eleven observer controls passed. Full project checks passed on the
  host: 96 files / 1,795 tests in 241.09 s, plus docs/typecheck, build/package,
  pilot, store-crash and spent-set checks. Final documentation/link checks pass.

## Next

1. Prepare one concrete standard-node sync plan using current preflight controls:
   30 min, 20 GiB disk, 100 GiB host reserve, 8 GiB traffic trigger/10 GiB maximum.
   Determine only the remaining execution prerequisites and peer-parser/JRE
   evidence; no full sync combination is established. Preserve explicit bounds.
2. Reuse the standard package and measured stock settings. Keep a fresh validation
   directory, no spending key, loopback service surfaces and bounded public reads.
   An offline start is not validated ancestry, zero packets or disk isolation.
3. After bounded sync, compare the three fixtures as ancestors of an applied tip.
   Keeping all blocks does not guarantee historical AD proofs; this comparison
   requires transaction spending proofs. Authenticated ranges/publication remain
   separate protocol work. Do not infer chain validation from /info alone.

## Open questions

- Bundled Java is still 21.0.1. Maintenance and public-peer parser review remain
  open; startup success is not runtime security or production approval.
- Stay with this instance for the bounded sync prerequisites: stable-package and
  host-control evidence are fresh. This is an efficiency recommendation, not
  measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback assurance dominate remaining effort. No product gate closed.
