# Current work

Updated: 2026-09-10

## Goal

The authorized fixed 64 MiB offline JRE/RocksDB control was executed and its
refusals diagnosed. Acceptance remains unmet: the pinned DLL reports 10.1.3
while the declared/reviewed dependency is 10.2.1, and the module policy refuses
a loaded Windows side-by-side COMCTL32 component. Stop trials pending artifact
and provenance resolution; no database or disk-full result was demonstrated.

Development branch: `test/ergo-jre-database-execution`, based on `2251836`.
Loader filename correction: `4bad3fc`; final diagnostics/evidence follow it.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, runtime adoption, Ergo node, peers or full-sized allocation.

## Status

- The explicit-directory API requests `librocksdbjnijni-win64.dll`; the harness
  now places the unchanged pinned archive DLL bytes under that basename. Pure
  tests execute the pinned JAR's name calculation; no default lookup is added.
- Java records native major/minor/patch and preserves the exact 10/2/1 gate
  after the bounded module handshake and before database access. The original
  Version.toString() used dotted numbers: the refusal was not a format issue.
- Native DLL SHA-256 remains `0f384322229c35bbb551ecf9bb49794c263e680b80cf8990024f28a69f489bc7`.
  Neither accepting 10.1.3 nor widening module paths is selected. A version
  marker does not establish the DLL's complete source/build provenance.
- All three owned images were detached, hash/size checked and removed; drive
  mappings were removed and absence rechecked. The fixed control root is absent.
  Pinned bundle/compiler remain in scratch as inputs for artifact comparison.

## Evidence

- [Current account](docs/ERGO_NODE_PREFLIGHT.md#prepared-offline-database-control)
  links all three attempts and separate cleanup records. The first failed at
  filename lookup; the second at version validation. Both had empty jobs and
  valid final traffic counters; neither reached database work.
- [Final diagnostic](docs/ergo-node-database-verification.json): JNI output
  reports 10/1/3, matching independent [static export inspection](docs/ergo-node-native-version-export.json).
  The supervisor then refuses WinSxS COMCTL32 before PROCEED: nativeVerified,
  databaseActive and injected are false; no complete module inventory returned.
- Final compiler/worker: 5,928/1,983 ms, 147,804,160/106,655,744 peak commit bytes,
  installed 1 GiB/25% CPU/one-process caps and both jobs empty. Real counters
  are valid at 766,227/10,829 bytes; max sample gaps 294/954 ms; final samples
  finish 5/2 ms after empty. Observer stop to empty takes 10 ms. The shared
  readError contains module-policy refusal, not a missing network sample;
  overall acceptance correctly remains unresolved.
- [Final cleanup](docs/ergo-node-database-cleanup.json) records exact detached
  67,109,376-byte image removal and 531,748,184,064 bytes host free afterward.
- [Preparation](docs/ergo-node-database-preparation.json): 167 bundle files,
  source/compiler/class pins; warning-free compilation and 24 pure Java tests.
  46 identity and 37 accounting cases pass. Independent review checked the
  actual patches, source/class hashes, DLL export, all reports and cleanups;
  no unresolved material code/evidence finding remains. Runtime gates remain.
- Final `npm run check` passes: 96 files / 1,795 tests, package consumer,
  pilot, store-crash and spent-set checks; final docs pass separately. The
  sandbox's test-config read restriction required ordinary-host checks.
  Final fetch has no intervening main change; `2251836` remote CI passed.
  Delivery targets `main`; check the final pushed revision's CI separately.
  Branch protection was absent and rulesets empty at final inspection.

## Next

1. Reconcile the declared dependency, published Windows artifact and native
   source/build provenance. Compare retaining/reviewing the reported older
   native implementation with a consistent Java/JNI artifact. Do not simply
   change the expected version to make this control pass; check API/ABI and
   source correspondence before selecting and independently reviewing a route.
2. Establish narrowly scoped Windows side-by-side component provenance before
   changing the module policy. Retain failure evidence and examine the 954 ms
   observation gap against the unchanged 1 s ceiling; do not widen it by default.
3. Retry the small control only after those choices are concretely reviewed.
   The earlier execution authorization covers this small experiment; it does
   not authorize a larger disk or public peers. No repeated failing trial is
   useful while the same known prerequisites remain unresolved.
4. A later 30 min / 20 GiB / 100 GiB reserve sync harness with 8 GiB traffic
   trigger / 10 GiB final maximum still needs preparation and separate approval,
   plus public-peer parser/JRE review. No complete sync combination is shown.

## Open questions

- Path settings/module snapshots are not a filesystem sandbox or exhaustive
  native/JRE/OS write trace. Supervisor/storage calls can stall; no complete
  database control, retained history, fixture ancestry or authenticated range.
- Runtime remains v2, refuses silence clauses and has no pool wallet.
  C2.10.13/A8, same-index order/A9, authenticated ranges and v3 adoption remain.
- Switch to a fresh instance for artifact/source reconciliation: this slice
  accumulated several execution/failure paths, now preserved in durable evidence.
  Fresh context should be more efficient; this is not measured model performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range
  **35-55%**. This diagnosis closes no end-to-end gate. Runtime/recovery,
  wallet/transport, authenticated evidence, witness publication and custody/
  rollback assurance dominate remaining effort and may require redesign.
