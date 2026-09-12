# Ergo range-source feasibility

Private offline probe; no runtime exports, node connection or transaction submission.
Use Node 24, then from the repository root:

```powershell
npm --prefix experiments/ergo-range ci --ignore-scripts --no-audit --no-fund
npm run check:ergo:range
```

The [deployment evidence](../../docs/POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
records source pins, observed coverage, counterexamples and the next source gate.
The fixture manifest pins the original public response bytes before parsing;
Git attributes preserve those raw responses, including trailing whitespace.
Do not expose this probe as an arbitrary-file or network verification API.

The separate [dedicated-node preflight](../../docs/ERGO_NODE_PREFLIGHT.md)
pins a Windows distribution and records the separate finite node-startup probe.

## Stable stock storage control

The current candidate is the complete stable v6.0.5 Windows x64 package.
The later RocksDB/custom-native controls below retain earlier evidence and are
suspended. Existing fixture provenance remains pinned separately.

Download into an existing `scratch/ergo-stable/`, check the official artifact,
then extract into an absent `bundle/` (PowerShell 7):

```powershell
$stableZip = 'scratch/ergo-stable/ergo-node-v6.0.5-windows-x64.zip'
curl.exe --fail --location --proto '=https' --proto-redir '=https' --max-time 180 --max-filesize 115343360 --limit-rate 8M --output $stableZip https://github.com/ergoplatform/ergo/releases/download/v6.0.5/ergo-node-v6.0.5-windows-x64.zip
if ($LASTEXITCODE -ne 0) { throw 'Download failed' }
if ((Get-Item -LiteralPath $stableZip).Length -ne 108916979 -or (Get-FileHash -LiteralPath $stableZip -Algorithm SHA256).Hash -ine '28be43dd010792bc72d320952dcfde368a9a21e3926409f78757e6218583ea06') { throw 'Package mismatch' }
if (Test-Path -LiteralPath 'scratch/ergo-stable/bundle') { throw 'Fresh bundle directory required' }
pwsh -NoProfile -File experiments/ergo-range/node-prepare.ps1 -Stable
pwsh -NoProfile -File experiments/ergo-range/node-stable-storage.ps1
pwsh -NoProfile -File experiments/ergo-range/node-stable-storage.ps1 -Execute > scratch/ergo-stable/storage-result.json
```

The existing pinned Eclipse compiler at `scratch/sync-preparation/ecj-3.37.0.jar`
is required. Default mode checks the node JAR and all 164 JRE files without
execution. `-Execute` requires absent `scratch/ergo-stable/storage-run/`; it
compiles the worker and runs three separate JVMs against the stock versioned
store for write, reopen/rollback and reopen verification. It starts no node,
wallet or peers. Preserve the report before removing the exact owned run folder.
On failure, `storage-run/processes.json` preserves returned process results;
observer/launch exceptions can occur before a result is returned.

This is an ordinary persistence control with native factory selection, not a
crash/disk-full test, loaded-module attestation or full-sync acceptance. Limits,
source comparison and measured results are in the preflight and
[stable evidence](../../docs/ergo-stable-verification.json).

## Stable node startup and settings

Use the same complete stable bundle for the finite offline node startup:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-startup.ps1 -Stable > scratch/ergo-stable/startup-result.json
```

This requires absent `scratch/ergo-stable/run/` and free loopback ports 19030
and 19053. It retains the original 120-second, 4 GiB process-commit and 16 MiB
observed file/output bounds, disables peers/discovery, uses an empty secret
directory and allows only three fixed local HTTP observations. A successful
report must be checked and captured as `docs/ergo-stable-startup-verification.json`
before the settings readback:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-settings.ps1 -Stable > scratch/ergo-stable/settings-result.json
```

Readback requires absent `scratch/ergo-stable/settings-run/`. It checks the
baseline plus JVM pruning override and omitted-checkpoint controls, using the
stock typed settings loader without starting node services. Omitting `-Stable`
retains the earlier prerelease reproduction paths and pins; it never falls back
between packages. The deleted custom artifacts are not prerequisites here.

## Maintained standard Java

The selected next runtime is the official Temurin **21.0.12.1+1 Windows x64
JRE**, alongside the unchanged stable Ergo bundle. It does not replace bundle
members, change system Java, or install a package. Download into an existing
`scratch/ergo-java/`; preparation requires its `bundle/` to be absent:

```powershell
$javaZip = 'scratch/ergo-java/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip'
curl.exe --fail --location --proto '=https' --proto-redir '=https' --max-time 120 --max-filesize 48999141 --limit-rate 8M --output $javaZip 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jre_x64_windows_hotspot_21.0.12.1_1.zip'
if ($LASTEXITCODE -ne 0) { throw 'Download failed' }
pwsh -NoProfile -File experiments/ergo-range/node-prepare.ps1 -MaintainedJava
pwsh -NoProfile -File experiments/ergo-range/node-stable-storage.ps1 -MaintainedJava -Execute > scratch/ergo-java/storage-result.json
pwsh -NoProfile -File experiments/ergo-range/node-startup.ps1 -Stable -MaintainedJava > scratch/ergo-java/startup-result.json
```

Preparation checks the exact archive size/hash and extracts 315 files /
151,524,241 bytes. Each consumer verifies the complete pinned Java inventory.
After checking the successful startup report, capture it as
`docs/ergo-maintained-java-startup-verification.json`, then run:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-settings.ps1 -Stable -MaintainedJava > scratch/ergo-java/settings-result.json
```

Each test requires its absent `maintained-java-storage-run/`,
`maintained-java-run/` or `maintained-java-settings-run/` under
`scratch/ergo-stable/`. Existing process, socket and observed file bounds apply.
Without the explicit flag, the earlier bundled-Java reproduction remains.
These are offline compatibility observations, not a connected sync or runtime
security certification. See the [current preflight](../../docs/ERGO_NODE_PREFLIGHT.md).

The additional candidate readback appends `node-sync-network.conf` to that
same baseline, reads its typed settings and tests a fifth-peer JVM override:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-settings.ps1 -Stable -MaintainedJava -SyncProfile > scratch/ergo-java/sync-settings-result.json
```

This requires absent `scratch/ergo-stable/sync-settings-run/` and starts only
the settings reader, with at most four cases plus one compiler. It never runs
the candidate as a node. The candidate's peer addresses and connection target
are not an enforced egress policy or kernel socket quota. The composed disk,
traffic and process controls remain necessary before connected execution.

## Offline node on a capped volume

`node-volume-split.ps1` uses an ordinary-user supervisor and node. A separate
UAC-elevated `node-volume-owner.ps1` creates, formats and maps one fresh fixed
64 MiB VHD and holds its native handle. The default offline profile never
selects an existing disk, changes ACLs or starts public-peer connections.
Default invocation is read-only:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-handoff.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-volume-evidence.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1
```

Execute from an **ordinary** PowerShell 7 session. The script requests UAC only
for the disk owner. It creates a fresh GUID directory below
`scratch/node-volume-split/` and leaves small `result.json` and `owner.json`
reports there. A successful run removes its own VHD:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Execute
```

The [recorded acceptance](../../docs/ergo-node-volume-split-verification.json)
contains successful ordinary-node startup and parent-death cleanup on this host.

The fixed parent-failure control must run in its own process: it deliberately
kills that process at the first Java observation. Inspect the resulting
`parent-failure.json` and `owner.json`; the interrupted parent has no result:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Execute -ParentFailureControl
```

One node JVM uses the pinned offline config and standard packages, 4 GiB commit,
2 GiB heap, 25% CPU, 120-second nominal wall time and 15 MiB captured output.
Its token is checked before resume. Data, home, temp and diagnostics use the
verified volume. Three bounded loopback reads after 60 seconds check genesis,
empty peers and wallet refusal; ten more seconds precede the whole-job stop.
Real traffic accounting retains the 8 GiB trigger / 10 GiB final maximum,
1-second sampling/final gaps and 2-second stop-to-empty acceptance. These are
observed timing checks, not independent hard deadlines. Host reserve is 100 GiB.

A fresh named job and GUID/PID/creation-time handoff bind parent and owner.
The owner verifies an empty job **after** parent completion or death closes
future admission, then removes only its own mapping and image. At its nominal
four-minute timeout it stops the job but retains the mounted volume until the
parent finishes or dies; a stuck live parent can therefore retain the helper
and disk indefinitely. Killing the helper itself is outside the demonstrated
cleanup ordering. This trusted-host IPC is not protection against malicious
same-user file mutation, and the volume is not a whole-host filesystem sandbox.

The earlier elevated `node-volume-control.ps1` and its
[recorded result](../../docs/ergo-node-volume-verification.json) remain historical
reproduction. The separately selected connected profile is described below.

## Bounded connected source sync

The [first connected measurement](../../docs/ergo-node-sync-verification.json)
ran for 282 seconds, observed three peers and 25,733 headers through the API
(the later log reached 33,263), then stopped at the console budget. No applied
full-state progress or fixture ancestry was observed. The 20 GiB image is
retained detached, with process exit and drive removal independently checked.
The inherited INFO logging override is now corrected with
`scorex.logging.level = WARN`, preserving the explicit UtxoState INFO logger.
The [offline regression](../../docs/ergo-node-sync-logging-verification.json)
uses the actual settings loader; a second connected execution is not claimed.

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-settings.ps1 -Stable -MaintainedJava -SyncProfile -LoggingProfile
```

This settings-only regression requires an absent
`scratch/ergo-stable/sync-logging-settings-run` directory and starts no node services.

The explicit `-ResumeSync` mode continues only the first recorded image at
`scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd`.
It checks its fixed size and GPT identity, then the recorded partition, volume
and original configuration; it never initializes or formats that image. A new
report directory preserves the earlier observations. The same node, traffic,
time and host-space bounds apply, with no additional large image allocation.
This mode is a single continuation from the recorded original configuration;
it refuses a later changed configuration rather than guessing its provenance.
The [recorded continuation](../../docs/ergo-node-sync-resume-verification.json)
was manually stopped after roughly seven minutes and 97,923 API-observed headers.
Cleanup detached the retained image. The raw automatic report stays unresolved
because an external stop is not its observer-stop acceptance; no full-state
application or final worker secrets check is claimed. The node is stopped, and
the rewritten configuration deliberately prevents blindly repeating this command.

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Sync30Minutes -ResumeSync
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Sync30Minutes -ResumeSync -Execute
```

The first command is read-only. Execution follows the explicit continuation
instruction under the unchanged bounded profile. The owner refuses an already
attached image and holds an exclusive local resume lock until cleanup. Native
handle lifetime and the existing parent-completion protocol control detachment.
Trusted same-user writers and ancestor replacement are outside this identity
check's guarantees; it is not a hostile image parser.

The reviewed `-Sync30Minutes` profile retains the standard packages, ordinary
node token, 4 GiB commit / 2 GiB heap / 25% CPU, 100 GiB host reserve and
8 GiB traffic trigger / 10 GiB final maximum. It creates exactly one new
20 GiB VHD, uses the pinned four-peer overlay and keeps REST/P2P listeners on
loopback. Fresh mode never reopens an image; resume selects only the recorded
image described above. Neither mode installs wallet keys. Read-only
preparation checks package/config pins, free space and unused probe ports:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-sync-profile.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-sync-reader.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Sync30Minutes
```

After the separate resource/execution approval, launch from an ordinary session:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-split.ps1 -Sync30Minutes -Execute
```

The native process has a 30-minute wall limit; the observer requests stop ten
seconds earlier. Earlier stops include the traffic trigger, 64 MiB remaining
on the data volume, 12 MiB captured console output, or five minutes with no
peer/header progress. Synchronous OS calls remain a timing limitation. The
owner's 36-minute deadline stops existing members but retains the mounted disk
until parent completion/death closes future admission. Shared cleanup and
helper-crash limitations from the offline profile still apply.

`scratch/node-source-sync/<GUID>/progress.json` reports bounded live progress.
`result.json` contains metadata, limits, traffic and partial applied-state
observations. `owner.json` records empty-job cleanup, removed mapping and
detachment. The exact 20 GiB image is **retained detached**, including on
unsuccessful node observations; it is not automatically deleted or resumed.
Inspect these reports before deciding how to use or remove that owned image.

The local metadata reader permits 128 requests, 1 MiB per body and 8 MiB total,
with a five-second request deadline. It checks `/info`, connected peers, wallet
refusal and the full tip's header. Historical applied-tip correlation requires
matching ID/height/root and the specific UTXO application log; view stability
is reported separately. Header progress alone is not applied-state evidence.
Fixtures above the observed full height are `not-reached`; reaching their height
without a checked parent chain is `ancestry-not-checked`, never verified.
Only bounded console prefix/tail and a digest of all captured text are retained
in the report; live databases are not recursively inventoried.

The [preparation record](../../docs/ergo-node-sync-preparation.json) captures
source pins, focused checks and review. It is not a connected execution result.

## Earlier platform controls
Its [first-sync control selection](../../docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection)
also records a narrow rootless WSL control. From the repository root in the
existing Ubuntu 20.04 distro, run `sh experiments/ergo-range/sync-namespace-control.sh`.
It requires an existing `scratch/` and absent `scratch/sync-namespace-control/`,
creates private namespaces, mounts 8 MiB of tmpfs, attempts at most 9 MiB of
writes, checks `ENOSPC` and removes the mountpoint. It runs under a 15-second
timeout plus two-second kill grace. Exit 0 establishes that fixed control only;
it does not permit sync or supply the 20 GiB disk/10 GiB traffic contract.
It creates no external connections and changes no host settings. No WSL
installation or distro-wide change is needed. This command is separate from
the Windows startup and default CI checks below.

The native traffic accounting/stop control is also separate from startup:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-traffic-counter.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-traffic-evidence.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-traffic-control.ps1
```

To revalidate the checked-in observation with the current stricter classifier,
run the evidence test with `-RecordedReport`. The
[report](../../docs/ergo-traffic-stop-verification.json) preserves source hashes
from its measurement at `2f1d9bc`; a later termination-code check closes a
natural-exit race. Revalidation repeats no transfer and does not rewrite history.

The first two commands are worker-free. The last makes one bounded HTTPS GET
of the already-public, immutable fixture through system curl, under the
existing Job Object supervisor. It counts all exposed host-interface receive
and send deltas and stops at 16 KiB; final accepted observations must not exceed
2 MiB. Maximum sample gap is 1 s, stop decision to confirmed empty job 2 s,
and final sampling delay 1 s. curl allows at most 64 KiB response bytes at
8 KiB/s for 8 s; the job permits 10 s, 256 MiB and one process. No Ergo peers,
proxy, redirects, retries or credentials. Run without concurrent repository
checks or intentional host transfers; unrelated traffic is still counted.
Exit 0 establishes only the finite observed stop response. Exit 2 preserves
an unresolved report; a baseline/launch error fails before acceptance. The
counter boundary excludes errored traffic and is not a wire/billing quota.
Keep the JSON output when comparing controls; never raise limits automatically.

This does not change the offline decoder commands above. On Windows x64 with
PowerShell 7, the node experiment has no npm/default-check integration:

The separate native disk control requires an already elevated Windows host.
Run the worker-free guards, harmless console startup checks and read-only
preflight first:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-disk-evidence.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-disk-startup.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-disk-control.ps1
```

After independent review, the concrete command in an elevated PowerShell 7
window, with this repository as the current directory, is:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-disk-control.ps1 -Execute > scratch/node-disk-control-report.json
```

The repository's `scratch/` must already exist for that output redirection;
`scratch/node-disk-control/` must not exist. The helper creates only a fixed
64 MiB VHD there, formats its own newly created partition, and attempts at
most 65 MiB through its volume GUID path. There are no path/disk/size options,
drive letters, folder mounts or automatic elevation. The worker is contained
by the existing Job Object and uses the verified parent console; its shared
control/lifetime and existing host resources remain outside that job.
Never run `node-disk-worker.ps1` directly.
See the [control contract](../../docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection)
for reserve, memory, time and evidence limits. Exit 0 from preflight only means
ready for an explicit attempt; exit 0 with status `fixed-native-disk-full-only`
requires the actual disk-full and detach observations. Exit 2 is unresolved.
Keep the report and the detached image for readback. A failed attempt is not
automatically rerun or removed; cleanup requires checking the exact image's
detached state before deleting only the captured image and inspecting/removing
its disposable PowerShell profile files, then the resulting empty directories.

The existing offline startup commands remain separate:

```powershell
New-Item -ItemType Directory -Force scratch/node-startup | Out-Null
curl.exe --fail --location --proto '=https' --proto-redir '=https' --max-time 300 --max-filesize 201326592 --limit-rate 8M --output scratch/node-startup/ergo-node-v6.1.5-windows-x64.zip https://github.com/ergoplatform/ergo/releases/download/v6.1.5/ergo-node-v6.1.5-windows-x64.zip
# Preparation verifies the exact ZIP hash before extracting anything.
pwsh -NoProfile -File experiments/ergo-range/node-prepare.ps1
pwsh -NoProfile -File experiments/ergo-range/node-controls.ps1 -EvidenceOnly
pwsh -NoProfile -File experiments/ergo-range/node-evidence.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-observer.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-controls.ps1
pwsh -NoProfile -File experiments/ergo-range/node-startup.ps1
```

Run controls and startup sequentially, without other repository checks during
measurements. Preparation requires the pinned archive at
`scratch/node-startup/ergo-node-v6.1.5-windows-x64.zip` and an absent `bundle/`.
Startup requires an absent `run/`; preserve the report before removing a
previous disposable run. Never invoke a control worker or bundled launcher
directly. The startup supervisor strips inherited JVM options, joins a job
before execution, caps CPU rate/memory/output, and samples owned TCP/UDP sockets.
It requests only `/info`, `/peers/connected`, and unauthenticated `/wallet/status`
once each, starting no earlier than 60 seconds, with five-second full-response
deadlines. It stops after ten further seconds of observation, or at 120 seconds.
The wallet remains uninitialized, with no known API authentication preimage.
Its actor and wildcard CORS remain present. This is a trusted-host probe,
not a network/filesystem sandbox or a service for arbitrary callers.

Exit **0** means the finite startup observations pass; exit **2** preserves
unresolved startup evidence. A launch/provenance error fails before acceptance.
Neither exit establishes sync, chain membership, exact CPU-time containment,
hard disk/network quotas or production readiness. The
[current report](../../docs/ergo-node-startup-verification.json) retains exact
artifact/source pins and the limitations of the observations.

The separate settings-only readback uses the same extracted pinned bundle:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-settings.ps1
```

It requires an absent `scratch/node-settings/` and the standalone Eclipse
compiler 3.37.0 at `scratch/sync-preparation/ecj-3.37.0.jar`. Retrieve that exact
artifact from [Maven Central](https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.37.0/)
with a 4 MiB / 60-second download ceiling; the launcher checks its SHA-256.
Reacquire the pinned node archive under the existing download/extraction
budgets above and run `node-prepare.ps1` if the scratch bundle was removed.
Nothing is installed. The helper invokes the actual loader and typed settings
constructors without starting node services. It checks the baseline and two
negative controls: a JVM pruning override and omitted checkpoint override.
Each compiler/readback process has 30 seconds, 1 GiB commit, 25% CPU rate,
one process and 64 KiB output. The [report](../../docs/ergo-node-settings-verification.json)
records effective values, process evidence and limits. Successful settings
loading is not evidence of executed chain validation or a complete sync boundary.

With that same verified bundle and compiler, run the separate fixed path probe:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-volume-path.ps1
```

It requires an absent `scratch/node-volume-path/`. It checks only path syntax
in the pinned JRE, without opening its fake volume/drive/UNC specimens or
loading Ergo/RocksDB. Its [report](../../docs/ergo-node-volume-path-verification.json)
records volume GUID refusal by both NIO entry points and accepted ordinary
absolute-path controls. Exit 0 means the expected incompatibility was reproduced;
it does not mean a volume or database worked. Compile and probe each have
30 seconds, 1 GiB commit, 25% CPU, one process and 64 KiB output.

The next fixed control is prepared separately:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-database-control.ps1
pwsh -NoProfile -File experiments/ergo-range/node-database-identity.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-database-evidence.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-database-native.test.ps1
pwsh -NoProfile -File experiments/ergo-range/node-database-compile.test.ps1
```

The first command only reads prerequisites and reports source hashes. The
identity/evidence tests use synthetic cases plus a read-only unused-letter
query; native-file tests create and remove only synthetic scratch files.
The control requires the exact separately retained DLL at
`scratch/retained-native-target/candidate/librocksdbjni-win64.dll`, verified
against the fixed hash/length in the harness. It checks again through one open
source handle when copying to the owned volume. The stock Ergo JAR stays intact;
the generated build JAR is inspection-only, and no published-DLL fallback exists.
The module policy permits only the reviewed Common Controls path/hash/length
outside the original directories, preserving all resource/timing bounds.
The compilation test uses the same pinned bundle/compiler above and an
absent `scratch/node-database-compile-test/`; it compiles the worker and runs
pure Java status/path tests without invoking its main method or loading JNI.
It emits JSON with exact artifact/class hashes and process evidence.

After separate approval, the concrete elevated command would be:

```powershell
pwsh -NoProfile -File experiments/ergo-range/node-database-control.ps1 -Execute
```

This requires absent `scratch/node-database-control/` and creates only its own
fixed 64 MiB VHD. It selects an unused letter, verifies its image/partition/GUID
mapping, and routes Java cwd/temp/home/native/diagnostic/database writes there.
Six sequential JVMs at most compile the worker, test four injected observer
refusals during database work, and exercise bounded RocksDB disk exhaustion.
Each has 30 seconds, 1 GiB commit, 25% CPU, one process and 64 KiB output.
Actual interface accounting has a 1 MiB trigger and 2 MiB final ceiling per
JVM, a 1 second sample/final delay ceiling and 2 second stop-to-empty ceiling.
Injected observations remain separate from real traffic measurements.

The command emits a JSON report; preserve it outside the owned volume.
Successful completion removes the mapping, detaches and deletes the exact
owned image, with readback. A failed attempt retains its bounded image after
attempting safe cleanup; inspect its report before any retry. The existing
native disk control is unchanged. No Ergo node, peers, arbitrary disk selector
or full-sized allocation is included. See the
[prepared control and evidence limits](../../docs/ERGO_NODE_PREFLIGHT.md#prepared-offline-database-control).

The original `npm run check:ergo:range` command runs both the block-root/Fleet experiment and the
[full binary decoder experiment](../../docs/POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility).
`decoder-check.mjs` launches the fixed corpus in a child process with a 30-second
deadline and 1 MiB output cap. The corpus checks fixture pins, all output
fields/IDs, every proper transaction prefix, trailing bytes, nonminimal counts
and JSON field-boundary aliases. Input budgets are experimental refusal limits;
there is no hard process/WASM memory cap and no production decoder selection.

The separate Windows x64 / PowerShell 7 containment probe is run explicitly:

```powershell
pwsh -NoProfile -File experiments/ergo-range/contained-check.ps1
pwsh -NoProfile -File experiments/ergo-range/contained-check.ps1 -LaunchMode detached
```

It requires Windows 10 or newer for creation-time job assignment. Run only
this supervisor, never `contained-worker.mjs` directly: the worker includes
memory-growth, infinite CPU/output and descendant-process controls. Each
worker joins a Job Object at creation, remains suspended until membership
and limits are read back, and has bounded captured output and a wall deadline.
The default `no-window` mode uses `CREATE_NO_WINDOW`; `detached` substitutes
`DETACHED_PROCESS`, with identical budgets and inherited handles. Each result
records the mode and creation flags. Run the two commands sequentially without
concurrent repository checks when comparing resource measurements. Detached
launch does not prevent the process from allocating a console later.
This controls resources for fixed trusted code; it does not isolate file or
network access. No arbitrary files or hostile parser inputs are accepted.

The [no-window result](../../docs/ergo-containment-verification.json) and
[detached result](../../docs/ergo-detached-containment-verification.json) retain
both launch observations. Both exit **2**, unresolved: no-window reports
excess memory/CPU and extra associated processes; detached samples only Node
and stays below the memory limit but still exceeds the CPU threshold.
Independent process counters, bounded process inventories and whole-job
cleanup readback distinguish those observations.
The extra console host does not establish a permissible memory allowance.
The commands are deliberately outside the default checks/CI until the
acceptance gate can be met. Exit 0 would establish only these fixed controls
and the old corpus; it would still not establish hostile-parser containment
or node equivalence.
`-StartupOnly` runs just the low-cost launch/readback control, not acceptance.
`-EvidenceOnly` checks eight resource-report regressions without executing a worker,
including a quota exit with excessive CPU that the earlier check accepted.
See the [comparison and limits](../../docs/POOL_DEPLOYMENT_PROBES.md#windows-process-containment-feasibility).

The separate [metered decoder probe](../../docs/POOL_DEPLOYMENT_PROBES.md#metered-decoder-feasibility)
requires a working Windows x64 Python 3.9+ executable as well as Node 24.
Choose its path below; install only into the disposable repository directory:

```powershell
$probePython = 'C:\path\to\python.exe'
& $probePython -m pip install --no-deps --only-binary=:all: --require-hashes --target scratch/metering-python -r experiments/ergo-range/metering-requirements.txt
& $probePython -I -B experiments/ergo-range/metering-provenance.test.py
node experiments/ergo-range/metering-check.mjs $probePython
```

The launcher uses isolated Python, a 30-second process deadline and 1 MiB
captured-output cap. It is a finite measurement runner, not process-tree or
total-memory containment. Only the existing pinned valid fixtures are decoded.
Wasmtime 48.0.0 is pinned by Windows wheel hash and native DLL hash; the runner
rejects missing scratch installs and checks the loaded package/DLL paths.
No production or default-check dependency is added. The scratch install can
be removed after the report is captured and reproduced using the same command.

Exit **2** preserves a report with unresolved fuel refusals (currently one of
24 transactions). Exit 0 means controls and all fixed fixture comparisons
completed; neither status establishes hostile-parser safety or production
acceptance. Fuel and linear-memory caps leave host overhead and total process
resources open. No limit is raised automatically, no fuel is refilled, and no
failed transaction contributes accepted outputs.

The separate [cost profile](../../docs/POOL_DEPLOYMENT_PROBES.md#decoder-cost-and-host-overhead)
uses that same scratch installation, Windows x64 Python and Node 24:

```powershell
& $probePython -I -B experiments/ergo-range/cost-observer.test.py
node experiments/ergo-range/cost-check.mjs $probePython
```

It pins the original metering report and verifies all 24 baseline results at
the unchanged 10-million-fuel budget. It then measures the one refused valid
transaction and its five original scripts under a separate, fixed
100-million-fuel ceiling each. These six diagnostics run once, without retry,
refill or adaptive budget changes; any refusal stays unresolved. No hostile
decoder inputs are accepted. Exit **2** is always retained because profiling
does not clear the original acceptance refusal or host-containment gate.
Phase observations include fuel, wall/process CPU and Windows process memory
before/after each measured operation. Process counters cover Python only;
lifetime peaks and timing samples are not worst-case resource bounds.
