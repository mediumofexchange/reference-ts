# Current work

Updated: 2026-09-12

## Goal

Stable Ergo v6.0.5 Windows package selected and its actual versioned storage
passed ordinary write, reopen and rollback checks in separate JVMs. Deliver this
bounded result; next prepare stock-node startup/settings against this package.
No sync, peers, deployment, custom native build or host installation.

Delivery: `main`; baseline `6b4ad87`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change; original fixture provenance pins remain unchanged.

## Status

- [Standard route](decisions/2026-09.md#2026-09-10--prefer-the-standard-ergo-distribution)
  now selects the complete stable Windows bundle, using LevelDB rather than the
  prerelease RocksDB migration. No inspected witness-source feature needs v6.1.5.
- [Evidence](docs/ergo-stable-verification.json) records exact package/source pins,
  the successful storage run, independent review and verified scratch cleanup.
- Bundle remains at `scratch/ergo-stable/bundle/`; archive and manifest beside it.
  Jar SHA-256: `2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588`.
  All 164 bundled JRE files equal the earlier stock Java 21.0.1 runtime.
- The custom-DLL trial is suspended. Do not run its prepared scratch launcher.
  Earlier native refusals and source-build evidence remain historical, not gates
  that the stable LevelDB candidate must satisfy.

## Evidence

- Stable commit `5528ef569a41ebccbc8658212e6ee3c97d990b96`: 18 relevant source
  files exactly match the prerelease, covering formats/API/settings and service
  boundaries. This is scoped source fit, not full dependency or binary equivalence.
- Four processes (compiler plus three storage JVMs) exited 0 with empty jobs,
  verified limits and native LevelDB factory selection. Write/update/delete,
  fresh-process reopen, unknown rollback refusal, known rollback and another
  fresh-process reopen passed. No node actors or keys were involved.
- Durations: 3,077 / 10,412 / 10,870 / 10,367 ms; maximum peak commit 145,022,976
  bytes. 136 socket samples observed none. Final 22 files totaled 2,675,278 bytes.
  Independent readback reproduced source/report hashes and the inventory.
- The initial helper compilation failed on an ambiguous Scala bridge method;
  the corrected direct Buffer-to-Seq conversion passed. Its refusal is preserved.
- Normal non-sync writes and close/reopen do not prove crash/power-loss durability,
  disk-full behavior, sync or protocol recovery. Factory identity is observed;
  loaded DLL identity is not hashed. Sampling is not disk/network containment.
- Full project checks passed: 96 files / 1,795 tests in 267.18 s, plus docs,
  typecheck, build/package, pilot, store-crash and spent-set checks. The sandbox
  initially blocked esbuild's config read; the same checks passed on the host.

## Next

1. Reuse the reviewed stock startup/settings helpers with explicit stable-package
   pins and fresh scratch paths. Preserve the no-spending-key, no-peer, loopback
   configuration and record actual startup/settings; do not claim old prerelease
   runtime evidence as a new stable run. Review the changed launcher before use.
2. Resolve only concrete blockers to a bounded source sync. Its existing plan is
   30 min, 20 GiB disk, 100 GiB reserve, 8 GiB traffic trigger/10 GiB maximum plus
   peer-parser/JRE review. Do not revive custom builds without demonstrated need
   or silently relax limits. No full sync combination is established.
3. Then compare the three fixtures against a validated ancestor of a stable tip.
   Full-history retention does not guarantee historical AD proofs; the current
   comparison needs transaction spending proofs. Stable fixture fetch/ancestry
   and authenticated source publication remain owed.

## Open questions

- Stay with this instance for stable startup/settings preparation: the package,
  source equality and reusable controls are fresh. This is an efficiency
  recommendation, not measured comparative model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  Runtime/recovery, wallet/transport, authenticated evidence/publication and
  custody/rollback assurance dominate remaining effort. No product gate closed.
