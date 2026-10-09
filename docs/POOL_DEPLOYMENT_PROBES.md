# Pool deployment probes

Measurements and acceptance evidence for the v3 deployment path, begun after the
[design-review check](../decisions/archive/2026-09-08-whole-project-design-review-check.md).
A probe retires once its decision is recorded or a runtime test covers it; its section then
shrinks to a stub with the deciding figures and a permalink to its last full text.
Nothing here changes the construction or declares a production release usable; production
rules land in the specification and adversarial model first.

## The bounded integration target

Demonstrate one signed constant-payout root, issuance, private payment with
change and a realistic fee arrangement, receiver discovery, independent
verification, interruption/exact retry, restoration on a fresh wallet, and
redemption after the original operator disappears. Start with one venue and
no reliance graph. The [fee contract](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md)
selects two inputs/four ordinary outputs. [The delivery contract](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md)
now selects receiver-prepared exact outputs and seed-encrypted capsules for a
successor; v2 cannot silently stand in for these changes.

Success requires the restored wallet to reconstruct its unspent notes from its
seed plus independently available data; a fresh verifier to check supply and
history without trusting issuer totals; and a returning operator to preserve
every finalized spend and effective recovery settlement. Tests must distinguish
invalid evidence, unavailable evidence and pending receipt liability.

The practical latency, memory and network budgets are declared in
[target scale and budgets](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets); a phone wallet is
outside the release target. [The design point](#the-design-point-m11c3) measures the runtime
against them. A one-backer deployment does not remove general independent
replacement rights from the protocol.

## Browser proof baseline

The retired v2 spend benchmark (`bench:pool:browser` at a020215: one worker, pinned `noir-recursive`
target, three samples for each of three input shapes) proved and verified nine spends in Windows
desktop Chromium 152 ([result at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-browser-verification.json)):
proving 4.28–6.29 s for same-backing and 6.79–9.30 s for mixed-backing inputs, verification 91–195 ms,
every proof 14,656 bytes, the whole run about 61.6 s. Warm caches, no whole-browser memory, synthetic
inputs and no wallet, resync or latency: a small local sample, not a budget pass. Retired with pool-v2's
spend (Git history at `a020215`). Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#browser-proof-baseline).

## Delivery and seed restoration

F3's receiver-prepared exact output requests ([pool-delivery C4.1–8](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md))
and seed-encrypted capsules are runtime code in `src/pool/v3/capsules.ts`, covered by `npm test` (the
recorded profile-1 vector, tamper and bound cases) and by the v3 conformance suite, which binds and
range-checks the aggregate delivery digest in the successor relations. The retired probes measured
89-byte capsules, 242 extra record bytes for two outputs (331 for three), +16 gates on a spend (19,050
against 19,034; subgroup 32,768 and proof 14,656 bytes unchanged) and 1,000 / 10,000 / 100,000 failed
capsule opens in 79 ms / 738 ms / 12.36 s on one desktop (Node 24.6.0, i7-5500U). Sources at
[17a9f1e](https://github.com/mediumofexchange/reference-ts/tree/17a9f1e/scripts/pool/delivery) and
[1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/scripts/pool/delivery/binding).
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration).

### Restoration from exact local evidence

`check:pool:restoration` (a020215) restored candidate notes in a fresh process from a seed, an
independently selected fixture identity and public package bytes (issue 10, pay 7 with change 3, pay 5
with receiver change 2), never from a request journal, payer secrets or operator callbacks. Results
stayed candidates: `spendable=false`, unresolved coverage, one backing and segment, empty opening.
Retired once the v3 wallet took over its cases ([retained result at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-restoration-evidence-verification.json)).
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#restoration-from-exact-local-evidence).

### Reference operator journal

`npm run check:pool:v3-store` exercises the candidate runtime's operator
journal and prover on the local reference venue. Add `-- --ergo` for the
synthetic Ergo reference chain: the journal publishes through `ErgoVenue`'s
`RecordPublisher` interface and the actual `ErgoPublisher`, with invented
funding in a synthetic mempool. Explicit mining and synchronization separate
transaction acceptance from witnessing. Raw Ergo publication supports record
kinds 1–4; this original acceptance flow uses only kinds 1–3.

The acceptance flow issues to a holder's request, pays with a fee and change,
then burns. Holders restore their input notes through the reader. A fresh
seedless process checks public supply from the served package and venue
evidence, and a fresh holder process restores the same remaining note. Under
`--ergo` the evidence contains blocks, while the reader holds its witnessed
block pin separately beside the candidate keys; wrong pins and withheld
sections refuse. Journal and reader entries recompute the reference identity
from the caller's preimage. The [retained report](pool-v3-store-verification.json)
owns the source hashes, outcomes and measurements.

These local/synthetic checks cover one genesis segment of one backing and real
proofs on reference venues. They provide no live-chain finality, adopted configuration, wallet
custody, recovery admission, imports or replacement service. The synthetic
chain's difficulty permits anyone to re-mine it, so its independent pin remains
an explicit trust input. Restart replay does not establish publisher or venue
persistence across a process restart. `npm run check:pool:v3-journal` kills a
fresh process before and after the COMMIT of an opening, an admission and a
checkpoint; the next process returns the exact reply, publishes the outbox and
signs the next sequence (synthetic venue and proof oracle, not power loss).

The recovery acceptance is `npm run check:pool:v3-recovery`, and
`npm run check:pool:v3-recovery -- --ergo` for the synthetic Ergo reference.
It covers service demand/withdrawal/settlement, a request count, silence,
holder-only force verification, return and exact adoption including a release
at the opening index. The fresh process receives no journal or asserted state;
missing directories, snapshots or ancestry refuse. The complete package must
fit the existing byte budget with receipt headroom. Work budgets also cover
checkpoints and imported ancestry; unchanged snapshots cannot evade them.
The [local](pool-v3-recovery-store-verification.json) and
[synthetic Ergo](pool-v3-recovery-store-ergo-verification.json) reports retain
the passing real-proof acceptance, package size and actual funding cost.
CI runs these checks, and the retained reports above bind the sources they passed on.
Earlier live publisher and journal reports are historical at
[`2c6b20c`](https://github.com/mediumofexchange/reference-ts/tree/2c6b20c).

The succession acceptance is `npm run check:pool:v3-succession`, with
`-- --ergo` for the synthetic reference chain. It uses distinct journals and
real proofs for A→B→A, inherited spending, imported double-spend refusal and
revoked issuance. Pending/cancelled handovers refuse; a fresh seedless process
reads only public evidence. Fully evidenced hostile checkpoints are excluded,
while missing ancestry remains unresolved. Focused tests additionally exercise
empty-book takeover, a nonempty force block, a record witnessed during
verification and authority ending during adoption. The real-proof drill's adoption block is empty;
the recovery drill above supplies real-proof force/adoption evidence.
The [local](pool-v3-succession-store-verification.json) and
[synthetic Ergo](pool-v3-succession-store-ergo-verification.json) reports own the
proof counts, package sizes, transaction bytes and source bindings.

The store checks' live testnet modes are retired ([decision](../decisions/2026-10.md#2026-10-07--retire-the-store-checks-live-testnet-modes-the-command-drill-is-the-live-evidence-simplify)):
the live command drill (`command-drill.mjs --testnet --authorized-testnet`, [M10d](../decisions/2026-10.md#2026-10-06--drill-the-moe-commands-live-on-the-testnet-and-keep-the-testnet-context-without-a-difficulty-floor-slice-10-m10d))
is the live evidence, and the recovery and scope checks keep their local and synthetic Ergo modes.
Their authorized live runs (`--testnet --authorized-testnet` through `drill.mjs` and a pre-broadcast
publication guard, sources at [`09534a8`](https://github.com/mediumofexchange/reference-ts/tree/09534a8/scripts/pool/v3)) are historical:
the 2026-09-27 [recovery acceptance at a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json)
(nine real proofs, ten transactions, 0.03434168 tERG, a 126,037-byte package, exact adoption of four recovery
records at opening index 51), the 2026-10-01 [two-backing scope drill (M8b) at 8ca96cd](https://github.com/mediumofexchange/reference-ts/blob/8ca96cd/docs/pool-v3-scope-store-testnet-verification.json)
(seven real proofs, twelve transactions, 0.01434984 tERG, equal to the synthetic run's spend) and the journal's own
[live report at 09534a8](https://github.com/mediumofexchange/reference-ts/blob/09534a8/docs/pool-v3-testnet-verification.json)
with its [reader readback at 2fd0f08](https://github.com/mediumofexchange/reference-ts/blob/2fd0f08/docs/pool-v3-testnet-reader-verification.json).
The anchor and prehistory are trust inputs; depth 2 on one controlled testnet node establishes no mainnet
finality, persistence, custody or adoption.
Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#reference-operator-journal).

### Conditional initial-segment replay

`npm run check:pool:local-replay` runs real successor issue, spend and burn
proofs through an independent reader of one empty-opening segment. The command
also runs in the Linux/Windows v3 CI job. This extends local evidence scanning
with state checks; it does not adopt a v3 configuration or reinterpret v2.
The [retained report](pool-v3-local-replay-verification.json) records source,
bytecode/key hashes, real-proof checks and the resulting public audit.
Every group is read by the runtime's `readPackage`; the harness adds only its
input shapes, the venue it selects, note scanning and the report's fields.
`frontier-check.mjs` also reads the single-backing compact-fault groups with
`readFrontier` from the root terms alone, and compares classification, fault
observations and canonical state with the selected read across successor imports,
spent predecessors and returned segments; the Ergo pass repeats these reads over
verified synthetic headers. Selection-independent unresolved/resource fixtures
require the same refusal from the frontier, including faults inside the adopted
block. These are candidate reference reads, with no adopted configuration or
live-chain claim.

The fixture issues 10, pays 7 with change 3, then burns 5 with receiver change
2. A seedless public verifier checks the 439-byte candidate configuration and
all six source/toolchain/bytecode/key identities against its independently held
manifest. It derives the candidate domain from that frame and the issuer key
from canonical signed constant-root terms under
[pool-v3 §11](https://github.com/mediumofexchange/money-from-first-principles/blob/916bffb/pool-v3.md#11-configuration-and-backing-evidence-before-adoption).
It checks every proof under the kind's own key and the issuer's statement signature,
derives the header's scope root, and replays accepted anchors, spent nullifiers,
new outputs and bounded totals. It reconstructs the local note tree, compressed
spent root, per-event history chain and terminal snapshot. A separate fresh
receiver process reconstructs its unspent change and a local membership path
from its seed and those public bytes. No witness or original wallet journal
enters either process. The public outstanding amount is 10 minus 5 = 5.

Fresh readers receive the 47,665-byte canonical [§12 evidence package](https://github.com/mediumofexchange/money-from-first-principles/blob/10dcf67/pool-v3.md#12-evidence-packages-and-dependency-retention):
exact configuration, commitment, the complete directory preimage of every
held commitment in range, snapshot and trail bytes, ordered by kind and
payload hash. Local limits are 1 MiB and 1,024 items, checked with all field
boundaries before hashing payloads. The bounded reader requires exactly one
configuration and commitment, resolves the selection's directory by root, its
snapshot by the digest that directory names and its trail by evidence
authentication, refuses two trails that authenticate one snapshot as
ambiguous, and uses the same replay engine as the in-memory fixture. Every
other directory, snapshot and trail is a dependency for the range read: the
110,054-byte dependency package carries two checkpoints of the segment (three
and four records) with three directory preimages.
Missing objects, duplicate/conflicting objects, unsupported dependencies,
false range-completeness assertions and replica substitutions yield no partial
audit or candidates. Package bytes, selection and seed are owned before
asynchronous verification; shared input refuses. Decoding checks budgets
before ownership copying, and fixed-width selection/seed views are copied
without their unused backing allocations. Generic transport can retain all
eleven specified evidence kinds, including opaque malformed inner bytes,
without interpreting them as valid.

The reader's record reads follow [pool-v3 §13](https://github.com/mediumofexchange/money-from-first-principles/blob/6272040/pool-v3.md#13-record-range-evidence).
Its venue-evidence verifier is a harness-owned fixture venue record beside the
selection and candidate manifest: it answers the reader's own requests for the
operator's commitments, the backing's replacements and K's revocations from
index zero through the judging index, or returns no answer; its lag is the
venue's constant. From those answers the reader walks the replacement chain
(C2.5.3–5 under the terms' rule key: lead floor from the lag, supersession
before the standing candidate's force, revocation by naming the incumbent,
the lesser identity at one index; a link past the judging index is pending),
derives each party in force's held commitments (C2.3.3 by ascending sequence
within an index) for its term, requires the selected checkpoint to be held
inside the original operator's term (a selection at or after the term's end
is `lapsed-selection`), passes every non-carrying commitment by its packaged
directory, and classifies every carrying checkpoint of the original operator
in held order from its own snapshot and trail (C2.10.11): a deterministic
replay failure excludes it and it is passed; a valid one must reach the last
valid checkpoint's length and reproduce its history and evidence hashes there
(C2.10.12, pool-v3 §7.1), the evidence before its proofs; a valid later one
makes the selection `superseded-selection` (C2.7.5). An earlier carrying
checkpoint of another segment contradicts the header's empty opening; a
later one, a successor's carrying commitment and a carrying checkpoint naming
other backings are unsupported. Under a declared silence clause the same
walk reads the no-commitment clock (C2b.6.1): `c(i)` is the last valid
carrying checkpoint strictly before `i`, the gap is open where `i − c(i)`
exceeds the duration, the segment's silence boundary is the first open
index strictly after its opening checkpoint, which carries the backing and
is exempt from lapse, and a later checkpoint of this segment witnessed
while the gap is open or after the boundary is `lapsed`: held, its snapshot
resolved to establish the segment, its trail neither resolved nor replayed,
closing nothing; selected, the read refuses `lapsed-selection` with the
clock record proving the lapse (C2b.4.1). The empty-opening contradiction
and the segment identity are settled before the clock, so a lower-sequence
checkpoint still refuses `OPENING` and another segment's checkpoint stays
unsupported. The audit's `clock` reports the duration, the snapshot index,
the gap, whether it is open, the boundary and the opening index; a held
opening whose directory carries nothing for the backing is a proven
contradiction (`OPENING`), an opening the record does not hold is
unresolved, and without record ranges a clause is unsupported. Issuance
witnessed at or after K's revocation is void, and a position the last valid
checkpoint finalized was witnessed at that checkpoint's index, not the
child's (C2b.1). A trail that does not decode is no evidence and does not
block the read; two trails that both authenticate one snapshot are refused
as ambiguous. The audit records the verifier's lag, the chain and each
carrying checkpoint's class beside the held counts of the classified term.
A current read requires the judging index to be the verifier's clock. Junk at
the operator's location, a stale lower sequence and a repeated sequence are
disregarded without becoming holes; a same-sequence twin with the lesser
record bytes stands for the sequence, so the selection is then not held. An
answer for another venue or request, an unwitnessed judging index, a silent
or absent verifier and a missing directory all leave the read unresolved; a
flood beyond the reader's entry budget is a resource refusal; an answer
supplied inside the package is an unsupported kind, never evidence. Without a fixture venue the reader runs as before and claims
no range. The fixture record is a trust input, not a venue; `ErgoVenue` answers the
same requests from authenticated chain evidence on the synthetic and testnet reference chains (below).

Valid proofs against an unaccepted anchor, a spent input, a duplicate output,
a different scope and overflowing aggregate issuance isolate the host checks.
Authenticated bad proof/signature bytes and false snapshot assertions fail
local replay. Replica substitutions remain unresolved evidence. No failure
returns partial totals or candidate notes. Exact repeated reads agree; repeating
a statement inside the served history refuses. Historical candidates remain
historical, and no-match scanning makes no complete-zero-balance claim.
Inputs are copied before asynchronous proof verification. Shared-memory
buffers refuse: cloning alone would leave terms, configuration and seed mutable
while a proof check is awaiting. The earlier loose-key regression is preserved
by checking shared storage before any verifier call. Loose issuer overrides
now refuse. Changed sources, all six bytecodes and retained keys, including
unused recovery keys, fail independent pins. Changed terms signatures, names,
domains, venues and original-operator/genesis-link assumptions refuse as well.

For a selection with a nonempty opening, the same
proof/state replay also serves a bounded single-backing import walk
(C2.10.3–7). It classifies each operator term in record order, matching the
header's link rather than just the key. Every new segment must name the
exact last valid predecessor; missing evidence blocks, and an excluded tail
supplies no state. The imported closure retains totals, spent nullifiers,
all output commitments and accepted roots. Local trees and chains start
fresh; later checkpoints replay from the same fixed imported base. Candidate
paths for imported outputs use their original trees and are labeled
`replayed-imported-tree-only`. The walk supports reappointment and
same-operator restart, including lower-sequence same-operator imports at the
same index, with the recovery obligations below where a silence clause is declared.
It caps total work at 128 held checkpoints and 8192 event operations,
counting repeated checkpoint prefixes, publication classification, recovery
folds and failed replays. The original-segment clock path retains the limits
above.

Multi-backing histories use a cached whole-checkpoint classifier under
C2.10.3–7. Every scoped backing contributes signed terms, a record-derived
canonical predecessor and an authenticated snapshot; every check must pass
before any audit or wallet candidate is returned. Shared events are identified
by segment and position and counted once. Distinct events cannot share a
nullifier or output. Per-backing supply totals remain separate, while accepted
roots and spent state cover the merged closure. Wallet paths retain their
original segment trees; a selected backing filters other recovered notes.
The real-proof fixture splits a shared two-backing prefix, continues each
branch, rejoins them, spends against distinct imported anchors and burns in a
later continuation. Fresh public and wallet processes replay the same package.
Per-object byte, item, record and range bounds apply; the checkpoint and event
totals that once bounded this work were removed in M5b.3b. Multi-scope range
audit counts describe classified dependencies, not all non-carrying commitments.
Recovery scopes retain each backing's own adoption index and original-prefix
clock. Returning scopes adopt the owed publication union in global venue order,
including publications at the opening index and obligations inherited through
same-index fresh openings. Shared demand ancestry is applied once; incomparable
lock, settlement, withdrawal or spend conflicts refuse regardless of parent
order. A two-backing fixture restores both settlement notes and continues with
a payment; unequal obligations prove that neither a scalar minimum nor maximum
can substitute for the per-backing indices. Non-service clauses remain
independent per backing throughout this shared ancestry.

With a silence clause, the same walk reads one backing clock across every
term, freezes its reset index across checkpoints at the same witnessed index,
and records each segment's first gap strictly after its opening before any
later opening resets the clock. A retired segment's continuation lapses even
after that reset. A fresh opening can return during a gap; its same-index
continuation cannot close the gap for itself. Exact finalized imports retain
payments, burns, spentness and original-tree restoration paths.

This path requires the independently selected verifier to answer kind 4 for
the backing over `[0, judgingIndex]`. Demand, withdrawal and release force is
read at each publication's original index, in venue order, against the
strictly preceding snapshot and intervening force (C2b.3.2). Recovery effects
never extend that snapshot's forest. Malformed or invalid publications have
no force; missing evidence remains unresolved. Acceptance and request have
no recovery force; the non-service count is a separate canonical-state read.

Each return opening remains empty and inherits its predecessor's adoption
index. Every non-opening checkpoint starts with the full adopted block through
the opening index inclusively, retaining exact proof and signature bytes at
new local positions (C2b.4.2). Effective statement identities persist after
withdrawal, preventing a proof variant from recreating a discharged demand.
Standing demands survive deadline expiry; locks expire individually. Ordinary
replay checks locks without reapplying door timing conditions. Adopted
settlement outputs support seed restoration from authenticated public fields.
Same-index fresh openings use C2.10.4–5's child-relative canonical predecessor
under [C2b.4.1 at fb7dd07](https://github.com/mediumofexchange/money-from-first-principles/blob/fb7dd07/pool-recovery.md#6-return).
The snapshot for gap and publication force stays strictly before the index.
Repeated empty openings inherit the adoption index and the exact block still
owed; a later opening cannot omit a valid lower same-operator sequence.
Full trails are still required to classify
import lapse; header-only lapse is an availability improvement. These limits
add no consensus rule, wire format or configuration-adoption claim.

A single kind-10 receipt in the evidence package selects a seedless receipt
read over the same verified checkpoint walks. Its signature binds the complete
original scope's header authority. The reader authenticates a held `after` even
past the boundary, without inferring signing time. Valid events compare
position, statement, history, proof and authorization hashes; an adopted
receipt names the adopting segment but retains source evidence hashes.
Inclusion is final immediately. Otherwise earlier contradiction and elective
abandonment precede repair, moved-past, silence or term lapse, then pending.
Excluded and noncarrying checkpoints occupy sequences without creating repair
holes. A transition carrying any original backing counts, including one that
drops the selected backing. The earliest silence/term boundary across the
original scope is exclusive for inclusion and contradiction. Clocks advance
only through the next candidate or term end; pre-gap inclusion requires no
publication range.
Later unavailable evidence cannot erase a returned final inclusion; refusals
preserve already proven contradictions as `receiptEvidence`. These conditional
receipt judgments use the fixture venue and expose no audit state, recovered
candidates or spending authority. One query adds only the existing 355-byte
receipt plus package framing and adds no budget of its own.

Signed non-service terms enable C2b.5.2 in `audit.range.nonService`, with
duration, threshold, window, count, firing status, incumbent and snapshot
index. It uses the last valid carrying checkpoint strictly before judgment,
passing excluded and lapsed checkpoints and retaining imported roots, spent
tags and locks across complete-scope split/rejoin and recovery. The count names
only the independently selected backing and uses its own duration, threshold
and window; sibling clauses need not agree. Unadopted recovery publications
and checkpoints at the judging index cannot clear its requests. With no
selected clause there is no count or additional request-range dependency.
Request publications are read from index zero, strictly before
judgment: the first statement identity fixes its window even if that copy's
proof fails; any later valid proof variant in the prefix can establish it.
Both window endpoints are inclusive. Refresh creates another identity, but
each unspent and unlocked tag counts once. Handover changes the incumbent
without resetting requests. Recovery publications do not serve a request
until the canonical checkpoint adopts their effects. The existing kind-7 key
in the checked configuration verifies requests; no new signed object, frame
or authority is introduced. Non-service terms need no silence clause; missing
terms mean no count, and missing range/ancestry evidence means no audit.
The count adds no budget of its own and retains the same conditional
fixture boundary as the other audit fields.

The complete public-package boundary still requires the following inputs and
checks. This table separates what this experiment establishes from prerequisites
that a production reader must establish before returning spendable holdings.

| Boundary | Experiment evidence | Still required |
|---|---|---|
| Construction and key routing | Exact configuration preimage and candidate domain; all six independently pinned source/toolchain/bytecode/key identities and fixed helper/bounds/profile | Approved configuration/artifact identities after full adoption prerequisites; setup provenance and deployment qualification |
| Backing and scope authority | Canonical signed constant-root terms/name, configuration/venue matching and per-backing issuance keys; header-derived scope root; fixture replacement/reappointment links and revocation checked across each complete scope | Authenticated evidence behind the fixture answers on a live chain: `ErgoVenue` supplies it on the synthetic and testnet reference chains; mainnet stays disabled |
| Local state | Issue/spend/burn across deduplicated shared ancestry and every scoped snapshot, with per-backing totals, shared spent state and original-tree paths; single-backing demand/withdraw/settle and locks | Qualified deployment of the runtime reader; the multi-backing recovery cases above pass locally |
| Witness and continuity | Exact fixture-selected signed checkpoint held in §13 answers; whole-scope classification, last-valid continuity and split/rejoin imports; multi-backing publication force and exact ordered adoption; complete-scope receipts and independent backing non-service counts | Authenticated mainnet chain evidence; the selected Ergo profile is read by `ErgoVenue` on the reference chains |
| Wallet restoration | Seed-only capsule and lit-settlement openings with local or imported-tree paths; independent seedless public audit | Full current state and certified anchors, independent retention and venue/backing discovery; pending invoices still need backup |

The candidate manifest, checkpoint selection and the fixture venue evidence
remain explicit **test fixture assumptions**. Signed terms establish identity,
and configuration checks bind the candidate keys; neither establishes adoption
or the force of those terms. `candidateConfigurationChecked` and
`signedTermsAuthenticated` report only those narrower successful checks.
`currentRangeAuthenticated` and `termsAuthorityAuthenticated` are true only
under the selected verifier: `rangeEvidence: "fixture-verifier"` names the
harness's fixture venue, while `"ergo-venue-synthetic-chain"` names
`ErgoVenue` over the synthetic reference chain, its headers verified from the
reader's own anchor and its sections by root. Neither authenticates the
mainnet; a historical read leaves currency false.
`npm run check:pool:ergo-replay` reads the same import/payment/burn trace
[through ErgoVenue](ERGO_VENUE_PROFILE.md#local-replay-through-the-venue),
including fresh readers and hostile evidence.
`fullV3Replay`, completeness and spendability remain false; coverage remains
unresolved. A local path is not a certified anchor. The required full-package
checks derive from pool-delivery C4.6, pool-v3 §§1/7/10/11/13 and the
authority/fault contracts. Section 11 adds configuration/terms framing for
conformance, with the existing signature rule. Section 12 adds source-neutral
transport; Section 13 fixes the record-range answer and the reader's
held/chain/revocation/publication rules, with no venue wire profile or
authority. No package-level completeness flag is accepted, and V8 remains
only the local fixture IPC for the independent selection, seed and fixture
venue record alongside the canonical package bytes.

## Transfer shape and ordinary fees

The F4 probe generated candidate spends from the pinned v2 spend and chose two inputs and four outputs
under [pool-fees C1.2.3–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md):
a payment and a fee in a second backing fit one statement with both changes, and a third position fits only
same-backing payment, change and fee. Measured gates (subgroup 32,768 for each):

| Spend candidate | Gates | Public inputs |
|---|---:|---:|
| Pinned v2, 2x2 | 19,034 | 11 |
| F3 delivery, 2x2 | 19,050 | 13 |
| F4 comparison, 2x3 | 19,256 | 14 |
| Selected F4, 2x4 | 19,465 | 15 |

The fourth position costs 209 gates over three (about 1.1%), a 32-byte commitment, an 89-byte capsule, one
leaf and one recovery trial on every spend, and 121 extra statement bytes, against another roughly 15 KB
proof-bearing preparation record when needed. All five real proofs are 14,656 bytes; the selected flow proved
in 4.22 s and verified in 92 ms on one single-threaded Node 24 desktop (individual feasibility measurements,
not a budget). Retired on 2026-09-25 with the v3 conformance suite proving the chosen spend, fee output
included; `npm run check:pool:v3` covers it now. The [recorded evidence at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-fees-verification.json)
is historical. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees).

## Spent-set replay

A22's canonical compressed spent root ([pool-spent.md](https://github.com/mediumofexchange/money-from-first-principles/blob/78f8a8c/pool-spent.md);
`src/pool/v3/spent-set.ts`, `test/pool-v3-spent-set.test.ts`) was compared with pinned v2's sparse root
before v2 retired ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-spent-verification.json),
harness at [c955798](https://github.com/mediumofexchange/reference-ts/tree/c955798)). With the root read
after every insert, 100,000 keys took 157.29 s for v2 and 15.80 s for the candidate (9.96×), with
1,649,737 candidate hashes (16.50 per insert); reverse replay took 10.14 s. An insertion costs at most one
leaf and 256 branch hashes even for hostile keys, and the tree stores N leaves and N−1 branches. This
closed the A22 shape decision; the unit tests cover the ten check groups. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#spent-set-replay).

## Replay and retention cost

Recovery map A13 asks what the redemption reader's full replay (C2b.3.3) and
the operator's exact-byte retention cost. The probe
[`replay-cost.mjs`](https://github.com/mediumofexchange/reference-ts/blob/0969845/scripts/pool/v3/replay-cost.mjs),
retired once A13 was recorded and the [replay-state probe](#replay-state-storage)
measured the stored runtime, replayed synthetic single-backing
segments (one issue, then spends with fresh nullifiers and four outputs) through
the conditional local replay, with a checkpoint every K events and the last one
selected. A counting stub stood in for proof verification; the
[conformance report](pool-v3-conformance-verification.json) supplies real
single-thread verification times. The
[recorded report](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/pool-replay-cost-verification.json) binds LF-normalized source
hashes, environment and every case; it is historical, recorded at
[6c6a80a](https://github.com/mediumofexchange/reference-ts/tree/6c6a80a), and its bound sources have since moved.

The first run found the local replay classifying each carrying checkpoint by
replaying its whole trail from position 1: 60 events with a checkpoint every
10 verified 210 proofs (17.3 s with the stub), and 1,024 events every 64 would
verify 8,704. Pool-v3 §7.1 already makes this unnecessary. A trail that
reproduces the last valid checkpoint's evidence hash at its length carries that
checkpoint's exact statement, proof and authorization bytes. The replay now
resumes in the stored namespace whose tip is that checkpoint when its replay
identity is the same: domain, backing, segment, issuers, imports, adopted block,
opening index, verifier and revocation indices. Otherwise it replays in full, so verdicts
and the first failing check are unchanged. Each trail's evidence chain is
computed once per read, and the full §10.1 check runs only on trails whose
terminal hash matches. Every case now verifies exactly one proof per event.

| Events, checkpoint every | Replay per event (stub verifier) | Same, selected trail only | Package trail bytes | Unique record bytes |
|---|---:|---:|---:|---:|
| 60 / 60, 14,656-byte proofs | 43.7 ms | 44.1 ms | 934,727 | 933,389 |
| 60 / 10, 14,656-byte proofs | 37.3 ms | 36.2 ms | 3,270,717 | 933,389 |
| 1,024 / 1,024, 32-byte stand-ins | 43.3 ms | 72.4 ms | 965,375 | 960,181 |
| 1,024 / 64, 32-byte stand-ins | 46.8 ms | 47.2 ms | 8,203,205 | 960,181 |

Recorded 2026-09-24 at the review merge. The 2026-09-23 run on the same
desktop, then also running two nodes and a chain driver, measured 66–91 ms per
event; host load moves these timings by up to 2×, so budgets need a quiet or
declared host.

Host replay is dominated by the note tree. A four-output append costs about
26 ms, about 34 Poseidon2 hashes at about 0.85 ms each in the JavaScript
implementation. Barretenberg's wasm computes the same permutation in 0.065 ms
against 0.43 ms, a lever [slice 15](#the-design-points-two-edges-slice-15) took. The spent set costs 0.16 ms per two
nullifiers, and a state copy 0.34 ms per 1,000 leaves. By extrapolation, one
core replays 10⁵ spends in about 2.3 h of verification (75–129 ms per proof in
this run's conformance report) plus 0.7 h of note-tree hashing. The proofs are
independent, so verification parallelizes. Records are 15,231 bytes for an
issue and 15,562 for a spend at the observed 14,656-byte proof. The operator
therefore retains about 1.56 GB per 10⁵ statements.

Packages that carry each carrying checkpoint's full trail grow as the sum of
prefix lengths, about N²/2K records, which is 8.5× unique records at 1,024
events every 64. [Pool-v3 §12.1 at 786f962](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#121-a-package-is-not-a-complete-certificate)
now resolves a checkpoint's served trail from the prefix of any supplied trail
of its segment whose decodable records reproduce its evidence hash
([decision](../decisions/2026-09.md#2026-09-23--resolve-a-served-trail-from-the-prefix-of-a-longer-supplied-trail)).
The measurement replays every case again from the selected trail alone. That
package carries the unique records once, gives the identical result and still
verifies each proof once. The local budgets remain far below such closures:
trails of 1 MiB and 1,024 events hold about 64 real-size events. The import
walk then charged each replayed position once, so a resumed checkpoint cost
only its new positions (M5b.3b removed that budget; the harness now checks that
each proof is verified once). Limits: one
synthetic shape with empty-root anchors and no imports, scopes, demands or
publications; stub verification; one desktop, one run per case; no device
budget.

## Replay-state storage

Slice 8 M5b asks where replay state lives so that memory is independent of
history (pool-v3 §14; [decision](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
The probe was `node --expose-gc scripts/pool/v3/replay-store-probe.mjs`, retired after M5b.6
([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/6c7d8f2/scripts/pool/v3/replay-store-probe.mjs));
the subsections below name its modes. On the replay-cost shape (an issue, then spends of two fresh nullifiers
into four outputs, 932-byte stand-in records) the in-memory state machine grew 8.3 KB of heap per spend-sized
statement, plus the record bytes twice at real proof size (38 KB in all). The stored layout (append-only fact
rows read as of a position, the note tree's frontier only, spent-set nodes behind a write-back cache, a
savepoint per checkpoint, keep points that hash the state file, records in a separate evidence file; a SHA-256
stand-in for the 26 ms Poseidon2 node hash) held heap flat near 44 MB and process memory near 520 MB over 10⁵
events at 1.3 KB of state per event and 1.9 ms mean storage work. Hashing the 126 MB state file at a keep point
took 0.4–0.6 s; reopening and re-digesting it took 0.54 s. At 10⁶ events storage work (about 4 ms an event) added about 66 minutes
against about 7 h of Poseidon2 note hashing, the state file was 1.27 GB (6.7 s to hash, 4.6 s to reopen and re-digest), and process memory rose
from 589 to 695 MB (about 0.1 KB per event after the caches filled). Records add 1.0 KB per event to the
evidence file at stand-in sizes, about 15.6 KB at the conformance proof size. Roots, totals and chain
recomputed from kept state matched the runtime `NoteTree` and `RadixSpentSet` across rolled-back savepoints.
Storage evidence from one shared Windows desktop, not replay-time evidence. Retired once the runtime
took the layout over; the subsections below measure that runtime. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#replay-state-storage).

### The runtime reader streaming one long segment (M5b.3a)

`replay-store-probe.mjs read <N>` measured the runtime reader streaming one segment
([M5b.3a](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)):
an issue, then spends of two nullifiers into four outputs, as one package of an empty opening checkpoint
and one checkpoint of all N records (the "M5b.3a shape" later sections reuse). At 10⁵ statements and
938-byte records (`4b159c2`, stub verifier, Windows desktop) the 89.8 MiB package copied in 40 s at 8.3 MB
heap and replayed at 37.1 ms per record, heap 8.6 → 8.7 MB and process memory flat near 262 MB (peak
266 MB). Superseded by M5b.3b, which removes the per-record event bytes and measures against checkpoints.
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#the-runtime-reader-streaming-one-long-segment-m5b3a).

### The runtime reader over many checkpoints (M5b.3b)

`replay-store-probe.mjs read <N> --every 1 [--silence]` measured the runtime reader with a checkpoint after
every record, classifying each in rank order ([M5b.3b](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
The earlier descent held every verdict and its heap rose about 16 KB per checkpoint (15.5 MB over 1,001), so
10⁵ checkpoints would pass 1 GiB. The forward walk held heap flat over 10,001 checkpoints (16.0 → 16.2 MB,
process memory 274 → 275 MB, 93 ms replay per checkpoint) and over 5,001 with a silence clause (13.0 → 13.4 MB).
About 4 ms of each held commitment's signature check (C2.3.3) precedes the first proof. Stand-in proofs, one
backing, shared host. Covered now by the runtime's kept-state tests and the later subsections. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#the-runtime-reader-over-many-checkpoints-m5b3b).

### Kept state and incremental retrieval (M5b.4b)

`replay-store-probe.mjs read <N> --every <K> --kept <M>` measured a reader that keeps its replay file under
its digest and fetches only the trail's head and the M records after its checkpoint
([M5b.4b](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
At N = 10⁵ and M = 1,000 the first read took 39.3 ms per record (heap 10.2 → 10.5 MB, peak 274 MB; state file
212 MiB, evidence 124 MiB); reopening the kept file took 0.68 s, the fetch was 0.9 MiB and the second read took
43.1 s, 43 ms per new record: its cost followed the new records, not the 10⁵ before them. Stand-in proofs, one
backing; the run predates the review fixes (32 bytes per record, one record hash per checkpoint read) and did
not re-measure them. Covered now by the kept-state tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#kept-state-and-incremental-retrieval-m5b4b).

### The operator journal on rows (M5b.5a)

`replay-store-probe.mjs journal <N> --every <K> [--audit]` measured the operator journal on rows
([M5b.5a](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)):
at 10⁴ stand-in admissions, heap stayed 10.0 → 10.4 MB, an admission took 59–87 ms (about two thirds of it the
note tree's Poseidon2 hashing), the database held 5.2 KB per 938-byte statement, and reopening took 0.14 s with
no proof verified. The rise per checkpoint (about 5 ms, the view verifying every held commitment twice per
command) is what M5b.5b.1 removed. Stand-in proofs, one backing and segment, no silence clause. Covered now by
the journal's kept-row tests and crash drills. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#the-operator-journal-on-rows-m5b5a).

### The journal's venue view by kept windows (M5b.5b.1)

`replay-store-probe.mjs journal <N> --every 1` measured the journal's view of the venue with a checkpoint
after every admission, so its own key held N + 1 commitments
([M5b.5b.1](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
With whole answers a cycle (admission, commitment, publication) rose about 20 ms per held checkpoint (228 ms
over the first 15, 4,871 ms at 240) and one answer's entry budget refused every command past 4,096
checkpoints. With kept windows, 5,001 checkpoints ran at 76–87 ms per admission with its commitment and
publication, flat, and the reopening verified no proof or commitment (0.11 s). Stand-in proofs, one backing
and segment, a fixture venue in the same process; a journal under a silence clause still judged every held
checkpoint at each admission then (M11b4). Covered now by the journal's kept-window tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#the-journals-venue-view-by-kept-windows-m5b5b1).

### Serving by stream and incrementally (M5b.5b.2)

`replay-store-probe.mjs journal <N> --every <K> --serve --more <M>` measured the journal serving its history
over its HTTP service into a reader's evidence file and then serving only what is new
([M5b.5b.2](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
At 10⁴ statements of real proof size (14.9 KB each) the first sync moved 142.3 MiB in 14.0 s while the heap
stayed at 12.0–13.2 MB; a second sync after 100 new records fetched their bytes plus 1,723 (1,494,323 bytes in
0.27 s), and a sync with nothing new 809 bytes. Loopback, one backing and segment; the reader kept the
evidence without replaying it. Since M11b3 a trail is read forward by position and only a fork walks its kept
links. Covered now by the service tests and the separate-process service check. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#serving-by-stream-and-incrementally-m5b5b2).

### The wallet on its kept files (M5b.5c.1)

`replay-store-probe.mjs journal <N> --every <K> --wallet --more <M>` measured a `V3Wallet` syncing its evidence
file from the journal's service and reading the backing into its kept replay file, scanning every output with
its seed ([M5b.5c.1](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
At 10⁴ statements of 15.6 KB the heap stayed at 13.2–13.6 MB through a first read of 44 ms per statement (4 × 10⁴
outputs scanned, 227 → 324 MB of process memory in SQLite's page caches); 100 new records cost 0.4 s to sync
and 5.7 s to read, and a restart with nothing new 0.06 s and 0.75 s with no proof checked and no venue request.
Stand-in proofs, one backing and segment, a wallet owning none of the outputs; a wallet's cost per record no
longer grows with the notes it holds ([M11b](#a-wallets-witnesses-kept-at-completion-m11b)). Covered now by the
wallet's kept-file tests and the history check below. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#the-wallet-on-its-kept-files-m5b5c1).

### Real proofs past the old package (M5b.5c.2)

`npm run check:pool:v3-history` (`scripts/pool/v3/history-store-check.mjs`)
closes M5b.5's acceptance with real proofs on the local reference venue
([M5b.5c.2](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
One package in a reader's memory held one megabyte, about 67 statements. Here
the journal admits 73: an issue to a holder, 36 to a payer wallet, and 36
payments the wallet proves from its kept witnesses, in rounds of twelve per
checkpoint. The operator then falls silent with a 74th statement admitted and
uncommitted. With the service down, a holder reads its own kept files, proves
two demands and a settlement from its kept witness (the history's first
output) and publishes them. The operator returns and adopts that block
exactly; the wallet proves its lapsed payment again in the returned segment
and pays once more. A fresh seedless process, holding only its own evidence
and replay files, reads at each stage.

The [retained report](pool-v3-history-store-verification.json) owns the proof counts and timings, the bytes
each party fetched, the process peaks and the source bindings. Every payment's membership path is the
wallet's kept witness, in the genesis segment and, after the return, under the returned segment's imports; a
wrong path fails its proof. The limits are tens of statements, one backing and the local reference venue: the
target scale has the stand-in-proof measurements of the sections above only, and a reader process's peak is one
verifier backend's (the whole process with its verification workers is M5b.6's).

### Verification ahead and the first sync (M5b.6)

M5b.6 asks whether proof verification beside the replay brings a reader's
first sync within 24 h at the design point, with the whole process in
1 GiB ([decision](../decisions/2026-10.md#2026-10-01--verify-a-trails-proofs-ahead-of-its-replay-on-a-pool-of-verifier-instances)).
The host is one Windows desktop with 2 physical cores (4 threads), below the
reader's declared 8, and Node 24.6.

*The cheapest probe first* (a scratch script, eight real issue proofs):

| Measure | Result |
|---|---:|
| One verification, sequential | 30.5 ms |
| Throughput over 2, 3, 4 instances | 17.3, 14.7, 13.6 ms a proof |
| Process memory with the caller's instance, then with 1 to 4 verifier instances | 114 MB, then 237, 359, 314, 378 MB |
| One verification while 34 JavaScript node hashes run beside it (49 ms alone) | 62.8 ms for both, against 88 ms in turn |
| A note-tree node hash, JavaScript against Barretenberg's synchronous WASM | 1.14 ms against 0.12 ms, equal outputs |

The recorded CI verification is 18 ms a proof
([conformance](pool-v3-conformance-verification.json)), and the
[history check's](#real-proofs-past-the-old-package-m5b5c2) fresh read took
41 ms a statement there. The replay, not verification, is the larger cost
on both hosts.

*The runtime reader with real verification load.*
`replay-store-probe.mjs read <N> --real <directory> [--instances <k>] [--in-turn]`
([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/6c7d8f2/scripts/pool/v3/replay-store-probe.mjs))
reads the M5b.3a shape with real-size records (14,656-byte stand-in proofs,
15,562-byte records). At each proof check it verifies a real proof on the
runtime verifier, cycling through the eight. The records' own proofs are
stand-ins, so this is real verification load and memory, not their
verdicts. Runs of 2026-10-01 at 2,000 statements, a checkpoint every 200:

| Verification | Replay per statement | Peak process memory |
|---|---:|---:|
| Stub | 40.2 ms | 166 MB |
| Real, one instance, in turn | 80.5 ms | 396 MB |
| Real, one instance, ahead | 51.5 ms | 406 MB |
| Real, three instances, ahead | 52.9 ms | 579 MB |

On two cores the replay's own 40 ms bounds the read: more instances add
memory, not speed. Process memory with verifier instances oscillates by
about 50 MB as their WASM memory reaches its high-water mark; it levelled
after about 700 statements.

*The first sync at 10⁵ statements*, the same shape with a checkpoint every
10,000, verified ahead on two instances, into a kept replay file committed
and digested at every 10,000th record. With `--kept 1000`, 1,000 more
records are then read incrementally. Run of 2026-10-01 at `6c7d8f2`, the
desktop otherwise idle:

| Phase | Result |
|---|---|
| Copy the 1.48 GB package into the evidence file | 78 s, process memory 334 → 368 MB |
| Replay 10⁵ statements with real verification ahead, keep points included | 52.7 ms a statement, 88 minutes |
| Heap over the replay | 15.7 → 17.1 MB, 3 bytes a statement |
| Process memory over the replay (verifier instances and the caller's key-deriving instance included) | quarter means 419, 444, 466, 449 MB; peak 543 MB |
| Files | evidence 1.57 GB, state 212 MB |
| Incremental read of 1,000 more records from the kept file | digest check 0.7 s, 45 s in all |

*Against the design point.* A first sync of 10⁶ statements on this desktop
is about 15.5–16 h. That is 52.7 ms a statement, plus the 2–4 ms the
[storage probe](#replay-state-storage) adds per event as its database grows
towards 10⁶, plus about 14 minutes to copy 15.6 GB of records. With the
Ergo header check of about 4.5 h run after it rather than beside it, the
total is about 20.5 h, within the 24 h budget. Load is the remaining risk:
it doubled earlier timings on this host. The declared reader has 8 cores,
so verification and the header check run beside the replay, which sets the
time.
- *The replay's own work* is now the cost: about 40 ms here and about 23 ms
  in CI. The JavaScript note tree is most of it. Barretenberg's synchronous
  Poseidon2, measured above at a ninth of the JavaScript hash's time, would
  bring the replay below the verification time on two cores. It is the
  lever if load or slower hardware takes the sync over 24 h.
- *Memory:* process memory rose by about 45 MB over the first half and
  levelled in the second, against flat heap. SQLite runs at its default
  cache of about 2 MB per connection, and the keep-point digest reads in
  1 MiB chunks, so neither accounts for it; it is unattributed. Each
  verifier instance settles near 85 MB once it has verified. A
  verify-only party may destroy its key-deriving instance once the
  verifier is built (here it stayed open).
- *Limits:*
  - one desktop below the declared hardware, one run;
  - stand-in records verified against eight real issue proofs, not their
    own;
  - one backing and segment on the reference venue, with no venue ranges;
  - the 10⁶ figure is extrapolated, not run.

### A wallet's witnesses kept at completion (M11b)

A replay rewrote each kept witness of its segment at every record adding outputs, so a wallet's cost per
record grew with the notes it ever held: about 0.15 ms per kept witness per record (16.5 ms at none, 162 ms at
1,000 witnesses, over 15 minutes at 4,000), or about 45 h on witnesses alone for a wallet holding 1,000 notes
through the design point's 10⁶ records. The store now writes a right sibling once its block completes and folds
the one filling block from the frontier when it reads a path; each witness is rewritten at most 31 times, and
the same probe stayed at 17.3–18.1 ms per record from 0 to 4,000 witnesses (the note tree's root being the
cost). The store alone, with no proof, scan or journal, on a 4-core cloud container. Covered now by the
replay-store tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#a-wallets-witnesses-kept-at-completion-m11b).

### An admission under a silence clause (M11b4)

Under a silence or non-service clause the operator's journal reads its own canonical checkpoint through the
public reader before each admission. Each read judged every held checkpoint again, walked the silence clock
from the segment's opening and hashed the kept replay file whole: about 14 ms per held checkpoint per admission
(96–122 ms at 5 held checkpoints, 1,099–1,194 ms at 80). A read now resumes the selected backing's kept walk and
judges only new checkpoints ([decision](../decisions/2026-10.md#2026-10-04--resume-a-kept-walk-so-a-later-read-judges-only-new-checkpoints-slice-11-m11b4-next-4k)),
and the probe stayed at 112–178 ms from 5 to 320. Stand-in proofs, the fixture venue and one backing; a small
replay file, so the whole-file hash a read at a new venue index still takes (about 7 s at 10⁶ statements by
M5b.6's figure) does not show. Covered now by the kept-walk tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#an-admission-under-a-silence-clause-m11b4).

### The commands over a thousand statements (M11c1)

M11c's first part measures the `moe` commands with real proofs against the
[declared budgets](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets), at
a history a run can prove
([method](../decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
`design-point-probe.mjs`
([at its revision](https://github.com/mediumofexchange/reference-ts/blob/fa8384d/scripts/pool/v3/design-point-probe.mjs))
runs `moe operator serve` on the synthetic Ergo node. In rounds of 50, a
backer issues two units to a holder's seed, then the holder pays one unit
to a shop, keeping one change note per payment. The statements are proved
through the wallet library in the probe's process. A block is mined every 14
statements, the design point's peak per two-minute block. At 200, 500 and
1,000 statements, a fresh reader runs `reader supply`, and a fresh wallet runs
`restore-seed` from the holder's seed and then `sync`. Both read through
counting proxies in front of the node and the service. One further round
measures the steady state.

Run of 2026-10-04 at `fa8384d` on a 4-core cloud container (Xeon 2.1 GHz,
16 GB), one checkpoint about every 16 statements:

| Statements | Reader first sync | Wallet first sync (250 notes at 1,000) | Served bytes |
|---:|---|---|---:|
| 200 | 8.8 s, 13.8 CPU-s, peak 442 MB | 9.6 s, 15.0 CPU-s, peak 457 MB | 3.09 MB |
| 500 | 17.3 s, 28.2 CPU-s, peak 490 MB | 18.9 s, 29.7 CPU-s, peak 499 MB | 7.71 MB |
| 1,000 | 29.4 s, 49.4 CPU-s, peak 498 MB | 34.2 s, 54.6 CPU-s, peak 550 MB | 15.43 MB |

- *Operator:* over 1,100 admissions, the submitter saw median 76–90 ms per
  round, p95 at most 116 ms and a maximum of 614 ms, flat across rounds.
  `serve` held
  459–554 MB, with a peak of 572 MB. Stopped and started again over 1,100
  statements, it listened after 3.1 s at 197 MB, without re-verifying its
  journal. The journal directory held 26.7 MB, about 24 KB a statement.
  Three submissions met the reopening lag (`SCHEDULE`). An earlier run met
  `STALE` once: the service refuses while its signed checkpoint is not
  witnessed past the lag. Both are venue waits, which the budget excludes.
  On the synthetic chain, blocks come only with statements.
- *First sync:* 25.7 ms and 44 CPU-ms a statement from 200 to 1,000
  statements, over about 3.7 s of start-up. Linear at that rate, 10⁶
  statements take about 7.1 h on these 4 cores, against 24 h on the
  declared 8. Served evidence is 15.4 KB a statement, and the node's venue
  ranges are 0.68 KB a statement at this block rate. A reader keeps 21 KB a
  statement (21.1 MB at 1,000). The wallet's first sync costs about as much
  as the reader's, because it replays the same history and also scans its
  outputs. `restore-seed` itself took 3.2–3.6 s and read 1.06 MB from the
  node at every mark.
- *Steady state:* over the further 100 statements, the reader's `supply`
  took 6.1 s and 9.5 CPU-s, moving 1.54 MB served and 0.07 MB from the
  node. With nothing new, it took 3.0 s and 3.6 CPU-s and moved 5 KB. The
  wallet's `sync` took 8.2 s and 11.6 CPU-s, and 4.7 s and 5.5 CPU-s with
  nothing new. That is about 60 CPU-ms a statement past a fixed 3.6–5.5 CPU-s,
  so a day of 900 statements in one sync is about 1 CPU-minute and 14 MB
  served, within the ≤ 10 CPU-minute and ≤ 50 MB budgets.
- *Payment preparation* grows with the outputs a seed has ever received.
  Issue proving held at about 1.05 s a statement. The holder's `prepare`
  (its read and its proof) rose from 3.2 s to 4.4 s over 1,100
  statements. Over those statements the holder received about 1,100
  outputs. A profiled 400-statement run (`--cpu-prof`) attributes this
  rise to `ownedNotes`: each wallet read recovers every witnessed output
  of the seed again from its capsule, spent outputs included, using
  JavaScript Poseidon2 and HMAC. The cost is about 1.2 ms an output a read,
  and `holdingsOf`'s tags add to it. The holder's `sync` exceeds the
  reader's `supply` by the same amount. A shop that receives 100 payments
  a day would hold about 10⁵ outputs after three years. Each of its reads
  would then take about 2 minutes, so ten syncs a day would exceed the
  steady-state budget. The lever is to keep each output's recovered
  opening and nullifier with its witness, so that a read recovers only
  new outputs. Dropping a spent output's witness would also help (WORK.md
  Next 4(n)). M11b7 took the first lever and leaves spent outputs out of a
  read ([below](#a-wallet-read-from-kept-marks-m11b7)).
- *Against the budgets:* at 10³ statements every budget holds. Admission is
  under 1 s, and every process stays under 1 GiB. Restart does not
  re-verify. The first sync rate extrapolates within 24 h, and the steady
  state is within budget. Two costs grow. A wallet read's cost per output
  received fails beyond these sizes (above). Peak memory also rose from
  200 to 1,000 statements, by 93 MB for the wallet and 56 MB for the
  reader; M5b.6 saw a rise like this level off. What 10³ statements cannot
  show:
  - whether these rates and memory stay flat at 10⁴–10⁵ (M11c2);
  - the whole-file hash at a new venue index (Next 4(v)), about 7 s at 10⁶;
  - real-chain block sizes. Node bytes here follow synthetic blocks, not
    720 real blocks a day.
- *Limits:* one run per point on one container; one backing and segment;
  the probe's own proving shares the cores with `serve` between
  submissions.

### A wallet read from kept marks (M11b7)

M11b7 keeps each witnessed output's nullifier and opening with its witness and leaves spent outputs out of a
read ([decision](../decisions/2026-10.md#2026-10-04--keep-each-witnessed-outputs-nullifier-and-opening-with-its-witness-and-leave-spent-ones-out-of-a-wallets-read-slice-11-m11b7-next-4x)).
`owned-notes-probe.mjs` ([at its revision](https://github.com/mediumofexchange/reference-ts/blob/9616784/scripts/pool/v3/owned-notes-probe.mjs))
timed `ownedNotes` over one seed's outputs in an in-memory replay store, half of them spent, with no proof or
record: a read recovered every output at 1.6 ms (3.14 s at 2,000 outputs, 32.8 s at 20,000) and now reads one
indexed row per witnessed output at 0.01–0.02 ms (39 ms at 2,000, 214 ms at 20,000, 1.54 s at 10⁵, against about
2 minutes before). Ten syncs a day then spend about 15 CPU-s on it, against the ≤ 10 CPU-minute budget;
spending recovers its one or two inputs at about 1.6 ms each. One 4-core cloud container, one run per point;
a kept file on disk adds page reads, which M11c2 measures. Covered now by `pool-v3-kept-state` and the wallet's
kept-file tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#a-wallet-read-from-kept-marks-m11b7).

### A wallet's tags kept with its marks (M11b8)

M11c2's runtime probe (`runtime-depth-probe.mjs`, [at its revision](https://github.com/mediumofexchange/reference-ts/blob/ee822c4/scripts/pool/v3/runtime-depth-probe.mjs))
found a wallet's read with nothing new growing with the notes held while a reader's of the same history stayed
flat: 351 ms at 315 holdings and 984 ms at 1,065, against 79–93 ms for the reader. Each unspent note cost three
`tagOf` hashes (0.21 ms each in JavaScript Poseidon2). M11b8 keeps the tag in the note's mark
([decision](../decisions/2026-10.md#2026-10-04--keep-each-witnessed-notes-tag-with-its-mark-so-a-wallets-read-hashes-none-slice-11-m11b8)),
and the read at 1,065 holdings took 235 ms, the wallet's cost beyond the reader's falling from about 0.84 to
0.14 ms a holding (a note's witness row and per-note lookups). First syncs were unchanged within the spread.
One 4-core cloud container, one run per point. Covered now by `pool-v3-wallet-kept`, `pool-v3-redemption` and
`pool-v3-kept-state`. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#a-wallets-tags-kept-with-its-marks-m11b8).

### The runtime at depth (M11c2)

M11c's second part runs the runtime over 10⁴ and 10⁵ statements with stand-in records under real verification
load, with venue ranges
([method](../decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
`runtime-depth-probe.mjs`
([at its revision](https://github.com/mediumofexchange/reference-ts/blob/ee822c4/scripts/pool/v3/runtime-depth-probe.mjs))
works on the synthetic Ergo node.
- *Operator:* the journal runs in the probe's process over its own view and publisher, as `moe operator serve`
  opens it. It commits on `serve`'s schedule (interval 2) under a silence clause, so every admission reads its
  own checkpoint. A block is mined every 14 statements, the design point's peak.
- *Records:* eight real issues to a holder's seed come first, and their proofs are kept. Every later statement
  is a stand-in spend: real-size records (14,656-byte proofs of random bytes), two nullifiers and four
  outputs. Every second spend pays the seed one output with a genuine capsule, and every fourth spends one of
  those again, so the wallet holds about a quarter of the spends' count.
- *Verification load:* every verifier (journal, reader, wallet) checks a real record's own proof, and in
  place of each stand-in proof it verifies the next kept real proof: real verification load and memory, not
  the stand-ins' verdicts.
- *Reads:* at each mark, child processes over directories made by the `moe` commands, each with its own Ergo
  view, read through counting proxies. They take a fresh reader's first read of the frontier, a seed-restored
  wallet's first sync, each one's read 200 statements later, and one with nothing new.

Runs of 2026-10-04 at `a4752a9`'s runtime on a 4-core cloud container (Xeon 2.1 GHz, 16 GB), one run per point:
a 10⁴ run (marks 10³ and 4·10³) and a 10⁵ run (marks 10⁴ and 10⁵). Parts of the 10⁵ run shared the container
with tests and M11b8's measurement.

*First sync* (read time after the view's sync; start-up and view sync add 3.5–12 s):

| Statements | Reader | Wallet (holdings) | Reader's peak; quarter means | Served | Kept by the reader |
|---:|---|---|---|---:|---:|
| 10³ | 27.3 s, 58 CPU-s | 29.5 s (265) | 515 MB; 258–492 MB | 15.6 MB | 21.7 MB |
| 4·10³ | 104 s, 204 CPU-s | 111 s (1,015) | 550 MB; 416–518 MB | 62.3 MB | 78.1 MB |
| 10⁴ | 277 s, 490 CPU-s | 293 s (2,515) | 543 MB; 452–508 MB | 156 MB | 191 MB |
| 10⁵, judged at 13,440 (below) | 385 s, 704 CPU-s | not run | 615 MB; 414–573 MB | 1,558 MB | 1,684 MB |

*Admission* by depth (`journal.submit` in the process; the first admission after each block reads at a new
venue index):

| Through | Median, others | Median (p95), first after a block | Checkpoints | Journal | Process memory |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 83 ms | 91 ms (123) | 239 | 0.22 GB | 671 MB |
| 20,000 | 88 ms | 118 ms (149) | 480 | 0.44 GB | 663 MB |
| 30,000 | 91 ms | 143 ms (174) | 718 | 0.65 GB | 680 MB |
| 40,000 | 98 ms | 173 ms (206) | 956 | 0.86 GB | 690 MB |
| 50,000 | 107 ms | 198 ms (237) | 1,194 | 1.07 GB | 739 MB |
| 60,000 | 115 ms | 228 ms (271) | 1,432 | 1.28 GB | 745 MB |
| 70,000 | 122 ms | 254 ms (297) | 1,670 | 1.50 GB | 745 MB |
| 80,000 | 127 ms | 285 ms (330) | 1,908 | 1.71 GB | 770 MB |
| 90,000 | 132 ms | 313 ms (356) | 2,146 | 1.92 GB | 771 MB |
| 100,000 | 140 ms | 343 ms (395) | 2,384 | 2.13 GB | 814 MB |

*Steady state* at each mark: 200 more statements, then nothing new (read time):

| Statements | Reader, 200 new | Wallet, 200 new | Reader, nothing new | Wallet, nothing new (holdings) |
|---:|---:|---:|---:|---:|
| 10³ | 5.8 s | 6.7 s | 85 ms | 351 ms (315) |
| 4·10³ | 6.2 s | 7.9 s | 89 ms | 984 ms (1,065) |
| 10⁴ | 6.6 s | 9.3 s | 117 ms | 2,294 ms (2,565) |

Findings:
- *First sync is flat per statement:* 27–29 ms and about 49 CPU-ms a statement from 10³ to 10⁴, and 28.7 ms
  over the 13,440 statements read at 10⁵ depth. The reader's process levels off at 500–575 MB, with a peak of
  615 MB at 10⁵. Served evidence is 15.6 KB a statement, kept evidence and state about 17–21 KB, and node
  bytes about 0.2 KB a statement here (synthetic blocks of about 14 statements). Linear at this rate, 10⁶
  statements take about 8 h on these 4 cores, against 24 h on the declared 8.
- *A fresh view reaches the tip only over several commands.* At 10⁵ (about 7,300 blocks), a fresh reader's
  view stopped at index 997 after one sync's budget (2,000 headers a supplier). `reader supply` then judged
  the checkpoint held there (13,440 statements) and reported it final at that index, as its `sync` fields
  show. The commands sync the view once per run, so a fresh reader or wallet at the design point (about
  788,000 blocks) would need hundreds of runs to reach the tip. The lever is that a command keeps syncing
  while a pass advances its clock. Each pass stays bounded as now. The wallet's 10⁵ reads, the steady state
  there and the reopening were not reached.
- *Ordinary admissions grew with history*, from 83 ms at 10⁴ to 140 ms at 10⁵ (median). A CPU profile of the
  live journal at 5.5·10⁴ statements (60 s, through its inspector) put about 15% of its time, about 22 ms an
  admission, in the reader's listing of the backing's carrying checkpoints. The journal's own read before
  each admission returns that listing but never uses it, and it costs one row per checkpoint ever held.
  M11b10 leaves the listing out of the journal's reads; the rest of the growth is measured again after it.
  The same profile shows the operator verifying each proof twice: at admission, and when its own read judges
  the checkpoint carrying it.
- *The first admission after each block grows with the journal's read file* (Next 4(v)): 91 ms at 10⁴, 343 ms
  at 10⁵, about 2.8 ms per 10³ statements. A read at a new venue index changes kept answers, so its keep point
  hashes the whole read file (227 MB at 10⁵). Extrapolated, that is about 2–3 s at 10⁶, past the ≤ 1 s
  admission budget. The lever is a digest that does not reread the file: an incremental root, or the rows that
  change at every index kept in a file of their own.
- *A wallet's read grew with the notes it holds*, about 0.84 ms a holding beyond a reader's (three Poseidon2
  tag hashes per note). M11b8 keeps each note's tag with its mark: about 0.14 ms a holding
  ([above](#a-wallets-tags-kept-with-its-marks-m11b8)).
- *A fresh view's first sync at 10⁴ refused.* At 742 blocks above the anchor, the reader's and the wallet's
  first view sync added every header but read no section. The node had closed the pooled connection as idle
  (5 s) while the view judged a header batch, and the next request met the closed socket. The command refused
  `UNAVAILABLE` ("the venue has witnessed nothing yet") until it was run again. M11b9 sends such a GET once
  more.
- *Journal size:* 2.04 GB at 10⁵ statements, about 20 KB a statement, so about 20 GB at 10⁶, as the budget's
  storage column assumes.
- *Against the budgets:*
  - First sync time and memory hold and stay flat per statement, once the view is caught up.
  - The reader's steady state holds. The wallet's holds after M11b8 for the holdings measured.
  - Admission fails at the design point through Next 4(v); its lever is named above (landed in [M11b12](#a-kept-files-digest-from-its-changed-pages-m11b12)).
  - A fresh party's first command fails to reach the tip at depth; its lever is named above (landed in [M11b11](#a-commands-view-caught-up-m11b11)).
  - M11c3 re-measures both, with the 10⁵ reads, once their levers land.
- *Limits:*
  - stand-in records verified against eight real issue proofs, not their own;
  - one backing and segment;
  - synthetic blocks, so node bytes are not the real chain's;
  - the probe's process also holds the synthetic node, the service and the record generator, so its memory
    (814 MB at 10⁵) bounds the operator's from above;
  - one run per point.

### A command's view caught up (M11b11)

M11b11 syncs every command's view in bounded passes until it is caught up
([decision](../decisions/2026-10.md#2026-10-05--sync-a-commands-view-in-bounded-passes-until-it-is-caught-up-slice-11-m11b11)).
`catch-up-probe.mjs` ([at its revision](https://github.com/mediumofexchange/reference-ts/blob/c693fa9/scripts/pool/v3/catch-up-probe.mjs))
opened an operator directory's view on a synthetic venue (depth 10) after 4,500 and 10,000 blocks were mined:
one command reached the tip less the depth in 3 and 6 passes (59 s and 154 s, about 13–15 ms a synthetic
block of header work), where before it answered at the first pass's clock (block 1,989). Empty synthetic
blocks, so the section budget's passes are covered by unit tests only; one supplier; the 4,500-block point
rerun on the review's final stop rule gave the same passes and clock in 61 s. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#a-commands-view-caught-up-m11b11).

### A kept file's digest from its changed pages (M11b12)

M11b12 records a kept replay file's digest from the pages each keep point changed, read from SQLite's
write-ahead log
([decision](../decisions/2026-10.md#2026-10-05--record-a-kept-files-digest-from-the-pages-its-keep-point-changed-slice-11-m11b12-next-4v)).
`page-digest-probe.mjs` ([at its revision](https://github.com/mediumofexchange/reference-ts/blob/e63f546/scripts/pool/v3/page-digest-probe.mjs))
ran the runtime's `ReplayStore` on kept files of 66 MB, 257 MB and 1,020 MB, one block's read (a walk of 14
records) per round: closing the walk took 23.2–23.8 ms at every size, where the whole-file SHA256 it replaced
took 0.19, 0.72 and 2.9 s (about 2.8 s a GB on a 4-core cloud container with no SHA extensions). Opening still
hashes every page, about 1.2 times one whole-file hash. Padding stands in for a deep history, whose indices
change more pages per record (about 40–70 µs a changed page here); the operator's admission at depth is
[M11c3's](#the-design-point-m11c3). Covered now by the kept-file and abrupt-exit tests. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#a-kept-files-digest-from-its-changed-pages-m11b12).

### The design point (M11c3)

M11c's last part measures the runtime again at depth once M11b10–M11b12's levers have landed. It bounds the commands'
overhead at matched size, and extrapolates the design point from the curves
([method](../decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
`runtime-depth-probe.mjs` ([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/1a3f76d/scripts/pool/v3/runtime-depth-probe.mjs);
method in [M11c2's section](#the-runtime-at-depth-m11c2)) ran to 10⁵ statements with marks at 10³, 10⁴ and 10⁵.
`design-point-probe.mjs` ([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/fa8384d/scripts/pool/v3/design-point-probe.mjs);
method in [M11c1's section](#the-commands-over-a-thousand-statements-m11c1)) ran the `moe` commands with real proofs
at matched size. Runs of 2026-10-05 at `d81079b`'s runtime, on two 4-core cloud hosts in turn, since the container
restarted:
- *Host A:* Xeon at 2.8 GHz without SHA or AVX-512 extensions. It ran the 10⁵ run and the matched pair at 200
  statements, one run each.
- *Host B:* Xeon at 2.1 GHz with both, the class of M11c1's and M11c2's runs. It ran an A/B at 10³ against the
  runtime before M11b12 (`0734cda`) and the openings at 10⁵.

The container restarted during the 10⁵ run, after the reader's 10⁵ read. The synthetic node lived in the probe's
process, so the wallet's first sync at 10⁵, the steady state at 10⁵ and the first admission after reopening were
lost. The journal's reopening and the kept files' opening were then measured on the run's files. A second restart
stopped the commands' 10³ run at 400 statements, before its reads, so the matched comparison below ran at 200
statements, both probes back to back on host A.

*The commands against the runtime at 200 statements*, on host A. The runtime figure is the depth probe's child
process over the same kind of directory; the command figure is `moe reader supply` or `moe wallet sync` as its own
process, with real proofs:

| Read | Runtime: time, CPU, peak | Command: time, CPU, peak |
|---|---|---|
| Reader's first sync | 11.9 s, 19.7 CPU-s, 427 MB | 14.4 s, 21.5 CPU-s, 424 MB |
| Wallet's first sync | 11.6 s, 18.7 CPU-s, 427 MB | 13.5 s, 20.8 CPU-s, 441 MB (`restore-seed` before it: 4.8 s, once) |
| Nothing new, reader / wallet | 3.7 s, 4.9 CPU-s / 3.7 s, 4.9 CPU-s | 4.0 s, 4.8 CPU-s / 4.2 s, 4.9 CPU-s |
| New statements, beyond the read with nothing new | about 100 CPU-ms a statement (50 statements) | 80 CPU-ms a statement (100 statements) |

Admission through `serve`'s HTTP took a median of 105–114 ms against about 90 ms in the probe's process at the same
depth on host A. On host B, before the restart, the first 400 statements' admissions took a median of 75 ms over HTTP
against 78 ms in the process at 10³ (the A/B). `serve` held 400–486 MB, peaking at 525 MB. It restarted over 300
statements in 3.8 s.

*Host factor.* At 10³ the same reads took 39.9 ms a statement on host A and 27.1 ms on host B. Admissions took a
median of 111 ms over the 10⁵ run's first 10⁴ statements on host A, about 90 ms over the matched pair's 200 (after
the second restart), and 78 ms over the A/B's 10³ on host B. The A/B on host B found the runtime before and after M11b12 equal:
- a reader's first sync, 26.9 and 27.1 ms a statement;
- a wallet's, 27.0 and 29.3 ms;
- admission medians of 72–86 ms in both;
- steady-state reads within 10%.

So the slower figures below are host A's, not a regression, and they are about 1.4–1.5 times host B's.

*Admission* by depth on host A (`journal.submit` in the process; the first admission after each block reads at a new
venue index). M11c2's figures on host B are given for comparison:

| Through | Median, others | Median (p95), first after a block | M11c2: others; first after a block | Journal | Probe process |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 111 ms | 112 ms (139) | 83; 91 ms | 0.22 GB | 778 MB |
| 20,000 | 113 ms | 115 ms (143) | 88; 118 ms | 0.44 GB | 770 MB |
| 30,000 | 120 ms | 122 ms (159) | 91; 143 ms | 0.65 GB | 775 MB |
| 40,000 | 124 ms | 125 ms (159) | 98; 173 ms | 0.86 GB | 771 MB |
| 50,000 | 123 ms | 124 ms (160) | 107; 198 ms | 1.07 GB | 792 MB |
| 60,000 | 121 ms | 124 ms (156) | 115; 228 ms | 1.29 GB | 795 MB |
| 70,000 | 125 ms | 128 ms (163) | 122; 254 ms | 1.50 GB | 804 MB |
| 80,000 | 131 ms | 134 ms (170) | 127; 285 ms | 1.71 GB | 825 MB |
| 90,000 | 126 ms | 127 ms (162) | 132; 313 ms | 1.92 GB | 836 MB |
| 100,000 | 123 ms | 125 ms (158) | 140; 343 ms | 2.13 GB | 857 MB |

*First sync* on host A (read time after the view's sync):

| Statements | Reader | Wallet (holdings) | Reader's peak; quarter means | Served | Kept by the reader |
|---:|---|---|---|---:|---:|
| 10³ | 39.9 s, 75 CPU-s | 43.0 s (265) | 501 MB; 289–485 MB | 14.9 MB | 20.7 MB |
| 10⁴ | 394 s, 671 CPU-s | 423 s (2,515) | 566 MB; 495–540 MB | 149 MB | 182 MB |
| 10⁵ | 4,368 s, 7,266 CPU-s | lost | 681 MB; 564–620 MB | 1,486 MB | 1,798 MB |

*Steady state* on host A: 200 more statements, then nothing new (read time; the command's process adds about 4 s
and 6 CPU-s of start-up and view sync):

| Statements | Reader, 200 new | Wallet, 200 new | Reader, nothing new | Wallet, nothing new (holdings) |
|---:|---:|---:|---:|---:|
| 10³ | 8.6 s | 9.9 s | 116 ms | 208 ms (315) |
| 10⁴ | 9.2 s | 10.0 s | 205 ms | 640 ms (2,565) |

*Openings at 10⁵*, on host B over the run's files:
- The reader's kept replay file (216.5 MB, about 2.2 KB a statement) opened in 0.8–0.9 s from a cold page cache,
  reading the whole file. Its page digest alone takes 0.3 s warm. The reader's `evidence.db` (1.65 GB) is not hashed
  at opening.
- The journal (1.94 GB, its read file 216 MB) reopened in 227 ms from a cold page cache, reading 9.5 MB, and in
  11–13 ms warm. Its first status took 42–519 ms. No proof is checked.
- The first opening after the container's restart took 115 s, and the first hash of the replay file ran at 17 MB/s.
  A cold-cache rerun did not reproduce either, so they are read as the restarted container's disk, not the store.

Findings:
- **Admission is flat.** The first admission after a block costs what the others do, 1–3 ms more, at every depth.
  At 10⁵ that is 125 ms against M11c2's 343 ms on the faster host, so M11b12 removed the whole-file hash. Ordinary
  admissions grew 111 → 131 ms through 8·10⁴ and stood at 123 ms at 10⁵. That is 1.3 ms per 10⁴ statements end to
  end, at most 2.9 over the steepest stretch, where M11c2 grew 6.3, so M11b10 removed most of that growth. Straight
  lines through these bands give 240–400 ms at 10⁶ on host A, within the ≤ 1 s budget.
- **A fresh party reaches the tip in one command at 10⁵.** The reader's view caught up through 4 passes in 174 s
  (M11b11), and the reader judged all 100,000 statements. M11c2's reader stopped at 13,440.
- **First sync stays flat per statement:** 39.9, 39.4 and 43.7 ms a statement at 10³, 10⁴ and 10⁵ on host A, about
  73 CPU-ms at 10⁵. The wallet's ran 7–8% above the reader's at 10³ and 10⁴. Linear at the 10⁵ rate, 10⁶
  statements take about 12 h on host A's 4 cores and about 8.3 h at host B's rate, against 24 h on the declared 8.
  Served evidence is 15.6 KB a statement and kept state about 19 KB, so a reader at the design point keeps about
  19 GB, as the budget's storage column assumes.
- **Reader memory stays under the budget and rises slowly.** Peaks were 501, 566 and 681 MB at 10³, 10⁴ and 10⁵,
  with quarter means of 564–620 MB at 10⁵. The rise was 65 MB, then 115 MB, a decade. Another such decade gives
  800–900 MB at 10⁶, under 1 GiB with a narrowing margin.
- **The steady state holds.** A read of 200 new statements costs the same at 10³ and 10⁴: about 16 CPU-s beyond the
  fixed start-up, or 80 CPU-ms a statement on host A. A day of 900 statements is about 75 CPU-s and 14 MB served,
  plus about 6 CPU-s of start-up per command, within ≤ 10 CPU-minutes and ≤ 50 MB. What grows with depth is the
  kept file's opening, about 0.9 s at 10⁵, which would be about 9 s a command at 10⁶. Ten syncs a day would spend
  about 1.5 CPU-minutes on it.
- **Restart stays cheap.** The journal reopens without re-verifying, in well under a second at 10⁵. The operator's
  directory held about 23 KB a statement, its read file and venue view included. That is about 23 GB at 10⁶, a
  little above the storage column's estimate of about 20 GB.
- **The commands add a fixed cost.** At matched size they add about 2 s and 2 CPU-s to a first sync, under 0.5 s to
  a read with nothing new, and up to about 20 ms to an admission through `serve`'s HTTP. None of these grows with
  the statements read, so the runtime's curves above, plus this fixed cost, give the commands' figures at depth.
- *Against the budgets:* at the measured depths, admission, first sync, steady state and restart hold and
  extrapolate within budget to 10⁶. Not established here (both measured in [M13h](#the-operator-apart-and-the-wallet-at-depth-m13h)):
  - **the operator's own memory at depth.** The probe's process, which also holds the synthetic node with every
    block and box of its chain in memory, the service and the record generator, grew 778 → 857 MB from 10⁴ to 10⁵.
    Its JavaScript heap grew 37 → 67 MB. A straight line from there reaches 1 GiB near 3·10⁵ statements. That bounds
    the operator from above but does not separate it. The measurement is `moe operator serve` as its own process at
    depth;
  - the wallet's first sync and the steady state at 10⁵, lost with the run. Their curves to 10⁴ and the reader's to
    10⁵ are flat.
- *Limits:*
  - stand-in records verified against eight real proofs, as in M11c2;
  - one backing and segment, and synthetic blocks;
  - one run per point, on two hosts;
  - 10⁶ itself is a local-machine run (WORK.md Open questions).

### The operator apart and the wallet at depth (M13h)

Slice 13 (e) measures the two 10⁵ points M11c3 left open: `moe operator serve` as its own process at depth, and the
wallet's first sync and steady state at 10⁵. `design-point-rerun/driver.mjs`
([at its last revision](https://github.com/mediumofexchange/reference-ts/blob/51ea592/scripts/pool/v3/design-point-rerun/driver.mjs), with the
[profile and memory tools](https://github.com/mediumofexchange/reference-ts/tree/51ea592/scripts/pool/v3/design-point-rerun) used for the findings)
keeps M11c2's history and verification load: eight real issues, then stand-in spends that verify a kept real proof in
place of their own, a block every 14 statements, and `serve --interval 2` under a silence clause. It changes three things:
- `serve`, the synthetic node and each read run as processes of their own. The node logs every request that changed it
  and replays the log when it starts, and the driver resumes from the journal's count. A container restart would lose
  at most the step in progress; none came.
- The stand-ins reach `serve` over its HTTP service. Its memory is read from `/proc`, and its JavaScript heap through a
  hook, as history grows.
- The reads are the `moe` commands (`reader supply`, and `wallet sync` after `restore-seed`), so each figure includes
  start-up and view sync. M11c3 measured these at about 2 s and 2 CPU-s at matched size. A hook gives each process the
  stand-in verifier.

One run of 2026-10-08 at `154735d`'s runtime, on a 4-core cloud container (Xeon at 2.1 GHz, 16 GB, host B's class), with
marks at 10⁴ and 10⁵, then `serve`'s restart. It took 5 h, and nothing else ran on the host.

*`serve`* by depth. Admission is timed as the submitter sees it over HTTP, and the first admission after each block reads
at a new venue index. Each proof is verified twice, at admission and in `serve`'s own read of the checkpoint carrying it
(200,382 checks for 100,193 stand-ins):

| Through | Median (p95), others | Median (p95), first after a block | Resident | CPU a statement | Journal |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 85.8 ms (108) | 84.8 ms (108) | 517 MB | 133 ms | 0.23 GB |
| 20,000 | 86.7 ms (109) | 86.3 ms (111) | 571 MB | 137 ms | 0.45 GB |
| 30,000 | 86.7 ms (111) | 85.8 ms (114) | 594 MB | 137 ms | 0.66 GB |
| 40,000 | 87.4 ms (114) | 86.4 ms (116) | 617 MB | 139 ms | 0.88 GB |
| 50,000 | 87.6 ms (111) | 87.1 ms (115) | 593 MB | 139 ms | 1.10 GB |
| 60,000 | 88.3 ms (115) | 88.2 ms (124) | 593 MB | 140 ms | 1.32 GB |
| 70,000 | 88.6 ms (114) | 88.4 ms (130) | 609 MB | 140 ms | 1.53 GB |
| 80,000 | 89.3 ms (114) | 88.6 ms (124) | 634 MB | 141 ms | 1.75 GB |
| 90,000 | 89.6 ms (115) | 89.4 ms (1,226) | 618 MB | 142 ms | 1.97 GB |
| 100,000 | 91.3 ms (118) | 91.4 ms (1,255) | 610 MB | 144 ms | 2.18 GB |

*First sync*, each the command's whole run:

| Statements | Reader: time, CPU, peak; quarter means | Wallet: time, CPU, peak (holdings) | Served | Kept by the reader, the wallet |
|---:|---|---|---:|---:|
| 10⁴ | 241 s, 463 CPU-s, 583 MB; 450–556 MB | 263 s, 485 CPU-s, 559 MB (2,515) | 156 MB | 191 MB, 216 MB |
| 10⁵ | 2,579 s, 4,868 CPU-s, 629 MB; 514–597 MB | 2,878 s, 5,226 CPU-s, 676 MB (25,015) | 1,558 MB | 1,885 MB, 2,130 MB |

*Steady state*: 200 more statements, then nothing new (each the command's whole run):

| Statements | Reader, 200 new | Wallet, 200 new | Reader, nothing new | Wallet, nothing new (holdings) |
|---:|---|---|---|---|
| 10⁴ | 9.7 s, 16.1 CPU-s, 444 MB | 10.7 s, 17.0 CPU-s, 433 MB | 3.8 s, 4.6 CPU-s, 293 MB | 4.0 s, 4.9 CPU-s, 277 MB (2,565) |
| 10⁵ | 10.7 s, 17.2 CPU-s, 429 MB | 19.7 s, 26.5 CPU-s, 632 MB | 4.3 s, 5.2 CPU-s, 302 MB | 7.4 s, 8.7 CPU-s, 441 MB (25,065) |

*Restart* at 100,201 statements: `serve` listened after 4.0 s over its 2.17 GB directory and then held 247 MB, against
662 MB before. Its first admission took 834 ms, a read at the reopened journal's new index.

Findings:
- **The operator's memory levels off.** `serve` rose from 517 to about 600 MB between 10⁴ and 3·10⁴ statements, then held
  593–634 MB to 10⁵. It peaked at 642 MB while admitting, and at 663 MB after serving both 10⁵ first syncs. Its JavaScript
  heap stayed near 7 MB after collection, and its heap snapshots grew from 23 to 30 MB between the marks. Sampled from
  2.5·10⁴ on, each part of the resident set was flat: anonymous mappings of 408–441 MB (V8 and the two verifier
  instances' WebAssembly), 125 MB of malloc heap (154 MB after serving) and the 55 MB binary. Restarted at 10⁵, it held
  247 MB. So the journal holds no state that grows with history, and M11c3's straight line to 1 GiB near 3·10⁵ does not
  apply to the operator.
- **Admission is flat.** The median rose from 85.8 to 91.3 ms over HTTP between 10⁴ and 10⁵, about 0.6 ms per 10⁴
  statements. A straight line gives about 150 ms at 10⁶.
- **A statement that arrives during `serve`'s read of its own newly held checkpoint waits for that read.** A profile of
  3,000 more statements at 10⁵ ran under `--cpu-prof`. Its 72 commitments coincided with the 71 admissions of
  the 3,000 that took over 0.5 s, 1.30–1.48 s for the middle 90% of them. Once the venue holds a commitment, `serve`'s next poll reads it
  at the new index. That read verifies the proofs of the checkpoint's statements again, in the verifier's workers. It
  also replays them on the note tree, where JavaScript Poseidon2 took most of the main thread's time. Admissions queue
  behind it in `serve`'s one journal turn.
  - The wait follows the statements a checkpoint carries, not depth. The profile's checkpoints carried about 40–44, and the
    longest admission in each band was 1.4–1.9 s from 10⁴ on. What changed with depth was only how often the wait fell
    on the first admission after a block, which moved that column's p95 past 1 s from 9·10⁴.
  - At the design point's peak, a checkpoint carries about 28 statements, so the wait is about 1 s. About 0.4% of
    statements would arrive during one and wait up to that long, at the edge of the ≤ 1 s admission budget. The median
    holds.
  - Levers (WORK.md Next 4 (ay)): the journal's read skips verifying a statement whose receipt it signed after verifying
    it at admission, or reads off the admission queue. Poseidon2 on Barretenberg shortens both. Slice 15 took the first
    and the third ([edges](#the-design-points-two-edges-slice-15)).
- **The wallet's first sync holds at 10⁵.** It took 28.8 ms a statement against the reader's 25.8 ms, peaking at 676 MB
  with 25,015 holdings. It was 26.3 ms at 10⁴, so it is flat per statement. Linear at the 10⁵ rate, 10⁶ takes the wallet
  about 8 h on these 4 cores, against 24 h on the declared 8. Served evidence stays 15.6 KB a statement. The reader keeps
  18.9 KB a statement and the wallet 21.3 KB.
- **A wallet's memory grows with its holdings, not with history.** At 10⁴ the wallet's read with nothing new matched
  the reader's within 0.2 s and 16 MB. At 10⁵ it took 7.4 s and 441 MB against 4.3 s and 302 MB. Sampled again with
  26,533 holdings, its JavaScript heap peaked at 124 MB against the reader's 29 MB, and it held 441 MB against 288 MB.
  That is about 6 KB and 0.12 ms a holding (M11b8 measured 0.14 ms), so a wallet holding about 1.2·10⁵ unspent notes
  would pass 1 GiB in a sync. The probe's holder is extreme by construction, since every second spend pays it; a
  design-point holder holds far fewer notes. Lever (WORK.md Next 4 (az)): a sync keeps its holdings in rows and streams
  its view, instead of holding every note as objects. Slice 15 cut the cost per holding instead ([edges](#the-design-points-two-edges-slice-15)).
- **The steady state holds.** The reader read 200 new statements in 10.7 s and 17.2 CPU-s at 10⁵, against 9.7 s and
  16.1 CPU-s at 10⁴. The wallet costs about 89 CPU-ms a new statement beyond its read with nothing new. A day of 900
  statements with ten syncs comes to about 170 CPU-s and 14 MB served for this wallet, within ≤ 10 CPU-minutes and
  ≤ 50 MB.
- **Restart stays cheap:** 4.0 s to listen at 10⁵. The journal holds 21.8 KB a statement, about 22 GB at 10⁶, against
  the storage column's estimate of about 20 GB.
- *Against the budgets:* at 10⁵ the operator, the reader and a wallet hold every budget, and their curves extrapolate
  within budget to 10⁶. Two exceptions remain, (ay) and (az) above: the ≤ 1 s admission budget at the edge for a
  statement that arrives during the journal's own read, and a wallet's memory past about 1.2·10⁵ holdings.
- *Limits:*
  - stand-in records verified against eight real proofs, as in M11c2;
  - one backing and segment, and synthetic blocks;
  - one run per point, on one host;
  - 10⁶ itself remains a local-machine run (WORK.md Open questions).

### The design point's two edges (slice 15)

Slice 15 measures the levers for M13h's two edges ([decision](../decisions/2026-10.md#2026-10-08--hash-h-through-barretenberg-let-the-journals-own-read-skip-the-proofs-it-verified-and-slim-a-wallets-read-notes-slice-15)). The tooling is
[at defc7ee](https://github.com/mediumofexchange/reference-ts/tree/defc7ee/scripts/pool/v3/design-point-edges), over M13h's driver and stand-in verifier. Every run was on
2026-10-08 on one 4-core cloud container (Xeon at 2.1 GHz, 16 GB), M13h's host class.

*The host hash.* Barretenberg's WebAssembly `poseidon2Hash` takes 0.085 ms against the JavaScript hash's 0.41 ms, with no
difference over 1,600 random inputs. Its native backend takes 0.044 ms. Starting the instance takes about 0.2 s and 30 MB.

*Admission during the journal's own read, A/B.* Each variant builds its own history of 1,200 statements. It then admits
1,500 stand-ins through `serve --interval 2`, with a block every 14 statements, so 36 checkpoints of about 42 statements
each. The wait follows a checkpoint's statements, not depth (M13h). The first admission of each run reads what the
building process admitted and is listed apart:

| Variant | Median (p95) | Waits over 300 ms: count, median, max | First admission |
|---|---:|---|---:|
| `66d3e93`, as M13h | 88.3 ms (117) | 36, 1,153 ms, 1,478 ms | 1,467 ms |
| H through Barretenberg | 60.5 ms (79) | 35, 752 ms, 940 ms | 1,121 ms |
| Proofs remembered at admission | 90.2 ms (114) | 35, 1,027 ms, 1,157 ms | 1,423 ms |
| Both (slice 15) | 60.2 ms (78) | 35, 424 ms, 527 ms | 1,028 ms |

*At 10⁵.* M13h's method, with both levers (`965b3c1`'s runtime), to 10⁵ statements in 2.2 h. From 2·10⁴ to 8·10⁴ the host
also ran the wallet measurements below. Admission over HTTP by band:

| Through | Median (p95), others | Median (p95), first after a block | Worst | Resident (peak) | CPU a statement |
|---:|---:|---:|---:|---:|---:|
| 10,000 | 62.1 ms (88) | 61.0 ms (81) | 714 ms | 435 MB (437) | 78 ms |
| 50,000 | 63.9 ms (97) | 61.9 ms (85) | 662 ms | 450 MB (476) | 84 ms |
| 80,000 | 67.2 ms (103) | 64.9 ms (94) | 1,480 ms | 452 MB (477) | 84 ms |
| 100,000 | 61.8 ms (85) | 60.2 ms (75) | 740 ms | 453 MB (480) | 84 ms |

Then 3,000 more stand-ins through a restarted `serve`, with nothing else on the host: median 61.2 ms (p95 82.5). Its 71
waits during the journal's own read lay between 518 and 606 ms (5th to 95th percentile), with a median of 550 ms; the
worst was 806 ms. The first admission after the restart took 1,498 ms.

*A wallet's holdings.* One history of about 25,100 statements, nearly all paying the probe's seed, so that 99,832 notes are
unspent. Each figure is the command's whole run:

| Holdings | Command | `66d3e93` with H through Barretenberg | Slice 15 |
|---:|---|---|---|
| 19,860 | wallet, nothing new | 6.0 s, 436–448 MB, heap 115–124 MB | 5.0 s, 318–323 MB, heap 61–93 MB |
| 19,860 | reader, nothing new | 3.9 s, 307–310 MB | 4.0 s, 310–326 MB |
| 99,832 | wallet, first sync | 615 s, 945 MB, heap 283 MB | 529 s, 859 MB, heap 245 MB |
| 99,832 | reader, first sync | 442 s, 633 MB | 444 s, 637 MB |
| 99,832 | wallet, nothing new | 14.7 s, 697–710 MB, heap 273–277 MB | 10.4 s, 518–524 MB, heap 214–250 MB |
| 99,832 | reader, nothing new | 4.2–4.5 s, 306–308 MB | 4.1–4.2 s, 303–309 MB |

The output (12.8 MB of JSON at 10⁵) is the same.

Findings:
- **Admission stays within ≤ 1 s during the journal's own read.**
  - H through Barretenberg shortens the read's replay and every admission's own replay: the median fell from 88 to 60 ms.
  - Proofs remembered at admission spare the read its second verification of each proof.
  - Each lever alone leaves waits at 0.75–1.03 s with checkpoints of 42 statements. Together they wait about 0.42 s, or about
    0.3 s at the design point's 28 statements a checkpoint.
  - At 10⁵ the waits lay between 0.52 and 0.61 s, against M13h's 1.30–1.48 s at the same checkpoint size. At the design
    point's 28 statements a checkpoint that is about 0.37 s.
  - They grew from 0.42 s at 2·10³. Growth per decade gives about 0.6 s at 10⁶ at this size; growth per statement gives
    about 1.7 s. Only the 10⁶ run can tell (WORK.md Open questions).
  - The operator's CPU a statement fell from M13h's 133–144 ms to 78–84 ms. Its resident set stayed at 435–480 MB,
    against M13h's 517–634 MB.
  - One admission took 1.48 s, in the band from 7·10⁴ to 8·10⁴, while the wallet measurements' first syncs ran on the
    same 4 cores.
- **The first admission once a restarted journal's last commitment is held still reads what the previous process
  admitted.** The new process remembers none of it: 1.03 s at 2·10³ and 1.50 s at 10⁵, at 42 statements a checkpoint on
  this host.
  - Reading earlier does not help. A restarted journal admits only after the lag, and the slow read follows the venue
    holding the commitment the previous process signed last, which happens after `serve` listens.
  - A read before listening, at the restart's index, discarded the journal's kept reads and replayed all 2.7·10³
    statements in 37 s (WORK.md Next 4 (bb), [fixed](#the-restart-read-next-4-bb)).
- **A wallet's read costs less per holding, but still grows with its holdings.**
  - Against the same code with only the hash changed, a nothing-new sync at 10⁵ holdings holds about 2.2 KB a holding beyond a
    reader's (4.0 KB before) and takes 0.06 ms a holding (0.10 ms before). M13h, before the hash too, measured about 6 KB.
  - A first sync holds about 2.2 KB a holding beyond a reader's (3.1 KB before).
  - So a seed-restored wallet's first sync reaches 1 GiB near 1.8·10⁵ unspent notes (about 1.3·10⁵ before), and its later
    syncs near 3.4·10⁵.
  - Allocation profiles found the cost in how each note was read: a bigint per byte in each field conversion, four closures
    and accessor pairs a note, and two prepared statements a holding. They did not find it in what a note holds.
  - What remains is spread over the replay store's rows, each note's demand lookups and the view.
  - Holding memory independent of holdings needs the sync to keep its holdings in rows and stream its view (WORK.md Next 4 (az)).
- *Limits:*
  - one run per point, on one host;
  - stand-in proofs verified against real ones, as in M11c2;
  - the wallet's holder is extreme by construction;
  - memory is the process's peak, which garbage collection timing moves by tens of MB.

### The restart read (Next 4 (bb))

Slice 18's 10⁶ run stopped at 1.25·10⁴ statements because a restarted `serve` replayed its whole history in its first
admission ([decision](../decisions/2026-10.md#2026-10-09--record-a-kept-files-digest-before-its-log-moves-in-and-keep-a-long-reads-progress-by-time-next-4-bb)).
A probe ran that run's driver (`scratch/dp6`, Windows) on a traced build, on the same laptop (i7-5500U, 4 threads), at
2·10³–6.2·10³ statements, 42 a checkpoint:
- **Before the fix, a stop between a keep point's commit and its digest discarded the kept reads.** With serve killed
  there, the restart's open found no matching digest, so the first admission replayed all 2,339 statements: about 100 s,
  past seven of the client's 10 s idle bounds. A stop at an idle moment kept them: the first read took 2.05 s at
  2.6·10³ and 2.4 s at 6·10³ (a test suite ran beside the second).
- *The window:* about 18–120 ms per keep point that changed rows, about once a checkpoint, so a random stop meets it
  rarely. In the 10⁶ run the reads file had been deleted and made again: its NTFS file number lies outside the block
  of the run's other files, and Windows carried its old creation time over. A deleted kept file is what an opening
  that fails the digest check leaves. The probe's own discarded file shows the same sign.
- *Every later restart began again,* because a keep point fell only every 10,000 records (minutes of replay) and the
  keeper killed each restart within about 18 s.
- **After the fix, a stop inside a keep point costs only that keep point.** Killed after its commit and before its
  digest, at 6.1·10³: the restart opened its kept reads in 0.15 s before it listened, and its first read took 2.2 s.
  Killed after its digest and before its checkpoint: 0.15 s and 1.8 s. A first read otherwise took 1.5–2.6 s.
- *Opening hashes the whole reads file,* at about 190 MB/s here (254 MB in 1.36 s). The 10⁶ run's file grew about
  2.2 KB a statement, so the hash would be about 12 s at 10⁶. `serve` now pays it before it listens.
- *Limits:* stand-in proofs, synthetic blocks, one host, one run per point; the trace's own logging adds to each read.
  The first admission still reads what the previous process admitted since its last kept read (slice 15's limit above).

## Invalid-checkpoint evidence

`model/pool-fault-boundary.test.ts` (nine cases over the authority and recovery models) shows, under the
contracts before the fault rules were selected, that one forged-proof checkpoint cost both scope
backings their readable snapshot, count and descent even after independent replacement, that invalid
publications at indices 4, 8, 12 and 16 kept resetting a five-index clock, and that corrupt or withheld
replica evidence never restored a consumed payer note from an older checkpoint. The case stays executable
as the original failure in [fault recovery](POOL_FAULT_RECOVERY.md), which holds the selected remedy.
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#invalid-checkpoint-evidence).

## Venue publication sizes, offline

Offline sizing (Fleet 0.12.0, nothing signed or sent) at ergo v6.1.5 / sigmastate v6.0.6: `MaxBoxSize`
4,096 bytes and `MinValuePerByte` 360 nanoERG, both over full box bytes with the 32-byte transaction id
and index; mempool `maxTransactionSize` 98,304 bytes; one chunk per box in `R4` with a 36-byte `R5` header
leaves 3,978 bytes. A 20,000-byte release needed 6 outputs in a 20,724-byte transaction (at least 0.00745
ERG plus the 0.0011 ERG fee); C3.6 later removed the non-membership proofs, so a release is about 15.5 KB
in four chunks. Superseded by the [publication experiment](#venue-publication-and-reassembly-on-a-node)
(signed sizes, node acceptance) and the runtime's `ergoRunCapacity`.
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#venue-publication-sizes-offline).

## Full-block commitment feasibility

*Retired 2026-09-25 with its Fleet dependency: the range source is chosen and `test/ergo-supplier.test.ts` reproduces the fixture roots; the script (`check.mjs`, run by the former `npm run check:ergo:range`) is kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range).*

Checked complete-block transaction commitments before the A8/A9 range source was chosen, against ergo
v6.1.5 ([c364664](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/history/BlockTransactions.scala)),
sigma-state v6.0.6 ([ab0b15c](https://github.com/ergoplatform/sigmastate-interpreter/blob/ab0b15ceb9d34f2ccd6e68e3e2a8aa27cd16a042/data/shared/src/main/scala/org/ergoplatform/ErgoLikeTransaction.scala))
and scrypto v3.1.1 ([70b3610](https://github.com/ergoplatform/scrypto/blob/70b36102b2ed8f7a443cfc92f9f135665d777a37/shared/src/main/scala/scorex/crypto/authds/merkle/MerkleTree.scala)):
version-1 leaves are transaction ids, later versions append 31-byte witness ids, prefixes 0/1. The
[result at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-range-verification.json)
(414 assertions): four mainnet blocks (heights 100000, 1000000, 1500000, 1876512; 29 transactions, 77
outputs) reproduced every id and root, but only 13 of 29 transactions round-trip through Fleet's decoder,
and two different JSON field assignments serialize to identical unsigned bytes, so serializing node JSON
and checking the root cannot authenticate claimed output fields. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility).

## Full binary decoder feasibility

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

Evaluated `ergo-lib-wasm-nodejs` 0.29.0-alpha-2f840d3 (sigma-rust `2f840d3`, pinned over 0.28.0, which
refused every Ergo 6.0 script: [decision](../decisions/2026-09.md#2026-09-22--pin-a-sigma-rust-build-that-keeps-every-sized-tree-as-exact-bytes)).
The [report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-verification.json)
(20,050 assertions): all 29 transaction ids and 77 outputs of the fixtures recovered, including the 16
transactions Fleet cannot decode and two header-version-3 trees; all 19,380 proper prefixes rejected by
the exact round trip; the five sized trees read as exact slices under header versions 0–7 (80 reads).
Resource bounds were not established: the parser accepts trailing bytes, keeps a failed sized-tree parse
as opaque `Unparsed` bytes and allocates `tree_size_bytes` from a decoded `u32` before reading (source
evidence). Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility).

## Ergo venue-profile candidate and full-block range verifier

*The profile experiment (`profile-check.mjs`) retired 2026-09-25 with the vendored sigma-rust build: the unit tests and the [node's own parser](#hostile-input-node-equivalence) cover it; it is kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range) and its report below stays as measured there. `ergoRangeVerifier` retired later that day: `ErgoVenue`, which verifies its own headers, is the one Ergo reader.*

The model `ergoRangeVerifier` over [the candidate profile](ERGO_VENUE_PROFILE.md), driven through Fleet and
sigma-rust ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-range-profile-verification.json),
277 checks), answered a twelve-height synthetic chain with real signed commitments and read the four
mainnet fixtures as one-block ranges: real roots of block versions 1, 3 and 4 reproduced, all 77 outputs
scanned. Capacity carried from it, counted with a two-byte output index (M7 replaced the counts with the
runtime's `ergoRunCapacity` and a [live capacity run at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/ergo-publisher-verification.json)): a box holds a
3,981-byte piece and a transaction under the 98,304-byte mempool policy 24 pieces (95,544 bytes), so a
release of 15,498 bytes in four pieces fits, as does any proof up to 94,702 bytes; the frame's 131,914-byte
ceiling is a parser bound. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#ergo-venue-profile-candidate-and-full-block-range-verifier).

## Real-chain exhaustion cost from a real anchor

*Retired 2026-09-25: P4 is answered and the runtime's `ErgoVenue` reads the mainnet itself ([runtime venue](ERGO_VENUE_PROFILE.md#runtime-venue)); `chain-cost.mjs` and its guide are kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range), and the report below stands as recorded there.*

The recovery map's P4. `experiments/ergo-range/chain-cost.mjs` was run
explicitly, never by `check` or CI, because it read public mainnet nodes
(GET only; nothing is submitted). It reads the headers of a window from every named node and
the anchor's id at its height, compares them field by field, supplies each
block's transactions by copying the node's JSON text into unsigned bytes and
witness ids (`src/ergo-supplier.ts`, no decoder), counts a section only where every
copy hashes to its stated id and the header's transaction root holds through
the model's root, checks every framed transaction against the node's
statement of its outputs, then builds the model verifier from the real
headers and the supplied sections under four throwaway locations, so every
answer is empty by exhaustion. The [retained report](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-chain-cost-verification.json)
records the window, the nodes' agreement, a digest of the cached responses,
sizes and times. Until 2026-09-24 the run serialized the text with the
pinned sigma-rust and decoded it with two builds
([report at 0453955](https://github.com/mediumofexchange/reference-ts/blob/0453955/docs/ergo-chain-cost-verification.json)).

The window is anchored at height 1873360, so indices 0–5039 are heights
1873361–1878400, with headers to 1878410 for depth 10. `node.ergo.watch`
(5.0.21) and `213.239.193.208:9053` (6.0.6) agree on all 5,050 headers
and the anchor; the headers are version 4 of 220 or 221 wire bytes (mean
220.9) and link without a gap; the window spans 169.0 hours, 716 blocks a day. Every
one of the 5,040 sections reproduced its header root from the copies of the
node's text, so the JSON route yields exact bytes when the text is read in
its own order.
That root binds each transaction's unsigned bytes and the concatenation of
its proofs, not the proofs' split among inputs (and a version-1 root binds
no proofs); attribution reads outputs only, so no answer depends on the
difference, but the byte counts are authenticated only that far.

| Measure | Last day (720 blocks) | Seven days (5,040 blocks) |
|---|---|---|
| Transactions / outputs | 4,706 / 16,711 | 28,196 / 103,789 |
| Section bytes: total / mean / median | 4,131,042 / 5,738 / 424 | 26,639,110 / 5,286 / 424 |
| Section bytes: p90 / p99 / max | 18,340 / 52,503 / 86,421 | 15,701 / 56,015 / 193,531 |
| Largest transaction, bytes | 32,742 | 88,284 |
| Headers retained (one per block), wire / verifier view, bytes | 159,022 / 75,600 | 1,113,468 / 529,200 |
| JSON fetched, bytes | 21,501,423 | 133,335,507 |
| Indices without a section: sigma-rust 0.28.0 (the pin until 2026-09-22) / `0.29.0-alpha-2f840d3` (pinned 2026-09-22 to 09-23), decoder readers now retired | 5 / 0 | 58 / 0 |

Since 2026-09-24 neither the reader nor its supplier decodes
([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)):
the retained run, an offline re-read of the same cache (same digest), copies
each transaction's unsigned bytes and witness id from the node's text and
builds the verifier from those. All 28,196 transactions are supplied under
their stated ids, and the section bytes (the same copies with their proofs)
total 26,639,110, exactly the pinned serializer's count. The reader takes
24,165,521 bytes for the week; every root reproduces from the hashes of the
unsigned bytes, all 5,040 indices have their sections, and the framer
reads 4,707 of the 28,196 transactions, each with exactly the outputs the
node's JSON states (the rest carry no record); since the bytes are copied
from that JSON, this shows the framer splits them as the node's statement
does, and agreement with the node's own parser is the
[hostile probe](#hostile-input-node-equivalence)'s. The supplier's work, parsing
the week's 133 MB of JSON and copying every transaction, takes about 7.5 s
against 163 s for sigma-rust's serialization and derivation; building the
verifier, where every supplied section is hashed, rechecked against its root
and framed, takes about 3.5 s (13–21 s in the earlier runs on a loaded host).
5,040 single-index probes afterwards take under 0.1 s and a day's or the
week's range answers in a few milliseconds (the least of five repetitions),
walking per-index lists; every request answers (empty, 102 bytes each).
Under the 2026-09-22 decoder reader the first run, on 0.28.0, left 58
indices and every range through them unresolved. The week's
sections were fetched by a scratch probe whose log is not retained: about
six minutes of response time, roughly 80 ms a response at 250 ms pacing
from one host, and the 6.0.6 node refusing new connections after about 600
unpaced requests. The retained run reads the cache (two live reads, the
nodes' state), and reads are paced and rotate between nodes with backoff.

Three findings bind later choices. The then-pinned 0.28.0 refuses every
transaction carrying an ErgoTree of header version 3, the Ergo 6.0 script
version: 125 transactions in 58 blocks of the week, each leaving
its index without a section and every range through it unanswered, the
longest resolvable run being 2,683 indices; the alpha reads all of them
after exact round trips and is the experiment's pin since 2026-09-22
([the decision](../decisions/2026-09.md#2026-09-22--pin-a-sigma-rust-build-that-keeps-every-sized-tree-as-exact-bytes)),
with 0.28.0 as the control build. Second, the node's JSON keeps a spending-proof
extension's keys in its map's order, which a JSON object model sorts:
re-serializing parsed objects gives 12 of the week's transactions a
different id, so a supplier on JSON must read the node's text in its own
order (2,272 inputs carry several entries), and the header root, not the
supplier, authenticates the result. Third,
the node's header `size` (220–221 bytes) is twice the verifier's view (105), so
header retention is the deployment's age at about 58 MB a year
of wire headers at this rate.

Not established: the nodes' authenticity (two public nodes agreeing is not
proof of work, chain selection or finality, and a shared upstream is not
excluded), the copy for a node whose JSON states a transaction differently
(none in this window), the inclusion-latency
distribution (A10; it needs submitted transactions, which is P2), and any
bound on future blocks: the counts are for these package versions and this
window. No profile, decoder or dependency pin is selected by this probe.

## Venue publication and reassembly on a node

*Retired 2026-09-25 with the vendored sigma-rust it signed with: P2 is answered, the runtime's own publisher is [testnet-verified](ERGO_VENUE_PROFILE.md#runtime-venue) for kinds 1–3, and kind-4 runs arrive with the publisher's pieces (v3 plan slice 3). `publish.mjs` and its guide are kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range); the runs below stand as recorded.*

The recovery map's P2 submitted six chained cases and a sweep as seven transactions to a public Ergo testnet
node (a 15,498-byte release in four pieces, a 450-byte withdrawal in one; duplicate, reordered, partial,
adjacent and separated runs) and read the kind-4 range back under the subject. Under the
[candidate profile](ERGO_VENUE_PROFILE.md)'s layout every transaction was accepted on first submission
([report at d8f2b7b](https://github.com/mediumofexchange/reference-ts/blob/d8f2b7b/docs/ergo-publication-verification.json),
2026-09-22). The release transaction is 16,077 bytes (the partial case 12,441, the merged 16,608, the separated
16,652, the sweep of all 25 piece boxes 2,412). A 3,981-byte piece is a 4,095-byte box, within the 4,096-byte
limit, and the withdrawal's piece box is 564 bytes. The node's dust rule is its votable `minValuePerByte` over
the full box bytes (upstream `BoxUtils.minimalErgoAmount`): every piece box carried exactly that minimum,
1,474,200 nanoERG for a full piece box and 5,743,440 for a release, and was accepted with a 1,100,000 nanoERG
fee, about 0.0068 ERG a release. sigma-rust's `calc_min_box_value` was 11,880 nanoERG short of the node's rule
for a full piece box, so the experiment computed the values itself; the refusal side of the rule rests on the
upstream source. The six cases returned seven objects at one index in transaction-then-output order (the
release and its duplicate decode under §6; the reordered, partial and merged runs do not decode and have no
force), and every transaction was included two blocks above the node's height at submission. The
[2026-09-24 run on the own testnet node (v6.0.6) at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-publication-verification.json)
repeated the seven transactions through the reader that decodes nothing (`src/ergo-supplier.ts` and the
framer) and answered the same seven objects. Not established: an inclusion-latency distribution (one
correlated observation), the dust rule's refusal side, mainnet acceptance, and header authentication (the
headers came from the one node). Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#venue-publication-and-reassembly-on-a-node).

## Inclusion latency on the mainnet

*The collector (`latency.mjs`) retired 2026-09-25 once the depth was chosen; it is kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range) for a later distribution.*

Recovery map A10 asks how many blocks a publication takes to land against
C3.3's window. Authorized at tip `T` with the instant at the latest
witnessed index, it has force when included at `T + k` with
`1 <= k <= depth + 2`. `experiments/ergo-range/latency.mjs` watched the mainnet
passively from 2026-09-22 19:22 to 2026-09-23 20:22 UTC. It read a public
node's pool ids and blocks every 10 s (GET only; nothing submitted, no key).
Each transaction's first sighting was timed as `k`, bracketed above by the
height one round earlier. The [recorded report](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-latency-verification.json)
binds both states and the collector hash. It checks the window's 784 block
headers: each links to its parent, they end at the node's tip, and all 784
ids agree with a second public node. The own node ran a second observation
for the last 17.5 hours.

Of 7,520 timed sightings, 3,281 were included and 4,239 were dropped. None
was pending at the end. Most drops paid a high fee per byte: 3,531 of the
4,239 paid at least 4,000 nanoERG per byte, a stratum in which 359 of 3,890
sightings landed.
Included transactions had `k` median 3, p90 7, p99 12 and maximum 19; the
pessimistic bracket gives maximum 21.

| Declared depth | Window `k <= depth + 2` | Included within | Pessimistic |
|---:|---:|---:|---:|
| 0 | 2 | 42.4% | 25.8% |
| 2 | 4 | 76.4% | 71.1% |
| 4 | 6 | 88.9% | 86.6% |
| 6 | 8 | 94.1% | 92.6% |
| 8 | 10 | 97.5% | 96.9% |
| 10 | 12 | 99.8% | 99.5% |
| 12 | 14 | 99.9% | 99.8% |

The 30 sightings of 16 KiB or more, a four-piece publication's size, were
29 included with `k` at most 12. Blocks came every 84 s at the median and
262 s at p90 (max 538 s), and 410 of the 784 blocks carried only the
coinbase: a waiting transaction is not included merely because a block
arrives. Fourteen heights were reorganized during the window.

The own node's run (545 blocks, headers agreeing with the public node's)
gives 72.7%, 94.3% and 99.3% for included sightings at depths 2, 6 and 10,
with a maximum `k` of 28. Of the 2,940 transactions both observations timed,
the public node's first sighting was a median 2.7 s later. It came at the same
tip for 2,079, 1–5 blocks later for 783, 6–22 blocks later for 11 and 1–2
blocks earlier for 67, and the public node saw 1,080 first. A later sighting
shortens `k`, so the public node's fractions lean optimistic.

This one day implies that among included mainnet transactions the window
misses about a quarter at depth 2, 6% at depth 6 and 1% at depth 9. At depth
10 it still misses 0.2% on the public node (0.5% pessimistic) and 0.7% on the
own node. Each depth block adds a block interval to finality and to the
holder's wait. Drops are not classified: the report does not separate double
spends, invalid chains and eviction. In the 1–999 nanoERG-per-byte stratum,
where a four-piece publication at the suggested fee falls, 152 of 611
sightings were dropped and the 459 included had `k` at most 12. Counting
drops as misses, 33% of all sightings had force at depth 2 and 44% at depth
10. **Not established:** the population is the mainnet's, not a kind-4
publication with its size and fee; there is one venue, one day and no
congestion episode. `k` counts from the node's sighting, not from a holder's
authorization, so proving and propagation are unmeasured (optimistic). 1,664
included transactions were never seen in the pool, and for 104 sightings
after a round gap `k` is only a lower bound. Proof of work and chain selection
were not checked. No depth or target miss rate is selected, and no profile,
runtime or specification changes.

## Own node as the header source

*`header-check.mjs` retired 2026-09-25: the reader now verifies headers itself ([below](#reader-verified-headers)); it is kept at [1b4857a](https://github.com/mediumofexchange/reference-ts/tree/1b4857a/experiments/ergo-range).*

On 2026-09-22 the reader ran its own mainnet node (official v6.0.6, bootstrapped from a UTXO-set snapshot but
downloading the header chain from genesis, so the node itself checked every header's proof of work and
difficulty) as the header source in place of two public nodes. The
[retained report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-own-node-verification.json)
shows the five pinned fixture headers and the chain-cost window (anchor 1,873,360 to tip 1,878,410, 5,050
headers) on the node's best chain, equal to the public nodes' cached headers, so the chain-cost probe's 5,040
sections are bound to headers this reader validated. The 1.88 million headers synced in 6,863 s (1 h 54 min)
over one home connection, leaving 850 MB of data; the testnet archive node synced its 557,758 headers in
3,685 s. Not established: an independent check of proof of work or chain selection (the reader's own check
followed, [below](#reader-verified-headers)), resistance to an eclipse during sync, and full-block validation
from genesis. Retired with `header-check.mjs`. Full text: [at ca368db](https://github.com/mediumofexchange/reference-ts/blob/ca368db/docs/POOL_DEPLOYMENT_PROBES.md#own-node-as-the-header-source).

## Reader-verified headers

The reader need not run a node to authenticate headers: the profile's
[header store](ERGO_VENUE_PROFILE.md#header-source)
(`src/ergo-headers.ts`) verifies header bytes itself from the
pinned anchor. `experiments/ergo-range/header-verify.mjs` (retired 2026-10-04) ran it on real
mainnet headers on 2026-09-24
([retained report at 6e4cea8](https://github.com/mediumofexchange/reference-ts/blob/6e4cea8/docs/ergo-header-verification.json), recorded offline from
the run's cached responses):

- **Window.** From the P4 anchor at 1,873,360, the store was built from the
  1,024 headers below it by linkage alone; each of three nodes (the own
  v6.0.6 node, `node.ergo.watch` on 5.0.21 and a public 6.0.5 node) served a
  context that links to the pinned anchor id. It then verified all 6,940
  headers up to 1,880,300 from the own node's bytes, and both public nodes'
  copies of the same heights were already known: no header was unsupplied
  or refused, and the best chain is every source's chain height by height.
  P4's anchor and tip ids are on it, so P4's 5,040 root-checked sections
  now stand on headers the reader verified.
- **Every EIP-37 recalculation.** At each of the 8,091 difficulty
  recalculations from activation at 844,673 to 1,880,300, the model's
  EIP-37 value over the nine headers it reads equals the difficulty of the
  own node's accepted header, and each boundary header links to the header
  before it; all 16,198 headers read (at heights ≡ 0 and 1 mod 128) pass
  the model's Autolykos v2 check, across 21 table sizes `N`. These are the
  node's accepted headers read sparsely, not a chain the store verified.
- **Refusals on real bytes.** Nine mutations of an accepted header are each
  refused for their own reason: a flipped nonce (`pow`), `nBits`
  (`difficulty`), a timestamp equal to the parent's (`timestamp`), an
  unknown or below-anchor parent, a changed height, a non-minimal VLQ
  timestamp, a trailing byte and a nonzero new-fields length (`malformed`).
- **Cost.** Accepting a header (parse, rules and the work check) took a
  median of 21 ms (mean 22, p99 44) on this host in pure JavaScript, 153 s
  for the window; the work check alone has a median of 20 ms, almost all of
  it Blake2b over about 34 Autolykos elements of 8 KiB. A year of headers
  (262,800) is therefore about an hour and a half once, then 21 ms a block. A header
  is 220 wire bytes, kept beside the verifier's 105-byte view, and the
  anchor's context is 225,500 bytes once per venue.

The headers' bytes are copied from each node's JSON by
`src/ergo-supplier.ts` and are unsupplied unless the
copy hashes to the stated id (nodes before 6.0 omit `unparsedBytes`).
Unit tests (`test/ergo-headers.test.ts`) pin one real
recalculation, canonical parsing, compact normalization, the context rule
and each refusal, the boundary rule and fork choice on synthetic chains.
One independent review found no divergence from the pinned node's rules
beyond the documented omissions.

Not established: no real fork was offered, so chain choice rests on the
unit cases; three sources that agree say nothing about an eclipse; the
node's local-clock rule is not applied, so a supplier can lower a side
branch's required difficulty after about 256 blocks of work at the starting
difficulty and then feed cheap headers the store keeps (the chain choice is
unaffected; the bound belongs to the runtime's supplier policy); testnet
rules and header versions other than 2–4 are not implemented; the checks
run in pure JavaScript on one host.

## Decoder stack budget

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

The npm alpha of sigma-rust (a debug build) overflowed Node's default stack on a node-valid 7,131-byte
transaction (block 1,827,841) and trapped every later call; expression nesting traps it from depth 50.
The vendored release build of the same commit ([decision](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3))
needs 71 KB of V8 stack for the fixture (alpha 1,173 KB), parses expression nesting to 2,513 levels (alpha
37) and read the 28,196-transaction P4 week identically about six times faster ([stack report](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-stack-verification.json),
[pin report](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-pin-verification.json)).
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#decoder-stack-budget).

## Windows process containment feasibility

Hard Windows process containment of the standalone decoder was never
established, and the planned comparison against a locally built/run Ergo
node is superseded: the project now runs its own official v6.0.6 nodes
through `experiments/ergo-range/nodes.mjs` (decision 2026-09-10, own-node
evidence 2026-09-22). The retired measurements and node comparison are at
the immutable
[`c85af7b` revision](https://github.com/mediumofexchange/reference-ts/blob/c85af7b/docs/POOL_DEPLOYMENT_PROBES.md#windows-process-containment-feasibility).

## Metered decoder feasibility

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

Wasmtime 48.0.0 fuel metering of the 0.28.0 WASM under a fixed contract (10,000,000 fuel a transaction,
16 MiB memory, 4,096 table elements, every import trapping) refused as designed on the fuel, memory,
table and stack controls and decoded 23 of 24 fixture transactions with matching fields (largest
6,739,774 fuel, 1,572,864 bytes of guest memory); a 2,163-byte transaction exhausted fuel while parsing
and stayed unresolved ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-metering-verification.json)).
It judged metering a better candidate than periodic Windows CPU thresholds, with fuel not CPU time and
host memory unbounded; the contained decoder built on it. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#metered-decoder-feasibility).

## Decoder cost and host overhead

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

At a predeclared 100-million-fuel diagnostic ceiling the refused transaction took 21,525,326 fuel
(12,830,008 in `transaction_sigma_parse_bytes`, 2,599,805 reserializing, 5,714,147 building JSON); the
pinned source shows the parse constructor reserializing and hashing for ids and boxes, which explains the
cost without bounding it. On one host compilation took 2.377 s wall and 7.719 s CPU, peak commit reached
154,443,776 bytes and instantiation took 389.539 ms against 19.926 ms of guest parsing over the 24
attempts, favouring a reused compiled module with fresh capped Stores ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-cost-verification.json)).
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#decoder-cost-and-host-overhead).

## Metered release decoder over the week

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

`metered-check.mjs` ran the vendored release build under the same engine and import policy over the 29
fixtures and the 28,196 transactions of the P4 window (heights 1,873,361–1,878,400; [report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-metered-release-verification.json)):
all decoded, fuel per byte median 8,101 and maximum 22,450, guest memory at most 11.1 MB, largest
transaction 88,284 bytes. The finding carried by the [framer decision](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)
(first recorded [here](../decisions/2026-09.md#2026-09-23--keep-the-readers-own-decoder-the-transaction-root-does-not-authenticate-the-nodes-field-split)):
the root authenticates the bytes, not the node's split into ErgoTree and registers (moving one byte from
R5 to R4 of mainnet 1,000,000's `4987fc23…` keeps the id), and checking a split is a parse, since 98.5% of
the week's outputs (102,292 of 103,791) carry unsized version-0 trees. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#metered-release-decoder-over-the-week).

## Decoder node equivalence over the retained blocks

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

Over every full block the own mainnet node keeps after its UTXO snapshot (heights 1,830,001–1,879,100:
49,100 blocks, 314,028 transactions, 1,236,527 outputs, 915,923 registers) the vendored release decoder
reproduced all 49,100 roots, refused none and differed from the node's JSON in no compared field (id,
witness id, output count, ErgoTree, register names and constants); a mutation control per field shows
the comparison can fail ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-equivalence-verification.json)).
Valid retained transactions only; hostile inputs are compared [separately](#hostile-input-node-equivalence).
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#decoder-node-equivalence-over-the-retained-blocks).

## Contained decoder

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

`wasm-meter.mjs` derived from the vendored release build a module that charges fuel at every function
entry and loop head, caps bulk memory, growth and call depth (4,096 frames), run per transaction in a
fresh instance under fuel 2^26 + 2^21·n, memory 8 MiB + 1 KiB·n and inputs to 2 MiB ([report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-containment-verification.json)).
It decoded all 342,253 transactions of the fixtures, the P4 week and the own node's retained blocks with
fields equal to the node's, at most 394,944 fuel per byte; the budget was at least 5.4 times the fuel and
2.98 times the memory any took (costliest: 52,030 bytes, 18.4 × 10⁹ fuel, 16.7 MB), and expression nesting
to the node's cap of 110 decodes within 361 frames while deeper refuses as `depth` at frame 4,097. Not
established: that no node-valid transaction exceeds the budget, host memory bounds, CPU time.
Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#contained-decoder).

## Hostile-input node equivalence

**Framer against node, 2026-09-24, retired 2026-10-09** ([harness at 3ca1961](https://github.com/mediumofexchange/reference-ts/blob/3ca1961/experiments/ergo-range/hostile-equivalence.mjs),
[node reader at 2a625a1](https://github.com/mediumofexchange/reference-ts/blob/2a625a1/experiments/ergo-range/node-read/NodeRead.java),
[guide at 563a477](https://github.com/mediumofexchange/reference-ts/blob/563a477/experiments/ergo-range/README.md#hostile-input-node-equivalence),
[report at 2c6b20c](https://github.com/mediumofexchange/reference-ts/blob/2c6b20c/docs/ergo-framer-hostile-equivalence-verification.json)). The
seeds are the 29 corpus transactions' unsigned bytes, copied by `src/ergo-supplier.ts`,
so the mutations (as below) fall on the reader's own input: 143,227 distinct
cases. Each is read by the node (as below, with the node also stating its own
unsigned bytes, `messageToSign`); every reading the node gives, whole cases,
proper prefixes and the 2,824 distinct rewrites (all stable on a second
read), is 48,865 readings, and every one hashes to the node's id. The framer
reads 15,202 of them, each with exactly the node's output count, trees,
register names and constants, and leaves 33,663 outside its grammar, which
carry no record; none differs and none went uncompared. Of the 97,186 cases
the node refuses, the framer reads 4,608: bytes no version-4 section the
node accepts can hold, so no root can commit to them. Mutations reached ids,
trees and register constants among readings both sides agree on, not output
counts or register names. The node took 50 s for all cases; the framer 0.4 s (the decoder took 34 min in its run).

**Decoder against node, 2026-09-24, retired with the decoder** ([harness at 0453955](https://github.com/mediumofexchange/reference-ts/blob/0453955/experiments/ergo-range/hostile-equivalence.mjs),
[report at 1915d5d](https://github.com/mediumofexchange/reference-ts/blob/1915d5d/docs/ergo-decoder-hostile-equivalence-verification.json)).
The 29 corpus transactions (19,380 bytes) were mutated into 159,397 distinct cases (every byte replaced by
four values, deleted, and preceded by 0x00 and 0x80, every proper prefix, 256 seeded splices per
transaction); the node's reading is the pinned v6.0.6 JAR's own `BlockTransactionsSerializer` on a
one-transaction version-4 section, stating each transaction's id, witness id and each output's tree and
register constants. The contained decoder never read a case under the node's ids with other output
fields. It did refuse 1,141 of the bytes the node reads and writes back unchanged (624 type-check
refusals of expressions the node reads untyped, 71 unimplemented opcodes or methods, 359 value or token
bounds, 87 written back differently) and 1,633 of the node's own rewrites, so one such transaction in a
block would deny the reader that block's ranges; the header commits to the rewrite's ids, so a supplier
serving a miner's original bytes is refused (392 cases). These refusals no longer reach the reader, which
frames unsigned bytes itself ([decision](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer));
the framer's run is above. Full text: [at fd8ce7e](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_DEPLOYMENT_PROBES.md#hostile-input-node-equivalence).

## Proving parameters

The [probe report](https://github.com/mediumofexchange/reference-ts/blob/b4ea7cf/docs/pool-v3-parameter-provenance.json)
and [its script](https://github.com/mediumofexchange/reference-ts/blob/b4ea7cf/scripts/pool/v3/parameter-provenance.mjs)
serve adoption slice 8 M1 ([decision](../decisions/2026-09.md#2026-09-29--order-configuration-adoption-and-state-its-proving-parameters),
pool-v3 §4). Both were retired once recorded. It range-fetched Aztec Ignition's
`MAIN IGNITION/monomial/transcript00.dat` (322,560,412 bytes; its header gives
5,040,001 G1 and 2 G2 points). Transcript coordinates are four big-endian u64 limbs,
least significant first; after reordering them:

- the 2^19 uncompressed G1 points bb.js 5.2.0 loads by default (`bn254_g1.dat`,
  the prefix of the CDN's `g1.dat` with the same hash) equal the transcript's first
  2^19 points, and the 128-byte `bn254_g2.dat` equals its first G2 point;
- `[x]_2` is a valid G2 point. Every G1 point is on the curve, and a random
  128-bit linear combination shows the points are consecutive powers of the `x`
  in `[x]_2` (one pairing equation; about 8 minutes in `@noble/curves`, so it is
  not a CI check);
- issue proves and verifies with only these BN254 points loaded by the caller
  (`skipSrsInit`, `srsInitSrs`), with no Grumpkin points. The key it derives is
  the manifest's. A verifier instance holding G2 and the single G1 point `[1]_1`
  verifies the proof and refuses it under a changed public input;
- `srsInitSrs` refuses a G2 point differing in one byte ("g2_point bytes do not
  match the canonical Aztec [x]_2 SHA-256"). The default download path loads G2
  through the same call;
- `noir_wasm` 1.0.0-rc.3 compiles all six relations to the manifest's bytecode
  identities, and bb.js 5.2.0 derives the manifest's keys from them.

*Limits:* this compares against one published transcript copy and does not
re-verify the ceremony's contribution chain. Soundness still assumes one honest
participant. The G1 comparison covers the 2^19 points compared; the runtime loads the
first 2^15.

The runtime loader (slice 8 M2, [decision](../decisions/2026-09.md#2026-09-29--load-only-hash-checked-proving-parameters))
rests on a disposable probe of bb.js 5.2.0, one desktop, one thread:

- dyadic circuit sizes are 2^13 (issue), 2^15 (spend) and 2^14 (the other four).
  Spend derives the manifest's key and proves with exactly 2^15 points loaded; with
  2^15 − 1 the backend refuses ("prover trying to get too many points"). The
  leading 2^15 points (2 MiB, SHA-256 `50d2f4e9…`) are the same bytes as a 2 MiB
  range of both CDN hosts' `g1.dat`;
- loading all 2^19 points takes 0.8 s uncompressed and 19.6 s from the compressed
  layout (the backend decompresses each start); reading and hashing 32 MiB takes
  0.24 s;
- a verifier instance given `[1]_1` alone verifies the spend proof and refuses it
  under a changed public input; with no G1 point the loader refuses.
