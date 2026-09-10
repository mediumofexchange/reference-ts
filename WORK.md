# Current work

Updated: 2026-09-10

## Goal

Return the Ergo witness probe to a complete, unmodified upstream distribution.
Next acceptance: select a practical standard package/runtime, check its fit to
fixture requirements, and prepare a bounded offline test of actual Ergo storage.
Custom native execution is suspended. No sync, peers, deployment or installation
in this reassessment.

Delivery: `main`; baseline `baacb26`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change.

## Status

- [Route correction](decisions/2026-09.md#2026-09-10--prefer-the-standard-ergo-distribution)
  replaces custom native qualification as the next prerequisite. Independent
  source review agrees that current evidence does not establish its necessity.

## Evidence

- Stock v6.1.5 Windows already passed offline startup on Java 21.0.1: `/info` 200,
  no connected peers, exit 0. This proves startup only, not storage recovery,
  sync or all Java/native compatibility.
- Later standalone refusals came from our native-version gate and module policy
  before database operations. The 10.1.3 Windows DLL finding is real; it is not
  a demonstrated failure of Ergo's storage path.
- Inspected upstream RocksDBFactory and versioned store have no native-version
  equality gate or histogram call. Factory uses LZ4; the custom NO_COMPRESSION
  candidate does not cover that ordinary node configuration.
- Standard and Windows Maven 10.2.1 downloads contain the same DLL and all 253
  RocksDB classes as Ergo. Exact pins remain in native provenance docs.
- Upstream v6.1.5 Docker/integration setup uses Temurin 11 on Ubuntu. Another JRE
  cannot change the version in the same Windows DLL. Maintained Java 11 is an
  operating-baseline candidate, not a proven fix for that mismatch.
- GitHub latest-release API on 2026-09-10 identifies stable v6.0.5 with Windows
  and Linux x64 bundles. Existing v6.1.5 is a prerelease fixture baseline;
  assess whether its features are actually needed before retaining it.
- WSL listing confirms Ubuntu-20.04 is installed. Earlier namespace checks
  passed, but Linux Java/storage/network/process limits remain unqualified.
  Docker was not found on PATH; this is not a complete installation inventory.

## Next

1. Compare stable v6.0.5's required witness/API behavior with the v6.1.5 fixture
   baseline. Prefer the stable whole package if suitable; keep artifacts distinct
   and do not silently change fixture or consensus pins.
2. Choose the simplest standard host/runtime. Existing Windows startup is useful;
   maintained Java 11/Linux is an upstream-aligned alternative. Avoid replacing
   individual RocksDB dependencies inside the node.
3. Test actual stock storage operations, normal options/compression, persistence
   and failure behavior within explicit bounds. Review concrete required
   compatibility differences. Exact artifact identity remains useful; matching
   source-version labels alone do not prove operational suitability.
4. Keep the custom build as an unexecuted fallback. Its pinned preparation and
   passing code checks remain recorded. Do not launch
   `scratch/native-control-trial/launch.ps1`. No control volume was created.
5. Larger sync still needs its bounded execution plan: 30 min, 20 GiB disk,
   100 GiB host reserve, 8 GiB traffic trigger/10 GiB maximum and peer-parser/JRE
   review. No full sync combination is established. Windows controls are not
   Linux evidence; do not silently widen limits.

## Open questions

- Preparation code at `bb560a5` passed full checks: 96 files / 1,795 tests,
  plus docs, build/package, pilot and store checks; CI 34512630234 passed.
  This reassessment changes documentation only.
- Stay with this instance for the standard-package comparison: observed failures
  and untested alternatives are fresh. This is an efficiency recommendation,
  not measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback assurance dominate remaining effort. No product gate closed.
