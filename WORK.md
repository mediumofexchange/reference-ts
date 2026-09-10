# Current work

Updated: 2026-09-10

## Goal

Next slice: build and review the smallest offline pinned-JRE/RocksDB control
that uses the fixed native data volume and existing process/traffic controls.
Acceptance: a concrete runnable harness with finite limits, loaded-DLL identity,
volume-path compatibility, write-target accounting, database disk-full refusal,
job cleanup and final traffic accounting. Prepare/review before requesting
execution: the old elevated approval covered the fixed native disk worker only.
No peers or full-sized allocation. Companion specification:
`money-from-first-principles/main` at `7ea0ee8`; no normative change or adoption.

## Status

- Preparation slice `1374f5b` and handoff `52eb44f` fast-forwarded/pushed to
  `main`; exact remote parity confirmed. Development branch:
  `chore/ergo-sync-preparation`. This final handoff refresh follows on `main`.
- [Effective settings and write inventory](docs/ERGO_NODE_PREFLIGHT.md#effective-settings-readback)
  and [combined proposal](docs/ERGO_NODE_PREFLIGHT.md#combined-experiment-proposal)
  replace the open-ended source inventory with explicit measured prerequisites.
- [Readback report](docs/ergo-node-settings-verification.json) calls the pinned
  JAR's actual private configuration loader and typed constructors, with no
  node actors, databases, wallet initialization or node API calls.
- Baseline: mainnet, UTXO verification, all blocks retained, absent checkpoint,
  disabled bootstraps/snapshot payloads/mining/extra indexing; test mnemonic
  and test key count absent. Loopback/zero-peer settings are read back too.
- Controls: JVM `blocksToKeep=10` makes typed pruning true; omission of explicit
  null restores the mainnet checkpoint. Both reject the intended profile.

## Evidence

- Compiler plus three sequential readbacks: each 30 s / 1 GiB commit / 25% CPU /
  one process / 64 KiB output. All natural exits, limits read back, jobs empty.
  Readback peak commit <=156,377,088 bytes; 9,231 final run-file bytes; data and
  secrets empty. Compiler is scratch-only ECJ 3.37.0, SHA-256 pinned by launcher.
- Independent review verified all 167 bundle files, config/source/report hashes,
  loader/constructor call graph and controls. Inventory review caught RocksDB's
  native-library search before JNI extraction; loaded-module provenance is now
  an explicit next-control gate. No material preparation finding remains.
- Required `npm run check` passes: 96 files / 1,795 tests, package consumer,
  pilot, store-crash and spent-set checks. Sandboxed esbuild config access failed;
  the normal-host rerun passed. Final documentation changes checked separately.
- Reacquired bundle, compiler, generated class/run files and temporary source
  copies were removed after capture/review. Reproduction is in the experiment
  README. No disk image, node service, peer connection or full sync was launched.
- Final upstream refresh found no intervening commits; branch protection
  absent and rulesets empty. Prior `d7f65cf` CI passed; the new push was not yet
  listed by Actions at readback. Check available CI for the current revision.

## Next

1. Use the inventory's actual stores: history index/objects/extra, state+undo,
   snapshots, wallet registry+undo/storage, peers, secret directory, config temp,
   native DLL and diagnostic paths. Disabling snapshots/indexes still opens DBs.
2. Verify Java/RocksDB accepts the native control's volume GUID path and loads
   the pinned JNI DLL; observe optional compression modules. `java.library.path`
   includes system directories and cwd, so a pinned JAR alone is insufficient.
3. Build bounded database I/O and observer composition: no recursive DB scan or
   blocking API work in the traffic observer; demonstrate delayed/failed samples,
   every exit's final sample and empty-job cleanup. Account for native/JRE/OS
   writes without claiming a filesystem sandbox. Keep the runnable worker small.
4. After review, request execution of that exact small elevated control. Only
   after its evidence passes, prepare the 30 min / 20 GiB / 100 GiB host-reserve
   sync harness with 8 GiB traffic trigger and 10 GiB final observed maximum.
   Full-sized allocation and public-peer exposure remain separate gates.

## Open questions

- Earlier disk evidence at `91055fc`/`eab393f`: 64 MiB fixed VHD, native error
  112 after 51 MiB completed writes, within worker limits, empty job/detached.
  Earlier traffic evidence: 53,848 aggregate octets, 240 ms max gap, 7 ms stop
  to empty. Neither establishes the combined JRE/database/peer boundary.
- A settings readback is not executed validation, complete retained history or
  packet absence. No complete write trace, full-sized headroom or authenticated
  fixture ancestry is established. Public-peer parser/JRE review remains owed.
- Runtime stays v2, refuses silence clauses, and has no pool wallet. C2.10.13/A8,
  same-index order/A9, authenticated ranges and v3 runtime adoption remain open.
- Stay with the current instance for the next bounded harness implementation:
  relevant source/control context is fresh; use a fresh independent reviewer
  for its consequential boundary. This is an efficiency recommendation, not
  measured comparative model performance.
- About **45% done / 55% remaining**, plausible done range **35-55%**. This
  preparation reduces uncertainty, without advancing an end-to-end product gate.
  Main blocks: evidence/replay/configuration, v3 runtime, wallet/transport,
  authenticated ranges, witness publication and custody/rollback assurance.
- No firewall, WSL-wide settings, access controls, public release, live deployment,
  full-sized allocation or real funds are authorized here.
