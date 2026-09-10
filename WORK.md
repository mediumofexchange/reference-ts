# Current work

Updated: 2026-09-10

## Goal

Completed traffic accounting/stop slice `test/ergo-traffic-stop` for `main`,
based on `4af6af4`.
Contract clarification `ff82b2e`; first baseline refusal/source `bae0515`.
Acceptance: counter/refusal cases and a real traffic-triggered whole-job stop,
with final observed bytes and timing inside the small predeclared envelope.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative changes, runtime adoption, Ergo peers or sync in this slice.

## Status

- The [reviewed decision](decisions/2026-09.md#2026-09-10--measure-traffic-and-stop-the-finite-source-probe)
  resolves the original experiment contract: hard disk ceiling plus finite
  traffic accounting/stop, rather than an absolute incoming-wire guarantee.
  Preserve 10 GiB as maximum accepted final observed traffic, with an earlier
  trigger/headroom and measured timing; missing/late/excess evidence refuses.
- Native Windows remains selected, retaining the measured JVM/Job Object.
  The native interface reader replaces the .NET wrapper that refused an
  exposed interface without a usable IPv4 index before any worker/GET.
  That first refusal is preserved at `bae0515`, not reclassified as passing.
- Native control observed a traffic stop: 53,848 combined octets, 240 ms
  maximum sample gap, 7 ms decision-to-empty confirmation. Final reading
  ended 4 ms after that confirmation. No budget was raised.
- Independent native ABI/implementation review and 112 counter checks pass.
  Final classifier requires the supervisor's exact termination exit code,
  closing a natural-exit race. Its 26 cases and recorded-report revalidation
  pass. Raw report/source hashes remain from measured commit `2f1d9bc`;
  no GET was repeated. Final independent readback has no material findings.
  `npm run check` passed: 96 files / 1,795 tests, build/package, pilot,
  store-crash and spent-set checks. Final documentation checks also pass.
- Prior slice CI `34446724693` passed for `4af6af4`. Upstream was refreshed
  without intervening commits. No branch protection/rulesets were present;
  safeguards are unchanged. Delivery CI is pending; read the latest `main`
  run before beginning the next slice.

## Evidence

- [Control contract, native ABI and limits](docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection),
  [current report](docs/ergo-traffic-stop-verification.json),
  [reproduction](experiments/ergo-range/README.md).
- Small native control: 16 KiB stop trigger, 2 MiB maximum accepted final
  observed bytes, 1 s maximum sample gap, 2 s decision-to-empty-confirmation,
  final sample within 1 s of confirmation. Fixed public fixture GET uses
  curl's 64 KiB response/8 s/8 KiB-per-second limits inside a 10 s,
  256 MiB, one-process job. No redirects, retries, proxy or credentials.
- GetIfTable2 exposes logical and physical interfaces without IP-family
  filtering. SDK-checked Windows x64 rows are 1,352 bytes with an eight-byte
  table offset. Checked unsigned receive/send deltas include unrelated
  traffic and duplicate virtual-interface accounting. No .NET zero-index
  fallback remains; memory is released with FreeMibTable.
- Counters cover successful interface data, not physical-wire/ISP billing
  or complete link overhead. Errors/discards, observed reset/change, late
  sampling and overflow refuse. Hidden transient interfaces/reset-regrowth
  remain possible; a permanently stalled supervisor cannot execute a stop.
- Prior [startup](docs/ergo-node-startup-verification.json) and
  [process controls](docs/ergo-node-controls-verification.json) are unchanged.
  The rootless 8 MiB WSL/tmpfs control from `4af6af4` remains separate and
  does not establish dedicated disk, connected traffic or Linux job controls.

## Next

1. Read delivery CI, then prepare the native dedicated-volume disk-full
   control and review every
   write target/cleanup path before execution. Attachment needs
   SeManageVolumePrivilege, absent from the current normal host token;
   ordinary tool sandbox escalation does not provide Windows elevation.
   Finish the concrete helper before requesting any needed physical input.
2. Preserve 30 minutes, 20 GiB dedicated data, existing CPU/memory controls,
   100 GiB host reserve and 10 GiB final observed traffic. Choose first-sync
   trigger/headroom/timing from control evidence; a small pass alone does not
   establish those values. Review public-peer parser exposure independently
   under the no-spending-key boundary before enabling peers.
3. Then complete settings readback and finite sync/fixture ancestry evidence,
   or proceed with source-independent authenticated range/replay contract
   work from the [recovery map](docs/POOL_V3_RECOVERY_MAP.md) while access is
   missing. No mock or response match closes the fully validated source gate.
4. Use a fresh Astra instance for the next native disk boundary: the current
   investigation is captured, and disk setup is a distinct privileged action.
   Use an economical builder for bounded tooling with independent strong
   review. This is a workload/context judgment, not comparative benchmarking.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. No
  complete sync containment, authenticated ranges, validated fixture
  ancestry or production node/JRE selection is established.
- About **45% done / 55% remaining**, plausible done range **35-55%**.
  No product gate closes from this local control alone. Largest remaining
  work: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody/rollback assurance.
- No host firewall, WSL-wide settings or access-control changes, public
  releases, live deployment or real funds are authorized by this work.
