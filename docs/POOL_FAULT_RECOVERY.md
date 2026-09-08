# Pool fault recovery

Current research contract and evidence, 2026-09-08. No fault policy or v3
layout is selected. Runtime remains v2. The normative contracts still block
on invalid live carrying evidence; the approved historical-silence repair
in specification `c5f5464` is already implemented in the recovery model.

This document consolidates the proposal, reader contract and evidence review.
The [checked design review](../decisions/archive/2026-09-08-whole-project-design-review-check.md)
and [fault review](../decisions/archive/2026-09-08-pool-fault-review.md) retain
the independent findings. Historical drafts remain in Git history. The
specification proposal drafted from this evidence is the companion's
[`pool-fault.md`](https://github.com/mediumofexchange/money-from-first-principles/blob/main/pool-fault.md):
rules C2.10.10–13 and C2.10.9c, a revised C2b.6.1, the sentence-level
amendments and the four choices the maintainer selects. It recommends two
alternatives beyond this document's earlier recommendation, both modelled in
`model/pool-fault-alternatives.test.ts`: **D, the clock is the snapshot's**
(only a valid checkpoint carrying the backing resets its clock, so a dropped
backing's redemption opens after the duration and no other scope's evidence
is ever read), and **R7′, the segment continues from its last valid
checkpoint** (an excluded checkpoint is held and passed without ending its
segment, so an honest stale twin needs no new segment). D changes two
sentences of Construction §C2b.6; the term-only recommendation below stands
where the operator-wide clock is retained.

An independent read-only review of the proposal (Opus lane, 2026-09-08, one
probe with five cases, removed) returned ten findings, all folded into the
text: silence lapse under D depends on the classification of carrying
commitments, so the proposal's lapsed class now says so and prices the gap
verdict waiting on the snapshot's evidence (high); Construction §C2b.6's
clock-origin sentence also changes under D, added to the amendment table
(high); binding evidence digests into the history recurrence would have made
a lost original proof unrecoverable by re-proof and contradicted pool-v2 §7,
so C2.10.10 now commits a separate evidence chain bound by the snapshot digest
while the history hash stays proof-independent, and the retention cost is
priced (medium-high); a lapsed checkpoint with failing evidence is still
provable fault though no read passes it on that ground (medium); R7′ saves
the honest twin's tail only where the next valid checkpoint lands before the
gap opens, since exclusion resets nothing (medium); the segment-boundary
shortcut and the import/scope bullets of the excluded class were imprecise
(medium/low); the stranger's certificate bundle omitted the segment identity,
totals and public inputs (low). The review found no double settlement,
finality change or clock manipulation under D, confirmed hole counting and
transition selection under R7′, confirmed the receipt-comparison and
replica-corruption claims, and verified every quotation in the amendment
table.

## Recommendation and its limit

Prefer intrinsic authenticated exclusion with **term-only non-carrying
resets**, if the protocol retains its operator-wide silence clock. Excluded
carrying checkpoints do not reset that backing's clock. A non-carrying
checkpoint resets it after authenticated absence, scope and term checks,
without checking that unrelated segment's silence history or event proofs.
This is the existing opt-in `nonCarryingSilenceClosesInterval` research
branch, not a new implementation or a selected protocol rule.

This cuts one source of unrelated proof dependencies. It does not isolate
complete recovery: a carrying checkpoint still needs all its scoped terms,
canonical imports, prior faults and recovery adoption evidence. Retired
segments remain retired under C2b.4.1/3; resetting another backing's clock
does not authorize their continuation.

The cost is explicit: a stale signer for an unrelated retired segment can
keep resetting a dropped backing's clock. Existing clock tests show that
this suppresses silence redemption while leaving the non-service count and
independent replacement route available in their fixture. A″ rejects those
stale resets, but an active authorized operator can instead publish fresh,
valid unrelated openings repeatedly under either choice. New controls
exercise that case. Neither rule guarantees redemption against every faulty
operator when the declared replacement rule supplies no usable authority.
If that unconditional guarantee is required, neither candidate meets it.

Keep receipt boundaries explicit (R6): fault supplies neither inclusion nor
a canonical transition; fault alone leaves unfinished receipts pending.
Earlier finality and contradiction survive. Later canonical repair can
abandon a tail, and a real hole, term end or historical silence boundary can
lapse it. Recommend retaining this precedence instead of adding permanent
abandonment at a new fault boundary. Pending can last indefinitely when no
deciding boundary occurs; it is not proof of service or spendable value.

For service (R7), recommend ending the entire segment after an authenticated
invalid checkpoint, including a stale twin's checkpoint, while preserving
all earlier finalized prefixes. Repair opens a new segment on canonical
state. A stale signer can therefore force a restart; the rule does not solve
copied-key or rollback custody. These R6/R7 recommendations remain research
choices pending their exact normative contract.

## Candidate classification and reader contract

The failure is reproduced in `model/pool-fault-boundary.test.ts`: one
authenticated invalid carrying checkpoint blocks snapshot, count and descent,
even after replacement. A recurring invalid stream resets the normative
clock; stopping opens the gap but leaves the snapshot blocked. Earlier
finalized payments remain final. Missing bytes cannot justify an older state.

`FaultWorld` explores intrinsic authenticated exclusion. Every affected
reader uses the same classification at the checkpoint's own record prefix:

| Classification | Required evidence and consequence |
|---|---|
| Valid | Canonical descent, imports, replay and required recovery adoption pass. |
| Excluded | The signed checkpoint's exact authenticated bytes deterministically fail declared rules. No canonical state or import target; the held sequence remains occupied. |
| Unresolved | Required bytes, ancestry, scope, clock or other dependencies are missing or mismatching. No positive verdict and no rollback. Unsupported verifiers and programming failures are not fault certificates. |
| Lapsed | An independently established whole-scope term or historical silence boundary permits passing the record without treating it as canonical state. Term lapse needs scope/terms, not event proofs. |

`World.include` records witnessing and an initial diagnostic result; that
status is not venue-certified validity. `FaultWorld.record` evaluates afresh
against earlier witnessed indices plus lower same-operator sequences at its
own index, with the checkpoint itself absent. Later facts cannot fault an
earlier finalized prefix retrospectively. Restoring evidence can resolve a
previously unavailable result and permit service based on that fresh read.

`world.reader()` snapshots the record, terms, revocations, publications and
available evidence. Readers share ideal immutable checkpoint/proof identities,
not verdicts. Each owns `withheld`, `withheldDirectories`, `withheldScopes`
and `shownScopes`; clearing a withheld entry means obtaining exact evidence,
not trusting a cached assertion. Memoization lasts one read; active dependency
cycles refuse. Refresh for changed record facts, including same-index
revocation. Future-index model queries are hypothetical against the finite
snapshot, not evidence of a complete future record.

Import, descent, snapshot, count, clock, opening and both receipt readers pass
evidenced exclusions and refuse unresolved dependencies. Passed held sequences
remain occupied. An exclusion is neither receipt inclusion nor a canonical
carrying transition nor a missing-sequence repair. Publications retain force
according to their own record prefix, and a new return adopts all force through
its opening index. The semantic observer separately reads all ideal evidence
and uses hidden note openings only to check supply, authority and consumption;
ordinary readers never use those secrets to decide proof validity.

## Alternatives and costs

| Candidate | Clock rule | Cost or remaining limitation |
|---|---|---|
| D: the clock is the snapshot's (`clockIsSnapshot`, proposed) | Only a valid checkpoint carrying the backing resets its clock; `c(t)` is the snapshot's index. Non-carrying, excluded and lapsed checkpoints reset nothing. | A drop is reached by the aggravated grade after the duration, not only by the count (Construction §C2b.6 changes one sentence); the backer's duration prices a drop as darkness. Directories of every commitment in the range are still needed to authenticate carriage; no other scope's history, terms or clock is read. |
| A″ (model default) | Excluded carrying checkpoints do not reset; non-carrying checkpoints reset unless whole-scope lapsed. | Historical silence lapse recursively imports unrelated evidence dependencies. |
| Term-only non-carrying resets (recommended research branch) | As A″ for carrying checkpoints; non-carrying steps check term lapse only. | Stale unrelated signing can suppress silence. Complete recovery still has carrying/import dependencies. |
| A (first draft) | Non-carrying checkpoints must also classify valid. | Adds unrelated event history, possibly another construction, to every such clock step. |
| A′ | Excluded carrying checkpoints still reset, as C2b.6.1 currently says. | A garbage stream can suppress silence indefinitely; count/replacement is the remaining route. |
| B: prospective fault publication | A challenger publishes authenticated evidence; exclusion affects subsequent reads. | New frame, watcher and per-fault venue cost (roughly 15 KB for the proof alone, plus authentication/suffix/ancestry). Earlier force judgments cannot be reversed. |
| C: venue admission with availability | Commitments satisfy a declared availability requirement before admission/reset. | Changes the passive venue's role or adds attestors/full-data publication. Validity alone does not supply reconstruction data. |

No intrinsic rule can distinguish withheld preimages from honest replica
failure and thereby authorize rollback. Availability needs its own contract.
Selecting intrinsic exclusion affects C2b.3.1, C2b.5.2, C2b.6.1,
C2.10.3–4, C2.10.9b and v3 evidence continuity; term-only changes the
non-carrying lapse condition too; D changes Construction §C2b.6's drop
sentence and retires C2b.6.1's non-carrying reset. B adds a publication
history; C changes the venue contract. None is an incidental reader fix.

Segment continuity after an excluded checkpoint is a separate switch
(`faultContinuesSegment`): under the default R7 the segment ends and repair is
a new segment; under R7′ the segment's next checkpoint is valid where it
extends the last valid prefix. `model/pool-fault-alternatives.test.ts` shows
the honest stale twin recovering without a new segment under R7′ while the
default reads its live tail as pending and refuses the door; a bad-proof
checkpoint followed by the honest journal's valid continuation finalizes the
receipt under R7′; and replacing the faulted statement in the continuation
contradicts its receipt, so liability survives. Under D the same file shows a
dropped backing's gap opening after the duration with the count also firing,
a garbage carrying stream and fresh valid unrelated openings resetting
nothing, X's clock resolving without Y's or Z's fault evidence or scope
preimages but still refusing without their directories, and the silence
boundary retiring the old segment while an unrelated opening closes nothing.

## Dependencies exposed by the repaired clock

`model/pool-fault-dependency.test.ts` uses one operator and three disjoint
scopes, X, Y and Z, each with a five-index no-commitment duration:

| Witnessed trace | A″ read | Term-only read |
|---|---|---|
| X opening@1, Y opening@2, Z opening@4, bad Z@5, lapsed Z@10, stale Y@11 | X clock at 12 passes Y's lapse through Z's lapse to bad Z's proof; withholding that proof makes X unresolved. | Y@11 resets X without that proof. |
| Same prefix through Z@10, fresh Z opening@12, stale Y@13 | The opening lets X clock at 13 resolve without bad Z. Y@13 reintroduces the dependency at 14 through Y's historical gap at 11, although Y's current gap is closed. | Y@13 resets X without that proof. |

Thus the dependency extends beyond shared scopes and beyond the current
silence window. A later reset does not erase the evidence needed to establish
an earlier segment retirement. Withheld evidence refuses the read; it never
licenses rollback. The tests restore evidence and check the resolved clock.

The reader's dependency closure includes:

1. Authenticated complete operator record ranges, witnessed indices and
   same-index sequence order. A held sequence consumes its position even
   when excluded; a missing sequence and missing local evidence differ.
2. Authenticated directory absence or carriage, complete scope, original
   opening and replacement terms. A term-only non-carrying step stops here.
3. Under A″, current and historical silence checks for every scope backing
   of a non-carrying candidate, back to its opening, with the earlier clock
   and fault dependencies those checks recursively require.
4. For carrying candidates under either rule, classification at their own
   record prefix: canonical descent, imports, earlier segment faults, replay,
   revocation and the recovery publications required by their adoption block.

The finite ideal model's causal ordering permits these reads. It supplies no
fixed-size certificate, bounded cold-read cost or authenticated production
range service. Caching a previous verdict does not replace retained evidence
or refresh a stale record snapshot. Availability and retention remain gates.

## What the actual v2 bytes establish (R8)

`model/pool-fault-evidence.test.ts` uses real SHA-256 and Ed25519 through the
v2 implementation, with the existing oracle proof verifier. It characterizes
the pinned v2 relation; it does not exercise real proof-system soundness.

The ideal fault model freezes the exact proof object into a signed checkpoint.
V2's history instead binds semantic statement identity, note root, spent root
and position. Proof and obligor signature bytes are carried in the statement
encoding and attested by receipts, but their digests are absent from the
checkpoint's history recurrence. The tests establish:

- Replacing a proof or obligor signature with invalid bytes rejects replay
  while the original trail still validates the same signed checkpoint.
  Those replacement bytes are not a certificate of checkpoint invalidity.
- An operator can separately sign a later receipt attesting invalid proof
  bytes for an event in an earlier valid checkpoint. The receipt passes
  exact evidence attestation and semantic history inclusion. Rejecting the
  earlier checkpoint on that basis would discard valid finalized history.
  Receipt attribution alone does not bind those bytes to that checkpoint.
- A valid alternate proof preserves v2 history and the signed directory root.
  Exact encoded evidence differs; idempotent admission returns the original
  evidence hashes and original receipt. C2.10.6's semantic event identity and
  this retry behavior must survive any future evidence-binding design.

The v3 contract must authenticate which exact evidence a particular
checkpoint commits before a verifier failure can exclude it. Extending
history with evidence digests is one possible design, not a byte layout
selected here. Such a design must also say how a later checkpoint preserves
the originally committed evidence across proof variants without changing
semantic admission identity. It must not reinterpret old v2 commitments.

For an interior event in the existing linear history, authentication requires
the later recurrence inputs, not just later hash values. Each later v2 event
needs 104 bytes: statement hash, note root, spent root and position; deriving
position from order reduces this to 96. Appending two 32-byte evidence
digests would make those conditional sizes 168 or 160 bytes per later event,
before framing, target bytes, directory proof and ancestry. The tests
reconstruct the real three-event history and show that changing any later
input changes the terminal hash. This is a linear suffix cost, not a bounded
fault certificate or a selected v3 format.

## Receipt and stale-twin controls

`model/pool-fault-liability.test.ts` adds ideal operator-attributed hostile
receipt fixtures referencing the actual fault sequence. The model does not
authenticate receipt signatures; real receipt binding is tested separately
above. Fault alone leaves the hostile tail pending; historical silence
lapses it while an earlier final receipt remains final. Earlier contradiction
also survives a later fault. A stale twin after multiple X/Y events faults
future service while every earlier checkpoint remains importable and its
receipts remain final. These characterize the candidate; they do not select
new liability rules or establish production issuance behavior.

## Next implementation boundary

The specification proposal exists (`pool-fault.md` in the companion). The
maintainer selects among its four choices; the amendments it lists are then
applied to the normative documents, independently reviewed, and the model's
switches collapse to the selected rules before any v3 layout is frozen.
Scope the progress claim to available authenticated evidence and the declared
remedy; measure suffix/ancestry retention and retrieval rather than assuming
bounded cost from one proof verification. Complete evidence availability,
note delivery/restoration and custody still need deployment evidence.

## Regression map

| Tests | Evidence retained |
|---|---|
| `pool-fault-boundary.test.ts`, `pool-fault.test.ts` | Original blocked-recovery case, intrinsic remedy, unresolved-evidence rollback and reversed-verdict departures. |
| `pool-fault-reader.test.ts` | Independent snapshots, arrival order, retention, malformed/scope evidence, repair paths and same-index revocation; 27 reader regressions. |
| `pool-fault-clock.test.ts`, `pool-fault-dependency.test.ts` | Strict clock boundary, term lapse, suppression, unrelated recursive and historical dependencies, force and adoption controls. |
| `pool-fault-liability.test.ts`, `pool-fault-evidence.test.ts` | R6/R7 candidate consequences and real v2 hash/signature evidence limits described above. |
| `pool-fault-alternatives.test.ts` | D (the clock is the snapshot's) and R7′ (segment continuity) against the defaults: the dropped backing's clock, count, redemption and return; garbage and unrelated resets; disjoint-scope evidence; the silence boundary; the honest twin; bad proof then valid continuation; the replaced statement. |
| `pool-recovery-return.test.ts`, `pool-silence.test.ts` | Approved historical retirement, delayed-adoption refusal, receipt precedence and original unsafe return under `forgetSilence`. |

All files are in `model/`. The checked baseline at `f3ca8b4` passed
85 files / 1,606 tests plus typecheck, build, package, pilot and pool-store
crash checks. That is bounded executable evidence, not production readiness.
The accepted historical-silence rule and its costs are in the
[decision log](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts).
