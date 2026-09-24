# Implementation status and specification revisions

Current implementation evidence and version boundaries. For an introduction and
source setup, see the [README](../README.md). For the next development task,
see [WORK.md](../WORK.md). Update this guide when a component or its specification
pin changes; dated decisions retain the reasoning behind those changes.

**Experimental; the API and wire format can change.** Source is the supported
way to try the implementation. There is no published npm release, no
deployment, and no completed security audit.

The active implementation is the shielded pool in `src/pool/`: pinned v2
circuits and proofs, private notes, public supply replay, record-derived
authority and canonical history, receipt readers, and durable sequencing.
The [local service/client transport](POOL_SERVICE.md) exposes durable submission,
commitment and publication retry, with separate-process lost-response, fencing
and restart evidence. The [local wallet fixture](POOL_WALLET.md) retains receiver
requests, pending payments, private HTTPS inbox deliveries and verified local
fulfillment through restarts. Scoped durable capabilities and exact retry protect
inbox admission; checkpoint verification remains separate from acknowledgment.
The same flow uses pinned real v2 proofs with a separate public supply audit;
abrupt wallet-process tests cover eleven transaction boundaries. Encrypted offline
exports freeze the source and retain complete state and reservations; fresh
restores require the exact independently retained digest and record provenance.
Protected device storage and one active restore remain explicit preconditions.
Private TLS credentials and digest-authenticated invoice bindings now persist
with the wallet; rotation revokes capabilities and fences obsolete servers.
Independent digest authentication is modeled locally; a user authentication
channel and external venue remain unqualified. Receiver note checks distinguish spent/unspent at an exact
verified checkpoint; saved fulfillment lookup recovers historical records.
The [ordinary local operation](POOL_WALLET_OPERATION.md) accepts caller-selected
invoices, selects up to two verified unreserved notes, persists one payment per
authenticated alias and spends verified change in another payment. Both CLIs
share its builder. Historical status, reservations and fulfillment remain
distinct; imported-note selection and automatic consolidation remain open.
The [caller-configured local profile](POOL_LOCAL_PROFILE.md) supplies authenticated
signed terms and initial authority to holder, receiver and operator commands,
using the pinned real verifier. Holder processes have no fixture issuance keys.
Configured encrypted offline handoff freezes and restores both wallets with
independently retained profile/recovery digests; exact payment retry and receiver
credential rotation continue into another verified payment. No custody schema
or protocol bytes change; one active copy remains a precondition.
The [device custody profile](POOL_WALLET_DEVICE.md) selects Windows protected
storage and a manual current recovery record. Its read-only preflight refuses
adverse/unknown observations and never qualifies a device. Provisioned target
hardware, physical failure drills and continuous recovery remain open.
An exact segment constraint prevents another profile from fencing an existing
operator journal or signing another scope. Local ledger authentication, device
custody and continuous recovery remain deployment preconditions and open work.
Silence recovery is modeled but not implemented in the
runtime; usable wallet custody and an external witness write adapter remain open.

The frozen transparent implementation and its local pilot remain adversarial
and integration evidence. The duplicate private-payment experiment is retired;
its active case map and immutable historical report are in the architecture guide.

Use [the architecture map](PRIVATE_PAYMENT_ARCHITECTURE.md) for component
boundaries and retirement conditions, [production requirements](PRODUCTION_REQUIREMENTS.md)
for release gates, and [fault recovery](POOL_FAULT_RECOVERY.md) for the
selected rules and model limits of the companion's
[fault contract](https://github.com/mediumofexchange/money-from-first-principles/blob/23af0f5/pool-fault.md).
## Proof and deployment probes

`npm run check:pool` exercises the
pinned real circuits and multi-segment replay separately from the ordinary
test suite. With Node 24, `npm run check:pool:delivery` exercises the
[successor delivery/restoration probes](POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration):
seed-encrypted capsules, fresh-process recovery over synthetic public data,
real proof binding, and [candidate restoration from exact signed local evidence](POOL_DEPLOYMENT_PROBES.md#restoration-from-exact-local-evidence).
The latter authenticates local record bytes and refuses stale or substituted
packages against an independent fixture selection; all candidates remain
unspendable without full replay, authenticated ranges and certified paths.
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
Proof and signature checks remain separate. The conditional classifier now applies
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
Configuration adoption, a selected venue profile and runtime
imports remain open. Signed non-service terms drive single and multi-backing
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
`npm run check:pool:fees` compares the successor
[transfer shapes and ordinary fees](POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees)
with real proofs. These probes do not implement a pool wallet or v3 finality.
`npm run check:pool:spent` verifies the successor's
[canonical compressed spent-set candidate](POOL_DEPLOYMENT_PROBES.md#spent-set-replay)
against independent batch roots and hostile keys; `npm run bench:pool:spent`
compares per-insert replay cost with pinned v2. It is outside the runtime.

The [Ergo full-block probe](POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
reproduces real transaction roots and retains serializer counterexamples.
The [binary decoder corpus](POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)
recovers all 77 fixture outputs, reads every sized tree as its exact bytes
whatever its header version or body, and exposes permissive parsing, with
strict round-trip rejection controls; the experiment pins a vendored,
reproducible release build of sigma-rust `2f840d3`
([decided 2026-09-23](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3)) in place of the debug npm alpha, whose
parser a node-valid output nested 50 deep could trap; a
[contained](POOL_DEPLOYMENT_PROBES.md#contained-decoder) metered derivation
of it remains a probe tool. The reader decodes nothing: it takes each
transaction's unsigned bytes and witness id and frames the outputs itself
([decided 2026-09-24](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)),
so no library's refusal withholds a section; a transaction outside the
framer's grammar carries no record. Authenticated complete-range reads
remain unimplemented.
The [candidate Ergo venue profile](ERGO_VENUE_PROFILE.md) and
`model/pool-v3-ergo-profile.ts` fix attribution by exact tree and `R4`/`R5`
shape, run reassembly, transaction-then-output ordinals, an index space
anchored at a pinned header (index 0 is the anchor's child, so reads from
index zero are bounded by the deployment's age) and a §13 verifier by
exhaustion over root-checked blocks behind a linked header chain; the
[profile experiment](POOL_DEPLOYMENT_PROBES.md#ergo-venue-profile-candidate-and-full-block-range-verifier)
reproduces the four fixture roots and answers synthetic ranges through
Fleet and sigma-rust. The [local adapter](ERGO_VENUE_PROFILE.md#local-replay-adapter)
replays every real-proof local replay group (single-backing imports and
silence, two-backing scopes and recovery, receipts, non-service counts,
compact faults, returning segments) from exact unsigned transaction bytes
under independently selected synthetic headers with bounded ownership before
reading, reproducing the fixture verifier's results with kind-4 ordinals as
transaction positions. Fresh seedless and receiver readers retain this
provenance. The [real-chain cost](POOL_DEPLOYMENT_PROBES.md#real-chain-exhaustion-cost-from-a-real-anchor)
is measured over seven mainnet days from a real anchor against two agreeing
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
([own node](POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source)): header authentication
is shown for the retained evidence, from one run of the reference client,
while the verifier still leaves proof of work to its source and no runtime
path reads the node. No specification selects the profile; header
authentication for a reader remains open, and a record must be published
inside the framer's grammar to be read.

## Successor record conformance

`model/pool-v3-records.ts` implements the successor's reviewed
[canonical record layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks exact bytes, hostile parsing, delivery association and
signature-message binding. This codec is not exported or used for admission;
approved v3 configuration, finality and adoption remain undefined.
`model/pool-v3-commitments.ts` adds the reviewed history/evidence chains,
snapshot and receipt frames from [pool-v3 §7](https://github.com/mediumofexchange/money-from-first-principles/blob/4a58fdc/pool-v3.md#7-history-evidence-snapshots-and-receipts).
Its tests distinguish authenticated failing evidence from substituted bytes
using real signatures. Authentication alone supplies no checkpoint verdict.
`model/pool-v3-headers.ts` implements [v3 segment headers](https://github.com/mediumofexchange/money-from-first-principles/blob/061f87e/pool-v3.md#8-segment-headers)
with canonical scope/opening references and bounded strict decoding. Its
signed-directory and hostile-byte tests establish header conformance; complete
opening evidence, complete certificate formats and runtime adoption remain open.
`model/pool-v3-fault-evidence.ts` adds the [portable fault-evidence record](https://github.com/mediumofexchange/money-from-first-principles/blob/322bcae/pool-v3.md#9-fault-evidence-records):
exact raw target bytes and an evidence suffix, checked against an externally
authenticated snapshot with an explicit reader budget. Successful evidence
authentication is not an exclusion verdict or a complete served trail.
`model/pool-v3-trail.ts` implements [served-trail transport](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md#10-served-trail-transport)
with explicit byte/event budgets and raw inner-byte retention. Its local
evidence helper authenticates the header and ordered event evidence against
an expected signed-directory snapshot, including capsule association for
decodable records. It does not authenticate scoped terms, replay history or
imports, resolve record ranges/adoption or establish a complete opening.
Opaque terms still require their own decoding, name/signature and force checks.

`model/pool-v3-package.ts` implements [§12 evidence transport](https://github.com/mediumofexchange/money-from-first-principles/blob/10dcf67/pool-v3.md#12-evidence-packages-and-dependency-retention):
canonical typed exact-byte inventory, local byte/item limits before payload
hashing, and the existing MOED directory-root preimage. Fresh local replay
uses package bytes with exactly one configuration and signed commitment; the
selection's snapshot is the one its directory names and its trail the one
that authenticates it, both by hash, with the directory preimages, snapshots
and trails of the other carrying checkpoints its range read classifies. Other
dependency shapes refuse without a verdict. The in-memory fixture shares the
same replay engine.

`model/pool-v3-range.ts` implements [§13 record-range answers](https://github.com/mediumofexchange/money-from-first-principles/blob/6272040/pool-v3.md#13-record-range-evidence):
the request/answer frame with kind bounds and budgets, held commitments per
C2.3.3 by ascending sequence within an index with lesser-bytes ties and
reader-established priors, replacement identities, first-entry revocations
the cross-backing venue order for publications, and C2.5's walk over admitted
replacements (lead floor from the venue's lag, supersession, revocation and
the lesser identity at one index), checked against the runtime walk.
`scripts/pool/v3/fixture-venue.mjs` is the harness's default fixture verifier;
`experiments/ergo-range/replay-venue.mjs` is its optional candidate Ergo adapter.
The local replay integrates these answers with the bounded clock and import
checks described above. Venue-source authentication, complete shared-scope
authority, recovery and adoption remain open.

## Runtime pin and recovery models

The runtime follows specification revision
[`3676757a1c8ddc0df607352c6bddbb48f6d85a09`](https://github.com/mediumofexchange/money-from-first-principles/tree/3676757a1c8ddc0df607352c6bddbb48f6d85a09),
whose `pool-v2.md` pins the construction bit for bit and records the
implemented circuits and keys. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is frozen.
That revision's `pool-recovery.md` specifies presentation, the non-service
count, snapshot redemption at the venue and the return from silence over the
pool; `model/pool-recovery.ts` is its executable model with counterexamples.
Those objects belong to a later construction version and remain outside the
v2 runtime.

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
rejection. See the [conformance suite](../scripts/pool/v3/README.md). V3 remains
an incomplete construction: no approved configuration hash or artifact pins,
backing adoption or runtime support is defined.
