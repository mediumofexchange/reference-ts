# Ergo venue probes

Private probes of the Ergo venue profile, whose runtime code is in `src/`
(`ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`,
`ergo-publisher.ts`, `record-range.ts`); nothing here is exported. Each probe
is run explicitly, never by `check` or CI, and reads the runtime from `dist/`,
so run `npm ci` and `npm run build` at the repository root first (Node 24);
the directory has no dependencies of its own. The probes read nodes with GET
only, but for [node answers](#node-answers)' one refused submission. Do not expose a probe as an arbitrary-file or network
verification API.

The fixture manifest pins the original public response bytes before parsing;
Git attributes preserve those raw responses, including trailing whitespace.
`test/ergo-supplier.test.ts` reads them.

The v3 replay reads Ergo through `ErgoVenue` over the synthetic reference
chain (`src/ergo-synthetic.ts`) under `npm run check:pool:ergo-replay`; the
[Ergo venue guide](../../docs/ERGO_VENUE_PROFILE.md#local-replay-through-the-venue)
describes it.

## Supplying the reader

`src/ergo-supplier.ts` copies each transaction's unsigned bytes from the node's
JSON, as the Ergo venue guide's [costs and limits](../../docs/ERGO_VENUE_PROFILE.md#costs-and-limits)
describe; `test/ergo-supplier.test.ts` supplies these fixtures
([evidence](../../docs/ERGO_VENUE_PROFILE.md#evidence)).

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

## Node answers

`record-node-answers.mjs <node> <second node>` asks two real nodes the six
calls the runtime's node publisher makes (read-only but for one submission
of non-transaction bytes, which a node refuses) and writes their answers to
`test/fixtures/ergo-node-answers.json`, against which
`test/ergo-node-answers.test.ts` checks the node publisher and `MempoolNode`,
the mempool the synthetic node serves.

## Retired tooling

Retired probes are kept in Git history; each one's permalink and result are
in its section of the [deployment probes](../../docs/POOL_DEPLOYMENT_PROBES.md)
or the [Ergo venue guide](../../docs/ERGO_VENUE_PROFILE.md). This guide's last
full list of them: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/experiments/ergo-range/README.md#retired-tooling).
