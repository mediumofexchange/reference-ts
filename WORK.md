# Current work

Updated: 2026-09-10

## Goal

First retained Windows RocksDB candidate: verified local import and independent
static DLL/JAR/header/worker inspection are complete. Correct future retention
to the packaged DLL target project; the original run retained its sibling.
This slice performs no native load, runtime adoption, database retry or deployment.

Delivery: `main`; preparation branch: `fix/rocksdb-candidate-target`.
Build input: `373db5058b71370612818f4bb261ea8d25c66fdc`.
Companion specification: `money-from-first-principles/main` at `7ea0ee8`.
No normative change, local toolchain installation, peers or volume allocation.

## Status

- [Run 34502815638](https://github.com/mediumofexchange/reference-ts/actions/runs/34502815638),
  attempt 1, succeeded in 16.99 min compile/static time. Artifact `10163251532`
  expires 2026-09-11 16:50:37 UTC; its raw ZIP is 13,696,641 bytes, SHA-256
  `d3ab87cba4a7d432b182a81f23c21b91215a35e22cf9960efecbc3adceb194f6`.
- Authenticated API/upload-log identity matched before download. Original
  `373db50` importer verified all 105 content files and manifest before extraction.
  Actual candidate and ZIP: `scratch/retained-native-review/candidate/` and
  `scratch/retained-native-review/candidate-34502815638-1.zip`.
  Exact original importer/pins: `scratch/import-373db50/`.
- [Durable evidence](docs/ergo-native-candidate-verification.json) records all
  member hashes, build observations, class/native deltas, import/export facts,
  generated/source signatures and the exact 36-method offline worker path.
  [Build qualification](docs/ERGO_NATIVE_BUILD.md#actual-retained-output) explains limits.
- DLL: `a05f9ba907daf041a5ac9eaec7f241fe012b1aef4b1b844bb1696d392229c5de`.
  All 1,524 exports match pinned generated/source signatures; required worker
  bindings all resolve. Same seven broader gaps; no blanket Ergo compatibility.
- Generated JAR has 258 Java-21 classes and 1,531 natives, including 12 test-helper
  natives. All 1,519 stock native declarations remain unchanged, but Java bytes
  differ. Keep stock Ergo JAR; generated JAR is inspection-only.
- Actual WBWI header uses jclass; source uses jobject without explicit export
  decoration. The resulting mismatch is outside the worker path. No patch or
  placeholder JNI methods. At most two unclosed stock default ReadOptions
  allocations also remain a bounded-worker lifecycle limit.
- Original artifact has `rocksdbjni-shared.vcxproj`; actual packaged target is
  `rocksdbjni.vcxproj`. Stager/importer now require the correct project and reject
  sibling-only old archives. The original candidate still lacks exact-target
  project/complete compile-command evidence; correction needs hosted observation.
- Existing zero-dollar Actions/Packages budgets with prevent_further_usage=true
  were rechecked before dispatch; no settings changed. Package inventory remains
  incomplete because read:packages scope is absent.

## Evidence

- Independent ZIP/PE/class/header/source review reproduced actual member identity,
  1,524 export addresses, 1,531 generated signatures and same seven gaps. Separate
  worker bytecode/source review covered constructors, setters, cleanup/errors and
  callback exclusions. No unresolved material finding in this static-only scope.
- Target correction focused review passed; 47 synthetic archive cases include
  both sibling projects present and rejection of substituted sibling evidence.
- Full npm run check passed: 96 files / 1,795 tests in 254.64 s, plus docs,
  typecheck, build, package, pilot, store-crash and spent-set checks.
- Build-input revision `373db50` CI run `34502530808` passed every job.
  Final delivery CI must be checked for the resulting commit; local checks pass.

## Next

1. Recheck zero-spend budgets, then dispatch the corrected manual build on main
   with retain_candidate=true. Preserve input refusals and import the exact new
   run/digest. Inspect actual rocksdbjni.vcxproj and independently review new bytes;
   prior hashes and the sibling project do not authorize that candidate.
2. Review exact native pin changes and narrow WinSxS provenance before any load.
   Keep fixed 64 MiB controls and unchanged 1 s sampling ceiling. Last diagnostic
   loaded native 10/1/3 and refused COMCTL32 before PROCEED, with 954 ms sample gap;
   all VHDs/mappings were removed and no database control acceptance exists.
3. Larger sync still needs separate preparation/approval: 30 min, 20 GiB disk,
   100 GiB host reserve, 8 GiB traffic trigger/10 GiB final maximum, plus public
   peer parser/JRE review. No complete sync combination is established.

## Open questions

- Runtime remains v2, refuses silence clauses and has no pool wallet. Recovery,
  authenticated ranges, fixture ancestry and v3 adoption remain unestablished.
- Recommend a fresh instance for the next actual-target build/native-module
  review: evidence is durable and a focused context should help the next boundary.
  This is an efficiency recommendation, not measured comparative performance.
- Estimate unchanged: **45% done / 55% remaining**, plausible done range **35-55%**.
  This slice closes no end-to-end product gate. Runtime/recovery, wallet/transport,
  authenticated evidence, witness publication and custody/rollback assurance
  dominate remaining effort and may require redesign.
