# Current work

Updated: 2026-09-10

## Goal

Prepare a retained Windows RocksDB 10.2.1 candidate for the bounded offline
database control. Static Java/JNI name reconciliation is complete; runtime
adoption remains blocked. No build, DLL load or database retry in this slice.

Delivery: `main`; preparation branch `docs/rocksdb-jni-compatibility`.
Prior executable revision: `e917849`; this slice changes documentation only.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, local toolchain installation, peers or disk allocation.

## Status

- [JNI comparison](docs/ERGO_NATIVE_BUILD.md#javajni-name-compatibility) accounts
  for all 79 removed exports: 71 LZ4, four obsolete option bindings, four still
  declared `failIfOptionsFileError` getter/setter bindings on Options/DBOptions.
  No added exports. Seven of 1,519 Ergo native declarations have no build
  export; three were also missing from the published DLL. Twelve build exports
  are test helpers absent from the Ergo class set.
- [Static report](docs/ergo-native-jni-compatibility.json) retains all missing
  descriptors, export differences, 253 class hashes, input/source hashes and
  explicit evidence limits. Four newly missing natives have no bridge source
  implementations; a full Java API compatibility claim is ruled out.
- The existing worker does not directly call missing wrappers and explicitly
  uses no compression. Transitive control reachability, retained output linkage
  and runtime semantics remain open. No replacement of the stock Ergo baseline.
- [Compile-only run 34495975811](docs/ERGO_NATIVE_BUILD.md) at `e917849` used
  source `4b2122578e475cb88aef4dcf152cccd5dbf51060`, image `20260830.290.1`,
  Temurin 21.0.12.1, CMake 3.31.6 and MSVC 14.44.35207. It took 16.43 minutes
  and ended with 744.04 MiB scratch. All binaries disappeared with the runner.
  Reports retain output/tool hashes and 1,524 exports. A later build is a new
  candidate; no current hash silently authorizes it.

## Evidence

- Rehashed pinned Ergo JAR, published DLL and exact RocksDB source archive.
  Read every compiled RocksDB class method table and the published PE exports;
  compared against retained hosted exports without loading any native code.
- Independent readback used separate ZIP/class and PE export-address parsers,
  reproduced all counts/digests/missing lists and checked pinned source/prose.
  No short-name overload collisions, zero published function addresses or
  forwarded exports; no unresolved material finding within the static scope.
- `npm run check:docs` and `git diff --check` pass for documentation changes.
  Unchanged code reuses full `npm run check` at `e917849`: 96 files / 1,795
  tests plus package, pilot, store-crash and spent-set checks; cross-platform
  CI run `34497461262` passed. Build warnings/refusals remain in the build doc.
- Static names do not prove signatures, callbacks, semantics, codec inventory
  or runtime call paths. Generated build JAR and DLL are unavailable. The new
  report does not qualify a runtime artifact or close a product gate.
- Last [database diagnostic](docs/ergo-node-database-verification.json) loaded
  native 10/1/3 and refused WinSxS COMCTL32 before PROCEED. Sample gap 954 ms
  approaches the unchanged 1 s ceiling. All three VHDs/mappings were removed;
  no write/flush/reopen or disk-full acceptance has been demonstrated.

## Next

1. Prepare bounded artifact retention/transfer for the narrow offline profile.
   Independently review actual retained DLL/JAR, Java descriptors/JNI signatures,
   export addresses and compression configuration. Carry the seven name gaps
   as explicit exclusions and establish the worker's required call path.
   Do not substitute the compile-only JAR for the stock Ergo class baseline.
2. Review exact bundle/native pin changes before any load. General Ergo use
   requires a separate resolution of the missing bindings and codec profile;
   do not patch placeholder methods merely to satisfy a symbol count.
3. Establish narrow WinSxS component provenance separately; keep the sampling
   concern and 1 s ceiling. Retry the fixed 64 MiB control only after candidate
   and module-policy prerequisites are concretely reviewed.
4. Larger sync still requires separate preparation/approval: 30 min, 20 GiB
   disk, 100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum,
   public-peer parser/JRE review. No complete sync combination is shown.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Stay with the current instance for retention preparation: the exact inputs,
  static gaps and runtime exclusions are fresh. Use an independent reviewer
  for the eventual retained candidate. This is an efficiency recommendation,
  not measured comparative performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. Static compatibility evidence closes no end-to-end product gate.
  Runtime/recovery, wallet/transport, authenticated evidence, witness publication
  and custody/rollback assurance dominate remaining effort and may need redesign.
