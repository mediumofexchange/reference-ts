# Dedicated Ergo node probe

Status: 2026-09-12, standard packages and ordinary offline execution verified;
the approved connected run demonstrated header progress and safe early stopping.
It reached the output budget after 282 seconds; full-state progress is unobserved. The
[stock no-spending-key decision](../decisions/2026-09.md#2026-09-10--keep-the-source-probe-free-of-spending-keys)
records the fresh uninitialized wallet choice for the trusted-host source probe.
The runtime remains v2;
this does not select a production source, change a parser budget or establish
an authenticated range. Companion specification: `main` at `7ea0ee8`.

Current direction: [prefer the standard Ergo distribution](../decisions/2026-09.md#2026-09-10--prefer-the-standard-ergo-distribution).
Select the unmodified stable **v6.0.5 Windows x64 bundle** for the next source
probe. It uses LevelDB and avoids the prerelease's RocksDB migration. The custom
native trial remains suspended. Earlier v6.1.5 preparation and refusals below
remain historical evidence, not the current execution queue.
The two custom candidates, their archives and unexecuted trial launcher have
now been removed from scratch (224 files / 55,859,988 bytes). Their committed
findings and build recipes remain; no standard-package dependency was removed.

## Stable package and ordinary storage result

The [stable evidence](ergo-stable-verification.json) records the official
108,916,979-byte archive and verified GitHub SHA-256 digest
`28be43dd010792bc72d320952dcfde368a9a21e3926409f78757e6218583ea06`.
It expands to 167 files / 131,488,960 bytes. The unchanged node JAR is
82,384,324 bytes, SHA-256
`2a7e2978cb09538ed6780d85ae3aa39c1ecce10e5e5a6e0dc3cd8ab087851588`.
All 164 bundled Java runtime files equal the earlier measured stock runtime.
Java 21.0.1 is also checked by the new worker; no Java replacement or installation
was needed for this control. Runtime maintenance remains a separate question.

The stable source commit is `5528ef569a41ebccbc8658212e6ee3c97d990b96`.
An independently reviewed comparison finds identical Git blobs for 18 relevant
files: block/transaction/header formats, required block routes, history reader,
stats, settings and mainnet defaults, and node/wallet/network entrypoints.
No inspected witness-source requirement needs the later RocksDB migration.
This is scoped source compatibility; existing fixture provenance pins remain
unchanged, and no stable-node sync or fixture ancestry has been demonstrated.
Keeping all historical blocks also does not guarantee historical AD proofs:
the shared UTXO path retains generated proofs only within its configured suffix.
The current fixture comparison needs transaction spending proofs instead.

On 2026-09-12, the [worker](../experiments/ergo-range/NodeStableStorage.java)
and [launcher](../experiments/ergo-range/node-stable-storage.ps1) successfully
exercised the actual stock `LDBVersionedStore`, using ordinary node options:

- Write version 1; write version 2 with an update, removal and insertion.
- In a fresh JVM, verify version 2, reject an unknown rollback target without
  changing values/version, then roll back and verify version 1.
- In another fresh JVM, verify that version 1 and its restored values persisted.

Every `Try` result is checked, and success is emitted only after closing the
store. All three workers selected the native `JniDBFactory`; experimental
pure-Java fallback is refused. The compiler and workers exited 0 with empty
process jobs. Their durations were 3,077 / 10,412 / 10,870 / 10,367 ms.
There were 136 socket observations with no sockets, and the final run contained
22 files / 2,675,278 bytes, including three extracted native-library files.
The initial helper compilation failed on an ambiguous Scala bridge method;
the corrected direct Buffer-to-Seq conversion compiled and passed the run.

The reused supervisor limits each process to nominally 30 seconds, 1 GiB commit,
25% CPU scheduling and 64 KiB output; the launcher observes a 16 MiB file threshold.
These observations are not hard disk/network containment, and synchronous
observer calls can delay the wall deadline. Native factory selection does not
hash the actually loaded module. The upstream store uses non-sync writes;
normal close/reopen does not establish power-loss durability, crash recovery,
disk-full behavior, compaction stress, full sync or protocol recovery acceptance.
See [reproduction](../experiments/ergo-range/README.md#stable-stock-storage-control).

## Stable offline startup and settings

The existing preparation, startup and settings scripts accept explicit
`-Stable`; without it their historical prerelease paths/pins remain available.
Each selection has fixed artifact hashes and separate scratch paths, with no
automatic fallback. Stable extraction reproduced the exact manifest SHA-256
`df98bdbfa029ad3aaeabb3968a2b73cdaa92769d93192bc25b4c8f298102dce6`.

The [actual stable startup report](ergo-stable-startup-verification.json) passed
on 2026-09-12. `/info` returned 200 and `appVersion=6.0.5`, expected mainnet UTXO
genesis state, absent header/full-block fields, mining false and zero peers.
`/peers/connected` returned an empty array; unauthenticated `/wallet/status`
returned 403. The secret directory stayed empty. The run took 74,377 ms, peaked
at 341,958,656 process-job commit bytes, and observed 966,600 combined file/output
bytes. All 287 socket samples were consistent with loopback TCP only, and the
process job was empty after cleanup. This is source-configured offline startup,
not network isolation, a synchronized chain or a production deployment.

The [stable typed-settings report](ergo-stable-settings-verification.json) used
the actual stock loader after startup. The baseline selected mainnet UTXO,
transaction verification, all retained blocks, explicit absent checkpoint,
disabled UTXO/NiPoPoW bootstrap, zero stored snapshots, no mining/extra index,
and absent test mnemonic/key count. The JVM pruning override was detected and
rejected as a validation profile; removing checkpoint=null restored the mainnet
default and was likewise rejected. All three processes exited 0 with empty jobs:
8,023 / 9,429 / 6,480 ms. Final files were 9,319 bytes and data/secrets stayed empty.

Independent review checked the actual package-selection patch before execution
and the actual reports afterward. The same startup reply and combined-byte
predicates accept the stable observations; process/resource/HTTP controls remain
unchanged. Preparation and startup establish distribution identity and observed
behavior, not reproducible-build provenance, crash durability, complete effective
configuration or zero packets. Wallet actors/routes and wildcard CORS remain
under the previously recorded no-spending-key experiment scope. The next source
step is bounded sync preparation and peer-parser/runtime review, not native
library qualification. See [reproduction](../experiments/ergo-range/README.md#stable-node-startup-and-settings).

## Maintained Java and connected candidate

The next standard-node candidate uses the unchanged stable JAR with the official
[Temurin 21.0.12.1+1 Windows x64 JRE](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.12.1%2B1),
published 2026-08-19. The separately downloaded ZIP is 48,999,141 bytes, SHA-256
`d35f31e712f0fcf6ac5a093edc90204fbff22f720ba3950bd09d331d5e621636`, matching the
GitHub asset digest. It expands to 315 files / 151,524,241 bytes; the generated
manifest is pinned at `fab21196a9f51cdc4678b5ffbe4ba3ad5ccdf945863024b16400d15a7c03ac1d`.
Every consumer verifies that complete inventory. The runtime remains alongside
the original bundle in scratch; system Java and bundle members are unchanged.
This selects a current standard Java 21 maintenance release, not a custom build
or a claim that a runtime update fixes an observed database failure.
The [combined evidence](ergo-maintained-java-verification.json) records artifact
identity, independent reviews, the source inventory and disposable-file cleanup.

The [storage result](ergo-maintained-java-storage-verification.json) passed
write/update/delete, fresh-process rollback and another fresh-process readback.
The [startup result](ergo-maintained-java-startup-verification.json) observed
Java 21.0.12.1 and Ergo 6.0.5, expected genesis UTXO state, zero peers and wallet
HTTP 403. Startup lasted 73,624 ms with 341,065,728 peak job-commit bytes;
285 socket samples were loopback-only and combined file/output bytes were
966,056. The [settings result](ergo-maintained-java-settings-verification.json)
retains baseline and pruning/checkpoint controls. Existing evidence limits and
process budgets apply; these results do not establish connected sync, disk
isolation, crash recovery or runtime security certification.

The [candidate network overlay](../experiments/ergo-range/node-sync-network.conf)
is only combined with the fresh full-UTXO/no-spending-key baseline. It selects
four mainnet seed addresses, four target connections, no discovery, no local
peers, loopback listeners and no UPnP/declared address. Connect/handshake/delivery
timeouts are 1/30/10 seconds; inactivity is 2 minutes with the source's 60-second
sweep. The [actual typed readback](ergo-sync-settings-verification.json) checks
the exact candidate and rejects a JVM override to five connections, along with
the existing pruning and checkpoint controls. It starts no actors or sockets.
The first candidate-reader compilation refused an ambiguous Scala iterator
bridge; the corrected JavaConverters bridge compiled and all four cases passed.
The five compiler/readback processes exited 0 with verified limits and empty
jobs, peaking at 206,827,520 commit bytes. Final files were 13,239 bytes, with
empty data and secrets directories.
The peers are untrusted bootstrap endpoints from pinned mainnet configuration;
three connected during the bounded run below. Peer count is a scheduler target, and
the addresses are not a kernel connection quota or an egress allowlist.

An independent bounded source review checked 86 files against their Git blobs
at stable commit `5528ef569a41ebccbc8658212e6ee3c97d990b96`. The
[framing parser](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/network/message/MessageSerializer.scala)
caps payloads at 16,388,608 bytes. The
[peer handler](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/scorex/core/network/PeerConnectionHandler.scala)
bounds its backpressured outbound buffer to 16,388,621 bytes / 64 messages per
peer, but supplies no independent per-frame completion deadline or message-rate
cap. Other queues, parsing, validation and logging can exhaust resources or
stall sync. Such an outcome ends the finite experiment without accepted sync
evidence. This is not a general hostile-code sandbox or a complete node audit.

Disabled bootstrap/snapshot flags do not unregister every incoming parser.
Unsolicited NiPoPoW proofs can supply sparse headers while no best header exists;
this is a limit on interpreting header height, not a demonstrated bypass of full
UTXO validation. The
[full-block height rule](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/nodeView/history/storage/modifierprocessors/FullBlockPruningProcessor.scala#L48)
starts full blocks at genesis under the selected settings, and
[UTXO application](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/nodeView/state/UtxoState.scala#L112)
executes transactions and checks state roots. Keep normal proof-quorum settings;
require applied full-state ancestry for fixture acceptance. Snapshot subtree
parsing also remains reachable. No native decompressor call was found in the
inspected wire parser paths; ordinary native LevelDB storage remains reachable.
The [official advisory index](https://github.com/ergoplatform/ergo/security/advisories)
listed no published advisories when checked; this is not absence-of-defects
evidence. [Issue 2470](https://github.com/ergoplatform/ergo/issues/2470) describes
a 6.0.3RC1 chain-tip wedge, not a verified exploit against this candidate.

## Offline node on the capped volume

The [fixed launcher](../experiments/ergo-range/node-volume-control.ps1) now
combines the standard stable node and maintained JRE with the existing disk,
drive-letter, process-job and traffic controls. Its default is read-only; its
only execution mode is offline on a newly created fixed 64 MiB VHD. There is no
existing-disk selector, custom library or connected mode. Exact reviewed
offline-config bytes are checked before substituting the owned run path and a
new unavailable API-authentication target. All known worker data/temp/home and
diagnostic paths use the mapped volume. Synchronous observation reads only
counters, mapping, host reserve, sockets and fixed diagnostic names; it does
not walk a live database tree. Three asynchronous bounded API reads start after
60 seconds, followed by ten seconds of observation and a whole-job stop.

The [actual result](ergo-node-volume-verification.json) passed on 2026-09-12:

- One node process, 71,117 ms, peak commit 372,654,080 bytes, with 4 GiB commit,
  2 GiB heap, 25% CPU scheduling and 120-second nominal wall limits.
- Expected Ergo 6.0.5 genesis UTXO state, empty peers, wallet HTTP 403 and
  276 loopback-only socket observations. Secret storage was empty at the end.
- Real host traffic 3,444,749 bytes across 278 samples; largest gap 309 ms.
  The stop decision was at 71,165 ms, empty job confirmed at 71,209 ms, and
  final sample spanned 71,211–71,213 ms. Accounting remained valid.
- Fixed virtual size 67,108,864 bytes; backing file 67,109,376 bytes. The
  formatted NTFS volume was 65,990,656 bytes, including its metadata capacity.
  Final inventory: 54 files / 899,803 logical bytes. Fixed diagnostics were
  1,156 bytes and captured console output 4,326 bytes.
- The owned mapping was removed, disk detached and exact image deleted after
  successful process, final-accounting and identity checks. Recorded host free
  space before allocation and after detach exceeded the 100 GiB reserve.

Independent review found and corrected a duplicate HTTP-reader disposal before
execution; disposal now occurs once before final accounting. Final diagnostic
lengths are checked after the job is empty. Twenty-six pure evidence cases
cover successful boundaries and rejection of wrong exits, missing cleanup,
excess resources, invalid counters and late stop/final timing.

The real window uses the planned 8 GiB trigger / 10 GiB final-traffic maximum,
including unrelated host traffic. It does not claim an exercised 8 GiB transfer
or measured worst-case stop overshoot. The fixed VHD bounds its contents, not
all JRE/OS writes, paging or supervisor allocations. Synchronous OS calls may
stall; timing checks reject late evidence rather than proving independent hard
deadlines. The stop is not graceful shutdown, crash recovery or chain sync.
Failed runs retain their image after best-effort cleanup and cannot claim empty
jobs or reusable database state. Stable host administration/path identity is
assumed; these are owned-volume controls, not a hostile-code filesystem sandbox.

Windows requires elevation for disk operations. The earlier control above
inherited elevation; the current
[split launcher](../experiments/ergo-range/node-volume-split.ps1) starts the
node under an ordinary user and checks its token before resume. A separate
fixed elevated owner creates and retains the VHD; it never starts Java. The
ordinary session verifies the volume GUID/DOS mapping and actual file access.

A fresh named job is opened by the owner before it publishes its bounded
GUID/PID/creation-time handoff. Normal completion follows node termination,
final traffic accounting, API-reader disposal and volume inventory. The owner
then terminates and verifies the job empty **after** authenticated completion
or bound-parent death closes further launch admission, before unmapping and
detaching. Independent review caught a stale empty-job check on an error path;
the final check now follows admission closure. Twelve native handoff/job guard
cases supplement the existing 26 process/traffic evidence cases.

The owner's nominal four-minute timeout stops current job members but retains
the volume until parent completion or death. This prevents a paused parent
from later launching against a removed volume; a stuck live parent can retain
the helper and disk indefinitely. Helper termination itself can detach the
volume before Java exits and remains outside the cleanup claim. Host identity
and same-user IPC remain trusted. No ACLs, native package or protocol rules
changed. The [actual split result](ergo-node-volume-split-verification.json)
passed on 2026-09-12: ordinary parent and verified non-elevated child, one JVM
for 71,409 ms, 440,512,512 bytes peak commit, expected genesis UTXO state,
275 loopback socket samples, empty peers/secrets and wallet HTTP 403. Traffic
was 7,520,534 bytes across 277 samples with a 373 ms maximum gap; stop to empty
job took 48 ms and final accounting finished 6 ms later. Normal cleanup removed
the mapping, detached the disk and deleted its exact 67,109,376-byte image.

The separate failure control killed its dedicated ordinary supervisor at the
first JVM observation with one active job member. Its bound owner recorded
parent exit, terminated and verified the job empty, removed the mapping and
detached/deleted its own image without error. Both images, the six recorded
process IDs and the logical/DOS drive reservation were independently absent
afterward. This demonstrates parent-death cleanup, not a general failure matrix.

The concrete `-Sync30Minutes` profile now adds the named fixed 20 GiB / 30-minute
entrypoints while retaining the offline defaults. Its
[preparation record](ergo-node-sync-preparation.json) pins the actual sources,
standard packages and peer overlay. Independent source review found no material
blocker; 25 profile/evidence and 49 loopback-reader cases pass alongside the
existing affected guards. The unchanged full protocol suite is reused from
`7c27a06`, whose CI 34688754933 passed. This follows the revised verification
rule: scope checks to affected behavior rather than rerun unrelated tests.

The selected peer overlay was already independently read back through the
node's typed settings. Both Java and node distributions remain unchanged.
The node is ordinary, REST/P2P listeners stay on loopback, and no wallet keys
are installed. Sockets remain sampled observations rather than enforced egress.
The 20 GiB image is retained detached after the owned cleanup, preserving
partial progress for inspection without implementing arbitrary image reopening.
See [connected reproduction](../experiments/ergo-range/README.md#bounded-connected-source-sync).

Metadata reads report partial progress honestly: best headers may be ahead of
the applied full-state tip. Correlation checks the state-version/full-header
ID, header height/root and the UTXO application log; bracketing-view stability
is recorded separately. Fixtures at heights 100,000, 1,000,000 and 1,500,000
remain not reached or ancestry not checked until the explicit parent-chain
comparison has actually completed. A 30-minute measurement is not a promise
of full sync or fixture verification.

The 20 GiB / 30-minute / 10 GiB final traffic envelope was explicitly approved
after the initial request was rejected for missing allocation/execution approval.
The [actual connected result](ergo-node-sync-verification.json) records a
282,315 ms run, stopped at the 12 MiB console trigger. Three peers connected.
The last API observation reached 25,733 headers; the retained log later reached
33,263. All sampled full heights were null, and no full-state application or
fixture ancestry was demonstrated. The last API sample predates stopping by
about 42 seconds, so neither value is asserted as final database state.

Observed host traffic was 133,770,818 bytes; peak node commit was 625,156,096
bytes. Maximum accounting gap was 382 ms, stop-to-empty 105 ms, and final
accounting completed 6 ms after empty. The ordinary child exited; its owner
removed the mapping and detached the image. Independent post-run checks found
all recorded processes and the drive reservation absent, opened the retained
image exclusively and matched its GPT disk GUID. The backing remains
21,474,836,992 bytes. This establishes early output stopping, not 30-minute
endurance or the 8 GiB traffic-trigger path.

The node's typed settings loader resets the Logback root using
`scorex.logging.level`, which inherited INFO despite XML root WARN. The worker
now explicitly selects WARN in HOCON while retaining UtxoState INFO for applied
block evidence. The [offline logging regression](ergo-node-sync-logging-verification.json)
exercises the actual pinned settings loader and reproduces the old override.
It starts no node services. Executed source hashes remain in the original run
report; this logging correction has not had another connected execution.

The stock scheduler requests no full blocks until its header chain reaches a
recent header (approximately 200 minutes from the node clock under the pinned
defaults). Thus early header-only progress is expected. This operational gate
does not require current full-state catch-up for the later historical fixture
comparison. See the pinned [download gate](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/nodeView/history/storage/modifierprocessors/ToDownloadProcessor.scala#L82)
and [logging override](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/settings/ErgoSettingsReader.scala#L30).
Historical custom RocksDB controls are not prerequisites or fallback work.

### Retained-image continuation

The next bounded measurement explicitly uses `-ResumeSync` with the corrected
logging and the existing fixed image. Native opening checks its normalized
recorded path suffix, exact backing size and GPT disk identity, then fixed-provider
size. The elevated owner verifies the recorded GPT disk, partition GUID, offset,
size and NTFS volume before exposing a drive letter. The ordinary worker checks
the original configuration and empty secrets before reusing data. No partition
initialization, formatting, resize or image deletion occurs in this branch.
An exclusive owner lock rejects concurrent continuation and an already-attached
image is refused. This is limited to the first recorded configuration, rather
than an arbitrary database reopening interface. The native call follows
[OpenVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-openvirtualdisk)
version 1 with read/write depth 1 and only attach, detach and information access.
The trusted-host and helper-failure limitations above still apply.

Acceptance for this continuation is surviving database restart, measured header
or applied-state progress, preserved resource bounds and verified detachment.
If it remains header-only, preserve that result and move to pool service/client
transport. The authenticated external-history gate remains open; it does not
block independent local transport and wallet integration work.

The [actual continuation](ergo-node-sync-resume-verification.json) reopened the
same image and observed three peers and 97,923 headers over 415,386 ms. Captured
output was only 1,905 bytes, confirming the logging correction; host traffic
was 418,472,522 bytes. Full heights remained null. The measurement was manually
ended once restart and continued header progress were established, rather than
waiting for full-chain synchronization. The separate stop record confirms one
process became zero in 24 ms. Owner cleanup removed the drive mapping and
detached the retained image; independent process/drive/exclusive-file checks passed.

The automatic report remains unresolved because external exit does not meet
its observer-stop contract. Its raw result is preserved, without weakening that
guard. The last API sample preceded termination by about 55 seconds; final worker
secrets, volume and diagnostic checks were not reached. Initial empty secrets,
wallet refusal, final owner cleanup and the manual-stop record remain distinct
observations. No full-state application, ancestry or full-sync claim is made.
The node is currently stopped. Unattended background synchronization is an
allowed follow-up, but this one-time configuration-pinned launcher is not yet a
general long-running node service. Product transport work proceeds independently.

## Predeclared resource envelope

The implemented limits below belong to the explicitly approved first bounded
sync. Reaching a bound yields partial or unresolved evidence; it does not
permit an automatic increase, longer run or second retained 20 GiB image.

| Resource | Implemented sync profile |
|---|---|
| Data disk | New fixed 20 GiB VHD; at most 20 GiB + 1 MiB backing bytes; retained detached after cleanup |
| Host space | At least 121 GiB before setup; at least 100 GiB during observations and cleanup |
| Node | One ordinary-user JVM, creation-time job assignment, 4 GiB job/process commit, 2 GiB heap, 25% CPU scheduling |
| Time | Native 30-minute node wall limit; observer requests stop ten seconds earlier; owner timeout 36 minutes including setup |
| Traffic | Real host-interface accounting, 8 GiB trigger / 10 GiB final ceiling; includes unrelated/duplicated interface traffic |
| Accounting acceptance | Maximum 1-second sample/final delay; stop decision to confirmed empty job at most 2 seconds |
| Console/diagnostics | 15 MiB native capture cap; observer stops at 12 MiB; combined observed diagnostics/output at most 16 MiB |
| Reports | At most 16 MiB JSON; bounded console prefix/tail plus digest of all captured text; 64 KiB handoffs |
| Local metadata | Fixed GET endpoints, one request at a time, 128 requests, 1 MiB per response, 8 MiB total, 5 seconds per request |

The fixed volume bounds its own contents, not every OS/JRE write, cache, paging
operation or supervisor allocation. Sampling and synchronous OS calls are not
an independent hard deadline, firewall or traffic quota. CPU rate is not a
fixed total CPU-time budget. Failed/late accounting remains unresolved rather
than being excused by otherwise successful sync.

At owner timeout, existing job members are stopped while the disk remains
mounted until parent completion/death closes further launch admission. A stuck
live parent can retain it indefinitely. Killing the elevated owner itself may
detach before Java exits; that failure ordering is not demonstrated. Normal
and parent-death cleanup have the earlier actual 64 MiB evidence; the 20 GiB
profile has demonstrated the early stop documented above. No host firewall, ACL, WSL or system
Java changes are part of this experiment.

The first large-image attempt failed before node startup: Windows created a
Microsoft Reserved GPT partition covering the requested 1 MiB data offset.
[Captured evidence](ergo-node-sync-first-preparation.json) records the raw GPT,
empty job, detachment and subsequent exact-image deletion. The reviewed fix
uses [Storage's automatic placement](https://learn.microsoft.com/en-us/powershell/module/storage/new-partition?view=windowsserver2025-ps)
on the fresh sync image, then applies the existing data-partition identity and
capacity guards before formatting. Offline placement is unchanged. No peer or
Java ran in that failed preparation; the retry uses the same approved envelope.

## Validation and local service requirements

The selected stable package and typed-read-back configuration require:

| Setting | Selected value |
|---|---|
| Network | Explicit `--mainnet`, fresh empty database |
| State / transaction validation / retained blocks | `utxo` / `verifyTransactions=true` / `blocksToKeep=-1` |
| UTXO bootstrap / stored snapshots | `false` / `0` |
| NiPoPoW bootstrap / checkpoint | `false` / explicit `null` |
| Mining / offline generation / extra index | All `false` |
| REST / P2P listener | `127.0.0.1:19053` / `127.0.0.1:19030` |
| UPnP / declared address / REST public URL | `false` / `null` / `null` |
| Peers | Exact pinned four-peer overlay; discovery disabled; maximum four connections |
| Spending keys | No secret file, test mnemonic, restored seed or test keys |

Explicit checkpoint null matters: an omitted override inherits the mainnet
checkpoint. Disabling bootstrap does not remove incoming proof/snapshot parsers.
The source review and its limits are recorded in the maintained-Java evidence
above. Source pins remain separate from the original fixture provenance.

The stock binary still mounts wallet actors/routes and wildcard CORS; parsed
CORS settings do not remove that surface. The reviewed no-spending-key choice
uses a fresh uninitialized wallet, unpredictable API-key hash with no retained
preimage, local listeners and an allowlisted GET reader. No seed, funds,
restoration, signing or transaction submission is needed or authorized. The
unauthenticated wallet status must return 403 and final secrets remain empty.
This does not claim wallet services are absent or a production security boundary.

For the offline control only, the peer list is empty and maximum connections
is zero. Empty peer configuration or sampled sockets alone do not prove packet
isolation. The connected profile deliberately permits its four configured
public peers while preserving local listeners and the same validation settings.

## Acceptance after a controlled sync

Preserve source/package/config hashes, fresh-database evidence, exact Java
arguments, process/disk/traffic observations and the owned cleanup report.
Separate header progress, historical applied-state observations, a stable
selected view and completed catch-up; none implies the others automatically.

For a partial applied-tip observation, bracket a returned full-header read with
`/info`. Require mainnet, Ergo 6.0.5, UTXO state, mining false and genesis
`b0244dfc267baca974a4caee06120321562784303a8a688976ae56170e4d175b`.
Correlate nonzero `stateVersion = bestFullHeaderId = returnedHeader.id`,
`fullHeight = returnedHeader.height`, and the matching state root. Record the
specific UTXO application log for that ID/height. Its pinned
[implementation](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/nodeView/state/UtxoState.scala)
logs after transaction application and root checks. A generic modifier-success
log can refer to another block section and is insufficient.

Record whether the bracketed applied IDs, heights and roots stayed equal.
A changed view can still support a historical application observation with
matching evidence, but not a stable current view or completed ancestry audit.
Header height/best-header ID may be ahead during useful partial sync. Full
catch-up additionally needs header/full/state tips and respective scores to
agree, with independent current-chain comparison; it is not the first run's
minimum progress criterion. Local selection is not eclipse resistance.

The [fixture manifest](../experiments/ergo-range/fixtures/manifest.json) pins
heights 100,000, 1,000,000 and 1,500,000. A fixture above observed full height
is `not-reached`; a reached height without checked links is
`ancestry-not-checked`. Neither `/blocks/at/{height}` nor a returned body proves
membership: the former returns all stored IDs at that height.

Future ancestry reads must walk bounded `/blocks/chainSlice` windows backwards
from a captured applied header. Require exact ascending heights, each parent
link, the anchored upper ID and shared boundary between windows. The
[pinned routes](https://github.com/ergoplatform/ergo/blob/5528ef569a41ebccbc8658212e6ee3c97d990b96/src/main/scala/org/ergoplatform/http/api/BlocksApiRoute.scala)
cap slices at 16,384 headers and may choose/fall back to a different header at
the requested upper height, so the upper-ID check is mandatory. The current
metadata reader does not allow chain slices; a bounded ancestry-read extension
and its byte/time envelope remain owed, not silently bypassed with another client.

After membership, compare all 24 transaction IDs, the fields/IDs of all 65
outputs, their order and the three version-dependent transaction roots using
the existing experiment. Do not compare JSON whitespace or infer original wire
bytes from parsing. Version 1 transaction roots do not bind spending-proof
bytes. Recheck the applied view/ancestry after reading; changed views, budget
exhaustion or missing data leave evidence unresolved. Three noncontiguous
fixtures do not establish contiguous ranges, publication order, recovery,
production resource sufficiency or a completed product gate.

## Earlier evidence and superseded preparation

The former detailed preflight is retained at
[commit 7c27a06](https://github.com/mediumofexchange/reference-ts/blob/7c27a06cde901f80fac0100771ddb2e30a5ea6e1/docs/ERGO_NODE_PREFLIGHT.md).
It records prerelease artifact inspection, offline controls, native-loader
reconciliation, WSL experiments, rejected custom builds and earlier proposals.
Those are historical observations, not additional prerequisites or an execution
queue. Raw verification JSON and committed recipes remain available.

### First-sync control selection

The current selection is standard Windows packages, an ordinary node and the
small elevated disk owner described above. The
[earlier platform comparison](https://github.com/mediumofexchange/reference-ts/blob/7c27a06cde901f80fac0100771ddb2e30a5ea6e1/docs/ERGO_NODE_PREFLIGHT.md#first-sync-control-selection)
preserves rootless WSL, native disk and traffic-control evidence and limitations.
Do not revive a discarded custom library or repeat completed platform controls
without new evidence that affects this selected path.

### Published Windows native reconciliation

The [historical reconciliation](https://github.com/mediumofexchange/reference-ts/blob/7c27a06cde901f80fac0100771ddb2e30a5ea6e1/docs/ERGO_NODE_PREFLIGHT.md#published-windows-native-reconciliation)
preserves the prerelease DLL/version observations and their evidence limits.
It does not impose a custom-library or version-label gate on the selected
standard stable package.

### Prepared offline database control

The [historical control](https://github.com/mediumofexchange/reference-ts/blob/7c27a06cde901f80fac0100771ddb2e30a5ea6e1/docs/ERGO_NODE_PREFLIGHT.md#prepared-offline-database-control)
preserves the earlier fixed offline database experiment and refusal evidence.
Current standard-package and split-volume acceptance records are linked above.
