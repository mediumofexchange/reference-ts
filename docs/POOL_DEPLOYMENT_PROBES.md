# Pool deployment probes

These are provisional experiments to inform v3, authorized after the
[design-review check](../decisions/archive/2026-09-08-whole-project-design-review-check.md).
They do not change the construction or declare a production release usable.
Production rules still land in the specification and adversarial model first.

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

The target phone and practical latency/memory/network budgets have not yet been
selected. The benchmark below supplies a baseline, not a pass against an
unstated budget. A one-backer deployment does not remove general independent
replacement rights from the protocol.

## Browser proof baseline

Use Node 24 for the tooling. Vite 7.3.6 is an explicit development dependency,
already present in the lockfile before this probe; no new runtime dependency
is added to the library. Its development-server Node requirement is narrower
than the library's Node 20 minimum.

```powershell
npm run bench:pool:prepare
npm run bench:pool:browser
```

Open `http://127.0.0.1:4173/`, record the device/browser, run the benchmark and
download the JSON. The server is loopback-only and serves synthetic benchmark
assets and development modules. For an Android device with USB debugging and
`adb` already configured, `adb reverse tcp:4173 tcp:4173` makes that same URL
reachable on the phone without exposing the repository to the LAN. Reverse
forwarding is transport only; it does not emulate phone hardware on desktop.

Preparation reuses `scripts/pool/compile.mjs` and the existing synthetic
fixtures. It verifies source, bytecode and key identities against the v2
manifest, requires the cached parameters recorded in
`docs/pool-v2-verification.json`, and publishes the completion manifest only
after the assets exist. A failed preparation invalidates that marker. Scratch
compiler files are removed on ordinary completion/failure; interrupted runs
may leave disposable compiler directories in `scratch/`. No parameters are
silently fetched by preparation or by the browser probe.

The browser exercises only spend, with one worker and the pinned
`noir-recursive` ZK target. It verifies the locally derived spend key, the
public-input order and values, proof bounds and all nine generated proofs.
There are three raw samples for each of: one real input plus padding, two
same-backing inputs, and two different backings. No warmup sample is discarded.

The recorded [first browser result](pool-browser-verification.json) is Windows
desktop Chromium 152. All nine proofs verified. Proving ranged from 4.28 to
6.29 seconds for same-backing cases and 6.79 to 9.30 seconds for mixed backings;
verification ranged from 91 to 195 ms. Every proof was 14,656 bytes. The entire
run, including initialization, took about 61.6 seconds. This is a small local
sample, not a throughput estimate or an isolated hardware comparison with the
earlier Node run. The result records the probe source hashes used for the run.

Limitations:

- This is not a cold device: code, WASM and operating-system caches may be warm.
  Asset requests bypass HTTP cache; parameter fetch and initialization are timed.
- Window JS heap sampling excludes worker/WASM allocations. Whole-browser peak
  memory is explicitly unknown. Do not compare the sampled value to a phone's
  memory budget or the old Node process RSS.
- Window resource entries exclude worker fetches and are not total network cost.
- The parameter hashes identify the local files; they do not authenticate the
  trusted setup or establish reproducible dependency builds.
- The synthetic proof inputs do not measure a wallet, restoration, note-tree
  resync, encrypted delivery, publication fees, or witnessed payment latency.

## Delivery and seed restoration

F3 selects receiver-prepared exact output requests under
[pool-delivery C4.1–8](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md).
A receiver derives the requested note from its seed and a fresh durable request
identifier and encrypts the identifier/backing/value to itself. The payer
copies the exact opening and opaque capsule. There is no stable public scan
key, new ownership algebra or payer-to-recipient key agreement. Arbitrary
unsolicited amounts require a new receiver request; pending invoices and
accounting labels still need a backup.

The capsule library is candidate runtime code in
[`src/pool/v3/capsules.ts`](../src/pool/v3/capsules.ts); the delivery digest
is the record codec's. `npm test` checks the recorded profile-1 vector byte
for byte, deterministic retries, key separation, u64 and width bounds,
malformed/context-swapped/tampered capsules, authenticated wrong-commitment
plaintext, the ordered delivery vector, the settlement owner secret and an
independent WebCrypto envelope. With Node 24, `npm run check:pool:delivery`
adds the real proof binding and restoration from signed local evidence below;
CI runs it on Linux and Windows beside the pinned v2 proof checks.

The first probe (retired at slice 1 M1; its
[recorded result](pool-delivery-verification.json) and sources are at
[17a9f1e](https://github.com/mediumofexchange/reference-ts/tree/17a9f1e/scripts/pool/delivery))
restored notes in a fresh process from a seed and a prevalidated synthetic
view: public outputs and capsules, spent nullifiers and lit settlements, with
no request journal, payer secrets or operator callbacks. It kept unresolved
coverage, separated force-created outputs awaiting adoption and generated a
fresh request after journal loss. Restoration from exact signed evidence and
the local replay's receivers now cover that path over authenticated bytes.

Every capsule is 89 bytes. One aggregate digest adds two public field
encodings, 64 bytes per issue/spend/burn before record framing: 242 extra
bytes for two outputs, 331 for three. A real candidate spend with those two
public `u128` limbs uses 19,050 gates versus 19,034 (+16); its subgroup
remains 32,768 and proof remains 14,656 bytes. Mutating either limb rejects
the original proof. Changing only the compiler ABI metadata to `Field`
still rejects `2^128` in either limb over unchanged ACIR, establishing an
actual circuit range constraint. This is a spend-binding measurement, not
an already measured final v3 issue/spend/burn suite.

The retired probe recorded, on this Windows desktop (Node 24.6.0, i7-5500U),
that 1,000 / 10,000 / 100,000 failed capsule opens took 79 ms / 738 ms / 12.36 s. These samples repeat one
foreign envelope while deriving its subkey each time; they measure trial
cryptography, not traversal of distinct history records. Existing commitment
plus nullifier hashing averaged 2.11 ms per pair over 250 samples, excluding
owner derivation and the rest of successful recovery. The candidate spend
proved in 4.38 s and verified in 92 ms. These are single local samples, not
phone budgets or throughput guarantees.

The production wallet must consume independently authenticated complete
public packages, retain full evidence before payer/operator disappearance, and
construct certified paths. Seed recovery does not discover unknown
venues/backings, prove a complete balance or guarantee permanent availability.
Device and full-history replay costs remain additional gates.

### Restoration from exact local evidence

`npm run check:pool:restoration` connects the existing capsule scanner to the
canonical v3 served-trail, record, snapshot and header codecs. It also runs in
`check:pool:delivery`, including Linux/Windows CI. The
[retained result](pool-restoration-evidence-verification.json) pins the sources.

A fresh child receives only a synthetic seed, an independently selected fixture
identity and public package bytes. It verifies the operator signature, complete
single-entry directory, snapshot preimage, segment context and ordered local
evidence chain before scanning bound capsules. Output commitments and spent
nullifiers come from those records, never a separately supplied replica list.
No request journal, payer secrets or original operator callbacks enter the child.
The fixture issues 10, pays 7 with change 3, then pays 5 with receiver change 2.
Restoration finds the appropriate change and filters spent, zero and foreign
outputs. A separate burn case exercises its nullifier/change layout.

An old package yields historical candidates only when explicitly selected as
historical. Against the current independently supplied fixture selection it
refuses, including a validly signed alternative at the same sequence. Missing
records/capsules, reordering, substitution and lost source copies are exercised.
Current or stale request journals cannot override the public evidence: the IPC
rejects journal fields. A retained independent copy restores the same candidates.
Resource refusal is distinct from unresolved evidence; neither is operator fault.

**These are candidate notes, never permission to spend.** The judging index and
checkpoint selection are test inputs, not authenticated venue ranges. Proofs,
history roots, backing terms and authority are synthetic; successful local
authentication deliberately also accepts signed invalid totals and does not
validate term signatures. All results retain unresolved coverage, no complete
balance or full-finality claim, and `spendable=false`. The experiment supports
one backing and one segment with an empty opening; imports and recovery records
refuse. Complete replay, independently authenticated current ranges, certified
paths, durable invoice restoration and network retention remain dependencies
for the end-to-end restoration target. No v2 bytes, circuits, keys or runtime
APIs change, and no v3 configuration is adopted.

### Conditional initial-segment replay

`npm run check:pool:local-replay` runs real successor issue, spend and burn
proofs through an independent reader of one empty-opening segment. The command
also runs in the Linux/Windows v3 CI job. This extends local evidence scanning
with state checks; it does not adopt a v3 configuration or reinterpret v2.
The [retained report](pool-v3-local-replay-verification.json) records source,
bytecode/key hashes, real-proof checks and the resulting public audit.

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
no range. A venue profile and authenticated chain evidence behind such answers
remain unimplemented; the fixture record is a trust input, not a venue.

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
above, and the separate local-only restoration scanner still refuses imports.

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
The same checkpoint/event budgets bound visited commitments and replay/merge
operations, causal frontier construction, conflict comparisons and clock scans;
existing byte, item and range bounds also apply. Multi-scope range
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
receipt plus package framing and reuses the replay's work budgets.

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
The count uses the shared replay work budget and retains the same conditional
fixture boundary as the other audit fields.

The complete public-package boundary still requires the following inputs and
checks. This table separates what this experiment establishes from prerequisites
that a production reader must establish before returning spendable holdings.

| Boundary | Experiment evidence | Still required |
|---|---|---|
| Construction and key routing | Exact configuration preimage and candidate domain; all six independently pinned source/toolchain/bytecode/key identities and fixed helper/bounds/profile | Approved configuration/artifact identities after full adoption prerequisites; setup provenance and deployment qualification |
| Backing and scope authority | Canonical signed constant-root terms/name, configuration/venue matching and per-backing issuance keys; header-derived scope root; fixture replacement/reappointment links and revocation checked across each complete scope | A venue profile and authenticated evidence behind the fixture answers |
| Local state | Issue/spend/burn across deduplicated shared ancestry and every scoped snapshot, with per-backing totals, shared spent state and original-tree paths; single-backing demand/withdraw/settle and locks | Multi-backing recovery and runtime integration |
| Witness and continuity | Exact fixture-selected signed checkpoint held in §13 answers; whole-scope classification, last-valid continuity and split/rejoin imports; multi-backing publication force and exact ordered adoption; complete-scope receipts and independent backing non-service counts | A selected venue profile and authenticated chain evidence; runtime integration |
| Wallet restoration | Seed-only capsule and lit-settlement openings with local or imported-tree paths; independent seedless public audit | Full current state and certified anchors, independent retention and venue/backing discovery; pending invoices still need backup |

The candidate manifest, checkpoint selection and the fixture venue evidence
remain explicit **test fixture assumptions**. Signed terms establish identity,
and configuration checks bind the candidate keys; neither establishes adoption
or the force of those terms. `candidateConfigurationChecked` and
`signedTermsAuthenticated` report only those narrower successful checks.
`currentRangeAuthenticated` and `termsAuthorityAuthenticated` are true only
under the selected verifier: `rangeEvidence: "fixture-verifier"` names the
harness's fixture record, while `"candidate-ergo-profile-synthetic-headers"`
names exact transaction decoding and checked roots against independently chosen
synthetic headers. Neither authenticates a real chain; a historical read leaves
currency false. `npm run check:pool:ergo-replay` runs the optional
[Ergo adapter](ERGO_VENUE_PROFILE.md#local-replay-adapter) through the same
import/payment/burn trace, including fresh readers and hostile evidence.
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

Run the retained comparison and hostile checks with Node 24:

```powershell
npm run check:pool:fees
```

[Probe sources](../scripts/pool/fees/) generate candidates from the pinned v2
spend; [recorded evidence](pool-fees-verification.json) pins their identities,
inputs and measurement scope; it is historical, recorded at
[fcf532c](https://github.com/mediumofexchange/reference-ts/tree/fcf532c) before the
capsule library moved into `src/pool/v3/`. Generated sources/builds/reports stay in
`scratch/pool-fees/`. CI runs this command on Linux and Windows.

F4 selects two input/four output positions for successor spend, under
[pool-fees C1.2.3–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md).
A payment of 73 A from 100 A and a fee of 2 B from 10 B fit in one statement:
73 A to the receiver, 27 A change, 2 B to the fee recipient and 8 B change.
Each recipient controls its output through an exact F3 request. Every output
uses the same commitment, scope and per-backing conservation rules; no fee
position, asset, debit authority, public amount or new statement kind exists.
Same-backing fees and sponsored service pad the unused positions with the
payer's distinct zero-value notes and capsules.

Three positions fit same-backing payment/change/fee and can use another fee
backing if its input already has the exact amount. Four also returns both
changes without a preparation transfer. Separate fee/payment statements have
separate admission/finality; putting their submissions beside each other does
not provide atomicity. Adding a batch would need a new receipt/replay/finality
contract for behavior one ordinary spend already supplies.

| Spend candidate | Gates | Subgroup | Public inputs |
|---|---:|---:|---:|
| Pinned v2, 2x2 | 19,034 | 32,768 | 11 |
| F3 delivery, 2x2 | 19,050 | 32,768 | 13 |
| F4 comparison, 2x3 | 19,256 | 32,768 | 14 |
| Selected F4, 2x4 | 19,465 | 32,768 | 15 |

Four costs 209 gates over three (about 1.1%), a 32-byte commitment, 89-byte
capsule, one leaf and one recovery trial on every spend, including padding.
That is 121 extra statement bytes versus another roughly 15 KB proof-bearing
preparation record when needed. It also increases output storage/scanning
positions by one third; no frequency or device budget is assumed. All four
capsules plus the two public digest encodings cost 420 bytes before framing.
Inputs, note formulas, issue's one output and burn's one change remain fixed.

All five real proofs are 14,656 bytes. The selected 2x4 flow and a total of
`2^64` with individually bounded inputs both prove. Seventeen positive host
checks and 35 rejection cases cover every added output, all duplicate pairs,
per-backing conservation even when aggregate value matches, and exact capsule
association. Host-ABI bypasses leave ACIR unchanged and still reject `2^64`
in each added output and `2^128` in either delivery limb. Mutating any
commitment or digest limb rejects its original proof. These tests do not
infer hidden-value range constraints from ABI serialization alone.

On the recorded single-threaded Node 24 desktop run, the selected fee/change
proof took 4.22 s to prove and 92 ms to verify; its widened-sum boundary took
5.78 s and 132 ms. These are individual feasibility measurements, not a
timing distribution or a phone/deployment budget.

The fee recipient knows its fee opening and statement association. When the
flow guarantees the same backing, this reveals the payment backing; a quoted
fee independent of payment size avoids disclosing size through a fee formula.
Another fee backing reduces that inference only where scope and other leaks
leave actual alternatives. Sponsored service avoids direct-fee disclosure.
Fees have ordinary pending-local-root, finality, lapse and recovery treatment;
exact retry returns its existing receipt before applying a changed price.
Changing an exposed fee requires a newly authorized transfer after verified
lapse and canonical unspentness, not an implicit rewrite or cancellation.

Private fee policy is outside public validity. A fee-free admitted statement
remains valid on replay. Unpaid/declined quotes do not clear non-service counts
or gate the public remedies: the holding request proves no fee agreement.
Backer/sponsor funding remains a practical service choice, including for the
unchanged issue/burn/recovery shapes. Pool fees do not fund venue currency
publication costs automatically.

The probe compares generated circuits and receiver-prepared output evidence.
It does not implement v3 admission, a quote transport, durable wallet pricing,
public-history authentication or actual publication. Those are integration
and deployment gates, not consequences of choosing an arity.

## Spent-set replay

A22 selects [the successor spent-root contract](https://github.com/mediumofexchange/money-from-first-principles/blob/78f8a8c/pool-spent.md):
a canonical compressed binary tree with full-key leaves and absolute split
positions. [`src/pool/v3/spent-set.ts`](../src/pool/v3/spent-set.ts) holds the
candidate and `test/pool-v3-spent-set.test.ts` an independent batch oracle;
no v2 code, root, proof or configuration changes. `npm test` runs the checks
in Linux Node 20/24 and Windows Node 24 CI.

Ten check groups cover empty/singleton frames, all 120 insertion orders of a
five-key boundary set, every prefix under four orders, every split position
and a hostile 256-branch path, skipped prefixes, field boundaries,
non-membership capability, imported-set grouping, duplicates, malformed
typed arrays and input/output aliasing. Imported event/conflict validation
and atomic multi-nullifier statement updates remain runtime obligations;
the probe only accumulates an already validated set. The path algebra proves
the retained non-membership capability, without selecting a published proof
format or parser.

Run `npm run bench:pool:spent` to regenerate
`scratch/pool-spent-set/report.json`. The
[recorded report](pool-spent-verification.json) pins the specification and
LF-normalized source hashes, environment and deterministic roots; it is
historical, recorded at [c955798](https://github.com/mediumofexchange/reference-ts/tree/c955798)
before the candidate moved into `src/pool/v3/`. Both shapes
use the same SHA-256 library, and the harness reads the root after **every
insert**, including v2's lazy singleton hashing. Sizes are 128, 1,024, 8,192
and 100,000 keys, with one measured run after a 128-key warmup; a reversed
candidate replay checks the final root at every size. No timing threshold
determines a pass. This measures accumulator replay, excluding proof checks,
history bytes, import validation and transport; it is not end-to-end replay,
memory-in-bytes, mobile or deployment evidence.

The retained 100,000-key comparison took 157.29 s for v2 and 15.80 s
for the candidate (9.96×), with 1,649,737 candidate hashes, or 16.50 per
insert. Reverse candidate replay took 10.14 s; timings vary with the
machine and load. An insertion needs at most one leaf hash and 256 branch
hashes even for hostile keys, while uniform-key path lengths are approximately
logarithmic. The selected representation stores N leaves and N−1 branches
for N > 0. This closes the A22 shape decision, not v3 runtime integration.

## Replay and retention cost

Recovery map A13 asks what the redemption reader's full replay (C2b.3.3) and
the operator's exact-byte retention cost. `node scripts/pool/v3/replay-cost.mjs
--out docs/pool-replay-cost-verification.json` replays synthetic single-backing
segments (one issue, then spends with fresh nullifiers and four outputs) through
the conditional local replay, with a checkpoint every K events and the last one
selected. A counting stub stands in for proof verification; the
[conformance report](pool-v3-conformance-verification.json) supplies real
single-thread verification times. The
[recorded report](pool-replay-cost-verification.json) binds LF-normalized source
hashes, environment and every case; it is historical, recorded at
[6c6a80a](https://github.com/mediumofexchange/reference-ts/tree/6c6a80a), and its bound sources have since moved.

The first run found the local replay classifying each carrying checkpoint by
replaying its whole trail from position 1: 60 events with a checkpoint every
10 verified 210 proofs (17.3 s with the stub), and 1,024 events every 64 would
verify 8,704. Pool-v3 §7.1 already makes this unnecessary. A trail that
reproduces the last valid checkpoint's evidence hash at its length carries that
checkpoint's exact statement, proof and authorization bytes. The replay now
resumes from a copy of that checkpoint's replayed state when the replay context
is the same: domain, backing, segment, issuers, imports, adopted block, opening
index, verifier and receipt context. Otherwise it replays in full, so verdicts
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
against 0.43 ms, an untaken lever. The spent set costs 0.16 ms per two
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
walk's event budget now charges each replayed position once, so a resumed
checkpoint costs only its new positions. Limits: one
synthetic shape with empty-root anchors and no imports, scopes, demands or
publications; stub verification; one desktop, one run per case; no device
budget.

## Invalid-checkpoint evidence

`model/pool-fault-boundary.test.ts` contains nine cases using the existing
authority/recovery models. The valid control finalizes the same public suffix
that a forged ideal proof causes to fail. In the hostile case both scope
backings lose readable snapshot, count and descent; independently replacing
their operator does not make the invalid predecessor importable.

Invalid publications at indices 4, 8, 12 and 16 keep resetting a five-index
clock. At 22 the gap is open, but the snapshot still cannot be read. Even an
ideal snapshot-only skipping reader cannot fix the clock or descent; the
count reads the snapshot's state (C2b.5.2), so it follows the skip.
Corrupt and withheld replica evidence never restore the consumed payer note
from an older checkpoint. These are concrete failures of conditional progress,
not demonstrations that the finalized payment has been reversed.

The model uses ideal signed objects and proof tokens. It does not implement a
fault-certificate byte format or prove that an interior history event can be
authenticated cheaply. The proposed remedy must establish those facts and
must also explain delayed fault evidence, a prior valid prefix, recovery
publications at their own index, and descendant adoption.

The [fault-recovery proposal](POOL_FAULT_RECOVERY.md) compares intrinsic
exclusion, prospective fault publication and venue-side validation, and
records what `model/pool-fault.ts` shows for the intrinsic candidate; no
candidate has been selected as a normative rule.

## Venue publication sizes, offline

An offline probe under `scratch/ergo-publication/` (Fleet SDK `@fleet-sdk/core`
0.12.0 and `@fleet-sdk/serializer` 0.11.0, no node contacted, nothing signed)
verified the venue constants against upstream source and measured serialized
sizes. At ergo `v6.1.5` with sigmastate-interpreter `v6.0.6`: `MaxBoxSize` is
4,096 bytes and `MinValuePerByte` defaults to 360 nanoERG, both checked against
the full box bytes including the 32-byte transaction id and index; the mempool
`maxTransactionSize` is 98,304 bytes. With one payload chunk per box in `R4` and
a 36-byte object header in `R5`, the largest chunk that fits a box is 3,978
bytes. A 20,000-byte release publication (the 14,656-byte proof plus about
5,000 bytes of statement, signatures, acceptance and two non-membership proofs)
needs 6 outputs in a 20,724-byte transaction carrying at least 0.00745 ERG at
the minimum value per byte, plus the conventional 0.0011 ERG fee; a release and
a demand together (35,000 bytes) need 9 outputs and 35,980 bytes. The
non-membership proofs left the release on 2026-09-09 (C3.6), so a release is
now about 15.5 KB in four chunks; the chunking arithmetic above is unchanged
and still bounds the larger case. Every case is
well under the mempool limit. Not established here: node acceptance, a real
signature, fee policy, the votable parameter's current value, reassembly and
authentication of chunks against forged or reordered boxes, and retrieval
after the boxes are spent. The probe's script, notes and JSON stay in
`scratch/` and are reproducible with `npm install` there. The signed sizes
under the candidate profile's layout and the reassembly cases are now in the
[publication experiment](#venue-publication-and-reassembly-on-a-node).

## Full-block commitment feasibility

The private [offline experiment](../experiments/ergo-range/README.md) checks
complete block transaction commitments before choosing an A8/A9 range source.
Run it on Node 24 with `npm run check:ergo:range` after the experiment's
separate pinned install. CI runs it on Linux and Windows. It adds no library
runtime dependency or exported verification API.

The source baseline matches the publication probe: Ergo node v6.1.5 at
[`c364664`](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/history/BlockTransactions.scala),
sigma-state v6.0.6 at
[`ab0b15c`](https://github.com/ergoplatform/sigmastate-interpreter/blob/ab0b15ceb9d34f2ccd6e68e3e2a8aa27cd16a042/data/shared/src/main/scala/org/ergoplatform/ErgoLikeTransaction.scala),
and its scrypto v3.1.1 dependency at
[`70b3610`](https://github.com/ergoplatform/scrypto/blob/70b36102b2ed8f7a443cfc92f9f135665d777a37/shared/src/main/scala/scorex/crypto/authds/merkle/MerkleTree.scala).
Fleet serializer 0.11.0 is pinned to
[`7d06847`](https://github.com/fleet-sdk/fleet/blob/7d06847afea124c5fdc71c0e8d813db0a1791978/packages/serializer/src/serializers/transactionSerializer.ts)
and npm integrity hashes in the experiment lockfile. These are selected
research baselines, not a claim to cover every node or future block version.

Transaction IDs hash the canonical transaction with empty spending proofs.
For block version 1, Merkle leaves are the transaction IDs alone. Later
versions in the node use all transaction IDs followed by all witness IDs.
Each witness ID is Blake2b-256 of the concatenated input proof bytes with its
first byte removed: 31 bytes, as fixed by
[the node transaction implementation](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/mempool/ErgoTransaction.scala).
The leaves are neither pairs nor interleaved. Merkle leaf/internal prefixes
are 0/1; a missing right sibling contributes zero bytes, and a single leaf
still has an internal parent. The
[node types](https://github.com/ergoplatform/scrypto/blob/70b36102b2ed8f7a443cfc92f9f135665d777a37/shared/src/main/scala/scorex/crypto/authds/merkle/Node.scala)
fix those details. Secondary discovery material described a conflicting
paired-leaf construction; the probe follows the pinned source instead.

The retained [result](ergo-range-verification.json) has 414 passing assertions:
four public mainnet block fixtures at heights 100000, 1000000, 1500000 and
1876512, versions 1/3/3/4, 29 transactions and 77 outputs. Their raw JSON
totals 191,382 bytes; reconstructed signed transactions total 19,380 bytes,
excluding block section framing. The fixture manifest records source URLs and
SHA-256 pins. These blocks are separated in height and were acquired from a
public node; their headers have not been independently authenticated (the
version-4 block, added 2026-09-22, agrees on every header field with the two
nodes of [the P4 cache](#real-chain-exhaustion-cost-from-a-real-anchor)). No
network request is needed to repeat the checks.

All 29 computed transaction IDs and all four roots match the fixtures.
Controls remove and duplicate every transaction, swap adjacent transactions,
mutate every output value and input-proof evidence, and check competing root
algorithms. Version 1 explicitly retains the same root after proof mutation.
Node 24's JSON source-text reviver retains amounts above JavaScript's exact
integer range without rounding.

**Parser result:** only 13 of 29 transactions round-trip through Fleet's
decoder. The other 16 fail on valid fixture scripts without a size flag;
every sampled block contains at least one such transaction. Expected failure
positions and messages are pinned so new failures cannot count as success.
A small counterexample moves one creation-height byte into a claimed raw
ErgoTree field: two different JSON field assignments serialize to identical
unsigned bytes and transaction IDs. Thus serializing arbitrary node JSON and
checking its root cannot authenticate the claimed output fields. Separate
finite controls show a short byte read advances past the buffer and an empty
integer read returns zero. The
[SDK reader](https://github.com/fleet-sdk/fleet/blob/7d06847afea124c5fdc71c0e8d813db0a1791978/packages/serializer/src/coders/sigmaByteReader.ts)
also allocates arrays from decoded counts. The probe only decodes hash-pinned
fixtures; it is not a safe parser for hostile bytes.

The next source gate is a complete, bounded canonical transaction decoder,
then a contiguous-range reader against externally authenticated headers.
The [binary decoder experiment](#full-binary-decoder-feasibility) below closes
the observed fixture coverage gap but leaves resource isolation and supported
node equivalence open. An unsupported transaction anywhere in the range
prevents an absence verdict.
Consensus, chain selection/finality, exact output extraction, resource refusal,
same-height publication order and admission of held commitments remain open.
No runtime source has been selected and no C2.10.13 completeness claim follows
from this probe. Raw venue outputs would still need existing signature,
sequence and authority checks before acquiring protocol force.

## Full binary decoder feasibility

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

The same private experiment now evaluates `ergo-lib-wasm-nodejs`
**0.29.0-alpha-2f840d3**, the npm alpha published 2025-08-13 and pinned on
2026-09-22 in place of 0.28.0 (the npm stable of 2026-09-09) after 0.28.0
refused every Ergo 6.0 script on mainnet
([the decision](../decisions/2026-09.md#2026-09-22--pin-a-sigma-rust-build-that-keeps-every-sized-tree-as-exact-bytes);
[P4](#real-chain-exhaustion-cost-from-a-real-anchor)). npm associates it with
sigma-rust [`2f840d3872367d6181d66d4a168194dbefad77f1`](https://github.com/ergoplatform/sigma-rust/tree/2f840d3872367d6181d66d4a168194dbefad77f1).
The lockfile pins package integrity; the [retained report](ergo-decoder-verification.json)
also hashes the installed WASM and corpus sources and checks the installed
version. This is package metadata provenance of a pre-release, not an
independently reproduced build or a maintenance guarantee.

Fleet serializes only the existing hash-pinned fixtures. Sigma-rust parses
those signed binary transactions, reserializes them, and exposes fields only
after exact byte equality. It recovers all **29 transaction IDs and 77 output
IDs**, values, scripts, token order/amounts, registers, creation heights,
transaction references and indices; input proofs/extensions and data inputs
also match. This includes the 16 transactions Fleet cannot decode and the
two carrying Ergo 6.0 trees (header version 3), which 0.28.0 refuses at the
header byte. Numeric fixture ingestion remains lossless above `2^53`;
comparisons use `bigint`.

The report retains **20,050 assertions**, including rejection of all **19,380
proper prefixes**. For each transaction, the raw parser accepts a trailing
zero byte and an overlong input-count VLQ; the exact byte round trip rejects
both. For each output position, moving a creation-height byte into the claimed
JSON script produces identical signed bytes, but binary extraction recovers
the original committed fields. Forged claimed transaction/output IDs are
ignored and recomputed. For each of the five outputs whose tree carries the
size flag, the header's version bits are rewritten to each of 0–7, with the
real body and with the body zeroed under the same size: all 80 are read as
the exact slice with every other committed field unchanged, so a script
version or opcode the library does not know cannot refuse a transaction (the
previous pin refused every version above 1 before reading the size). An
unsized version-0 tree or a register constant the library cannot parse still
refuses the whole transaction. These controls establish observed behavior,
not a proof of parser equivalence with the node over every valid transaction.
In particular, the pinned
[ErgoTree parser](https://github.com/ergoplatform/sigma-rust/blob/2f840d3872367d6181d66d4a168194dbefad77f1/ergotree-ir/src/ergo_tree.rs)
preserves a failed sized-tree parse as opaque `Unparsed` bytes that round-trip.
Exact reserialization is therefore not evidence that every embedded script
was structurally validated or that the transaction satisfies consensus.

The fixed corpus runs in a separate process with a **120-second deadline**
(raised from 30 s with the slower build; the corpus takes about 14 s on one
desktop) and **1 MiB output cap**. It refuses fixture files above **256 KiB**
before reading and transaction buffers above **64 KiB** before entering WASM;
the largest fixture transaction is **2,576 bytes**. These are experiment
budgets, not network consensus limits. A failed, timed-out or oversized run
yields unresolved evidence, never a successful absence verdict. **There is no
hard process/WASM memory limit** and no adversarial depth/allocation exhaustion
test. Input size, reserialization and a process deadline do not establish
bounded memory use; this slice does not pass that part of the source gate.

The pinned [generic parser](https://github.com/ergoplatform/sigma-rust/blob/2f840d3872367d6181d66d4a168194dbefad77f1/ergotree-ir/src/serialization/serializable.rs)
returns after `sigma_parse` without checking cursor exhaustion, explaining
the accepted suffix. More consequentially, the
[sized ErgoTree parser](https://github.com/ergoplatform/sigma-rust/blob/2f840d3872367d6181d66d4a168194dbefad77f1/ergotree-ir/src/ergo_tree.rs)
allocates `vec![0u8; tree_size_bytes as usize]` from a decoded `u32` before
reading that many bytes, without a local pre-allocation cap. A small input
budget therefore does not bound this allocation. Per-field count bounds in
the [transaction parser](https://github.com/ergoplatform/sigma-rust/blob/2f840d3872367d6181d66d4a168194dbefad77f1/ergo-lib/src/chain/transaction.rs)
do not supply a parser-wide resource budget. The exhaustion case is source
evidence only; the finite corpus deliberately does not execute that allocation.
The [containment](#windows-process-containment-feasibility) and
[metering](#metered-decoder-feasibility) evidence below was taken on the
0.28.0 WASM and is not runnable as documented against the alpha: the
containment probe's corpus case has a 10 s user-CPU quota that the slower
build's larger corpus (about 13 s of CPU) exceeds, and the metering probe
pins the 0.28.0 WASM hash and the 2026-09-09 manifest hash (stale since the
2026-09-15 manifest). No containment evidence binds the pinned build.

Next, compare an OS-contained decoder with a local validating-node boundary,
including hard memory/CPU limits, hostile depth/counts, refusal semantics and
compatibility with the selected node. Canonical round trips can conservatively
refuse node-valid noncanonical encodings; they must not turn that refusal into
an omission. Only then connect a complete contiguous range to independently
authenticated headers and stable transaction/output order. A8/A9, chain
selection/finality, build provenance and publication admission remain open.
No runtime API, venue profile or protocol rule changes in this experiment.

## Ergo venue-profile candidate and full-block range verifier

The [candidate Ergo venue profile](ERGO_VENUE_PROFILE.md) fixes what pool-v3
§13 leaves to a profile: an identity over a pinned anchor header, the
finality depth and one exact ErgoTree per record kind; attribution by that
tree with `R4` a 32-byte subject and `R5` the bytes; kinds 1–3 at exact
length and kind 4 as one transaction's maximal run of adjacent same-subject
outputs; the index as the number of blocks above the anchor's child, so a
read from index zero begins at the deployment's anchor rather than the
chain's genesis; and the ordinal as transaction position then output index.
`ergoRangeVerifier` (`src/ergo-profile.ts`) answers a request by recomputing every
block's transaction root from decoder-derived ids and scanning every output
in the range, so an empty answer is proven by exhaustion; unwitnessed,
gapped or unlinked evidence and headers without the anchor's child give no
answer, and a block that is malformed, of another chain, a duplicate or one
failing its root is passed over so that no supplied block can deny a read
for an index whose section is present. The profile, every header, block and
output, and each request are read once into owned copies before they are
judged.

`experiments/ergo-range/profile-check.mjs` compiles the model and drives it
through the pinned Fleet serializer and sigma-rust decoder. The
[retained report](ergo-range-profile-verification.json) has 277 passing
checks. The mainnet genesis header, pinned as a fixture (height 1, version
1, a zero parent id, 279 wire bytes), is read as an anchor: alone it reaches
no index, a synthetic child at height 2 is index 0 and needs its section,
and with that section index 0 answers empty in 102 bytes. A twelve-height
synthetic chain anchored at its first header, at depth 2 (witnessed index
8) with 15 transactions and 11,896 serialized bytes, carries real signed commitments,
a replacement, two revocation witnessings, single-piece publications for two
backings, a three-piece run and a two-piece run of 3,900-byte pieces; every
decoder id equals Fleet's unsigned-bytes hash, every block root equals an
independent oracle, and the answers (1,038 commitment bytes with six
carried objects of which five are held, 355 replacement bytes with the
successor pending at the lead floor, 334 revocation bytes revoked at the
first witnessing, 8,284 publication bytes merged in venue order) decode
under the §13.3 reader rules. A flipped record byte decodes as another
transaction and fails its block's root, leaving that height without a
section while later ranges answer; a truncated transaction fails the strict
decode; a root-failing twin, a stray block, a malformed block and a
duplicate beside the true sections change no answer byte; a missing block,
an unlinked header, another anchor, headers without the anchor's child, a
range above the witnessed index and an exceeded budget give no answer, and a
chain beginning at the anchor's child answers the same bytes. The four
mainnet fixtures pass through the same verifier as one-block ranges at depth
0, each index 0 under its own parent as the anchor: the model reproduces the real transaction roots
of block versions 1, 3 and 4 from decoder-derived ids, scans all 77 outputs,
decodes all 65 real register constants beside sigma-rust's constant decoder
(43 `Coll[Byte]` equal byte for byte, 22 of other types refused), attributes
nothing at four throwaway locations and answers empty in 102 bytes.

Not established: header authentication (proof of work, chain selection and
finality are the reader's header source), decoder containment and node
equivalence, acceptance of the synthetic transactions by a node, and
reassembly on a node after boxes are spent; the cost of exhaustion from a
real anchor on a real chain is [measured below](#real-chain-exhaustion-cost-from-a-real-anchor).
One limit is concrete: a transaction the reader's decoder
refuses leaves its height without a section, so one node-valid transaction
the decoder cannot read denies every range through it until the decoder is
repaired. One is measured: a kind-4 run is one transaction's outputs, and
under this layout a box carries a 3,981-byte piece and a transaction under
the pinned 98,304-byte mempool policy carries 24 pieces, 95,544 bytes; the
largest publication under the observed 14,656-byte proofs is a release of
15,498 bytes in four pieces, and any proof up to 94,702 bytes fits, so the
frame's 131,914-byte ceiling is a parser bound no configuration-conformant
publication approaches. A configuration is publishable here only where its
largest publication fits one transaction, which the selected profile makes
normative ([venue-ergo.md §8](https://github.com/mediumofexchange/money-from-first-principles/blob/13e5b66/venue-ergo.md#8-publishing)).

## Real-chain exhaustion cost from a real anchor

The recovery map's P4. `experiments/ergo-range/chain-cost.mjs` is run
explicitly, never by `check` or CI, because it reads public mainnet nodes
(GET only; nothing is submitted); the [experiment guide](../experiments/ergo-range/README.md#real-chain-exhaustion-cost)
has the command. It reads the headers of a window from every named node and
the anchor's id at its height, compares them field by field, supplies each
block's transactions by copying the node's JSON text into unsigned bytes and
witness ids (`src/ergo-supplier.ts`, no decoder), counts a section only where every
copy hashes to its stated id and the header's transaction root holds through
the model's root, checks every framed transaction against the node's
statement of its outputs, then builds the model verifier from the real
headers and the supplied sections under four throwaway locations, so every
answer is empty by exhaustion. The [retained report](ergo-chain-cost-verification.json)
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

The recovery map's P2. `experiments/ergo-range/publish.mjs` is run explicitly,
never by `check` or CI, because it submits transactions to a public Ergo
**testnet** node and reads blocks back from it; the
[experiment guide](../experiments/ergo-range/README.md#publication-and-reassembly-on-a-node)
has the commands. It refuses a node whose `/info` does not report the
testnet, signs with the pinned sigma-rust from a throwaway key in ignored
`scratch/ergo-testnet/`, and never touches mainnet or real funds. Under the
[candidate profile](ERGO_VENUE_PROFILE.md)'s layout it builds two publications
of one backing with exact pool-v3 §6 frames and synthetic proof and signature
bytes (a 15,498-byte release in four pieces and a 450-byte withdrawal in one),
places each piece in a box at the kind-4 location with `R4` the subject and
`R5` the piece, and submits six chained cases as separate transactions: the
release; the same release again; its pieces reordered; three of its four
pieces; the release and the withdrawal adjacent in one run; and the two
separated by a plain output. After they are witnessed under the depth it
spends every piece box back to the wallet, waits for the depth again, checks
that the node's UTXO view serves no piece box and its indexed view names the
spend for each, reads the headers from the header below the first inclusion to
the tip and every block through the last inclusion through the JSON-text
copy of the chain-cost probe, builds the model verifier from that anchor
and asks the kind-4 range under the subject, mapping each answered object to
its transaction by index and ordinal. Every submission records the node's full
height at submission and the inclusion height and block timestamp (A10); the
cases are chained on one change box and submitted together, so their
latencies are one correlated observation, not a distribution. `--dry-run`
runs the same construction, signing and read over a synthetic funded input
and one synthetic block whose parent is the real latest testnet header,
reading `/info` and the signing context from the node once, caching both
together and submitting nothing.

**Dry run, 2026-09-22** (the offline mode; its report is in Git history and
is regenerated by the dry-run command): every case signs and round-trips
exactly with the pinned build (`0.29.0-alpha-2f840d3`). The release
transaction is 16,075 bytes over a 1-ERG synthetic input with six outputs;
the partial case 12,439, the merged 16,606, the separated 16,650, and the
sweep of all 25 piece boxes 2,412 bytes with one return output; read back
from one synthetic block under the real latest header, the cases give the
same seven objects as the testnet run below.

**Testnet run, 2026-09-22** ([report](https://github.com/mediumofexchange/reference-ts/blob/d8f2b7b/docs/ergo-publication-verification.json)):
the public node (`ergo-testnet-6.0.3`, `minValuePerByte` 360) accepted all
seven transactions on first submission. The six cases, submitted together
at full height 558,327 from one 20,000-tERG box, were all included in block
558,329 (positions 1–5 and 7; another sender's transaction took 6); the
sweep of all 25 piece boxes, submitted at 558,331, was included in 558,333.
The release transaction is 16,077 bytes (34,473 bytes of node JSON): two
bytes more than the dry run because the change value's VLQ is seven bytes,
not five; the partial case 12,441, the merged 16,608, the separated 16,652,
the sweep 2,412. A 3,981-byte piece box is 4,095 full bytes, within the
4,096-byte limit, the 3,555-byte last piece 3,669, and the withdrawal's single
piece box 564. The node's dust rule is its votable `minValuePerByte` over the
full box bytes (upstream `BoxUtils.minimalErgoAmount`, applied in
`ErgoTransaction.verifyOutput`): every piece box carried exactly that
minimum, 1,474,200 nanoERG for a full piece box and 5,743,440 for a release,
and was accepted with the library's suggested 1,100,000 fee, about 0.0068 ERG
a release. sigma-rust's `calc_min_box_value` covers the candidate only (4,062
bytes, 1,462,320 nanoERG), 11,880 nanoERG short of the node's rule for a full
piece box, so the experiment computes the values itself; a value below the
node's minimum was not submitted, so the refusal side of the rule rests on
the upstream source. The sweep returned every piece value; the run cost the
wallet the seven fees, 7,700,000 nanoERG. After the sweep reached depth 2 the
node's UTXO view served none of the 25 piece boxes and its indexed view named
the sweep as each one's spender. The window from the anchor at 558,328 to
558,333 (five blocks, 30 transactions, 264,597 section bytes) was read through
the JSON-text discipline, every block's transactions reproduced its header
root, the pinned decoder refused none, and the model verifier built from that
anchor answered the kind-4 range under the subject with seven objects at one
index in transaction-then-output order (ordinal = position << 32 | output):
the release and its duplicate are two witnessings of the same 15,498 bytes,
both decoding under §6; the reordered, partial and merged runs are single
objects of 15,498, 11,943 and 15,948 bytes that do not decode and so have no
force; the separated case yields the release at output 0 and the withdrawal
at output 5, both decoding; kinds 1–3 are empty. Every transaction was
included two blocks above the node's full height at submission, 10–17 s by
the block timestamps. Under C3.3's window a publication authorized at the
tip with the instant at the latest witnessed index has force when included
at most `depth + 2` blocks above that tip (A10), so these landed two
blocks inside the bound at depth 2; the report's latency note states the
bound one block stricter.

**Testnet run, 2026-09-24** ([retained report](ergo-publication-verification.json)),
through the reader that decodes nothing: the own testnet node (v6.0.6)
accepted the same seven transactions, the six cases in block 561,774
(positions 1–6) and the sweep in 561,779, each two blocks above the full
height at submission. Every block's unsigned bytes and witness ids, copied
from the node's JSON by `src/ergo-supplier.ts` (re-read from the same cached sections
through the copy on the same day, with no new submission), reproduced its
header root, and the framer read each case
built by sigma-rust's transaction builder (plain inputs, piece outputs, a
pay-to-public-key change and the fee output): the kind-4 range answered the
same seven objects in the same order, kinds 1–3 empty, after all 25 piece
boxes were spent.

**Not established:** an inclusion-latency distribution (A10: the six cases
are one correlated observation and the sweep a second, on the testnet's fast
blocks and light load), the dust rule's refusal side and fee policy beyond
acceptance at these values, mainnet acceptance, and authentication of the
headers, which came from the one node the transactions were submitted to.
The publications' content is synthetic (frames exact, proof and signature
bytes not), which the venue does not read.

## Inclusion latency on the mainnet

Recovery map A10 asks how many blocks a publication takes to land against
C3.3's window. Authorized at tip `T` with the instant at the latest
witnessed index, it has force when included at `T + k` with
`1 <= k <= depth + 2`. `experiments/ergo-range/latency.mjs` watched the mainnet
passively from 2026-09-22 19:22 to 2026-09-23 20:22 UTC. It read a public
node's pool ids and blocks every 10 s (GET only; nothing submitted, no key).
Each transaction's first sighting was timed as `k`, bracketed above by the
height one round earlier. The [recorded report](ergo-latency-verification.json)
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

The profile leaves proof of work and chain selection to the reader's header
source, and until now that source was two public nodes. On 2026-09-22 the
reader ran its own mainnet node (`experiments/ergo-range/nodes.mjs`, the
official v6.0.6 Windows release, JAR checked against the release digest),
configured to bootstrap state from a UTXO-set snapshot but to download the
header chain from genesis rather than accept a NiPoPoW proof, so the node
itself checked every header's proof of work and difficulty and chose the
best chain. `experiments/ergo-range/header-check.mjs` then asked whether the
retained evidence stands on that chain
([retained report](ergo-own-node-verification.json)):

- the five pinned fixture headers (genesis, 100,000, 1,000,000, 1,500,000 and
  1,876,512) are on the node's best chain, equal in id, parent, height,
  version and transaction root;
- the chain-cost window from its anchor at 1,873,360 to its tip at 1,878,410
  links on the node's best chain, its anchor and tip ids are the report's,
  and all 5,050 headers after the anchor equal the cached headers of both
  public nodes in id, parent, height, version and transaction root;
- at a recent height the node and both public nodes name the same header.

A header id commits to its transaction root and, through its parent, to its
ancestry, so the chain-cost probe's 5,040 sections, each of which reproduced
its header's root, are now bound to headers this reader validated; they were
not re-read from the node. The node's log shows it processing the genesis
header itself. The header chain of 1.88 million headers synced in 6,863 s
(1 h 54 min, from the first process, which was stopped for a configuration
change at height 2,492 and resumed ten seconds later on the same data) over
one home connection with up to 30 outbound peers (2 at the first sample); at
that point the node held 850 MB of data with a 1.2 GB working set and 7,231
CPU-seconds, read by hand with `nodes.mjs status` 34 s after the node
logged the milestone. The testnet node (a full archive with the extra index)
synced its 557,758 headers in 3,685 s.

Not established here: an independent check of proof of work or chain
selection (the node is the reference client most of the network runs; the
reader's own check followed, [below](#reader-verified-headers)), resistance to
an eclipse during sync beyond the agreement at one recent height, and the
cost of full-block validation from genesis (state came from a snapshot).
The node's INFO log grew by about 400 MB an hour during sync, so the nodes
now log at WARN. v6.0.6 answers every API request with
`Access-Control-Allow-Origin: *` whatever `corsAllowedOrigin` says, so a
local browser page can read the node's key-free routes.

## Reader-verified headers

The reader need not run a node to authenticate headers: the profile's
[header store](ERGO_VENUE_PROFILE.md#header-source)
(`src/ergo-headers.ts`) verifies header bytes itself from the
pinned anchor. `experiments/ergo-range/header-verify.mjs` ran it on real
mainnet headers on 2026-09-24
([retained report](ergo-header-verification.json), recorded offline from
the run's cached responses):

- **Window.** From the P4 anchor at 1,873,360, the store was built from the
  1,024 headers below it by linkage alone; each of three nodes (the own
  v6.0.6 node, `node.ergo.watch` on 5.0.21 and a public 6.0.5 node) served a
  context that links to the pinned anchor id. It then verified all 6,940
  headers up to 1,880,300 from the own node's bytes, and both public nodes'
  copies of the same heights were already known: no header was unsupplied
  or refused, and the best chain is every source's chain height by height.
  P4's anchor and tip ids are on it, so P4's 5,040 root-checked sections
  now stand on headers the reader verified. Its views build the unchanged
  range verifier (witnessed index 6,929 at depth 10).
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
  median of 21 ms (mean 21, p99 35) on this host in pure JavaScript, 147 s
  for the window; the work check alone has a median of 21 ms, almost all of
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

Reading the own node's retained mainnet blocks through the chain-cost probe,
the npm alpha `ergo-lib-wasm-nodejs@0.29.0-alpha-2f840d3`, then pinned,
overflowed Node's default stack inside `Transaction.sigma_parse_bytes` on a
node-valid 7,131-byte transaction (block 1,827,841, index 1, now the fixture
`mainnet-1827841.json` from the own node), and every later call into the
same WASM instance trapped; the probe crashed seconds later in unrelated
calls, and whether it overflowed depended on the stack already in use. The
decoder caught the overflow as an ordinary refusal, so every transaction
after it would have read as unsupported evidence. Upstream builds its npm
alphas with `wasm-pack build --dev` (the `build-nodejs-alpha` script): the
alpha is a debug build, 16.7 MB of WASM with wasm-bindgen's debug assertions
in its glue, which also explains its six-fold slowdown. Its WASM records
rustc 1.87.0 and wasm-bindgen 0.2.100.

Independent review then found that ErgoTree expression nesting
(`BoolToSigmaProp` over `LogicalNot` nested d levels) traps the alpha from
depth 50 at any V8 stack, consistent with exhausting the module's own
linear-memory stack. The node's cap (sigmastate `MaxTreeDepth`, 110) covers
expressions too by its source, so an output the node accepts could deny every
range through its block. No such transaction was submitted to any node.

The experiment now pins a release build of the same commit, vendored and
reproducible ([decision](../decisions/2026-09.md#2026-09-23--pin-a-reproducible-release-build-of-sigma-rust-2f840d3);
[guide](https://github.com/mediumofexchange/reference-ts/blob/0453955/experiments/ergo-range/README.md#decoder-build)).
`experiments/ergo-range/stack-check.mjs` measures, each trial in a fresh
process, the least V8 `--stack-size` a build needs (found to 8 KB; 71 KB is
the least Node runs with at all) and the deepest expression nesting it
parses at the largest stack Node's 8 MB main thread holds
([retained report](ergo-decoder-stack-verification.json)):

| Input | Pinned release build | Debug alpha | 0.28.0 |
|---|---|---|---|
| Fixture transaction | 71 KB | 1,173 KB | 71 KB |
| An ordinary transaction of the block | 71 KB | 418 KB | 71 KB |
| `Coll^d[Byte]` constant, d = 110 (the node's cap) / 150 | 79 / 101 KB | 1,339 / 1,816 KB | 71 / 71 KB |
| Deepest `LogicalNot` expression nesting, default stack / 7,800 KB | 2,513 / 2,513 | 37 / 49 | 2,842 / 2,842 |

At the default stack the fixture overflows the alpha and the next ordinary
transaction traps. `decoder.mjs` treats a `RangeError` or
`WebAssembly.RuntimeError` from the library as fatal: it rethrows it, marks
its instance poisoned and throws on every later call. On the default stack
it decodes the fixture; on a synthetic transaction whose output tree nests
100,000 levels, which only a dishonest source could present, it traps and
reports its instance poisoned, failing closed. Re-reading the P4 week
offline from the cache with the release build pinned and the alpha as the
alternate ([retained report](ergo-decoder-pin-verification.json)), both
builds answer all 28,196 transactions with an equal id, witness id, ErgoTree
and register constants, neither refuses one, all 5,040 roots reproduce and
no index is unresolved, with decoding about six times faster.

Not established: recursion paths other than collection nesting and
`LogicalNot` expressions; reproduction of the bytes on a host other than
Windows (panic locations keep the host's path separators). The reader now
decodes [contained](#contained-decoder), where a depth ceiling refuses deep
nesting before either stack.

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

The [baseline harness](https://github.com/mediumofexchange/reference-ts/blob/d446f83/experiments/ergo-range/metering-check.py) evaluates
Wasmtime **48.0.0**, using the existing `ergo-lib-wasm-nodejs` 0.28.0 WASM hash.
The Windows x64 wheel is
[hash-pinned](https://github.com/mediumofexchange/reference-ts/blob/0453955/experiments/ergo-range/metering-requirements.txt), with a native
DLL hash and loaded-path checks before controls. The
[report](ergo-metering-verification.json) records the Python/native engine and
harness hashes at `d446f83`; the cost probe below pins that report and verifies
its deterministic results with the current observational hooks. Package
integrity is not an independently reproduced build.
This is a disposable experiment, not a production dependency selection.

The trial contract is **10,000,000 fuel units per transaction**, **16 MiB**
linear memory, one instance/memory/table and **4,096 table elements**. Input is
at most 64 KiB; canonical bytes copied out are at most 64 KiB and JSON text at
most 256 KiB. Limits are fixed before the run and never increased or refilled.
Each transaction gets a fresh Store. Its single fuel budget covers guest
allocation, parsing, exact reserialization and `transaction_to_json`; Store
destruction discards allocations on success or refusal. No guest cleanup call
receives fresh fuel. Shared memories, multiple memories and memory64 are disabled.

All 56 wasm-bindgen function imports use a trap callback. The Python trampoline
converts scalar arguments; the callback reads no guest memory and implements no
JS object bridge, WASI, filesystem, network or randomness service. Successful
fixture paths do not call imports. This deliberately refuses unsupported paths;
it is not a general replacement for the library's JavaScript binding.

| Control or fixture measurement | Result |
|---|---|
| Infinite guest loop with 0 / 1 / 1,000 / 100,000 fuel | `OUT_OF_FUEL`, zero remaining |
| Memory growth to exactly two pages, then one page or a single 4,096-page growth beyond | Exact cap accepted; both overages return -1; remains 131,072 bytes |
| Table growth to two elements, then one beyond | Exact cap accepted; overage returns -1; remains two elements |
| Recursive guest call | `STACK_OVERFLOW` |
| Valid transaction with one fuel unit | `OUT_OF_FUEL`; no accepted output |
| Fixed valid corpus at the unchanged trial budget | 23 of 24 transactions, all 60 corresponding outputs and fields match |
| Largest successful guest fuel / linear memory / JSON text | 6,739,774 units / 1,572,864 bytes / 3,891 bytes |

The 2,163-byte transaction
`745e19978f4bb6d1c0ebe4f083408f3e8474b4010a88ada07f3d1fbb7ee9ac1c`
exhausts fuel during parsing; its five outputs remain **unresolved**. The
runner exits **2**, carries explicit matched/refused totals and gives that
transaction no accepted outputs. This is evidence of enforced refusal, not a
usable complete-corpus budget. No hostile parser mutation ran.

The [v48 limiter](https://github.com/bytecodealliance/wasmtime/blob/v48.0.0/crates/wasmtime/src/runtime/limits.rs)
checks each memory/table separately; limiting their counts makes these guest
caps aggregate here. The
[memory implementation](https://github.com/bytecodealliance/wasmtime/blob/v48.0.0/crates/wasmtime/src/runtime/vm/memory.rs)
consults `memory_growing` before the underlying growth allocation. The control
observes the logical size and refusal; pre-allocation ordering comes from this
pinned source inspection. Neither establishes a process-commit or RSS ceiling.

[Fuel](https://github.com/bytecodealliance/wasmtime/blob/v48.0.0/crates/wasmtime/src/config.rs)
meters guest execution using engine-specific accounting. It is not CPU seconds,
an invariant instruction cost across engine versions, or a bound on compilation,
bulk-operation cost, host callbacks, copies or JSON parsing. The fixed artifact
is compiled once; only pinned valid fixture data reaches this harness. Its
30-second launcher deadline and 1 MiB output cap are operational guards, with
no whole-process/tree resource guarantee. Total host memory is unmeasured in
this baseline.

Metering is a better candidate for explicit guest-work refusal than periodic
Windows CPU thresholds. A validating node supplies different consensus evidence;
rewriting the parser would add compatibility work without removing host costs.
The [cost probe](#decoder-cost-and-host-overhead) below explains the API's extra
work and measures host overhead, without selecting a supported budget. Keep
hard hostile-parser containment, node equivalence and authenticated ranges as
separate open gates.

## Decoder cost and host overhead

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

The [profile](ergo-decoder-cost-verification.json) uses the same pinned artifacts
and replays all 24 valid fixtures at the original 10-million-fuel budget. It
checks IDs/order, status, input size, fuel, guest memory, JSON size, output
counts and refusal phase against the hash-pinned baseline. Optional phase
observation does not change guest calls or refill fuel. Phase fuel totals must
equal the attempt total; success and trap paths both bracket Store destruction.

A separate, predeclared **100-million-fuel diagnostic ceiling** applies once
to the one refused transaction and once to each of its five original scripts.
These six attempts keep 16 MiB guest memory and the old launcher limits. No
mutation, retry or adaptive ceiling occurs; if a diagnostic refuses, that result
remains unresolved and the remaining fixed cases still run. The ceiling permits
cost measurement above the original refusal; it is not a proposed acceptance
budget. The runner always exits **2** and preserves the original corpus refusal.

| Work within the diagnostic transaction | Fuel |
|---|---:|
| Instantiation | 380,929 |
| Stack-area reservation and input allocation | 437 |
| `transaction_sigma_parse_bytes` | 12,830,008 |
| Exact transaction reserialization | 2,599,805 |
| Guest JSON construction | 5,714,147 |
| Whole attempt | 21,525,326 |

All fields of the five outputs match in this diagnostic, with an exact transaction byte
round trip. The five original script lengths are 515, 948, 36, 36 and 105 bytes;
their independent parse calls consume **2,322,785 fuel combined** and all five
round-trip exactly. Script round trips still do not establish structural or
consensus validation. Nor is their sum a decomposition of transaction parsing:
the two API paths do different work.

In the pinned
[transaction source](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergo-lib/src/chain/transaction.rs),
`sigma_parse` ends by constructing a transaction. The constructor clones
candidates, builds outputs with a zero transaction ID, computes the transaction
ID through serialization and hashing, then builds outputs again with that ID.
Each [box construction](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/chain/ergo_box.rs)
clones its tree/tokens/registers and serializes/hashes the box. The
[tree serializer](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/ergo_tree.rs)
rebuilds parsed trees from constants and the expression tree; opaque `Unparsed`
trees retain their bytes. Thus the nominal parsing
call includes repeated copying, serialization and identity computation.

This source confirms additional work and supports the cost explanation; it
does not assign the **10,507,223-fuel difference** to particular constructors,
clones or hashes. A split wrapper or instrumented pinned-source build could
falsify the proposed dominance of constructor work. Neither a parser defect nor
an asymptotic bound follows from this finite measurement, and no upstream code
was changed. The required real IDs and canonicality checks remain intact.

Host snapshots cover loading the pinned Python engine package/native DLL,
compilation, instantiation, guest
calls, copies, JSON parsing and cleanup. They use
[Windows process counters](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)
for current private commit and working set, plus process-lifetime peaks, and
[process CPU time](https://docs.python.org/3/library/time.html#time.process_time).
Before/after snapshots and phase totals are retained. These are measurements,
not resource enforcement. Lifetime peaks cannot be attributed to the latest
phase; process CPU is quantized, so a zero phase delta does not mean no CPU work.
Initial Python startup/standard-library imports precede these snapshots.
The Python counters omit fixture-preparation and launcher processes; wall
timings include instrumentation. No guest-memory subtraction is used to claim
a bound on host memory.

The final sequential run after repository checks measured **2.377 s wall /
7.719 s process CPU** for compilation. Python's lifetime peak commit reached
**154,443,776 bytes**; current commit after engine closure was **28,057,600
bytes**. Across the original 24 attempts (including the refusal), instantiation
took **389.539 ms** combined versus **19.926 ms** in guest parse calls. The full
diagnostic transaction attempt took **22.237 ms**. These are one host's samples,
including measurement overhead, not statistical or supported-device bounds.

The measured fixed compilation and fresh-instance setup costs argue for reusing
a compiled module if this decoder is adopted, with fresh capped Stores and a
separately bounded host interface. They do not justify a production fuel limit
or clear total-process containment. Further parser optimization or a custom
source build is deferred: the next source probe should exercise a dedicated
keyless validating node, whose consensus/configuration/sync evidence is needed
independently of binary parsing. Hostile alternate-parser cases remain gated
on containment; they need not precede testing that independent node boundary.

## Metered release decoder over the week

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

`experiments/ergo-range/metered-check.mjs` runs the vendored release build of
sigma-rust 2f840d3 (WASM SHA-256 `0d200385…aa28a`) under the
[baseline](#metered-decoder-feasibility)'s pinned Wasmtime 48 engine and
import policy: a fresh Store per transaction, one fuel budget across parse,
exact reserialization and JSON extraction, every import trapping. The
release build needs a second table; the ceilings are an effectively
unbounded fuel and wasm32's whole 4 GiB, for observation rather than as a
budget. `--week` reserializes the cached node text of the P4 window with the
pinned serializer and meters every transaction, checking each decoded id
([report](ergo-metered-release-verification.json)).

| Input | Transactions | Decoded | Fuel per byte, median / max | Guest memory max |
|---|---|---|---|---|
| Corpus fixtures | 29 | 29 | 8,101 / 10,928 | 2.5 MB |
| P4 window, heights 1,873,361–1,878,400 | 28,196 | 28,196 | 8,101 / 22,450 | 11.1 MB |

The largest window transaction is 88,284 bytes; the costliest took 2.8 × 10⁸
fuel. These are valid retained transactions, so no bound for adversarial bytes
follows, and fuel is not CPU time; host memory is unmeasured here.

The same probe checks whether the node's JSON could stand in for the parse.
Rebuilding a transaction's bytes by copying the node's hex fields in order
reproduces its id, but the id hashes only the concatenation: moving one byte
from R5 to the end of R4 in fixture transaction `4987fc23…` (mainnet
1,000,000) rebuilds the same bytes and id while both registers change. The
root therefore authenticates the bytes, not the node's split of them into
ErgoTree and registers. Checking a split is a parse: in the week, 102,292 of
103,791 outputs (98.5%) carry version-0 trees without the size flag
(45,293 of them P2PK), whose length only a parse of the whole expression
gives; the other 56,999 use 160 distinct trees, one register holds a whole box, and
34,063 context-extension values, like registers, are constants without a
length prefix (a scratch count over the same cache). At the node's pinned
sigmastate v6.0.6, 102 expression serializers apply and a method call's
layout depends on the versioned method registry. The reader keeps its own
decoder ([decision](../decisions/2026-09.md#2026-09-23--keep-the-readers-own-decoder-the-transaction-root-does-not-authenticate-the-nodes-field-split));
it runs [contained](#contained-decoder) under the reader's budget.

## Decoder node equivalence over the retained blocks

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

The [chain-cost probe](#real-chain-exhaustion-cost-from-a-real-anchor) ran over every full
block the [own mainnet node](#own-node-as-the-header-source) keeps after its
UTXO snapshot, heights 1,830,001–1,879,100 (49,100 blocks, 69 days), in five
chunks; an offline pass then compared, for every transaction, what the
vendored release decoder reads with the node's JSON fields
([guide](../experiments/ergo-range/README.md#real-chain-exhaustion-cost),
[retained report](ergo-decoder-equivalence-verification.json)).

| Blocks | Transactions | Outputs | Registers | Roots reproduced | Refused | Differing fields |
|---|---|---|---|---|---|---|
| 49,100 | 314,028 | 1,236,527 | 915,923 | 49,100 | 0 | 0 |

Compared per transaction: id, witness id and output count, and per output
the ErgoTree bytes, register names and register constants. In each chunk,
mutating each of those fields in the node's statement of one real
transaction shows as a difference, so the empty count is not a comparison
that cannot fail. The pass recomputes each chunk's cache digest before
comparing, links its headers by id, and binds the decoder's WASM and
JavaScript glue against the vendored checksums; the summary joins chunks
by header id and accepts only the driver's exact plan. The largest
transaction is 91,842 bytes.

The comparison is independent of the shared serializer only because each
block's root, over ids equal to the node's, authenticates the bytes the
decoder reads. Inputs, data inputs, values and tokens are not compared, since
the verifier reads outputs only. These are valid transactions from one
node's retention window: script versions only earlier blocks carry are not
exercised, and no decoder or profile is selected; hostile inputs are compared
[separately](#hostile-input-node-equivalence).

## Contained decoder

*Retired 2026-09-24: neither the reader nor its supplier decodes ([decision](../decisions/2026-09.md#2026-09-24--supply-ergo-unsigned-bytes-by-copying-the-nodes-json)); the scripts named below are kept at [0453955](https://github.com/mediumofexchange/reference-ts/tree/0453955/experiments/ergo-range).*

The reader decodes through `experiments/ergo-range/contained-decoder.mjs`
([decision](../decisions/2026-09.md#2026-09-24--contain-the-readers-decoder-per-transaction-under-a-deterministic-metered-budget),
[guide](https://github.com/mediumofexchange/reference-ts/blob/0453955/experiments/ergo-range/README.md#contained-decoder),
[retained report](ergo-decoder-containment-verification.json)). `wasm-meter.mjs`
derives from the vendored release build (WASM `0d200385…`) a module
(`bd7cfbb5…`, 13,727 functions, 16,050 charged regions, 54,467 counted call
sites, 5,211 helper calls) that charges fuel at every function entry and loop
head, charges and caps bulk memory, memory growth and table growth, and
refuses a call depth past a ceiling. Each transaction runs in a fresh instance,
every import trapping, under a budget linear in its length n: fuel
2^26 + 2^21·n, linear memory 8 MiB + 1 KiB·n, 4,096 table elements and
4,096 frames, inputs to 2 MiB (mainnet's voted `maxBlockSize` is 1,271,009
bytes on the own node).

| Input | Transactions | Decoded, fields equal to the node's | Least budget margin |
|---|---|---|---|
| Corpus fixtures | 29 | 29 | 4.45 |
| P4 week, heights 1,873,361–1,878,400 | 28,196 | 28,196 | 3.69 |
| Own node's retained blocks, heights 1,830,001–1,879,100 | 314,028 | 314,028 | 2.98 |

Over all 342,253 transactions the budget is at least 5.4 times the fuel
and 2.98 times the linear memory any of them took; the costliest, a
52,030-byte transaction of block 1,867,680, took 18.4 × 10⁹ fuel and
16.7 MB of memory, and none took more than 394,944 fuel per byte. The node's JSON fields are compared as in the
[equivalence pass](#decoder-node-equivalence-over-the-retained-blocks), with a
mutation control per set, so `decoder.mjs` and the contained decoder agree
there transitively. On one desktop the derived module ran these transactions
at about 3.4 × 10¹⁰ fuel a second, because a region's charge also covers
code its branches skip; where every charged instruction runs, as in the
control module's counted loop, it runs 2–9 × 10⁹ a second (the lower rate
before the engine optimizes the loop). So the worst case for a 98,304-byte
transaction's budget is about 23–100 seconds, and for a 2 MiB input's
about 8–37 minutes. A read's transactions each get their own budget and the
reader sets no total, so a read's worst case is their sum. A fresh
instance costs 2.6–5 ms.

`contained-check.mjs` counts by hand what each construct must cost on an
assembled module and finds it exactly: straight code, a counted loop and
nested loops with an outer-loop branch, `br_table` and `if`/`else`, every
helper including a refused growth, direct and `call_indirect` recursion
stopped at depth ceilings, and the depth back at zero after calls return. Growth past a ceiling returns −1 and sets its flag;
tail calls, SIMD, `memory.init` and a start section make the rewriter throw.
On the decoder, fuel and memory ceilings below a corpus transaction's need
refuse it as `fuel` or `memory` and its exact need decodes it; an expression
nested to the node's cap of 110 decodes within 361 frames, while nesting of
2,000, 100,000 and 1,000,000 refuses as `depth` at frame 4,097 wherever the
caller leaves 437 KB of V8's 984 KB default stack (measured on this unary
nesting; review found other unary operators need no more, and other
recursion paths are not measured); truncated, extended and
pseudorandom bytes refuse; and the next transaction after every refusal
decodes unchanged. Metering repeats exactly.

Not established: that no node-valid transaction exceeds the budget (the
node's rules bound neither a decoder's work nor its memory per byte, so the
budget is the reader's and a costlier node-valid transaction is refused,
denying the ranges through its block); a bound on the host's own memory
(a dropped instance's memory stays until V8 collects it, and the
per-transaction caps summed over the replay adapter's read limits reach
16 GiB); CPU time, which fuel only approximates. Node equivalence on
hostile inputs is measured [below](#hostile-input-node-equivalence).

## Hostile-input node equivalence

**Framer against node, 2026-09-24** ([guide](../experiments/ergo-range/README.md#hostile-input-node-equivalence),
[retained report](ergo-framer-hostile-equivalence-verification.json)). The
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

**Decoder against node, 2026-09-24, retired with the decoder**
([harness and report at 0453955](https://github.com/mediumofexchange/reference-ts/blob/0453955/experiments/ergo-range/hostile-equivalence.mjs)).
Offline, the 29 corpus transactions (19,380 bytes) were mutated
deterministically into 159,397 distinct cases: every byte replaced by four
values, deleted, and preceded by 0x00 and 0x80, every proper prefix, and 256
seeded splices per transaction. Each case was read by the node and by the
contained decoder
([retained report](ergo-decoder-hostile-equivalence-verification.json)). The
node's reading is the pinned v6.0.6 JAR's own `BlockTransactionsSerializer`
on a one-transaction version-4 section, in its bundled runtime; it states
its id, witness id, and each output's tree and register constants as its
serializers write them. Where the node writes what it read as other bytes,
it and the decoder read that rewrite again; all 2,845 distinct rewrites read
back unchanged under the same ids and fields.

| Node's reading | Readings | Node's ids and fields | Other ids | Node's ids, other fields | Decoder refuses |
|---|---|---|---|---|---|
| Whole case, written back unchanged | 50,754 | 49,613 | 0 | 0 | 1,141 |
| Whole case, rewritten: the case | 3,127 | 0 | 392 | 0 | 2,735 |
| Whole case, rewritten: the rewrite | 2,845 | 1,212 | 0 | 0 | 1,633 |
| A proper prefix: the whole case | 227 | 0 | 0 | 0 | 227 |
| A proper prefix: the prefix | 227 | 77 | 0 | 0 | 150 |

The node refused the other 105,289 cases; the decoder read 10,171 of them,
bytes that cannot be a transaction of a version-4 block. No case was left
uncompared and no resource limit was reached on either side.

The decoder never read a case under the node's ids with other output
fields. The reader authenticates decoded transactions only by the header's
transactions root over their ids and witness ids, so on these cases it
either reads what the node committed to or leaves the block unresolved.
Controls confirm that each compared field shows as a difference and that the
verdicts separate equal, same-id and other-id readings. Mutations changed ids,
witness ids, trees and registers in cases both sides read alike, but never
the output count or register names.

Refusals are the finding. Of the bytes the node reads and writes back
unchanged, the decoder refuses 1,141, and all but 7 pass the node's
stateless checks:

- 624 are expressions sigma-rust's type check refuses while the node reads
  them untyped.
- 71 are opcodes or methods sigma-rust does not implement.
- 359 are box values or token amounts outside sigma-rust's bounds.
- 87 are bytes sigma-rust writes back differently.

Of the node's own rewrites it refuses 1,633, of which 1,488 fail
sigma-rust's type check. Both come from every corpus era, including 148 and
307 respectively from block 1,876,512's transactions. If such a transaction is also valid against state, which this
does not test, one placed in a block denies the reader that block's ranges
for the price of a transaction. The rewrites add a second denial: the header
commits to the ids of the node's rewrite, so a supplier serving a miner's
original bytes is refused (392 cases read under other ids).

These refusals no longer reach the reader, which since 2026-09-24 takes each
transaction's unsigned bytes and frames them itself
([decision](../decisions/2026-09.md#2026-09-24--read-venue-transactions-as-unsigned-bytes-through-the-profiles-own-framer)).
The 2026-09-24 rerun has the node also state its own unsigned bytes
(`messageToSign`) for every transaction it reads: 56,953 readings (whole
cases, prefixes and the 2,845 stable rewrites). Every one hashes to the
node's id; the framer reads 18,382 of them, each with exactly the node's
output count, trees, register names and constants, and leaves 38,571
outside its grammar, which carry no record. The decoder's counts above are
unchanged by the rerun. The run on unsigned seeds is the framer's section
above.

Not established: validity against state or proofs; version contexts other
than a version-4 block's (the profile reads every block version); which
bytes peers and node APIs serve for a rewritten transaction; inputs beyond
single-byte mutations and splices of these 29 transactions. The stateless
verdict uses the node's initial validation settings.

## Venue and restoration work still required

The [publication experiment](#venue-publication-and-reassembly-on-a-node)
covers piece framing, canonical reassembly, duplicates, reordered, partial
and merged runs and retrieval after boxes are spent, with node acceptance on
the public testnet. Still required: an inclusion-latency distribution from
repeated independent submissions, and mainnet acceptance.

The restoration experiment must specify receiver-only spending authority,
authenticated encrypted openings, deterministic retry, seed-based discovery
and a complete independently retrievable evidence package. Merely adding
ciphertexts or serving public inputs without proofs is not that package.
