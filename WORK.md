# Current work

Updated: 2026-09-10

## Goal

Prepare a retained Windows RocksDB 10.2.1 candidate whose Java/JNI and build
identity can be reviewed before the existing bounded local database control.
Compile feasibility is now demonstrated; runtime adoption is not.

Integration: `test/rocksdb-build-execution` into `main` after verified review.
Successful executable revision: `e917849`; subsequent changes record evidence.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, local toolchain installation, peers or disk allocation.

## Status

- [Build qualification](docs/ERGO_NATIVE_BUILD.md) passed in hosted run
  `34495975811`: pinned RocksDB source `4b2122578e475cb88aef4dcf152cccd5dbf51060`,
  image `20260830.290.1`, Temurin 21.0.12.1, CMake 3.31.6, MSVC 14.44.35207.
  Duration 985,526 ms (16.43 min), final scratch 780,178,640 bytes (744.04 MiB).
- [Workflow](.github/workflows/rocksdb-native-build.yml): manual public main or
  named development branch, read-only token, exact image/source gates,
  30-minute timeout and parallelism two. No artifact/cache upload or release.
  No DLL was loaded; binaries disappeared with the runner. Logs/report remain.
- C++17, static CRT and portable CPU, compression-free JNI profile. Five build
  JARs have fixed URLs/sizes/SHA-256 (3,144,161 bytes). Java test classes generate
  JNI headers only; no tests/native candidate are executed by this workflow.
- [Build report](docs/ergo-native-build-verification.json) records tool hashes,
  source/tree, cache and output hashes. [Static evidence](docs/ergo-native-build-static.json)
  retains 1,524 JNI exports and direct imports SHLWAPI/RPCRT4/KERNEL32.
  The published DLL had 1,603 exports: binding/semantic compatibility is open.
- Existing local version/hash/module/resource gates are unchanged. Published
  Java 10.2.1/native 10.1.3 mismatch and WinSxS refusal still block acceptance.
  A later build is a new candidate; these hashes cannot silently authorize it.

## Evidence

- Independent source/workflow and actual output review found no material
  compile-feasibility blocker. Report and all exports match the hosted log.
  `/MD` cache defaults are shadowed by upstream normal flags ending in `/MT`;
  JDK 8 javah/idlj discoveries are unused in the modern header-generation path.
- Java emitted source-8/bootstrap warnings; warnings-as-errors is C++ only.
  Shallow checkout has no tag; generated version source records the exact
  commit and clean-source marker. No runtime version result is claimed.
- Final executable revision `e917849`: full `npm run check` passed with default
  workers, 96 files / 1,795 tests in 277.97 s, plus package, pilot, store-crash
  and spent-set checks. Cross-platform CI run `34497461262` passed all jobs.
  Earlier parallel contention failure and serial recovery remain in the build
  document; no implementation or deadline was changed to make checks pass.
- Three earlier hosted pre-compile refusals are retained: image mismatch,
  omitted JDK metadata, then the actual Java 21.0.12.1 diagnosis. Exact inputs
  were corrected after review; no permissive version fallback was added.
- Selected hashes are observations, not full toolchain/OS attestations or
  reproducibility evidence. Disk readings are observations, not quotas.
  Compiler success and exports do not establish Java/native runtime semantics.
- Last [database diagnostic](docs/ergo-node-database-verification.json) loaded
  native 10/1/3 and refused WinSxS COMCTL32 before PROCEED. Sample gap 954 ms
  approaches the unchanged 1 s ceiling. All three VHDs/mappings were removed;
  no write/flush/reopen or disk-full acceptance has been demonstrated.

## Next

1. Compare the new 1,524 exports against the published DLL and pinned Java
   native declarations; explain missing/added bindings and feature differences.
   The published [reconciliation](docs/ergo-node-native-provenance.json) and
   pinned Ergo bundle under ignored `scratch/node-startup/bundle/` are inputs.
   Do this static work before arranging another build or loading any candidate.
2. Prepare bounded artifact retention/transfer and independently review the
   actual retained output, input/Java linkage and compression-profile evidence.
   Review the exact bundle/native pin patch before any library load. The
   compile-only JAR cannot silently replace the stock Ergo baseline.
3. Establish narrow WinSxS component provenance separately; keep the sampling
   concern and 1 s ceiling. Retry the fixed 64 MiB control only after candidate
   and module-policy prerequisites are concretely reviewed.
4. Larger sync still requires separate preparation/approval: 30 min, 20 GiB
   disk, 100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum,
   public-peer parser/JRE review. No complete sync combination is shown.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Switch to a fresh instance for the next JNI compatibility slice: this long
  build-diagnostic session is complete and the retained evidence gives a clean
  starting point. This is an efficiency recommendation, not measured performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. Build feasibility closes no end-to-end product gate. Runtime/
  recovery, wallet/transport, authenticated evidence, witness publication and
  custody/rollback assurance dominate remaining effort and may require redesign.
