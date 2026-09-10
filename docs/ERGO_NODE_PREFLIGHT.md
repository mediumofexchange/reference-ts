# Dedicated Ergo node preflight

Status: 2026-09-10, artifact inspection and launch requirements only. No node
was installed, extracted, executed or synchronized. The runtime remains v2;
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
| First sync measurement | 30 minutes; same memory/CPU controls; 20 GiB dedicated data volume; 10 GiB combined network traffic | Demonstrated disk ceiling and traffic accounting/stop mechanism; preserve at least 100 GiB free on C:; report stop latency and any overshoot |
| Logs | 16 MiB aggregate for an attempt | Bounded capture including JVM/node file logs, not only stdout; stop on exhaustion |
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
hash of `hello` or wildcard CORS. An API authentication secret is distinct from
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

Keep this distinction in the next decision. The smallest alternatives are:

- Retain the stock binary with a fresh uninitialized wallet, an unpredictable
  API-key hash whose preimage is not retained, local listeners and a reader
  that has only bounded public GET access. This avoids a node fork and spending
  keys but retains wallet code and depends on authentication/isolation; it
  changes the experiment's service-disabling requirement and needs review.
- Omit wallet actor/routes through a minimal source change or an upstream
  supported option. This can satisfy literal service removal, but introduces
  a changed artifact, build provenance and continuing maintenance/review costs.

Neither alternative is adopted by this preflight. An HTTP proxy alone leaves
the underlying wallet routes present and does not establish their removal.

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

## Next executable slice

Resolve the service boundary above with independent review before choosing
the executable artifact. Prefer reusing the stock node if its uninitialized,
authentication-isolated wallet preserves the actual no-spending-key invariant;
do not describe it as wallet-service removal. Falsifier: any reachable route,
startup behavior or persisted data can generate/import/use a spending key
without the deliberately unavailable authentication capability.

Then build a fixed-purpose offline startup supervisor for the chosen artifact.
Acceptance is a short process with no wallet/spending keys, local-only
listeners, effective settings, job limits and whole-job cleanup read back,
plus no outbound traffic. Only a separately controlled sync can produce the
fixture and validation evidence. No production dependency is selected here.

Independent source/claim review caught the omitted prerelease label, now
corrected, and confirmed the always-present wallet surface and API membership
limits. No material preflight finding remains. It did not approve a future
wallet-boundary relaxation or establish startup/resource/sync evidence.
