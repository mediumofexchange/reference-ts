# Six successor proof relations

Run `npm run check:pool:v3` from the repository root. This compiles and proves
all six relations against one shared `notes.nr` and the existing pinned
Poseidon2 helper. It implements the proof layouts in
[pool-v3.md at d57ddb0](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md).

V3 is adopted with one configuration (pool-v3 §11.4), whose manifest the
runtime holds in `src/pool/v3/configuration.ts`. The runtime in `src/pool/v3/`
runs on reference venues only; these scripts are its conformance tooling and
hold the only circuit sources (pool-v2's are retired to Git history).
The compiler writes temporary projects only under ignored `scratch/` and
the check records observed source/bytecode/key hashes, checks and metrics in
`scratch/pool-v3-results.json`. It reuses the existing parameter cache and
runs Barretenberg with one worker thread. The sources hold final text: their
comments cite pool-v3, pool-v2, pool-recovery, pool-delivery and pool-fees
rules by section. Their hashes are the manifest's source identities, and the
check asserts that the identities it derives frame §11.4's configuration hash.

The package ships the compiled relations in `src/pool/v3/programs.json`
(compiler version, ABI and bytecode; no debug fields, which hold the compiling
machine's paths), and the runtime proves and verifies only those
(`programs.ts`, `verifier.ts`). `programs.mjs` (`npm run check:pool:v3-programs`)
compiles the sources again and requires that file to match exactly, the ABI
included; `--write` regenerates it.

`store-check.mjs` (also `npm run check:pool:v3-store`) runs the runtime's
operator journal, prover and guard (`src/pool/v3/store.ts`, `prover.ts`,
`guard.ts`) with real proofs on the local reference venue and records
`scratch/pool-v3-store-results.json`; its fresh reader is `local-worker.mjs`.
Use `npm run check:pool:v3-store -- --ergo` to run that same issue, payment
with fee/change and burn flow through `ErgoPublisher` and `ErgoVenue` on the
synthetic reference chain. A synthetic mempool checks the signed transactions;
the harness explicitly mines and syncs before the reader consumes them.
The fresh reader gets served blocks and keeps its witnessed block pin in
`ergo-pin.bin` beside its keys, outside the supplied package. Wrong pins and
withheld sections refuse. This uses invented funding and no live node; the
synthetic chain establishes no deployment.
Both modes guard journal and reader entries against the caller's independently
held reference identity preimage.

`synthetic-node.mjs` serves the synthetic chain and its mempool through the
node REST paths `ergoNodeSupplier` and `ergoNodePublisher` call, plus two drill
paths that fund a key and mine, so slice 10's command drill runs each party in
its own process through the clients the live venue uses. It binds loopback
only and is not shipped. `synthetic-node-check.mjs`
(`npm run check:pool:v3-synthetic-node`, part of `check:scripts`) runs it as a
separate process, compares its answers with real node answers recorded by
`experiments/ergo-range/record-node-answers.mjs`
(`test/fixtures/ergo-node-answers.json`), and reads back the four record kinds
a view published through it.

`history-store-check.mjs` (`npm run check:pool:v3-history`) is the real-proof
acceptance of storage independent of history, on the local reference venue:
73 statements, more than one package in memory once held, served by stream; a
payer wallet on its kept evidence and replay files paying from kept witnesses;
a fresh seedless reader process (`--reader`) on files of its own; and an
offline-operator recovery in which a holder forces redemption with the service
down, the operator returns and adopts, and the wallet proves its lapsed payment
again. It records `docs/pool-v3-history-store-verification.json`.

The live command drill (`command-drill.mjs --testnet --authorized-testnet`,
[M10d](../../../decisions/2026-10.md#2026-10-06--drill-the-moe-commands-live-on-the-testnet-and-keep-the-testnet-context-without-a-difficulty-floor-slice-10-m10d))
is the live evidence; `testnet.mjs` holds its node and transfer helpers, and
`npm run check:pool:v3-transfer` (part of `check:scripts`) checks the transfers offline. The
store checks' live testnet modes (`store-check.mjs --testnet`,
`recovery-store-check.mjs`/`scope-store-check.mjs --testnet --authorized-testnet`)
are retired ([decision](../../../decisions/2026-10.md#2026-10-07--retire-the-store-checks-live-testnet-modes-the-command-drill-is-the-live-evidence-simplify));
they, their publication guard and their readers of the retained public bundles
are at [`09534a8`](https://github.com/mediumofexchange/reference-ts/tree/09534a8/scripts/pool/v3),
and their runs are [recorded with the journal acceptance](../../../docs/POOL_DEPLOYMENT_PROBES.md#reference-operator-journal).
Current work belongs in WORK.md.

The local replay command additionally checks, against the runtime manifest
(`manifest.mjs`, pool-v3 §§11.1, 11.4), all six source/toolchain/bytecode/key
identities, the 439-byte adopted configuration a package carries and signed
constant-root terms before local replay. The domain is the adopted
configuration's hash; issuance keys come from the signed terms. See the
[local replay evidence and limits](../../../docs/POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay).

Fresh readers additionally decode the canonical §12 evidence package at
specification `10dcf67`. One configuration and commitment are supported; the
selection's snapshot and trail are resolved by hash, and the other carrying
checkpoints' directories, snapshots and trails are its dependencies, with
byte/item budgets and no first-match selection of conflicting objects. The
same local replay engine checks the contents; package framing cannot
establish complete dependencies, authenticated ranges or spendability.
With a fixture venue, the runtime's one reader walk (`scope-reader.ts`, for a
scope of one backing or several) classifies each carrying checkpoint the read
depends on from its own trail, and under a declared silence clause the
no-commitment clock, the silence boundary and lapse by silence are read
from that walk (C2b.6.1, C2b.4.1). For a selection with imports, the walk
descends every operator term and requires each segment's exact finalized predecessor. It imports the validated spent set,
output commitments, accepted roots and totals, then starts an empty local
output tree. Reappointment and same-operator restart use the same rule.
Imported wallet paths retain their source trees. Only per-object budgets
bound this path (the whole-read checkpoint and event totals were removed in
M5b.3b); each record's proof is verified once, and a checkpoint
whose trail reproduces the last valid checkpoint's evidence hash at its length
resumes from a copy of that replayed state under the same replay context,
verifying only its new positions (C2.10.12, pool-v3 §7.1). Any other trail
replays in full with unchanged checks. A checkpoint's served trail may be the
prefix of any longer supplied trail of its segment whose decodable first n
records reproduce its evidence hash, and signed terms are resolved by backing
name from any strictly verifying field ([pool-v3 §12.1 at 786f962](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#121-a-package-is-not-a-complete-certificate)),
so a package needs one trail per chain of prefixes ([time and bytes](../../../docs/POOL_DEPLOYMENT_PROBES.md#replay-and-retention-cost)).
The replay-state probe, retired after M5b.6 ([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/6c7d8f2/scripts/pool/v3/replay-store-probe.mjs)),
measured this state's memory against the storage layout M5b moved it to, the runtime
reader, journal and wallet over long histories, and the first sync with real
verification load ([evidence](../../../docs/POOL_DEPLOYMENT_PROBES.md#replay-state-storage)).
The design-point probes, retired with slice 11 ([commands](https://github.com/mediumofexchange/reference-ts/blob/fa8384d/scripts/pool/v3/design-point-probe.mjs)
and [runtime at depth](https://github.com/mediumofexchange/reference-ts/blob/1a3f76d/scripts/pool/v3/runtime-depth-probe.mjs)
at their last revisions), measured the `moe` commands with real proofs and the runtime under real
verification load to 10⁵ statements against the declared budgets
([evidence](../../../docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3)).
Silence-bearing imports read the independently answered publication
range, classify demand/withdrawal/release force against each original snapshot,
and preserve retirement after another segment resets the clock. A returning
segment adopts the complete block through its opening index in venue order,
retaining the exact proof and authorization bytes. Standing demands and locks
survive imports; settlement outputs restore from public fields and the seed.
Same-index fresh openings import the latest valid lower same-operator sequence
under [C2b.4.1 at fb7dd07](https://github.com/mediumofexchange/money-from-first-principles/blob/fb7dd07/pool-recovery.md#6-return).
Their inherited adoption indices preserve publications still owed, while gap
and publication-force reads stay strictly before the index.
The scope classifier also handles two-backing split/rejoin histories, shared
ancestry, per-backing adoption obligations and their exact publication union.
Import lapse authenticates scope
and terms independently of event history; live validity and exclusion retain
their complete evidence requirements.

Kind-7 package items carry existing §9 compact fault openings. When a checkpoint
is reached, the reader can authenticate its committed target proof without
unrelated event preimages and retain a `PROOF` fact in `faultEvidence`, including
on later refusal or lapse. Exact commitment, position and byte hashes identify
the observation. Every scoped term must match the adopted configuration
and venue. Only a supported proof verifier's strict rejection produces a fact;
exceptions propagate. Facts never decide classification, state, clocks or receipt
status. Missing complete history still prevents exclusion and import descent.
The same inventory also reports strict signature failures for issue K, settlement
acceptance K, withdrawal presenter and settlement release presenter. K comes from
the target backing's signed scoped terms. A presenter's key comes from the exact
canonical demand statement whose hash the target names, carried in another compact
item. The dependency item's opening need not authenticate: its statement preimage
establishes identity, never demand admission or standing. Missing/mismatched demand
preimages suppress presenter observations while independent K failures remain.
Facts name the expected signer and role and attribute the committed bytes to the
operator. Signature checks do not require a valid or well-shaped proof. Unsupported
authorization widths, malformed targets, zero-owner acceptance messages, capsules
and admission failures remain outside this reporter.
Per-read local limits are 32 compact items, 1 MiB of backing
allocations and 1024 suffix entries per item; proof results are cached by exact
evidence identity. These limits do not change protocol bounds or grant finality.

A package containing one kind-10 receipt requests a seedless receipt read.
The checkpoint walks authenticate its opening, complete original scope and
held `after`, compare all five event fields, and apply receipt precedence
through the earliest scoped silence or term boundary. A transition carrying
any original backing counts, including one dropping the selected backing.
Held noncarrying and excluded checkpoints occupy sequences for repair reads.
The reader stops at proven inclusion;
later unavailable evidence cannot erase it. Other refusals retain already
proven contradictions in `receiptEvidence`. Adopted receipts name the new
segment and position while retaining original proof and authorization hashes.
Receipt results expose no wallet candidates or spending authority. Multiple
receipts per package and any read without venue evidence are unsupported.

Signed non-service terms enable a seedless C2b.5.2 count in the audit. The
reader uses the canonical checkpoint strictly before the judging index,
including imported roots, spent tags and standing locks. It groups request
publications by statement identity at their first index, verifies any proof
variant available strictly before judgment, and counts distinct unserved
tags in the signed window. Handover preserves requests and changes the
incumbent. Across scope changes the selected backing retains its own clause;
sibling durations, thresholds and windows need not agree. Shared canonical
roots, spent tags and locks feed the same counter. Checkpoints at the judging
index and unadopted recovery publications cannot change its strictly earlier
state. A non-service clause needs no silence clause; without the former
there is no count. Missing range or ancestry evidence returns no audit.
The count adds no budget of its own and shares the fixture authority boundary.

The reader is the runtime's `readPackage` (`src/pool/v3/package-reader.ts` in
`dist/`): `local-replay.mjs` encodes each fixture as §12 bytes, reads it under
the venue the verifier's record factory selects (a `RecordVenue`,
`FixtureVenue` by default), and reports the result in the harness's fields with
the seed's notes; a refusal keeps the facts the read established before it.

To replay every group above a second time through `ErgoVenue`, run
`npm run check:pool:ergo-replay` (Node 24; it needs only the root
dependencies). CI uses `npm run check:pool:v3 -- --ergo` to include both
relation conformance and this read. Under `--ergo` every fixture names the
synthetic reference chain's venue identity; each fixture venue export is
written into blocks of that chain (index `i` is the block `i + 1` above the
anchor, lag 2 is depth 1, one transaction per record in insertion order), the
reader's own `ErgoVenue` verifies them from its own anchor context up to the
block the reader pinned (a heavier re-mined branch is refused), and the
Ergo result must equal the fixture venue's with kind-4 ordinals as
transaction positions. Missing, unframable or root-mismatched sections stop
the clock and leave the range unresolved. Successful results carry
`ergo-venue-synthetic-chain` provenance; they establish no mainnet
authentication or spendability.
See the [Ergo venue guide](../../../docs/ERGO_VENUE_PROFILE.md#local-replay-through-the-venue).

The npm command fetches the proving parameters with `../prepare-crs.mjs` before
starting the suite: the leading 2 MiB of the CDN's uncompressed `g1.dat` (2^15
BN254 G1 points, the largest relation's size) and `g2.dat`. It checks both
upstream hosts on download failure, verifies length and SHA-256 before caching,
and accepts a longer cached copy by its leading bytes. Every harness then proves
and verifies only on instances from `startBackend`, which checks the same hashes
again before loading and never lets bb.js read a directory or download (nor run
while `BB_WASM_PATH` would replace its WASM); `check.mjs` records
the hashes it loaded. They equal Aztec Ignition transcript00's leading points
([proving parameters](../../../docs/POOL_DEPLOYMENT_PROBES.md#proving-parameters));
that establishes their source, not ceremony trust.

The suite verifies every public-input position under each amended key,
equal-count spend/burn substitution in both directions, separately provable
metadata, and integer overflow with ABI range encoding bypassed while ACIR
stays identical. Hostile note witnesses recompute dependent hashes, paths
and sums where needed. Four-output and widened-conservation cases accompany
demand's canonical padding and request's refresh. The source orders are
issue 11, spend 15, burn 15, demand 16, settle 17 and request 7.

Domain and capsule fixtures are synthetic. The capsules exercise opaque
public-vector hashing only; no fixture claims receiver decryption. There is
no v3 key router, issuance authorization, admission/replay,
lock enforcement, finality, wallet restoration or complete venue evidence
in this check. `test/pool-v3-capsules.test.ts` covers the separate cryptographic
seam. Those tests and real-proof conformance do not close runtime gates.

The `src/pool/v3/records.ts` codec follows
[pool-v3 §§5–6 at ca727f6](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks canonical statement/publication bytes and signature-message
binding with no proof verifier; the runtime admits these bytes in the
operator journal (`check:pool:v3-store`).
