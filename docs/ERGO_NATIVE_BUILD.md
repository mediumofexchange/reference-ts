# Windows native build qualification

Status: 2026-09-10, bounded compile-only qualification passed after three input refusals.
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
on `main` or the named `test/rocksdb-build-execution` development branch of
the public `mediumofexchange/reference-ts` repository, on a
standard `windows-2022` runner. There are no dispatch inputs, schedules,
secrets, credential persistence, artifact/cache uploads or release steps.
Its token has `contents: read`. Logs retain the JSON report and static
inspection; generated binaries disappear with the runner and are not an
adoptable local artifact. A later retention/transfer route is separate work.

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
Only logs are retained; they do not consume artifact-storage allowance under
the [billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

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
The published baseline had 1,603 exports; name/Java binding and semantic
compatibility still need investigation before adoption. Import names do not
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
