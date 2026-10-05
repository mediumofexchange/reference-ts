# Implementation status and specification revisions

Current implementation evidence and version boundaries. For an introduction and
source setup, see the [README](../README.md). For the next development task,
see [WORK.md](../WORK.md). Update this guide when a component or its specification
pin changes; dated decisions retain the reasoning behind those changes.

**Experimental; the API and wire format can change.** Source is the supported
way to try the implementation. There is no published npm release, no
deployment, and no completed security audit.

The pool runtime is the guarded pool-v3 runtime in `src/pool/v3/`, under the adopted configuration (pool-v3 §11.4), over the
shared primitives in `src/pool/` (field, Poseidon2, notes, note tree, scope and
proof verifier). It implements issue, payment, burn, single-backing recovery
and Ergo publication with bounded venue/publisher process persistence. The [v3 wallet](POOL_V3_WALLET.md) now persists C4.1–2 exact
requests and C4.5 final fulfillment after independent current-frontier replay,
including forced spends and locks. It pays exact requests and direct fee
requests (pool-fees C1.2.3–5) from one backing's holdings found by the C4.6
seed scan, in single- or multi-backing segments, saving the exact record with its reservations before submission,
re-proving it with the same outputs after its segment lapses, and reconciling
it from canonical evidence. The
[v3 loopback service](POOL_V3_SERVICE.md) adds bounded journal operations and
public package retrieval, with independently verified receiver fulfillment and
process retry/restart/fencing acceptance. Requests pass between wallets as
canonical frames authenticated by an independently obtained digest; v3 needs
no receiver endpoint. A wallet restores holdings from its seed alone, or its
complete local state from an encrypted offline handoff that freezes the source.
It also holds the redemption acts under service (issue, demand, accept, settle,
withdraw, burn; [guide](POOL_V3_WALLET.md#redeeming-and-issuing)) and, in a gap with the operator offline, publishes
demands, withdrawals and releases bound to the snapshot, with the disclosure count read from releases witnessed
without force. A wallet restored from its seed finds its standing demands by their presenter keys and
withdraws or settles them; an act whose segment ended fails and is made again. Any wallet reads a demand's
C3.8 outcome per witnessed index (settled, withdrawn or voided, else past its deadline the backer's dishonour or
the holder's lapse), and the backer publishes its acceptance; a gap release taken by another demand's settlement
is refused `TAKEN` and releases its acceptance (stand-in proof cases, slice 9 M9a–M9c1). With real proofs, wallet
processes over the operator's service issue, pay, demand, accept, settle and burn, and demand and settle by
publication in a gap; a wallet restored from its seed settles and withdraws the standing demands it finds, and late,
forged and taken gap releases have no force ([local](pool-v3-redemption-store-verification.json), [synthetic Ergo](pool-v3-redemption-store-ergo-verification.json); M9d1–M9d2).
Each redemption act survives an abrupt exit at its commit (stand-in proofs).
Cancellation/release, statements spending several backings, continuous backup and physical
qualification remain open. Every read keeps its replay state in node:sqlite
(`replay-store.ts`, [storage decision](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)):
append-only facts read at a position, savepoints for refused checkpoints and
witnesses for a wallet's own notes. A reader may keep its classes, replays and
evidence in files across reads. The operator journal keeps its admission state,
records and served evidence in its own database, commits each command with all
it changes and reopens without verifying again (M5b.5a). It keeps its venue
answers there too and asks the venue only past the index they reach (M5b.5b.1).
It serves by stream and incrementally (M5b.5b.2); the wallet reads from kept
files (M5b.5c). A reader's replay verifies proofs ahead on a pool of verifier
instances, with verdicts and first failures unchanged (M5b.6,
[decision](../decisions/2026-10.md#2026-10-01--verify-a-trails-proofs-ahead-of-its-replay-on-a-pool-of-verifier-instances)).

Pool-v2 is retired: every remaining v2 check was mapped to a v3 case, a v2-only
mechanism or a later slice
([case map](../decisions/2026-09.md#2026-09-28--retire-v2-against-a-case-map-of-its-checks)),
and its runtime, guides and reports remain at
[a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

The transparent implementation and its local pilot are retired the same way
([case map](../decisions/2026-10.md#2026-10-03--retire-the-pilot-and-the-transparent-path-against-a-case-map-of-their-checks-slice-10-m10e1)),
and remain at [8d207eb](https://github.com/mediumofexchange/reference-ts/tree/8d207eb).
The duplicate private-payment experiment is retired;
its active case map and immutable historical report are in the architecture guide.

Use [the architecture map](PRIVATE_PAYMENT_ARCHITECTURE.md) for component
boundaries and retirement conditions, [production requirements](PRODUCTION_REQUIREMENTS.md)
for release gates, and [fault recovery](POOL_FAULT_RECOVERY.md) for the
selected rules and model limits of the companion's
[fault contract](https://github.com/mediumofexchange/money-from-first-principles/blob/23af0f5/pool-fault.md).

## Proof and deployment probes

`npm run check:pool:v3` exercises the real circuits and multi-segment replay
separately from the ordinary test suite, and proves the capsule digest's binding
in the successor relations, which retired the earlier
[delivery binding probe](POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration).
[Candidate restoration from exact signed local evidence](POOL_DEPLOYMENT_PROBES.md#restoration-from-exact-local-evidence)
retired once the v3 wallet took over its cases; the wallet restores from its seed
with full replay.

`npm run check:pool:local-replay` reads real-proof histories through the
runtime's `readPackage` (and, for single-backing compact faults, `readFrontier`)
under a harness-owned fixture venue: single- and two-backing imports, silence
and its clock, return and adoption, force, compact §9 faults, non-service counts
and receipts. The
[conditional initial-segment replay](POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay)
section owns the groups, fixtures, evidence and limits, and the
[retained report](pool-v3-local-replay-verification.json) records the checks.
`npm run check:pool:ergo-replay` repeats every group through `ErgoVenue` over
the synthetic reference chain ([local replay through the venue](ERGO_VENUE_PROFILE.md#local-replay-through-the-venue)).
Neither carries a live-chain claim, and neither establishes admission, spendability
or a complete fault certificate.
The successor's
[transfer shapes and ordinary fees](POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees)
were chosen with a retired probe; `npm run check:pool:v3` proves the chosen
two-in, four-out spend. `npm test` checks the successor's
[canonical compressed spent root](POOL_DEPLOYMENT_PROBES.md#spent-set-replay)
(`src/pool/v3/spent-set.ts`) against independent batch roots and hostile keys.

The [Ergo venue profile](ERGO_VENUE_PROFILE.md), selected by
[venue-ergo.md](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/venue-ergo.md),
is implemented in `src/ergo-profile.ts` (attribution, reassembly, ordinals, the
anchored index space and §13 answers by exhaustion over root-checked blocks) and
read by `ErgoVenue`, the one Ergo reader, behind the header chain it verifies
itself (`src/ergo-headers.ts`). The reader and its supplier decode nothing: they
take each transaction's unsigned bytes and frame the outputs themselves
([reader](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer),
[supplier](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)),
so no library's refusal withholds a section. The decoder probes and
containment harnesses are retired; sigma-rust (a vendored release build,
[decided 2026-09-23](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3))
only builds and signs the publication experiment's transactions and the
fixtures' trees. The profile guide maps each rule to code and tests and owns
the [runtime venue](ERGO_VENUE_PROFILE.md#runtime-venue), the
[durable view and publisher](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher)
and the costs and limits. The measurements stand in the probes guide:
[real-chain cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor),
[publication on a node](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node),
[inclusion latency](POOL_DEPLOYMENT_PROBES.md#inclusion-latency-on-the-mainnet),
[own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source) and
[reader-verified headers](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers).
Withholding a heavier chain remains a supplier's power. No mainnet publication
or physical storage qualification is claimed.

## Successor record conformance

The v3 codecs below, the spent root and the C4 capsule library live in
`src/pool/v3/` (slice 1 M1 of the
[v3 runtime plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2));
the v3 scripts, including the local replay, read them from `dist/`. The state
machine, admission journal and reader use those same codecs on reference venues,
under the adopted configuration (pool-v3 §11.4). Pool-v2's code is retired
(above).

`src/pool/v3/records.ts` implements the successor's reviewed
[canonical record layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks exact bytes, hostile parsing, delivery association and
signature-message binding. The journal admits ordinary and recovery
statements through those records; deployment acceptance remains open.
`src/pool/v3/commitments.ts` adds the reviewed history/evidence chains,
snapshot and receipt frames from [pool-v3 §7](https://github.com/mediumofexchange/money-from-first-principles/blob/4a58fdc/pool-v3.md#7-history-evidence-snapshots-and-receipts).
Its tests distinguish authenticated failing evidence from substituted bytes
using real signatures. Authentication alone supplies no checkpoint verdict.
`src/pool/v3/headers.ts` implements [v3 segment headers](https://github.com/mediumofexchange/money-from-first-principles/blob/061f87e/pool-v3.md#8-segment-headers)
with canonical scope/opening references and bounded strict decoding. Its
signed-directory and hostile-byte tests establish header conformance. The reader
checks single-backing opening evidence and recovery adoption; no certificate
format is added (M4). Reference-venue succession is
covered by the slice-4 runtime below.
`src/pool/v3/fault-evidence.ts` adds the [portable fault-evidence record](https://github.com/mediumofexchange/money-from-first-principles/blob/322bcae/pool-v3.md#9-fault-evidence-records):
exact raw target bytes and an evidence suffix, checked against an externally
authenticated snapshot with an explicit reader budget. Successful evidence
authentication is not an exclusion verdict or a complete served trail.
`src/pool/v3/trail.ts` implements [served-trail transport](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md#10-served-trail-transport)
as one frame reader for memory and streams, with per-object bounds, optional
caller budgets for a trail held in memory and raw inner-byte retention. Its local
evidence helper authenticates the header and ordered event evidence against
an expected signed-directory snapshot, including capsule association for
decodable records. It does not authenticate scoped terms, replay history or
imports, resolve record ranges/adoption or establish a complete opening.
Opaque terms still require their own decoding, name/signature and force checks.

`src/pool/v3/package.ts` implements [§12 evidence transport](https://github.com/mediumofexchange/money-from-first-principles/blob/10dcf67/pool-v3.md#12-evidence-packages-and-dependency-retention):
canonical typed exact-byte inventory with u64 item lengths ([97ff964](https://github.com/mediumofexchange/money-from-first-principles/blob/97ff964/pool-v3.md#12-evidence-packages-and-dependency-retention)),
one frame reader for memory and streams, and the existing MOED
directory-root preimage. A reader first copies the package into its own
evidence storage (`src/pool/v3/evidence-store.ts`, node:sqlite in memory or a
file) and reads only the copy: whole items under a 1 MiB per-object budget,
and trails by record, each record kept once under its evidence chain value
with the value before it, so replay reads one record at a time. A party's file
retains directories, snapshots and trails across reads, each checked by its
hash or chain step on use, so a later package carries only new objects and a
later trail is assembled from its head and the records after the reader's
checkpoint ([§14](https://github.com/mediumofexchange/money-from-first-principles/blob/8d48b25/pool-v3.md#14-replay-retention-and-resource-bounds)).
The operator journal serves that way, by parts read from its rows, and the
local service streams them ([service guide](POOL_V3_SERVICE.md)); the wallet
still reads whole packages. In a package,
the configuration, selected commitment, faults and receipt stay one read's own.
A kind the reader does not read refuses the import at its header; every item's
row counts against the party's quota; a directory that does not decode is
found by no root rather than refusing the read. The §13 answers a read asks
are kept in its replay store and extended by windows past the index they are
kept through ([decision](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
Fresh local replay uses a package with exactly one configuration and signed commitment; the
selection's snapshot is the one its directory names and its trail the one
that authenticates it, both by hash, with the directory preimages, snapshots
and trails of the other carrying checkpoints its range read classifies. Other
dependency shapes refuse without a verdict. The in-memory fixture shares the
same replay engine.

`src/record-range.ts` implements [§13 record-range answers](https://github.com/mediumofexchange/money-from-first-principles/blob/6272040/pool-v3.md#13-record-range-evidence):
the request/answer frame with kind bounds and budgets, held commitments per
C2.3.3 by ascending sequence within an index with lesser-bytes ties and
reader-established priors, replacement identities, first-entry revocations,
and C2.5's walk over admitted replacements (one identity at its first entry,
lead floor from the venue's lag, supersession, revocation and the lesser
identity at one index), first checked against the answers the retired transparent
walk gave for 135 scenarios ([8d207eb](https://github.com/mediumofexchange/reference-ts/tree/8d207eb)). The
reader orders several backings' publications by `venueOrder` in
`src/pool/v3/scope-reader.ts`.
The reader (`src/pool/v3/reader.ts`) reads them through a `RecordVenue`
(`src/record-venue.ts`): `FixtureVenue` in the harness by default and
`ErgoVenue` under `--ergo`. The local replay integrates these answers with the
bounded clock and import checks described above. Ergo authenticates venue
evidence from untrusted suppliers; the runtime recovery path below verifies force and
adoption, for every scope through `scope-reader.ts`.

The operator side runs in `src/pool/v3/` on reference venues only
([decision](../decisions/2026-09.md#2026-09-25--admit-commit-and-serve-v3-through-an-operator-journal-proving-in-the-runtime-on-reference-venues-only)):
the runtime prover (`prover.ts`, `witness.ts`), admission at the horizon in
`state.ts`, the operator journal (`store.ts`) and the reference guard
(`guard.ts`), also enforced at the reader's entry with a caller-held reference
preimage. `npm run check:pool:v3-store` exercises an issue, a payment with a
fee to the operator's own request and a burn through the journal on the local
reference venue. Add `-- --ergo` for `ErgoVenue` under the synthetic reference
identity: actual `ErgoPublisher` transactions enter a synthetic mempool, then
explicit mining and synchronization witness them. Holders spend notes restored
from the served package; a fresh seedless process verifies supply from the
package and venue records. In synthetic mode it receives block evidence and
holds the witnessed block pin separately ([report](pool-v3-store-verification.json)).
The explicit `store-check.mjs --testnet` path uses the reference testnet identity
and a fresh reader fetching its own headers/sections. The [live journal report](pool-v3-testnet-verification.json)
records successful public supply verification and hostile refusals; the header rules have a separate
[historical own-node check at 6e4cea8](https://github.com/mediumofexchange/reference-ts/blob/6e4cea8/docs/ergo-testnet-header-verification.json).
The corrected retained public bundle has a separate [standalone readback](pool-v3-testnet-reader-verification.json).
Those live observations describe slice 2 at
[`2c6b20c`](https://github.com/mediumofexchange/reference-ts/tree/2c6b20c); their
source bindings are historical after the recovery changes.

Slice 3 adds single-backing recovery admission, publication force over fixed
snapshot anchors, non-service counts and exact return/adoption to the runtime.
`package-reader.ts` verifies complete bounded ancestry through the reader walk
(then a single-backing `import-reader.ts`, now `scope-reader.ts` for every scope). The journal
refuses service at the silence horizon but discards its tail only at a proven
witnessed boundary. A return waits for its empty opening's actual index and
reads publications through that index before issuing adopted receipts.
`npm run check:pool:v3-recovery` is the real-proof acceptance command, with
`-- --ergo` selecting actual kind-4 transactions on the synthetic chain. It
includes a fresh process that has only public evidence and independent reader
inputs. The [local](pool-v3-recovery-store-verification.json) and
[synthetic Ergo](pool-v3-recovery-store-ergo-verification.json) real-proof
acceptance is retained for the current reader; WORK.md records its checked CI baseline.
The separately authorized [live testnet recovery](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json)
and retained public-bundle readback also passed. That live evidence is historical
at `a72888b`; later journal changes need their own acceptance evidence.

Each party's storage is independent of history ([decision](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)):
the journal's rows, a reader's or wallet's evidence file and its kept replay
file. `npm run check:pool:v3-history` is the real-proof acceptance past the
old ceiling of one package in memory (one megabyte, about 67 statements). The
journal admits 73 statements and serves them by stream. A payer wallet syncs
over HTTP and pays from its kept witnesses. A fresh seedless process verifies
the history from its own files. With the service down a holder forces
redemption from its kept files; the operator returns and adopts, and the
wallet proves its lapsed payment again ([report](pool-v3-history-store-verification.json)).
It runs on the local reference venue at tens of statements: the target scale
has stand-in-proof measurements only
([probes](POOL_DEPLOYMENT_PROBES.md#replay-state-storage)).
[Measurements and limits](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal)
distinguish this single-backing drill from deployment acceptance.
Complete trails remain bounded; imports do not erase ancestry or reset the
package budgets. No replacement service, wallet custody, persistence or
live deployment is supplied by this slice.

Slice 4 adds public-evidence successor activation through `store.ts` `takeover`.
The shared import walk exposes a canonical frontier without trusting a selected
predecessor, including an empty book proved by complete descent. Exact replacement
links govern authority; A→B→A imports B's state while continuing A's own signed
counter. Every successor opening waits for witnessing and exact adoption before
service. Complete relevant venue ranges bind signing stability across asynchronous
verification. The acceptance command is `npm run check:pool:v3-succession`, with
`-- --ergo` for synthetic Ergo. The [local](pool-v3-succession-store-verification.json)
and [synthetic Ergo](pool-v3-succession-store-ergo-verification.json) real-proof
drills passed.
Both runtime package readers now accept dependency-resolved single-backing compact
fault evidence. Slice 7 M1 moves multi-backing reads to `scope-reader.ts`, read
through `readPackage`; since the [one-walk decision](../decisions/2026-09.md#2026-09-29--read-every-scope-with-one-reader-walk)
it reads every scope, and `readPackage`/`readFrontier` are the only package entries. Slice 7 M2 lets the journal open several backings in one
segment and change scope with one `rescope` command (take successor terms, keep live
backings, drop the rest; an elective change waits for the witnessed tail); silence
return keeps the whole scope. `npm run check:pool:v3-scope` runs the two-backing
split/rejoin with real proofs and fresh per-backing readers on local and synthetic
Ergo venues ([local](pool-v3-scope-store-verification.json),
[synthetic Ergo](pool-v3-scope-store-ergo-verification.json)). Slice 7 M3 lets the wallet hold,
pay and re-prove one backing in any scope; the same acceptance pays a wallet request in the
rejoined scope. After configuration adoption the same drill passed live on the own testnet
node (M8b, [probes](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal)); the recovery,
succession and scope drills share `scripts/pool/v3/drill.mjs` for proving, venues and fresh readers.

Slice 5 adds the [durable venue and journal-owned publisher](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher).
Synthetic fresh-process crash checks reproduce ranges and exact publication retries;
reopen authenticates retained evidence, preserves non-held records and deep-fork
failure, and incomplete fork prefixes survive pruning. Full-history memory and
checkpoint rewrite costs remain. No live deployment,
physical power-loss or wallet custody evidence is added.

## Runtime pin and recovery models

The runtime follows specification revision
[`e7f7f246a5a57741b9ceeaaa9efef67a7b0bccad`](https://github.com/mediumofexchange/money-from-first-principles/tree/e7f7f246a5a57741b9ceeaaa9efef67a7b0bccad):
`pool-v3.md` for the construction, adopted with §11.4's configuration, with the Ergo venue profile's
`venue-ergo.md`; the v3 reports bind the revision they check
(`V3_SPECIFICATION` in `scripts/pool/v3/provenance.mjs`), which names both
documents' text for Ergo reports. The circuit sources cite rules by document
and section, not revision, so a later revision that keeps those rules leaves
their source identities unchanged. The pin includes venue-ergo §2's clock
on a heavier, shorter chain (`dce3ae1`, `298cc06`) and §8's one-transaction
condition (`01f922c`), which the v3 guard checks against `PROOF_BYTES`, and
pool-v3's adoption (`e7f7f24`), whose manifest the runtime holds.
`740adaa` (pool-recovery C3.4, C3.5 and C3.8) is in it; the wallet's disclosure
count and the C3.8 reading (`dishonour.ts`) read it. Earlier revisions
pinned the retired pool-v2 runtime. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is retired.
Later specification revisions, such as the lit profile (`29fc585`) and its draft layouts `lit-v1.md`, are not pinned by the pool runtime. `src/lit/` implements lit-v1 §§2–5, 8–9 at `fabd386` (byte layer only; [map](PRIVATE_PAYMENT_ARCHITECTURE.md#lit-construction-draft)).
`pool-recovery.md` specifies presentation, the non-service count, snapshot
redemption at the venue and the return from silence over the pool;
`model/pool-recovery.ts` is its executable model with counterexamples.

The recovery model follows the later [silence-retirement decision](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)
and specification revision [`c5f5464`](https://github.com/mediumofexchange/money-from-first-principles/commit/c5f5464).
An intervening silence gap retires old continuation and lapses unfinished
receipts even after an unrelated clock reset, preserving earlier finality and
liability. Return requires a new segment and complete recovery adoption.
The original double-spend counterexample remains under an explicit departure.
`model/pool-fault.ts` extends that model with the selected fault contract at
[`23af0f5`](https://github.com/mediumofexchange/money-from-first-principles/commit/23af0f5):
authenticated exclusion, a clock read from the snapshot, and continuation of
the last valid prefix. Rejected policies remain test-only historical controls.
The model hashes exact admitted proof/signature bytes into a separate chain,
compares receipt evidence and retains witnessed bytes through adoption. Proof
and signature verification remain ideal oracles; its framed encoding is not v3's. The
runtime implements v3's records, configuration, compact fault evidence and
authenticated Ergo ranges (above), with real verification.

The later [presentment clarification](https://github.com/mediumofexchange/money-from-first-principles/commit/923ee46)
keeps pool demands authorized by their holding proofs. A fresh presenter key
authorizes release/withdrawal; the demand does not establish that key's
participation, its publisher's identity or a person's reputation. Focused
model cases cover copied evidence, field rebinding and lock/retry behavior;
they assume cryptographic authentication; the runtime's recovery path is above.

## Successor proof layouts

The successor [proof layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md)
fix six relations and public-input orders. `npm run check:pool:v3` compiles
and proves them together, including delivery on issue/burn, four spend
outputs, canonical demand padding, refresh binding and equal-count cross-key
rejection. See the [conformance suite](../scripts/pool/v3/README.md). The
[proving parameters](https://github.com/mediumofexchange/money-from-first-principles/blob/85655a5/pool-v3.md#4-proof-and-conformance-obligations)
are Ignition's ([probe](POOL_DEPLOYMENT_PROBES.md#proving-parameters)). Every
backend instance starts through `startBackend` (`src/pool/proof-verifier.ts`),
which loads only the leading 2^15 G1 points and `[x]_2` whose hashes are
`BN254_PARAMETERS`, the manifest's parameter identities; the verifier and prover refuse any other instance, and the
suite records the hashes it loaded. Readers, the journal and the wallet refuse
a verifier that names circuits other than the configuration's six (§11.1).
Pool-v3 §11.4 adopts the configuration whose identities the suite reproduces;
the runtime holds that manifest (`src/pool/v3/configuration.ts`), takes no
configuration from a caller, and remains guarded to reference venues.
