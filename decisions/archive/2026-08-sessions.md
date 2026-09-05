# Session records — 2026-08

Handoffs, review rounds and session closes moved out of the decision log on
2026-09-05. They are history, not decisions: nothing here states a standing
rule that the indexed entries do not. Kept for the reasoning, unindexed.

---

## 2026-08-29 — The 35c round: ordering is not obligation, and an era starts where its signer did

**Question:** the review round owed by slice 35's implementation commit. Three
angles, all Opus: the succession walk, the readers, the test sweep (ten
mutations plus the two the handoff listed). Every finding below was
probe-proven by its reviewer and re-traced here before being acted on.

**The blocking find, and the shape worth keeping: ordering is not obligation.**
`termOf` was built as one answer to two questions — which term a state SORTS in
(`isRewrittenHistory`'s rank) and whether it was committed while holding the
pen (`committedWhileInForce`) — and the merge failed both ways. Strict
witnessed windows as the rank: an honest re-appointed operator's old
served-but-unpublished state fell out of its closed first term, placed at its
tip term, sorted AFTER its successor's genuinely later state, and read as a
shrink — a permanent stranger-checkable fault it armed by consenting to its own
re-appointment. And one published replacement closed a predecessor's term, made
its real unwitnessed rewrite unplaceable, and erased invariant 22's fault for
one free record — the exact attack shape this slice closed for the silence
clock, reopened in the rank. Fixed as two rules: one signer's states compare by
its own sequence field, witnessed or not, however the chain grew; across keys a
state ranks by the term the record places it in, a multi-term key's tip is
bounded by what it has had witnessed (ambiguous places nowhere), and an
unplaceable state accuses nobody. `committedWhileInForce` keeps the strict
read. A "rank a once-named key at its link" fallback was drafted and dropped:
the only behaviour it preserved was main's own false-accusation hazard (a
retired key's dead tail faulting its honest successor's shorter log).

**The second blocking find: `eraLapsed` laundered an heir's equivocation.**
Untouched by the slice and broken BY it: §C2 seats an heir before it commits,
so its receipts honestly say `after = 0`, and both of eraLapsed's arms measured
from `after` — every heir on a venue older than one duration read lapsed, the
handover arm found the handover that seated the heir's own predecessor, and
`lapsed` is the excuse `isDoublePosition`/`isDoubleAcceptance` read: a punctual
heir's two receipts at one position, its own signature on both, unprovable.
Fixed with a floor: the era begins no earlier than the signer's first term. For
a twice-named key with no commitment anywhere the floor is its first seat,
which reads toward the excuse — this predicate's direction.

**Reverted from the slice's own first cut, on its reviewers' probes:**

- The operator-equality checks added to `replayLatestState` and `isLatestAt`.
  The root is injective over states (inv 22) and `committedLogFor` already
  refuses non-operators, so the signer comparison only refused honest things:
  an heir re-committing the predecessor's book verbatim carries the same root
  and, as a fresh key, the same first sequence — and the holder keeping the
  predecessor's copy is following CLAUDE.md's own rule.
- The tie-break's loop shape. The comparator alone let a same-index sibling
  supersede the sorted winner (greater hash won under any lead time), and a
  same-index naming beat a revocation in EVERY hash order. Now exactly one
  candidate per witnessed index is considered — the lesser hash — and a
  revocation holds the tie its hash wins.

**Also:** empty-term guards in `termOf`/`lastCommitmentInForce` (a degenerate
equal-`from` chain put a negative index on the Venue interface); `linkIn`
deleted (dead, and the one exported reader handing out a live reference);
docstrings corrected where the round caught them overclaiming — both halves of
the covering-nothing concession are now stated (a routine commitment for OTHER
backings closes this one's gap AND kills the open snapshot redemption; the
fallback is the non-service grade and it is the holder's to arm by filing),
the incumbent-naming fairness argument now covers requests arriving between
consent and force, and `quietFor` says plainly the grades no longer read it.

**Test debts paid** (the sweep's list): the same-at skip and both equality
checks had ZERO coverage — mutations survived; now five mutations die to five
named tests. "Commits its way out" commits; "whoever is in force" seats an
heir; "the remainder" is a live remainder, not a corpse; "proves no more"
proves the exact holding first; "clears them only by serving them" serves
them, and pins the reader asymmetry (a stale state's count is a fact about
that state). Suite 842 → 852.

**Routed to 35d, now with three probes proving urgency:** `takeOver` still
reads `latestFor(incumbent)` — a dark heir makes the backing unrescuable by a
second heir; zero lead time still locks out (and the heir's only move, an
empty commitment, closes the gap and kills the holder's redemption); a
re-appointed operator cannot resume through `takeOver` at all, so resuming
honestly manufactures a fault. `caughtUp`'s `isInForce`-vs-`serves` divergence
rides along (probed benign today). The walk's flood cost (~4ms per junk
record, uncached, pre-existing) stays open beside it.

**Spec change:** none beyond the branch already open — the code follows §C2's
"strictly before" reading everywhere, including its one odd corner (a handover
at exactly the predecessor's last-commitment index ages the backing's clock by
one commitment; the rule-holder firing its own grade is the collusion case
§C2b declines to distinguish).

### The regression review of this round, and the correction it forced

The recurring shape appeared again, in fix 1. The multi-term tip bound was
derived from the RANK's problem and left on the shared function, so it decided
FAULTS: `committedWhileInForce` went from convicting a re-appointed in-force
operator's unwitnessed dropped state to acquitting it, at a price of two
records the rule-holder signs itself. And the boundary was purchasable
regardless — `named` counted zero-width terms, so two records with an
equal-index pair bought the multi-term policy for a key that held the backing
once.

The correction is a uniform line, drawn at the CHAIN rather than at the key:
**an unwitnessed sequence places at the tip only while the chain is the genesis
link alone.** Once any succession exists, every key on the record has had a
period out of force, and a shared operator's honest service in such a period
produces signed states that drop this backing — indistinguishable by sequence
from an in-force key's unwitnessed drop. Both policies this replaces treated
one ambiguity two ways. **The price, stated:** past the first handover, an
in-force operator's unwitnessed dropped state is not provable by the
rewritten-history pair alone; the witnessed drop still is, and the non-service
grade still reaches the dropper. The reviewer's counter-scenario — an honest
shared operator permanently faulted by any floating state of its ordinary
out-of-force service — is what accusing instead would cost, and "say nothing
rather than accuse" is this codebase's stated standard. Note the acquittal at
the tip remains purchasable at one record; what the record buys is escape from
one unwitnessed-evidence fault, and it subjects the buyer to everything else a
handover costs.

Also from the review: `eraLapsed`'s era END is now measured from the same
floor as its start — keyed on `after` alone, a pre-seat commitment for
anything else the key operates stood in as "next", both arms went dead, and a
genuinely dead era read live, which is the accusing direction. The floor's
own residue is stated in its docstring now: a re-appointed key's receipt whose
`after` predates its second seat reads toward the excuse, for as long as the
key stays dark. The reviewer also confirmed with 800 randomised trials that
the tie loop never moves a past reading and never depends on publication
order, proved root injectivity holds where the operator checks were dropped,
noted `linkIn`'s deletion is semver-visible (fine under the `next` dist-tag),
and recorded one pre-existing, out-of-scope find: §C2b's own return self-frames
via `isEquivocation`, the accepted standard `fault.ts` already names. Suite
852 → 854.

## 2026-08-29 — Handoff: what force stopped guaranteeing, and the work it left

**Status: the branch `slice/force-is-the-effective-index` is parked, unmerged, and
is NOT to be fixed forward by patching.** §C2 as merged stands; the
implementation of it does not. This entry is the brief for whoever builds next.
It is written because the author of the branch was not confident in it and the
maintainer moved the build to a fresh instance.

### The one sentence

**Force stopped being an event on the venue and became a claim about one, and
every predicate that treated it as an event still does.**

Under the retired two-stage rule, a successor took force only by publishing its
own commitment. That bought three things at once, and §C2's new rule keeps only
the first:

- **Consent** — the co-signature keeps this, and it is real.
- **Totality.** `venue.latestFor(operatorInForce)` was a TOTAL function. Every
  reader that asks "what did the party of record last commit?" always had an
  answer: `provesHolding`, `isLatestAt`, `standingOutstanding`, `takeOver`,
  `committedWhileInForce`.
- **Custody.** In force ⇒ holds the book. Doors could gate on force alone and
  mean custody; the last committed state carrying a backing was always the
  incumbent's; a handover was proof a tail had really died.
- **Non-forgeability.** The role cost a witnessed commitment only the successor
  could pay, so no fact about an operator was writable by a third party. A chain
  link was evidence of an event, not an assertion about the future.

**The previous panel read "consent" as the whole of what the old bound was
buying.** It was buying totality, custody and non-forgeability too. Every finding
below is a site that leaned on one of those three and was not touched.

### Verified independently by the session model

Not taken on a reviewing agent's word — re-proved with fresh assertions:

- **A locked-out heir serves against an empty log.** After a zero-lead-time
  handover, `takeOver` throws, and the heir — in force, registered, holding
  nothing — still passes `requireServed`, `shut` and `inForce`. It accepted an
  issuance at position 0 with a co-signed receipt: **two live claims on one
  backing, both operator-attested, one by the operator of record.** Its own act
  then closes its escape, since `takeOver` also refuses a non-empty log.
  (`src/sequencer.ts:1396`, `:1215`, `:327`.) Slice 34b fixed this in `serves`,
  which gates `commit`/`snapshot`, and changed nothing on the write path.
- **One self-co-signed replacement kills the holder's redemption proof.**
  `provesHolding` is `true` for a silent operator with no handover, and `false`
  after one record naming a key the rule-holder generated and co-signed itself —
  while `isSilent` still reports the operator dark. The grade fires and the proof
  the remedy runs on is gone. The rule-holder is the backer by default: the party
  that owes the money. (`src/recovery.ts:490`, via `:463`.)
  *Not isolated:* the same reviewer reports `redemptionIsOpen` and
  `snapshotRedemptions`/`isLatestAt` (`:1095`) dying the same way. In the
  fixture used here `redemptionIsOpen` was false with and without the handover,
  so that half is UNCONFIRMED and needs its own fixture before it is relied on.
- The four blocking defects of the review round: the unrecoverable lockout, the
  one-way `holdsBook` latch with its `chain.findIndex` exemption, the silence
  grade cancellable by two published records, and the same-index tie resolved by
  arrival order. All re-proved.

### Reported and not independently verified

Read the reviewer's reasoning before trusting these; each cites file:line and
claims a run.

- **`takeOver` needs the incumbent's LATEST commitment** (`src/sequencer.ts:336`),
  so ONE never-committing link makes the backing permanently unrecoverable —
  independently of the lockout, and even with a generous lead time. The remedy
  chain completes and breaks at the last link: `isNonServing` fires, the
  rule-holder names a rescuer, and the rescuer cannot execute.
- **`eraLapsed`'s handover branch launders the operator-fault predicates**
  (`src/recovery.ts:769` → `src/receipt.ts:304` → `src/fault.ts:175`, `:216`).
  `fault.ts:170` already records this residual and prices it at "§15's price on
  the succession". That price is gone: a succession now costs one publication and
  a disposable key.
- **`eraLapsed` measures a successor's `after = 0` era from index 0**
  (`src/recovery.ts:765`), so an honest successor's whole first era is a
  permanent excuse for lies. The fix named is one the file already owns: floor
  the era at `clockStart`.
- **`standingOutstanding` unreadable after one replacement**
  (`src/recovery.ts:564`) — invariant 19's revocation stop-loss number gone.
- **Latent:** `caughtUp` gates on `isInForce` where 34b's rule is `serves`
  (`src/sequencer.ts:1354`); `committedWhileInForce`'s existence read is now
  vacuously false and safe only by luck (`src/fault.ts:301`);
  `isNamedSuccessor`'s safety argument names a door `takeOver` is not behind
  (`src/replacement.ts:350`); `firstCommitmentFor` is a retired-stage `Venue`
  method with one unaudited caller (`src/venue.ts:440`); `ErgoVenue.sync`'s
  fixed-point loop is dead and doubles a walk (`src/ergo.ts:268`).
- **Untested by mutation** (nothing fails when broken): the supersession
  boundary `<` → `<=` (`src/replacement.ts:273`) — which is the entire content
  of spec PR #8 — and the `effective >= incumbent.from` void filter
  (`src/replacement.ts:261`), without which a chain can be seated running
  backwards. Both need a test before anything else lands.

### Spec holes the rebuild must close first

§C2's new paragraph patched §C2's own text and did not reach §C2b. These read
false or undefined now, and **the redemption one has to be written first, because
the code's answer to it is what the verified finding above got wrong**:

1. §C2b redemption: "redemption against the last witnessed snapshot opens" —
   **whose** snapshot, when the operator in force has none?
2. §C2b returning: "returning is committing… rebuilds from its last commitment" —
   a successor that never committed is silent without ever having been present.
3. §C2b aggravated grade: "runs from the first missed commitment" — a successor
   has no first missed commitment.
4. §C2 lead time: names the zero-lead-time hazard and forbids nothing. That
   sentence is the licence the lockout walks through.
5. §C2 undertaking: "checked against the served state" — there is none for a
   successor that never served.
6. §C2b revocation: "reads what stands rather than what was committed" — the
   spec does not say whose commitment.

Plus two already owed: §C2's same-index tie, and what a revocation leaves open.

### For whoever builds this

- **Do not patch these one at a time.** Five patches on five gaps is §C0a rule 2
  exactly, and the author tried three fixes in one day and got all three wrong.
- Three panel angles were still running when this was written — how the book
  moves, the clock and the grades, and simplicity/consolidation. If their reports
  exist, read them before designing; if not, that panel is worth re-running, and
  the inventory angle above is the one that must not be skipped.
- The branch is worth keeping as an artifact: its tests encode real properties,
  and the co-signature and the retirement of the qualification machinery are
  probably right. What is wrong is everything that assumed force was an act.

## 2026-08-29 — The force-rule round: thirteen findings, one root, and a panel that did not look down

**Question:** the review round owed by `slice/force-is-the-effective-index`
(three commits: the co-signed replacement and force at the effective index, the
commit-scope rule, and the operator clock). Four angles, all Opus: the
succession walk and law, hostile parties, the test sweep, readers and encoding.

**Verdict: not mergeable, and not patchable by the author.** The branch stays
unmerged. What follows is the record; the rebuild is a panel's to shape.

**Note on how the round was run.** The first attempt at all four angles died on
a session usage limit before any of them reported. Two had left probe files in
the shared tree, and one of those probes — a `console.log` diagnostic, not an
assertion — exposed a real defect in the author's own fix. Every finding below
was re-proved with real assertions before being acted on, and the four blocking
ones were re-verified by the session model independently rather than taken on
the reviewing agent's word.

### The root

**Force became a rule-holder-chosen signed field, and three mechanisms went on
assuming that force implies "has committed".** Under the retired two-stage rule
that implication was free: a successor took force only by publishing a
commitment. Nothing replaced the guarantee, and the code that leaned on it was
not touched.

- **The book.** `takeOver` refuses once `isInForce`, because on main a successor
  was never in force when it called it.
- **The clock.** `clockStart` reads `link.from`, which the rule-holder now
  chooses, where it used to read a commitment the operator had to actually make.
- **The fault predicates.** `committedWhileInForce` and `isRewrittenHistory`
  rank an operator by `chain.findIndex` — its FIRST link — which was harmless
  while force and first-commitment coincided.

### Blocking (four)

1. **An unrecoverable lockout, reachable without an adversary.** §C2 admits
   `effective == witnessed`, so a replacement published at its own effective
   index seats the successor instantly; `takeOver` then throws "already in
   force" and the backing's log becomes unpublishable **by anyone**. Three
   escape routes were tried and all refuse. An honest heir that syncs ONE INDEX
   LATE is locked out identically, so this is a crash-and-restart hazard, not
   only an attack. **This is the conscription the co-signature was added to
   close, re-entered through the effective index**: consent to a message is not
   consent to the index at which somebody else publishes it.
2. **`holdsBook` is a one-way latch.** A re-appointed operator re-asserts its
   stale pre-handover book — `outstanding` observed reverting 150 → 100, a
   holder's units gone from the state of record — and `isRewrittenHistory`
   answers false in BOTH argument orders, because a re-appointed key ranks at
   its first link. Any key appearing twice in the chain is exempt from that
   fault by construction. The unprovability is the serious half.
3. **The silence grade is cancellable by publishing replacements.** Two venue
   records — hop to a throwaway key the rule-holder generates and co-signs
   itself, then hop straight back to the same never-committing operator — clear
   a standing §C2b grade and an open gap, with no commitment anywhere. §C2b's
   recovery path is the holder's only checkable remedy against a dark operator,
   and it is now cancellable at one record per duration by the party with the
   motive. Under the retired rule this was impossible: restarting the clock
   required breaking the silence. **Introduced by this branch's own third
   commit.**
4. **Two replacements witnessed at one index resolve by arrival order.** The
   candidate list sorts on `at` alone, so two honest wallets holding the same two
   records disagree permanently about who was operator at a PAST index —
   the "two readers disagree about who is at fault" hazard `fault.ts` forbids,
   arriving through publication order instead of served state.

### The rest (nine)

- **A candidate naming the incumbent CLEARS the supersession bar** rather than
  setting it, so a candidate witnessed arbitrarily late is seated — against both
  §C2's sentence and the function's own doc. Making the code match the sentence
  literally would brick the link forever, so §C2 does not cover its own
  revocation case and the code silently picked a reading, which CLAUDE.md
  forbids. Needs a spec sentence.
- **Mutation `<` → `<=` on the supersession boundary kills nothing** — and that
  strictness is the entire content of spec PR #8, made the same day. Its
  coverage left with the 270 deleted test lines, which had three tests sitting
  on exactly that index. So the deleted block was NOT only a fence around the
  retired stage, twice over: this and the same-index tie were both live.
- **Deleting the `effective >= incumbent.from` filter kills nothing**, and the
  chain can then be seated running backwards. Slice 34's entry claims that check
  was "retired as a live concern"; it is in the code and still firing. Entry and
  code disagree.
- **The first-witnessing dedup is LIVE, and this entry originally said the
  opposite.** The sweep angle found no discriminating case and concluded it was
  probably a dead fence to be deleted under §C0a rule 2. A later panelist found
  the case, and the session model ran it both ways: rule-holder names HEIR
  (witnessed 5, effective 20), revokes by naming OTHER (witnessed 12, effective
  30), and a STRANGER republishes the rule-holder's own first record at 15 —
  free, since `publishReplacement` verifies no signature. With the dedup, OTHER
  serves and the revocation holds. Without it, HEIR serves: **a stranger with no
  key of its own undoes a revocation.** Deleting it is a security regression.
  Recorded as a correction rather than edited away, because "a mutation nothing
  catches" is evidence of missing coverage and never on its own evidence that
  the code is dead.
- **`venue-refusal.test.ts` cannot see this class of regression.** Its scan
  matches `export function`, so `Sequencer` methods are invisible. `snapshot()`
  went from a pure ledger read that could not throw to one that raises
  `VenueError` on a partial view — the "honest operator reads as inauthentic"
  failure the file exists to prevent, in a shape its own guard will never flag.
- **The DoS constant doubled.** `publishReplacement` verifies no signature, so
  replacements are free to publish; `successionOf` re-verifies every record on
  every walk, uncached, now twice each. Measured ~9.4 ms per record, linear;
  `register` does roughly four full passes. Pre-existing shape, worsened here.
- **`linkIn` hands out a live reference** where `operatorIn` copies. Not
  reachable today, but the memoisation the DoS finding wants is what makes it so.
- **Comment drift**: several tests and two source docstrings still justify
  themselves with "force comes from the successor's own first commitment".
- **The two-read pair idiom survives in four fixtures**, where slice 34b's entry
  claims it is gone from the whole suite. Benign today; it is the exact shape
  that slice added a test to forbid.

### Clean, and worth keeping

Stability of past readings holds under a twelve-event sweep (zero changes);
termination is sound; `isSignedReplacement` refuses 18 hostile shapes without
throwing; the record round-trips strictly at 233 bytes; `replacementHash` is
still the right chain identity with two signers; the non-service grade still
reaches a locked-out heir's backing; and an exhaustive public/secret census
across every fixture found no key in a secret position. Two of the four defects
that killed slice 33 are genuinely closed: `serves` no longer flips mid-`commit`,
and the served set is read once.

### The process finding, which is the one worth carrying

**The panel decided a mechanism and nobody inventoried what the old mechanism
was silently guaranteeing.** Four angles argued simplicity, security,
practicality and consolidation about the force rule itself; none asked "what
currently depends on force implying a commitment?" All three blocking defects of
that family fell straight out of that unasked question.

The same shape appeared in the author's fixes: three patches in one day — slice
33 downstream of the circularity, `clockStart` as a fallback rather than a
maximum, and `clockStart` again resetting a grade it should not reach — each
made with high confidence about a thing just thought through, each wrong, each
caught by a reviewer rather than by its author. **A fix is a design decision and
gets a panel.** The rule added this morning said so for slices; it did not say
so for fixes, and fixes are where the evidence says the author is least reliable.

**Spec change:** none from this round. Two are owed by the rebuild — §C2's
same-index tie, and what a revocation leaves open.

## 2026-08-25 - Session close: the audit queue is done; what the next instance picks up

**Decision (the maintainer, 2026-08-25):** the 2026-08-22 audit queue is complete —
slices 28a, 28b, 29, 30, 28, each with its Opus review round, all merged, 784
tests green. Both repos pushed at the maintainer's instruction (mfp-reference main;
money-from-first-principles 589316a..6e5e4ff, the six spec sentences the
slices earned — pointers added to each slice's entry above).

**Queued for the next instance, in the maintainer's words "todos for another instance":**

1. **Locks keyed by (attempt, holder).** Open since 24c, resurfaced by every
   review since: it ends the whole squat family — the leg-slot squat, the
   pre-lock demand refusal, the acceptance-vs-leg slot collision — and would
   let `demandStands` and the "one slot, two locks" filing refusals be
   deleted, doors and counts agreeing by the law alone. A law change: hash
   keys in LedgerState, signerOf resolution, the hash-sharing rule and
   replays all move. Its own slice, tests first.
2. **`commit()` roots only the backings the operator is in force for.** The
   root cause behind slice 28's settledInPart false accusation (fixed
   reader-side with the pen-holder gate) and behind 28a's recorded wart that
   a retired operator's commitments root handed-over logs (isRewrittenHistory
   then names the heir). One mechanism would replace both patches; decide
   what a commitment may carry, and what takeOver inherits, before touching
   commit(). See the slice 28 entry's review round.
3. **The one-door refactor.** Every slice pays the nine-doors tax (shape →
   caughtUp → repeat → inForce → refusals → submit, hand-copied per door);
   one gate asked by all doors would make the next law change one edit.
   Standing offer, never ruled on — ask the maintainer before starting.
4. **CLAUDE.md restructure.** Short rules in CLAUDE.md, reasoning moved to
   DECISIONS; the file has grown past quick reference. Standing offer, never
   ruled on — ask the maintainer before starting.
   *[Landed 2026-08-27 — asked and approved; see the reorganization entry.
   CLAUDE.md is 394 lines and DECISIONS.md is an index over `decisions/`.]*

Residuals worth re-reading before any of these: the slice 28 entry's list
(the grade-suppression chase, the tail-shielded squat, settledInPart's
absence-has-no-prefix dodge), slice 30's clockless-reservation misses, and
slice 29's far-future-effective corner.

**Spec change:** the six above, made and pushed; nothing further proposed.
