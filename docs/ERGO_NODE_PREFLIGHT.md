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

## Next executable slice

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
candidate for the 20 GiB data ceiling. It still needs an attach-capable host
context and a small disk-full/write-refusal demonstration before allocating
the declared volume. Verify the mounted volume identity and capacity, all
node write locations (including temporary/crash files), container overhead,
the host reserve and cleanup. A bounded data volume alone does not isolate
the process from other host paths or reserve disk against unrelated writers.
Do not replace that prerequisite with directory sampling or a file-length
limit: neither bounds aggregate database storage.

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

**Selection status:** retain the native stock-node probe and the reviewed
accounting/stop route; no complete first-sync combination is demonstrated. Native disk
attachment lacks a privilege in the current host token; rootless Linux is
feasible at the namespace boundary but has unproven disk, connected-network
and process-resource controls. Do not launch peers or install a new stack based
on the small tmpfs test. Prepare and review one complete control route before
its full-sized measurement. This is an experiment prerequisite, not a change
to the normative protocol or an impossibility claim about this host.

Use the reviewed stock-node boundary above. Falsifier: any reachable route,
startup behavior or persisted data can generate/import/use a spending key
without the deliberately unavailable authentication capability.

Select and demonstrate the first sync's disk/network controls before enabling
peers. Preserve the declared finite envelope, explicit wallet boundary and
validation/history settings. A complete effective-settings readback remains
useful before sync. Only a separately controlled sync can produce fixture and
validation evidence. No production dependency is selected here.

Independent source/claim review caught the omitted prerelease label, now
corrected, and confirmed the always-present wallet surface and API membership
limits. Subsequent independent boundary review found hardcoded CORS and public
non-passive routes; the explicit residual surface and reader allowlist resolve
those findings for the finite experiment. No material static boundary finding
remains under the recorded assumptions; startup/resource/sync evidence is separate.
