# Adversarial review of the invalid-checkpoint candidate, 2026-09-08

Reviewed reference `6de607b` (candidate implementation from `4587de9`) and
companion specification `main` at `3676757`. Two independent reviewers
examined dependency closure and segment/receipt semantics in separate lanes;
the primary agent inspected their probes and reran both. The silence-lapse
finding was then independently checked by the receipt reviewer as well.
This is a bounded protocol/model review, not a deployment security audit.

**Result:** do not turn the current candidate into normative text. The
[proposal](https://github.com/mediumofexchange/reference-ts/blob/f3ca8b4/docs/POOL_FAULT_RECOVERY_PROPOSAL.md) identifies a real
recovery failure, but its recommendation understates a dependency on other
scopes, its model mixes recorded facts with reader knowledge, and several
receipt paths do not implement its stated policy. No protocol choice was
made and neither the specification nor runtime was changed.

**Follow-up:** the [reader repair](https://github.com/mediumofexchange/reference-ts/blob/b6a0970/docs/POOL_FAULT_RECOVERY.md#candidate-classification-and-reader-contract) separates
witnessing from per-reader validation, fixes R2–R5, and makes R1's dependency
explicit. Independent review of those changes found and verified further
service, observer, malformed-header and supplied-repair fixes. R1's design
cost and R6–R8's policy/layout choices remain open. The findings and traces
below describe the reviewed `6de607b` baseline.

## R1 — High: silence lapse introduces the other scope's evidence

The A″ comparison claims no new dependency on other scopes. C2b.6.1,
however, excludes whole-scope lapses even from a non-carrying commitment's
effect on a backing's clock. C2b.4.1 decides silence lapse by reading the
commitment's own scope's gap. With intrinsic exclusion, that gap can depend
on authenticated fault evidence rather than public record emptiness alone.

Reproduced with operator P and no-commitment duration 5 for X and Y:

| Index | Witnessed record or read |
|---|---|
| 1 | Valid XY opening. |
| 2 | Valid Y-only opening; P has dropped X. |
| 3 | Y-only checkpoint with an authenticated invalid proof. |
| 8 | Y-only continuation. It lapses because Y's last valid close is 2 and `8 - 2 > 5`. |
| 9 | X's clock passes the lapsed record at 8 and closes at 3; X's gap is open. |

Remove the reader's evidence for checkpoint 3. Y's gap at 8 becomes
unresolved, so the reader cannot establish that checkpoint 8 lapsed. Yet
`FaultWorld.classification` returns its cached `lapsed` verdict immediately
(`model/pool-fault.ts:52`), and `closing` skips it on recorded status
(`:120`). X still gets a positive gap verdict. A fresh reader needs Y's
fault evidence to justify that step. Both independent reviewers confirmed
this dependency; it cannot be removed by fixing the cache alone.

**Required:** distinguish term-end lapse from evidence-dependent silence
lapse and resolve the latter's dependencies. Amend the proposal's costs and
include C2b.4.1 in its specification impact. Accepting that dependency is one
possible design; eliminating it requires a different, explicitly modelled
clock/lapse rule. Do not count every non-carrying lapsed commitment as a
reset without checking the effect on the existing whole-scope lapse rule.

## R2 — High: evidence arriving after the first read cannot resolve it

`World.include` records a reader's refusal as an invalid checkpoint with a
reason (`model/pool-authority.ts:548`); `FaultWorld.own` reads only that
recorded verdict (`model/pool-fault.ts:75`).

Reproduction: valid opening at 1; sign an otherwise valid issuance
continuation; withhold the opening; witness the continuation at 2. Its reason
is `unresolved clock`. Restore the opening: the opening classifies valid,
but the continuation stays unresolved and snapshot selection still refuses.
The nine candidate cases withhold bytes after the model has computed a
verdict; they do not test evidence absent on first examination.

**Required:** separate immutable witnessing from evidence-dependent
validation. Re-read unresolved checkpoints against their original record
prefix when evidence arrives. This is an inherited model limitation exposed
by the candidate's advertised resolution property, not evidence of a runtime
v2 regression.

## R3 — Medium: import and finality paths disagree about dependencies

`World.import` checks cached final state and named imports
(`model/pool-authority.ts:392`), but not excluded checkpoints crossed by
descent. The private `canonical` helper inherits that gap (`:671`), and the
receipt's initial comparison bypasses candidate classification (`:637`).

Reproduced: opening at 1, issuance at 2, evidenced fault at 3, valid repair
opening at 4, valid issuance child at 5. Withhold the fault at 3. The repair
and child classify unresolved, but `import(child)` returns state. A
valid-context receipt naming the containing child as `after` returns final.
A further opening prepared while evidence was available can be witnessed as
`final` at 6 after the evidence is withheld; that same opening immediately
classifies unresolved.

Previously proven inclusion can legitimately survive loss of a source if
the reader retains sufficient validated provenance. The model does not
represent that retention separately from its reduced-evidence reader.
**Required:** make retained evidence explicit, or require the same complete
dependency closure for fresh import, receipt and opening validation. Do not
interpret a cached status alone as a fresh reader's proof. No rollback or
theft was demonstrated by this trace.

## R4 — Medium: the non-carrying clock branch lacks authenticated absence

With XY opening at 1 and Y-only opening at 2, withhold the latter's directory.
Its classification becomes unresolved and X's descent refuses `unavailable
directory`, but X's clock still returns 2 (`model/pool-fault.ts:122`).

Avoiding the other scope's history does not remove the need to authenticate
that the commitment carries nothing for X. **Required:** authenticate
carriage before choosing that branch, and check the same filtering in
classification and snapshot selection.

## R5 — High: receipt selection does not pass every excluded checkpoint

Two paths call `canonical` directly and throw `not finalized`:

- Opening sequence/index 1/1; excluded checkpoint 2/2; excluded new segment
  3/3; valid new segment 4/4. A receipt with `after = 1` passes 2, then blocks
  on 3 instead of reaching the canonical transition
  (`model/pool-authority.ts:650`).
- Opening 1/1; faulty checkpoint 2 signed; another receipt accepted while
  that checkpoint is in flight, naming `after = 2`; checkpoint 2 excluded at
  index 2; valid repair 3/3. Classification blocks on its excluded base
  (`:637`).

**Required:** apply exclusion and unresolved-evidence handling to the base
and different-segment transition selection as well as same-segment records.
An excluded transition consumes a sequence but is not a canonical repair or
abandonment boundary. Exact repair-hole counting must use that same walk.

## R6 — Material choice: when fault abandons a receipt, and for how long

The proposal says a faulted tail is abandoned with no repair excuse. The
model establishes neither immediate nor permanent abandonment:

- Opening 1/1; excluded checkpoint 2/2; continuation sequence 3 signed but
  unheld; canonical opening 4/4. The tail receipt is `lapsed / repair`.
- Opening 1/1; excluded checkpoint 2/2. The receipt is `pending`. Announce
  replacement at 2, effective at 5; it becomes `lapsed / scope-boundary`.

The later hole and term-end branches are `model/pool-authority.ts:651–656`.
These traces contradict the proposal's unconditional language, but selecting
new precedence is a protocol choice, not a mechanical test fix.

If persistent fault accountability is intended, the review recommends:

> Read prior final inclusion and contradiction first. An evidenced excluded
> checkpoint of the receipt's segment, witnessed while every original scope
> term remains live and before an earlier decisive transition, abandons the
> remaining unfinalized receipts. Subsequent missing sequences or term ends
> do not excuse that abandonment. Earlier finalized holdings, contradiction
> evidence, and already established lapse remain unchanged.

This is proposed wording, not an adopted rule. Its applicability to receipts
signed after the faulty checkpoint, receipt `after` resolution, and prior
lapse must be made precise in the model before specification text. The
alternative is to retain later canonical-transition precedence and narrow
the proposal's accountability claim accordingly.

## R7 — Material choice: a stale twin ends the segment's future service

Reproduced: opening 1/1; valid issuance 2/2; an empty stale twin signed at the
next sequence and witnessed 3/3 is excluded for `rewritten prefix`. The next
honest continuation 4/4 is excluded for `faulted segment`. The previously
final issuance receipt stays final.

This is a conservative, coherent policy with a cost: a later signature error
forces all scoped backings into a new segment. C2.10.6's common-history
consistency does not alone imply that every invalid checkpoint terminates
its segment. Recommend stating and selecting this rule expressly, including
stale twins, while preserving all earlier finalized prefixes.

## R8 — Certificate evidence is larger than the sketch claims

The proposal said an interior history proof needs one 32-byte link per later
statement. Pool-v2 §9's recurrence also needs that step's `statementHash`,
`noteRoot`, `spentRoot` and position: 104 bytes, or 96 when position is
derived. Appending `proofHash` and `signatureHash` directly makes that 168
bytes, or 160 with derived position. Later history hashes alone do not bind
the claimed interior event to the committed terminal hash.

These are conditional recurrence costs, not a selected certificate format.
The proposal now says so. V3 must also specify how exact evidence binding
interacts with C2.10.6's proof-independent statement identity, prefix
continuity and idempotent admission. No new hash layout was selected.

## Verification and next work

- Node 24.6.0 / Vitest 3.2.7: the existing authority, recovery, fault-boundary
  and fault suites passed, **4 files / 134 tests**.
- The primary agent reran the receipt reviewer's **5/5** probes. They assert
  the current counterexamples, not that the candidate meets the proposal.
- The dependency probe reproduced R1–R4 and the initial receipt comparison
  variant. The primary agent reran it; the second reviewer also reran R1.
- Temporary probes were under ignored `scratch/`. Their traces and results
  are captured here; those probes were removed. Documentation/link checks and
  `git diff --check` passed. No full build, real-proof circuit check or runtime audit was
  needed for this documentation-only slice.

Next, model witnessing separately from reader validation, with two readers
examining the same signed record in different evidence-arrival orders.
Exercise term and silence lapses separately, same-index sequence order,
transitive imports, all receipt selection branches and retained provenance.
Compare accepting the complete dependency closure with alternatives to the
clock/lapse rule. Then present that priced choice together with R6/R7; obtain
the selected design before normative edits, and independently review
the critical changes. The specification remains `main` at `3676757`; the
review branch is `docs/pool-fault-review`.
