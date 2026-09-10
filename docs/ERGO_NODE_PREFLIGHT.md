# Dedicated Ergo node probe

Status: 2026-09-10, artifact inspection and launch requirements. The
[stock no-spending-key decision](../decisions/2026-09.md#2026-09-10--keep-the-source-probe-free-of-spending-keys)
permits a finite, source-configured offline startup on a trusted host. The runtime remains v2;
this does not select a production source, change a parser budget or establish
an authenticated range. Companion specification: `main` at `7ea0ee8`.

## Candidate and measured artifact

Keep the fixture baseline, Ergo **v6.1.5**, rather than changing consensus
versions during the comparison. The
[tag reference](https://api.github.com/repos/ergoplatform/ergo/git/ref/tags/v6.1.5)
resolves directly to `c36466405abc9a2ddda37e890635f00d593041f5`.
The [release](https://github.com/ergoplatform/ergo/releases/tag/v6.1.5)
was published on 2026-09-01 and is marked **prerelease** in the release API.
It remains a fixture-comparison candidate, not a supported production release.
Its `target_commitish` says `v5.1.0`; that field
is not the resolved tag pin or proof that the binary was built from it.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `ergo-node-v6.1.5-windows-x64.zip` | 179,682,635 | `7d8c010b781841631f8968e424e30ea99f2352ac0cd40ef32c72e90c37d0af73` |
| Embedded `ergo-6.1.5.jar` | 153,586,421 | `4ada5520636a65d7be09b6ec3ff8044b8fdc5baf552633b8c4f6335f71b93928` |

The archive was downloaded once from the release asset URL into ignored
`scratch/node-preflight/`, in 51.175424 seconds. Its measured hash matches
GitHub's release asset digest. Streaming the embedded JAR through SHA-256
also matches the standalone JAR's advertised digest. These establish artifact
identity against that distribution, not a reproducible source build or an audit.

Archive metadata reports 192 entries and 202,691,057 uncompressed bytes.
`jre/release` declares Java 21.0.1; `jre/bin/java.exe` is present. No executable
was run, so the declaration is not a runtime-version observation. The bundled
configuration only disables mining: it is insufficient for this probe. Do not
use the packaged launcher without inspecting its arguments and environment.
Security/maintenance suitability of this bundled JRE remains unassessed.

The host reports 17,048,907,776 bytes physical RAM, four logical processors
and 533,708,570,624 bytes free on C: at preflight. The detected system Java is
Oracle 8u481. The bundle avoids relying on that Java; the pinned source and
actual runtime still need startup verification. WSL2/Ubuntu 20.04 is configured,
but its resource controls were not tested; Docker was not found on PATH.

## Predeclared resource envelope

The artifact inspection used a 192 MiB download ceiling, 256 MiB scratch
ceiling, 300-second transfer timeout and 8 MiB/s transfer ceiling. Only small
text entries (at most 1 MiB each) were read; the JAR was hashed as a stream.
Nothing was unpacked. The archive is disposable after these observations are
captured. Reproduction downloads the exact named asset and rejects any size or
hash mismatch; it must not silently follow a new release.

The following are **provisional refusal budgets**, not measured sufficient
capacity or claims of enforcement. No installation or sync starts until the
corresponding controls have been implemented and read back. Reaching a limit
ends that attempt with incomplete evidence; there is no automatic increase.

| Phase | Declared ceiling | Required enforcement/evidence |
|---|---|---|
| Extract and inspect runtime | 512 MiB dedicated scratch total; 5 minutes | Check member count, paths, expanded sizes and hashes before extraction; keep all files under the probe directory |
| Offline startup | 120 seconds; 4 GiB aggregate job commit; 2 GiB JVM heap; one JVM and no descendants; 25% host CPU rate | Assign the process to a kill-on-close job before execution; read back memory, process and CPU-rate controls; exercise controls before the node |
| First sync measurement | 30 minutes; same memory/CPU controls; 20 GiB dedicated data volume; 10 GiB combined final observed successful-interface traffic | Demonstrated disk ceiling and traffic accounting/stop mechanism with an earlier trigger; preserve at least 100 GiB free on C:; report stop latency and any overshoot, refusing missing/late accounting or final excess |
| Logs and run files | 16 MiB combined observed envelope | Capped stdout plus sampled/final run-file bytes; stop/refuse on excess. This is not a filesystem quota |
| Fixture/API reads | GET only, one at a time; 1 MiB decoded bytes and 5 seconds per response; 64 MiB/120 seconds total | Stream counting before JSON parse; no redirects or automatic retries; lossless integer parsing; stop on malformed, unavailable or excessive data |

The old decoder Job Object supervisor is not a JVM launcher and did not
establish an exact CPU-time bound. Do not reuse its passing subcontrols as a
passing node resource contract. A CPU-rate limit is a different property from
an exact total-CPU limit and needs its own Windows source/readback/control
evidence. JVM `-Xmx` alone excludes native allocations and is insufficient.
Disk directory sampling and process I/O counters alone are not hard disk or
network quotas. The table deliberately leaves their implementation open; a
fully controlled sync launch is not yet available. Do not change host firewall,
WSL-wide configuration or existing services to make this probe pass.

Thirty minutes may not reach any fixture height, much less the current tip.
Record partial progress honestly. A longer run needs a separate declared
measurement envelope informed by the first run, with remaining costs stated.

## Validation and local service requirements

Inspect the pinned
[application configuration](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/resources/application.conf)
and its consuming code together. The candidate requires mainnet, UTXO state,
transaction verification, all historical blocks retained, no UTXO snapshot or
NiPoPoW bootstrap, and no individual checkpoint. Mining, offline generation
and the extra index are unnecessary. A fresh, dedicated empty data directory
must be demonstrated before the first run: configuration alone does not prove
an existing database was validated from genesis.

| Setting | Candidate value |
|---|---|
| Network selection | Explicit `--mainnet`; inspect resolved mainnet settings |
| `ergo.node.stateType` / `verifyTransactions` / `blocksToKeep` | `"utxo"` / `true` / `-1` |
| `ergo.node.utxo.utxoBootstrap` / `storingUtxoSnapshots` | `false` / `0` |
| `ergo.node.nipopow.nipopowBootstrap` / `ergo.node.checkpoint` | `false` / `null` |
| `ergo.node.mining` / `offlineGeneration` / `extraIndex` | `false` / `false` / `false` |
| `scorex.restApi.bindAddress` / `scorex.network.bindAddress` | `"127.0.0.1:19053"` / `"127.0.0.1:19030"`; verify ports are free |
| `scorex.network.upnpEnabled` / `declaredAddress` | `false` / absent in the fully resolved configuration |

This is a source-inspected requirement table, not a runnable config. Data/log
paths, API authentication, CORS, network isolation and all configuration
fallbacks/overrides must be resolved by the startup slice.
In particular, the
[settings reader](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/settings/ErgoSettingsReader.scala#L64)
places user config above mainnet defaults, which contain a checkpoint. Omission
does not disable that checkpoint; the explicit `null` override matters.

Bind REST and P2P listeners only to loopback, disable UPnP and avoid a declared
public address. Keep mainnet peers for a later controlled outbound sync; an
empty peer list alone is not network isolation. Before sync, verify actual
listener addresses and outgoing behavior. Never inherit the default API-key
hash of `hello`. Wildcard CORS is hardcoded by
[ErgoHttpService](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/http/ErgoHttpService.scala)
and cannot be disabled by the parsed `corsAllowedOrigin` setting; the finite
probe retains that local surface explicitly. An API authentication secret is distinct from
a spending key and cannot establish that wallet services are disabled.

The pinned
[application](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/ErgoApp.scala)
requires an API-key hash and unconditionally mounts `WalletApiRoute`.
The
[node view holder](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/ErgoNodeViewHolder.scala#L428)
starts the wallet even when there is no seed.
The stock bundle therefore **does not meet the preflight's wallet-services-
disabled requirement**. A fresh uninitialized wallet has no spending key, but
its registry, actor and authenticated HTTP routes still exist. An unknown
configuration key such as `wallet.enabled = false` cannot establish otherwise.
No seed, wallet restoration, funds, signing or transaction submission is
needed for the source comparison.

The reviewed decision selects the first of these alternatives for this probe:

- Retain the stock binary with a fresh uninitialized wallet, an unpredictable
  API-key hash whose preimage is not retained, local listeners and a reader
  that has only bounded public GET access. This avoids a node fork and spending
  keys but retains wallet code and depends on authentication/isolation; it
  changes the experiment's service-disabling requirement, as explicitly reviewed.
- Omit wallet actor/routes through a minimal source change or an upstream
  supported option. This can satisfy literal service removal, but introduces
  a changed artifact, build provenance and continuing maintenance/review costs.

Only the finite experiment adopts the first alternative. An HTTP proxy alone leaves
the underlying wallet routes present and does not establish their removal.
The invariant is that the node never initializes/imports/persists/uses a spending
key, wallet prover or keystore. Random entropy is not itself wallet authority.
The source's
[wallet startup](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/wallet/ErgoWalletService.scala#L271)
does not generate a key when the secret file and test mnemonic are absent.
All [wallet routes](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/http/api/WalletApiRoute.scala#L49)
require authentication. Public entropy and transaction-submission routes remain:
the startup reader allowlists `/info`, `/peers/connected` and the unauthenticated
`/wallet/status` rejection check, not arbitrary GET paths.

For source-configured offline startup, explicitly set `knownPeers=[]`,
`bannedPeers=[]`, `peerDiscovery=false`, `maxConnections=0`, `upnpEnabled=false`,
`declaredAddress=null` and `restApi.publicUrl=null`, with a fresh peer database.
The pinned
[network controller](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/scorex/core/network/NetworkController.scala#L268)
suppresses scheduled connections at zero maximum. Its direct connect path is
not guarded by that maximum, but its HTTP trigger requires authentication.
No NTP/DNS-seed implementation was identified in the bounded production-source
review. Record no observed outbound sockets when supported; socket sampling
does not prove zero packets or hard network isolation.

## Acceptance after a controlled sync

Record artifact/configuration hashes, exact Java invocation, fresh directory
evidence, resource observations, bootstrap/history settings and sync state.
Distinguish the best header tip from the best fully validated block and applied
state. A high header height, `/info` response or returned block body alone does
not establish transaction validation, ancestry or a stable selected chain.

The pinned
[stats collector](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/local/ErgoStatsCollector.scala)
exposes `bestHeaderId`, `bestFullHeaderId` and `stateVersion`, plus header/full
heights and scores. Candidate stable-tip acceptance requires all three IDs
equal, the respective heights/scores equal, the expected mainnet genesis ID,
UTXO state and mining false. Correlate these with fresh-directory/config and
application evidence; record peers and compare an independent current tip.
This is evidence of the node's selected applied tip, not protection against
eclipse or adversarial chain selection.

The pinned
[block routes](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/http/api/BlocksApiRoute.scala)
serve `/blocks/{headerId}` and `/blocks/{headerId}/transactions` without a
wallet key. `/blocks/at/{height}` returns all stored header IDs at that height;
it is not a canonical-membership oracle. `/blocks/chainSlice` is capped at
16,384 headers and a nonnegative upper height starts from the first stored
header ID at that height. Any use must anchor the returned upper ID to the
captured tip or known ancestor and verify parent links across windows.

For the three entries in the
[fixture manifest](../experiments/ergo-range/fixtures/manifest.json), fetch local
full blocks and compare all 24 transaction IDs, the fields and IDs of all 65
outputs, transaction/output order and the three version-dependent transaction
roots using the existing offline experiment. Do not demand identical JSON
whitespace, and do not infer canonical wire bytes from node parsing. Version 1
does not commit to transaction proof bytes through its transaction root.

Prove each fixture header is an ancestor of a captured, fully validated tip;
recheck that tip/ancestry after reads and reject a changed view. Pagination or
client budgets may prevent that demonstration: unresolved is the result, not
an empty range. The exact bounded membership-read procedure remains owed.
Even a successful fixture comparison covers three noncontiguous blocks only.
Complete contiguous ranges, publication ordering, hostile-node/parser cases
and production resource sufficiency remain separate gates.

## Offline startup evidence

The [supervisor and reproduction](../experiments/ergo-range/README.md) now run
the pinned stock JVM/node in a fresh directory. The first attempt's early
listener/500 ms response timeout refused before readers were ready; its exact
[report and code](https://github.com/mediumofexchange/reference-ts/blob/2309bdf/docs/ergo-node-startup-first-attempt.json)
remain in history. The second, scheduled observation received all expected
responses but its classifier incorrectly expected height zero. Its exact
[refusal](https://github.com/mediumofexchange/reference-ts/blob/a462dd3/docs/ergo-node-startup-verification.json)
also remains. Neither historical report is reclassified as passing.

The source shows absent headers/full blocks encode as explicit null fields.
The corrected checker requires those nulls, the pinned genesis UTXO root,
zero state-version bytes, mainnet/UTXO/non-mining flags and an actual empty peer
array. It rejects missing fields, wrong roots/networks, mining, invalid field
types and nonempty/non-array peer data. Socket observations cover owned IPv4
and IPv6 TCP/UDP table entries; the finite node run requires loopback TCP only.
Tests exercise real loopback TCP/UDP ownership, path allowlisting, duplicate
refusal, redirects, encoding/UTF-8 failures, oversized responses and timeouts.

The JVM runs with an explicit minimal environment and private home/tmp/data/
secret paths. A custom console-only Logback config avoids its default large
rolling log. RocksDB and JVM temporary files remain included in sampled and
final file-byte accounting. The native supervisor records raw captured bytes;
acceptance adds them to the maximum sampled/final run-file size. The check is
conservative over observations, not a hard filesystem quota.

All archive members are hash-checked against the pinned generated manifest
before execution; the runner refuses extra files, reparse entries, reused run
directories and occupied listener ports. The installed distribution reports
application label `6.0.4RC2-109-c3646640-SNAPSHOT`; preserve that observation
alongside the v6.1.5 prerelease asset hashes. It is not a reproducible-build proof.
The actual Java version is checked under the same process controls before node
startup. Exact command/config hashes and observations live in the
[current report](ergo-node-startup-verification.json).

The final run passes the finite startup predicates and exits **0**:

| Observation | Final result |
|---|---|
| Java runtime | Microsoft OpenJDK 21.0.1+12-LTS, matching the bundled declaration |
| Node duration and process CPU | 73.897 s wall; 20.797 s job user CPU and 2.281 s job kernel CPU |
| Peak job commit | 336,232,448 bytes under the 4 GiB installed job limit |
| Observed combined files/output | 9,193,752 bytes, below 16 MiB |
| API observations | 1,319 response bytes; `/info` 200, `/peers/connected` 200 with `[]`, `/wallet/status` 403 |
| Socket samples and cleanup | 287 owned TCP/UDP samples; only loopback TCP observed; one associated process; whole job empty after cleanup |

The [separate controls](ergo-node-controls-verification.json) preserve six
fixed process cases, including four busy threads under CPU-rate scheduling,
allocation refusal, descendant refusal, wall and output termination. Ten
worker-free resource-report cases, sixteen startup-evidence cases and eleven
loopback observer cases pass. The rate is a cycle-scheduling contract, not an
exact total-CPU bound. Memory peaks/timing from this single run are not capacity
planning, worst-case costs, or evidence for hostile parser inputs.

Independent implementation review confirmed the boundary and found the initial
null-height and separate stdout/file-budget errors. Corrected predicates and
their nearby cases were read back and independently exercised. API/config
observations do not constitute a complete effective-settings dump; no sync,
validated block ancestry, production resource sufficiency or hard network/disk
isolation has been established.

## Effective settings readback

The [offline readback](ergo-node-settings-verification.json) uses the pinned
JAR's actual `ErgoSettingsReader.readConfig(Args)` and `fromConfig` methods,
including its typed settings constructors. The
[helper](../experiments/ergo-range/NodeSettingsReadback.java) reflects the exact
private loader method rather than recreating HOCON precedence. It never calls
`ErgoApp.main`, starts actors, opens the node databases or invokes wallet routes.
The [fixed launcher](../experiments/ergo-range/node-settings.ps1) reproduces the
recorded offline startup configuration with fresh paths and a new random API
hash target, without retaining an authentication preimage.

The baseline resolved mainnet (address prefix 0, magic bytes `[1,0,2,4]`,
genesis ID `b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b`).
Typed settings confirm `utxo`, transaction verification, `blocksToKeep=-1`,
absent checkpoint, disabled UTXO/NiPoPoW bootstrap and zero stored snapshots.
Both `isFullBlocksPruned` and `areSnapshotsStored` are false. Mining, offline
generation and extra indexes are false; test mnemonic and test key count are
absent. REST/P2P are loopback, known/banned peers empty, maximum connections
zero, discovery and UPnP false, declared address and public URL absent. CORS's
parsed null still does not remove the hardcoded HTTP behavior described above.

Two otherwise matching controls establish that this is effective readback:
`-Dergo.node.blocksToKeep=10` overrides the file and sets typed pruning true;
omitting `checkpoint = null` restores mainnet's checkpoint. Both are rejected
as validation profiles. Their settings processes successfully exit; this
rejection does not claim the stock node itself rejects those configurations.
Settings establish intended behavior, not that a node executed validation
from genesis or retained a complete history.

The compiler and three readbacks each use the existing Job Object launcher:
30 seconds, 1 GiB aggregate/process commit, 25% CPU rate, one process and
64 KiB captured output. The compiler took 5,409 ms / 132,771,840 peak commit
bytes; readbacks took 5,841–6,972 ms / at most 156,377,088 bytes. Each exited
naturally with one total process, limits read back and an empty job. Final
run files totaled 9,231 bytes; data and secret directories remained empty.
JRE readback reports 21.0.1 and the explicit home/temp/logback paths. This is
neither a full filesystem trace nor packet-isolation evidence.

The bundle lacks `jdk.compiler`. Compilation uses the standalone
[Eclipse compiler 3.37.0 distribution](https://repo.maven.apache.org/maven2/org/eclipse/jdt/ecj/3.37.0/),
3,257,207 bytes, SHA-256
`cde026ff966b48b5e5f148b6f041ceff3cf4f85cf75155f4ec0f40e4ee14b545`,
only in ignored scratch. Its published SHA-1 was cross-checked at retrieval;
the launcher pins the measured SHA-256. This is distribution identity, not
reproducible-build assurance. No runtime/compiler installation or project
dependency was added. The compiler is absent from the readback classpath.

## First-sync preparation

### First-sync control selection

The Windows stock-node route has a concrete disk prerequisite. Microsoft's
[AttachVirtualDisk contract](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk)
requires `SeManageVolumePrivilege`. On 2026-09-10, `whoami /priv` in the normal
host process did not list that privilege, and
`WindowsPrincipal.IsInRole(Administrator)` returned `false`. This was read
outside the Codex filesystem/network sandbox; requesting ordinary host access
does not grant Windows administrator elevation. No privilege, disk attachment,
firewall or access-control setting was changed.

A fixed-capacity, freshly formatted dedicated virtual disk is the native
candidate for the 20 GiB data ceiling. The small native worker's disk-full
demonstration below now passes in an attach-capable host context; a composed
JRE/database control is still needed before allocating the declared volume.
Verify the mounted volume identity and capacity, all
node write locations (including temporary/crash files), container overhead,
the host reserve and cleanup. A bounded data volume alone does not isolate
the process from other host paths or reserve disk against unrelated writers.
Do not replace that prerequisite with directory sampling or a file-length
limit: neither bounds aggregate database storage.

The [fixed native disk control](../experiments/ergo-range/node-disk-control.ps1)
prepares that next observation. Its default mode is read-only preflight;
`-Execute` requires an already elevated Windows x64 / PowerShell 7 process.
It never requests elevation or enables token privileges itself. An ordinary
host refusal is unresolved evidence, not an attached-volume test.

The control creates a new **64 MiB fixed VHD**, with at most **65 MiB** backing
file accepted, under the absent `scratch/node-disk-control/` directory. It
requires a fixed NTFS host volume, with **100 GiB plus 65 MiB** free before
creation and **100 GiB** after the worker. Its handle owns the new image;
attachment has no drive letter or permanent-lifetime flag. Before each storage
mutation, the script correlates the image association with the handle's
physical path and the disk's identity, size and non-system/non-boot state.
It initializes only that new RAW disk, creates a GPT data partition and
formats only that partition as NTFS. No existing image, disk selector, mount
directory or drive-letter option is accepted.

The worker uses the formatted volume's GUID path, which Windows defines as a
[volume identifier](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-volume).
It attempts at most **65 MiB** in 1 MiB writes; only native error **112** after
positive completed writes can establish disk-full. The existing Job Object
allows **30 seconds, 512 MiB commit, one process, 25% host CPU rate and 64 KiB
output**. The final classifier also requires a natural successful worker exit,
confirmed empty job, expected volume capacity/free space, backing-file bounds,
host reserve and detached-image readback. Errors never imply empty or complete
evidence. The bounded VHD is retained for inspection after detachment; cleanup
must first verify the exact path and detached state and must not recurse.

This is a trusted-host control, not a storage sandbox. Concurrent path/disk
administration is outside its assumptions. Synchronous Windows storage setup
and detach calls have no hard deadline; only the worker has the demonstrated
Job Object deadline. The worker's private temporary/home directory and the
supervisor's compiler/Storage-module activity are outside the data volume.
The future node run still owes an inventory of every node write target,
full-sized disk/overhead measurements and combined traffic/process evidence.
No 20 GiB allocation, node, peer or sync is launched by this control.

Preparation verification passes 69 durable worker-free cases, including native
compilation/ABI and strict path endings. Independent adversarial review found
and corrected the fixed-subtype selector (`GET_VIRTUAL_DISK_INFO_PROVIDER_SUBTYPE`
is **7**, not the storage-type query **6**) and ownership of the undefined
output handle on failed creation. The helper now owns that handle only after
successful creation. See Microsoft's
[information selectors](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-get_virtual_disk_info_version)
and [creation contract](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-createvirtualdisk).
Focused readback also verified trailing LF/CRLF/NUL/suffix refusal; no material
static finding remains under the stated host assumptions. These checks do not
exercise the storage operations themselves.

The [ordinary-host preflight](ergo-disk-control-preflight.json) exited **2**
with `administrator=false`, `mutationsStarted=false`, no process or disk
observation, and **532,020,400,128 bytes** available on the host volume. Source
hashes identify the tested helper. The result is `unresolved-disk-preflight`:
no disk was created, attached, formatted, filled or detached in that preflight.
The subsequent elevated observations are recorded below.

The [first elevated attempt](ergo-disk-control-first-attempt.json), preserved
at `358b070`, obtained administrator context and created/attached a fixed VHD:
67,108,864 virtual bytes, 67,109,376 backing bytes, provider subtype 2.
It refused before disk initialization because the Storage module projects
`BusType` to the display string `File Backed Virtual`, which cannot be cast
to an integer. The worker never launched; no formatting or disk-full result
was established. Explicit detach and readback succeeded. A separate read-only
query confirmed the exact image was detached before its captured scratch
artifact was removed for the corrected attempt.

The corrected guard at `e3864b3` reads the underlying CIM property and requires
`System.UInt16` value 15. Installed `Storage.types.ps1xml` and `Disk.cdxml`
confirm the display mapping and raw type; the
[MSFT_Disk contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/storage/msft-disk)
defines the bus values. An independent in-memory CIM reproduction and 74
durable cases pass, including wrong raw values behind a matching display label,
missing properties and wrong scalar types. No other identity predicate or
budget changed. The initial refusal is not reclassified as passing.

The [second attempt](ergo-disk-control-second-attempt.json) passed the raw-bus
check, initialized the new GPT disk and created a data partition, then refused
before formatting. Read-only inspection of that detached image's GPT found the
data partition starting at sector 128, **65,536 bytes**, below the guard's
declared 1 MiB minimum. The setup had relied on Windows' default offset.
Detachment succeeded again; no worker or disk-full evidence was produced.
The corrected setup at `53c2bec` requests the 1 MiB offset explicitly and
preserves observed disk/partition properties before evaluating their guards.
Independent readback and 75 durable cases pass.

The [third attempt](ergo-disk-control-third-attempt.json) created and formatted
the expected partition at offset 1,048,576 bytes. NTFS capacity was 65,990,656
bytes with 53,633,024 bytes free both before and after the worker. The detached
PowerShell worker exited 0 in 208 ms with no output; no fill happened. The
classifier refused the missing result and image detachment passed. Source
hashes identify `53c2bec`; this refusal is preserved without reclassification.

Harmless startup probes reproduced empty exit 0 even for an explicit exit 72.
PowerShell 7.6.5's
[entry point](https://github.com/PowerShell/PowerShell/blob/v7.6.5/src/Microsoft.PowerShell.ConsoleHost/host/msh/ManagedEntrance.cs)
returns its initial exit code on selected console-handle exceptions; its
[ConsoleHost](https://github.com/PowerShell/PowerShell/blob/v7.6.5/src/Microsoft.PowerShell.ConsoleHost/host/msh/ConsoleHost.cs)
registers a console handler before running the command. Together with the
managed-entry trace, this supports an early console failure, not a successful
fill. A no-window probe ran commands but added a second associated process.

The fixed trusted worker now opts into the parent's **existing console**.
Before disk creation and again before worker launch, a bounded
[`GetConsoleProcessList`](https://learn.microsoft.com/en-us/windows/console/getconsoleprocesslist)
query must include the parent PID. Only `DETACHED_PROCESS` is removed from
the creation flags; existing node/traffic callers stay detached. No console
is created, attached or reconfigured. Job assignment, inherited standard
handles, minimal environment and all resource limits are unchanged.
The existing console host's resources and shared control/lifetime are outside
the worker job; this mode is only for the trusted offline control. It supplies
no isolation from console APIs or console closure. A new compiled host was
unnecessary given this scope and would add build/runtime obligations.
The classifier requires the exact mode/flags, verified parent console and
one total job process, including transient processes. The
[harmless startup test](../experiments/ergo-range/node-disk-startup.test.ps1)
requires exact stdout and an explicit nonzero exit code in separate launches.

The [corrected fixed control](ergo-disk-control-verification.json), measured
at `91055fc`, passes with native **ERROR_DISK_FULL (112)** after **53,477,376
completed bytes (51 MiB)**; the failed next block brings attempted bytes to
54,525,952 (52 MiB). The 65,990,656-byte NTFS volume has **151,552 bytes** free
afterward, down from 53,633,024. The worker exits naturally in **4,746 ms**,
uses at most **69,287,936 bytes** job/process commit, captures 273 output bytes
and records one total process. Limits were read back before resume and the
whole job was confirmed empty. The fill loop itself took 222 ms.

The new VHD has 67,108,864 virtual bytes and **67,109,376 backing bytes**;
explicit detachment and a separate ordinary-host `Get-DiskImage` readback
both confirm it is detached. Host free space after the run is
531,929,812,992 bytes, above the reserve. PowerShell also created a
192,792-byte startup profile under the run directory, outside the data volume,
consistent with the stated write-location limit. Project checks were running
concurrently; this is a bounded capacity/control observation, not isolated
performance benchmarking. Source hashes and the completion classifier were
rechecked against the unmodified report. The three refused reports remain
historical failures. This small pass does not establish a complete first sync.
Independent report review repeated the completion/partition guards, checked
all seven source hashes, output bytes and volume bindings, with no unresolved
material finding. Raw CIM/image samples are not serialized in the report:
those identity checks are evidenced by the reviewed executed path, not by
independent replay of their original native types. The separate detached-image
query corroborates cleanup. The final focused suite has 79 worker-free cases;
the harmless inherited-console and unchanged detached-Node checks also pass.
The captured image and inspected startup profile were subsequently removed
after another exact-path detached readback; only resulting empty directories
were removed. The raw report's `artifactRemoved=false` describes measurement
time and is intentionally unchanged. Final `npm run check` passes: 96 files /
1,795 tests, package consumer, pilot, store-crash and spent-set checks.

The existing Job Object does not supply the combined traffic control:
Microsoft's
[network rate structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_net_rate_control_information)
limits **outgoing** bandwidth. Multiplying that rate by the wall deadline
does not cap downloads. Windows
[extended TCP statistics](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-setpertcpconnectionestats)
are disabled by default and require administrator access to enable per
connection. Enabling them after socket discovery leaves an unmeasured prefix;
short-lived connections can disappear between samples. Neither mechanism
establishes the proposed 10 GiB combined budget.

The [reviewed experiment contract](../decisions/2026-09.md#2026-09-10--measure-traffic-and-stop-the-finite-source-probe)
selects a native accounting/stop candidate: conservative host-interface
receive/send deltas, including unrelated traffic, with immediate job stop
on threshold, counter reset, interface change or observation failure. The
[interface counters](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-mib_if_row2)
report successful received and transmitted octets; they are observations,
not a physical-wire, ISP-billing or complete link-overhead bound. Include
unrelated traffic and repeated virtual-interface accounting. The original
table called for traffic accounting/stop and reported overshoot; the later
absolute-cap interpretation is superseded by this explicit refusal contract,
without reclassifying any prior result. Keep 10 GiB as the maximum accepted
final observation; earlier trigger/headroom and timing limits still need
first-sync selection and measurement. Missing/late accounting or excess
refuses the attempt. Increases in error/discard counts also refuse.

Sampling cannot detect every transient interface or counter reset/regrowth,
and a permanently stalled supervisor cannot execute a stop. Stable trusted
host configuration and counter continuity are explicit assumptions. Public
peers remain untrusted; their parser exposure needs separate review before
sync. A gateway could cap admitted bytes, but does not prevent arbitrary
incoming physical-link consumption before local rejection. No hard network
quota or isolation is inferred from this selection.

The first [.NET wrapper attempt](https://github.com/mediumofexchange/reference-ts/blob/bae0515/docs/ergo-traffic-stop-verification.json)
refused baseline enumeration because one exposed interface lacked a usable
IPv4 index. It launched neither the worker nor its request. That refusal
remains preserved; skipping the interface would leave incomplete accounting.
The inspected .NET wrapper could otherwise turn index zero into zero counters.

The replacement reads the native
[GetIfTable2 table](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getiftable2)
of logical and physical interfaces directly, without active/IP-family filters,
and releases its buffer with `FreeMibTable`. Its Windows x64 binding follows
the full `MIB_IF_ROW2` layout, including alignment: 1,352-byte rows and an
eight-byte offset to the first row. At most 256 rows are accepted. Identity
binds interface LUID, GUID and index, with type and operational-status continuity.
Native counters and checked deltas/sums remain unsigned 64-bit values. No
public-wrapper signed conversion or index-zero fallback remains. This still
does not establish a full interface-lifecycle or reproducible-build proof.

The [native control report](ergo-traffic-stop-verification.json) records
83 interfaces and four samples: 42,399 received plus 11,449 sent octets,
53,848 total. The final observation exceeds the early 16 KiB trigger by
37,464 bytes but stays below the separately declared 2 MiB acceptance maximum.
Maximum sample gap was 240 ms; stop decision at 339 ms was followed by
confirmed empty job at 346 ms and final sampling at 347–350 ms. The job's
exit code is `0xE0000001`, the supervisor's termination code. This is host
aggregate evidence, including unrelated/duplicate traffic; it does not
attribute those bytes to curl or prove a completed fixture download. The
controlled worker ran for 271 ms under the installed process limits.
The report's six source hashes refer to the measured code at
[`2f1d9bc`](https://github.com/mediumofexchange/reference-ts/commit/2f1d9bc).
Final review strengthened the classifier to require that exact termination
code: the observer runs before natural-exit detection, so `observer-complete`
alone could accept an already-finished curl process. The unchanged report
passes the strengthened classifier through `node-traffic-evidence.test.ps1
-RecordedReport`; its historical source hashes were not rewritten and the
GET was not repeated. Final evidence includes 112 pure counter checks and
26 worker-free report cases. No material review finding remains after readback.

The existing WSL 2 / Ubuntu 20.04 installation offers a second route without
Windows elevation. A fixed
[rootless control](../experiments/ergo-range/sync-namespace-control.sh)
successfully created private user, mount and network namespaces on kernel
`5.10.102.1-microsoft-standard-WSL2`. Its 8,388,608-byte tmpfs mount refused the
next write with `ENOSPC` (28) after exactly 8,388,608 bytes. The loop attempts
at most 9 MiB, under a 15-second timeout plus two-second kill grace. UID 0 maps
only to the existing unprivileged UID 1000. Observed network interfaces were
`lo`, `tunl0`, `sit0`, all with zero counters. No sockets or external traffic
were generated by the control. Private mount propagation, unmount on exit and
an empty parent mountpoint were checked; the empty scratch directory was removed.
Independent review repeated the final isolated-Python control with inherited
`PYTHONOPTIMIZE=1`: it passed with all assertions active. Invoking the same
control as Linux root correctly refused the `0 -> 0` UID map before writes,
then left no probe directory. No material review finding remains in this scope.

That passing result establishes only the fixed local control, not a connected
network quota or complete filesystem/process sandbox. Kernel
[tmpfs documentation](https://docs.kernel.org/6.2/filesystems/tmpfs.html)
explains that it uses memory and swap; scaling this control to 20 GiB would
substitute a different resource obligation for the declared disk volume.
The existing WSL root filesystem is also not a dedicated 20 GiB volume.
`mount`, `mkfs.ext4`, `fusermount`, `ip`, `tc` and Python are available;
`fuse2fs`, `slirp4netns`, Java and GCC were not found individually on PATH.
These observations do not prove that a rootless disk/network route is
impossible. It needs separate filesystem/gateway feasibility and Linux
CPU/memory/process controls; the Windows Job Object evidence does not transfer
to Linux guest processes. Launching the Windows bundle through WSL interop
also does not place that Windows process inside the Linux namespaces. No
WSL-wide settings or host access rules were changed.

### Write targets and remaining observation boundary

This inventory distinguishes source-derived destinations from measured file
activity. Let `R` be one fresh run root on the owned data volume, `D=R/data`,
`T=R/tmp`, and `S=R/secrets`. For the later volume experiment, process working
directory, `TEMP`, `TMP` and `USERPROFILE` must be `R`; `user.home=R/home`,
`java.io.tmpdir=T`, `ergo.directory=D` and wallet `secretDir=S`. Read these back
under the same invocation/environment that the experiment will use. The
existing supervisor supplies only `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`:
Java option injection, `DATADIR` and `ROCKSDB_SHAREDLIB_DIR` are not inherited.
Path settings constrain ordinary writes, not a compromised process.

| Target | Source and required treatment |
|---|---|
| `D/history/index`, `objects`, `extra` | `HistoryStorage` opens all three RocksDB databases. `extraIndex=false` does not remove `extra`. |
| `D/state/ldb_main`, `ldb_undo` | `ErgoState`/`UtxoState` and `RocksDBVersionedStore` derive the current and undo stores under `D`. |
| `D/snapshots` | `UtxoStateReader` includes `UtxoSetSnapshotPersistence`, which eagerly opens `SnapshotsDb`; zero stored snapshots disables snapshot dumping, not this database. |
| `D/wallet/registry/ldb_main`, `ldb_undo`; `D/wallet/storage` | `ErgoWalletActor`/`ErgoWalletState` construct the registry and storage even without a spending key. A fresh registry records pre-genesis state. |
| `D/peers` | `PeerDatabase` still opens with offline networking settings. |
| Per-database RocksDB files | SST data, WAL `.log` files, `MANIFEST-*`, `CURRENT`, `LOCK`, `LOG`/`LOG.old.*`, `OPTIONS-*`, `IDENTITY`, temporary `.dbtmp` and possible archive files belong to each DB directory. Include compaction/obsolete/temp bytes in the same volume ceiling. |
| `S/<UUID>.json` | Encrypted seed storage written by wallet init/restore. Keep `S` initially empty, test mnemonic/count absent and API authentication unavailable; any secret file is a refusal. Registry/storage files are distinct from this directory. |
| `T/mainnet.conf` | The settings reader copies the embedded defaults before parsing and deletes them via a shutdown hook. A killed process can leave this file. |
| Native lookup and JNI extraction fallback | `RocksDB.loadLibrary()` first tries optional compression and RocksDB libraries through `java.library.path`. Only its extraction fallback uses `ROCKSDB_SHAREDLIB_DIR` if present, otherwise the Java temp directory `T`. Verify the actual loaded JNI and optional compression DLL paths/hashes; count extraction and residue after kill, without depending on delete-on-exit. |
| Application stdout and fallback logs | Stock `logback.xml` writes `ergo.log`/rolled archives relative to cwd; `scorex.logDir` does not redirect that appender. Use the explicit console-only logback file and capped output pipe. Keeping cwd in `R` also contains ordinary fallback logs. |
| JVM/native diagnostics | Put `-XX:ErrorFile=R/hs_err.log` on the volume, disable core dumps and performance data (`-XX:-CreateCoredumpOnCrash`, `-XX:-UsePerfData`), and supply no heap-dump/JFR/logging injection options. Auxiliary native/JRE/Windows destinations still require observation. |
| Host supervisor and OS | Bundle/compiler reads, supervisor compilation/module caches, evidence output, VHD backing file, paging and Windows crash reporting are outside the worker volume. The previous PowerShell startup profile demonstrates this boundary. Inventory/budget these separately; the Job Object does not contain host services or filesystem access. |

Ergo sources at the pinned revision: the
[history stores](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/history/storage/HistoryStorage.scala#L230),
[snapshot trait](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/state/UtxoSetSnapshotPersistence.scala#L18),
[snapshot database](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/state/SnapshotsDb.scala#L140),
[peer database](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/network/peer/PeerDatabase.scala#L15),
[state root](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/state/ErgoState.scala#L299),
[UTXO store](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/state/UtxoState.scala#L286),
[database factory](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/avldb/src/main/scala/scorex/db/RocksDBFactory.scala),
[versioned stores](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/avldb/src/main/scala/scorex/db/RocksDBVersionedStore.scala),
[wallet registry](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/wallet/persistence/WalletRegistry.scala),
[wallet storage](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/wallet/persistence/WalletStorage.scala),
[wallet startup/init/restore](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/nodeView/wallet/ErgoWalletService.scala#L271),
[settings reader](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/settings/ErgoSettingsReader.scala#L105)
and [logback](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/resources/logback.xml).
[build.sbt](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/build.sbt)
pins rocksdbjni 10.2.1. Its
[Java loader](https://github.com/facebook/rocksdb/blob/v10.2.1/java/src/main/java/org/rocksdb/RocksDB.java#L46),
[native extraction](https://github.com/facebook/rocksdb/blob/v10.2.1/java/src/main/java/org/rocksdb/NativeLibraryLoader.java#L112),
[default directories](https://github.com/facebook/rocksdb/blob/v10.2.1/db/db_impl/db_impl_open.cc#L123)
and [file naming](https://github.com/facebook/rocksdb/blob/v10.2.1/file/filename.cc)
support the native-storage rows. The observed `java.library.path` includes
Windows/system directories and `.`; environment scrubbing alone does not prove
that the embedded JNI DLL will be loaded. The settings-only run does not load
RocksDB. The Ergo factory sets no separate WAL/log/data paths.
`scorex.dataDir` and `scorex.logDir` are read back for visibility but are
not substitutes for these consuming-code paths.

This accounts for the identified node write targets and explicitly leaves
transitive native/JRE/OS writes unclosed. Source search and a settings-only
run cannot establish an exhaustive runtime write trace. A first-sync launch
must refuse until the following composition checks account for that remainder.

### JRE volume path prerequisite

The [bundled-JRE path probe](ergo-node-volume-path-verification.json) falsifies
direct reuse of the native worker's volume GUID path for all Java write roots.
`Paths.get` and `File.toPath` both reject
`\\?\Volume{11111111-2222-3333-4444-555555555555}\` and its `run/tmp` child.
The error is `Long path prefix can only be used with an absolute path`.
`File.isAbsolute()` is nevertheless true: that check alone is insufficient.
Ordinary drive paths, extended drive paths and extended UNC paths pass the
syntax controls. These specimens were never opened, resolved against a real
volume, statted or used for network access.

The [fixed helper](../experiments/ergo-range/NodeVolumePathCheck.java) has no
Ergo/RocksDB classes on its runtime classpath. The
[launcher](../experiments/ergo-range/node-volume-path.ps1) verifies the existing
167-file bundle manifest and compiler pin. Each of its two JVM processes has
30 seconds, 1 GiB commit, 25% CPU rate, one process and 64 KiB output. Compile:
4,411 ms / 130,850,816 peak commit bytes. Probe: 733 ms / 97,480,704 bytes.
Both naturally exit 0 with installed limits and empty jobs. Only the
3,142-byte compiled class remains in the probe directory at capture.
Successful probe classification records an incompatible path; it does not
mean the disk prerequisite passed. No disk or mount was created.

This agrees with the
[OpenJDK 21.0.1 parser](https://github.com/openjdk/jdk21u/blob/jdk-21.0.1%2B12/src/java.base/windows/classes/sun/nio/fs/WindowsPathParser.java#L95):
after stripping the extended prefix it requires a drive-absolute path, which
`Volume{...}` is not. The bundled binary is the decisive measured artifact;
upstream source agreement is not a reproducible Microsoft JRE build claim.
RocksDB 10.2.1's
[JNI extraction](https://github.com/facebook/rocksdb/blob/v10.2.1/java/src/main/java/org/rocksdb/NativeLibraryLoader.java#L140)
calls `Files.copy(..., temp.toPath(), ...)`. Thus routing its fallback temp
file through that GUID path cannot succeed on the measured JRE. This does
not prove that every `java.io.File` operation or direct native RocksDB path
fails; no such wider claim is needed to reject the proposed all-roots route.

The next candidate uses an ordinary drive-letter path for the **same newly
created, fixed 64 MiB VHD**, leaving the old native control unchanged. It must
select an unused letter, associate it only with the owned new partition, and
verify that its drive root maps to the expected volume GUID before any worker
write. Correlate image, disk, partition and volume identity as before; refuse
collisions, ambiguous identity or changed mapping, and verify mapping removal
and image detachment during cleanup. Stable trusted-host administration is
still assumed; a letter is not a filesystem sandbox. The new control must
remain read-only by default and have no arbitrary disk/path selector.

A mounted directory is an alternative but adds mount-point/reparse handling
to the existing ancestor guards. Pre-extracting/preloading JNI outside the
volume could avoid this one conversion, but would introduce another load path
and would not establish compatibility for other Java writes. A temporary
owned drive letter is therefore the smaller next candidate. Syntax acceptance
does not establish its Windows mapping, RocksDB behavior or cleanup. Prepare
and independently review the exact mapping/database harness before requesting
execution; neither this syntax probe nor the old native-worker approval
authorizes that new elevated experiment. No 20 GiB allocation follows.

Fresh independent review verified the complete bundle and report/source/class
hashes, the captured JSON, the helper's syntax-only operations and the narrow
source inference. No material finding remains. Both child processes exited 0;
an outer in-process capture wrapper initially misread a stale PowerShell
`LASTEXITCODE`, which does not change those recorded process results. The full
`npm run check` passes (96 files / 1,795 tests plus package, pilot, store-crash
and spent-set checks); final documentation checks pass separately. The review
did not rerun the probe or establish mounted-volume/database behavior.

### Prepared offline database control

The [fixed harness](../experiments/ergo-range/node-database-control.ps1) now
prepares the drive-letter candidate above. Its default is read-only. The
[reproduction commands](../experiments/ergo-range/README.md) distinguish that
preflight, pure preparation checks and the separately authorized elevated
`-Execute` experiment. Neither database execution nor a mapped-volume result
is claimed by preparation.

Execution would create one new fixed 64 MiB VHD at the harness's fixed scratch
path. There are no disk-number, existing-image, path or capacity arguments.
It correlates image, physical disk, GPT partition and NTFS volume; selects an
unused ordinary letter using logical-drive and DOS-device views; and checks
that both the letter and volume GUID resolve to the same native volume.
These checks precede worker writes and recur during observation. Cleanup
checks ownership before removing the access path, confirms letter absence
and image detachment, then deletes only that successfully verified image.
Failures retain the bounded image and exact unresolved evidence.

The pinned JAR contains an 8,869,888-byte `librocksdbjni-win64.dll`, SHA-256
`0f384322229c35bbb551ecf9bb49794c263e680b80cf8990024f28a69f489bc7`.
It is streamed into the volume's otherwise empty native directory as
`librocksdbjnijni-win64.dll`. The pinned explicit-directory overload calls
`Environment.getJniLibraryFileName("rocksdbjni")`, adding that second suffix;
the original archive member and exact bytes/hash remain unchanged. The
[worker](../experiments/ergo-range/NodeDatabaseControl.java) uses RocksDB's
[explicit directory loader](https://github.com/facebook/rocksdb/blob/v10.2.1/java/src/main/java/org/rocksdb/RocksDB.java),
validates JRE/version/write roots, and waits for the supervisor to inspect
actual loaded module paths and hashes before opening a database. The bounded
snapshot requires the exact JNI, pins bundled modules, records system modules
and refuses unpinned optional compression libraries. This is a point-in-time
identity observation, not a native-code audit or exhaustive lifetime trace.

At most six sequential JVMs each have 30 seconds, 1 GiB aggregate/process
commit, 256 MiB maximum Java heap, 25% CPU rate, one process and 64 KiB output.
Compilation is followed by four database cases exercising synthetic threshold,
missing, late and failing observations, then a disk-full case. Each database
case first writes, reads, flushes, closes, reopens and reads a baseline value.
The stop cases then make bounded paced writes while the same observer code
handles the injected refusal. The final case attempts at most 64 MiB + 4 KiB
payload, with compression/automatic compaction off and awaited flushes.
Only RocksDB `IOError/NoSpace` counts as disk exhaustion; other failures and
close errors are retained. The
[Windows mapping](https://github.com/facebook/rocksdb/blob/v10.2.1/port/win/io_win.h)
and [status enum](https://github.com/facebook/rocksdb/blob/v10.2.1/java/src/main/java/org/rocksdb/Status.java)
support that narrow classifier.

Real host-interface accounting remains separate from the injected samples.
For every JVM, including compilation, it starts before launch and attempts a
final sample even when launch, observation or cleanup throws. Actual traffic
triggers at 1 MiB and final acceptance is at most 2 MiB per JVM; any actual
threshold, missing/late sample or reader error refuses this offline control.
Sample gaps/final delay are at most 1 second, and injected stop to confirmed
empty job at most 2 seconds. A module snapshot that overruns the sample budget
also refuses. Recursive file inventory happens only after all jobs are empty,
bounded by 1,024 entries, 64 MiB logical bytes and a 5 second refusal deadline.

These limits do not contain a permanently stalled supervisor, host services,
paging or transitive native/JRE/OS writes. There is no network quota, public
peer data, complete write trace or full-size sufficiency result. The database
options are fixed control settings, not a claim that the stock node uses them.
Successful execution would demonstrate this small composition only; stock
node operation and the larger sync envelope remain separate work.

The [preparation report](ergo-node-database-preparation.json) captures a passing
read-only preflight, exact source/artifact pins, warning-free compilation and
18 pure Java status/path/filename checks. Compilation took 5,806 ms with 156,262,400
peak commit bytes; tests took 639 ms with 101,052,416 bytes. Both processes exited
0 with installed limits and empty jobs. Separately, 46 identity and 37
accounting/evidence cases pass; the full project check passes 1,795 tests plus
package, pilot, store-crash and spent-set checks. Its test runner required the
ordinary host after the filesystem sandbox refused configuration access.

Fresh independent review matched all 167 bundle hashes, source/compiler/class
pins and captured process results. It caught unpinned optional compression
names passing as system modules; the policy now covers the pinned loader's
complete names and rejects alternate JNI paths. A post-exit marker read avoids
rejecting a fast completed disk-full worker merely because it finished between
observer samples. Focused readback and hostile cases close both findings; no
material preparation finding remains. The mapped-volume/JNI/database and
cleanup experiment required separate authorization; its first attempt and
loader correction are recorded below.

The [first authorized attempt](ergo-node-database-first-attempt.json) at
`2251836` created/mapped the owned disk and compiled the worker successfully
on `Z:\run`, then failed before the JNI handshake or any database operation.
The explicit-directory loader requested `librocksdbjnijni-win64.dll`, while
the prepared extraction had retained the archive member's shorter name. The
Java result records `UnsatisfiedLinkError`; the outer stop classifier's refusal
does not replace that underlying cause. Both jobs were empty, final actual
traffic accounting remained valid (103,964 and 3,388 bytes), and mapping
removal plus detachment succeeded. A
[separate cleanup readback](ergo-node-database-first-cleanup.json) checked the
exact detached 67,109,376-byte image's hash and absent drive letter before
removing it; host free space afterward was 531,757,232,128 bytes.

The correction keeps the explicit-directory API and its loaded-state update,
renaming only the extracted copy to the basename that API computes. Switching
to the default search path or manipulating private loader state is unnecessary.
Two additional pure Java regression cases execute the pinned JAR's filename
calculation for both `rocksdb` and `rocksdbjni`, tying the archive name and
worker destination to actual artifact behavior. No budget or load directory
is widened; the failed first attempt remains a refusal.

### Combined experiment proposal

The smallest route reuses the native fixed disk, existing detached JVM Job
Object and aggregate interface accounting/stop contract. It introduces no
firewall, sandbox claim, separate service or production dependency; the stock
wallet actor/routes remain under the existing no-spending-key boundary. Before any
20 GiB allocation or peers, demonstrate a small **offline JRE/RocksDB control**
on the same owned volume and exact path form intended for sync. The direct
volume GUID route is refused above; the candidate owned drive-letter mapping
still needs demonstration. Test create/write/flush/close, finite disk-full refusal and
whole-job termination with verified pinned JNI identity and explicit optional
compression-library provenance; correlate actual loaded modules and file
destinations with the inventory, including cleanup residue. The old
disk control's approval covered its fixed worker, not this different worker.
Prepare and review that runnable control before requesting its execution.
Do not silently redirect writes to an ordinary host directory.

The later combined first-sync proposal has these fixed refusal limits:

| Boundary | Proposed limit and acceptance |
|---|---|
| Worker | 1,800,000 ms; 4 GiB aggregate/process commit; 2 GiB JVM heap; 25% host CPU rate; one detached JVM, no descendants. Read back limits before resume and confirm empty job for every exit. |
| Disk | New fixed VHD with 21,474,836,480 virtual bytes (20 GiB); accept at most 20 GiB + 1 MiB backing bytes. GPT/NTFS overhead and every `R` write share the virtual capacity, so 20 GiB is not usable database space. Verify exact image/disk/partition/volume association before each mutation. |
| Host | At least 100 GiB + maximum backing bytes + 512 MiB preparation + 16 MiB reports free before creation; at least 100 GiB while observing and after detach. No reservation against unrelated host writers is inferred. Record actual backing/NTFS/free bytes and setup/detach times. |
| Traffic | Trigger at 8 GiB combined successful-interface receive/send octets; maximum accepted final observation 10 GiB. Include unrelated and duplicate virtual-interface traffic. The 2 GiB headroom is a provisional refusal margin, not a throughput/overshoot guarantee. |
| Accounting timing | Nominal 250 ms observation; refuse a sample gap above 1,000 ms, discontinuity, interface change or read/error/discard failure. Stop decision to confirmed empty job at most 2,000 ms; final sample must finish within 1,000 ms after empty confirmation. Final accounting is required for natural exit, wall/memory/output stop and errors too. |
| Logs and reports | Capped 16 MiB combined application output and non-database diagnostic/report files; observe against the same budget and refuse excess. Database, WAL, JNI and temporary data bytes belong to the disk budget and must not be mistaken for logs. No directory sample is a quota. |
| API | Existing bounded, one-at-a-time public GET allowlist; at most 1 MiB/5 s per response, 64 MiB/120 s total for any later fixture extraction. No redirects, retries, credentials, wallet mutation or transaction submission. |

Do not put a recursive database scan, blocking API read, disk setup/detach or
other potentially long operation inside the traffic observer. Volume/free
queries and diagnostic accounting need measured latency; any file inventory
must be finite and outside the sample-critical path. The current synchronous
observer cannot stop a worker while permanently blocked. Preserve that
trusted-supervisor limitation, and test delayed/failed observers and final
sampling in a combined harness before any peer run. Independent controls
cannot be multiplied into a hard total disk/network/CPU guarantee.

The combined control must exercise disk-full and traffic stop while the same
JVM is doing finite database work, with no public peer payloads, and preserve
each refusal and final accounting result. This remains preparation for a
separately reviewed public-peer parser boundary: connection/message limits,
native decompression and the bundled JRE's maintenance suitability are open.
Keep the offline config at zero peers until the exact candidate peer-enabled
config and artifact are reviewed; rerun effective readback for that config.
Full-sized allocation needs separate authorization of the concrete harness.
No selection here establishes fixture ancestry, complete ranges, C2.10.13/A8,
same-index order/A9, or permission to deploy a public service.

Independent review inspected the actual helper, captured report, all 167
bundle hashes and the pinned loader/constructor path. A separate read of the
inventory and combined proposal caught the native-library search order;
the loaded-library identity requirement above resolves that claim gap.
No material review finding remains for this preparation slice. The combined
control and public-peer parser review remain future execution gates.
`npm run check` passes on unchanged final runtime code: 96 files / 1,795 tests,
package consumer, pilot, store-crash and spent-set checks. The ordinary host
was required after sandboxed esbuild could not read its configuration.

**Selection status:** retain the native stock-node probe and the reviewed
accounting/stop route; no complete first-sync combination is demonstrated.
The explicitly elevated native route now passes the fixed 64 MiB disk control;
ordinary process escalation alone still does not grant the required Windows
privilege. Rootless Linux is feasible at the namespace boundary but has unproven
disk, connected-network and process-resource controls. The inventory and
combined proposal above identify the remaining measured prerequisites. Verify
the composed route and full-sized overhead before a separately
authorized full-sized measurement. Neither small disk control authorizes peers
or establishes the complete sync boundary. No normative protocol change follows.

Use the reviewed stock-node boundary above. Falsifier: any reachable route,
startup behavior or persisted data can generate/import/use a spending key
without the deliberately unavailable authentication capability.

Select and demonstrate the first sync's disk/network controls before enabling
peers. Preserve the declared finite envelope, explicit wallet boundary and
validation/history settings. The offline effective-settings readback now passes;
the peer-enabled invocation still needs its own readback. Only a separately controlled sync can produce fixture and
validation evidence. No production dependency is selected here.

Independent source/claim review caught the omitted prerelease label, now
corrected, and confirmed the always-present wallet surface and API membership
limits. Subsequent independent boundary review found hardcoded CORS and public
non-passive routes; the explicit residual surface and reader allowlist resolve
those findings for the finite experiment. No material static boundary finding
remains under the recorded assumptions; startup/resource/sync evidence is separate.
