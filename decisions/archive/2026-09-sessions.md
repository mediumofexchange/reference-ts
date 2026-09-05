# Session records — 2026-09

Handoffs, review rounds and session closes moved out of the decision log on
2026-09-05. They are history, not decisions: nothing here states a standing
rule that the indexed entries do not. Kept for the reasoning, unindexed.

---

## 2026-09-04 — Handoff: slice 39 is built, reviewed, fixed by panel, and owes one verification

**Status: `slice/39-the-blind-window` is built, reviewed by three Opus angles,
its two blocking findings put to a two-angle Opus fix panel, fixed, and the
fixes reviewed once by the mutation sweep — which found three of the fix's own
rules unpinned and one unobservable. It is NOT merged, and it owes an
independent verification of the fix round that this session launched and could
not finish.** A fresh instance picks it up here.

**What the branch holds** (`git log --oneline main..HEAD`): the panel record;
the era, the window and the floor; the seat's provenance test; the review's
first fixes; the fix round; CLAUDE.md's rules; the round record; the fix
round's own review. The spec branch `spec/the-blind-window` holds four
commits on §C2 and §C2b.

**The mechanism, in one sentence:** an operator serves the book its own
signature put the record on, holding one commitment in flight that expires at
the venue's lag; a receipt names the commitment its operator last SIGNED, and
the record answers three ways about it — it holds it, it has not reached it,
or it moved past it without ever holding it; a venue's record for one key
rises in sequence as it rises in index; and a replacement's lead is floored at
twice the venue's lag plus one.

**The numbers:** 962 tests green; refusals on Ergo 50/70/81 % → **zero** at
depths 1/3/6; the commit cadence an index faster than main; the witnessing
interval's floor down from the lag to the depth, which makes §C2's "a floor
under the interval" sentence true for the first time.

**What is owed, in order:**

1. **The verification of the fix round.** Its brief is
   `scratch/panel39/review/VERIFY-BRIEF.md`, written for an Opus angle; the
   session that wrote it launched one and hit its limit. If
   `scratch/panel39/review/verify.md` exists, read it first — otherwise run it.
   Every fix round in this project's history has found a real bug in the
   fixes, and this one already found three in its own sweep.
2. **The mutation sweep, re-run.** `scratch/panel39/mutants.sh` was changed
   with the last commit (a superseded mutant dropped, the ordering mutant
   re-aimed, the tiebreak mutant retired with its mechanism) and was
   restarting as this session ended. Nineteen mutants, whole suite each. The
   log is `scratch/panel39/mutants.log`; check it is complete and that every
   mutant dies.
3. **A grade over the hole a skipped sequence leaves.** This is the price the
   fix panel measured and accepted: an operator can decline to broadcast a
   commitment and stamp receipts with that era, unbounded, free, every public
   grade reading healthy. The hole is permanent and countable from reads the
   `Venue` contract already has, and nothing reads it. It is a slice.

**Residues, recorded, do not lose:** `eraIndex` cannot name the earlier of two
commitments sharing an index — a read by sequence (`witnessedAtSequence`)
would name it exactly, and both fix-panel angles proposed it; `lag()` is an
unbounded lever on the co-signing path whose cautious-looking direction is the
dangerous one; the commit-before-register hole is narrowed by the boot wait
and not closed, and wants its own door; under the extend rule one box at an
absurd sequence from a **stolen** key censors that key's later commitments,
priced by `isSilent` firing; `Venue.nextSequenceFor` now has one production
caller reading it as a floor and could leave the interface; the payee has no
reader for "is this operator inside its own window"; a reorg deeper than the
declared depth moves the kept record sideways, out of contract and undetected;
and `serves` gained a venue read on the hottest path with nobody timing it.

**From before this slice, still standing:** the platform Ed25519 verifier and
the commitment-root framing, each recommended next with a panel first; the
`replacementCountFor` Venue method and the drifting clock, deferred;
`settledInPart`'s double walk; `isNamedSuccessor`'s second venue read;
`ErgoVenue.publishedOpsFor` and `revocationsFor` handing out stored objects;
persistence of verdicts across restarts; the sharded-key party rule; and the
Ergo write side, which is where the operator's own durable sequence count
belongs.

**Where the reasoning is:** the two entries above this one, and under
`scratch/panel39/`: three design-panel reports, three review reports, two
fix-panel reports, the briefs, and the probes and builds beside each.

## 2026-09-04 — The slice-39 round: the window held, the era did not, and the fix panel that found the record's third answer

**Status: the review round for slice 39 — three Opus angles over the build,
a two-angle Opus fix panel over the two blocking findings, and the fixes.**
Reports and probes under `scratch/panel39/review/`. The slice is NOT merged;
the merge and the push are the maintainer's calls, and the spec branch
`spec/the-blind-window` is read against the code before either.

**The one-line outcome.** The window half stood: an operator serves the book
its own signature put the record on, the twin is still caught at the index it
always was, and the refusal rate on Ergo is zero at every depth. The era half
did not. Naming the commitment rather than the index was necessary — all
three design-panel angles measured that — but it moved every reader onto an
ordering the shipped venue does not have, and it had no answer for the one
case the slice exists to survive: a commitment the chain never takes.

**What the three angles found, each probe-proven:**

- **The spec angle** — no defect in the mechanism, and better numbers than
  the panel predicted: refusals 50/70/81 % → **zero** at depths 1/3/6, the
  commit cadence an index *faster* than main, and the witnessing interval's
  floor falling from the lag to the depth, which makes §C2's "a floor under
  the interval" sentence true for the first time. Four blocking findings, all
  prose: the binding rule for `serves` described the door the slice replaced;
  the payee's era rule compared a sequence to an index; the handover party
  rule told an operator to commit at a clock where it is usually refused; and
  the era contradicted a live §C2b sentence the branch never touched, while
  the panel entry claimed that section had been changed. It also caught three
  errors in my own floor reasoning — the cadence, the minimum lead, and a
  guard I had recorded as deleted that is kept as an arm — each corrected
  against a sweep of the axis that matters, which is where the rule-holder
  puts its record rather than how the operator paces itself.
- **The inventory angle** — two blocking, both regressions. A dropped
  commitment leaves a permanent hole in the record's sequence space, an era
  naming the hole read `unrelated`, and `unrelated` does not excuse: the
  operator's own honest receipts convicted it of a double position the moment
  the repair re-let the position. And `eraIndex` keyed on the record's last
  **by height**, so one keyless replay of bytes the operator already published
  turned a lapsed pair into a fault proof. Both false on `main`, where the era
  was an index no later box could move. It also found `unrelated` had
  re-merged with `dropped` — the defect slice 11 closed, at the same layer —
  that the "one ahead" bound is reached by the operator's own honest signature
  and widens by one per drop, and that the estate's own `provable-fault` file
  never leaves the genesis era, so the readers whose meaning the slice changed
  were tested only on the one input the change does not touch.
- **The security angle** — the same two blocking findings from the other end,
  plus: the boot wait's stated property is false (a mempool keeps what a
  restart published, so it is neither readable nor gone); the wait is armed by
  `register`, so a process that commits before registering anything is
  unguarded and roots a rewritten history against its own key; `lag()` on the
  door path is a linear unbounded lever whose *cautious-looking* direction is
  the dangerous one; and one operator's era went backwards in time after a
  repair, so a payee applying the freshness rule took the dead receipt and
  refused the live one.

**The fix panel** (`review/FIX-BRIEF.md`, `review/fixpanel-{security,inventory}.md`),
over the pair, with prototypes of every candidate run against every
reviewer's fixture. **C — never skip the sequence — manufactures the
equivocation it was meant to avoid and closes neither finding. F — widen what
excuses — is a free excuse costing the liar nothing at all, and is the fourth
predicate this repository's own test refuses.** Both ruled out by two angles
independently. What survived is a pair:

1. **A — a venue's record for one key rises in sequence as it rises in
   index**, in the `Venue` contract and enforced where the Ergo view reads
   boxes, sorted by index then by sequence so two commitments of one key in
   one block read the same way whatever order a node returns them. Nine
   readers already assumed it and `fault.ts` states the reliance in prose;
   this gives it an owner. Only A reaches `commit`'s own sequence, which is
   why no reader-side fix substitutes for it.
2. **B′ — the record has three answers about an era, not two**: it holds the
   commitment, it has not reached it, or it moved past it without ever
   holding it. The third is what a dropped transaction leaves, and it means
   the commitment died and took its tail — §C2b's return from silence under
   the declared duration, which is what an expiry is.

**The inventory angle's decisive catch, and why the panel rule exists.** The
first shape of B merged the last two answers into one blanket lapse. That
shuts the operator's **own** co-signing door, because `shut` asks the same
predicate about the era the operator is stamping right now — the blind window
back by another road, from the second dropped commitment onward. Keeping the
answers apart is exactly what the operator's own era can never be: its era is
one past what it has *signed*, so its target is either the record's highest or
beyond it, never a sequence the record stepped over.

**Also taken:** the `"ahead"` answer is now unbounded, because the gap between
what an operator signed and what the record holds widens by one per dropped
commitment and the old bound of one called an honest operator's own receipts
forgeries from its second drop on — one shipped claim amended rather than
extended; the era an operator stamps is one past what it has SIGNED, the
quantity `commit` already writes, so its era never runs backwards; and
`commit` arms the boot wait as well as `register`, which narrows the
commit-before-register hole rather than closing it.

**What the fix does not close, and it is the price both angles measured.** An
operator can decline to broadcast a commitment and stamp receipts with that
era: unbounded receipts on one skipped sequence, no fee, every public grade
reading healthy. No bound separates that from an honest dropped transaction,
because the two records are byte-identical, and the dead commitment cannot be
put on the record because publishing it would convict the honest operator who
lost it. What is bought back is that the hole is **permanent and countable** —
the same shape as the silence grade that already prices laundering by going
dark. A holes-per-commitment grade is available from reads the contract
already has; it is a slice, not a fix, and it is owed.

**What this round makes false in the panel entry above:** its decision 4 (the
one-per-witnessed-index guard is kept as an arm, not deleted — and it is
pinned now, where the panel had filed it as unpinned by the whole estate);
its cadence figure of one commitment per lag+1, which is one per lag; its
claim that only `2·lag+1` leaves a safe clock, when `2·lag` does and the
shipped number is one index of slack that keeps lag zero free of a special
case; its residue that a dropped commitment's window receipts read `pending`,
"the excusing direction", which was true only until the repair landed; and
its spec-change line, which named §C2b although the branch touched only §C2.

**Residues, recorded for the handoff:** the park above; `lag()` as an
unbounded lever on the door path, whose cautious direction is the dangerous
one; `eraIndex` cannot name the earlier of two commitments sharing an index,
which A makes an excuse rather than an accusation and which a
`witnessedAtSequence` read would close exactly; under A one box at an absurd
sequence from a *stolen* key censors that key's later commitments, priced by
`isSilent` firing; the commit-before-register hole, narrowed not closed;
`Venue.nextSequenceFor` now has one production caller reading it as a floor
and could leave the interface; the payee still has no reader for "is this
operator inside its own window"; and a reorg deeper than the declared depth
moves the kept record sideways on any venue, which is out of contract and
undetected.

## 2026-09-04 — Handoff: slice 38 is built, reviewed, fixed five times over, and waits on the maintainer

**Status: `slice/38-the-lead-time` is built, reviewed by three Opus angles,
its one design finding put to a two-angle Opus fix panel, its fixes
verified twice by a further angle, and the last batch — wording only,
applying the second verification's own prototyped cut — checked by the
docs budget and the suite with no further agent round (the maintainer's to
demand). It is NOT merged: the merge and the push are the maintainer's
calls, and the spec branch `spec/the-lead-floor` on the paper repo (five
commits, not pushed) is read against the code before either merges.** A
fresh instance picks it up here.

**What the branch holds, oldest first** (`git log --oneline main..HEAD`):
the maintainer's decisions on slice 37's flags; the build — the floor,
`Venue.lag()`, a door since removed, the lagging test double, the tests,
twenty-three fixtures moved by one index; the panel record; CLAUDE.md's
rules; five fix batches; the round record; this handoff.

**The mechanism, in one sentence:** a replacement's lead is floored at the
venue's lag plus one — the lag a constant of the venue's finality rule that
its id must bind — judged once per record against the venue that answered
it, so every party reads the record by the last clock at which an act it
signs can still be witnessed in the incumbent's term; what a party does
with that index is its own, in the three clauses of CLAUDE.md's party rule,
and §C2 says what a rolling record can buy against a party's caution.

**The numbers:** 944 tests green; the sweep at `scratch/panel38/mutants.log`
kills every comparison the slice keeps (five mutants; the one seating a
successor the lag early dies to five tests); the same-block erasure is
refused on a venue with no lag; on a lagging venue the floor gives exactly
one safe clock to commit in, which the panel's and both verifications'
runs agree on, and which the F11 slice must protect.

**Spec change:** `spec/the-lead-floor`, five commits on §C2: the lag
defined beside the finality rule and bound to the venue's name; the floor;
the property at the venue's own speed; the revocation carve-out and the
window at the floor; the handover as the parties' to do, with what a
rolling record buys against a party's caution said. Not pushed.

**Owed beyond this slice, recorded, do not lose:**

- **F11 and the one-commitment-per-index guard on a lagging venue**, its own
  slice and now load-bearing: `serves` reads stale for the lag after every
  commit, the guard is blind to a commitment in flight (two signed at one
  clock land at one index), and together they can take away the floor's
  one safe clock. The floor is sized for a sequencer that can commit at
  every clock; that slice restores the assumption, and the party rule's
  "one window of dead co-signatures" becomes exact with it.
- **The payee's reader**: `receiptStatus` answers `witnessed` against a
  state no successor takes on; nothing named computes "who is in force
  where my act lands"; and nothing named shows a link re-armed — the walk
  resolves superseded records away, and only `replacementsFor` shows them.
- **The rolling record against a party's caution** — moved, not closed. The
  door fallback (bound supersession at the lag, with the floor raised to
  `2·lag + 1` to keep the revocation window) is recorded with its six
  drafted tests under `scratch/panel38/review/fixpanel/inventory/probes/`.
- **`ErgoVenue.nextSequenceFor`** answers from the finalised height and would
  sign two roots at one sequence once a write side exists — the Ergo
  write-side slice's, beside the drifting clock.
- **The `LaggingView` double** shares its chain's `id` deliberately, against
  the contract it models; `ErgoVenue` refuses to publish, so every lagging
  number in this slice comes from the double.
- §C2b's rescue carries the floor unsaid; "the three holder rules" was never
  re-counted; the lag and a record's reported index are declared, not
  checked; a venue with a probabilistic finality gadget declares its own
  number.
- **From before this slice, still standing**: the platform Ed25519 verifier
  and the root framing (recommended next, each with a panel first); the
  count method and the drifting clock (deferred); `settledInPart`'s double
  walk; `isNamedSuccessor`'s second venue read; `ErgoVenue.publishedOpsFor`
  and `revocationsFor` handing out stored objects; persistence of verdicts
  across restarts; the sharded-key party rule; the frontier loop's cost
  against a real node.

**Where the reasoning is:** the panel entry ("Panel: the lead time", whose
status line says what the round changed), the round entry ("The slice-38
round"), and under `scratch/panel38/`: three panel reports, three review
reports, the fix panel's brief and two reports, two verifications, and the
probes and builds beside each.

## 2026-09-04 — The slice-38 round: the floor held, the door was a lever, and the fixes

**Status: the review round for slice 38 — three Opus angles over the build,
a two-angle Opus fix panel over the one finding that turned on a design
decision, four fix batches, an Opus verification of the first three and a
second of the fourth (recorded in the handoff entry above).** Reports and
probes under `scratch/panel38/review/`. The slice is NOT merged; the merge
and the push are the maintainer's calls.

**The one-line outcome.** The floor stood every angle's attack: a
replacement's lead is at least the venue's lag plus one, judged once per
record, and no reviewer moved an erasure outcome by touching it. The door
did not: `Sequencer.retiring` — the co-signing door refusing while a
handover takes force within the lag — was a lever, and it is gone. What
the door did is now the parties' to do; the reference implementation's
party rule says so in three clauses, and §C2 says what that leaves open.

**What the three angles found, and what was done:**

- **The spec angle** (`review/spec.md`) — one blocking, five should-fix.
  BLOCKING: §C2's own sentence "until the effective index the predecessor
  governs and goes on serving — a handover that froze the backing in between
  would hand any named successor a stall" contradicted the door clause the
  slice added twenty-six sentences earlier; on a lagging venue the two could
  not both be built. Resolved by the door's removal, which made the old
  sentence true again. Should-fix, all done: the property sentence "the
  record precedes, on every party's clock, every act it can void" was true
  only at the venue's minimum inclusion delay (a slow block carries a
  commitment signed before the record past the index — probed) and now says
  what the floor buys, one index of notice at the venue's own speed, in §C2,
  CLAUDE.md, the Venue contract and `admitted`; three docstrings still quoted
  the retired two-stage rule; "a constant of the venue's identity" was false
  of the test double, which shares its chain's id — the contract now requires
  the id to bind the lag, in the same voice as the append-only clause; the
  party rule said "a handover naming you", which in this repo's vocabulary is
  the successor. Residues taken: "its index is otherwise inert" became "inert
  as a date, and a name in the same-index tie"; the decision entry's count of
  re-shaped tests was off by one. Left: §C2b's rescue now carries the floor
  and §C2b does not say so; "the three holder rules" was never re-counted.
- **The inventory angle** (`review/inventory.md`) — no defect in `src/`;
  one blocking in the test estate. BLOCKING: the only fixture in the suite
  for the key-hopping attack on the silence clock ("is not cancelled by
  hopping to a throwaway key and back") had both its records dated at their
  own witnessing, so the floor refused them and the hop never happened; the
  test passed with nobody hopped. Re-dated, and mutation-proven to kill the
  clock that restarts at a handover. Should-fix, done: "refuses a handover
  to the incumbent itself" was refused by the floor before the walk's own
  rule (mutation-proven: the rule lost that killer), re-dated; the claim
  that a retiring operator's commitment still carries the book had no test,
  and a mutation making the operator drop the backing survived the whole
  suite — a test now pins that a commitment witnessed at the effective index
  carries the book, lands out of its term, is not the book, and accuses
  nobody. Found in passing and fixed: "ignores a replacement that names the
  wrong predecessor" had been refused by the void rule since before this
  slice. Recorded: such a commitment can never cure its publisher's own
  silence; a receipt for an act co-signed just before a handover reads
  `witnessed` against the retiring operator's own out-of-term state and
  `lapsed` against the successor's.
- **The security angle** (`review/security.md`) — three blocking. S1: the
  door guards co-signatures, but the erased object is the commitment;
  removing the door changed no cell of a sixteen-row erasure matrix. S2:
  the floor buys exactly one safe clock to commit in, and two existing
  rules can take it away — the one-commitment-per-index guard fires when
  the operator's previous commitment happens to land at the record's
  index, and the post-commit blind window (`serves` reads its own
  commitment only once finalised, the panel's F11) forces an operator on a
  lagging venue to commit at most once every `lag + 1` indices. S3: **the
  rolling-record lever** — publish a record dated the floor, supersede it
  one index before it arrives, repeat: the incumbent's door shut `lag − 1`
  indices in every `lag`, indefinitely, for one publication per `lag`
  indices, with the incumbent in force, no gap open, no grade firing.
  Should-fix: the door refused `submitWithdrawal`, §C3's unilateral abort;
  `adopt` and `caughtUp` co-signed inside the window through a path the
  door never guarded; the contract could not bind the lag to the id; the
  test double landed writes in the current block, one less than the venue
  it models, and the decisive test passed at a lead below a real venue's
  floor. Residue: a co-signed revocation in the same block as the handover
  wins or loses on the hash tie; F11's width is exactly the lag.

**The fix panel** (`review/FIX-BRIEF.md`, `review/fixpanel-{security,inventory}.md`),
over S3, with prototypes of every candidate: A, bound supersession at the
lag (a record is final from the clock the door would close on it); B,
remove the door; C, a door that reads only a record that can no longer be
superseded; D, grade the roller. Both angles measured the same facts. A
closes the roller completely — a proof, and 800 random schedules at four
depths with no freeze — and costs the revocation window `lag` clocks: at
every lead below `2·lag + 1` a rule-holder cannot take back a handover it
can see, the floor is `lag + 1`, and the exemption for a self-naming record
cannot be moved outside the bound (outside, the roller returns at exactly
the old efficiency). A has no killer anywhere in the estate and puts the
venue's lag into the ordering rule, so two views declaring two lags seat
two different keys at a past index. B changes no erasure outcome, restores
the withdrawal, and its party rule reproduces the door's decision at every
clock from `successionAhead` and `lag()`. C degenerates to the shipped door
or to B in every precise reading. The angles split on the judgement —
security for A, inventory for B.

**The decision — B, the session model's.** Both angles showed the erasure
closure does not depend on the door. The door's one benefit, refusing acts
that can only die, is computable by the party from public readers and was
already written as a party rule. What made the door a lever is its shape:
a door a third party's free record can shut. `shut`, the door it was built
to resemble, reads the operator's own silence, which nobody else can
manufacture; that is the shape a door may have. CLAUDE.md's design rule
says the rest: a fix that layers a second mechanism to patch the first's
gap is a signal the first is in the wrong place — the supersession bound
was that layer. Removing the door also returns the slice to the
maintainer's framing (the floor) and gives the holder back §C3's abort.
**A stands recorded as the fallback** if a door is wanted: with the floor
raised to `2·lag + 1` (the inventory's A3) it keeps the revocation window,
and the six drafted tests under `review/fixpanel/inventory/probes/` are
what it would need.

**What the verification of the fixes found** (`review/verify.md`), and the
correction it forced: the party rule that replaced the door reproduces the
door's refusal pattern under the rolling record, index for index — a party
that follows it to the letter is stopped by a rule-holder that never lets
a record arrive — so §C2's clause "a door only its own conduct can shut is
the shape a door may have" claimed of the rule what was true only of the
code. **S3 is therefore recorded as MOVED, not closed:** the lever's target
went from a mechanism, which cannot decline, to a party's caution, which
can. A party that reads a link re-armed as re-armed keeps serving, at the
price of one window of dead co-signatures should the next record be real;
the record shows which, and nothing here grades either. §C2 now says
exactly that. The verification also found five more quotations of the
retired two-stage sentence, "before the last clock" one index optimistic
at the floor ("by"), the fix panel's own rider unfulfilled (`submitLeg`
reads the demanded backing's record — the party rule now says "on or under
that backing"), §C2's middle lag shape with its only exemplar retired by
the same round (dropped), and the double's `nextSequenceFor` counting
in-flight commitments where `ErgoVenue`'s does not — pinned, and named as
the one method not `ErgoVenue`'s. All taken in the fourth batch.

**What this round makes false in the panel entry above**, so nobody reads
it unwarned: its point 2 (the door) wholesale, including "without it the
floor is theatre"; "no candidate makes two honest readers disagree" (the
shipped rule is a function of the reader's declared lag, which the
contract now requires the id to bind); "the record precedes, on every
party's clock, every act it can void" (one index of notice, at the venue's
own speed); "a lagging venue prices a handover at a stall of the lag" (no
act is refused there now — the stall is the party's own conduct); "its
index is inert" (as a date); the double's lag being its depth (it is the
depth plus one, and writes land in the next block); the fixture counts
(four more records across three more tests were re-dated by the review,
and thirteen tests were added, not nine); the party rule's wording.

**The four fix batches** (`git log`, the four commits after the build):
the re-dated fixtures and the docstrings; the wording of the property, the
contract and the party rule; the door's removal, with the test double made
faithful and the lead-time tests rebuilt on the floor and the party rules —
the rule computed from the public readers, the cost of ignoring it
measured, the doors pinned to the effective index against a door that would
open the successor's early; the verification's findings. The suite is 944;
the sweep at `scratch/panel38/mutants.log` kills every comparison the slice
keeps, the early-seat mutant by five tests.

**Residues, recorded for the handoff:** the rolling record against a
party's caution (above); F11 and the one-commitment-per-index guard on a
lagging venue — the guard is blind to a commitment in flight, so two signed
at one clock land at one index, and together they can take away the
floor's one safe clock (security's S2): the floor is sized for a sequencer
that can commit at every clock, and that slice restores the assumption;
the payee's reader (`receiptStatus` answers `witnessed` against an
out-of-term state, and nothing named computes "who is in force where my
act lands") — now the payee's whole defence; §C2b's rescue carries the
floor unsaid; the lag and the index a view reports are declared, not
checked; a venue with a probabilistic finality gadget declares its own
number; `ErgoVenue.nextSequenceFor` answers from the finalised height and
would sign two roots at one sequence once a write side exists; the
roller's visible cousin — a handover to a key that never serves — is the
freeze the backer always had, and every grade reaches it.

## 2026-09-03 — Handoff: slice 37 is built and reviewed, and waits on the maintainer

**Status: `slice/37-the-cold-walk` is built, reviewed by two angles, its
fixes verified by a third, and the verification's own corrections verified
by probe and mutation with no further agent round (the maintainer's to
demand) — and it is NOT merged: the merge and the push are the maintainer's
calls.** A fresh instance picks it up here.

**What the branch holds, oldest first** (`git log --oneline main..HEAD`):
the pending-seat test slice 36 owed; the two Ergo-venue repairs the panel
found on the way (a first sync of a ruled backing threw; replacement records
came out uncopied) with the gap walker's chain threaded and a stale test
comment corrected; the panel record; the memo with its tests; the review's
two fix batches; the round record; this handoff.

**The mechanism, in one sentence:** a published replacement is judged once
— its two signatures verified — against the venue object that answered it,
the admitted records kept with their hashes, deduplicated by hash at
admission, positionally counted, keyed on the backing name and the rule
key, dropped when the venue re-gathers; the verify stays first, before every
rule that compares one record against another.

**The numbers:** a stranger's 4,000 free replacement records cost a live
chain's door call fourteen seconds per block on main and about forty
milliseconds now; the cold resume sits at its floor of one verify pair per
record, about ten seconds at 4,000 on this machine; the suite is green,
every mutant across four sweeps kills except one equivalent, and the seven
slice-36 exploits are byte-identical to main.

**No spec change**: §C2 says the record is witnessed and the reader walks it;
how often a reader verifies is the implementation's.

**Owed beyond this slice, recorded, do not lose:**

- The verify cost itself: 4–6 ms per strict Ed25519 verification on this
  machine (`@noble/curves` on this CPU) is 40–60× the usual figure and sets
  every number above; a faster path within "no other crypto dependencies"
  would be worth more than any cache.
- The sequencer's cache key decodes every record five times per door call;
  a `replacementCountFor` Venue method makes the door flat and was built by
  the panel (S+), deferred because it touches the interface for a constant.
- `settledInPart`'s double walk; `isNamedSuccessor`'s second venue read;
  `ErgoVenue.publishedOpsFor` and `revocationsFor` handing out stored
  objects; persistence of verdicts across restarts, which has no layer to
  live in; the frontier loop's cost against a real node.
- From slice 36, still standing: the rule-holder's unprovable erasure of a
  same-block commitment (a §C2 question), the root-framing proposal (names
  beside digests in `stateRoot`), the drifting clock against a real Ergo
  view, and the sharded-key party rule.

**Where the reasoning is:** the panel ("Panel: the cold walk"), the round
("The cold walk's round"), and the three panel reports plus two review
reports and one verification under `scratch/panel37/`.

## 2026-09-02 — The cold walk's round: the memo held, the venue beside it did not, and the fixes

**Status: slice 37's review round, its fixes built in two batches (929 tests
green; thirteen mutants over the fixes kill, one is equivalent by
construction — both callers return before the memo for a backing with no
rule — and two, the dedup and the empty return, are memory bounds no test
measures), and a verification of those fixes recorded below — the merge and
any push are the maintainer's call.** Two Opus angles over the build (adversarial; the
replaced-mechanism inventory and record), every finding probe-proven,
reports under `scratch/panel37/review/`. The memo itself held everything the
panel claimed for it: the walk's promises P1a–P1h all kept (the re-implemented
walk reproduces the built one on every scenario), the sequencer's cache
untouched, the seven slice-36 exploits byte-identical to main, the caller
census confirming the win (a warm reader pays no verifies where it paid one
per record; `isNamedSuccessor` cold 402 → 201 and warm 402 → 0). **Every
blocker was beside the memo: in the Ergo venue this slice also repaired, and
in one line of the memo's own housekeeping.**

**The blockers, and what fixed them:**

- **The Ergo venue marked an operator fetched BEFORE awaiting its fetch.**
  Pre-existing, and made reachable on every first sync by this slice's own
  repair of the sync flag: with the view answering from before the frontier
  loop, a half-fetched heir read `latestFor` as nothing — never committed —
  for the whole round trip, and forever if the node erred, so a punctual
  operator graded SILENT (the door to §C2b, from a network error; both
  angles, independently). And a sync that failed part-way left the view
  marked synced over half of two pictures. Fixed: the mark follows the
  fetch; the view un-marks itself on entry to `sync` and again on any
  failure inside the frontier; the guard refuses in both windows, tested
  with a node that errs and with a reader placed inside the fetch.
- **The memo's batch push was a spread call**, which has a stack bound near
  125,000 arguments; past it the `RangeError` inside `answering` answered the
  genesis chain — the retired operator back in force — permanently, since
  the count never advanced. Reachable by the rule-holder or by a stranger
  republishing the rule-holder's record (below). Fixed: a loop, and a test
  with 126,000 admitted records, the verify stubbed to price the count and
  not the signatures.

**Should-fix, all fixed:** the memo keyed on `nameHex` where the admission
reads `name`, so a hand-built object with the victim's `nameHex` wrote its
own count into the victim's slot and froze its succession at the genesis
chain; the memo retained the venue's own objects uncopied, so a field written
after admission SEATED a successor no signature covered where the uncached
walk merely stopped verifying the record; a backing the venue holds no
records for was memoised anyway, one entry per invented name for the venue's
life, on a local venue that answers `[]` for anything; the memo survived
`ErgoVenue.sync`'s whole-view replacement, so `sync`'s own frontier walked the
stale chain, fetched the wrong operator, and graded the true one silent —
`sync` now drops the memo (`forgetAdmitted`, not a verifier, exempt on the
refusal surface); a republished copy of an admitted record was retained at
junk prices, ~1.5 kB and a sort per walk each, so the docstring's "the memory
bound is the honest record's" was false — deduplicated at admission by the
record's hash, first witnessing kept, exactly the walk's own rule; the Ergo
accessor's copy through the canonical encoding cost seventy times the read
it replaced, on the read every walk makes — field-wise now; the lean was
stated narrower than the code (any change below the count, at any length no
shorter, in either direction — a co-signed handover written over a position
once judged junk stays invisible too); a dead sentinel carried the memo's
docstring; two comments in files the slice never touched described the
retired shape.

**Residues recorded, not fixed:** the sequencer's cache key still decodes
every record five times per door call, ~40 ms of a warm door at 4,000 on the
local venue and ~22 ms on Ergo after the field-wise copy; `isNamedSuccessor`
still asks the venue twice per call; `settledInPart` still walks its head
backing twice and each leg twice (the panel's other free repair, not taken);
`ErgoVenue.publishedOpsFor` and `revocationsFor` still hand out stored
objects (the same copy-rule class as the repaired accessor); a foreign throw
inside the admission step reads as the genesis chain through `answering`,
pre-existing and reachable from one more place; a caller that builds a venue per
request gets none of the memo; the memo's protection is per venue OBJECT, so
a Proxy over one is a stranger to it; a commitment can land in no term when
a real venue's clock crosses an effective index between reads and a publish
(unchanged from slice 36's residue); the verify itself is 4–6 ms on this
machine and sets every number here; and the prefix-cut property, the
junk-at-the-same-index slot and the unsigned self-naming record now have
named tests at the walk, which the panel's inventory had asked for.

**The numbers, after the fixes** (this machine, the same probes): a stranger's
4,000 records — live chain per block 14.5 s → ~40 ms; a holder's one grade
13.5 s → ~4 ms; the cold resume 56 s → ~10 s, the floor; verifies per full
round 36,000 → 3,000, the new records once; heap across the flood +0.0 MB,
republications included.

### The verification of the fixes, and what it corrected

One Opus angle over the two batches, probe-backed. Every review finding
re-fired and closed: the half-fetched operator refuses in all three
windows; the re-gathered view re-judges; a retained record's fields are
inert; the `nameHex` split is closed; the accessor's copy is thirteen times
cheaper; republications cost what junk costs; 130,000 admitted records
walk. The dedup keeps the first witnessing and cannot drop a valid record
behind an invalid twin; every path through `sync` answers from one view or
refuses; the stub does not leak between tests. Corrected in the last
commit, the recurring shape twice in one function: the empty-records
return had bounded the invented-NAME half of the retention and left the
RULE half open — a hand-built object with a real name and any rule key took
a 2 kB entry per ask, no venue write — and sat above the shrink guard, so a
read at the empty moment no longer re-judged (a regression, and the
docstring's "judged again from scratch" false in the total-loss case). Both
closed by one move the repository already makes elsewhere: the memo looks
its records up by the name RE-DERIVED from the backing's fields, as
`committedLogFor` picks a snapshot, so a hand-built object reads the records
of the backing it is — none — costs no verify and takes no entry, and the
key is the name alone, since the name binds the rule; the empty check
follows the guard and deletes the entry. Also: the Ergo view un-marks
itself after the height read rather than before it (a node that cannot
answer the height no longer takes a coherent view offline), and the
witnessed-order lean the dedup takes is named in the Venue contract.
Three mutants over these corrections — the lookup by the field name, the
empty check above the guard, the view left marked — all kill; 931 tests.
Residues: the `rule === undefined` return stays and is
dead from both callers (a third caller would get the right answer); the
dedup and the empty return are memory bounds nothing in the suite measures
— verified by the review's heap probes, not by a killing mutant;
`forgetAdmitted` and `copyReplacement` are public API now (`index.ts`
re-exports the module); the corrections themselves had probe and mutation
verification and no further agent round, the maintainer's to demand.

## 2026-09-02 — Handoff: slice 36 is fixed, reviewed twice over, and waits on the maintainer

**Status: `slice/36-the-resume` is built, fixed, and reviewed to the point the
workflow requires — the fix panel, the fix, its regression round (three
angles), the fixes' review (two angles), and a verification of the review's
corrections (one angle); the final correction batch (two guards, one message,
record text) has probe and mutation verification and not an agent round, which
is the maintainer's to demand — and it is NOT merged: the merge, the push of
the branch and of main, and the merge of the spec branch are the maintainer's
calls.** A fresh instance picks it up here.

**What the branch holds, newest first** (`git log --oneline main..HEAD`):

- The fix batch's review record (this entry's sibling above, if any fixes
  landed) and the regression round's record.
- `fc9c371` — the regression round's fixes: the opening claim costs one
  exhibit and seats on the link the guard read; the walk's refusals name the
  order they take; the non-object guard; the docstrings; CLAUDE.md as built.
- `b1834e3` — the register guard's owed test.
- `69b1c33` — **the fix**: `takeOver` is one walk down the record, the empty
  book is a signed claim, currency is `serves`.
- `bce0cab` — the fix panel's record; `d8b40fd` — the review round's record;
  before that, slice 36 as originally built and its own records.

**The numbers:** 911 tests green, typecheck clean, `check:docs` at
CLAUDE.md's 500-line cap exactly; the seven round-36 exploits refuse
(`bash scratch/panel36/run-blockers.sh . base` reruns them); twenty-five
mutants across four sweeps (`scratch/mutcheck-walk*.mjs`) all kill.

**The spec.** `money-from-first-principles`, branch `spec/the-walk`, four
commits (`e4d9d6d`, `78c914d`, `ece63e1`, `8ee6da7`), unpushed, off `96f3c17`
on main: §C2's resume sentence becomes the walk, paid per step, with the
opening claim and its refusals. CLAUDE.md says the spec is corrected upstream
first and the code follows; here the code was built to the draft, so the
maintainer reads the draft against the code before merging either.

**Three things flagged for the maintainer, none of them this slice's:**

1. **F4, a §C2 question.** A replacement effective AT the index of the
   incumbent's newest commitment puts that commitment in no term: every
   fault predicate returns false, and a witnessed final payment in it is gone
   and re-spendable, bought by the rule-holder (the backer by default) for one
   record and a key it generates itself. Composed with `opening` it is a total
   wipe, still provable one carrying state back. The candidate cure is
   `effective > witnessed` (strictly later), which costs the zero-lead-time
   handover the 35d round allowed. Probe: `scratch/panel36/security/probes/s3-boundary-erasure.mjs`.
2. **The root-framing proposal, a commitment-root change.** `stateRoot`
   hashes snapshot digests only, so an exhibit proving "carries nothing for
   EUR" is every other backing's whole log — 19.2 MB at 100 backings × 1,000
   entries, 21 hours on a 2 kbit/s link. Framing each snapshot's NAME beside
   its digest makes the exhibit the sorted (name, digest) list, 64 B per
   backing: 6.5 kB. It invalidates every existing commitment, so it is
   invariant 23's definition to change, and every implementation moves
   together. With it the walk's exhibit price disappears.
3. **F3, the cold resume.** A stranger's junk replacement records cost a
   restarting process two strict Ed25519 verifies each on every uncached
   walk: ~25 ms per record, ~170 s at 4,000. The warm path is flat. Cure: a
   rule-holder key pre-filter before verification, or memoising the filtered
   set per venue view. Probe: `scratch/panel36/security/probes/s2-venue-junk.mjs`.

**Owed beyond this slice, recorded, do not lose:** the drifting-clock probe
against a real `ErgoVenue` view (`takeOver` reads `witnessedIndex()` through
four paths); `snapshot()` and `adopt()` at a pending-link seat, untested; the
walk's price in the hostile-predecessor case (one exhibit per drop, bounded by
the lead time, stranding rather than framing); the sharded-key tail death
(W3), a party rule; the plain reads never asking `serves`; `commit`'s
unreachable `if (seat !== undefined)`.

**Where the reasoning is:** the fix panel ("Panel: the walk"), the round it
answered ("The slice-36 round"), the regression round ("The walk's regression
round"), and the four panel reports plus three regression reports under
`scratch/panel36/` (gitignored; `BRIEF.md` is the template for the next
panel's brief, `run-blockers.sh` the exploit runner).

## 2026-09-02 — The walk's regression round: two blockers in the opening claim, both the recurring shape, and the fixes

**Status: the regression round the walk fix owed, its fixes built and
reviewed, the review's corrections verified, and `slice/36-the-resume` NOT
merged — the maintainer's call.** Three
Opus angles over the fix diff (adversarial; the replaced-mechanism inventory
as built; docs, messages and spec), every finding probe-proven, each working
from a `git archive` copy while a mutation sweep rewrote the working tree
(`scratch/panel36/regression/`). The seven round-36 exploits refuse on the
fix; the walk itself withstood seventeen attacks (sixteen refused, the honest
one accepted) and could not be steered across any term boundary; Root B's
currency guard was right in both directions and no new configuration was
found. **Every defect was in the piece the panel ADDED beside the walk —
`commit({ opening })` — and both blockers are the recurring shape verbatim:
the fix bounded the walk's every input against the record and left the
opening claim bounded against the process's own local state.**

**The two blockers, and what fixed them:**

- **The opening claim was not bound to the record.** Its four conditions —
  registered, in force, not served, holding no operation — were all facts
  about this process, so a second process for the same key that merely
  booted opened a LIVE operator's book empty while the record's last
  commitment plainly still carried it: no drop, no forgery, one call, the
  wipe the round graded A3, back at `commit`. The panel's
  information-theoretic argument covers only the configuration it names —
  the record's last DROPS the backing — and the code never asked which
  configuration it was in. **Priced, not closed: an opening costs one
  exhibit**, the record's last commitment for the backing shown to carry
  nothing for it, through the walk's own step check (`recorded`), asked once
  — which closes the ONE-call wipe and makes the claim a possession check.
  What the door still cannot tell is the indistinguishable case, and a
  second process can MOVE the record into it by first signing a drop
  (`dropping`, or the silent W3 drop of a backing it never registered) —
  itself a provable rewritten history — so the wipe is two signed faults
  away for a second process of the live key — while an heir that finds the
  record already dropped signs only its own opening, the drop above it
  being its predecessor's; three door-side bounds were ruled out, one by
  run and two by argument, each bricking the honest new backing or making
  `opening` redundant (the review of the fixes, below). Where the record
  holds no in-force commitment at all there is nothing to exhibit and nothing
  to claim — refused, naming `takeOver(backing)`, which takes the empty book
  (the F2 heir). `opening` is now a list of `{ backing, record }`; the
  false-opening test inverts where the record's last carries (refused, the
  walk named) and keeps its shape where it drops (signed, provable).
- **The opened seat was written from a fresh chain walk AFTER `venue.publish`.**
  Every other seat write reuses a link decided before the publish; this loop
  re-walked, and `walked` is memoised on the witnessed index — so a venue
  whose clock ticks as it witnesses a commitment (every real chain) seated a
  retiring operator on its HEIR's link, `serves` read true out of force, and
  its next commitment rooted a book it did not serve, in no term, accusing
  nobody. No adversary. **Fixed: the link is read in the guard loop, from the
  same chain the force check reads, before the publish, and reused** — the
  discipline the served pin loop already follows. Tested with a venue whose
  `publish` advances the clock.

**Should-fix, all fixed in the same batch:** an explicit `undefined` or `null`
exhibit escaped the door as a `TypeError` (the rest-args signature made it
reachable from JavaScript and the retired helper's guard went with it) — a
non-object guard in `recorded`, refusing in the door's voice; the two refusal
texts carrying the k-exhibit walk-back spelled the exhibit order BACKWARDS
(newest first is the rule; the message put the newer drops after the older
state — the suite's own tests assert that order is refused) and the
nothing-offered refusal named a call that discarded the exhibits already
paid; two refusals named no path at all (a state that does not re-root; the
opening's four conditions); `serves`' docstring and the seat map's comment
still described the BOUNDED pin, `takeOver`'s docstring still called the
resume "the raise"; CLAUDE.md's opening rule overstated itself into "never a
door's acceptance" (the walk's bottom does license the empty book — the suite
says so), its boot rule did not name `opening` and so could not be obeyed at
depth two, the `dropping`-trap sentence the round asked for was still
missing, the holder rule's third path understated what `takeOver` now needs,
and "eight" party rules counted nine — three lines of recorded reasoning cut
to pay for it, at the 500-line cap; the spec draft left the retired "fixed
object" definition standing in front of the new one, never said the walk
must be PAID or that a successor can be stranded, was imprecise about the
seat's one choice, and omitted the claim's strictness (`spec/the-walk`,
second commit); four test defects — the opening's force condition untested
(the test named for it exercised `register`), the depth-two empty book
asserting only refusals under a name claiming acceptance, one test refused
for a reason other than its name, three comments naming the retired term
rule as what refuses and one contradicting its own inverted assertion — and
one deliberate behaviour with no test, the witnessed own rewrite resumed onto
in one call (F9), now tested up to the empty log with the price stated: no
public call back to the fuller book. The register guard's owed test landed
before the round (`b1834e3`).

**Residues recorded, not fixed:**

- **F9's reach is the empty log, not only a truncation**: an own witnessed
  commitment carrying the backing with nothing in it is served, every nonce
  freed. Provable forever; kept on the panel's reasoning; the sentence
  corrected here.
- **A seat can serve MORE than the record stands on**: `keep = mark` when
  stale, `restore` never below it, so an offered state shorter than the mark
  applies nothing and the longer held book survives — the safe direction
  (the prefix is checked), and it undoes an heir's truncation of a real
  payment. CLAUDE.md now says "no less than".
- **The rule-holder's boundary erasure (F4) composes with `opening`** into a
  total wipe rather than a one-commitment rollback, still provable one
  carrying state back. `opening` does not widen F4; it changes the loss's
  shape. F4 stays the maintainer's §C2 question.
- **A takeover from the PENDING link seats without serving until force** —
  correct by §C2 (no door opens before force) and not a strand, but the
  panel entry's "every `takeOver` either serves or throws" is corrected to
  "of an in-force link", and `snapshot()`/`adopt()` at that seat remain
  untested (the panel inventory's promise 3, still owed).
- **`opening` where the walk is free is not refused** and cannot be: an heir
  whose predecessor's last DROPS the backing, with a carrying state beneath
  it, already holds the one exhibit `opening` demands — the wipe costs it
  exactly what the honest one-exhibit walk costs, one signature of its own
  — no power an operator's key lacked, provable, and no refusal for
  CLAUDE.md's rule to attach to. (Where the predecessor's last CARRIES the
  book, the opening is refused by name.) A warning-shaped reader is a
  design question, not a defect.
- **The sharded key (W3)** now has `commit({ opening })` as its cheapest
  trigger — CLAUDE.md's boot rule names it. Pre-existing bound.
- **Redundant evidence** (`takeOver(b, record, record)`) is refused where
  main accepted it; the refusal names the call. A runbook item.
- **The drifting clock** against a real `ErgoVenue` view: every configuration
  built fails closed, none reached a partial mutation, but `takeOver` reads
  `witnessedIndex()` through four paths and they are not one read. One probe
  owed in an `ErgoVenue` slice. **F3** (junk records stall a cold resume)
  reproduces unchanged and stays owed.
- Three refusals name conditions rather than a call and honestly cannot (a
  retired link; a `dropping` name that would not drop; the rewind, for which
  no situation could be constructed — believed unreachable under the walk).
  `commit`'s `if (seat !== undefined)` stays unreachable; the plain reads
  never ask `serves`; `markCommitted` on an opened book is symmetry (an
  equivalent mutant, since `opening` refuses a non-empty log). The panel
  inventory's `q4-resync-jobs.mjs` does not parse (its P7 table came from the
  sweep, not that probe).

**Mutations:** the fix's fourteen (`scratch/mutcheck-walk.mjs`) all kill,
the register guard's survivor killed by the test landed before the round; the
regression fixes' six (`scratch/mutcheck-walk2.mjs`: the opening exhibit not
required, its identity ignored, force ignored, no-record allowed, the opened
link re-walked after the publish, the non-object guard deleted) all kill,
each by a test named for the claim. The inventory angle's own sweep of the
fix: 22 of 26 killed, two equivalent, two coverage gaps — both now tests.

**Next, and owed:** the merge and any push, the maintainer's call, with the
spec branch `spec/the-walk` (three commits, unpushed) to merge upstream
first, and three things flagged for the
maintainer: F4's §C2 question (`effective > witnessed`), the root-framing
proposal (names beside digests in `stateRoot`, 19.2 MB → 6.5 kB per exhibit,
a root change), and F3's cold-resume cost.

### The review of the fixes, and what it corrected

Two Opus angles over `fc9c371` (adversarial; messages, docs and record),
both probe-backed. What held: the seat link is dead as a defect (34 tick
positions, the reverse crossing, a re-appointed chain, two chains); the
`recorded` guard refuses `undefined` and `null` from both doors; the exhibit
binds what it was meant to (a stale own drop, an older state, a second
entry with a different record, each refused by name); every k-exhibit
refusal's `takeOver` arm works as spelled at k = 1 and k = 2. Corrected in
the follow-up commit:

- **The opening exhibit is a possession check, not a bound** — the
  blocker-1 bullet above now says so, with both routes: the acknowledged
  drop then the opening, and the honest opening of a new backing whose
  commitment silently drops the rest (W3) then the opening against it. Each
  route's first step is a provable fault; the door cannot tell the second
  from the honest one. `commit`'s refusal no longer names `dropping` and
  `opening` as peers without saying so, and CLAUDE.md's boot rule says the
  drop unlocks the opening.
- **The two k-exhibit refusals named `commit({ opening })` with the walk's
  current step as the exhibit**, which fails at k ≥ 1 — the recurring shape
  a third time in the same two sentences. They name the record's LAST
  commitment now.
- **`opening`'s element shape and `commitmentIdentity`'s three fields
  escaped as raw errors** (eight of eleven malformed elements, the pre-fix
  `opening: [backing]` among them; five malformed commitments) — one clause
  each, in the guards that exist, in the door's voice.
- **The spec draft** said the empty book at a seat with history is "never a
  state a door accepts" and "cannot be told, at any door" (false: the walk's
  bottom takes it — CLAUDE.md's own overstatement, one document over),
  bounded the steps by the lead time (false: six drops in one term with no
  replacement at all), and kept the retired word "raised" — corrected in
  `spec/the-walk`'s third commit, with the opening's fifth refusal added.
- A test named six refusals and exercised four (renamed for what it
  exercises); the re-root refusal names its call; CLAUDE.md's "no LESS
  than" is scoped to `takeOver`; the panel entry's signature bracket says
  where the `undefined` refusal is reachable from.

**Residues from this review:** a commitment can land in no term when the
venue's clock crosses a replacement's effective index between a door's
reads and its publish — the served path as much as the opening path,
inherent to a publish that is not atomic with its reads, accusing nobody;
the W3 repair's exhibit is the twin's served state, which the venue does not
hold (a runbook line); `awaitingTakeover`'s "one `takeOver` away" sits
beside the recorded strand; `commitmentIdentity`'s four other callers were
not audited for the same shapes; and a warning-shaped reader an operator
could ask with a carrying state in hand — would this opening wipe? — is a
design question left open.

### The verification of the corrections

One Opus angle over the correction batch, probe-backed at k = 2 and k = 3:
the two k-exhibit refusals and the silent-drop refusal name calls that
work, the one-call wipe is closed at every single-call shape, the widened
guards hold across 27 malformed inputs at `takeOver` and 22 at `commit`,
CLAUDE.md's changed sentences are true, and the spec's third commit reads
as one statement. Corrected in the last commit: the entry's "two signed
faults away, never one" was an absolute false for an heir that finds the
record already dropped (one call, one own signature, the drop above it its
predecessor's), and its residue example described the pre-fix door — both
scoped above; the re-root refusal's appended call was right in one of the
three slots `recorded` serves — the recurring shape a fourth time — and
now names the slot instead of a call; `dropping`'s elements and a hole in
either list escaped as TypeErrors one line from the new guards — guarded;
the opening guard's comment still stated the bound the entry retracted;
the entry's own status and commit count contradicted its subsection; the
spec's "an honest record has none" gains the deliberate stop-serve. That
last batch — two guards, one message, record text — was verified by probe
and by mutation (each guard's mutant killed) and not by a further agent
round, which is the maintainer's to demand. Residues: a getter that throws
propagates the caller's own error; `takeOver(undefined)` is a TypeError
from the ledger's `has`, pre-existing; the boot rule's "un-resumed backing
in `dropping`" reads as a fault only where the record carried it; the
strictness test's four arms share one message, so it cannot tell which
arm fired.

## 2026-09-01 — The slice-36 round: the raise is sound, its evidence arms are not, and a "no-op" that un-serves

**Status: `slice/36-the-resume` does NOT merge — the round found six blocking
defects.** Four Opus angles, sized to what the diff touched (one code file,
`src/sequencer.ts`, and five test files): the takeOver door adversarially, the
replaced-mechanism inventory (the non-optional one), the commit/pin/serves seam
with cost measurement, and the test sweep with mutations. Every blocking
finding was independently re-run by the session before being recorded. Suite is
green on the branch (893) — the point of the round is what green did not catch.

**What HELD, and it is the centre of the slice: the raise arm is sound.** The
floor-not-ceiling reversal — the F-A fix the slice exists for — survived every
attack. The raise target is venue-derived, so an older own state, an
unpublished own-signed forgery (at or above the tip's sequence), a stranger's
state, and a skipped anchor are all refused by identity; a predecessor's
commitment can be the target ONLY when it IS the anchor (the arm table proves
it, not argues it); the F4 lead-time cure works end to end; the one-writer twin
fails closed on the losing side. The decision tree's arms are disjoint and
one-pass. Cost is free: `serves`' unbounded read is +5µs (inside payment noise,
Ed25519 dominates), flat in junk, and a stranger cannot inflate it — nothing of
the 35d 60× shape. The register guard EARNS its place (keep it): `serves` alone
detects a stale seat with no window, but only the guard stops a repeat
`register` from un-seating a live serving book, and that is the writer's rule to
hold, not a second detector — its code is a binding CLAUDE.md sentence besides.
The consolidation, if ever wanted, is inversion (register writes then keeps iff
`serves`), not deletion.

**The six blockers cluster into three roots. The raise is fine; everything
built AROUND it to reshape the evidence path and the pin is where the slice
broke.**

- **Root A — the evidence arms bound the EXHIBIT, never the offered BOOK
  against anything the record holds** (four manifestations, `serves`-unbounded +
  the ceiling moved anchor→`latest`):
  - **A1 forgery.** The walk-back arm has no venue check (`committedLogFor` has
    none by contract; the raise arm compensates, the walk-back does not). A
    retired predecessor signs a second root at its own last sequence, never
    publishes it, and its successor serves it — holders' money gone, spent
    nonces free, inv 22 broken. Attacker: the retired key alone.
    (`scratch/b36/p4-predecessor-forgery.mjs`; main refuses the call.)
  - **A2 downgrade.** The walk-back window is open ABOVE — any earlier own
    state is accepted, attacker-selected: one record + one exhibit yield four
    accepted books including a full wipe. This is verbatim the shape the resume
    panel VETOED bare option (a) for, one rung down. Breaks §C2's "a fixed
    object". (`scratch/b36/p1-walkback-downgrade.mjs`, `p7-dropping-route.mjs`.)
  - **A3 wipe.** The empty-book-by-evidence arm licenses the empty book off the
    record's LAST commitment with no reference to the anchor, so
    `takeOver(b, undefined, latest)` at a seat whose anchor carries a full book
    serves the empty book, commits it, and lands a provable fault on the honest
    key. Precondition is manufactured by an ordinary multi-backing operator
    letting its commit timer fire with the backing named in `dropping` — the
    very arm added so one backing cannot hostage the rest. Main REFUSED the
    identical call. (`scratch/inv36/p2b-wipe-at-a-pinned-seat.mjs`.)
  - **A4 strand.** When `latest` is a drop, `takeOver(b, anchor)` seats without
    serving and the two refusals it then offers both name dead paths; the only
    working call (the evidence arm) is named by neither. Regression vs main,
    one argument from A3. (`scratch/b36/p6-…`, `scratch/inv36/p1-anchor-strand.mjs`.)
- **Root B — the `settled` pin guard keys on log LENGTH, not seat currency**
  (`sequencer.ts:680`), wrong in both directions:
  - **B1.** Re-offering the state already held un-serves a LIVE operator
    (`offeredLog.length < keep` is false at equal length, so the pin regresses
    to the anchor and unbounded `serves` reads false). Two existing tests named
    "…is a no-op" assert only `opLog` length and cannot see it — "a test's name
    is a claim the test must exercise" read backwards.
    (`scratch/rev36-reoffer.mjs`.)
  - **B2.** A losing twin holding an uncommitted tail offers the record's
    latest: the fast-forward makes the guard fire, the STALE pin is kept, and
    `takeOver` returns success having changed nothing — no public call repairs
    it, only a restart. (`scratch/rev36-raise-noop.mjs`.) The guard wants "is
    the seat already current" (pin == the record's unbounded answer), not
    lengths; `reSync` is now overloaded four ways and this is what conflating
    them costs.
- **Root C — two rewritten `c2-dropped-backing` fixtures no longer exercise
  their names.** `sequencer.snapshot()` returns `[]` after `commitWithout`
  desyncs the seats (the resume rule), so both "later states" — one literally
  named `carried` — carry nothing; "a backing appearing in a later state is not
  a rewrite" is now a duplicate of its drop-drop sibling, passing vacuously. The
  35d round found this same shape twice. Fix is ~3 lines each: snapshot BEFORE
  the drop. (Verified by the sweep's `zz-probe36`.)

**Directions the angles built and probed (for the fix panel, not decisions):**
Root A — the inventory's narrowing (license the empty book only where the
handover pinned nothing OR pinned the very commitment exhibited) is built in
`scratch/inv36/buildfix`, all 893 green, and closes W1 at a successor seat too;
angle 1's "give the precedence check a floor as well as a ceiling" is the
walk-back's half. Both point one way: the evidence path must bound the offered
book by a venue-derived object, as the raise arm already does. Root B — key the
guard on pin-vs-record, and split `reSync`'s jobs rather than add a fifth
condition.

**Should-fix (not blocking):** the restarted-genesis refusal message
(`:530`, `:545`) is factually wrong — it says the book is empty while the
record pins the operator's own carrying latest, and never names the two-call
path; `requireDroppedBy`'s contract (`:690`) and `takeOver`/`register`
docstrings still describe the replaced fixed-object mechanism and say
`incumbentLatest` "is needed in exactly one case" (now false — needed whenever
the operator's own record moved past the anchor); two owed tests (evidence that
contradicts the raise; the walk-back's term bound is `latest` not the anchor)
were WRITTEN by the sweep and kill their mutants; the empty-by-evidence arm has
no refusal test at all. The resume-panel entry's residue "the walk-back for
one's OWN dropped backing is not licensed" is now FALSE of the shipped code and
must be corrected so a later reader does not reopen on a false premise.

**Recorded residue:** the `seat.from === 0n` special case (`:502`) duplicates
`lastCommitmentInForce`'s own `end < link.from` guard (one-mechanism, no
behaviour either way); `commit`'s pin loop `if (seat !== undefined)` (`:1622`)
is an unreachable branch (`served ⊆ serves-true ⊆ seat defined`); between
`venue.publish` and the pin loop `snapshot()` returns `[]`, so a process holds
the only copy of the state its signature roots and cannot export it — a
process-death window the boot party rule covers, but now covering a state never
returned; the plain reads (`balance`/`outstanding`/`nextNonce`) never ask
`serves`, so a restarted process answers them from a book it knows is behind the
record (pre-existing, now "known stale" rather than "partly unwitnessed"). The
35d entry's `dropping`-trap note: an honest restarted genesis that lets its
timer fire mints a provable fault via `commit({dropping})` before it ever
reaches the wipe — the boot rule should name `dropping`, not only the timer.

**Mutations:** the seven build-time mutants all KILL (the seventh's stale
old-string was fixed in `scratch/mutcheck-resume.mjs`); of the six extension
mutants, three kill and three survive — `9b` (the `seat.from === 0n` case,
near-equivalent, the residue above) and `11c2`/`12d` (real coverage gaps, tests
now written).

**Next, and owed:** the fix turns on design decisions (Root A: what
venue-derived object bounds the evidence path's offered book, and when the empty
book is licensed at all; Root B: the guard's real condition) — so it gets a
PANEL before it is built (one angle must inventory what the current evidence
arms silently promise), then implementation, then its own regression round. The
merge stays blocked until that round passes; the maintainer's call on the merge
and any push, as ever.

## 2026-09-01 — Handoff: slice 36 is built and owes its review round

**Status: `slice/36-the-resume` is built, 894 assertions green, typecheck and
check:docs clean, NOT merged, and it owes its review round** — every change
gets one (CLAUDE.md), and this one reversed a three-day-old decision (the pin
was a ceiling; it is now a floor) and reshaped `serves`, the hottest predicate
in the sequencer. A fresh instance picks it up here.

**What is done, and where the reasoning is:**

- The resume PANEL (four Opus angles, two with prototype builds run against
  the suite) is recorded in the entry directly below this one. It decided the
  design; it is not the review of the implementation.
- The design is three commits on the branch: `98b88f4` (the panel record),
  `54cbc33` (the build — `serves` unbounded, the raise from the anchor via the
  existing fast-forward, the seat's pin as the book's provenance maintained by
  `commit`, register-seats-only-where-the-record-pins-nothing, the genesis
  refusal deleted, the never-carried wall closed by the evidence path), and
  `b488d5d` (the last two mutation killers). Tests: `test/c2-the-resume.test.ts`.
- The spec sentence landed upstream first (`money-from-first-principles`
  `96f3c17`, pushed to main): "the pinned object is a floor, not a ceiling".
- Mutation-tested at build time: six mechanisms, six kills by named tests. The
  seventh mutation in `scratch/mutcheck-resume.mjs` (`evidence-vs-anchor-again`)
  is a NO-MATCH — a stale mutation string, not a coverage gap; fix or drop it.

**What the review round must do, and what to watch (the recurring shape here
is "a fix bounded one input and left the other open"):**

- **The takeOver decision tree grew a lot.** It now has: the anchor (the pin),
  the raise (own latest, reSync-gated), and three evidence arms (empty by
  evidence, carrying walk-back by evidence, the served earlier-state path) —
  plus the empty anchor and the pure-empty book. The angles should confirm
  the arms are DISJOINT and one-pass, and that no arm licenses a state another
  refuses. The `incumbentLatest === undefined` guards on the served branches
  are load-bearing (they route a resume away from the evidence path); check
  them.
- **`serves` is now uncached in a second place** (it reads
  `lastCommitmentInForce` unbounded per call, as the fix round's F4 already
  made it read the bounded pin). The DoS/threading angle: `serves` is on the
  hottest path and now walks/reads more. Confirm the memoised chain is used
  and measure.
- **The evidence arms exhibit the record's LAST commitment, not the anchor.**
  This is the deliberate reversal that lets an acknowledged own-drop be walked
  back — but it widened `requireDroppedBy`'s subject. Inventory angle: every
  reader of the dropped-target path.
- **`commit` rewrites every served seat's pin.** A partial commit, a commit
  that throws mid-loop, the interaction with `dropping` and with the F4
  TOCTOU (`served` is read once) — walk them.
- **The register guard is near-equivalent under unbounded `serves`** (the
  survived mutation): its only observable content is refusing a direct raise
  at a restarted genesis seat, now pinned. The angle should decide whether the
  guard earns its place or `serves` alone should carry it (one-mechanism).
- The fixture churn (7 files) was all "the design working" — but a reviewer
  should confirm each rewritten test still exercises its NAME, not just passes
  (the 35d round found two tests that had stopped exercising their claims).

**Owed beyond this slice, already recorded, do not lose:**

- **F-A's own follow-up is now BUILT by this slice** — the crash-restart
  family (F-A, the genesis twin, the empty-pin wipe, W1 the never-carried
  wall) was the panel's subject and is closed here. The "recorded, not fixed"
  F-A note in the 35d fix-round entry is now SUPERSEDED by this slice; a
  reviewer should confirm the four probes (in the panelists' /tmp builds, and
  reconstructable from the test file) all pass against the built design.
- The prototype builds the security and practicality panelists made (two
  independent (c) implementations) are worth diffing against what shipped if
  the review wants a second opinion on the door's shape — paths are in their
  reports (this session's transcript; the panelists were spawned by the F-A
  panel).
- The same-block amnesty, the pre-armed handover, the `isRewrittenHistory`
  walked-chain parameter, and the genesis "never had it vs lost it"
  unreadability are all recorded residues (this entry's sibling and the 35d
  entries); none blocks.

**The merge, when the round passes:** `slice/36-the-resume` → main, then push
main + the branch (the maintainer's call — never push without asking, but the
last two merges were authorised the same way). The spec is already on main.

## 2026-09-01 — The 35d round and its fix panel: the seat is a link and a provenance, and every refusal must leave a live path

**Question:** the review round owed by slice 35d's implementation. Five angles,
all Opus (the door adversarially, the replaced-mechanism inventory, the
seat/walk/cache reader, the tail/mark/idempotency seam, the test sweep with
mutations), every finding probe-proven and the blocking ones independently
re-verified by the session before being acted on. Four blocking findings —
all on one seam — then a five-angle fix panel (simplicity, security,
practicality, consolidation, inventory), each arguing the choice from its
lens with its own probes. The full finding set is in the round's working
notes; this entry records what was decided and why.

**The four blockers, and what the panel showed each really was:**

- **F1 — the seat was the walk's LAST link, not this operator's own.** A
  rotation queued at the heir's link is invisible until the heir's own force
  arrives (the walk stops at the first pending link), then locks the heir out
  for its ENTIRE term — the rule-holder writes the queued record's effective
  index, so the window is its choice. The locked-out heir's ordinary scheduled
  commit roots a drop that reads as rewritten history in BOTH argument orders,
  and that empty commitment becomes the pin for the next heir, breaking the
  one-argument takeover for every later rescuer. A crash-restart under a
  queued rotation triggers it with no adversary at all.
- **F2/F2b — an absent pinned target was a permanent wall, and the zero-width
  term is an eraser.** An operator dark before its first commitment left the
  backing unservable by every party forever. Worse: one record with
  `effective == incumbent.from` (legal under `effective >= at`) empties a term
  retroactively — the erased committed state places in no term, so
  `isRewrittenHistory` is false in both orders and the book cannot even
  accuse; and TODAY'S `>=` filter is itself a past-reading mover
  (`operatorAt` at an already-read index changes when the record lands),
  which is the hazard fault.ts forbids, purchasable for one publication.
- **F3 — the resumed operator's era window is a minting window.** Between its
  fast-forward and its first new-term commitment, its receipts name an era
  `eraLapsed` reads as ended — and `lapsed` is the excuse the fault pair
  reads, so its equivocation is unprovable while every liveness signal reads
  normal, the payee's freshness rule PASSES (the stale era IS its latest
  commitment), and the tokens never expire. 35c's recorded price ("for as
  long as the key stays dark") was false: the key is trading.
- **F4 — a stale BOOK under a current SEAT did not detect itself.** An heir
  that synced early in the lead time, whose predecessor then legitimately
  committed again, had no signal — its first commitment was a permanent
  shrink fault, both parties honest, and the customer-visible symptom is a
  wrong balance in the operator's own voice.

**The panel's synthesis — one design, five convergent voices:**

1. **The seat is this operator's OWN link** — the last link of
   `successionAhead` naming it — and it must be the link in force or the link
   pending; the genesis test becomes "my seat is the chain's first link"
   (the `ahead.length` proxy dies with the fix). Security ran five adversary
   shapes against it and nothing opens; a retired mid-chain key gains only a
   callable, inert refusal. The inventory traced every (old seat, new seat)
   pair through the tail disposition: no wrong branch — a live tail can only
   exist under an in-force-tip seat, which is exactly the re-sync branch.
2. **The walk voids a replacement whose effective index is not strictly
   later than its predecessor link's force — unless it names the incumbent**
   (a revocation-by-renaming at the boundary must still revoke; probed, the
   exemption is load-bearing). This is the walk's existing void rule set
   where its own comment already puts it ("two operators in force at one
   index"), it deletes a purchasable past-reading mover and the eraser class,
   and it costs exactly one test fixture that sat on the degenerate boundary.
   Recorded shape changes: a void record no longer spends its index's slot in
   the same-index tie, and readers on the two code versions can disagree
   about a past index of a chain containing a degenerate record (migration
   note; the record class is now unbuildable).
3. **Only behind that rule, an absent pin is the EMPTY book**: takeOver
   conforming to `lastCommitmentInForce`'s documented contract ("never
   publishing at all must not read as punctual"), generalizing register's own
   genesis rule — the book you take on is what the record pins before your
   seat, the empty one where it pins nothing. Fires ONLY on an undefined
   target, never the dropped-target case (which keeps its evidence path); the
   mark moves only where a commitment backs it. Alone this option was VETOED
   by two angles (it converts F2b's brick into a silent debt erasure, and an
   empty book resets nonces, framing honest holders); the ordering is the
   soundness argument, not a preference.
4. **The era condition joins `shut`**: one commit-first door, two conditions,
   two messages — an operator whose own current era already reads lapsed
   commits before it co-signs, which restores §C2's "takes effect only from
   the first index at which it has published its own commitment" as a door
   rule rather than a force rule. Placement is load-bearing: at the doors
   only, never in `caughtUp`/`adoptOne` — placed there, the return commit
   refuses ITSELF (probed: permanent self-inflicted lockout). `shut` sheds
   its dead `isInForce` copy (the `inForce` door runs first at both sites).
   Rejected: receipts naming their seat (a self-asserted field reproduces the
   bug; +18% wire on a LoRa-class payload; every held receipt stops
   verifying), and merging with `gapOpen` (two orthogonal windows, two
   audiences — probed in both directions). The adoption wrinkle is not a
   hole: `receiptStatus` reads the log before the era, so an adopted leg is
   `witnessed`. The reader-side residue — a payee accepting from a resumed,
   uncommitted operator — gets a party-rule sentence: a receipt whose era
   predates the operator's current seat is stale on its face, and the seat is
   readable from the chain.
5. **The seat gains the pin — possession WITH provenance**: the seat stores
   the taken commitment's identity, and `serves` compares the seat against
   the tip AND the stored pin against the recomputed one. The pin is frozen
   at the effective index (probed against a predecessor committing at every
   index of the lead time: one re-sync, ever), recomputed per call rather
   than cached (it can move at an unchanged cache key; 0.02ms flat on a
   walked chain), and rewritten on every re-sync. The identity is the
   commitment triple through ONE comparison, retiring three inline copies.
6. **`commit` refuses to silently drop an in-force backing — with a per-call
   acknowledgement** (`dropping`). Unconditional refusal was vetoed by
   security's hostage probe (one withheld backing silences a multi-backing
   operator's whole book and fires every grade); silent dropping was vetoed
   by inventory (it converts F4's shrink fault into a drop fault against the
   same honest party). The acknowledgement threads both: the forgetful
   operator gets a refusal naming takeOver, the besieged one names its choice
   and its healthy backings commit. `commit` reads its served set once and
   threads it (a pin-aware `serves` is uncached, so the old
   read-twice was a TOCTOU). A public reader lists the backings in force
   without the book.
7. **The walked chain is threaded through `gapOpen`, `gapLegsFor` and
   `eraLapsed`** (optional trailing parameter). Re-graded from "recorded
   design call" to part of the fix: the memo halved the crypto but left 3-4
   unmemoised walks per door call — ~4.9s per payment at 100 junk records,
   ~80ms with the chain threaded (60×), and junk costs the adversary one
   publication each. For the off-grid deployments this project cares about,
   compute IS the wire.

**Residues recorded, not fixed:**

- **The same-block amnesty** (security's probe, corrects 35c's price): a
  rule-holder retiring a dropper with `effective` equal to the drop's own
  witnessed index makes the WITNESSED drop unprovable in both orders. The
  window is one index; the buyer is the rule-holder — the backer by default —
  and the dropper is typically its own sequencer. 35c's sentence becomes:
  the witnessed drop is provable unless the rule-holder retires the dropper
  in the drop's own block.
- The pre-armed handover (a record published before the incumbent's first
  commitment, effective later): a holder relying on an out-of-force
  commitment is reading the key rather than the chain, which §C2 already
  forbids.
- The rule-holder's queue-voiding recourse (naming the incumbent at its own
  link, co-signed) exists and is now documented rather than folklore.
- The evidence path's bound widened from "the incumbent's own earlier states"
  to "any earlier term's" — within slice 13's bounded-not-checked limit,
  provable in both orders, now stated.
- N8's one-writer twin widens by one case (a second process for the in-force
  operator can take over while a rotation is pending) — priced by "one
  writer at a time", as before.

**Also from the round, landed ahead of the fix:** the missing killer tests
(the cross-term precedence guard had three sub-conditions surviving deletion —
each survivor a real capability; the cache key had neither half pinned; the
door order, the seat check, the mark condition and the caughtUp gate were
untested), the probes' verifier-side assertions carried into the pinned tests,
two tests renamed or removed for claiming what they did not exercise, and
three test names moved onto the boundary they claimed. The submitLeg-site
door-order killer is owed alongside the fix (that door is reshaped by it).

**Spec changes owed** (upstream first; the maintainer merges): the strictness
sentence on §C2's replacement rule (with the incumbent-naming carve-out), the
empty-book base case for the handover object, and the payee's seat-aware
freshness sentence. **The fix itself is the next commits on this branch and
gets its own regression round.**

### The regression round of the fix, and what it corrected

Two Opus angles over the fix diff (adversarial; the replaced-mechanism
inventory as BUILT), both probe-backed. **No blocking findings.** What held
under attack, for the record: the seat bound against every party shape and 25
randomized record floods (no past reading moved, `from` strictly increasing,
a key at both tip and pending unbuildable); the exemption never chosen as a
link; the empty book unsmuggleable in either direction; the frozen pin under a
predecessor committing at every lead-time index; repeats served pre-commit by
a re-appointed key; the live re-sync unable to move the mark; the (stored
seat, scanned seat) pair table complete with no wrong tail branch — the one
reSync-true pin rewrite is the F4 cure, safe because that state provably
holds no live tail.

Corrected on the round's findings, in the follow-up commit:

- **C-1**: `commit`'s abandoned-check re-derived `serves` instead of testing
  membership of its one served read — the TOCTOU its own comment claimed
  closed. Now membership.
- **S-1**: `eraLapsed`'s `answering(…, false)` made a NON-VenueError venue
  throw read as consent at the door, where `gapOpen` fails closed. Resolved at
  the contract: the Venue interface now states both promises readers lean on
  (append-only — the walk cache's key, and ErgoVenue.sync's bound — and reads
  answer or throw VenueError), and the residual is recorded here rather than
  patched with a second door mechanism.
- **F-C**: `eraLapsed` is chain-sensitive where gapOpen/gapLegsFor are
  indifferent (handed `successionAhead` it shut every door for the whole lead
  time) — it now slices a pending tip off inside, and the docstring names the
  force chain.
- **F-B**: the era door's comment and this entry overclaimed §C2's
  commit-before-co-sign as a door rule. What the door closes is the MINTING
  window (the era already lapsed); a re-appointed key whose era stayed live by
  committing elsewhere passes it — nothing is mintable there (the fault pair
  stays armed, probed) — and its stale-era receipts are the payee's to refuse
  by the seat-aware freshness sentence. The comment now says exactly that.
- `dropping` is strict in both directions (a name that would not be dropped is
  refused — an acknowledgement must not assert something false, and a typo
  must not read as accepted); the empty-book path refuses stray
  `incumbentLatest` evidence as it refuses a stray state; the era-door test
  pins WHICH refusal spoke; and the owed submitLeg-site door-order killer
  landed.

**Recorded as the owed follow-up, with probes proving urgency (F-A):** the pin
bounds the PREDECESSOR's commitments and leaves the operator's OWN open. A
fresh process for the in-force key — the one-writer persistence boundary — can
re-seat only at the frozen pin: its own later committed state is refused ("not
the state the handover pins"), the pin-matched seat reads `serves` true and
`awaitingTakeover` empty, and its next commitment is a shrink fault against
its own honest key, the payee's receipt `contradicted`. A/B against the parent:
pre-existing and byte-identical in the base configuration; the fix made it
reachable in the queued-rotation configuration where F1 had accidentally
blocked it. It is the recurring shape verbatim — one input bounded, the other
open — and the refusal names no live path. The candidate closure (accept a
LATER commitment by the seat's OWN operator — the fast-forward applied to
one's own history) is a design decision and gets a panel before it is built.
