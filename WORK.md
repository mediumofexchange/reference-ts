# Current work

Updated: 2026-09-12

## Goal

Prepare the fixed 20 GiB / 30-minute connected source-sync launcher using the
working ordinary-user node plus elevated disk owner. The standard package and
maintained Java now pass ordinary-token offline startup on a capped VHD and
parent-death cleanup. No connected sync or large allocation has occurred.
Next acceptance: reviewed concrete launcher, then separately authorized bounded
sync producing an applied full-state tip and honest progress/resource evidence.

Delivery: `main`; baseline `a83a5b9` (CI 34687643612 passed).
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change; original fixture provenance pins remain unchanged.

## Status

- [Split evidence](docs/ergo-node-volume-split-verification.json) contains actual
  ordinary-node and parent-death controls. `node-volume-split.ps1` defaults to
  read-only; execution requests UAC only for the disk owner. It creates one
  fresh fixed 64 MiB image and never selects an existing disk or launches peers.
- The ordinary parent creates a fresh named job; the elevated owner opens it
  before publishing the bounded GUID/PID/creation-time handoff. The node joins
  at creation; its token is checked before resume. No ACL changes were needed.
- Owner cleanup verifies the job empty after parent completion/death closes
  future launch admission, then removes its own mapping and VHD. On timeout,
  it stops current members but retains the disk until the parent finishes/dies.
- Official node remains at `scratch/ergo-stable/bundle/`; official Temurin
  21.0.12.1+1 JRE at `scratch/ergo-java/bundle/`. Pinned archives/manifests and
  compiler remain; custom candidates remain deleted. No Java/system install.
- [Prior evidence](docs/ergo-maintained-java-verification.json) covers standard
  storage/startup/settings and four-peer candidate readback. The candidate
  overlay is not enabled by the offline launcher.

## Evidence

- Actual ordinary node: one JVM, 71,409 ms, 440,512,512 bytes peak commit,
  4 GiB commit / 2 GiB heap / 25% CPU / 120-second nominal limit.
- Expected Ergo 6.0.5 genesis UTXO, zero peers, wallet HTTP403, empty secrets
  and 275 loopback socket observations. No chain-membership claim.
- Real host traffic 7,520,534 bytes / 277 samples / 373 ms maximum gap.
  Stop to empty job 48 ms; final accounting finished 6 ms after empty.
- Fixed disk 67,108,864 bytes, backing 67,109,376. Final logical node files
  899,809 bytes, diagnostics 1,156, captured output 4,338. Normal cleanup passed.
- Failure injection killed the dedicated parent with one active Java job
  member. Owner observed parent exit, stopped/verified empty job and removed
  mapping, detached/deleted image. Both images, six recorded process IDs and
  Z logical/DOS reservations were independently absent afterward.
- Independent source/evidence review found and corrected the cleanup loop's
  stale empty-job check; final check follows admission closure. All 13 executed
  source hashes verified. No unresolved material finding.
- Twelve handoff/job and 26 volume-evidence cases passed. Both are now in the
  Windows CI guard step. Full project checks passed: 96 files / 1,795 tests in
  262.70 s, plus docs/typecheck, build/package, pilot, store-crash and spent-set.
  Final docs/links pass separately; inspect delivery CI.

## Next

1. Add named fixed 20 GiB disk and 30-minute process entrypoints; preserve old
   64 MiB / 120-second controls. Keep 100 GiB host reserve, 8 GiB traffic trigger
   / 10 GiB final maximum and bounded diagnostics/readbacks. Review concrete
   code before separate full-allocation/connected-run authorization.
2. Use the measured baseline plus candidate overlay. After bounded sync, compare
   all three fixtures as ancestors of an applied full-state tip; headers or
   /info alone are insufficient. These fixtures use transaction spending proofs.

## Open questions

- A stuck live parent can retain the disk/helper indefinitely after owner
  timeout. Killing the elevated helper may detach before Java exits; helper
  crash ordering is not demonstrated. Same-user IPC/host identity are trusted.
- Synchronous OS calls can stall; observed timing is not independent hard
  enforcement. The volume excludes some OS/JRE/supervisor writes/allocations.
  No 8 GiB threshold stress, general crash recovery or connected sync proved.
- Full block application starts at genesis; incoming proof/snapshot parsing
  remains possible. No proof-quorum workaround.
- Consolidate historical preflight once connected launch is concrete; preserve
  immutable evidence links rather than adding parallel plans.
- Stay with this instance: next work directly extends the reviewed ownership
  and process controls. This is an efficiency recommendation, not a benchmark.
- Estimate **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback dominate remaining effort. No product gate closed here.
