# Ergo venue probes

Private probes of the Ergo venue profile, whose runtime code is in `src/`
(`ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`,
`ergo-publisher.ts`, `record-range.ts`); nothing here is exported. Each probe
is run explicitly, never by `check` or CI, and reads the runtime from `dist/`,
so run `npm ci` and `npm run build` at the repository root first (Node 24);
the directory has no dependencies of its own. The probes read nodes with GET
only, except the [publisher check](#runtime-publisher-on-the-testnet), which
submits on the testnet. Do not expose a probe as an arbitrary-file or network
verification API.

The fixture manifest pins the original public response bytes before parsing;
Git attributes preserve those raw responses, including trailing whitespace.
`test/ergo-supplier.test.ts` and the hostile probe read them.

The v3 replay reads Ergo through `ErgoVenue` over the synthetic reference
chain (`src/ergo-synthetic.ts`) under `npm run check:pool:ergo-replay`; the
[Ergo venue guide](../../docs/ERGO_VENUE_PROFILE.md#local-replay-through-the-venue)
describes it.

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
practical sources for the probes, not a hardened or process-contained
deployment.

## Runtime publisher on the testnet

`publisher-check.mjs` runs the runtime's `ErgoPublisher` on the own testnet
node: three records chained in the mempool, a corrupted proof refused, a
lost answer retried without a second transaction, and the including blocks'
sections read back under the profile. It signs with the throwaway key in
ignored `scratch/ergo-testnet/wallet.json` and refuses a node that does not
report the testnet
([publisher report](../../docs/ergo-publisher-verification.json);
[guide](../../docs/ERGO_VENUE_PROFILE.md#runtime-venue)):

```powershell
node experiments/ergo-range/publisher-check.mjs --node http://127.0.0.1:9052 --out docs/ergo-publisher-verification.json
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

On 2026-09-25 the probes whose questions were answered or whose checks the
runtime's tests now cover retired, together with the Fleet dependency and the
vendored sigma-rust release build (and its reproducible-build script) that
only they used: the block-root/Fleet experiment and the range-profile check
(`check.mjs`, `profile-check.mjs`, formerly `npm run check:ergo:range`), P4's
chain cost (`chain-cost.mjs`), P2's testnet publication (`publish.mjs`), A10's
latency collector (`latency.mjs`) and the own-node standing check
(`header-check.mjs`). Their reports and scripts, and this guide's sections
for them, are kept at the
[`1b4857a` revision](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range)
([decision](../../decisions/2026-09.md#2026-09-25--retire-probes-whose-questions-are-answered)).

The reader's decoder tooling (the unmetered `decoder.mjs` and its corpus,
the contained and metered derivations with their Wasmtime probe, the stack
check, the decoder-against-node equivalence driver over the own node's
retained blocks, and the decoder side of the hostile probe) was retired on
2026-09-24 when the supplier stopped decoding; the scripts are kept at the
[`0453955` revision](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range),
and the reports (`docs/ergo-decoder-*.json`, `docs/ergo-meter*.json`) at
[`1915d5d`](https://github.com/mediumofexchange/reference-ts/tree/1915d5d/docs).

On 2026-10-04 three real-chain probes retired, their reports having been
cited only as history since `6e4cea8`: the mainnet header check
(`header-verify.mjs`), the reference-testnet header check
(`testnet-header-check.mjs`) and the runtime venue on the mainnet
(`runtime-sync.mjs`). `test/ergo-headers.test.ts` holds real mainnet and
testnet recalculation windows for the header rules, and the live testnet
drill (M10d) runs the runtime venue on a real chain; mainnet stays disabled.
The scripts, this guide's sections for them and every report retired with
them are kept at the
[`1915d5d` revision](https://github.com/mediumofexchange/reference-ts/tree/1915d5d/experiments/ergo-range).

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
