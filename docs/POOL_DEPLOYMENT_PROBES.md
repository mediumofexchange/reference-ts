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
[target scale and budgets](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets), the phone holder's
(declared 2026-10-16) among them. [M13h](#the-operator-apart-and-the-wallet-at-depth-m13h) and
[slice 15](#the-design-points-two-edges-slice-15) measure the runtime against them at 10⁵. A one-backer deployment does not remove general independent
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

`npm run check:pool:v3-store` exercises the runtime's operator
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
block pin separately beside the adopted keys; wrong pins and withheld
sections refuse. Journal and reader entries recompute the reference identity
from the caller's preimage. The [retained report](pool-v3-store-verification.json)
owns the source hashes, outcomes and measurements.

These local/synthetic checks cover one genesis segment of one backing and real
proofs on reference venues. They provide no live-chain finality, wallet
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
with state checks under the adopted configuration; it does not reinterpret v2.
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
block. These are reference reads, with no live-chain claim.

The fixture issues 10, pays 7 with change 3, then burns 5 with receiver change
2. A seedless public verifier checks the 439-byte adopted configuration and
all six source/toolchain/bytecode/key identities against its independently held
manifest. It derives the domain from that frame and the issuer key
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
selection and runtime manifest: it answers the reader's own requests for the
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
| Construction and key routing | Exact adopted configuration preimage and domain ([pool-v3 §11.4](https://github.com/mediumofexchange/money-from-first-principles/blob/e7f7f24/pool-v3.md#114-the-adopted-configuration)); all six independently pinned source/toolchain/bytecode/key identities and fixed helper/bounds/profile | Setup provenance (the parameters' trust assumption) and deployment qualification |
| Backing and scope authority | Canonical signed constant-root terms/name, configuration/venue matching and per-backing issuance keys; header-derived scope root; fixture replacement/reappointment links and revocation checked across each complete scope | Authenticated evidence behind the fixture answers on a live chain: `ErgoVenue` supplies it on the synthetic and testnet reference chains; mainnet stays disabled |
| Local state | Issue/spend/burn across deduplicated shared ancestry and every scoped snapshot, with per-backing totals, shared spent state and original-tree paths; single-backing demand/withdraw/settle and locks | Qualified deployment of the runtime reader; the multi-backing recovery cases above pass locally |
| Witness and continuity | Exact fixture-selected signed checkpoint held in §13 answers; whole-scope classification, last-valid continuity and split/rejoin imports; multi-backing publication force and exact ordered adoption; complete-scope receipts and independent backing non-service counts | Authenticated mainnet chain evidence; the selected Ergo profile is read by `ErgoVenue` on the reference chains |
| Wallet restoration | Seed-only capsule and lit-settlement openings with local or imported-tree paths; independent seedless public audit | Full current state and certified anchors, independent retention and venue/backing discovery; pending invoices still need backup |

Checkpoint selection and the fixture venue evidence
remain explicit **test fixture assumptions**. Signed terms establish identity,
and configuration checks bind the adopted keys; neither establishes
the force of those terms. `configurationChecked` and
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

Superseded by [M11c3](#the-design-point-m11c3), [M13h](#the-operator-apart-and-the-wallet-at-depth-m13h)
and [slice 15](#the-design-points-two-edges-slice-15). `design-point-probe.mjs`
([at fa8384d](https://github.com/mediumofexchange/reference-ts/blob/fa8384d/scripts/pool/v3/design-point-probe.mjs))
ran the `moe` commands with real proofs on the synthetic Ergo node to 10³ statements (2026-10-04, one 4-core cloud
container; [method](../decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
Every [budget](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets) held at 10³, and first sync was linear per
statement. It found one growing cost: a wallet read recovered every output a seed ever received, about 1.2 ms an
output, which [M11b7](#a-wallet-read-from-kept-marks-m11b7) removed. Full text:
[at 563a477](https://github.com/mediumofexchange/reference-ts/blob/563a477/docs/POOL_DEPLOYMENT_PROBES.md#the-commands-over-a-thousand-statements-m11c1).

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

Superseded by [M11c3](#the-design-point-m11c3) and [M13h](#the-operator-apart-and-the-wallet-at-depth-m13h).
`runtime-depth-probe.mjs` ([at ee822c4](https://github.com/mediumofexchange/reference-ts/blob/ee822c4/scripts/pool/v3/runtime-depth-probe.mjs))
ran the runtime on the synthetic Ergo node to 10⁵ statements: stand-in records under real verification load,
`serve`'s schedule under a silence clause, a block every 14 statements (2026-10-04, one 4-core cloud container). It
is the method M11c3 and M13h reuse. First sync stayed flat per statement. It found the levers that M11b8–M11b12
took: the first admission after a block grew with a whole-file hash of the journal's read file
([M11b12](#a-kept-files-digest-from-its-changed-pages-m11b12)); a fresh view reached the tip only over many
commands ([M11b11](#a-commands-view-caught-up-m11b11)); the journal's read listed checkpoints it never used
(M11b10); a wallet's read paid three tag hashes a holding ([M11b8](#a-wallets-tags-kept-with-its-marks-m11b8)); and
a node-closed idle connection refused a first sync (M11b9). Full text:
[at 563a477](https://github.com/mediumofexchange/reference-ts/blob/563a477/docs/POOL_DEPLOYMENT_PROBES.md#the-runtime-at-depth-m11c2).

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

Partly superseded by [M13h](#the-operator-apart-and-the-wallet-at-depth-m13h) and
[slice 15](#the-design-points-two-edges-slice-15). After M11b10–M11b12's levers, `runtime-depth-probe.mjs`
([at 1a3f76d](https://github.com/mediumofexchange/reference-ts/blob/1a3f76d/scripts/pool/v3/runtime-depth-probe.mjs),
[M11c2's method](#the-runtime-at-depth-m11c2)) ran to 10⁵ statements and `design-point-probe.mjs` ran the `moe`
commands at matched size (2026-10-05, `d81079b`'s runtime, two 4-core cloud hosts;
[method](../decisions/2026-10.md#2026-10-03--measure-the-design-point-at-sizes-a-run-can-prove-and-give-the-holders-transport-and-funding-a-slice-before-release-assurance)).
Admission was flat (the first after a block cost what the others did), a fresh reader reached the tip in one command at
10⁵, and first sync and the steady state stayed flat per statement, so all four extrapolated within budget to 10⁶. A
reader's peak memory rose 501, 566 and 681 MB at 10³, 10⁴ and 10⁵; another such decade gives about 800–900 MB at
10⁶, under 1 GiB with a narrowing margin. A kept file's opening grew with depth (about 0.9 s at 10⁵); the commands
add a fixed cost of about 2 s and 2 CPU-s. The operator's own memory and the wallet at 10⁵ were left to M13h. Full
text: [at 563a477](https://github.com/mediumofexchange/reference-ts/blob/563a477/docs/POOL_DEPLOYMENT_PROBES.md#the-design-point-m11c3).

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
  - 10⁶ itself was a local-machine run ([slice 18](#the-design-point-at-10-slice-18)).

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
    about 1.7 s. The 10⁶ run fell between them ([slice 18](#the-design-point-at-10-slice-18)).
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

### A new version's kept reads, prepared beside the operator (Next 4 (bg))

A new version of `moe` names another kept context, so its first read replays the operator's whole history
([decision](../decisions/2026-10.md#2026-10-12--prepare-a-new-versions-kept-reads-beside-the-serving-operator-and-hold-one-handle-per-kept-file-next-4-bg)).
A probe (a disposable test over the journal library, removed after it ran) built 3,000 statements, 42 a checkpoint,
with stand-in proofs and a silence clause, on an Intel Xeon at 2.10 GHz (4 cores, cloud container), then removed the
kept reads as a version change does:
- **Unprepared,** the first admission verified 3,001 proofs and took 17.7 s: the history and its own.
- **Prepared** beside the owner first (18.3 s, 3,000 proofs), the first admission verified 2 proofs and took 0.07 s: the
  record committed after the index the preparation read at, and its own.
- *Scale:* the unprepared admission is linear in the history, about 5.9 ms a statement on this host (the (bb) probe's
  laptop, another host and a traced build, took about 43 ms); the prepared one is linear in what was admitted since the
  preparation.
- *Limits:* stand-in proofs, a fixture venue, one host and one run; building the history took 97.6 s.

### The design point at 10⁶ (slice 18)

M13h's method, as slice 15 ran it, carried to 10⁶ statements on the Windows PC
([decision](../decisions/2026-10.md#2026-10-17--record-the-design-point-at-10-statements-and-take-a-wallets-spent-witnesses-a-reads-opening-hash-and-the-operators-read-wait-as-open-budgets-slice-18)).
The driver and its hooks are [at 9cc291c](https://github.com/mediumofexchange/reference-ts/tree/9cc291c/scripts/pool/v3/design-point-1e6), on
`bc43e79`'s runtime with the lock-byte page fix (`9f6515d`, applied at 4.7·10⁵ statements). Its changes from slice 15's driver:
- each process samples its own memory and CPU in place of `/proc`;
- every process runs at above-normal priority, and each band records the whole host's CPU beside `serve`'s, so other
  work on the PC shows;
- the holder's holdings stop at 25,000, M13h's 25,015 at 10⁵: past it every second statement also spends one of its
  notes, so 10⁶ measures depth at 10⁵'s holdings (holdings are (az));
- `serve` is restarted at each mark.

The host is a laptop below the declared operator and reader hardware: an i7-5500U at 2.4 GHz (2 cores, 4 threads),
16 GB, an SSD, Node 24.21.0. Generation took about 61 h of the nine days from 2026-10-09 to 2026-10-16. The rest went to
the PC's sleep and shutdowns, and to the lock-byte stop at 4.7·10⁵ ([decision](../decisions/2026-10.md#2026-10-13--digest-sqlites-lock-byte-page-as-a-constant-so-a-kept-file-grows-past-1-gib-slice-18)).
The driver resumed from the journal's count each time. Admissions spanning a sleep are left out of the bands (355). The
PC was in other use in 33 of the 100 bands, marked by a host CPU above 40%.

*`serve`* by depth, timed as the submitter sees it over HTTP, 42 statements a checkpoint. "Over 300 ms" holds the waits
during the journal's own read of its new checkpoint (about 238 a band) and the slowest ordinary admissions:

| Through | Median (p95), others | Median (p95), first after a block | Over 300 ms: count, p95, max | Resident (peak) | CPU a statement | Journal | Host busy |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 100.4 ms (161) | 99.7 ms (836) | 237, 984 ms, 1,087 ms | 343 MB (401) | 102 ms | 0.2 GiB | 47% |
| 100,000 | 149.2 ms (297) | 140.0 ms (230) | 467, 2,049 ms, 3,302 ms | 380 MB (430) | 131 ms | 2.1 GiB | 59% |
| 300,000 | 140.7 ms (270) | 134.5 ms (209) | 313, 1,480 ms, 1,605 ms | 354 MB (436) | 130 ms | 6.4 GiB | 25% |
| 500,000 | 152.6 ms (286) | 146.5 ms (232) | 389, 1,777 ms, 2,174 ms | 427 MB (521) | 142 ms | 10.6 GiB | 33% |
| 700,000 | 160.1 ms (317) | 152.2 ms (237) | 585, 1,854 ms, 2,909 ms | 381 MB (521) | 153 ms | 14.8 GiB | 30% |
| 900,000 | 166.7 ms (329) | 157.8 ms (236) | 692, 1,985 ms, 2,707 ms | 372 MB (453) | 156 ms | 19.1 GiB | 30% |
| 1,000,000 | 168.3 ms (343) | 159.6 ms (230) | 726, 2,039 ms, 2,243 ms | 401 MB (460) | 159 ms | 21.2 GiB | 26% |

*The tail:* once the report was done, 3,000 more stand-ins at each of two block sizes, through a restarted `serve` with
nothing else on the host, every admission timed. The waits during the journal's own read are each checkpoint's slowest
admission:

| Block | Statements a checkpoint | Median (p95), others | Checkpoints | Their slowest admission: median, p95, max |
|---:|---:|---:|---:|---|
| 14 | about 42 | 146.7 ms (279) | 72 | 1,805 ms, 2,044 ms, 2,200 ms |
| 9 | about 27 | 144.0 ms (322) | 113 | 1,468 ms, 1,705 ms, 1,967 ms |

The first admission after each restart took 1,261 ms and 1,967 ms.

*First sync*, each the command's whole run, with every stand-in verifying a kept real proof (999,992 and the 8 real issues at 10⁶):

| Statements | Reader: time, CPU, peak; quarter means | Wallet: time, CPU, peak (holdings) | Served | Kept by the reader, the wallet |
|---:|---|---|---:|---:|
| 10⁵ | 3,210 s, 5,982 CPU-s, 645 MB; 513–518 MB | 3,196 s, 6,284 CPU-s, 666 MB (25,009) | 1,558 MB | 1,886 MB, 2,130 MB |
| 10⁶ | 37,108 s (10.3 h), 65,838 CPU-s, 655 MB; 439–521 MB | 39,894 s (11.1 h), 68,020 CPU-s, 1,169 MB (25,009); 528–982 MB | 15,580 MB | 18,834 MB, 21,186 MB |

The wallet's quarter means at 10⁵ were 533–545 MB.

*Steady state*: 200 more statements, then nothing new (each the command's whole run):

| Statements | Reader, 200 new | Wallet, 200 new | Reader, nothing new | Wallet, nothing new |
|---:|---|---|---|---|
| 10⁵ | 16.0 s, 22.9 CPU-s, 379 MB | 21.9 s, 29.0 CPU-s, 382 MB | 7.4 s, 7.9 CPU-s, 274 MB | 11.5 s, 12.4 CPU-s, 306 MB |
| 10⁶ | 29.3 s, 33.0 CPU-s, 471 MB | 46.9 s, 54.1 CPU-s, 487 MB | 15.3 s, 16.4 CPU-s, 315 MB | 33.2 s, 35.2 CPU-s, 419 MB |

Each read of 200 new statements was served 3.1 MB.

*Restart* at 1,000,201 statements: `serve` listened after 19.0 s over its 21.7 GB directory (6.6 s and 2.2 GB at 10⁵), and
then held 241 MB, against 338 MB before. Its first admission took 2,250 ms (551 ms at 10⁵).

*The wallet's growth, isolated* (`witness-probe.mjs`): the runtime's `ReplayStore` appending four-output records to a
kept file, witnessing every eighth output (the run's 12.5% owned) and spending each two records later. Each append that
completes a large block of the note tree, and the keep point after it:

| Leaves | Witness rows | Append | Keep point | Resident before → after, settled |
|---:|---:|---:|---:|---|
| 2¹⁷ | 16,384 | 2.6 s | 2.1 s | 239 → 249 MB, 241 MB |
| 2¹⁸ | 32,768 | 5.2 s | 4.0 s | 247 → 290 MB, 271 MB |
| 2¹⁹ | 65,536 | 10.3 s | 7.0 s | 284 → 366 MB, 350 MB |
| 2²⁰ | 131,072 | 20.2 s | 15.0 s | 352 → 534 MB, 500 MB |

Between those appends the resident set stayed where the last one left it, and an append completing 2¹⁵ leaves took
0.55 s.

Findings:
- **The reader holds every budget at 10⁶.** Its first sync took 10.3 h on this 2-core host, against 24 h on the
  declared 8 cores. It peaked at 655 MB, against 645 MB at 10⁵, so its memory is independent of history length. It was
  served 15.6 KB a statement and kept 18.8 KB. It reads a new statement in about 83 CPU-ms beyond its read with nothing
  new: a day of 900 statements in ten reads costs about 4 CPU-minutes and 14 MB served, within ≤ 10 CPU-minutes and
  ≤ 50 MB.
- **A read with nothing new about doubled from 10⁵ to 10⁶:** the reader's from 7.9 to 16.4 CPU-s, the wallet's from 12.4
  to 35.2 CPU-s. Opening hashes each whole kept replay file (§14's check). At [190 MB/s here](#the-restart-read-next-4-bb),
  that is about 12 s for the reader's 2.27 GB file and 23 s for the wallet's 4.37 GB, most of each read. This is inferred
  from those rates, not profiled. The cost grows with history: a wallet reading ten times a day spends about 7.3 of its
  10 CPU-minutes, about 6 of them hashing (WORK.md Next 4 (cl)).
- **A wallet's first sync passes 1 GiB at 10⁶, through the witnesses of the notes it has spent.** It peaked at 1,169 MB,
  and its quarter means rose from 528 to 982 MB. Its holdings stayed at 25,009 throughout, and at 10⁵ it peaked at
  666 MB. So its memory grows with history, which the budget excludes. Its time, 11.1 h, holds.
  - The witness probe isolates the cause. A record that completes a block of the note tree rewrites the witness of every
    output the wallet ever marked in the leaves before it, spent or not. It does so in one synchronous append that holds
    every moved path in memory. The resident set steps up by about twice as much with each height and stays there.
  - The run's four outputs a statement complete a block of 2²⁰ leaves at about 2.6·10⁵ statements and of 2²¹ at
    5.2·10⁵. The sync's two steps came at the times its replay reached them: 4.2 h and 6.4 h into the 11.1 h run, against
    about 3.9 h and 6.5 h at its mean rate. The next block of 2²⁰, at 7.9·10⁵, raised no new peak.
  - No read of a note-tree namespace uses a spent note's witness: the wallet's holdings read only unspent ones
    (`holdings.ts`), and the reads of spent marks are lit-v1's (§8), in a construction without a tree. Those rows also make the wallet's replay file 2.1 GB larger than
    the reader's. By SQLite's format, each row of about 1.2 KB spills onto an overflow page of its own (an estimate).
  - Levers (WORK.md Next 4 (ck)): drop a tree namespace's witness row once its nullifier is spent, which bounds the rows by
    the holdings; and rewrite a block's witnesses in bounded batches, which bounds the step even at the largest holdings.
    Both are taken ([slice 44](#a-wallets-spent-witnesses-dropped-slice-44)).
- **The operator's memory and storage hold, and its ordinary admission stays flat.** `serve` held 340–430 MB, peaked at
  521 MB, and kept 21.7 KB a statement (21.7 GB at 10⁶, against about 20 GB declared). Its median admission rose from
  100 to 168 ms over the run, and its CPU a statement from 102 to 159 ms.
- **The wait during the journal's own read exceeds 1 s on this host, and holds on the declared hardware only by
  scaling.**
  - In the tails, each checkpoint's slowest admission took 1.80 s at about 42 statements a checkpoint. At the design
    point's peak of about 27 it took 1.47 s, which 3.8% of admissions shared.
  - Over the run, that wait's p95 rose from about 1.46 s at 2.5·10⁵ to 2.04 s at 10⁶ (quiet bands). That is slower than
    in proportion to statements.
  - Slice 15's 4-core host admitted 2.4 times faster at 10⁵ (61.8 ms against 149.2 ms). Scaled by that, the 10⁶ waits
    are about 0.75 s at 42 statements and 0.6 s at 27. That lies between slice 15's two extrapolations, nearer the
    per-decade one.
  - With a third fewer statements a checkpoint, the wait fell only 18%. A fixed part of about 0.9 s a checkpoint here
    grows with depth: the read's kept-file work, not its statements' replay.
  - A run on the declared hardware decides (WORK.md Next 4 (cm)).
- **A restart resumes without verifying its history again, but its first admission waits longer with depth.** `serve`
  listened after 19.0 s (6.6 s at 10⁵), then took 2.25 s for its first admission (0.55 s at 10⁵). The tails' restarts
  took 1.26 s and 1.97 s. That admission reads what the previous process admitted since its last kept read ((bb)'s open
  limit), at the read's depth cost above.
- *Limits:*
  - stand-in records verified against eight real proofs, as in M11c2;
  - one backing and segment, synthetic blocks, one holder by construction extreme up to its cap;
  - one run on one host below the declared hardware, in use for a third of the bands;
  - memory is the process's peak, which garbage collection timing moves by tens of MB.

### A wallet's spent witnesses dropped (slice 44)

A note tree's namespace now drops its own witness row when its replay inserts that row's nullifier, and a record
completing a block rewrites the remaining rows 1,024 at a time, patching the one sibling in place
([decision](../decisions/2026-10.md#2026-10-17--drop-a-spent-notes-witness-and-rewrite-a-completed-blocks-witnesses-a-page-at-a-time-slice-44-next-4-ck)).
The [witness probe](https://github.com/mediumofexchange/reference-ts/tree/9cc291c/scripts/pool/v3/design-point-1e6), unchanged, on the
runtime at `e3c314e` (the append and keep point as merged), against the 10⁶ run's
([results at 403c76d](https://github.com/mediumofexchange/reference-ts/tree/403c76d/scripts/pool/v3/spent-witnesses)):

| Leaves | Append, before → after | Keep point, before → after | Resident after the keep point, before → after |
|---:|---:|---:|---:|
| 2¹⁷ | 2.6 s → 9 ms | 2.1 s → 0.7 s | 244 → 168 MB |
| 2¹⁸ | 5.2 s → 9 ms | 4.0 s → 0.5 s | 290 → 237 MB |
| 2¹⁹ | 10.3 s → 11 ms | 7.0 s → 0.5 s | 366 → 238 MB |
| 2²⁰ | 20.2 s → 12 ms | 15.0 s → 0.7 s | 534 → 247 MB |

The probe's peak over the whole run of 2²⁰ leaves was 249 MB, against 534 MB, and it reached it by 2·10⁵ leaves; the run
took 1,599 s beside the unit suite, against 1,356 s alone. In this probe every witnessed note is spent two records
later, so the rows left are a handful. A wallet's rows are now its unspent notes', so a rewrite's memory is one page and
its work is bounded by the holdings, not by every note the wallet ever held.

*Pending:* a seed-restored wallet's first sync at 10⁶ on the retained run, with this build (WORK.md).

## The trail's succinct relation (slice 27)

Measured 2026-10-12, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/1c85142/scripts/pool/trail-probe);
[decision](../decisions/2026-10.md#2026-10-12--a-succinct-trail-relation-takes-one-4-vcpu-prover-1419-hours-a-day-at-the-design-point-over-half-of-it-sha-256-slice-27-next-9)).
The question: can one prover carry a relation that proves pool-v3 §14's complete replay of the design point's
statements, leaf by leaf, in the declared proof system (pool-v3 §4)? Superseded by
[the aggregation](#the-trails-proof-aggregation-slice-33): the phone path proves the trail's statement proofs and
replays the rest itself, and a relation over the whole verdict stays unbuilt (succinct reading §5 weighs it as an
alternative). Its measurements (one 4-vCPU Xeon at 2.10 GHz, 15 GB):
- *Recursion:* verifying a genuine v3 proof costs 704,135 gates the first in a circuit and 766,520 each further one,
  its key taken as a witness; §7's `proofHash` over a proof's 14,656 bytes 1,128,057 (230 compressions).
- *Primitives:* a SHA-256 compression (Barretenberg's black box) 3,974 gates plus 185 for packing bytes into words; a
  Poseidon2 permutation 73; Ed25519 ([noir-ed25519](https://github.com/willemolding/noir-ed25519) at f9e0b44,
  unaudited) 219,706–276,307 over 86–410 bytes; the reference's `RadixSpentSet` 13.2, 17.8, 21.3 and 22.3 hashes an
  insertion at 10⁴, 10⁵, 10⁶ and 2·10⁶ nullifiers.
- *The leaf:* a spend's is 3.6–3.9 million gates, over half of them SHA-256, and a measured leaf of 3,324,772 gates in
  2^22 rows proved in 47.3–64.8 s. 900 spends a day take 14.0–19.2 hours at the depth-32 path budget a fixed leaf pays.
- *The lever:* a leaf with a Poseidon2 proof digest and a Poseidon2 spent tree of fixed depth 32 measured 1,609,950
  gates in 2^21 rows, proved in 22.2–22.5 s; it changes bytes v3 fixed, so it is a pool-v4 candidate.

Full text: [at 05337cf](https://github.com/mediumofexchange/reference-ts/blob/05337cf/docs/POOL_DEPLOYMENT_PROBES.md#the-trails-succinct-relation-slice-27).

## The trail's proof aggregation (slice 33)

Measured 2026-10-13, read-only ([tooling and result](https://github.com/mediumofexchange/reference-ts/tree/4cd16ee/scripts/pool/aggregation-probe);
[decision](../decisions/2026-10.md#2026-10-13--aggregating-the-trails-statement-proofs-keeps-up-with-the-design-points-mean-on-one-4-vcpu-prover-and-agrees-with-the-host-on-every-hostile-proof-slice-33-next-12)).
The question ([direction 2026-10-13](../decisions/2026-10.md#2026-10-13--keep-the-release-target-take-the-phone-path-now-and-prove-the-trails-proofs-rather-than-its-state-machine-direction),
Next 12 step 2): instead of [a relation over the whole verdict](#the-trails-succinct-relation-slice-27), a phone runs
the reference's own reader over proof-free bytes, and a tree of proofs attests that each statement proof verified
under its kind's key and what its §7 `proofHash` is. Does the tree keep up with the design point's mean on one 4-vCPU
prover, does a leaf accept exactly what the host accepts, and does any verdict need a proof's bytes beyond a failed
proof?

**The circuits.** A leaf of kind k (one circuit per proved kind: issue, spend, burn, demand, settle, request) holds
kind k's key as a constant, verifies one statement proof under it (`verify_proof_with_type`, noir-recursive),
computes `proofHash` as SHA-256 over the proof's 458 big-endian fields, and outputs one digest: Poseidon2
permutations chaining k, the public inputs and the hash's two halves. Its other public input is the node key, free in
the leaf. A node verifies two children, each under one of the six leaf keys (constants) or the node key (its own
public input, which each child must carry), and outputs one permutation of the two digests under a node tag. A phone
recomputes every digest from the proof-free bytes and the supplied hashes, verifies one root proof under the pinned
node key, and checks the root's node-key input against that key. The reader's rules are now succinct reading §§2–3,
whose digests differ from the probe's (its §5).

| Measured (one 4-vCPU Xeon at 2.10 GHz, 15 GB; native bb 5.2.0) | |
|---|---|
| Leaf, each of the six kinds | 1,832,291–1,832,945 gates, 2^21 rows (12.6% headroom); 32.4–34.9 s, median 33.9 over 10 proofs; 2.5–2.6 GB peak; digests equal the host's |
| Node | 1,469,816 gates, 2^21 rows; 24.8–29.4 s, median 25.6 over 4 proofs; 2.0 GB; a two-level tree over issue, spend, burn and demand leaves, every digest equal to the host's, the root verified and its node key the pinned one |
| A statement (leaf + its share of nodes) | 59.5 s |
| Proofs presented to pinned leaves (14: 2 genuine, 12 hostile) | every verdict equals the host's verifier's (`openV3Verifier`); 8 hostile leaf proofs fail verification, 4 cases stop before a leaf proof exists |
| Leaves with their key or key hash as a witness (4 cases, circuits not built) | why keys are constants; bb binds a key hash to its key |
| Hostile children and trees (8 cases) | all refused, one only by the phone's check of the root's node-key input |

**The tree keeps up with the mean 1.6 times.** 900 statements a day take one 4-vCPU prover 14.9 hours. A peak day of
10⁴ takes 165 hours: seven machines in the day, with a spine of 14 node levels (about 6 minutes) after the last leaf.
The direction's estimate from summed parts was 48 s a statement; the leaf runs 34 s rather than the 25–26 s scaled from
its gate count (not isolated; leaf and node both fill 2^21 rows). The leaf's cost is the same for every kind; kind 5 has no proof and
no leaf. With [slice 32](VENUE_ALTERNATIVES.md#the-complete-exhaustion-leaf-slice-32)'s exhaustion (7.0 hours on
slice 22's day, 14.1 on the latest, shared by every scope on the venue), a scope's phone path takes about two 4-vCPU
provers at the mean. Levers: SHA-256 is 1.13 M of the leaf's 1.83 M gates, so the pool-v4 Poseidon2 proof digest
would bring a leaf near 0.7 M (estimate); two statements a leaf, or four children a node, trade rows for fewer proofs.

**Hostile proofs, against the host.** Each case was presented to the host's verifier and to the leaf (execution, then
proof, then verification of the leaf's proof):
- *Leaf proofs that fail* (bb names the stage): a public input changed (spend; demand), a scalar changed, the inner
  proof's pairing-point object set to (G, 2G) and to (G, ∞) (public-input words, so the transcript changes), and spend
  and burn proofs swapped between their leaves (they share a public-input count) fail at the reduction step, where the
  in-circuit verifier's constraints break. A pairing-only tamper (KZG's W replaced by the generator, so only the final
  pairing fails) fails at the pairing check: the inner proof's deferred pairing points enter the leaf's own and are
  checked with it. A node over that leaf and a genuine one also fails at the pairing check, so the points propagate
  up the tree.
- *Refused before a leaf proof exists:* a scalar word plus p (`noir_js` refuses a value past the modulus; the host:
  "Non-canonical proof element"); a commitment's limb split non-canonically for the same point, a commitment off the
  curve and a commitment at infinity (bb's prover stops on its own native assertion; the host refuses each by its
  named malformed-proof message). An honest prover's assertion is not a constraint; against a malicious prover the in-circuit
  verifier's limb-range, alias, on-curve and key-hash constraints refuse each (source reading; probe supports), and a pairing-point object with one
  point at infinity is refused by the reader ([slice 43's recursion probe](../decisions/2026-10.md#2026-10-16--refuse-a-proof-publishing-exactly-one-pairing-point-at-infinity-and-hold-bbs-in-circuit-limb-curve-and-key-hash-constraints-against-a-malicious-prover-slice-43-succinct-read-2-6)).
- *Key cases:* a leaf taking its key as a witness, as slice 27's measured recursion did, accepts a burn proof as a
  spend; the host refuses it. Keys are therefore constants of each leaf. bb's recursion binds a key hash to its key:
  a pinned key with another kind's hash, and a key with another key's hash in either direction, give leaf proofs
  that fail. That also holds up [slice 32](VENUE_ALTERNATIVES.md#the-complete-exhaustion-leaf-slice-32)'s node and
  folds, which admit children by key hash. In review, the pinned leaf's key witnesses (Noir turns the constant
  into witnesses) were patched to the burn key and hash over a burn proof: the leaf proof fails at the reduction step.
- *Operational:* the prover makes a leaf proof over an invalid inner proof, which then fails verification; an
  aggregator verifies each proof natively before proving its leaf.
- *Node:* a child under a key outside the set, a child under a pinned key carrying another node key, a node-key input
  that is not the children's, a substituted child digest, a child's proof with another child's public inputs, and a
  child presenting the pinned spend leaf's key hash over the witness-key leaf's key and proof are all refused.
- *A forged tree:* the genuine node circuit with its node-key input set to the witness-key leaf's key hash, over two
  such leaves accepting a burn proof as a spend. Its root proves and **verifies under the pinned node key**; only the
  phone's check that the root's node-key input equals the pinned key's hash refuses it. That check carries the tree's
  soundness and is a named rule for step 3's contract.

**No verdict needs a proof's bytes beyond a failed proof.** An inventory of every read of a record's or publication's
proof in `src/pool`, `src/pool/v3` and `src/lit` (lit records carry no proof): the bytes are verified, hashed into
`proofHash`, length-checked, copied or compared as bytes; nothing reads a value out of them. The uses that decide a
verdict:
- *Verification* (admission, replay, force, §9 fault targets, a kind-7 request's count): the aggregation attests it.
- *Adoption* (`state.ts`): the trail's record must equal the adopted publication's byte for byte, which the
  proof-free bytes, the proof's length and its `proofHash` decide, barring a SHA-256 collision.
- *A failed proof:* an exclusion (`PROOF` in replay, §9.1's intrinsic exclusion) needs the verifier's strict
  rejection over the exact bytes, which an attestation that proofs verified cannot give. The phone fetches that
  proof and establishes the failure itself; a statement without a leaf is never read as failed.
- *Kind-7 variants* share one statement identity and differ only in their proofs; a phone needs one attestation or
  one native verification per variant, keyed by `proofHash`.
- *Venue publications* (demands, releases, requests) are judged at the venue, outside the evidence chain; a phone
  verifies them natively (below).
- *Lengths:* the trail store's digests decode records strictly (`evidence-store.ts`), so a record whose proof length
  breaks §5 ends a kept trail's authentication, where §7.1 lets digests be computed over such fields (the fault path
  hashes raw fields); the proof-free frame must carry exact lengths, and step 3's contract states which rule it follows.

A proof-free record keeps everything but the proof and adds its 32-byte hash: by kind 607, 938, 671, 614, 358 (kind 5,
unchanged), 782 and 326 bytes against 14,950–15,562 with the proof (kinds 1–7). 900 spends a day are 0.84 MB.

**A phone-class proxy.** The reference's own code on this host, bb.js as WebAssembly (what a phone runs) and
JavaScript single-threaded unless named; a desktop core is not a phone core, so these scale to a phone only by a
device's measured factor (step 5):

| Proxy | This host | A mean day (900 statements, 720 headers) |
|---|---|---|
| A 14,656-byte v3 proof verified, pinned key (a spend; the level-2 root, in review, 23.2 ms) | 22.7 ms, after a 210 ms instance start | one root a period |
| Leaf and node digests recomputed | 0.48 ms a statement | 0.4 s |
| Proof-free replay (`readPackage` over 1 issue and 1,000 spends, stand-in proofs judged by a stub) | 5.4 ms a statement | 4.9 s |
| Ergo header check (the store's full child check over a synthetic chain; real headers 8–13 ms for proof of work) | 11.0 ms a header | 7.9 s |
| A restore's capsule scan (foreign capsules) | 0.061 ms a capsule | 4·10⁶ capsules in about 4 minutes (extrapolated) |
| A spend proved on the holder's device (`openV3Prover`) | 3.9 s on one thread, 1.6 s on four; 482 MB peak | per payment |

The phone's daily work is seconds; a restore at 10⁶ statements replays about 1.5 hours (extrapolated) and checks
headers from the backing's anchor (3.2 hours from EIP-37 activation, 6.0 from genesis, extrapolated from these
per-header times). **Aggregation saves a day's bytes and a restore's computation:** verifying a mean day's 900 proofs natively takes
20 s here but downloads about 13 MB; a restore's 10⁶ proofs would take 6.3 hours (four times its proof-free replay)
and 14.7 GB. The unaggregated tail, venue publications and a small scope's daily trail stay cheap to verify natively,
and complete replay remains the fallback when no aggregator serves.

**Limits.** One host and one run of each case; the tree has two levels over four kinds (settle and request leaves
proved alone); bb's in-circuit range and on-curve constraints not read from source; the in-circuit verifier's
agreement with the host is shown on these 14 proofs on pinned leaves, not proved; phone rates are a desktop proxy; the replay's venue answers are in-memory fixtures; no aggregator, frame or reader integration
exists (step 4).

## The trail check set (slice 36)

Measured 2026-10-13 in CI's real-proof group `check-set` ([report](pool-v3-check-set-verification.json), Ubuntu; the
Windows run's in the same CI artifact; [decision](../decisions/2026-10.md#2026-10-13--prove-the-trail-check-sets-six-circuits-on-the-pinned-webassembly-backend-verify-covers-under-pinned-keys-and-take-native-proving-as-the-aggregators-lever-slice-36-next-12)).
Succinct-read §3.2's six circuits in production form, proved on the pinned backend as the package runs it
(WebAssembly, four threads, 4-vCPU runners with 16 GiB), over one genuine statement proof of each proved kind.

| Circuit | Gates | Key derivation | Proof (Ubuntu, Xeon Platinum 8573C) | Proof (Windows, EPYC 9V45) | Process peak |
|---|---:|---:|---:|---:|---:|
| Each trail leaf (five) | 1,652,294–1,652,634 | 23–24 s | 84.5–87.0 s | 50.9–59.7 s | 3,383–4,030 MiB |
| Trail node | 1,469,828 | 17.5 s | 70.1–70.3 s | 42.2–42.6 s | 2,435–3,431 MiB |

*Against the aggregation probe* ([slice 33](#the-trails-proof-aggregation-slice-33), bb's native binary on a 4-vCPU
Xeon at 2.10 GHz, leaves 32.4–34.9 s, node 24.8–29.4 s): WebAssembly proves 1.6 to 2.6 times slower, by runner. A
statement costs a leaf and about one node, 94–155 s, so the design point's mean of 900 a day takes one 4-vCPU
WebAssembly prover 23–39 hours, short of keeping up alone; the native binary, at the probe's rates, kept up 1.6 times.
The word-wise `proofHash` cut each leaf from the probe's 1,832,727 gates (spend) to 1,652,618, and its bytecode from 2.7
MB to 533 KB of base64.

*In the recovery check* (one thread before the review, all four after), a real trail's covers for two issues (two
leaves and a node) took 249.9 s and for its settlement (a leaf) 87.7 s, on the Ubuntu runner; the succinct read
answered and verified exactly those two covers and fetched only the two demands' proofs.

*Memory:* a hostile attempt proves on an instance of its own beside the main one, so its process peaks (4,182–6,008 MiB) count
two instances; one instance proving a leaf peaks at 3,383–4,030 MiB of the whole process, under WebAssembly's 4 GiB per instance with the
verifier lanes and Node beside it.

**Limits.** One run on each system, runners differing 1.7 times; no native or phone measurement here; one genuine
proof per kind.

## The aggregator's native backend (slice 42)

Measured 2026-10-14 by `check-set-check.mjs --native` (CI's real-proof group `native`: [report](pool-v3-check-set-native-verification.json);
[decision](../decisions/2026-10.md#2026-10-14--prove-covers-on-the-native-binary-bbjs-bundles-from-a-private-copy-of-the-checked-points-on-an-instance-replaced-after-any-failure-slice-42-next-12)). The question (Next 12 step 4): does the native `bb` that bb.js 5.2.0
bundles prove the [check set](#the-trail-check-set-slice-36) from the checked points alone, with the pinned keys, and
how much faster than WebAssembly on one host?

**Points.** Native `bb` ignores `srsInitSrs` for proving: it reads G1 points from `$CRS_PATH` (default `~/.bb-crs`)
and, finding none, fetched 2^21 compressed points over plain HTTP from `crs.aztec-cdn.foundation` when it first derived
a key (seen on this host). The file it wrote was byte-equal to the check set's (SHA-256 `2bb84462…`), so a private
directory holding exactly the checked bytes as `bn254_g1.dat` serves it: bb then read that file, wrote only its lock
and fetched nothing. The check holds an empty `CRS_PATH` sentinel that stays empty and asserts each private copy.

**Keys and cases.** All six check-set keys and pool-v3's six derived natively equal the pinned ones; every hostile
case of the WebAssembly check gives the same outcome natively (the same bb assertion where a proof is refused, the same
unverifiable proofs where one is made); a node bb refuses retires the aggregator's process and the next node is made by
a fresh one.

| One 4-vCPU Xeon at 2.10 GHz, 15 GB (this run; CI's runners in the report) | Native | WebAssembly |
|---|---:|---:|
| Leaf, each of five kinds | 30.3–33.6 s | 72.8 s (spend, no other load) |
| Node | 24.7–27.7 s | 60.8 s |
| Peak memory proving a leaf, process and `bb` | 2.8–3.2 GiB | 3.2–3.8 GiB |
| A key derived | 12–26 s | 23–27 s |

| Same-host rate in CI's `native` group (spend leaf; node over two leaves) | Native | WebAssembly |
|---|---:|---:|
| Ubuntu runner, 4-vCPU AMD EPYC 9V74 (the report) | 30.5 s; 26.7 s | 81.7 s; 64.7 s |
| macOS runner, 3-core arm64 | 45.1 s; 48.8 s | 100.3 s; 74.2 s |

**Rate.** Natively a leaf is 2.2–2.7 times faster on x64 (2.2 on the arm64 runner), a node 2.2–2.4 on x64 (1.5 there): a statement (a leaf and about one node) takes about
1 minute against 2.2, so one 4-vCPU prover keeps up with the design point's mean (900 a day in about 15 hours) where
WebAssembly needs about 33. The native leaf is near the [aggregation probe](#the-trails-proof-aggregation-slice-33)'s
(32.4–34.9 s on the same host type), so the production circuits cost what the probe's did natively.

**Limits.** One host here plus CI's runners (Ubuntu, macOS) once each, the macOS runner smaller than the 4-vCPU prover the rates assume; peaks are sampled every 200 ms; the native
binary is bb.js's own build, shown equal only by keys and proofs; a native binary that needs a newer glibc than a host
has is refused by name, not measured.

## The holder's read path in a browser engine (slice 39)

Measured 2026-10-14 in CI's real-proof group `browser` (`scripts/browser/check.mjs --proofs`, run 38549803306; each
system's report is `scratch/browser-proofs.json` in its `pool-v3-reports-<os>` artifact; [decision](../decisions/2026-10.md#2026-10-14--run-the-holders-read-path-in-a-browser-engine-over-bundle-time-substitutes-for-nodes-built-ins-ahead-of-the-native-backend-and-the-exhaustion-half-slice-39-next-12)).
The library's own modules, bundled for a browser (`scripts/browser/build.mjs`), run in a dedicated worker of headless
Chrome 154 on CI's 4-vCPU runners, cross-origin isolated, with Barretenberg as WebAssembly on one thread and the
spend's 2^15 points:

| Phase | Ubuntu | Windows | Engine's measure after it |
|---|---:|---:|---:|
| Start the backend from the parameters | 0.27 s | 0.27 s | 78 MiB |
| Derive and check the six relations' keys against the configuration | 2.5 s | 2.9 s | 100 MiB |
| Verify a genuine proof of each of the five proved kinds | 0.32 s | 0.31 s | 120 MiB |
| Prove a spend (two inputs, four outputs, real capsules) | 3.6 s | 3.5 s | 125 MiB |
| Verify it | 23 ms | 29 ms | 125 MiB |
| Try 4,000 capsules under one seed (a quarter its own) | 0.15 ms each | 0.14 ms each | 125 MiB |

The engine's measure is `performance.measureUserAgentSpecificMemory()`, the page and its workers. The browser's
whole process tree on Linux, sampled every 200 ms, held 1,113 MiB idle and peaked at 1,511 MiB; its resident sizes
count shared pages once in each process, so the difference, about 400 MiB, bounds the check's own share. Over the six
CI runs of the group the spend took 2.9–4.0 s and key derivation 2.0–2.9 s. A tampered proof was refused in each.

*Against slice 33's Node proxy* ([phone-class proxy](#the-trails-proof-aggregation-slice-33), another host): a spend
3.9 s on one thread and a verification 22.7 ms there, so the browser engine costs the proof nothing of note. A capsule
costs 0.11–0.16 ms against 0.061 ms, @noble/ciphers' AES-GCM against OpenSSL's, so a restore's 4·10⁶ capsules at the design
point would take about 7–11 minutes rather than 4 (extrapolated).

*Equivalence:* the substitutes pass `test/browser-host.test.ts` against node:sqlite, node:crypto and node:path; 31
suites (488 tests) pass over them in Node, skipping the 17 kept-file tests by name and the oracle comparisons, which
would compare a substitute with itself there; ten suites run in the browser,
180 tests passing and one (Node's `BB_WASM_PATH`) skipping, as many as Node runs of those files; on a page without
cross-origin isolation Poseidon2 refuses to start, by name.

**Limits.** CI runners, not phones: DevTools' CPU throttling is refused for workers, where every check runs, so no
throttled run stands in for a device, and `check.mjs --serve` is the route to a phone's rates. Memory databases only:
no kept replay or evidence file, no wallet store and no durability in the browser then ([slice 40](#the-holders-files-in-a-browser-engine-slice-40) adds them). One genuine proof per kind;
one spend shape.

## The holder's files in a browser engine (slice 40)

Measured 2026-10-14 in headless Chromium 141 on a 4-vCPU cloud container (Intel Xeon @ 2.10 GHz), `scripts/browser/check.mjs
--files` ([decision](../decisions/2026-10.md#2026-10-14--keep-the-browser-hosts-database-files-on-the-origins-private-file-system-under-the-code-and-write-ahead-logs-node-keeps-slice-40-next-12)).
*Probe:* SQLite's own OPFS pool VFS kept a write-ahead log only under exclusive locking, recovered 1,000 committed rows
after its worker was ended holding an uncheckpointed log, and refused a second worker; the reference's pool
(`src/browser/files.ts`) carries node:fs and SQLite over the same files instead.

*Suites:* the replay-store, evidence-store, wallet and wallet-backup suites and the pool's own cases ran with the pool
mounted: 76 tests passing, the 17 kept-file tests among them, and one skipping (it needs `vi.mock`'s module registry).
Each test left no file named or open; at most 39 members were in use at once (two wallets and an operator journal).

*A crash:* a worker kept a replay file through a walk of 300 records, then appended in a second walk until its
transaction spilled one uncommitted 4,120-byte frame into the log, and was ended. A new worker mounted the pool in
0.10 s and reopened the file through the digest check in 0.05 s, at the keep point's tip; a third worker's mount, and
the second of two racing on a new pool, were refused (EBUSY).

| On one host | Browser (OPFS) | Node (disk) |
|---|---:|---:|
| Append 300 records in a kept walk | 1.07 s | 0.90–1.02 s |
| Its keep point (digest, log moved in) | 24 ms | 13–15 ms |
| Reopen through the digest check | 51 ms | 6–7 ms |

The records' own work dominates; the browser's files add little to a walk. **Limits.** Chromium only; ending a worker
loses no write the browser accepted, so no run stands in for a device's power loss (the torn-header and stopped-rename
cases are simulated); one run per figure.

## The wallet's flows in a browser engine (slice 41)

Measured 2026-10-14 in headless Chromium 141 on a 4-vCPU cloud container (Intel Xeon @ 2.10 GHz), `scripts/browser/check.mjs
--wallet` ([decision](../decisions/2026-10.md#2026-10-14--run-the-wallet-commands-in-a-browser-engine-one-command-a-worker-over-its-file-pool-and-take-a-wrapped-app-as-the-holders-route-slice-41-next-12)); CI's
`browser` group repeats it on Ubuntu and Windows (`scratch/browser-wallet.json` in each `pool-v3-reports-<os>` artifact).
A holder's `moe wallet` commands ran in the page's workers, one a worker over the origin's file pool, against an
operator, a backer and a shop running `moe` as processes over the synthetic node; every flow passed (init, request,
receive, pay with a proof made in the browser, restore from the seed) with its refusals by name (`REQUEST`, `BUSY`,
`PROXY`).

| Command, same host | Browser worker | Node process |
|---|---:|---:|
| `init` (parameters copied, venue context kept) | 5.2 s | 4.3 s |
| `request` | 4.2–4.3 s | 4.0 s |
| `fulfill` | 4.1–4.7 s | 4.6–4.8 s |
| A spend proved (browser `pay`, with its submission; Node, the backer's `issue`) | 9.0 s | 6.3 s |
| `terms add`, `service add` (no verifier) | 0.7–0.8 s | 0.5 s |

A command that verifies starts the verifier and derives the relations' keys, about 3.5 s of each under both hosts
([slice 39](#the-holders-read-path-in-a-browser-engine-slice-39)), so the browser adds little to a command. The
browser's process tree peaked at 1.2–1.9 GiB over the three runs. Headless Chromium refused persistent
storage (`persist()` false). **Limits.** Three runs on one host; Chromium only; the worker reaches the loopback parties
through the check's server, standing in for an app's native transport; no device.

## The throttled phone estimate (slice 46)

Measured 2026-10-18 on a 4-vCPU cloud container (Intel Xeon @ 2.10 GHz), headless Chromium 141, `scripts/browser/throttle.mjs`
at `32d4ceb` ([report](phone-throttle-estimate.json), which binds the relations' and check set's programs and the
checks by hash; [decision](../decisions/2026-10.md#2026-10-18--estimate-the-phone-holders-budgets-on-a-throttled-core-a-days-sync-breaks-even-near-17-times-this-hosts-thread-a-restore-22-pay-31-and-the-wallet-browser-at-its-memory-budget-slice-46-next-12)).
**Simulated, not a phone.** The browser's whole process tree ran on one core under a CFS quota of 1/s of it (100 ms
periods) and a 1 GiB memory cap, the harness and the parties it starts (synthetic node, operator, backer, shop) on the
other three; every holder workload runs on one thread, so the quota stands in for a core s times slower than this
host's. `check.mjs --proofs`, `--rates` (new: the journal's package of one issue and 300 spends replayed proof-free,
succinct reading's digests, 300 headers through the store's full check) and `--wallet` ran once at each s.

| Workload, one thread | s = 1 | 1.5 | 2 | 3 | 4 | 6 |
|---|---:|---:|---:|---:|---:|---:|
| Proof-free replay, a statement | 7.8 ms | 11.2 | 15.8 | 22.5 | 29.9 | 60.5 |
| Digests, a statement | 0.61 ms | 0.82 | 1.07 | 1.70 | 2.35 | 4.97 |
| Ergo header, full check | 10.4 ms | 17.2 | 26.3 | 40.3 | 42.7 | 68.7 |
| Capsule tried | 0.21 ms | 0.35 | 0.49 | 0.73 | 1.02 | 2.05 |
| A spend proved | 4.6 s | 7.1 | 9.5 | 14.2 | 19.7 | 30.9 |
| `request` (verifier started, keys derived) | OOM | 6.4 s | 8.7 | 14.2 | 18.9 | 31.0 |
| `pay` with its proof and submission | OOM | 13.8 s | 18.4 | 29.2 | 37.7 | 58.2 |
| `fulfill` | OOM | 7.6 s | 9.3 | 14.5 | 19.2 | 30.2 |

Times grow faster than s at deep quotas (replay at s = 6 is 7.7 times its s = 1 time): the browser's other processes
share the core and the quota's periods, so the deep points overstate a slower core, and crossings are interpolated
between measured points. Against the budgets ([Phone holder](PRODUCTION_REQUIREMENTS.md#target-scale-and-budgets)),
the day and the restore are arithmetic over these rates (a mean day 900 statements, 720 headers, 3,650 capsules and
one cover root verified; a peak day 10⁴ statements and 4·10⁴ capsules; a restore 10⁶ statements, 7.9·10⁵ headers and
4·10⁶ capsules), the commands measured:

| Budget | s = 1 | Holds to | Break-even slowdown |
|---|---:|---:|---:|
| A mean day's sync ≤ 30 s | 15.9 s | 1.5 | 1.7 |
| A peak day's sync ≤ 3 min | 100 s | 1.5 | 1.8 |
| A seed restore ≤ 12 h | 4.9 h | 2 | 2.2 |
| `pay` ≤ 30 s | 13.8 s at 1.5 | 3 | 3.1 |
| `request`, `fulfill` ≤ 30 s | 6.4, 7.6 s at 1.5 | 4 | 5.8, 6.0 |
| A mean day's CPU ≤ 2 min | 15.9 s | 6 | about 6 (extrapolated) |

An earlier run at `d4fe0d4` (same programs and checks but for reporting) gave the same break-evens within 0.1. At
s = 1 the day and the restore split about evenly between headers (720 × 10.4 ms, 47% of a mean day; 2.3 h of a
restore) and replay with digests (48%; 2.3 h); capsules take the rest. A header's cost is Autolykos v2's hit: 33 Blake2b-256
hashes over the 8 KiB table message M and four short ones, in JavaScript (`src/ergo-headers.ts`).

*Memory.* `--proofs` and `--rates` peak at 305–332 MiB of the group's anonymous memory at every s. The wallet drill
peaks at 876–985 MiB for s ≥ 1.5, against the 1,024 MiB cap, and at s = 1 its page was killed by the cap during the
restore step in two of three runs (this one and `d4fe0d4`'s; a trial run passed). Uncapped and unthrottled it peaked
at 1,112 and 1,161 MiB (two runs, not retained): the page's renderer 863–974 MiB, the browser, GPU and service
processes about 190 MiB. The renderer grows over the drill's 24 commands, each a worker ended after it answers (316 MiB
after the first, 974 before the last, with partial drops); whether ended workers' memory returns later or is held is
not yet known (WORK.md Next 4 (cq)).

*Against the direction's proxy* (desktop rates in one Node thread, [slice 33](#the-trails-proof-aggregation-slice-33)):
replay costs 7.8 ms in the browser against 5.4 in Node, a capsule 0.21 ms against 0.061 (@noble/ciphers' AES-GCM
against OpenSSL's), so the break-evens are lower than the declared ones (a mean day 2.3, a peak day 2.6, the restore
3.0, `pay` 3.3, a mean day's CPU 9).

**Limits.** A throttled Xeon core is not an ARM core, whose ratio differs by workload; one run per point; Chromium on
Linux, not Android's WebView; the counterparties are unthrottled loopback processes; a day and a restore are sums of
rates, not a measured day (a day's weight depends on mainnet blocks: slice 45's decision); the cgroup's anonymous
memory counts each page once, close to the processes' summed PSS, while Android's PSS also shares file pages. A device
runs every check through `check.mjs --connect` (WORK.md Open questions).

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

## The onion routes on the live Tor network

The holders' transport (slice 12 M12a–c) was drilled with fixture proxies; this run puts the operator's holders'
listener, an M12b replica and an M12c relay behind real onion names on the Tor network (2026-10-09, at `fdbe829`,
Tor 0.4.9.13 from the signature-checked Expert Bundle, on one laptop). It ran a cut-down lit
command drill on the synthetic node: a service-side tor with four onion services (one with nothing listening) and a
client-side tor whose `HTTPTunnelPort` every holder process reached with `NODE_USE_ENV_PROXY=1`, a credential of its
own and the node direct (`NO_PROXY`). A guard found no holder connection anywhere else. One run of four completed
every step; the others stopped early, two at drill bugs and one at a submit timeout through Tor.

- **Each role works through Tor.** Syncs read evidence the operator served, and issue, pay, demand and accept
  completed. A reader holding only the replica read it final, and with the operator stopped a wallet's sync fell to the
  replica in 14 s. `relay send` refused a wrong token (`UNAUTHORIZED`), answered pending, then final, and an exact
  resend returned the same transaction.
- **Latency** (time to Tor's CONNECT answer): on a circuit already built, median 1.2 s (max 2.2 s, 20 samples); on a
  new circuit with the descriptor cached, median 4.1 s (max 19.2 s, 20); first contact, median 3.9 s after a new
  identity (max 5.6 s, 15) and 4.5–25.3 s from a fresh client (3), with one 120 s gateway timeout in each case. A steady
  `wallet sync` took a median 9.5 s through Tor against 5.3 s through the fixture proxy (16 and 15 samples, on a
  loaded host where a local status read took 3.8 s).
- **Isolation by credential holds for onion streams:** two streams under one credential shared a rendezvous circuit,
  and a third under another credential took its own (the control port's circuit list, two runs). Each `moe` process,
  with its own credential, got its own circuit.
- **Tor refuses internal addresses** (`403 Forbidden (private address)` for loopback, `localhost`, `[::1]`, 10.0.0.1 and
  192.168.1.1, in 1–4 ms), and answers an onion's failures with 500 (backend refused), 503 (name not published) or 504
  (timeout), in eight failures none the 502 the fixture proxy sends; `moe` reads each as `UNAVAILABLE`.

*Findings* (WORK.md Next 4 (bj)): the service client's one 10 s bound per exchange includes Tor's circuit setup,
which took up to 25 s. A first-contact sync failed `UNAVAILABLE`, a submit failed `UNAVAILABLE` with its record saved for a rerun, and two steady
syncs exited 0 on kept evidence while the operator was up; an agent gets a stale answer it cannot tell from a fresh
one but by the evidence field. Node's `fetch` drops a proxy's refusal status, so a holder file naming an internal
address reads as an operator that did not answer, not as Tor's refusal. Both fixed
([decision](../decisions/2026-10.md#2026-10-12--give-an-onion-exchange-time-for-tors-circuit-and-name-a-proxys-refusal-of-a-tunnel-next-4-bj)):
an onion exchange's response may begin 50 s later, and a proxy's refusal to tunnel an internal address refuses as `PROXY`.

*Limits:* one host, one Tor release, a few samples per case on a loaded laptop; the synthetic chain and lit
backings, so no real proofs crossed Tor; latency to an onion service on another network was not measured.
