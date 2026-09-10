# Current work

Updated: 2026-09-10

## Goal

First-sync control feasibility, on `test/ergo-sync-controls`, based on
`462b488`. Acceptance: source-backed control selection and a bounded local
demonstration or reproducible refusal, before enabling any peers.
Companion specification remains `money-from-first-principles/main` at `7ea0ee8`;
this experiment changes no normative rule or runtime configuration.

## Status

- Rootless WSL user/mount/network namespaces and an 8 MiB tmpfs write limit
  passed a fixed local control. This is partial containment evidence, not
  the declared 20 GiB disk / 10 GiB combined traffic contract. No sync ran.
- Native VHD attachment needs `SeManageVolumePrivilege`, absent from the
  normal host process token; administrator role is false. Ordinary tool
  sandbox escalation does not provide Windows administrator elevation.
- Job network rate limits cover outgoing traffic only. Interface sampling
  is not selected as a combined ceiling. A complete control route remains
  open; rootless Linux is a feasible namespace alternative, not disproven.
- Independent review is complete with no unresolved material findings.
  `npm run check` passed: 96 files / 1,795 tests, build, package, pilot,
  store crash and spent-set checks. Sandbox esbuild access refusal was
  resolved by rerunning the unchanged command with normal host access.
  Final docs/links passed. Delivery CI for this slice remains to be checked.
- Startup baseline `462b488` delivery CI
  [34442831180](https://github.com/mediumofexchange/reference-ts/actions/runs/34442831180)
  passed. Upstream refreshed without intervening commits. No branch
  protection or rulesets were present; safeguards remain unchanged.

## Evidence

- [Control selection, sources and limits](docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection),
  [fixed control](experiments/ergo-range/sync-namespace-control.sh),
  [reproduction](experiments/ergo-range/README.md).
- WSL 2 / Ubuntu 20.04, kernel `5.10.102.1-microsoft-standard-WSL2`;
  rootless UID map `0 -> 1000`, length 1. Private namespaces expose only
  `lo`, `tunl0`, `sit0`, with zero observed counters. No external sockets
  are opened by the fixed control.
- tmpfs capacity/write result: 8,388,608 bytes then `ENOSPC` (28). At most
  nine 1 MiB writes; timeout 15 s plus 2 s kill grace. Unmount and empty
  parent mountpoint checked, disposable directory removed. tmpfs consumes
  memory/swap and cannot substitute for the dedicated disk requirement.
- Independent final control passed with inherited `PYTHONOPTIMIZE=1`;
  isolated Python preserves assertions. Root invocation correctly refused
  the `0 -> 0` map before writes, and cleanup left no probe directory.
- Tool inventory was corrected using individual PATH checks. WSL has
  mount/mkfs.ext4/fusermount/ip/tc/Python; fuse2fs/slirp4netns/Java/GCC were
  not found. No complete Linux resource-control contract was demonstrated.
  Windows Job Object results do not constrain Linux guest processes, and
  Windows interop processes do not inherit Linux namespace containment.
- Prior [stock startup report](docs/ergo-node-startup-verification.json) and
  [Windows controls](docs/ergo-node-controls-verification.json) are unchanged:
  no spending key, 200/200/403 GETs, empty history/peers/secret storage,
  finite CPU-rate/memory/process controls. No production readiness or
  reproducible-source-build claim follows from the artifact hashes.

## Next

1. Select one complete first-sync control route. Native fixed-capacity VHD
   retains the measured JVM/job baseline but needs an attach-capable host
   context and a small disk-full demonstration. A rootless Linux route
   first needs a bounded disk-backed filesystem and connected-network
   gateway feasibility, then equivalent CPU/memory/process/JVM evidence.
   Do not build both stacks or treat host inventory as universal impossibility.
2. Preserve 30 minutes, 20 GiB dedicated data, 10 GiB combined traffic,
   existing CPU/memory limits and 100 GiB host disk reserve. Define the
   accounting boundary, include transport/bypass traffic and demonstrate
   stop latency/overshoot within that envelope before enabling peers.
   No host firewall, WSL-wide settings or access-control changes are authorized.
3. Complete effective-settings readback if practical. Then measure a finite
   sync and reproduce all 24 fixture transactions/65 output fields and IDs,
   order and roots, with ancestry to a captured fully validated tip.
4. While host capabilities remain unresolved, source-independent work on
   the authenticated range/replay contract can proceed from the
   [recovery map](docs/POOL_V3_RECOVERY_MAP.md), with specification first and
   independent review. Do not claim mock ranges close the live-source gate.
5. Continue with this Astra instance for the next boundary/design decision;
   current context remains useful. Delegate bounded implementation/checks
   economically once the route is settled. This is a workload judgment,
   not measured comparative model performance.

## Open questions

- No complete sync containment, authenticated ancestry/ranges, production
  node/JRE selection or pool wallet exists. Runtime remains v2 and refuses
  silence clauses. v3 replay/adoption/configuration and runtime remain open.
- About **45% done / 55% remaining**, plausible done range **35–55%**.
  This local control closes no product gate. Largest remaining work:
  evidence/replay/configuration, v3 runtime, wallet/transport, authenticated
  ranges, witness publication and custody/rollback assurance.
- Deployment, public releases, access changes and real funds remain outside
  standing authorization.
