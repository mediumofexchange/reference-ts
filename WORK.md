# Current work

Updated: 2026-09-10

## Goal

Demonstrate a bounded compile-only Windows build of pinned RocksDB 10.2.1,
then qualify an actual native candidate before any local database trial.
The fixed manual hosted workflow is prepared and independently reviewed;
execution is next. No candidate DLL is loaded or adopted by this slice.

Development branch: `docs/rocksdb-build-feasibility`, from `f2e511a`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, local toolchain installation, peers or disk allocation.

## Status

- The [build plan](docs/ERGO_NATIVE_BUILD.md) selects an existing public standard
  Windows runner: local compiler/SDK/CMake/JDK were not found in scoped inventory.
  WSL2 Ubuntu exists but was not started. Local runtime controls remain intact.
- [Workflow](.github/workflows/rocksdb-native-build.yml): manual public-main-only,
  read-only token, fixed image/source, 30 minutes, build parallelism two.
  Five Java build JARs are URL/size/SHA-256 pinned, 3,144,161 bytes total.
- C++17, static CRT, portable CPU, compression-free JNI profile; no tests run.
  Initial/final disk observations are refusal checks, not quotas. Selected tool
  hashes and effective CMake configuration are logged, not full attestations.
  No artifact/cache uploads; generated binaries disappear with the runner.
- Fresh independent review found no material workflow/source/permission blocker.
  Java test classes generate JNI headers only; native target does not run them.
- All existing local version/hash/module/resource gates remain unchanged.
  Published Java 10.2.1/native 10.1.3 mismatch and WinSxS refusal still block
  database acceptance. A build result alone will not clear either runtime gate.

## Evidence

- `f2e511a` CI passed all jobs in run `34489837246`; main matched upstream at
  session entry. The prior static reconciliation remains in
  [the native report](docs/ergo-node-native-provenance.json).
- Exact upstream CMake source exposed unconditional Java build downloads and
  JNI test-helper header requirements. The prepared workflow addresses both
  without patching upstream source or widening loader paths.
- PowerShell parsing and local-host refusal passed. Full `npm run check` passed:
  96 files / 1,795 tests, package consumer, pilot, store-crash and spent-set checks.
  Hosted execution and delivered-revision CI remain pending.
- Last [database diagnostic](docs/ergo-node-database-verification.json) loaded
  native version 10/1/3 and stopped before PROCEED on WinSxS COMCTL32.
  Maximum sample gap was 954 ms against a 1 s ceiling. All three images and
  mappings were removed; no write/flush/reopen or disk-full result was shown.

## Next

1. Finish full checks, deliver the reviewed workflow under standing authority,
   dispatch it once, and capture its exact run/revision/report and static output
   or refusal. Keep image mismatch and compile errors; do not automatically
   update inputs, disable warnings or raise limits. Record measured cost.
2. After build feasibility, prepare a retained candidate with complete input,
   Java/JNI and compression-profile evidence. Review actual output and the
   concrete local bundle/native pin patch before any library load. The generated
   compile-only JAR is not silently substituted into the Ergo baseline.
3. Establish narrow WinSxS component provenance separately; retain the sampling
   concern and 1 s ceiling. Retry the existing fixed 64 MiB control only after
   the candidate and module-policy prerequisites are concretely reviewed.
4. Larger sync still requires separate preparation/approval: 30 min, 20 GiB
   disk, 100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum,
   public-peer parser/JRE review. No complete sync combination is shown.

## Open questions

- Runner labels roll; exact image gating can refuse. Recorded selected hashes
  do not prove full toolchain/OS provenance or reproducible outputs. Candidate
  retention/transfer and runtime compatibility remain separate work.
- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Stay with this instance through build qualification: the source, input and
  review context is fresh. This is not measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. This tooling slice closes no end-to-end product gate. Runtime/
  recovery, wallet/transport, authenticated evidence, witness publication and
  custody/rollback assurance dominate remaining effort and may require redesign.
