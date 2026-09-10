# Windows native build qualification

Status: 2026-09-10, retained candidate imported and statically inspected; runtime
adoption and exact packaged-target project evidence remain open.
This implements the [preparation preference](../decisions/2026-09.md#2026-09-10--qualify-a-consistent-windows-database-build).
The [published artifact mismatch](ERGO_NODE_PREFLIGHT.md#published-windows-native-reconciliation)
and the existing database-control refusals remain unresolved for execution.

## Observable result

Build the pinned RocksDB 10.2.1 source with an explicit, compression-free
Windows x64 configuration. Record source/tree, image, selected tool hashes,
configuration, output hashes, static imports/exports and elapsed/storage
observations. Success means compilation completed under those inputs; it does
not establish Java/native runtime compatibility, reproducibility or database
acceptance. No output DLL is loaded and no native or Java test is executed.

The [manual workflow](../.github/workflows/rocksdb-native-build.yml) runs only
on `main` or the named `test/rocksdb-retention-preparation` development branch of
the public `mediumofexchange/reference-ts` repository, on a
standard `windows-2022` runner. There are no schedules, secrets, credential
persistence, cache uploads or release steps. Its token has `contents: read`.
The sole boolean dispatch input, `retain_candidate`, defaults to false:
logs retain the report and static inspection, and binaries disappear with the
runner. An explicit true value stages the [bounded one-day candidate](#bounded-candidate-retention)
for separate static review. Neither mode adopts or loads the output.

Development-branch dispatch tests reviewed input/diagnostic changes before
merge; it does not waive independent review or final project checks. Both
workflow and script reject every other ref. This replaces the initial
main-only development cycle, which forced unverified input assumptions into
main before the first hosted observation. Runtime execution stays separately
gated regardless of branch.

## Host and route choice

Read-only inventory on 2026-09-10 found Windows 10 Education build 19045,
17,048,907,776 bytes physical memory, four logical processors and
531,721,535,488 bytes free on C:. PATH exposes Oracle Java 8; the known Java
directory contains a JRE, and the pinned Ergo bundle contains a Java 21.0.1
JRE without a full JDK. No compiler, CMake, Ninja, javac or dumpbin was found
on PATH. The normal Visual Studio/Installer, LLVM, CMake and Windows Kits
locations were absent. This is a scoped inventory, not an exhaustive disk
search. WSL2 Ubuntu 20.04 is installed but stopped; no Linux tools were run.

A local Visual Studio/JDK/SDK installation adds substantial unmeasured host
state. WSL changes the database and host-control baseline. The public
repository already has successful standard Windows CI jobs. Prefer its
disposable runner for build feasibility, keeping the existing local process,
disk and accounting controls for a later reviewed runtime candidate.
[GitHub documents free standard-runner use for public repositories](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The default logs-only mode does not consume artifact-storage allowance under
the [billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
Opt-in retention uses the account's included storage and requires the separate
storage/budget check described below.

## Inputs and configuration

The [input manifest](../experiments/ergo-range/native-build-inputs.json) pins
RocksDB commit `4b2122578e475cb88aef4dcf152cccd5dbf51060`, image version
`20260830.290.1` or `20260907.297.1`, CMake 3.31.6, Java 21.0.12.1 and Windows SDK 10.0.19041.0.
The [image source](https://github.com/actions/runner-images/blob/3e99119430a6c4ead03a20a2a4020a71782eede1/images/windows/Windows2022-Readme.md)
lists Visual Studio 2022 and those tools (Java as `21.0.12+101.0`), as does the separately inspected
[preceding image](https://github.com/actions/runner-images/blob/81f6fba751cfd9688d726f4981cd9798305a1985/images/windows/Windows2022-Readme.md).
The script refuses any other image;
it selects and records the installed MSVC 14.44 toolset and passes its exact
version to CMake. Image labels can change: this is a refusal gate, not a claim
that GitHub permits immutable runner selection. Selected tool/header/library
hashes are observations, not a complete transitive toolchain attestation.

Both repository checkouts use the fixed checkout action commit
`11d5960a326750d5838078e36cf38b85af677262`. The source checkout is shallow at
the exact RocksDB commit, with no tracked diff before or after compilation.
Keep its own Git metadata: an unpacked source archive inside this repository
could otherwise let upstream version generation discover the parent checkout.
For comparison, the exact-commit codeload ZIP downloaded during preparation
was 15,183,601 bytes, SHA-256
`5537b7e494daec8cd34fc41ad54fffff0ab528afad9908d38c75104614470ef6`;
the workflow uses Git, not that archive.

The [pinned root CMake configuration](https://github.com/facebook/rocksdb/blob/4b2122578e475cb88aef4dcf152cccd5dbf51060/CMakeLists.txt)
uses C++17, MSVC static CRT (`WITH_MD_LIBRARY=OFF`), portable CPU settings,
static RocksDB linked into the JNI DLL, and C++ warnings as errors. Third-party
discovery, compression codecs, gflags, jemalloc, liburing, dynamic extensions,
native tests, benchmarks and tools are disabled explicitly. Compression-free
output serves only the small offline control profile; it cannot silently
replace the stock Ergo database profile or read arbitrary compressed data.

The [pinned Java CMake configuration](https://github.com/facebook/rocksdb/blob/4b2122578e475cb88aef4dcf152cccd5dbf51060/java/CMakeLists.txt#L550)
unconditionally checks/downloads five test JARs, even with `WITH_TESTS=OFF`.
Their exact Maven URLs, lengths and SHA-256 hashes are prefilled and verified:
JUnit 4.13.1, Hamcrest 2.2, Mockito-all 1.10.19, CGLIB 3.3.0 and AssertJ 2.9.0,
3,144,161 bytes total. A nonexistent local `CUSTOM_DEPS_URL` prevents fallback
to the unpinned S3 downloads if the existence assumptions stop holding.
These are build classpath inputs, not runtime project dependencies.

Upstream JNI sources also include test helper wrappers. Build
`rocksdbjni_test_classes` first to generate their JNI headers, then the
`rocksdbjava` target, which builds and packages `librocksdbjni-win64.dll`.
Java compilation is not test execution. Do not invoke `ctest`, `java` with the
candidate on its native search path, the generated launcher or an all-target
test command. The existing Java/JNI API mismatch still needs runtime checking
after a concrete retained candidate and its module policy are reviewed.

## Bounds, checks and remaining gates

The [first run](ergo-native-build-first-refusal.json) at `b304e34` refused in
110 ms before configure or compilation: GitHub delivered `20260830.290.1`
despite the newly published `20260907.297.1` image. Its recorded
`imageSourceCommit` is the expected manifest reference, not the delivered
image's source. Inspection of both immutable manifests found the same OS,
CMake, Java, Visual Studio and installed SDK versions; listed changes concern
other software. Explicitly qualify these two images, recording which one ran,
and refuse all others. The two manifest hashes do not attest the live VM.
Also disable upstream's default-enabled trace-tool target explicitly; the
named JNI target did not depend on it, but the declared configuration should
match the generated graph. Independent readback reproduced both manifest hashes,
confirmed the unchanged listed build tools and accepted the bounded retry.

The [second run](ergo-native-build-second-refusal.json) at `ef091de` accepted
the delivered image and exact source tree, then refused the JDK version in
616 ms, before configure or downloads. The report omitted the actual JDK
release text. Record tool version evidence before its corresponding check so
the next diagnostic can distinguish an input mismatch from a parsing defect;
the JDK gate itself remained unchanged for that diagnostic.

The [diagnostic run](ergo-native-build-jdk-diagnostic.json), `34495391755` at
`443d84b`, recorded `JAVA_VERSION="21.0.12.1"`,
`JAVA_RUNTIME_VERSION="21.0.12.1+1-LTS"` and Eclipse Adoptium as implementor.
The runner manifest's `21.0.12+101.0` toolcache spelling was incorrectly
interpreted as the release-file version. The recorded version agrees with
the [official Temurin release](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1).
Correct the exact pin to `21.0.12.1`; keep the same exact-match check and all
other input/runtime limits. This is observed provider metadata, not an
independent attestation of the installed JDK binaries.

One manually dispatched job has a 30-minute platform timeout and build
parallelism two. Refuse less than 8 GiB free before the build; accept at most
8 GiB observed scratch use, at least 2 GiB final free and at most 32 MiB each
for the DLL/JAR. These are initial/final observations, not disk quotas or a
process-memory limit. The standard runner supplies the machine boundary;
no local host resource envelope or worst-case compile cost is inferred.
The initial estimate was 5–25 minutes and 2–6 GiB scratch; the measured result
below replaces that estimate for this one configuration. Keep failures rather than automatically
raising limits, updating the image or disabling warnings.

The script parses with PowerShell and refuses execution on the local host
before any mutation. Full `npm run check` passed (96 files / 1,795 tests plus
package, pilot, store-crash and spent-set checks); independent workflow/source
review found no material blocker. A later local parallel rerun failed one
30-second fault-evidence test timeout and two Vitest `onTaskUpdate` RPC
timeouts (1,794/1,795 tests passed). The unchanged failing file then passed
all ten cases with one worker; its large-suffix case took 1,975 ms. This
supports contention as the cause, not a proved diagnosis. The full check
sequence then passed with one worker and unchanged deadlines: 96 files /
1,795 tests in 420.46 s, plus docs, typecheck, build, package, pilot, store-crash
and spent-set checks. Preparation `b304e34` CI also passed in run `34492285718`.
Final `e917849` full `npm run check` passed with default workers: 96 files /
1,795 tests in 277.97 s and every subsequent check. The earlier timeout remains
recorded above; no test deadline or implementation was changed.
Cross-platform project CI also passed all jobs for `e917849` in
[run 34497461262](https://github.com/mediumofexchange/reference-ts/actions/runs/34497461262).
No version/hash/module gate in the local database harness changes here.

## Successful compile-only result

[Run 34495975811](https://github.com/mediumofexchange/reference-ts/actions/runs/34495975811)
at `e9178497a22162d13958085d096fd4df54715c4b` passed. The
[build report](ergo-native-build-verification.json) records the exact source
and tree, image `20260830.290.1`, Temurin 21.0.12.1, CMake 3.31.6 and
MSVC toolset 14.44.35207. Compilation and static inspection took 985,526 ms
(16.43 minutes), with 780,178,640 bytes of final scratch files (744.0 MiB).
Free disk was 157,792,608,256 bytes initially and 157,050,720,256 finally.
This is one observation, not a worst-case bound or reproducibility result.

- DLL: 8,998,912 bytes, SHA-256
  `dc4b067b3a6fb9d30f6b2b8d384918c4eacd51d6ae1ea2c2b051f5f46354affe`.
- JAR: 3,991,103 bytes, SHA-256
  `5c9bc052737d6f88b14a999e69889f50e8bb4a5c06a7950d04e66fcb44131e3f`.

[Static inspection](ergo-native-build-static.json) retains all 1,524 export
names/RVAs and direct imports: SHLWAPI.dll, RPCRT4.dll and KERNEL32.dll.
The published baseline had 1,603 exports; the [static comparison below](#javajni-name-compatibility)
accounts for the difference and identifies unresolved Java bindings. Semantic
compatibility remains open before adoption. Import names do not
authenticate the eventual loaded Windows components or their transitive graph.
The generated binaries were not retained; a later build is a new candidate
whose actual bytes must be captured and reviewed, not assumed to match these hashes.

Independent output review found no compile-feasibility contradiction and
retained these evidence limits:

- CMakeCache retains baseline `/MD` flags. The pinned source appends `/MT`
  through normal variables when `WITH_MD_LIBRARY=OFF`, shadowing the cache;
  static imports are consistent with that selection. Cache text is not a
  complete record of compiler invocations.
- JDK 8 `javah`/`idlj` cache discoveries are unused by the selected modern JNI
  header-generation branch. Both Java builds emitted three source-8/bootstrap
  option warnings; C++ warnings-as-errors does not apply to those Java warnings.
- Shallow exact-commit checkout has no tags, so `git describe` reported no
  names. Generated build metadata records the correct commit, empty tag and
  `HAS_GIT_CHANGES=0`; source diff checks passed before and after compilation.

Before a local trial: retain and independently inspect an actual candidate,
establish its full input/Java linkage evidence, handle compression-profile
differences, review the exact bundle/native pin change and narrow WinSxS
component provenance. The prior 954 ms sampling gap remains close to the
unchanged 1-second ceiling. Neither build success nor static exports satisfy
those gates; the fixed 64 MiB database control has not yet passed.

## Java/JNI name compatibility

Static comparison on 2026-09-10 found **seven native declarations without a
matching export in the compile-only build**, four more than in the published
Windows DLL. The [machine-readable evidence](ergo-native-jni-compatibility.json)
retains the complete difference, missing descriptors, unused exports, class
hashes and source hashes. This closes the export-count question and rules out
a blanket compatibility claim. It does not adopt or execute a candidate.

Rehashed the complete pinned Ergo 6.1.5 JAR and its embedded published DLL,
matching the [earlier provenance](ergo-node-native-provenance.json). Enumerated
all 253 `org/rocksdb/` class files, including eight below `util/`, and read
their class-file method tables: 1,519 declarations carry `ACC_NATIVE`.
Descriptors and static/instance flags come from compiled classes, not a
source regex. Compared the DLL's PE export-name directory with the hosted
build's retained export list; the built DLL and generated JAR are unavailable.
The exact-commit source archive also matches the previously recorded hash.

| Static quantity | Published DLL | Compile-only build |
|---|---:|---:|
| Named exports | 1,603 | 1,524 |
| Java declarations with a matching name | 1,516 | 1,512 |
| Java declarations without a matching name | 3 | 7 |
| Exports unused by these Java declarations | 87 | 12 |

Applied the [Java 21 JNI name rules](https://docs.oracle.com/en/java/javase/21/docs/specs/jni/design.html#resolving-native-method-names):
search the escaped short name first, then the long name containing the
argument descriptor. No short-name match aliases multiple native overloads
in these inputs. Name coverage does not check return types, calling
conventions, callbacks, argument semantics or runtime behavior.

There are no added exports. The 79 removed names partition exactly as follows:

- **71 `LZ4_*` exports**, consistent with the explicit compression-free build.
  None is the JNI name of a native declaration in the pinned Java classes.
- **Four obsolete option bindings**: `setMaxWriteBufferNumberToMaintain` and
  `maxWriteBufferNumberToMaintain` on both `Options` and `ColumnFamilyOptions`.
  These are absent from the pinned Java declarations and 10.2.1 JNI source.
- **Four still-declared option bindings**: `setFailIfOptionsFileError(JZ)V`
  and `failIfOptionsFileError(J)Z` on both `Options` and `DBOptions`.
  The public Java methods still call these private static natives. The
  10.2.1 Java source retains them, while `java/rocksjni/options.cc` has no
  corresponding implementation. This is a source/binding gap, not evidence
  that a compression switch removed an otherwise available JNI method.

The 12 remaining unused build exports are JNI test helpers: six exception
helpers, one comparator helper, three write-batch internal helpers, one
write-batch contents helper and one event-listener helper.
The exact names are retained in the JSON evidence. They correspond to the
upstream test-helper sources included in the build; the stock Ergo class set
contains none of their declaring classes.

Three further declarations lack names in both DLL export sets:

| Declaring class and method | Pinned-source evidence and scope |
|---|---|
| `LiveFileMetaData.newLiveFileMetaDataHandle` | Public wrapper calls a private native; no matching JNI definition was found. `export_import_files_metadatajni.cc` includes its header but only defines disposal of `ExportImportFilesMetaData`. |
| `RocksEnv.disposeInternalJni(J)V` | `env.cc` defines the old `disposeInternal` spelling. `Env.getDefault()` disowns the singleton handle, so that ordinary close path need not call this native. This does not establish every environment lifecycle. |
| `WBWIRocksIterator.refresh0Jni(J)V` | A source definition exists in `write_batch_with_index.cc`, but neither recorded export set contains its JNI name. Source presence alone does not prove Windows export availability. |

No `RegisterNatives` or `JNI_OnLoad` occurrence was found under the pinned
`java/` source tree. These are unresolved names under ordinary JNI lookup;
no runtime failure was reproduced and no whole-Ergo reachability claim follows.
The reviewed [database worker](../experiments/ergo-range/NodeDatabaseControl.java)
does not directly call the missing wrappers. Its fresh database, explicit
`NO_COMPRESSION` for ordinary and bottommost data, and disabled automatic
compactions fit the intended narrow offline profile. That source inspection
does not prove every transitive call or any retained candidate's runtime result.

The pinned Java CMake list includes all 85 `java/rocksjni/*.cc` files; no
translation-unit omission explains the missing names. Independent readback
used a separate ZIP/class parser and PE export-address parser. It reproduced
the archive/class hashes, declaration/export digests, missing and unused lists,
and all source hashes in the report. It found no short-name overload collisions,
zero published export addresses or published forwarded exports. Source and
prose review found no unresolved material finding within this static scope.
The discarded candidate's export addresses and generated Java classes could
not be independently examined. Documentation and link checks passed; unchanged
runtime checks reuse `e917849` evidence above.

### Compression and next acceptance boundary

Root CMake explicitly disables codec discovery in the qualified configuration;
`util/compression.h` selects support through compile-time codec macros.
The absence of LZ4 exports supports that profile but is not a complete codec
inventory of the published DLL. A successful no-compression control would
establish neither decoding of previously compressed data nor the stock Ergo
configuration. Do not substitute the compile-only JAR for the pinned Ergo JAR.

Bounded retention/transfer below supports inspection of the narrow offline
candidate's actual DLL, generated JAR, export addresses, Java descriptors,
JNI signatures and build configuration. Preserve the seven gaps as explicit
exclusions; demonstrate the control's required call path before relying on it.
A general Ergo replacement must resolve the binding
gaps and compression profile separately. Do not add placeholder JNI methods
or relax the native version, module or resource gates to make adoption pass.
WinSxS provenance and the previous 954 ms sampling gap remain separate blockers
to the fixed 64 MiB control.

## Bounded candidate retention

[Run 34502815638](https://github.com/mediumofexchange/reference-ts/actions/runs/34502815638)
at `373db5058b71370612818f4bb261ea8d25c66fdc`, attempt 1, successfully retained
one candidate. The [candidate report](ergo-native-candidate-verification.json)
records independently read API/upload-log identity, raw archive verification,
all member hashes, build observations and the static worker call path. The
original successful run remains logs-only; this candidate has new DLL/JAR hashes.

The [stager/importer](../experiments/ergo-range/native-candidate.ps1) selects
only these outputs from one successful build:

| Members | Maximum uncompressed bytes |
|---|---:|
| DLL and JAR | 32 MiB each |
| All post-generation `source/java/include/org_rocksdb_*.h` | 256 files, 256 KiB each, 8 MiB together |
| `rocksdbjni.vcxproj` (packaged DLL target) | 4 MiB |
| Build report, CMake cache, export report, import report | 1 MiB each |
| `build_version.cc`, reviewed input manifest | 64 KiB each |
| Transfer manifest | 256 KiB |

At most 300 content files and 80 MiB of content are accepted, plus the transfer
manifest. The downloaded ZIP must fit 81 MiB. Filenames are allowlisted, source
paths must be ordinary paths below repository scratch, and existing staging or
import destinations are refused. No source tree, build dependency JARs, compiler
installation, credential file, PDB or unrelated workspace output is uploaded.
The generated project complements the cache's incomplete compiler-flag evidence.
The first retention revision `373db50` selected `rocksdbjni-shared.vcxproj`,
a sibling target. Pinned Java CMake lines 792-806 create both targets, but
lines 846-850 name the `rocksdbjni` output and lines 878-883 package that target
into the JAR. Future staging/import requires its exact `rocksdbjni.vcxproj`;
the old sibling-only archive requires the original revision's importer and
cannot satisfy the corrected target-evidence requirement. No artifact is
renamed or reinterpreted to hide this gap. Neither project is a complete
compiler-invocation or transitive toolchain attestation.
Headers, built Java classes and exports let the next review investigate the
unresolved `WBWIRocksIterator` signature/export boundary using actual output.
The [pinned CMake source](https://github.com/facebook/rocksdb/blob/4b2122578e475cb88aef4dcf152cccd5dbf51060/java/CMakeLists.txt#L564)
explicitly generates main and test headers into the source checkout's
`java/include`, not the build directory. Those headers are ignored upstream;
a clean tracked-source diff does not attest their generated bytes. The stager
enumerates and hashes the actual post-generation files.

The manifest binds source/workflow commit, run ID, run attempt and every member's
name, byte count and SHA-256. The retained build report must agree on identity,
DLL/JAR hashes and non-execution status; retained input bytes must match the
reviewed input file. File identity is evidence about these bytes, not a build
attestation or proof of runtime safety. `elapsedMs` remains the compile/static
inspection duration before staging; existing scratch/free-space observations
also precede the at-most-80-MiB staging copy.

The workflow uses [upload-artifact v4.6.2](https://github.com/actions/upload-artifact/tree/ea165f8d65b6e75b540449e92b4886f43607fa02)
at its verified commit. It uploads only after successful compilation and staging,
with one-day retention, zero compression, no hidden files and no overwrite.
The name includes run ID and attempt. Logs record artifact ID and archive SHA-256.
The minimum one-day expiry is automatic; no release or deployment is created.

### Storage prerequisite and transfer

Read-only account checks on 2026-09-10 found the organization on GitHub Free,
whose [included artifact allowance](https://docs.github.com/en/billing/reference/product-usage-included)
is 500 MB and is shared with Packages. Existing organization-level Actions and
Packages budgets were both zero dollars with `prevent_further_usage=true`.
The billing usage summary had no storage rows; the only unexpired artifact in
the four repositories was 7,454 bytes. Package inventory returned HTTP 403 for
missing `read:packages` scope, so it is not a complete inventory of shared usage.
The existing zero-spend budgets are the spending safeguard; no billing settings
or access controls were changed. Recheck those budgets before each retained run.
If the storage quota refuses an upload, retain that refusal and keep the budget.

After a reviewed retained build succeeds:

1. Read the exact workflow run and artifact metadata through the authenticated
   GitHub API. Check repository, full workflow commit, successful completion,
   run ID/attempt, expected artifact name, non-expiry, advertised size at most
   81 MiB and archive digest matching the successful upload log. Use the exact
   artifact ID, never a latest-by-name selection.
2. Save the raw response from `GET /repos/mediumofexchange/reference-ts/actions/artifacts/{artifact_id}/zip`
   to a fresh file below ignored `scratch/`. For CLI transfer, PowerShell 7.4+
   native stdout redirection preserves the bytes from `gh api`; check its exit
   code. Do not use `gh run download`, which extracts before these checks.
3. Dot-source `experiments/ergo-range/native-candidate.ps1` and call
   `Import-NativeCandidate` with `-Archive`, the independently read
   `-ArchiveSha256`, full `-WorkflowCommit`, `-RunId`, `-RunAttempt` and an absent
   `-Destination` below scratch. Do not obtain expected identity from the ZIP.
4. Inspect the retained DLL/JAR/header/project combination independently. The
   seven JNI name gaps, compression exclusions and runtime/module gates remain.
   A verified transfer is not authorization to load the candidate or replace
   any pinned bundle file.

Archive/member hashes, types, names and bounded stream lengths are checked
before extraction. JSON must have scalar identity fields, exact boolean
non-execution fields, bounded integer lengths and no duplicate properties.
The importer holds the archive open without write/delete sharing, writes into
a fresh random partial directory, then renames it to the requested destination
only after success. On write failure it removes its own partial output. This
does not provide isolation from a hostile process concurrently modifying the
local scratch directory.

These are artifact-size and acceptance bounds, not a network-traffic quota or
whole-process memory ceiling. The GitHub transfer has an advertised-size
preflight and the importer checks actual archive bytes; ZIP central-directory
metadata and JSON parsing still allocate memory within their input bounds.

### Actual retained output

The run accepted image `20260830.290.1`, Temurin 21.0.12.1, CMake 3.31.6 and
MSVC toolset 14.44.35207. Compilation/static inspection took 1,019,452 ms
(16.99 minutes), observing 780,378,258 bytes of scratch before staging.
Artifact `10163251532`, named `rocksdb-candidate-34502815638-1`, advertised and
downloaded exactly 13,696,641 bytes. Its API and upload-log digest both matched
the raw ZIP SHA-256 `d3ab87cba4a7d432b182a81f23c21b91215a35e22cf9960efecbc3adceb194f6`.
The advertised expiry is 2026-09-11 16:50:37 UTC; local verified bytes remain in
ignored scratch for the next static/adoption preparation step.

The original `373db50` importer validated all 105 content members, 13,660,092
bytes plus manifest, before extraction. Its unchanged Git blob was checked
before use. This archive retains the sibling project described above; the
corrected current importer deliberately refuses that old member selection.
Existing zero-dollar Actions/Packages budgets were rechecked before dispatch;
no billing or access setting changed. The package inventory limit remains.

| Output | Bytes | SHA-256 |
|---|---:|---|
| DLL | 8,998,912 | `a05f9ba907daf041a5ac9eaec7f241fe012b1aef4b1b844bb1696d392229c5de` |
| JAR | 3,991,103 | `d04301aa65fb5830d459089b19c492727798b9a84c8d745173eb77cf0e19f2ee` |

Independent PE parsing confirms x64, 1,524 named/nonzero executable exports,
no forwarded or unnamed exports, and the same complete name/RVA table as the
prior retained static report. Direct imports remain SHLWAPI, RPCRT4 and
KERNEL32; there is no delay-import directory or embedded certificate table.
The JAR's embedded DLL equals the standalone DLL byte for byte. These facts
do not authenticate Windows transitive imports or establish native semantics.

The generated JAR contains 258 RocksDB classes and 1,531 native declarations:
all 1,519 stock declarations are unchanged, plus 12 test-helper declarations
corresponding to the formerly unused exports. It has 11 classes absent from
the stock JAR and lacks six stock `$1` classes; all 247 shared class files have
different bytes. Generated classes use class-file major 65 (Java 21), while
stock classes use major 52 (Java 8); earlier source-8 compiler warnings do not
establish the packaged JAR's target level. The 96 generated headers (373,675 bytes) cover all 1,531 native
declarations with matching descriptor, return type and static/instance receiver.
The same seven names are missing. The generated JAR remains inspection-only;
the stock Ergo JAR is unchanged. All 1,524 actual exported names have a
matching pinned C++ definition and generated header return/parameter type list
after normalizing top-level `const`. This is static signature consistency,
not a proof of the compiled ABI or runtime semantics.
The source comparison also records an extra `Transaction_getDirect` receiver
overload; a separate matching definition and actual export cover that method,
so it is not an eighth missing binding.

The actual `WBWIRocksIterator` header declares `refresh0Jni` with a `jclass`
receiver. Pinned C++ line 947 defines it with `jobject` and without an explicit
`JNIEXPORT`/`JNICALL`. Distinct C++ parameter types permit an overload that
does not inherit the generated declaration's C linkage/export decoration;
the actual export is absent. This explains the source/header inconsistency
without treating source presence as an exported binding. No patch, placeholder
implementation or runtime reproduction was introduced.

### Offline worker linkage boundary

The candidate report records the exact **36 potential native declarations**
reachable through the reviewed `NodeDatabaseControl` configuration. Independent
stock class-bytecode and pinned-source inspection includes all 17 Options
setters, write/flush options, explicit loading/version, both database opens,
put/get/flush, constructor calls and exceptional cleanup. Five use long JNI
names: Options/ReadOptions constructors and the selected RocksDB open/get/put
overloads; the other 31 use short names. Every required candidate export and
generated prototype matches the selected stock signature.

The seven missing bindings are excluded by specific paths: no missing option
wrapper, live-file metadata conversion or indexed-write-batch iterator is
called; the default RocksEnv is disowned. Single-family open leaves the owned
column-family list empty and disowns its separately stored default handle.
Native status errors construct the checked Java-only Status and RocksDBException
objects. The worker installs no Java comparator, listener, logger, filter or
environment callbacks. This is a scoped potential-call set, not a whole-Ergo
call graph or a claim that every call occurs on every failed run.

Stock RocksDB allocates a default native ReadOptions object on construction
without closing it along this path. The worker creates at most two before
process exit; this review does not establish general leak-free lifecycle.
Native allocation failure, fatal assertions, memory corruption, arbitrary
callbacks and JVM/OS native behavior remain outside the static call graph.

Before execution, capture the corrected packaged-target project in a later
bounded run, then review exact native pins and narrow WinSxS provenance.
Keep the stock JAR, compression-free fresh-database profile, fixed 64 MiB
control and unchanged one-second sampling ceiling. No native load, database
retry, node start, peer connection or volume allocation occurred here.

### Verification

The [synthetic suite](../experiments/ergo-range/native-candidate.test.ps1) covers
47 cases without executable binaries or network access: valid round trip,
wrong archive/member hashes and workflow identities, missing required members,
traversal, case collisions, symlink metadata, malformed lengths, size overflow,
lying ZIP lengths, duplicate JSON keys, identity/status arrays and final-newline
filenames. It stages the packaged target when both project files exist and
rejects a sibling project substituted for it. Windows CI runs it alongside
the offline identity/accounting checks.
Independent review reproduced the array-comparison and newline-name defects;
strict scalar validation and absolute regex anchors fixed them. Independent
readback passed the suite, original counterexamples and a separate Windows
write-failure cleanup probe, with no unresolved material finding in this scope.
Full `npm run check` passed: 96 files / 1,795 tests in 264.20 s plus build,
package, pilot, store-crash and spent-set checks. An initial sandbox run passed
documentation/type checks but refused Vitest/esbuild directory access; the same
command passed outside that boundary without changing implementation or deadlines.
The retained-build script also refused local invocation at its host gate before
mutation. The actual retained run and verified transfer above now complement
the synthetic evidence. The exact-target correction passed all 47 archive
cases and full `npm run check`: 96 files / 1,795 tests in 254.64 s plus every
subsequent check. Preparation revision `373db50` passed every CI job in
[run 34502530808](https://github.com/mediumofexchange/reference-ts/actions/runs/34502530808).
Independent candidate review used separate ZIP/class/PE readers and compared
all 85 pinned JNI source files with the generated prototypes. It reproduced
member identity, class/native sets, export addresses and the scoped findings
above. The reviewer used the primary authenticated API/log identity as its
outer expectation and independently checked the archive contents against it.
No unresolved material finding remains within static retention/reporting;
the missing exact-target evidence and runtime adoption gates remain explicit.
