# Current work

Updated: 2026-09-12

## Goal

Separate elevated disk ownership from ordinary-user Java execution for the
bounded source-sync launcher. The standard node now passes the combined
64 MiB offline volume/process/traffic control. No connected sync or large
allocation occurred. Next acceptance: ordinary-token node access to the owned
volume, fresh bounded handoff and correct cleanup after parent failure.

Delivery: `main`; baseline `9270b31` (CI 34686579835 passed).
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change; original fixture provenance pins remain unchanged.

## Status

- [Volume evidence](docs/ergo-node-volume-verification.json) records the actual
  elevated offline node run. `node-volume-control.ps1` defaults to read-only;
  its only execution is a fresh fixed 64 MiB VHD, with no existing-disk selector.
- It reuses disk ownership/identity, drive mapping, process jobs and traffic
  helpers. No native/process API limits were enlarged or custom library added.
- Complete stable node remains at `scratch/ergo-stable/bundle/`; official
  Temurin 21.0.12.1+1 JRE at `scratch/ergo-java/bundle/`. Both pinned archives
  and manifests retained. Custom candidates remain deleted.
- [Prior evidence](docs/ergo-maintained-java-verification.json) covers standard
  storage/startup/settings and four-peer candidate readback. The candidate
  overlay is not enabled by this offline launcher.

## Evidence

- Real offline control passed: one node JVM, 71,117 ms, 372,654,080 peak commit,
  4 GiB commit / 2 GiB heap / 25% CPU / 120-second nominal limit.
- Expected Ergo 6.0.5 genesis UTXO state, zero peers, wallet HTTP403, 276
  loopback socket samples, empty final secrets. No chain-membership claim.
- Real host traffic: 3,444,749 bytes, 278 samples, maximum gap 309 ms. Stop
  decision to empty job 44 ms; final accounting finished 4 ms after empty.
- Fixed disk 67,108,864 bytes; backing 67,109,376 bytes; NTFS 65,990,656 bytes.
  Final 54 files / 899,803 bytes; diagnostics 1,156 and captured output 4,326.
  Mapping removed, image detached/deleted; >100 GiB host reserve before/after.
- Independent review found duplicate HTTP-reader disposal before execution;
  corrected to once before final accounting. Final diagnostic-byte check added.
  Actual source/package/config/process/traffic/inventory evidence reviewed;
  no material finding. Native check confirmed Z: mapping/reservation absent.
- Twenty-six pure evidence cases and full project checks passed: 96 files /
  1,795 tests in 253.31 s, plus docs/typecheck, build/package, pilot, store-crash
  and spent-set checks. Final docs/link checks pass. Inspect delivery CI.

## Next

1. Implement the smallest privilege split: ordinary main supervisor plus a
   fixed elevated disk owner retaining the VHD handle. Verify the ordinary
   session sees the correct mapped volume and can write to it. Bind a fresh
   handoff to this run; test failure/parent-death cleanup before public peers.
   Do not reuse this elevated offline launcher as a connected node launcher.
2. Add only named fixed 20 GiB / 30-minute disk/process entrypoints when the
   split works. Keep 100 GiB host reserve, 8 GiB traffic trigger / 10 GiB final
   maximum and bounded diagnostics/readbacks. Review concrete code before
   separate full-allocation/connected-run authorization; no automatic budgets.
3. Use the measured baseline plus candidate overlay. After bounded sync, compare
   all three fixtures as ancestors of an applied full-state tip; headers or
   /info alone are insufficient. These fixtures use transaction spending proofs.

## Open questions

- Synchronous OS calls can stall; observed timing is not independent hard
  enforcement. The fixed volume does not contain all OS/JRE writes or host
  supervisor allocations. No traffic-threshold stress or crash recovery proved.
- Full block application still starts at genesis under the selected settings;
  incoming proof/snapshot parsing remains possible. No proof-quorum workaround.
- Reduce historical preflight text once the connected launch is concrete,
  preserving immutable evidence links rather than adding parallel plans.
- Stay with this instance for the privilege split: ownership and cleanup
  evidence is fresh. This is an efficiency recommendation, not a benchmark.
- Estimate **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback dominate remaining effort. No product gate closed here.
