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

Reproduce the cryptographic seam and proof-binding checks with Node 24:

```powershell
npm run check:pool:delivery
```

The retained sources are under [scripts/pool/delivery](../scripts/pool/delivery/).
Generated compilation and run reports stay under ignored `scratch/`.
The [recorded result](pool-delivery-verification.json) identifies the exact
sources/toolchain and records hostile checks and local measurements. CI runs
the candidate checks on Linux and Windows beside the pinned v2 proof checks.
No production circuit, key, configuration or exported runtime API changes.

The fresh restoration process receives only a seed and synthetic public
outputs/capsules, spent nullifiers and lit settlement data. It receives no
request journal, original payer secrets or original operator callbacks.
It reconstructs positive unspent notes, retains unresolved coverage, and
separates force-created outputs awaiting canonical adoption. The probe also
checks deterministic retries, key separation, malformed/context-swapped
capsules, missing/reordered delivery vectors, authenticated wrong-commitment
plaintext, spent/zero outputs and fresh request generation after journal loss.
Node's cipher results are checked against WebCrypto independently.

Every capsule is 89 bytes. One aggregate digest adds two public field
encodings, 64 bytes per issue/spend/burn before record framing: 242 extra
bytes for two outputs, 331 for three. A real candidate spend with those two
public `u128` limbs uses 19,050 gates versus 19,034 (+16); its subgroup
remains 32,768 and proof remains 14,656 bytes. Mutating either limb rejects
the original proof. Changing only the compiler ABI metadata to `Field`
still rejects `2^128` in either limb over unchanged ACIR, establishing an
actual circuit range constraint. This is a spend-binding measurement, not
an already measured final v3 issue/spend/burn suite.

On this Windows desktop (Node 24.6.0, i7-5500U), 1,000 / 10,000 / 100,000
failed capsule opens took 79 ms / 738 ms / 12.36 s. These samples repeat one
foreign envelope while deriving its subkey each time; they measure trial
cryptography, not traversal of distinct history records. Existing commitment
plus nullifier hashing averaged 2.11 ms per pair over 250 samples, excluding
owner derivation and the rest of successful recovery. The candidate spend
proved in 4.38 s and verified in 92 ms. These are single local samples, not
phone budgets or throughput guarantees.

The restoration fixture is explicitly a **prevalidated synthetic view**.
It does not verify full v3 history, force, adoption, venue ordering or range
completeness. A caller's marker is no finality evidence. The production wallet
must consume independently authenticated complete public packages, retain
full evidence before payer/operator disappearance, and construct certified
paths. Seed recovery does not discover unknown venues/backings, prove a
complete balance or guarantee permanent availability. Device and full-history
replay costs remain additional gates.

### Restoration from exact local evidence

`npm run check:pool:restoration` connects the existing capsule scanner to the
canonical v3 served-trail, record, snapshot and header codecs. It also runs in
`check:pool:delivery`, including Linux/Windows CI. The
[retained result](pool-restoration-evidence-verification.json) pins the sources;
temporary codec builds are removed after the run.

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
inputs and measurement scope. Generated sources/builds/reports stay in
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
positions. `scripts/pool/spent-set/` retains the candidate and an independent
batch oracle; no runtime v2 code, root, proof or configuration changes.
`npm run check:pool:spent` is included in `npm run check`, so Linux Node 20/24
and Windows Node 24 CI exercise the deterministic checks.

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
LF-normalized source hashes, environment and deterministic roots. Both shapes
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
well under the mempool limit. Not established: node acceptance, a real
signature, fee policy, the votable parameter's current value, reassembly and
authentication of chunks against forged or reordered boxes, and retrieval
after the boxes are spent. The probe's script, notes and JSON stay in
`scratch/` and are reproducible with `npm install` there.

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

The retained [result](ergo-range-verification.json) has 342 passing assertions:
three public mainnet block fixtures at heights 100000, 1000000 and 1500000,
versions 1/3/3, 24 transactions and 65 outputs. Their raw JSON totals 138,228
bytes; reconstructed signed transactions total 14,450 bytes, excluding block
section framing. The fixture manifest records source URLs and SHA-256 pins.
These blocks are separated in height and were acquired from a public node;
their headers have not been independently authenticated. No network request
is needed to repeat the checks.

All 24 computed transaction IDs and all three roots match the fixtures.
Controls remove and duplicate every transaction, swap adjacent transactions,
mutate every output value and input-proof evidence, and check competing root
algorithms. Version 1 explicitly retains the same root after proof mutation.
Node 24's JSON source-text reviver retains amounts above JavaScript's exact
integer range without rounding.

**Parser result:** only 11 of 24 transactions round-trip through Fleet's
decoder. The other 13 fail on valid fixture scripts without a size flag;
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

The same private experiment now evaluates `ergo-lib-wasm-nodejs` **0.28.0**,
the npm stable version observed on 2026-09-09. npm associates it with
sigma-rust [`635bbaca55a27d6dd6b2c0ee2479b6ed60117780`](https://github.com/ergoplatform/sigma-rust/tree/635bbaca55a27d6dd6b2c0ee2479b6ed60117780).
The lockfile pins package integrity; the [retained report](ergo-decoder-verification.json)
also hashes the installed WASM and corpus sources. This is package metadata
provenance, not an independently reproduced build or a maintenance guarantee.

Fleet serializes only the existing hash-pinned fixtures. Sigma-rust parses
those signed binary transactions, reserializes them, and exposes fields only
after exact byte equality. It recovers all **24 transaction IDs and 65 output
IDs**, values, scripts, token order/amounts, registers, creation heights,
transaction references and indices; input proofs/extensions and data inputs
also match. This includes the 13 transactions Fleet cannot decode. Numeric
fixture ingestion remains lossless above `2^53`; comparisons use `bigint`.

The report retains **14,874 assertions**, including rejection of all **14,450
proper prefixes**. For each transaction, the raw parser accepts a trailing
zero byte and an overlong input-count VLQ; the exact byte round trip rejects
both. For each output position, moving a creation-height byte into the claimed
JSON script produces identical signed bytes, but binary extraction recovers
the original committed fields. Forged claimed transaction/output IDs are
ignored and recomputed. These controls establish observed behavior, not a
proof of parser equivalence with the node over every valid transaction.
In particular, the pinned
[ErgoTree parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/ergo_tree.rs)
can preserve a failed sized-tree parse as opaque `Unparsed` bytes that round-trip.
Exact reserialization is therefore not evidence that every embedded script
was structurally validated or that the transaction satisfies consensus.

The fixed corpus runs in a separate process with a **30-second deadline** and
**1 MiB output cap**. It refuses fixture files above **256 KiB** before reading
and transaction buffers above **64 KiB** before entering WASM; the largest
fixture transaction is **2,163 bytes**. These are experiment budgets, not
network consensus limits. A failed, timed-out or oversized run yields
unresolved evidence, never a successful absence verdict. **There is no hard
process/WASM memory limit** and no adversarial depth/allocation exhaustion
test. Input size, reserialization and a process deadline do not establish
bounded memory use; this slice does not pass that part of the source gate.

The pinned [generic parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/serialization/serializable.rs)
returns after `sigma_parse` without checking cursor exhaustion, explaining
the accepted suffix. More consequentially, the
[sized ErgoTree parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergotree-ir/src/ergo_tree.rs)
allocates `vec![0u8; tree_size_bytes as usize]` from a decoded `u32` before
reading that many bytes, without a local pre-allocation cap. A small input
budget therefore does not bound this allocation. Per-field count bounds in
the [transaction parser](https://github.com/ergoplatform/sigma-rust/blob/635bbaca55a27d6dd6b2c0ee2479b6ed60117780/ergo-lib/src/chain/transaction.rs)
do not supply a parser-wide resource budget. The exhaustion case is source
evidence only; the finite corpus deliberately does not execute that allocation.

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
`model/pool-v3-ergo-profile.ts` answers a request by recomputing every
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
[retained report](ergo-range-profile-verification.json) has 250 passing
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
chain beginning at the anchor's child answers the same bytes. The three
mainnet fixtures pass through the same verifier as one-block ranges at depth
0, each index 0 under its own parent as the anchor: the model reproduces the real transaction roots
of block versions 1 and 3 from decoder-derived ids, scans all 65 outputs,
decodes all 57 real register constants beside sigma-rust's constant decoder
(42 `Coll[Byte]` equal byte for byte, 15 of other types refused), attributes
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
largest publication fits one transaction. No specification selects the
profile.

## Real-chain exhaustion cost from a real anchor

The recovery map's P4. `experiments/ergo-range/chain-cost.mjs` is run
explicitly, never by `check` or CI, because it reads public mainnet nodes
(GET only; nothing is submitted); the [experiment guide](../experiments/ergo-range/README.md#real-chain-exhaustion-cost)
has the command. It reads the headers of a window from every named node and
the anchor's id at its height, compares them field by field, obtains each
block's transaction section by serializing the node's exact JSON text with
the pinned sigma-rust, counts a section only where the bytes reproduce the
header's transaction root through the model's root, reads the sections with
the experiment's strict decoder and, beside it, with another named
`ergo-lib-wasm-nodejs` install, then builds the model verifier from the real
headers and the read sections under four throwaway locations, so every
answer is empty by exhaustion. The [retained report](ergo-chain-cost-verification.json)
records the window, the nodes' agreement, a digest of the cached responses,
sizes, times and refusals.

The window is anchored at height 1873360, so indices 0–5039 are heights
1873361–1878400, with headers to 1878410 for depth 10. `node.ergo.watch`
(5.0.21) and `213.239.193.208:9053` (6.0.6) agree on all 5,050 headers
and the anchor; the headers are version 4 of 220 or 221 wire bytes (mean
220.9) and link without a gap; the window spans 169.0 hours, 716 blocks a day. Every
one of the 5,040 sections reproduced its header root from the node's
text, so the JSON route yields exact bytes when the text is fed as written.
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
| Indices without a section: sigma-rust 0.28.0 / alpha | 5 / 0 | 58 / 0 |

Decoding the week's 28,196 transactions took 32.5 s under the
pinned 0.28.0 and 227.4 s under `0.29.0-alpha-2f840d3`; serializing
them from text 32.4 s; building the verifier from the read sections
1.8 s, and that construction is where every output is scanned and
attributed and every root rechecked from the decoder's ids; 5,040
single-index probes afterwards took 49 ms and a day's or the week's
range answers in a few milliseconds (the least of five repetitions),
walking per-index lists. The week's
sections were fetched by a scratch probe whose log is not retained: about
six minutes of response time, roughly 80 ms a response at 250 ms pacing
from one host, and the 6.0.6 node refusing new connections after about 600
unpaced requests. The retained run reads the cache (two live reads, the
nodes' state), and reads are paced and rotate between nodes with backoff.

Three findings bind later choices. The pinned 0.28.0 refuses every
transaction carrying an ErgoTree of header version 3, the Ergo 6.0 script
version: 125 transactions in 58 blocks of the week, each leaving
its index without a section and every range through it unanswered, the
longest resolvable run being 2,683 indices; the alpha reads all of them
after exact round trips. Second, the node's JSON keeps a spending-proof
extension's keys in its map's order, which a JSON object model sorts:
re-serializing parsed objects gives 12 of the week's transactions a
different id, so a reader on JSON must serialize the node's text as written,
and the header root, not the serializer, authenticates the result. Third,
the node's header `size` (220–221 bytes) is twice the verifier's view (105), so
header retention is the deployment's age at about 58 MB a year
of wire headers at this rate.

Not established: the nodes' authenticity (two public nodes agreeing is not
proof of work, chain selection or finality, and a shared upstream is not
excluded), decoder containment and node equivalence, the inclusion-latency
distribution (A10; it needs submitted transactions, which is P2), and any
bound on future blocks: the counts are for these package versions and this
window. No profile, decoder or dependency pin is selected by this probe.

## Windows process containment feasibility

The private `experiments/ergo-range/contained-check.ps1` probe compares fixed
workers under Windows Job Objects, separately from the default CI corpus.
The [no-window report](ergo-containment-verification.json) and
[detached report](ergo-detached-containment-verification.json) record Node
24.6.0, Windows build 19045, PowerShell, launch flags and the same six source
hashes. Both exit **2**, meaning **unresolved containment evidence**.
These are one sequential pair of runs after repository checks, not statistical
bounds or samples selected for passing. The default remains `no-window`.

The supervisor creates each worker suspended with a
[creation-time job list](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812),
checks membership and reads back limits before resuming. Only NUL input and
the shared stdout/stderr pipe are inherited. Both modes retain 256 MiB
process/job committed memory, one active process, a default two-second user-CPU
threshold, 64 KiB output and an eight-second wall deadline. The CPU control
gets one second user CPU; the wall control gets one second wall time. The
finite corpus gets 10 seconds user CPU and 30 seconds wall time. These are
experimental budgets. The
[memory fields](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information)
describe committed virtual memory, not an RSS ceiling.

The only launch difference is `CREATE_NO_WINDOW` versus `DETACHED_PROCESS`,
combined respectively into flags `0x08080004` and `0x0008000c` with
`CREATE_SUSPENDED` and `EXTENDED_STARTUPINFO_PRESENT`.
[Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
that detached console processes do not inherit the parent's console and may
allocate one later. This comparison does not prevent later console allocation
or isolate untrusted programs. Both modes keep identical job assignment,
handle inheritance, budget checks and cleanup.

| Observation | No window | Detached |
|---|---|---|
| Images observed in all eight cases | Node and `C:\Windows\System32\conhost.exe` | Node only |
| Maximum sampled associated IDs per case | 2 | 1 |
| Growing-memory job peak, bytes | 273,985,536 (above 268,435,456 cap) | 267,730,944 (below cap) |
| Growing-memory process and independent private-commit peaks, bytes | 267,403,264 | 267,730,944 |
| Single 256 MiB growth | Refused; retains 65,536 WASM bytes | Refused; retains 65,536 WASM bytes |
| One-second CPU control, target / final job user seconds | 1.1875 / 1.203125 | 5.859375 / 5.859375 |
| Whole-job cleanup readback | All eight empty | All eight empty |
| Finite corpus job peak, bytes | 61,480,960 | 54,521,856 |
| Report resource issues | Extra associated IDs, memory and CPU overages | CPU overage |

Detached job/process memory peaks agree in every case and no helper is observed.
This supports the console-helper explanation for the no-window accounting
mismatch on this host; it does not prove why the OS admitted the helper under
the configured one-process limit. **Do not subtract an empirical allowance.**
[Job accounting](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)
records one lifetime process in each detached case and two in each no-window
case. Failed associations can also increment this count, so it cannot by itself
prove successful execution. The descendant control fails in both modes;
that alone does not attribute the failure to the process-count limit.

Independent
[private-commit measurements](https://learn.microsoft.com/en-us/windows/win32/api/psapi/ns-psapi-process_memory_counters_ex)
and process-ID/image queries are bounded samples, may race exit and do not
prove a complete lifetime inventory. Inventory storage is capped at 16 IDs.
Cleanup terminates the job, waits for the target with a direct termination
fallback, and reads back zero active job entries within five seconds. Some
no-window accounting snapshots retain entries after target exit; detached
snapshots report zero. Final job CPU includes the cleanup interval.

Both CPU controls exit with native `STATUS_QUOTA_EXCEEDED` (`0xc0000044`,
mapping to Win32 1816). The
[status identity](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)
does not prove its cause or an exact bound. Windows checks
[user-CPU thresholds periodically](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)
without a documented maximum overshoot; kernel CPU is separate. Detached
launch does not change this contract. Observed target or final job CPU above
the threshold remains a failure even on a quota exit. Wall/output controls
still terminate with their named supervisor outcomes and no accepted output.

Eight worker-free `-EvidenceOnly` regressions retain checks for CPU overshoot,
exact boundaries, job CPU, independent/job memory, associated IDs and both
accounting snapshots. `-StartupOnly` remains diagnostic and returns exit 2 for
unresolved observations. Independent adversarial review and final report/hash,
resource-predicate and numeric-claim readback found no material defect.
Both full runs recover the unchanged corpus: **14,874 assertions, 24
transactions and 65 outputs**. Its embedded report describes the old runner;
the outer reports name the effective limits.

Earlier failed evidence remains at immutable revisions:
[`8938c77`](https://github.com/mediumofexchange/reference-ts/blob/8938c77/docs/ergo-containment-verification.json)
records a 274,014,208-byte job memory peak and 6.59375 seconds CPU, and
[`8f29a4a`](https://github.com/mediumofexchange/reference-ts/blob/8f29a4a/docs/ergo-containment-verification.json)
records a 273,514,496-byte peak and a CPU case reaching the wall deadline after
3.796875 user seconds during concurrent repository checks. New samples do not
erase those failures. No hostile depth/count/declared-size parser cases ran;
there is no filesystem/network isolation or selected runtime boundary.
Unsupported decoding and resource refusal remain unresolved, never omission.

Hard containment remains **failed**. The
[metered probe](#metered-decoder-feasibility) below evaluates a different guest
resource contract; it does not clear these OS failures or raise their budgets.
Header/range authentication, parser compatibility and publication status remain
separate gates.

## Metered decoder feasibility

The [baseline harness](https://github.com/mediumofexchange/reference-ts/blob/d446f83/experiments/ergo-range/metering-check.py) evaluates
Wasmtime **48.0.0**, using the existing `ergo-lib-wasm-nodejs` 0.28.0 WASM hash.
The Windows x64 wheel is
[hash-pinned](../experiments/ergo-range/metering-requirements.txt), with a native
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

## Comparison with a local validating node

The comparison retains the fixture manifest's Ergo node source pin
[`c364664`](https://github.com/ergoplatform/ergo/tree/c36466405abc9a2ddda37e890635f00d593041f5)
and sigma-interpreter pin `ab0b15c`; no node artifact was installed or executed.
The [dedicated-node preflight](ERGO_NODE_PREFLIGHT.md) now records the verified
Windows archive/JAR hashes, runtime/source requirements and a finite offline
startup. The stock node runs with no spending key, an uninitialized wallet,
loopback listeners and a strict reader allowlist; wallet routes and hardcoded
CORS remain. Startup and whole-job cleanup are demonstrated under the reported
resource controls. Sync, hard disk/network containment and fully validated
chain membership remain open.
At this node revision, the
[block API](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/src/main/scala/org/ergoplatform/http/api/BlocksApiRoute.scala)
looks up a stored header and full block. The
[transaction section](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/ergo-core/src/main/scala/org/ergoplatform/modifiers/history/BlockTransactions.scala)
emits its transaction sequence in order and parses transactions with the
applicable version context. The endpoint alone does not prove best-chain
membership or completed transaction validation. Those require configuration,
sync and chain-selection evidence; fetching a block by ID is insufficient.

| Boundary | What it can establish | Cost and remaining evidence |
|---|---|---|
| Disposable binary-decoder process | Fields derived from input bytes; per-attempt failures can remain local | Alternate parser compatibility and resource bounds must be demonstrated; this Windows probe leaves memory and CPU evidence unresolved |
| Local validating node | Selected-chain transaction semantics using that node's consensus implementation, conditional on verified configuration and sync | A long-lived JVM, chain state/storage and node maintenance become dependencies; parser/service exhaustion affects that node's availability |

Node consensus validation and resource containment answer different questions.
The pinned
[generic node parser](https://github.com/ergoplatform/ergo/blob/c36466405abc9a2ddda37e890635f00d593041f5/avldb/src/main/scala/org/ergoplatform/serialization/ErgoSerializer.scala)
also returns after parsing without checking cursor exhaustion; using the node
does not establish unique accepted wire encodings. A client should compare
node-derived objects, identities and authenticated block roots without
claiming byte canonicality from successful parsing. Failed decoding, missing
history or client response limits cannot establish omission.

The smallest independent node probe is a dedicated keyless instance with an
artifact hash and explicit validation/history/bootstrap configuration, then
bounded GET reads of the three pinned fixtures. Compare all 24 transactions,
65 outputs and their order/roots, and record best fully validated chain state.
No fixture match closes contiguous-range authentication. Per-response byte
and time budgets, node-wide OS memory/CPU bounds, disk/sync costs and behavior
on malformed block sections still need measurement. This source comparison
selects no production node version or runtime trust boundary.

## Venue and restoration work still required

A separate venue publication experiment must publish a complete recovery publication through
a pinned node, including chunk framing, canonical reassembly, duplicates,
incomplete publication and retrieval after boxes are spent. No transaction
acceptance result is claimed yet.

The restoration experiment must specify receiver-only spending authority,
authenticated encrypted openings, deterministic retry, seed-based discovery
and a complete independently retrievable evidence package. Merely adding
ciphertexts or serving public inputs without proofs is not that package.
