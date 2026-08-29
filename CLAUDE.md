# reference-ts

TypeScript reference implementation of the **Medium of Exchange Protocol**:
one object `B = (K, P, R, E)`, claims held against it, wallets, and the law.

Published to npm as `@mediumofexchange/reference`, under the `next` dist-tag
while the API moves.

Three names, three jobs, so it is clear which one a change belongs to:

- **Money from First Principles** — the paper. Why the object is what it is.
  Keeps its own name; it is an argument, and arguments are cited, not
  versioned.
- **Medium of Exchange Protocol** — what `construction.md` and `extensions.md`
  define. The thing that gets built, and the thing an implementation tracks.
- **reference-ts** — this repository. One way to build it.

## The spec is a reference, not gospel

- Spec: https://github.com/mediumofexchange/money-from-first-principles
  (the derivation is in `money-from-first-principles.md`, the build machinery
  in `construction.md`, optional profiles in `extensions.md`).
- The code tracks the spec as it stands, not a snapshot. When the spec
  changes in a way that touches implemented code, the code changes to match;
  divergence between the two is a bug in one of them. Check the spec repo for
  recent changes when starting a work session.
- The spec can contain mistakes. When implementation work reveals a
  contradiction, an ambiguity, or something that cannot work as written:
  **stop, quote the exact passage, explain the problem in plain language, and
  propose a fix to the spec.** Never silently build around a spec bug, and
  never pick one of several possible readings without flagging the choice.
- The spec is corrected upstream (issue or edit on the paper repo), then the
  code follows the corrected spec. Resolved questions are logged in
  `DECISIONS.md` — not to lock them forever, but so that reopening one is
  done knowingly, with the earlier reasoning in view. That file is an index:
  one line per decision, with the entries themselves in `decisions/` by month.
  Read the index, then open only the entry you need — never the whole log.

## Scope (current)

Transparent setting only. In scope: canonical encoding of backings, hashing,
signatures, issuance, swaps (transfer), presentation, the conservation
arithmetic. **Out of scope for now:** blinding, the accumulator and pooled
constructions, the Chaumian profile, shielded anything, external references,
triggers, pro-rata. Cryptography is limited to hashes and signatures
(`@noble/hashes`, `@noble/curves` — no other crypto dependencies).

## Binding rules

Construction.md §C0 says: an implementation that violates an invariant is a
different system. These are the ones that bind every line of code here.

None of them is sacred. Any rule below can change — but a change needs a very
good reason, stated explicitly and agreed with the maintainer, and it happens by editing
this file (and the spec, where the spec is the source). What is never
acceptable is silent drift: code that quietly stops following a rule while the
rule still stands.

Each rule says what must hold and names the code that holds it. The reasoning
that produced it is in the decision log — reach it through the index in
`DECISIONS.md` rather than restating it here.

- **All quantities, counts, and payout arithmetic use `bigint`.** The
  JavaScript `number` type is a float; a rounding error in this system is a
  counterfeit. `number` may appear only for things that are genuinely not
  quantities (array indices, lengths).
- **A backing's name is the hash of a canonical encoding of (K, P, R, E)**
  (inv 1). Byte-deterministic: same fields, same bytes, on every machine,
  forever. No `JSON.stringify` of objects with unordered keys.
- **A backing exists only with a valid signature by K over its own name**,
  under a fixed domain-separation tag (inv 2). K must be a valid,
  non-small-order Ed25519 point, and verification is strict (non-ZIP215).
- **Issuance and reissuance never share a code path** (inv 7). Issuance changes
  the outstanding count and needs the backer's signature; reissuance preserves
  the count and needs none. In the transparent slice this reads as issuance vs.
  movement (transfer/burn); reissuance proper (denomination swaps) arrives with
  blinding.
- **No clawback, no reversal, no privileged party who can move claims**
  (inv 8). The rule is not "don't call it" — the code path must not exist.
- **Fees are ordinary transfers alongside a swap, never a shaved reissue**
  (inv 9).
- **Do not write cycle detection** (inv 5). A reliance cycle would need a hash
  cycle; it cannot be built.
- **`outstanding = issued − burned`**, in claim quantity, per backing, at every
  published moment (inv 10). Presentation destroys nothing; only a burn lowers
  the count.
- **An unaccompanied claim is inert, never invalid, and still transferable**
  (inv 17).
- **Time is a witnessed index, never a clock** (inv 21, 24). Every instant a
  party asserts is an index in the **venue's** witnessed history, never in the
  operator's own commitment history — a clock an operator could stop by going
  quiet would hand it every deadline in its book. No code reads wall-clock
  time. One witnessed evaluation instant per presentation, named in the demand
  and agreed by the acceptance, and no later than the latest witnessed index at
  signing.
- **Every TIME rule is a refusal and never a balance**, because the clock is
  undefined on a replay and a lock that freed its own units would make an
  honest history unreplayable.
- **Every state a sequencer asserts proves against its latest published
  commitment** (inv 22), and the commitment commits to the issuance log, the
  spent set, running totals and the standing demand record (inv 23). The root
  must be injective, or one signature covers two states and equivocation is
  unprovable.
- **A replacement is co-signed by its successor, and force is the effective
  index** (§C2). Naming somebody is not a power over them: signed by the
  rule-holder alone, one published record seated any commitment-publishing key
  as the operator of record of any backing, and its own next punctual commitment
  then proved a fault against it. Both signatures go over one message, so there
  is one record and one tag. Force being a signed field and nothing else is what
  keeps the succession walk a pure function of the venue record — condition it
  on served state and two readers disagree about who is at fault, which
  `fault.ts` forbids outright. `successionOf` stops at the last link whose index
  has arrived, so the chain's tip and the operator in force are one thing.
- **Every operation is signed by the party the law names, over that backing's
  own message, at that signer's next nonce — except the commit.** §C3's commit
  names no backing, carries no nonce, and is signed by every party the lock
  names (§C1's "all sign"), because one object has to be valid in every log of
  an exchange at once and a nonce is per (signer, backing). Those are the only
  departures in the system, and they are what "one object" costs. Do not add a
  third without the same kind of reason.
- **Swaps and presentation are idempotent** (inv 26). The sequencer returns the
  identical prior receipt for any resubmitted operation, presentation included,
  and declines a different operation at an already-spent nonce. A crash must
  lose nothing. The ledger alone rejects a replay (per (signer, backing) nonce)
  rather than answering it.
- **Settling a published demand voids the exact claims offered, and only on the
  holder's release signature** (inv 27). A backer must never void unilaterally.
  Dishonour is the branch where no *live* acceptance answers, so an acceptance
  that expires unpaid is dishonour too — and an acceptance may not outlast the
  demand's own deadline, because the lock-up is the holder's term to set.
- **`closure(S)` expands deterministically before hashing**; counts sum where
  paths meet; the stored object is flat; cap closure size (inv 16). `closureOf`
  in `src/closure.ts` is that macro, and it is a **tool for writing terms, not
  a rule about them** — §8b makes an unclosed R a readable setting, so
  `makeBacking` stores what it is handed and `closureStatus` is what a reader
  asks. Expansion takes a resolver, every answer is checked against the name it
  was asked for, and that check is also what makes the walk terminate without
  the cycle detection inv 5 forbids. A direct count is a floor, not a second
  contribution.
- **Quantities are whole numbers of the backing's declared unit**; counts in R
  are whole. Reliance is a conjunction over a fixed list with constant counts —
  no disjunction, no computed membership — and names backings and chain assets
  only.

### Presentability and the lock (inv 13–15, 18)

A holding is presentable at *b* for *q* iff it contains *q* units of *b* and
*q·cᵢ* units of each *(bᵢ, cᵢ)* in R(b). Units, never claims. One level, no
traversal.

- **A demand reserves each leg with a `lock` in that leg's own log**, so every
  backing stays replayable alone, and the sequencer takes the demand and its
  locks as one act or none (§C3's single-phase).
- **Two-phase across operators is `submitLock` + `settle`.** The holder reserves
  at each sequencer, publishes ONE commit at a decision venue, and each settles
  its own half against that witnessed object without hearing from the others.
  §C1's n-party exchange is the same mechanism: a sequencer converts its lock
  only when every party the lock names has signed, so a partial object settles
  nothing anywhere.
- **A lock names who may convert it.** One party converts on their release or
  their commit, several only on the witnessed object. A set leg names no
  decision venue (`NO_DECISION_VENUE`), so no commit reaches it; it is not
  retired, and it comes and settles only with its set — at filing, or
  re-prepared for a standing demand by its holder.
- **A bundle lock is prepared only where the sequencer can read the commits it
  may settle on**, and only for an attempt the record does not show committed.
- **Two-phase is not the only honest answer.** §C2's partial-and-retry is the
  ordinary transfer path and covers every trade where both sides have recourse.
  Which branch a trade uses is the parties' choice, not the implementation's.
- **Where P pays in claims**, the backer's acceptance reserves the payout — its
  lock on the paying backing, to the holder, convertible by the holder alone —
  and the release settles set and payout as one act (`payoutOf` reads it).
- **The law stays per backing.** Whether a demand's legs were locked is read
  across the served state by `accompanimentOf`, which the backer asks before it
  signs an acceptance. Converter and venue are one definition, `LegTerms`, for
  the sequencer and both readers; liveness is the law's at the doors and each
  reader's own on the venue's clock.
- **A lock carries §C3's timeout, and `lockIsLive` is the one predicate both
  exits read.** At or before it a commit can still settle the set and no
  withdrawal is accepted; a commit witnessed past it does not reach it, and
  withdrawal is then the exit — unless the record already shows a commit
  witnessed in time, which every reader asks before freeing anything
  (`committedInTime`). Exactly one exit is open at every index, per record.
- **A leg that lapses inside a live acceptance is re-prepared**, not lost:
  withdrawn alone and past its timeout, then locked again under the standing
  demand through `submitLeg`, one leg per call (§C3's "a demand outlives its
  locks"). A demand's deadline, like a lock's timeout, is strictly ahead of the
  witnessed index at filing — the same index is not a window.
- **A lock is keyed by (attempt, holder)**: a slot is its holder's own, so a
  stranger's lock is a record beside the set, never in front of it. A release or
  withdrawal names the record it ends — hash and holder, inside the signed
  message — because the law resolves the signer from the record, and **a leg ends
  the record the set names**, the door binding each leg's holder to the set's
  terms. A venue-naming lock names its own holder among its parties (§C1's "all
  sign"), which bounds what a commit converts: every lock under its attempt whose
  parties it satisfies, settled as one act. **A set leg is never in that match
  set** — it names no venue — and is excluded rather than thrown for. An attempt
  id names one attempt on one backing **for its holder**: once theirs has settled
  or withdrawn, a retry names a fresh id.
- **A venue-naming attempt is named by the hash of its terms** —
  `H(salt ‖ venue ‖ timeout ‖ parties)` (`attemptIdOf`, checked in the law):
  invariant 1's move, applied to the other object parties must agree on and none
  may edit alone. A matching id IS matching terms, so one attempt carries one
  timeout across backings and operators alike, and a stranger's differing terms
  are a different attempt. Drawing the salt at RANDOM is the party's; the law
  refuses only the value an omission produces. A set leg is the same rule — its
  attempt is its demand — and carries none, which the law does check.
- **An entry's identity is what decides its effect**, and one answer serves the
  receipt, the committed root and the rewritten-history comparison
  (`opIdentityOfEntry`): the signed message, plus — for a commit alone — its
  signatures, since those decide which locks it converts.

## What the parties must do, that no code here enforces

Eight rules the protocol cannot check but the reference implementation must not
leave unsaid. Each was reached by asking what a failing sequencer costs
somebody, and is recorded in the decision log with its reasoning.

The three holder rules are load-bearing. §C2b's recovery path does not protect a
holder who ignores them, and every mechanism that would reach further either
fails to close its own hole or does not survive the move to a blinded
construction — which is why they are rules here rather than code.

- **One writer at a time**, or a threshold key. Two live servers holding one
  operator key co-sign conflicting operations, and `fault.ts` proves that
  against the operator exactly as if it were malice — the protocol cannot tell
  a botched failover from collusion and does not try. A t-of-n threshold with
  t > n/2 removes the possibility rather than recording it; aggregated to one
  Ed25519 key it is invisible here, so the name, E and strict verification are
  untouched.
- **A threshold K, or theft is unbounded.** §C2b: a stolen backer key does
  damage that is "unbounded and permanent, since K alone authorises issuance
  and nothing expires", and revocation is a stop-loss rather than a remedy.
  Invisible here for the same reason as the operator rule — nothing in this
  repository can check that a backer took it.
- **The payee obtains the signed request and the receipt at payment time.**
  During a §C2b gap the operator's log is unpublished, so its receipt is the
  only evidence outside it that an operation was accepted at all. The signed
  request too, because a receipt given after the operator's last commitment
  dies with a gap: the operation is resubmittable by anyone holding the request
  once the operator serves again, and a payee holding only the receipt cannot.
  `submitTransfer` returns the receipt to whoever submitted, normally the
  payer. Read the receipt's era when taking it — `after` names the operator's
  last commitment, and one naming anything but the latest at payment time is
  stale on its face.
- **Claims go illiquid while the operator is dark. Do not accept one.** A
  transfer published at the venue is evidence, never an operation, so nothing
  moves until the operator returns or a successor takes over; the operator
  co-signs no new act while dark by its own declared measure. A presentation
  with legs neither opens nor settles in a gap — one predicate
  (`admittedInGap`) says so for the operator's adoption and the verifier's fold
  alike. A payee who accepts anyway is relying on §C2b's challenge window, and
  that window reaches a careless double-spender and never a deliberate one.
  What the payee does get is a fault proof: two of the payer's signatures at
  one nonce, checkable by any stranger forever, needing no operator and no
  commitment (`fault.ts`).
- **Keep the last committed state that carries your backing.** An operator that
  drops one backing from its commitments and keeps publishing the rest looks
  perfectly live, and a stranger reading a root cannot tell which backings it
  covers. Every path against that operator runs through the last state that
  *did* carry the backing — the non-service grade (`isNonServing`), the fault
  (`isRewrittenHistory`), the successor's takeover (`takeOver`). The party who
  would otherwise serve it on request is the one with the motive not to, which
  is the same shape as the receipt rule above: obtain the evidence while the
  party holding it still has a reason to give it to you.
- **A payment is final when witnessed, not when co-signed.** §C2: "Finality
  means witnessed rather than co-signed", and §C3 applies it to the release. An
  operation accepted after the operator's last commitment lives only in its
  unpublished log and in the receipt, and dies with it — in every construction.
  The operator's own side is code: **returning from silence is committing**,
  per backing. While a publication would still have gap force (`gapOpen`), the
  doors refuse every act and name the commit; where the silence is the
  operator's own, the commit first restores that backing's book to the last
  commitment (`restore`, the one place a log shrinks) and adopts what the venue
  witnessed. **A set is one act and dies as one**, so the sequencer takes it
  only over backings that declare one silence duration — and a handover takes
  no tail (`takeOver`), so perform only against the witnessed whole. What was
  co-signed after the last commitment and before the silence is dead, and the
  receipt makes that readable: it names its era (`after`); an era ended by a
  return or a handover lapses its receipts (`eraLapsed`, `receiptStatus`), where
  one ended at an ordinary commitment carried its whole tail — so an attested
  operation missing then is `contradicted`, and a pair one log cannot hold is a
  fault (`isDoublePosition`, `isDoubleAcceptance`, both excusing a lapsed era).
  §C2 makes the exposure "a signed field rather than operational discretion": E
  carries the interval with the venue it is read on, so a payee can tell a fast
  operator running late from a slow one running on time (`isOverdue`).
- **Draw a fresh random salt per attempt** — what "never reuse an attempt id you
  signed a commit for" became. A commit binds its id and nothing else, so an
  object you signed converts any later lock under that id whose parties you are
  among, on another backing too. The id is its terms' hash now, so a *derived*
  salt makes a repeat trade the same attempt; randomness also keeps the venue
  from reading your party set off the id.
- **Check that a lock of your counterparty's stands under the attempt you
  agreed** before you sign the object. One timeout per attempt is the law's now,
  so passing that check implies their terms are yours; nothing helps a party who
  does not check.

A receipt proves **acceptance, not a holding**: a payee who was paid and paid
onward still holds the receipt for what they received, and reading it as a
holding is how a redemption pays a party that has already spent. The durable
form, and the one that decides what may be built on a receipt: **it attributes
an act to the operator, and never proves a value to a holder.** A chain of receipts back
to committed state would prove the value — and that is provenance, which is
precisely what blinding exists to destroy, so it is ruled out here rather than
deferred.

## Design rules

The invariants above say *what* must be true. These say *how* to build it. The
goal is a reference implementation an auditor can read once and be convinced by:
**smallest, then most secure, then fastest — in that order when they conflict,
except that security never loses to size.**

**One mechanism per property.** If a property is enforced in three places, an
auditor must check three places and a maintainer can break it in three ways.
When a fix is needed, first ask whether an existing mechanism should be
generalized. Never layer a second mechanism on a first to patch its gap: that
is how a review finding becomes permanent complexity. A fix that adds a layer
is a signal the layer below is in the wrong place. This is construction.md
§C0a applied to code — the spec holds itself to the same test, so fix it
there rather than restating it here.

**Bytes are framed, not concatenated.** Every field written into a signed or
hashed message is either fixed-width and asserted to be, or length-prefixed.
Never write a variable-length field raw. Two different values must never
produce one byte string — hashed identity and commitment roots depend on it,
and adjacent unframed fields silently destroy it. Use `ByteWriter.key32` /
`ByteWriter.fixed` for fixed-width fields; they assert the width at the one
place that writes it.

**Validate once, at the boundary that owns the rule.** `makeBacking` owns
backing well-formedness; the ledger owns the law and funds; the sequencer owns
routing and refusal. A layer does not re-check what a layer below will check
anyway, and does not pre-check in order to relabel an error — give the lower
layer a distinguishable error type instead.

**Copy on the way in, copy on the way out.** Bytes entering validated state are
copied once at construction; every accessor returns a copy. `readonly` is
erased at runtime and is not a boundary. This is deliberate cost paid for
invariant 8: no accessor may hand out a write path into state.

**Verifiers never throw.** Anything that answers a question about
adversary-supplied data (`verify*`, `*ProvenBy`, `isEquivocation`, decoders)
returns `false` or a typed rejection on *any* malformed input — wrong lengths,
non-integer positions, out-of-range quantities. A verifier that throws is a
denial-of-service hole and tempts a caller to read "no exception" as "checked".

**But a venue's refusal is not malformed input.** A real venue holds a partial
view and refuses what it was not synced for, and answering `false`, `undefined`
or `"unrelated"` there states a fact about a party built out of not having
looked: an honest operator reads as inauthentic, a punctual successor as silent,
a stolen key as live. So a `VenueError` propagates where everything else is
caught. That is one rule, in one place — `answering` in `src/venue.ts` — because
it was written by hand three times and forgotten four, each time one layer above
the last. `venue-refusal.test.ts` holds every verifier that takes a `Venue` to
it; a new one belongs in that list.

**An error names the boundary that refused.** `EncodingError` = these bytes or
fields are not well-formed. `SigningError` = you asked me to sign with a key
that is not yours. `LedgerError` = the law refuses (`NonceError` = this nonce
is not the signer's next). `SequencerError` = this operator declines to serve
you. `VenueError` = the record will not accept this. Do not add a sixth
without a new boundary to name.

**Domain tags live in one file.** Every context string that separates one
signed message type from another is declared in `src/contexts.ts`. A tag
collision is a signature-forgery class; the full list must be readable on one
screen.

**Efficiency where it is free.** Prefer the direct algorithm over a clever one,
and the allocation-free form over the allocating one, when it is no less
readable — exact-integer arithmetic over string round-trips, one buffer over
per-item allocation, a keyed lookup over a linear scan. Do not trade clarity
for speed anywhere else; this is a reference implementation, not a product.

## Workflow

- **Plan before code.** For each slice: propose the approach, wait for the maintainer's
  approval, then build.
- **A design decision gets a panel before it is implemented.** Where a slice turns
  on a choice — a mechanism, a boundary, what a rule should be — run independent
  angles on the CHOICE and let the recommendation come out of them, rather than
  proposing an answer and asking a panel to bless it. Angles where applicable:
  simplicity, security, practicality, and whether it consolidates with a mechanism
  that already exists. Decided 2026-08-29, after a slice whose shape was chosen
  solo and whose review round then found the shape itself unbuildable.
- **Tests first, named for invariants.** Test files follow
  `invariant-07.issuance-paths.test.ts`. Each test carries a one-line
  plain-language statement of what it checks. the maintainer reviews the tests; the
  implementation is judged by the tests.
- **Prove it, don't argue it.** A bug is demonstrated by a script that runs the
  exploit, and the fix by that same script failing to exploit it. An argument
  that code is wrong is a hypothesis; only a run settles it. Scratch scripts are
  gitignored `.mjs` files in `scratch/`.
- **Regression-review the fixes.** After fixing review findings, review the
  fixes themselves. Every round so far has found a real bug there, and the
  recurring shape is a fix that bounded one input and left the other open.
- **A refusal added at a door names the honest path it leaves open, and a test
  walks it.** Slice 26 closed a stranger's door and the holder's re-prepare with
  it; the regression review asked "what else does this refuse?" only about
  strangers. A door closed to one party is a door closed to everyone who used it.
- **A test's name is a claim the test must exercise.** A test titled "can be
  relocked" that never relocks is how a behaviour retires unnoticed.
- **Explain, don't just produce.** When asked to explain, walk through the code
  in plain language rather than restating the types. Prefer readable code over
  clever code everywhere — an auditor reads this once and has to be convinced.
- **Small commits, one slice per branch.** Run `/code-review` before merging
  to main. Never push without asking.
- **Every change gets a review round**, not only the ones that feel large enough
  to warrant one. A slice does not merge with the round owed; a session that
  cannot run one has a reason to stop, not a reason to ship. If the harness a
  session runs under forbids spawning agents, say so when reading this file
  rather than at the end of the slice.
- **Review agents run on Opus.** Every agent spawned for a review — the
  `/code-review` finder angles, the verify pass, the regression reviews of a
  fix round — is started with `model: "opus"`; the session model does the
  synthesis, the verdicts and the fixes. A review is judgement work and a weaker
  model would miss the shape these rounds keep finding, but it does not need the
  session model's cost at every angle. **The session model decides which angles
  to run and how many**, sized to what the slice touches — the law, an encoding,
  a reader, a door — rather than to a fixed count; it says in DECISIONS which it
  ran. Decided 2026-08-22: a fixed count spends its effort on angles the slice
  never touched.

## Toolchain

Node 24, TypeScript (strict), Vitest.

```
npm test           # run all tests
npm run typecheck  # tsc --noEmit
```

Scratch scripts (`scratch/*.mjs`, gitignored) import `./src/*.js`, so they run
against a compiled copy: `npx tsc --noEmit false --outDir <build> --rootDir .`
from the repo, then copy the script beside `<build>/src`, link `node_modules`
there, and `node` it from `<build>`.

`npm run check:docs` holds CLAUDE.md to its line budget and keeps the decision
index and `decisions/` in agreement. CI runs it, along with typecheck, the
tests on Node 20 and 24, and a `npm pack` of what would be published.
