# Ergo range-source feasibility

Private probe; no runtime exports and no transaction submission. The checked
command connects to nothing; only the explicit [chain-cost probe](#real-chain-exhaustion-cost)
below reads public nodes. Use Node 24, then from the repository root:

```powershell
npm --prefix experiments/ergo-range ci --ignore-scripts --no-audit --no-fund
npm run check:ergo:range
```

The [deployment evidence](../../docs/POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
records source pins, observed coverage, counterexamples and the next source gate.
The fixture manifest pins the original public response bytes before parsing;
Git attributes preserve those raw responses, including trailing whitespace.
Do not expose this probe as an arbitrary-file or network verification API.

A retired Windows-only preflight covered a separately built/run dedicated
node; that path is superseded by [Own nodes](#own-nodes) below, which runs
the project's official v6.0.6 distribution directly. See
[Retired platform controls](#retired-platform-controls) for the permalink.

## Real-chain exhaustion cost

`chain-cost.mjs` is the recovery map's P4: it measures what the
[candidate profile's](../../docs/ERGO_VENUE_PROFILE.md) exhaustion costs on
mainnet from a real anchor. It is run explicitly, never by `check` or CI,
because it reads public nodes (GET only; nothing is submitted):

```powershell
node experiments/ergo-range/chain-cost.mjs --from 1873361 --count 5040 --depth 10 --alternate scratch/sigma-0.28.0 --out scratch/chain-cost.json
```

The anchor is the block below `--from`; indices `0..count-1` are the next
`count` heights, and headers are read up to `count - 1 + depth` above the
anchor so the last index is witnessed. Every response is cached by name under
`--cache` (default `scratch/ergo-chain`); `--offline` reuses the cache,
refuses anything missing and records no live node state, and only the same
window's header slices replay; `--delay` paces live reads, which rotate over
`--sources` with backoff when a node throttles. Each source's headers are
compared field by field, and the anchor's id is read from each; a
disagreement gives an unresolved report and exit 2. Transaction bytes come
from each transaction's exact text in the node's JSON (its spending-proof
extension's key order is part of the bytes, and a parsed object would sort
it) through the pinned sigma-rust serializer, and a block's section counts
only where its bytes reproduce the header's transaction root through the
model's root; `decoder.mjs` then reads them, and `--alternate` names a
directory holding another `ergo-lib-wasm-nodejs` install that reads the
same bytes through the script's verbatim copy of that round trip, checked
against `decoder.mjs` on the pinned build for every transaction, with the
two builds' outputs compared (the alternate's version and WASM hash are
recorded; nothing is pinned by it). The pinned build is the vendored
[release build](#decoder-build) of sigma-rust `2f840d3`; earlier pins are
useful controls: 0.28.0 under `scratch/sigma-0.28.0`
(`npm install ergo-lib-wasm-nodejs@0.28.0 --ignore-scripts`) shows the Ergo 6.0
refusals, and the debug npm alpha `0.29.0-alpha-2f840d3` under
`scratch/sigma-alpha` the same commit's reading. Moving the pin again means
rerunning this window offline from the cache with zero refusals, every root
reproduced and no differing view against the build being replaced.
The model verifier is built from the real headers and the read sections
with four throwaway locations, so every answer is empty by exhaustion; its
construction is where every output is scanned, and its single-index probes,
the last-day and whole-window requests and the unresolved indices are
reported. The [retained report](../../docs/ergo-chain-cost-verification.json)
records the window and anchor, the nodes' agreement, a digest of every
cached response the run read, sizes, times and the refusals by output tree
version.

Over the [own node](#own-nodes)'s retained blocks the same probe runs in
chunks, then an offline pass compares each decoded transaction with the
node's JSON, and a summary adds them up:

```powershell
node experiments/ergo-range/equivalence-driver.mjs
node experiments/ergo-range/equivalence-fields.mjs
node experiments/ergo-range/equivalence-summary.mjs --out docs/ergo-decoder-equivalence-verification.json
```

The driver's constants fix the heights (the node keeps its last 50,000 full
blocks); it and the field pass write to `scratch/equivalence/` and skip a
chunk whose report exists, so either resumes. The field pass recomputes each
chunk's cache digest before comparing, so it reads exactly the responses the
chunk read, links the headers by id, and compares the decoder's id, witness
id, output count and every output's ErgoTree, register names and register
constants with the node's fields; mutating each of those fields in one real
transaction per chunk must show as a difference. The summary requires the driver's exact plan, chunks joined by
header id, every root reproduced, no refusal and no differing field
([result](../../docs/POOL_DEPLOYMENT_PROBES.md#decoder-node-equivalence-over-the-retained-blocks)).

## Publication and reassembly on a node

`publish.mjs` is the recovery map's P2: it publishes the candidate profile's
kind-4 layout on the public Ergo **testnet** and reads it back through the
model verifier. It is run explicitly, never by `check` or CI, because it
submits transactions to and reads blocks from a public node. It refuses any
node whose `/info` does not report the testnet and signs only with a
throwaway key read from ignored `scratch/ergo-testnet/wallet.json`
(`{ "network": "testnet", "secretHex": "...", "address": "..." }`; make one
with the pinned library's `SecretKey.random_dlog()` and never copy it into
the repository). Fund the address with testnet ERG from a public faucet
(about 0.05 tERG covers a run), then:

```powershell
node experiments/ergo-range/publish.mjs --dry-run --out scratch/ergo-testnet/dry-run.json
node experiments/ergo-range/publish.mjs --node http://213.239.193.208:9052 --depth 2 --out scratch/ergo-testnet/live.json
```

The dry run builds and signs every case over a synthetic funded input and
reads them back from one synthetic block under the real latest header; it
reads only `/info` and the signing context, caches both together on the first
run and is offline afterwards, and submits nothing. The live run chains six cases (the release, its duplicate, its pieces reordered,
three of four pieces, the release and a withdrawal adjacent, and the two
separated by a plain output), waits for inclusion and the depth, sweeps every
piece box back to the wallet, waits again, checks the UTXO and indexed views,
then reads every block from the header below the first inclusion to the tip
and asks the kind-4 range under the subject. `--state` (default
`scratch/ergo-testnet/run.json`) records every step, including the run's
pinned creation height, and `--resume` continues an interrupted run,
re-submitting only what the node does not already hold; `--poll`,
`--max-wait` and `--delay` pace it. The [retained report](../../docs/ergo-publication-verification.json)
is the 2026-09-22 testnet run: the node's acceptance, sizes, values, each
transaction's inclusion latency, the UTXO check and the read-back.

## Decoder build

The decoder is `vendor/ergo-lib-wasm-nodejs`, a release build of sigma-rust
`2f840d3` installed as a `file:` dependency
([decision](../../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3)).
Upstream's npm alphas of that commit are debug builds (`wasm-pack build --dev`)
that overflow Node's default stack and trap on expression nesting of 50.
`sigma-release-build.sh` rebuilds the package from a fresh checkout with
the vendored lockfile, Rust 1.87 (`wasm32-unknown-unknown`) and the
wasm-bindgen 0.2.128 CLI, and checks the committed and the built files against
`SHA256SUMS`; the bytes reproduce on a Windows host (panic locations keep the
host's path separators), and the corpus checks every installed file against
the same list:

```bash
WASM_BINDGEN=<path to wasm-bindgen 0.2.128> bash experiments/ergo-range/sigma-release-build.sh
```

An overflow or trap inside the module leaves its one instance unusable, so
`decoder.mjs` treats it as fatal, never as a refusal. `stack-check.mjs`
measures the stack each build needs and the deepest nesting it parses, each
trial in a fresh process, with earlier builds as controls
([retained report](../../docs/ergo-decoder-stack-verification.json)):

```powershell
node experiments/ergo-range/stack-check.mjs --control scratch/sigma-alpha,scratch/sigma-0.28.0 --out docs/ergo-decoder-stack-verification.json
```

`metered-check.mjs` meters the pinned release build under the metering
probe's Wasmtime install ([below](#metered-decoder-feasibility)) over the
corpus and, with `--week`, the P4 window reserialized from the
`scratch/ergo-chain` cache (about 17 minutes); it also shows that the
node's JSON field split is not bound by the transaction id
([retained report](../../docs/ergo-metered-release-verification.json),
[probe](../../docs/POOL_DEPLOYMENT_PROBES.md#metered-release-decoder-over-the-week)):

```powershell
node experiments/ergo-range/metered-check.mjs $probePython --week > docs/ergo-metered-release-verification.json
```

## Inclusion latency on the mainnet

`latency.mjs` measures recovery-map A10 passively: it polls a public mainnet
node's pool ids and blocks (GET only, no key, nothing submitted) and times
each first sighting as `k`, the inclusion height less the node's height at
that sighting, bracketed above by the height one round earlier. Under C3.3 a
demand authorized at the tip with the instant at the latest witnessed index
has force for `1 <= k <= depth + 2`; the report gives that fraction for
depths 0–20, with dropped sightings as misses and unfinished ones censored.

```powershell
node experiments/ergo-range/latency.mjs --hours 24 --tail-minutes 60 --out scratch/ergo-latency/report.json
node experiments/ergo-range/latency.mjs --report-only --out <report>
```

The state (`scratch/ergo-latency/run.json`) keeps the collector's script
hash and arguments; `--resume` continues an interrupted run and flags the
gap, and `--report-only` recomputes the report and checks the window's
chain against the node (parent links to its reported tip, recorded ids) and
a second node (`--offline` skips both).

The day from 2026-09-22 19:22 UTC is retained as
[the latency report](../../docs/ergo-latency-verification.json), paired with
the own node's observation (`--pair`); the result and its limits are in
[deployment probes](../../docs/POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet).

## Own nodes

`nodes.mjs` runs our own mainnet and testnet nodes from the official
`ergo-node-v6.0.6-windows-x64.zip` (108,925,914 bytes, SHA-256
`311c0b1b9a451b50badc2c3d998a2d919a2efa9fd517682927015169a04a82c5`, from
the v6.0.6 release) extracted to `scratch/ergo-nodes/v6.0.6/`; `start`
checks the JAR against the release digest, writes each node's
configuration and a random API key under `scratch/ergo-nodes/<network>/`
and launches the bundled Java detached. The host may be turned off: `start`
again resumes from the data directory.

```powershell
node experiments/ergo-range/nodes.mjs start      # or: stop, status; [mainnet|testnet]
node experiments/ergo-range/nodes.mjs watch 10   # appends status to scratch/ergo-nodes/status.jsonl
```

Mainnet bootstraps from a UTXO-set snapshot but downloads the full header
chain from genesis (no NiPoPoW proof), so this node checks every header's
proof of work; it keeps the last 50,000 full blocks, API `127.0.0.1:9053`.
Testnet is a full archive with the extra index, API `127.0.0.1:9052`. P2P
listeners are bound to 127.0.0.1 (outbound peers only), mining is off and
no wallet is initialized. v6.0.6 answers every request with
`Access-Control-Allow-Origin: *` whatever `corsAllowedOrigin` says
(upstream `CorsHandler` and `ErgoHttpService` hardcode it), so a page in a
local browser can read the API and use its key-free routes. These are
practical sources for the experiments, not a hardened or process-contained
deployment.

Once the mainnet headers pass the chain-cost window, `header-check.mjs` checks
that the pinned fixtures and that window stand on the node's best chain and
that the node agrees with two public nodes near the tip; the
[retained report](../../docs/ergo-own-node-verification.json) also records
the sync cost:

```powershell
node experiments/ergo-range/header-check.mjs --out docs/ergo-own-node-verification.json
```

## Full binary decoder and venue-profile checks

`npm run check:ergo:range` runs, in order, the block-root/Fleet experiment
(`check.mjs`), the
[full binary decoder experiment](../../docs/POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)
(`decoder-check.mjs`) and `profile-check.mjs`. `decoder-check.mjs` launches
the fixed corpus in a child process with a 120-second deadline and 1 MiB
output cap. The corpus checks fixture pins, all output fields/IDs, every
proper transaction prefix, trailing bytes, nonminimal counts and JSON
field-boundary aliases. Input budgets are experimental refusal limits;
there is no hard process/WASM memory cap and no production decoder selection.

`profile-check.mjs` compiles `model/pool-v3-ergo-profile.ts` with the
repository root's TypeScript into a disposable `scratch/` build, so run it
after `npm ci` at the root. It builds a twelve-height synthetic chain from
Fleet-serialized transactions carrying real signed records in `R4`/`R5`
register constants, decodes them with sigma-rust's strict round trip, and
checks the [candidate venue profile](../../docs/ERGO_VENUE_PROFILE.md):
pool-v3 §13 answers by exhaustion over root-checked blocks, the reader's
rules over them, refusals for unwitnessed, gapped, unlinked, substituted or
truncated evidence, tolerance of stray and duplicate blocks, the pinned
mainnet genesis header (`fixtures/mainnet-genesis-header.json`, listed under the
manifest's `headers`) as the chain's anchor, and the four fixture blocks
through the same verifier with every real register constant decoded beside
sigma-rust's. Its [retained report](../../docs/ergo-range-profile-verification.json)
is an offline observation; nothing connects to a node or selects the profile.

## Contained decoder

The reader's decoder is `contained-decoder.mjs`; the replay adapter
(`replay-venue.mjs`), the v3 Ergo check and `profile-check.mjs` read through
it. `wasm-meter.mjs` derives, from the vendored release build, a module with
fuel charged at every function entry and loop head, bulk memory, memory
growth and table growth routed through charged, capped helpers, and a call
depth counted at every call site against a ceiling; the derivation is
deterministic and its SHA-256 is pinned. Each transaction runs in a fresh
instance of that module with every import trapping, under the budget
`budgetFor(length)` declares; fuel, memory, table and depth exhaustion and
traps refuse that transaction with a reason and leave the next unaffected.
A caller must leave the V8 stack the check measures for the depth ceiling
to refuse before the engine's stack does. `decoder.mjs` stays the unmetered reference the chain-cost,
equivalence, publication and stack probes bound in their reports.

`contained-check.mjs` runs in `npm run check:ergo:range`: hand-counted
exact-cost controls on an assembled module, the corpus against
`decoder.mjs`, reduced budgets, synthetic hostile inputs and, in child
processes at reduced `--stack-size`, the least V8 stack the depth ceiling
needs. `contained-range.mjs` compares
the contained decoder's fields with the node's over cached blocks and
records each transaction's fuel and memory; the
[retained report](../../docs/ergo-decoder-containment-verification.json)
embeds its summaries:

```powershell
node experiments/ergo-range/contained-range.mjs corpus > scratch/containment/corpus.json
node experiments/ergo-range/contained-range.mjs week > scratch/containment/week.json
node experiments/ergo-range/contained-range.mjs retained --from 1830001 --to 1846367 > scratch/containment/retained-a.json
# ... likewise 1846368-1862734 (b) and 1862735-1879100 (c), in parallel if cores allow
node experiments/ergo-range/contained-check.mjs --report docs/ergo-decoder-containment-verification.json --ranges scratch/containment/corpus.json,scratch/containment/week.json,scratch/containment/retained-a.json,scratch/containment/retained-b.json,scratch/containment/retained-c.json
```

The week reads `scratch/ergo-chain` and the retained set
`scratch/ergo-chain-own` ([Real-chain exhaustion cost](#real-chain-exhaustion-cost)).

## Hostile-input node equivalence

`hostile-equivalence.mjs` mutates the 29 hash-pinned corpus transactions
deterministically (every byte replaced by four values, deleted, and preceded
by 0x00 and 0x80; every proper prefix; seeded splices from other seeds) and
reads each case twice: through `node-read/NodeRead.java`, which frames it as
a one-transaction version-4 block section, reads it offline with the pinned
v6.0.6 node JAR's own `BlockTransactionsSerializer` and states the node's
ids, parsed ErgoTree bytes and register constants in that transaction's
version context, and through `contained-decoder.mjs`. Where the node writes
what it read as other bytes, the node and the decoder also read that
rewrite. Every pair is classified by whether the decoder reads the node's
ids and fields, other ids (which the header's transactions root refuses), the
node's ids with other fields (the disagreement the root would not catch), or
refuses. The node's runtime has
no compiler, so a JDK compiles the harness; the own node's bundle
([Own nodes](#own-nodes)) supplies the JAR and runtime:

```powershell
node experiments/ergo-range/hostile-equivalence.mjs --jdk <jdk-21 dir>
```

It writes the [retained report](../../docs/ergo-decoder-hostile-equivalence-verification.json)
and keeps its cases and the node's answers in `scratch/hostile-equivalence/`.

## Metered decoder feasibility

`metered-check.mjs` ([Decoder build](#decoder-build) above) needs a pinned
Wasmtime engine reachable at `scratch/metering-python`. Install it once with
an isolated Windows x64 Python 3.9+ interpreter and the pinned wheel hashes
in `metering-requirements.txt`, then pass that interpreter's path as
`$probePython` to the decoder-build commands above:

```powershell
$probePython = 'C:\path\to\python.exe'
& $probePython -m pip install --no-deps --only-binary=:all: --require-hashes --target scratch/metering-python -r experiments/ergo-range/metering-requirements.txt
```

`metering-check.py` (loaded as a library by `metered-check.py`, which
`metered-check.mjs` invokes) checks the loaded engine's package/DLL paths
and Wasmtime **48.0.0** version before decoding, and traps rather than reads
guest memory on every imported host function. `metered-check.mjs` runs it
with a 20-minute timeout (60 minutes with `--week`); no production or
default-check dependency is added, and the scratch Python install can be
removed after a report is captured and reproduced with the same command.

## Retired platform controls

Earlier sessions (2026-09-10 through 2026-09-12) evaluated a Windows-hosted
contained Ergo node: stable/maintained-Java stock storage, a native RocksDB
build, WSL and disk/traffic/volume containment controls, a bounded connected
node-sync, and Windows Job Object process containment of the standalone
decoder, plus retired `cost-check`/`cost-observer` decoder-cost profiling.
None cleared its acceptance gate, and all of it is superseded by
[Own nodes](#own-nodes) above (decision 2026-09-10, own-node evidence
2026-09-22). The full history, including every retired script and probe
report, is kept at the immutable
[`c85af7b` revision](https://github.com/mediumofexchange/reference-ts/tree/c85af7b/experiments/ergo-range).
