# Current work

Updated: 2026-09-10

## Goal

Next slice: prepare and independently review the smallest offline JRE/RocksDB
control on a newly created fixed 64 MiB VHD with an owned temporary drive letter.
Acceptance: concrete runnable harness, finite resource limits, exact mapping
and loaded-DLL identity, database write/flush/disk-full behavior, final traffic
accounting, empty job and verified mapping/image cleanup. Default is read-only.
Prepare the actual harness before requesting execution: previous elevated
approval covered the native disk worker only, not this worker or mapping.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`;
no normative change, runtime adoption, peers or full-sized allocation.

## Status

- Path prerequisite slice complete at `525bbd5`; instruction/estimate method
  clarification at `9c17c0d`. Delivery branch: `main`; development branch:
  `test/ergo-jre-disk-preparation`. Final handoff follows those commits.
- [Measured JRE path refusal](docs/ERGO_NODE_PREFLIGHT.md#jre-volume-path-prerequisite)
  rules out routing all Java write roots through the old native worker's
  volume GUID path. Prepare an ordinary drive-letter route on the same small
  owned VHD; syntax acceptance alone does not establish mapped-volume I/O.
- Permanent instructions in both workspace and repository AGENTS.md require
  explicit stay/switch advice after every slice without a reminder. Workspace
  instructions are stored locally; the standalone repository rule is committed.
- [Estimate method](docs/PRODUCTION_REQUIREMENTS.md#progress-estimate) now states
  that progress is an engineering judgment against product acceptance, without
  a measured hours ledger, automatic gate score or fixed numerical weights.

## Evidence

- [Path report](docs/ergo-node-volume-path-verification.json): pinned JRE 21.0.1
  rejects GUID root/child through both Paths.get and File.toPath, although
  File.isAbsolute returns true. Drive, extended drive and extended UNC syntax
  pass. No specimen was statted/opened/resolved; no JNI/Ergo classes were loaded.
- RocksDB 10.2.1 JNI extraction calls Files.copy(..., temp.toPath(), ...), so
  its fallback temp route cannot use the measured GUID syntax. This does not
  assert that every java.io or direct native operation rejects GUID paths.
- Compiler: 4,411 ms / 130,850,816 peak commit bytes; probe: 733 ms / 97,480,704.
  Both exit 0 under 30 s / 1 GiB / 25% CPU / one process / 64 KiB output limits,
  with installed limits and empty jobs. Only a 3,142-byte compiled class remains
  at capture. An outer wrapper's stale LASTEXITCODE did not reflect child exit.
- Fresh review verified all 167 bundle files, compiler/JRE/class/source hashes,
  captured JSON, syntax-only call effects and the narrow source inference.
  No material finding remains; mapped-volume/database behavior is still untested.
- Required npm run check passes: 96 files / 1,795 tests, package consumer, pilot,
  store-crash and spent-set checks. Final docs checks pass separately. Scratch
  bundle/compiler/generated class and source copies removed after capture/review.
- Latest fetch had no intervening main commits. Protection absent, rulesets
  empty; previous main `97cdf24` CI passed. Check the final pushed revision's CI
  separately; none of the above claims a new remote CI result before it exists.

## Next

1. Keep node-disk-control.ps1 and its GUID-only guards unchanged. Prepare a
   separate fixed JRE/database control that assigns an unused drive letter only
   to its owned new partition. Verify root-to-GUID and image/disk/partition/volume
   identity before writes; refuse collisions/changed mapping, and read back
   mapping removal plus detachment on cleanup. Never reuse an existing image.
2. Put all identified node/JRE temp/home/log/crash/database paths on that volume.
   Verify actual loaded JNI/optional compression DLLs; java.library.path can
   otherwise find system/cwd libraries before extraction from the pinned JAR.
3. Combine bounded database work with the existing process/traffic controls;
   keep blocking API reads/recursive DB scans out of the traffic observer.
   Exercise missing/late/failing observations, disk full and every exit's final
   accounting. Native/JRE/OS writes and supervisor stalls remain explicit limits.
4. Request execution only after the exact new small harness is reviewable.
   Then prepare the 30 min / 20 GiB / 100 GiB host-reserve sync harness with
   8 GiB traffic trigger and 10 GiB final maximum. Full-size allocation and
   public-peer parser/JRE review remain separate gates.

## Open questions

- Earlier fixed disk, aggregate traffic and effective-settings evidence remains
  in ERGO_NODE_PREFLIGHT.md. It does not prove combined containment, full-sized
  headroom, executed validation, complete retained history or fixture ancestry.
- Runtime remains v2, refuses silence clauses and has no pool wallet. C2.10.13/A8,
  same-index order/A9, authenticated ranges and v3 runtime adoption remain open.
- Switch to a fresh instance for the next mapping/database harness. This thread
  accumulated two preparation slices; the handoff preserves the necessary
  conclusions. This is context-efficiency advice, not comparative benchmarking.
- Estimate reassessed 2026-09-10: retain **45% done / 55% remaining**, plausible
  done range **35-55%**. V3 relations/layout/conformance work supports the modest
  increase over the historical Sep 8 baseline; recent Ergo controls close no
  end-to-end gate. Runtime/recovery integration, wallet/transport, authenticated
  evidence, witness publication and custody/rollback assurance dominate remaining
  effort and can force redesign. The range is judgment, not a statistical interval.
- No public release/deployment, access-control changes, real funds, public peers
  or new elevated/full-sized disk execution are authorized by this preparation.
