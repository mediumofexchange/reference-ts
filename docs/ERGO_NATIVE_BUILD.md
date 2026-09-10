# Windows native build qualification

Status: 2026-09-10, first run refused before compilation; reviewed retry prepared.
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
on `mediumofexchange/reference-ts/main`, in the public repository, on a
standard `windows-2022` runner. There are no dispatch inputs, schedules,
secrets, credential persistence, artifact/cache uploads or release steps.
Its token has `contents: read`. Logs retain the JSON report and static
inspection; generated binaries disappear with the runner and are not an
adoptable local artifact. A later retention/transfer route is separate work.

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
`20260830.290.1` or `20260907.297.1`, CMake 3.31.6, Java 21.0.12 and Windows SDK 10.0.19041.0.
The [image source](https://github.com/actions/runner-images/blob/3e99119430a6c4ead03a20a2a4020a71782eede1/images/windows/Windows2022-Readme.md)
lists Visual Studio 2022 and those tools, as does the separately inspected
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
static RocksDB linked into the JNI DLL, and warnings as errors. Third-party
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

One manually dispatched job has a 30-minute platform timeout and build
parallelism two. Refuse less than 8 GiB free before the build; accept at most
8 GiB observed scratch use, at least 2 GiB final free and at most 32 MiB each
for the DLL/JAR. These are initial/final observations, not disk quotas or a
process-memory limit. The standard runner supplies the machine boundary;
no local host resource envelope or worst-case compile cost is inferred.
The initial working estimate is 5–25 minutes and 2–6 GiB scratch, unmeasured
until execution. Keep failures and investigate rather than automatically
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
After execution, capture the exact run,
workflow revision, report, compile failure or static output and limitations.
No version/hash/module gate in the local database harness changes here.

Before a local trial: retain and independently inspect an actual candidate,
establish its full input/Java linkage evidence, handle compression-profile
differences, review the exact bundle/native pin change and narrow WinSxS
component provenance. The prior 954 ms sampling gap remains close to the
unchanged 1-second ceiling. Neither build success nor static exports satisfy
those gates; the fixed 64 MiB database control has not yet passed.
