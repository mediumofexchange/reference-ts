# Ergo range-source feasibility

Private probes of the Ergo venue profile, whose runtime code is in `src/`
(`ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`,
`record-range.ts`); nothing here is exported. The checked command connects to
nothing; the explicit probes below read nodes (GET only), and only
[publication](#publication-and-reassembly-on-a-node) submits, on the testnet. Use Node 24, then from the repository root:

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
[Retired tooling](#retired-tooling) for the permalinks.

## Supplying the reader

The profile's reader takes each transaction as its unsigned bytes
and witness id and frames the outputs itself. `src/ergo-supplier.ts` is the supplier:
it copies the unsigned bytes from the node's JSON statement of a transaction
(`/blocks/{id}/transactions`), hex fields and integers as they stand, and
hashes the stated proofs for the witness id; it parses no constant and runs
no decoder. Its small strict parser keeps object keys in text order (a
spending-proof extension's key order is part of the bytes, and a parsed
JavaScript object would sort it) and integers exact. A copy that does not
hash to the stated id is unsupplied, never misread
([decision](../../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)).
`test/ergo-supplier.test.ts` supplies every fixture
transaction, reproduces the four fixture roots from the copies and checks
each refusal; it also copies every fixture header, of versions 1 to 4, to its
id, and drives `ergoNodeSupplier` over HTTP responses.

## Real-chain exhaustion cost

`chain-cost.mjs` is the recovery map's P4: it measures what the
[profile's](../../docs/ERGO_VENUE_PROFILE.md) exhaustion costs on
mainnet from a real anchor. It is run explicitly, never by `check` or CI,
because it reads public nodes (GET only; nothing is submitted):

```powershell
node experiments/ergo-range/chain-cost.mjs --from 1873361 --count 5040 --depth 10 --out scratch/chain-cost.json
```

The anchor is the block below `--from`; indices `0..count-1` are the next
`count` heights, and headers are read up to `count - 1 + depth` above the
anchor so the last index is witnessed. Every response is cached by name under
`--cache` (default `scratch/ergo-chain`); `--offline` reuses the cache,
refuses anything missing and records no live node state, and only the same
window's header slices replay; `--delay` paces live reads, which rotate over
`--sources` with backoff when a node throttles. Each source's headers are
compared field by field, and the anchor's id is read from each; a
disagreement gives an unresolved report and exit 2. Each block's
transactions are supplied through `src/ergo-supplier.ts`, and a block's section counts
only where every transaction is supplied and the header's transaction root
holds through the model's root; the report compares every framed
transaction's outputs with the node's JSON and totals the supplied and
section bytes. The model verifier is built from the real headers and the
supplied sections with four throwaway locations, so every answer is empty by
exhaustion; its construction is where every output is scanned, and its
single-index probes, the last-day and whole-window requests and the
unresolved indices are reported. The [retained report](../../docs/ergo-chain-cost-verification.json)
records the window and anchor, the nodes' agreement, a digest of every
cached response the run read, sizes and times.

## Publication and reassembly on a node

`publish.mjs` is the recovery map's P2: it publishes the profile's
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
through `src/ergo-supplier.ts` and asks the kind-4 range under the subject. `--state` (default
`scratch/ergo-testnet/run.json`) records every step, including the run's
pinned creation height, and `--resume` continues an interrupted run,
re-submitting only what the node does not already hold, or re-reads a
finished one; `--poll`, `--max-wait` and `--delay` pace it. The
[retained report](../../docs/ergo-publication-verification.json) is the
2026-09-24 run on the own testnet node: the node's acceptance, sizes, values,
each transaction's inclusion latency, the UTXO check and the read-back.

## Signing library build

The publication experiment signs, and the fixture and profile checks build
trees and constants, with `vendor/ergo-lib-wasm-nodejs`, a release build of
sigma-rust `2f840d3` installed as a `file:` dependency
([decision](../../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3)).
No reader or supplier path uses it. Upstream's npm alphas of that commit are
debug builds (`wasm-pack build --dev`) that overflow Node's default stack and
trap on expression nesting of 50. `sigma-release-build.sh` rebuilds the
package from a fresh checkout with the vendored lockfile, Rust 1.87
(`wasm32-unknown-unknown`) and the wasm-bindgen 0.2.128 CLI, and checks the
committed and the built files against `SHA256SUMS`; the bytes reproduce on a
Windows host (panic locations keep the host's path separators):

```bash
WASM_BINDGEN=<path to wasm-bindgen 0.2.128> bash experiments/ergo-range/sigma-release-build.sh
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

## Reader-verified headers

`header-verify.mjs` runs the reader's own header store
(`src/ergo-headers.ts`) on real mainnet headers. Each header's
bytes are copied from a node's JSON by `src/ergo-supplier.ts` (unsupplied
unless the copy hashes to the stated id); the store builds from the 1,024
headers below the pinned anchor by linkage, then verifies every header above
it from each source in turn (own node, then two public nodes), and its best
chain must be every source's chain and feed the range verifier. It also
checks nine real-data mutations for their refusal reasons and, with
`--recalculations`, the model's EIP-37 difficulty and proof of work at every
recalculation since activation against the first source's accepted headers.
Responses are cached under `scratch/ergo-headers/`
([retained report](../../docs/ergo-header-verification.json)):

```powershell
node experiments/ergo-range/header-verify.mjs --anchor 1873360 --to 1880300 --recalculations --out docs/ergo-header-verification.json
```

## Venue-profile checks

`npm run check:ergo:range` runs, in order, the block-root/Fleet experiment
(`check.mjs`) and `profile-check.mjs`.

`profile-check.mjs` compiles `src/ergo-profile.ts` with the
repository root's TypeScript into a disposable `scratch/` build, so run it
after `npm ci` at the root. It builds a twelve-height synthetic chain from
Fleet's unsigned bytes of transactions carrying real signed records in
`R4`/`R5` register constants, which the model's framer reads, and
checks the [candidate venue profile](../../docs/ERGO_VENUE_PROFILE.md):
pool-v3 §13 answers by exhaustion over root-checked blocks, the reader's
rules over them, refusals for unwitnessed, gapped, unlinked or substituted
evidence, tolerance of stray and duplicate blocks, a transaction outside the
framer's grammar, the pinned
mainnet genesis header (`fixtures/mainnet-genesis-header.json`, listed under the
manifest's `headers`) as the chain's anchor, and the four fixture blocks
through the same verifier, their framed transactions against the node's
outputs and every real register constant read beside
sigma-rust's. Its [retained report](../../docs/ergo-range-profile-verification.json)
is an offline observation; nothing connects to a node or selects the profile.

## Runtime venue on the mainnet

`runtime-sync.mjs` runs the runtime's `ErgoVenue` (`src/ergo.ts`) on the
real mainnet: anchored `--blocks` (default 300) below the own node's tip at
the default depth, a view syncs from the own node and a public node, then a
second view from the public node alone, and a supplier that substitutes one
section and one that raises one header's difficulty are each set beside the
own node. It needs the own mainnet node running, caches nothing and writes
the [runtime venue report](../../docs/ergo-runtime-venue-verification.json):

```powershell
node experiments/ergo-range/runtime-sync.mjs --out docs/ergo-runtime-venue-verification.json
```

## Hostile-input node equivalence

`hostile-equivalence.mjs` takes the 29 hash-pinned corpus transactions'
unsigned bytes as `src/ergo-supplier.ts` copies them, mutates them deterministically
(every byte replaced by four values, deleted, and preceded by 0x00 and 0x80;
every proper prefix; seeded splices from other seeds) and reads each case
through `node-read/NodeRead.java`, which frames it as a one-transaction
version-4 block section, reads it offline with the pinned v6.0.6 node JAR's
own `BlockTransactionsSerializer` and states the node's ids, its own
unsigned bytes (`messageToSign`), parsed ErgoTree bytes and register
constants in that transaction's version context. Every reading the node
gives (whole cases, prefixes and its rewrites, each rewrite read again) is
put through the reader's path: its unsigned bytes must hash to the node's
id, and where the profile's framer reads them the outputs must be the
node's (`counts.framer`). The node's runtime has no compiler, so a JDK
compiles the harness; the own node's bundle ([Own nodes](#own-nodes))
supplies the JAR and runtime:

```powershell
node experiments/ergo-range/hostile-equivalence.mjs --jdk <jdk-21 dir>
```

It writes the [retained report](../../docs/ergo-framer-hostile-equivalence-verification.json)
and keeps its cases and the node's answers in `scratch/hostile-framer/`;
the run takes about two minutes.

## Retired tooling

The reader's decoder tooling (the unmetered `decoder.mjs` and its corpus,
the contained and metered derivations with their Wasmtime probe, the stack
check, the decoder-against-node equivalence driver over the own node's
retained blocks, and the decoder side of the hostile probe) was retired on
2026-09-24 when the supplier stopped decoding; its reports stay in
`docs/ergo-decoder-*.json` and `docs/ergo-meter*.json` as history, and the
scripts are kept at the
[`0453955` revision](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).

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
