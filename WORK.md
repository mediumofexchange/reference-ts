# Current work

Updated: 2026-09-10

## Goal

Qualify a consistent RocksDB Java/native candidate for the bounded offline
Windows control. Static artifact reconciliation is complete; no native code
was run in this slice. The published 10.2.1 Windows package combines newer
Java classes with native executable bytes matching published 10.1.3.
Database acceptance remains unmet; keep trials stopped and all guards intact.

Development branch: `docs/rocksdb-native-provenance`, from `ee88a47`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, native adoption, Ergo peers or full-sized allocation.

## Status

- All 253 RocksDB Java classes and the native DLL in the pinned Ergo JAR
  match the published Maven 10.2.1 Windows classifier. The mismatch is
  already present in that dependency, not the harness's extraction.
- Published 10.1.3 and 10.2.1 DLLs differ in only 36 metadata bytes; complete
  executable sections match. Both embed source commit `5823cf08...`, tag
  v10.1.3 and native version 10/1/3. Eleven Java class files differ.
- Distribution identity and executable-byte correspondence do not establish
  complete build provenance or mixed-version API/ABI compatibility.
- The [route decision](decisions/2026-09.md#2026-09-10--qualify-a-consistent-windows-database-build)
  prefers preparation of a source-controlled native 10.2.1 build for the
  current Java baseline. Independent review accepted this preparation choice;
  adoption and database acceptance remain unresolved. Delivery targets `main`.
- The 10/2/1 gate, native hash, module paths, 1-second sampling ceiling and
  resource budgets remain unchanged. No compiler or replacement DLL installed.

## Evidence

- [Static report](docs/ergo-node-native-provenance.json): all archive/member
  hashes, class comparison, PE sections, version export, every differing byte,
  exact source refs, reproduction method and evidence limits.
- [Current account](docs/ERGO_NODE_PREFLIGHT.md#published-windows-native-reconciliation)
  relates the published mismatch to the existing execution refusals. Independent
  ZIP/PE parsing reproduced the core static claims and metadata locations.
  Exact source endpoints expose a histogram mapping difference; no executed
  DLL failure or Ergo call-path reachability is claimed.
- Prior [database diagnostic](docs/ergo-node-database-verification.json) reached
  neither accepted JNI handshake nor database work: the version is 10/1/3 and
  the module policy refused WinSxS COMCTL32. Its maximum sample gap was 954 ms.
  Both jobs were empty with valid final counters. All three owned images and
  drive mappings were removed; the fixed control root remains absent.
- Previous `ee88a47` CI passed all jobs in run `34488164778`. This slice changes
  documentation/evidence only; `npm run check:docs` and diff checks pass.
  Verify the final pushed revision's CI separately.

## Next

1. Prepare a bounded build-feasibility plan for pinned native 10.2.1: inventory
   installed compiler/JDK/CMake, resolve immutable build/dependency inputs,
   select explicit compression features, and estimate disk/time cost before
   installing or building. Inspect Java/JNI mapping and source differences.
   If Windows requires disproportionate work, compare the mixed-package review
   and Linux control costs using concrete evidence rather than changing a gate.
2. Before any candidate load, review its actual source/flags/output hashes and
   bundle/module-pin patch. Separately establish narrow Windows side-by-side
   component provenance. Preserve the 954 ms timing concern and 1 s ceiling.
3. Retry the fixed 64 MiB offline control only after those prerequisites are
   concretely reviewed. Existing execution authority covers that small control;
   it does not authorize larger disks or public peers. Do not repeat a known
   failing trial with the unchanged candidate.
4. A later 30 min / 20 GiB / 100 GiB reserve sync harness with 8 GiB traffic
   trigger / 10 GiB final maximum still needs preparation and separate approval,
   plus public-peer parser/JRE review. No complete sync combination is shown.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet.
  C2.10.13/A8, same-index order/A9, authenticated ranges and v3 adoption remain.
- Native/JRE/OS write coverage, stalled supervisor/storage behavior, retained
  history, fixture ancestry and authenticated ranges remain unestablished.
- Stay with the current instance for the bounded build-feasibility plan: the
  artifact and review context is fresh. This is an efficiency recommendation,
  not measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. This reconciliation closes no end-to-end gate. Runtime/recovery,
  wallet/transport, authenticated evidence, witness publication and custody/
  rollback assurance dominate remaining effort and may require redesign.
