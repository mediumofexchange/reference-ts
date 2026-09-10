# Current work

Updated: 2026-09-10

## Goal

Completed native disk-control preparation `4849120`, fast-forwarded from
`test/ergo-disk-control` to `main`. Result: a reviewed fixed 64 MiB create-new VHD helper,
identity guards before storage mutations, bounded disk-full worker and detach
readback, ready for an elevated host attempt. Record ordinary-host refusal
without claiming an attached-volume pass. No full-sized allocation or peers.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`;
no normative change or runtime adoption.

## Status

- Prior delivery CI `34451912372` passed for `6357ed7`. Upstream was refreshed
  without intervening commits. No branch protection/rulesets were present;
  safeguards are unchanged. This slice's delivery CI must be read before
  the next measurement; all local required checks pass.
- The previous traffic control remains valid at its stated boundary: 53,848
  combined interface octets, maximum sample gap 240 ms, 7 ms stop-to-empty
  confirmation. The stricter classifier requires supervisor termination.
  Its recorded-report revalidation repeats no transfer. See the
  [contract and evidence](docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection).
- Independent adversarial review and final readback have no material static
  findings. Fixed subtype selector, failed-create handle ownership and strict
  path endings are corrected. Native compile/ABI and 69 durable cases pass.
- `npm run check` passes: 96 files / 1,795 tests, package, pilot, store-crash
  and spent-set checks. Restricted esbuild startup could not read config;
  ordinary-host rerun passed. Final docs/source hashes are checked separately.
- [Recorded preflight](docs/ergo-disk-control-preflight.json) exits 2 before
  mutation: ordinary host administrator=false, 532,020,400,128 bytes free,
  no disk or worker created. Real disk-full/attachment/detach is unmeasured.
  Ordinary sandbox escalation cannot provide Windows administrator elevation.

## Evidence

- New fixed 64 MiB VHD only; at most 65 MiB accepted backing file. Reject
  reused image/run directory, path redirection and non-local/non-NTFS host.
- Resolve disk from the owned image and cross-check handle physical path,
  size, bus, boot/system flags and identity before initialize/partition/format.
  No disk-number input, drive letter, directory mount, ACL or host-setting change.
- Fill through the new volume GUID path in 1 MiB blocks, at most 65 MiB
  attempted. Require native disk-full 112 after positive writes, volume-size
  and free-space readback, whole-job cleanup, explicit detach/readback.
- Worker: 30 s, 512 MiB commit, 25% host CPU, one process, 64 KiB output.
  Host reserve: 100 GiB plus 65 MiB before, 100 GiB after. Synchronous storage
  setup/detach has no hard deadline; no filesystem isolation is inferred.
- Default command is read-only preflight. An elevated `-Execute` attempt
  retains one bounded detached image and report for inspection. Do not
  automatically rerun, remove failed evidence or widen budgets.

## Next

1. Check delivery CI for the final main revision; local checks pass.
2. The reviewed command for an elevated PowerShell 7 window is documented in
   [reproduction](experiments/ergo-range/README.md). Run one small control only,
   then inspect disk-full, resource, image capacity and detach evidence.
3. Preserve 30 minutes, 20 GiB dedicated data, existing CPU/memory controls,
   100 GiB host reserve and 10 GiB final observed traffic for a future sync.
   A small control does not establish full-sized headroom/timing or all node
   write locations. Independently review public-peer parser exposure before
   peers; retain the no-spending-key boundary and configuration readback gate.
4. Then obtain finite sync/fixture ancestry evidence, or progress the
   source-independent authenticated range/replay contract from the
   [recovery map](docs/POOL_V3_RECOVERY_MAP.md) while host access is missing.
   No mock or response match closes the fully validated source gate.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. No
  complete sync containment, authenticated ranges, validated fixture ancestry
  or production node/JRE selection is established.
- Continue this Astra instance for the next elevated-control evidence/identity judgment;
  bounded tests/tooling can use economical builders with strong independent
  review. Reassess at slice completion; this is not comparative benchmarking.
- About **45% done / 55% remaining**, plausible done range **35-55%**.
  Preparation alone closes no product gate. Largest remaining work:
  evidence/replay/configuration, v3 runtime, wallet/transport, authenticated
  ranges, witness publication and custody/rollback assurance.
- No firewall, WSL-wide settings, access-control changes, public release,
  live deployment or real funds are authorized by this work.
