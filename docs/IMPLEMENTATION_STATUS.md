# Implementation status and specification revisions

Current implementation evidence and version boundaries. For an introduction and
source setup, see the [README](../README.md). For the next development task,
see [WORK.md](../WORK.md). Update this guide when a component or its specification
pin changes; dated decisions retain the reasoning behind those changes.

**Experimental; the API and wire format can change.** Source is the supported
way to try the implementation. There is no published npm release, no
deployment, and no completed security audit.

The pool runtime is the guarded pool-v3 candidate in `src/pool/v3/`, over the
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
Cancellation/release, multi-backing payment, continuous backup and physical
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

The frozen transparent implementation and its local pilot remain adversarial
and integration evidence. The duplicate private-payment experiment is retired;
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
The [conditional initial-segment replay](POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay)
adds real successor proof/signature checks, replayed roots/totals and local note
paths, with a fresh seedless audit process. It checks candidate configuration
and all six artifact identities plus canonical signed root terms under
[pool-v3 §11](https://github.com/mediumofexchange/money-from-first-principles/blob/916bffb/pool-v3.md#11-configuration-and-backing-evidence-before-adoption).
With [pool-v3 §13](https://github.com/mediumofexchange/money-from-first-principles/blob/6272040/pool-v3.md#13-record-range-evidence)
record-range answers from a harness-owned fixture venue, it establishes the
replacement chain, the checkpoint's record prefix, currency, its operator's
force and revocation absence against that fixture only, and classifies every
carrying checkpoint of the segment from its own trail with
[last-valid-prefix continuity](https://github.com/mediumofexchange/money-from-first-principles/blob/3ed1800/pool-v3.md#71-authentication-precedes-validity).
Under a declared silence clause it reads the no-commitment clock from those
classified checkpoints (C2b.6.1): the gap at the judging index, the segment's
silence boundary after its opening checkpoint, and the lapse of any
continuation witnessed past it (C2b.4.1). A selection with imports additionally
validates the exact single-backing predecessor
closure through replacement, reappointment and same-operator restart; it
retains imported spent state, roots, totals and original-tree wallet paths.
Two-backing histories additionally split and rejoin shared ancestry,
deduplicate events, check every scoped snapshot and canonical predecessor,
and preserve per-backing totals and original-tree paths through a later
continuation. Distinct-event nullifier/output conflicts refuse the whole replay.
Multi-backing recovery preserves each backing's inherited adoption index and
unions owed publications in global venue order. Causal event frontiers preserve
shared demand ancestry and refuse incomparable lock/settlement/spend conflicts.
Original-prefix clocks retire the whole scope when any scoped backing is silent;
scopes with mixed silence durations are invalid. The conditional fixtures cover
exact adoption, unequal obligations, seedless audit, restored issuer notes and
later payment. Non-service clauses remain independent per backing across scopes.
Silence-bearing imports read an independently answered publication range.
Demand, withdrawal and release force use the original snapshot and venue order;
return adopts the exact complete block through its opening index. Standing
demands and locks persist across imports, and lit settlement outputs restore
from the seed and public evidence. The clock retains each segment's retirement
after a fresh opening resets the gap. Same-index fresh openings import the
canonical lower same-operator sequence under
[C2b.4.1 at fb7dd07](https://github.com/mediumofexchange/money-from-first-principles/blob/fb7dd07/pool-recovery.md#6-return),
preserving the inherited adoption index and exact block still owed.
Import lapse authenticates the exact backing snapshot, header and scoped signed
terms independently of event history. Existing bounded trail containers can
carry that public evidence with records omitted. Term lapse reads the witnessed
replacement chains; silence lapse retains the original opening and canonical
clock dependencies. One carried snapshot binds the entire header even when the
directory selectively omits a sibling; complete carriage and sibling-snapshot
agreement remain finalization conditions after lapse. Live validity still needs
full committed event evidence, and selected state retains its complete selection
envelope. Compact §9 proof openings carried as §12 kind-7 items
report authenticated committed bad proofs beside import results, including
unresolved reads and lapsed shared scopes. The reader binds every scoped term to
the candidate configuration and checks the target against its independently
selected key. Individual reports establish no admission or state. Signature
observations additionally cover issuance,
withdrawal and both settlement roles. The target backing's scoped terms identify
K; the exact named demand statement preimage identifies its presenter, without
establishing demand standing or requiring its enclosing opening to authenticate.
Missing presenter evidence cannot hide an independently failed K signature.
Proof and signature checks remain separate. `fault-observer.ts` supplies the same
observations to the runtime and harness. Both single-backing public package readers
accept kind-7 evidence and apply the existing dependency-resolved exclusion gates.
Successful runtime reads return optional `faultEvidence` observations; throwing
reads return no partial state or diagnostic package. The harness separately retains
observations through refusal. Neither interface treats observations as state.
The classifier applies
[§9.1 at 183c09f](https://github.com/mediumofexchange/money-from-first-principles/blob/183c09f/pool-v3.md#91-compact-intrinsic-exclusion)
to strict proof rejection or issue-K rejection for a single-backing or shared-scope
continuation after resolving its valid opening, exact last valid state and complete
record dependencies. Only its target event trail may be replaced; selected state
and ancestor evidence remain complete. Full target evidence takes priority.
Missing predecessors still refuse, held sequences remain consumed, and repairs
extend the actual last valid prefix. Silence-bearing continuations retain complete
canonical clock dependencies and lapse priority; compact exclusion never resets
the clock. Missing publication evidence still blocks imported/returning segments.
The original path proves an empty adopted block from its valid empty opening and
absence of earlier carrying state. Shared-scope exclusion requires every sibling's
snapshot, terms, canonical predecessor and clock; its snapshots must agree on the
segment and shared history/evidence hashes. A fault opened through one sibling's
snapshot can exclude the shared checkpoint, but issue K still comes from the
statement's backing. Split/rejoin ancestry and spent state remain complete.
A returned segment's compact target must lie after the adopted block its valid
opening derived from the complete publication range (C2b.4.2); the fault cache
retains each authenticated position for that test, and the original single-segment
path keeps its empty block. Inside-block positions, opening checkpoints, other
signature roles and admission/capsule faults retain their ordinary evidence or
refuse; an inside-block record is ignored, never consumed, beside an after-block
one. The original classifier now explicitly excludes nonempty opening checkpoints
before establishing the compact path's valid-opening condition.
Local limits bound compact bytes, items and suffix
work, and verifier exceptions remain visible. Runtime adoption remains open.
Configuration adoption, runtime reading of the selected venue profile and
runtime imports remain open. Signed non-service terms drive single and multi-backing
real-proof counts against each selected backing's strictly preceding canonical
state, preserving first request indices, distinct tags and spent/lock status
across scope changes and handover. Unadopted publications and checkpoints at
judgment do not change that state; a missing clause produces no count.
Receipt reads reuse the verified checkpoint walks across single and multiple
backings: exact original/adopted event inclusion, liability precedence, repair
and the complete original scope's earliest silence/term boundary. Transitions
carrying any original backing count; held noncarrying/excluded sequences cannot
create repair holes. Earlier finality survives unavailable later dependencies;
refusals preserve already proven contradictions. There is no spendability claim.
The successor's
[transfer shapes and ordinary fees](POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees)
were chosen with a retired probe; `npm run check:pool:v3` proves the chosen
two-in, four-out spend. These probes do not implement a pool wallet or v3 finality.
`npm test` checks the successor's
[canonical compressed spent root](POOL_DEPLOYMENT_PROBES.md#spent-set-replay)
(`src/pool/v3/spent-set.ts`) against independent batch roots and hostile keys;
its per-insert replay cost against pinned v2 was measured before v2 retired.

The [Ergo full-block probe](POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
reproduces real transaction roots and retains serializer counterexamples.
The [binary decoder corpus](POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)
recovers all 77 fixture outputs, reads every sized tree as its exact bytes
whatever its header version or body, and exposes permissive parsing, with
strict round-trip rejection controls; the experiment pins a vendored,
reproducible release build of sigma-rust `2f840d3`
([decided 2026-09-23](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3)) in place of the debug npm alpha, whose
parser a node-valid output nested 50 deep could trap; it now only builds and
signs the publication experiment's transactions and the fixtures' trees. The
reader decodes nothing: it takes each transaction's unsigned bytes and
witness id and frames the outputs itself
([decided 2026-09-24](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)),
so no library's refusal withholds a section; a transaction outside the
framer's grammar carries no record. The supplier decodes nothing either: it
copies each transaction's unsigned bytes from the node's JSON and checks them
against the stated id
([decided 2026-09-24](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)),
and the decoder's containment and metering harnesses are retired.
Authenticated complete-range reads remain unimplemented.
The [Ergo venue profile](ERGO_VENUE_PROFILE.md), selected by
[venue-ergo.md](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/venue-ergo.md),
and `src/ergo-profile.ts` fix attribution by exact tree and `R4`/`R5`
shape, run reassembly, transaction-then-output ordinals, an index space
anchored at a pinned header (index 0 is the anchor's child, so reads from
index zero are bounded by the deployment's age) and §13 answers by
exhaustion over root-checked blocks, which `ErgoVenue`, the one Ergo reader,
reads behind the header chain it verifies itself; the unit tests reproduce
the four fixture roots and answer synthetic ranges (the
[profile experiment](POOL_DEPLOYMENT_PROBES.md#ergo-venue-profile-candidate-and-full-block-range-verifier)
that also read them through Fleet and sigma-rust is retired). The [local replay](ERGO_VENUE_PROFILE.md#local-replay-through-the-venue)
reads every real-proof local replay group (single-backing imports and
silence, two-backing scopes and recovery, receipts, non-service counts,
compact faults, returning segments) through `ErgoVenue` over the synthetic
reference chain, its headers verified from the reader's own anchor and its
sections by root, reproducing the fixture venue's results with kind-4
ordinals as transaction positions. Fresh seedless and receiver readers verify
the chain themselves. The retired P4 and P2 probes' results stand as measured at
1b4857a. The [real-chain cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor)
was measured over seven mainnet days from a real anchor against two agreeing
public nodes: exact sections from the nodes' text reproduce every header
root, the reader's framer reads every supplied transaction it frames with the
node's outputs, and every index has its section. The
[publication experiment](POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node)
published the profile's four-piece release and its duplicate, reordered,
partial, merged and separated cases on the public testnet at the node's
minimum values, spent every piece box and read the cases back through the
verifier from block sections, as the profile states; inclusion latency has
two correlated observations, not a distribution. The reader's own mainnet
node validated the header chain from genesis, and the fixtures and the
measured week stand on its best chain
([own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source)). The reader no longer
needs a node for that: `src/ergo-headers.ts` verifies header bytes
from any supplier from the pinned anchor (canonical parse and id, EIP-37
difficulty, Autolykos v2 work, heaviest chain) and feeds the verifier its
best chain, checked on real mainnet headers from three nodes and every
EIP-37 recalculation
([reader-verified headers](POOL_DEPLOYMENT_PROBES.md#reader-verified-headers));
it rests on the work, so withholding a heavier chain remains a supplier's
power. The [runtime venue](ERGO_VENUE_PROFILE.md#runtime-venue) reads Ergo only
under the profile: `ErgoVenue` syncs headers and sections from untrusted
node suppliers under a per-supplier header budget, answers §13 ranges for
every subject from the synced sections, stops its
clock before a missing section and fails on a reorganization past the depth;
it replaced the view over a node's box index. On the mainnet it synced 300
blocks from the own node and matched a public-node-only view. Given an
`ErgoPublisher` it publishes kind 1–3 records from its own funding key,
building and signing each transaction without an Ergo library; the own
testnet node accepted three chained publications and they read back from
their block ([publisher](ERGO_VENUE_PROFILE.md#runtime-venue)). The optional
[durable reference view and outbox](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher)
preserve reproducing evidence and exact publication retry. No mainnet publication
or physical storage qualification is claimed.

## Successor record conformance

The v3 codecs below, the spent root and the C4 capsule library live in
`src/pool/v3/` as candidate runtime code (slice 1 M1 of the
[v3 runtime plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2));
the v3 scripts, including the experimental local replay, read them from
`dist/`. The candidate state machine, admission journal and reader use those
same codecs on reference venues; nothing is adopted. V2-specific code is
frozen until the v3 wallet and service pass its ported cases.

`src/pool/v3/records.ts` implements the successor's reviewed
[canonical record layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks exact bytes, hostile parsing, delivery association and
signature-message binding. The candidate journal admits ordinary and recovery
statements through those records; configuration adoption and deployment
acceptance remain open.
`src/pool/v3/commitments.ts` adds the reviewed history/evidence chains,
snapshot and receipt frames from [pool-v3 §7](https://github.com/mediumofexchange/money-from-first-principles/blob/4a58fdc/pool-v3.md#7-history-evidence-snapshots-and-receipts).
Its tests distinguish authenticated failing evidence from substituted bytes
using real signatures. Authentication alone supplies no checkpoint verdict.
`src/pool/v3/headers.ts` implements [v3 segment headers](https://github.com/mediumofexchange/money-from-first-principles/blob/061f87e/pool-v3.md#8-segment-headers)
with canonical scope/opening references and bounded strict decoding. Its
signed-directory and hostile-byte tests establish header conformance. The reader
checks single-backing opening evidence and recovery adoption; complete certificate
formats and configuration adoption remain open. Reference-venue succession is
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
reader-established priors, replacement identities, first-entry revocations
the cross-backing venue order for publications, and C2.5's walk over admitted
replacements (lead floor from the venue's lag, supersession, revocation and
the lesser identity at one index), checked against the runtime walk.
The reader (`src/pool/v3/reader.ts`) reads them through a `RecordVenue`
(`src/record-venue.ts`): `FixtureVenue` in the harness by default and
`ErgoVenue` under `--ergo`. The local replay integrates these answers with the
bounded clock and import checks described above. Ergo authenticates venue
evidence from untrusted suppliers; the runtime recovery path below verifies single-backing force and
adoption. Complete shared-scope runtime recovery and configuration adoption
remain open.

The operator side runs in `src/pool/v3/` on reference venues only
([decision](../decisions/2026-09.md#2026-09-25--admit-commit-and-serve-v3-through-an-operator-journal-proving-in-the-runtime-on-reference-venues-only)):
the runtime prover (`prover.ts`, `witness.ts`), admission at the horizon in
`state.ts`, the operator journal (`store.ts`) and the candidate guard
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
distinguish this single-backing candidate drill from deployment acceptance.
Complete trails remain bounded; imports do not erase ancestry or reset the
package budgets. No replacement service, wallet custody, persistence,
live deployment or adopted configuration is supplied by this slice.

Slice 4 adds public-evidence successor activation through `store.ts` `takeover`.
The shared import walk exposes a canonical frontier without trusting a selected
predecessor, including an empty book proved by complete descent. Exact replacement
links govern authority; A→B→A imports B's state while continuing A's own signed
counter. Every successor opening waits for witnessing and exact adoption before
service. Complete relevant venue ranges bind signing stability across asynchronous
verification. The acceptance command is `npm run check:pool:v3-succession`, with
`-- --ergo` for synthetic Ergo. The [local](pool-v3-succession-store-verification.json)
and [synthetic Ergo](pool-v3-succession-store-ergo-verification.json) real-proof
drills passed; WORK.md tracks full CI and delivery.
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
rejoined scope. The live two-backing drill runs after configuration adoption
([decision](../decisions/2026-09.md#2026-09-28--pay-one-backing-in-any-scope-and-run-the-live-two-backing-drill-after-adoption)).

Slice 5 adds the [durable venue and journal-owned publisher](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher).
Synthetic fresh-process crash checks reproduce ranges and exact publication retries;
reopen authenticates retained evidence, preserves non-held records and deep-fork
failure, and incomplete fork prefixes survive pruning. Full-history memory and
checkpoint rewrite costs remain. No live deployment, configuration adoption,
physical power-loss or wallet custody evidence is added.

## Runtime pin and recovery models

The runtime follows specification revision
[`298b6f59edcc26e353a7b8fd00ac6385bfb33a82`](https://github.com/mediumofexchange/money-from-first-principles/tree/298b6f59edcc26e353a7b8fd00ac6385bfb33a82):
`pool-v3.md` for the construction, with the Ergo venue profile's
`venue-ergo.md`; the v3 reports bind the revision they check
(`V3_SPECIFICATION` in `scripts/pool/v3/provenance.mjs`), which names both
documents' text for Ergo reports. The circuit sources cite rules by document
and section, not revision, so a later revision that keeps those rules leaves
their source identities unchanged. Earlier revisions
pinned the retired pool-v2 runtime. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is frozen.
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
and signature verification remain ideal oracles. Production v3 records/configuration,
compact fault certificates and authenticated interval evidence remain open.

The later [presentment clarification](https://github.com/mediumofexchange/money-from-first-principles/commit/923ee46)
keeps pool demands authorized by their holding proofs. A fresh presenter key
authorizes release/withdrawal; the demand does not establish that key's
participation, its publisher's identity or a person's reputation. Focused
model cases cover copied evidence, field rebinding and lock/retry behavior;
they assume cryptographic authentication and do not implement v3 recovery.

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
`BN254_PARAMETERS`; the verifier and prover refuse any other instance, and the
suite records the hashes it loaded. Readers, the journal and the wallet refuse
a verifier that names circuits other than the configuration's six (§11.1).
V3 remains
an incomplete construction: no approved configuration hash or artifact pins,
backing adoption or deployment support is defined; the runtime candidate
remains guarded to reference venues.
