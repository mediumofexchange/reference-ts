# Current work

Updated: 2026-09-10

## Goal

Next slice: inventory the stock node's write locations and effective settings,
then define the smallest complete first-sync control route. Acceptance: each
write target accounted for, wallet/validation/history settings explicitly read
back, and a reviewable combined disk/traffic/process experiment with finite
limits. No peers or full-sized disk allocation in this preparation slice.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`;
no normative change or runtime adoption.

## Status

- The fixed native disk-control slice is complete on `main`: code `91055fc`,
  measured evidence `eab393f`. Explicit approval covered the fixed 64 MiB
  elevated test and corrected retries; it does not cover a 20 GiB allocation.
- [The passing report](docs/ergo-disk-control-verification.json) establishes
  native error 112 after 51 MiB completed writes, one worker within its resource
  limits, empty job and detached image. Independent report review found no
  unresolved material findings. The exact detached image and inspected profile
  were removed only after capture, review and separate detached readback.
- Earlier refusals remain historical: `358b070` raw BusType display mismatch;
  `8af9b34` Windows default 64 KiB partition offset; `bf240ec` detached
  PowerShell exiting 0 before the script. Each artifact was captured and
  independently checked detached before removal.
- Raw CIM UInt16 BusType and explicit 1 MiB partition offset are now used.
  Only the trusted disk worker inherits a verified existing parent console;
  all existing node/traffic callers remain detached. No limits were raised.
- Required `npm run check` passes on final code: 96 files / 1,795 tests plus
  package, pilot, store-crash and spent-set checks. Final docs checked separately.
  The normal host is needed for esbuild's configuration access.
- Latest fetch had no intervening main commits; branch protection returned
  absent and rulesets empty. Main was fast-forwarded without rewriting history.
  Refresh remote parity and available CI when resuming; no safeguards changed.

## Evidence

- See [the current control contract and evidence](docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection).
  VHD: 67,108,864 virtual / 67,109,376 backing bytes. NTFS: 65,990,656 bytes;
  free space fell from 53,633,024 to 151,552. Completed 53,477,376 bytes;
  attempted 54,525,952. Worker: 4,746 ms, 69,287,936 peak commit, 273 output
  bytes, one total process, natural exit, limits readback and empty job.
- Worker limits remain 30 s, 512 MiB commit, 25% CPU rate, one process and
  64 KiB output. Host reserve: 100 GiB plus 65 MiB before, 100 GiB after.
  Actual final host free space: 531,929,812,992 bytes.
- All seven recorded source hashes, captured output, completion/partition
  guards and volume bindings were independently checked. Raw CIM/image types
  are not serialized; their checks rely on the reviewed executed path.
- The 79 worker-free fixture/native ABI cases pass. Harmless stdout/exit72
  startup cases and unchanged detached Node sentinel pass. No new console,
  runtime or compiler installed; inherited console is trusted-worker-only.
- Shared console lifetime/control and existing host resources are outside the
  worker job. PowerShell wrote a 192,792-byte startup profile outside the data
  volume. Synchronous setup/detach has no hard deadline; no filesystem sandbox
  or full-sized timing/headroom is inferred. Concurrent project checks mean
  this was not isolated performance benchmarking.
- Earlier traffic control: 53,848 combined interface octets, maximum sample
  gap 240 ms, 7 ms stop-to-empty. Recorded-report classifier requires actual
  supervisor termination; no transfer repeated. Both controls are boundary-only.

## Next

1. Inspect stock-node configuration readback and every node/JRE write target;
   preserve no-spending-key and validation/history boundaries. Review whether
   existing small disk, aggregate traffic and Job Object controls compose.
2. Prepare the finite sync envelope: 30 min, 20 GiB dedicated data, existing
   CPU/memory limits, 100 GiB host reserve and 10 GiB final observed traffic.
   Full-sized allocation needs separate authorization after concrete review.
3. Independently review public-peer parser exposure before peers. Obtain finite
   sync/fixture ancestry evidence or advance a concrete authenticated replay
   consumer from [the recovery map](docs/POOL_V3_RECOVERY_MAP.md). Another
   abstract range wrapper still assumes completeness and closes no source gate.
   C2.10.13/A8 and same-index order/A9 remain open.

## Open questions

- Runtime is v2, refuses silence clauses and has no pool wallet. No complete
  sync containment, authenticated ranges, validated fixture ancestry or
  production node/JRE selection is established.
- Prefer a fresh Astra instance for the next combined-boundary judgment: this
  long slice accumulated host diagnostics that are no longer needed. Bounded
  inventories/checks can use economical agents with strong final review.
  This is a context-efficiency recommendation, not comparative benchmarking.
- About **45% done / 55% remaining**, plausible done range **35-55%**.
  Main blocks: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody/rollback assurance.
- No firewall, WSL-wide settings, access controls, public release, live
  deployment, full-sized allocation or real funds are authorized here.
