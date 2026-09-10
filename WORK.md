# Current work

Updated: 2026-09-10

## Goal

Prepare bounded retention and verified local import of an unadopted Windows
RocksDB candidate. Implementation, independent review and project checks are
complete. The first hosted retained build is the next slice.
No DLL load, runtime adoption, database retry or billing change in this slice.

Delivery: `main`; preparation branch `test/rocksdb-retention-preparation`.
Prior build revision: `e917849`; JNI evidence revision: `38b7af9`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, local toolchain installation, peers or volume allocation.

## Status

- [Retention route](docs/ERGO_NATIVE_BUILD.md#bounded-candidate-retention) adds an
  opt-in boolean to the manual build; default remains logs-only. Successful
  staging can upload one named artifact for one day with a pinned upload action.
- [Stager/importer](experiments/ergo-range/native-candidate.ps1) allowlists DLL,
  JAR, generated source/java/include headers, generated project, build/cache/
  import/export evidence and manifests. Bounds: 32 MiB per binary, 8 MiB headers,
  80 MiB content plus 256 KiB manifest, 81 MiB downloaded archive, 300 files.
- Import requires expected archive SHA-256 and workflow/run/attempt identity,
  validates every member and report before extraction, and publishes an absent
  destination only after complete extraction. Partial output is cleaned on error.
- Read-only billing check found existing zero-dollar Actions/Packages budgets
  with prevent_further_usage enabled. No budget/access settings were changed.
  Package inventory lacks read:packages scope; recheck zero-spend budgets before
  dispatch. Size gates are not bandwidth or whole-process memory quotas.
- [JNI comparison](docs/ERGO_NATIVE_BUILD.md#javajni-name-compatibility) accounts
  for 79 removed exports: 71 LZ4, four obsolete bindings, four still-declared
  Options/DBOptions failIfOptionsFileError getter/setter bindings. Seven of
  1,519 Ergo native declarations lack build exports; three gaps are shared with
  the published DLL. The stock Ergo class baseline is unchanged.
- Original [compile-only run 34495975811](docs/ERGO_NATIVE_BUILD.md) at `e917849`
  took 16.43 minutes and 744.04 MiB scratch; binaries were discarded. A new run
  produces new hashes, not an artifact authorized by those old observations.

## Evidence

- 46 synthetic archive tests pass without native execution: round trip, hashes,
  identity, traversal, duplicates, symlinks, bounds, malformed lengths, JSON
  arrays/duplicate keys and final-newline names. Windows CI runs this suite.
- Independent review reproduced two blockers: PowerShell array comparisons
  bypassed identity checks; a final newline passed a filename regex. Explicit
  scalar validation and absolute regex anchors resolve both. Independent
  readback passed original counterexamples, all 46 tests and a separate Windows
  extraction-failure cleanup probe; no material finding remains in this scope.
- Local retained-build invocation refused at the host gate in 53 ms before
  mutation. Workflow/source still require the exact public manual Windows job.
- Initial full check reached typecheck, then sandbox directory access blocked
  Vitest/esbuild startup. Full `npm run check` then passed outside the sandbox:
  96 files / 1,795 tests in 264.20 s plus build, package, pilot, store-crash and
  spent-set checks. No implementation or test deadline was relaxed.
- Previous JNI docs revision `38b7af9` CI run `34499805855` passed all jobs.
- No hosted retention/upload/download or candidate inspection has run yet.
  Synthetic archives do not prove actual generated paths, upload behavior,
  candidate signatures/semantics or the database worker's transitive call path.
- Last [database diagnostic](docs/ergo-node-database-verification.json) loaded
  native 10/1/3 and refused WinSxS COMCTL32 before PROCEED. Sample gap 954 ms
  approaches the unchanged 1 s ceiling; all VHDs/mappings were removed.

## Next

1. Recheck existing zero-spend budgets, then manually dispatch the reviewed
   native build with retain_candidate=true. Preserve input refusals. Verify
   successful workflow commit/run/attempt and artifact ID/digest/size, download
   raw ZIP into scratch, and import using independently read expected identity.
2. Independently inspect the actual DLL/JAR, generated JNI headers/project and
   import/export evidence. Establish the exact required worker call path and
   seven binding-gap exclusions; investigate WBWIRocksIterator's header/ABI.
   Do not replace the stock Ergo JAR or patch placeholder JNI methods.
3. Review exact native pin changes and narrow WinSxS provenance before any load.
   Keep the 1 s sampling limit and fixed 64 MiB control prerequisites.
4. Larger sync still needs separate preparation/approval: 30 min, 20 GiB disk,
   100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum, and public
   peer parser/JRE review. No complete sync combination is established.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Switch to a fresh instance for the retained-build execution/review slice.
  The bounded route and exclusions are recorded; fresh context should improve
  efficiency for inspecting actual build evidence. This is a recommendation,
  not measured comparative performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. Retention tooling closes no end-to-end product gate. Runtime/recovery,
  wallet/transport, authenticated evidence, witness publication and custody/
  rollback assurance dominate remaining effort and may require redesign.
