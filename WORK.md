# Current work

Updated: 2026-09-10

## Goal

Corrected Windows RocksDB candidate retained, imported and independently reviewed
as static evidence, including its exact packaged-target project. Narrow read-only
Windows component provenance also recorded. No native load, runtime adoption,
database retry, volume allocation, peers or deployment occurred.

Delivery: `main`; build input: `9ea1c16de569b7075a34850ba0ffbaf9975efd65`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change or local toolchain installation.

## Status

- [Run 34507404910](https://github.com/mediumofexchange/reference-ts/actions/runs/34507404910),
  attempt 1, succeeded in 17.72 min compile/static time on reviewed image
  `20260907.297.1`. Artifact `10165083375` expires 2026-09-11 17:36:32 UTC.
  ZIP: 13,695,907 bytes, SHA-256
  `28c4f283a0bdc9041c52ccf2ef62563f1cf295694580c67108873eeff9fa57e5`.
- Authenticated API/upload-log identity matched before download; current importer
  validated all 105 members and manifest before extraction. Candidate/ZIP/log/API
  files remain in `scratch/retained-native-target/`. Prior candidate remains in
  `scratch/retained-native-review/candidate/` for native-byte comparison.
- [Current evidence](docs/ergo-native-candidate-verification.json) and
  [build guide](docs/ERGO_NATIVE_BUILD.md#actual-retained-output) record exact
  target settings/source membership, member hashes and independent review.
  Actual `rocksdbjni.vcxproj`: 85 JNI sources, Release x64, C++17, static CRT,
  warnings as errors, correct `librocksdbjni-win64.dll` output.
- DLL SHA-256: `b0370fa9a8afe8942d0d2ccba1557b29ab08472a09da7c1bde7005eca7cdd21c`.
  All 1,524 exports and direct imports match prior observations; all 36 worker
  bindings resolve. All 258 generated classes and 96 headers match prior bytes.
  Keep stock Ergo JAR; generated JAR remains inspection-only. Same seven broader
  JNI gaps and at most two unclosed stock default ReadOptions allocations remain.
- DLL differs in 8,608 bytes, including 7,202 `.text` bytes. Cause and semantic
  equivalence are unestablished despite equal selected tool/dependency hashes.
  Full invocations and core project/object provenance remain unavailable.
- [Component provenance](docs/ergo-node-system-component-provenance.json) records
  exact refused COMCTL32 path/hash, valid Microsoft catalog observations,
  manifest digest equality and independent Java RT_MANIFEST inspection.
  This is trusted-host evidence only; current module policy still refuses it.
- Zero-dollar Actions/Packages hard budgets rechecked before dispatch; no settings
  changed. Package inventory remains incomplete without `read:packages` scope.

## Evidence

- Independent ZIP/PE/class/header and pinned CMake/project inspection reproduced
  identity, target settings, 1,531 generated signatures, 1,524 exports, worker
  bindings and native-byte difference counts. No unresolved material finding
  within static retention/reporting; no runtime-adoption clearance.
- Independent Windows file/manifest hashes and catalog readback reproduced the
  component observations; Java PE resource tree confirms actual RT_MANIFEST.
- Documentation/link checks and diff checks pass. Runtime/tooling code unchanged;
  reuse `9ea1c16` full check: 96 files / 1,795 tests in 254.64 s plus all remaining
  project checks. Its CI run `34505552007` passed all seven jobs.
  Check delivery CI for the resulting documentation commit separately.

## Next

1. Prepare and independently review the exact native candidate pin and narrow
   COMCTL32 path/hash/length policy, including disposition of unexplained native
   differences and retained build-evidence limits. Do not treat matching JNI
   interfaces or static retention review as native-code equivalence/clearance.
2. Keep stock Java classes, fresh compression-free profile, fixed 64 MiB control
   and unchanged 1 s sampling ceiling. Last diagnostic's 954 ms sampling gap
   remains close to that ceiling. No database-control acceptance exists.
3. Any execution needs the separately authorized elevated experiment boundary.
   Larger sync still requires separate preparation/approval: 30 min, 20 GiB disk,
   100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum, plus public
   peer parser/JRE review. No complete sync combination is established.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Recommend staying with this instance for narrow native-pin/module-policy
  preparation: the exact evidence and remaining boundaries are fresh. This is
  an efficiency recommendation, not measured comparative performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  No end-to-end product gate closed. Runtime/recovery, wallet/transport,
  authenticated evidence, witness publication and custody/rollback assurance
  dominate remaining effort and may require redesign.
