# Current work

Updated: 2026-09-10

## Goal

Prepare the smallest offline JRE/RocksDB control on a newly created fixed
64 MiB VHD with an owned temporary drive letter. Acceptance: runnable fixed
harness, finite limits, exact mapping and loaded-DLL identity, database
write/read/flush/close/reopen and disk-full behavior, every-exit's final traffic
accounting, empty jobs and verified mapping/image cleanup. Default is read-only.
The preparation is implemented; elevated execution has not been performed.

Development branch: `test/ergo-jre-database-control`, based on `1c2d70a`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, runtime adoption, Ergo node, peers or full-sized allocation.

## Status

- New `node-database-control.ps1` keeps the old native disk control unchanged.
  It has no arbitrary disk/path selector and refuses an existing scratch root.
  [Prepared control](docs/ERGO_NODE_PREFLIGHT.md#prepared-offline-database-control)
  and [commands](experiments/ergo-range/README.md) define the exact experiment.
- Six sequential JVMs maximum: compilation, four injected observer refusals
  during database work, then bounded disk exhaustion. Each has 30 s / 1 GiB
  commit / 256 MiB heap / 25% CPU / one process / 64 KiB output. Real per-JVM
  traffic is separate: 1 MiB trigger / 2 MiB final maximum, 1 s observation/final
  delay and 2 s stop-to-empty limits. No real traffic-trigger throughput claim.
- The pinned JNI is extracted to the owned volume and loaded through the
  explicit directory API. Java validates temp/home/cwd/environment roots before
  native load; a supervisor module/hash handshake precedes database access.
  Only exact `IOError/NoSpace` establishes capacity refusal. Killed-case residue
  shares the same disk; bounded final inventory occurs after all jobs are empty.
## Evidence

- Read-only preflight passes without creating a disk or control directory.
  Reproducible compiler check verifies all 167 bundle files, compiler/source/
  class hashes; warning-free compilation and 16 pure Java tests pass. No JNI
  or database experiment ran. Identity/accounting hostile tests pass separately.
- [Preparation report](docs/ergo-node-database-preparation.json) captures final
  source/artifact pins and compilation evidence. 46 identity and 37 accounting
  cases pass. Independent review resolved missing optional compression names,
  alternate JNI paths and a fast-exit marker race; focused readback closed review
  with no unresolved material finding. Actual volume/database behavior is untested.
- `npm run check` passes: 96 files / 1,795 tests, package consumer, pilot,
  store-crash and spent-set checks. Ordinary-host execution was needed after
  sandboxed esbuild could not read its configuration. Windows CI now includes
  safe identity/accounting tests, never the elevated disk experiment.
- Remote main at the final pre-delivery fetch remained `1c2d70a`; branch
  protection absent, rulesets empty. Delivery targets `main`; check the final
  pushed revision's CI separately. Local checks do not imply remote CI passed.

## Next

1. Request execution of the exact reviewed `node-database-control.ps1 -Execute`
   only after preparation is delivered. Prior elevated approval covered the
   native disk worker, not this Java/database worker or drive-letter mapping.
   Pinned bundle/compiler remain as direct inputs until that decision. The
   disposable archive and generated compile copies were removed after capture.
2. If approved, run only this small offline control and preserve every result;
   failures are unresolved, not reasons to widen budgets. Verify all job,
   mapping, image and final traffic results before accepting the composition.
3. Then prepare the separate 30 min / 20 GiB / 100 GiB reserve sync harness,
   with 8 GiB traffic trigger and 10 GiB final maximum. Full-size allocation and
   public-peer parser/JRE review remain separate gates and authorization.

## Open questions

- Synchronous supervisor/storage/module calls can stall; path settings and
  snapshots do not establish a filesystem sandbox or exhaustive native/JRE/OS
  write trace. Preparation proves no mounted-volume/database success, complete
  sync, retained history, fixture ancestry or authenticated range.
- Runtime remains v2, refuses silence clauses and has no pool wallet.
  C2.10.13/A8, same-index order/A9, authenticated ranges and v3 adoption remain.
- Stay with this instance for the bounded execution/readback if approved: its
  harness and review context are fresh. Switch after that result is captured
  if the next slice moves to peer-parser or protocol design. This is expected
  context efficiency, not measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. Preparation closes no end-to-end product gate. Runtime/recovery,
  wallet/transport, authenticated evidence, witness publication and custody/
  rollback assurance dominate remaining work and may require redesign.
