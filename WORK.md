# Current work

Updated: 2026-09-10

## Goal

Exact native candidate and narrow Common Controls policy prepared for the fixed
trusted offline database control. Candidate disposition and actual patch passed
independent adversarial review. No DLL load, JVM trial, volume allocation, peers
or deployment in this slice. Full project validation passed.

Delivery: `main`; baseline `37425da`; source build input `9ea1c16`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change or local toolchain installation.

## Status

- [Decision](decisions/2026-09.md#2026-09-10--prepare-the-exact-native-candidate-for-the-offline-control)
  selects one exact source-built DLL with unchanged stock Ergo Java/JRE for a
  fresh NO_COMPRESSION offline control. Neither earlier binary was adopted;
  equality to it is not a standalone prerequisite for preparing this candidate.
- The harness verifies source ancestors, exact length/hash in preflight, and
  rechecks through one source handle at copy time. CreateNew destination and
  exclusive readback refuse overwrite or altered bytes; no published-DLL or
  generated-JAR fallback. Ordinary trusted host stability remains assumed.
- Module policy admits only the exact reviewed COMCTL32 path/hash/length, refuses
  duplicates and preserves other native/module checks. It compares existing
  snapshot records without additional timed file reads or signature lookups.
- [Current preparation evidence](docs/ergo-node-database-preparation.json) records
  a passing default preflight: exact candidate verified, copied=false, no process
  cases or mutations. Unchanged Java compilation/pure tests reuse `37425da` evidence.
- [Candidate](docs/ergo-native-candidate-verification.json):
  `scratch/retained-native-target/candidate/librocksdbjni-win64.dll`, 8,998,912 bytes,
  SHA-256 `b0370fa9a8afe8942d0d2ccba1557b29ab08472a09da7c1bde7005eca7cdd21c`.
  Its exact run `34507404910` / attempt 1 archive and API/log identity remain
  beside it. Artifact `10165083375` expires 2026-09-11 17:36:32 UTC.
  Prior candidate remains in `scratch/retained-native-review/candidate/`.
- Both readers reproduce 8,608 differing DLL bytes, including 7,202 executable
  bytes. Further inspection classifies all 1,001 `.data` differences as generated
  identifiers. Some function-layout permutations are observed; complete cause,
  native semantic equivalence and reproducibility remain unproved.
- Exact target project, source/build identity and all 36 worker bindings reviewed.
  Seven broader JNI gaps and at most two unclosed default ReadOptions objects
  remain excluded/limited for this worker only; no general Ergo adoption.

## Evidence

- 58 identity/module cases, 21 synthetic file cases and 37 accounting cases pass.
  Independent review reran the first two and passed ten additional probes for
  path/stream/case aliases, duplicate records, existing writers, self-destination,
  refusal nonmutation and small copies. No material preparation finding remains.
- Full npm run check passed: 96 files / 1,795 tests in 279.87 s plus docs,
  typecheck, build, package, pilot, store-crash and spent-set checks.
  Final documentation/link/diff checks pass.
  Baseline `37425da` CI run `34510048192` passed all seven jobs. Check delivery
  CI separately after the resulting commit is pushed.
- Fixed worker, disk/process/traffic helpers, 64 MiB disk, 1 GiB process commit,
  30 s per process, 1 s sampling ceiling and all other bounds remain unchanged.
  The last actual diagnostic's 954 ms sampling gap remains close to the ceiling.

## Next

1. The next observable result is a separately authorized elevated offline control
   on this exact candidate. Preserve the JSON report outside its owned volume;
   require module/version handshake, baseline persistence, NoSpace, final real
   accounting and verified cleanup. No automatic retry or limit widening.
2. Keep `scratch/node-database-control/` absent before a trial. Six sequential
   JVMs at most, no node or peers. The trusted native-process boundary is not
   containment of malicious native code; no database-control acceptance exists.
3. Larger sync still requires separate preparation/approval: 30 min, 20 GiB disk,
   100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum, plus public
   peer parser/JRE review. No complete sync combination is established.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Recommend staying with this instance for the bounded trial and evidence review:
  the exact candidate, refusal conditions and cleanup boundaries are fresh.
  This is an efficiency recommendation, not measured comparative performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  No end-to-end product gate closed. Runtime/recovery, wallet/transport,
  authenticated evidence, witness publication and custody/rollback assurance
  dominate remaining effort and may require redesign.
