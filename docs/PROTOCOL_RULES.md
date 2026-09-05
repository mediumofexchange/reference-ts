# Protocol implementation rules

This is the detailed, on-demand companion to `AGENTS.md`. Each binding rule
names the specification rule it implements, the code that holds it, and the
test that would fail if it stopped holding. Read the relevant row when
changing that mechanism; workflow and handoff rules live in `AGENTS.md` and
`WORK.md`. Plain terms only, in the words Construction uses.

**Where the code stands.** Construction's core claim layer is the shielded
pool (§C1.2). This repository's transparent path — `ledger.ts`,
`sequencer.ts`, `presentation.ts`, `replacement.ts`, `recovery.ts`,
`fault.ts` — implements the transparent *profile* (Extensions) and is
**frozen**: it is a differential oracle and a library of adversarial cases
while the pool path is built, and it is deleted when the pool path passes
those cases. Rows marked *frozen* describe what that code does today,
including two mechanisms the specification has since retired. Rows marked
*core* bind the pool path too.

## Binding rules

None of these is sacred. Any rule can change — with a good reason, agreed
with the maintainer, by editing the specification first and then this file.
What is never acceptable is silent drift: code that quietly stops following a
rule while the rule still stands.

| Rule | Spec | Code | Test | Scope |
|---|---|---|---|---|
| Quantities, counts, positions and payout arithmetic are `bigint`; `number` only for lengths and indices. | — | everywhere | `encoding-primitives` | core |
| A backing's name is the hash of the canonical encoding of (K, P, R, E); same fields, same bytes, on every machine. | inv 1 | `backing.ts` `backingName` | `invariant-01` | core |
| A backing exists only with a valid strict (non-ZIP215) signature by K over its own name; K is a non-small-order point; identity is recomputed at signing, verification and registration, never trusted from a cached field. | inv 2 | `backing.ts`, `keys.ts` `verifySignatureStrict` | `invariant-02` | core |
| Issuance and reissuance never share a code path: issuance changes the outstanding count and needs K's signature; movement does neither. | inv 7 | `ledger.ts` | `invariant-07` | core |
| No clawback, reversal, freeze or privileged move exists as a path. | inv 8 | `ledger.ts` | `invariant-08` | core |
| Fees are ordinary transfers, never a shaved reissue. | inv 9 | `ledger.ts` | `invariant-10` | core |
| `outstanding = issued − burned` per backing at every published moment; presentation destroys nothing. | inv 10 | `ledger.ts` | `invariant-10` | core |
| No cycle detection; a reliance cycle would need a hash cycle. | inv 5 | `closure.ts` | — | core |
| `closure(S)` expands deterministically before hashing, counts sum where paths meet, size is capped; `closureOf` is a tool for writing terms, `closureStatus` is what a reader asks. | inv 16, §8b | `closure.ts` | `invariant-16` | core |
| Quantities are whole units; R is a conjunction over a fixed list with constant whole counts naming backings and chain assets only. | inv 13–15, 18 | `backing.ts`, `presentability.ts` | `invariant-13.*` | core |
| An unaccompanied claim is inert, never invalid, and still transferable. | inv 17 | `presentability.ts` | `invariant-17` | core |
| Time is a witnessed venue index, never a clock; one evaluation instant per presentation, named in the demand, agreed by the acceptance, no later than the latest witnessed index at signing. | inv 21, 24 | `venue.ts`, `sequencer.ts` | `invariant-21`, `invariant-24` | core |
| Every time rule is a refusal, never a balance change, so an honest history stays replayable. | decision 2026-08-21 | `sequencer.ts` | `c3-lock-timeout` | core |
| Every state a sequencer asserts proves against its latest commitment; the root is injective over the issuance log, spent set, totals, standing demands and pending locks. | inv 22, 23 | `commitment.ts` `stateRoot` | `invariant-22`, `invariant-23` | core |
| A commitment authenticates a sorted directory of (backing name, snapshot digest). A name present without its log is unavailable evidence; absence from the directory proves the commitment does not carry the backing. Directory framing v1 (`MOED`), signature context `moe/commitment/v2`; earlier roots are incompatible. | §C0b, C2.4.2 | `commitment.ts` | `commitment-directory` | core |
| A receipt names the commitment its operator last *signed*, never a witnessed index; the record answers *holds* (by exact sequence), *not reached*, or *moved past*. | C2b.4, C2.3.4 | `receipt.ts` `eraIndex` | `c2b-receipt-era`, `c2b-the-blind-window` | core |
| A replacement is co-signed by its successor and takes force at its effective index; the chain from the original terms is walkable; `successionOf` stops at the last link whose index has arrived. | C2.5.1–2, C2.5.6 | `replacement.ts` `successionOf` | `c2-succession`, `c2-force-is-effective` | core |
| A replacement's effective index is at least twice the venue's lag plus one past its witnessing; the venue's id binds its lag. | C2.5.3, C2.3.5 | `replacement.ts` `admitted`, `venue.ts` `lag()` | `c2-the-lead-time` | core |
| A replacement not strictly later than the link it replaces is void unless it names the incumbent (a revocation); two replacements of one link resolve by C2.5.5. | C2.5.4–5 | `replacement.ts` | `c2-succession` | core |
| A venue's record for one key rises in sequence as it rises in index: it keeps only what strictly extends. | C2.3.3 | `venue.ts`, `ergo.ts` | `c2-venue-records` | core |
| One commitment stands in flight; the next waits for the record to show it or for the lag to pass. Its sequence is one past the highest this operator has signed. | C2.4.3, C2.4.1 | `sequencer.ts` `inFlight` | `c2-the-resume` | core |
| An operator serves the log its own signed-but-unwitnessed commitment stands on. | C2.4.4 | `sequencer.ts` `serves` | `c2b-the-blind-window` | core |
| A commitment never silently drops an in-force backing. | C2.4.5 | `sequencer.ts` `commit` (`dropping`) | `c2-dropped-backing` | core |
| A key seated anew, or returning from silence, commits before it co-signs. | C2.7.4, C2b.4 | `sequencer.ts` `shut`, `restore` | `c2b-return-from-silence` | core |
| A restarted process resumes each backing from its own latest witnessed commitment and commits nothing until the lag has passed. | C2.8 | `sequencer.ts` `awaitingTakeover` | `c2-the-resume` | core |
| Takeover. A seat's opening state is the last commitment carrying the backing, by a party then in force, witnessed strictly before the effective index; the record fixes it, never the seat. **Frozen implementation:** `takeOver` descends from the operator's own link, paying each step past a non-carrying commitment with that commitment's *whole served state* as an exhibit, and where the descent cannot be paid the operator signs an *opening claim* in its next commitment (`commit({ opening })`). Construction C2.7.2 now pays each step with a directory absence proof and C2.4.5 retires the opening claim (Appendix). Do not port either retired mechanism to the pool path. | C2.7 | `sequencer.ts` `takeOver`, `serves`, `lastCommitmentInForce` | `c2-the-book`, `c2-the-cold-walk`, `c2b-the-record-is-the-backings` | frozen |
| Every operation is signed by the party the law names, over that backing's own message, at that signer's next nonce — except the n-party commit, which names no backing, carries no nonce, and is signed by every party the lock names. | law, §C1.7 | `ledger.ts`, `messages.ts` | `invariant-06` | frozen (per-holder nonces are the transparent profile's; the pool's replay protection is the nullifier set and inv 26) |
| Swaps and presentation are idempotent: a resubmitted operation returns the identical prior receipt; a different operation at a spent nonce is declined. | inv 26 | `sequencer.ts` | `invariant-26.*` | core |
| Settlement voids the exact claims offered only on the holder's release; dishonour is the branch where no live acceptance answers; an acceptance may not outlast the demand's deadline. | inv 27, §C3 | `presentation.ts` | `invariant-27`, `c3-payout-in-claims` | core |
| The non-service count stands against the backing and the grade names the incumbent; a handover neither resets nor moves it. | C2b.5 | `recovery.ts` `isNonServing` | `c2b-non-service` | core |
| The no-commitment clock is the backing's: it runs from the last commitment by a party then in force, or from index zero, and only a commitment closes it. | C2b.6 | `recovery.ts` `isSilent` | `c2b-silence-and-recovery` | core |
| A revocation is per venue, effective at its witnessed index, prospective. | C2b.1 | `revocation.ts` | `c2b-revocation` | core |
| The snapshot a holder redeems against is the backing's: the last carrying commitment by a party then in force, whichever term it fell in. | C2b.3 | `recovery.ts` | `c2b-redemption-legs`, `c2-dropped-backing` | core |
| Conflicting signed histories are provable fault: two signatures at one nonce, a double position, a double acceptance, a rewritten history. | inv 22 | `fault.ts` | `provable-fault` | core |
| A venue's refusal is not a verdict: `VenueError` propagates through every verifier that takes a `Venue`, in one place (`answering`); the pilot boundary maps it to `unavailable`. | design | `venue.ts` `answering`, `pilot-store.ts` | `venue-refusal`, `pilot-store` | core |

### Presentability and the lock (inv 13–15, 18; §C3)

- A demand reserves each leg with a `lock` in that leg's own log, so every backing stays replayable alone; the sequencer takes the demand and its locks as one act or none (single-phase).
- Two-phase across operators is `submitLock` + `settle`: the holder reserves at each sequencer, publishes one commit at a decision venue, and each settles its own half against that witnessed object. The n-party exchange (§C1.7) is the same mechanism: a sequencer converts its lock only when every party the lock names has signed.
- A lock names who may convert it. One party converts on their release or commit; several only on the witnessed object. A set leg names no decision venue (`NO_DECISION_VENUE`) and settles only with its set.
- A bundle lock is prepared only where the sequencer can read the commits it may settle on, and only for an attempt the record does not show committed.
- Two-phase is not the only honest answer: partial-and-retry (§C2.9) is the ordinary transfer path; which branch a trade uses is the parties' choice.
- Where P pays in claims, the backer's acceptance reserves the payout — its lock on the paying backing, to the holder, convertible by the holder alone — and the release settles set and payout as one act (`payoutOf`).
- Whether a demand's legs were locked is read across the served state by `accompanimentOf`; converter and venue are one definition, `LegTerms`.
- A lock carries §C3's timeout, and `lockIsLive` is the one predicate both exits read: at or before it a commit can settle and no withdrawal is accepted; past it withdrawal is the exit, unless the record shows a commit witnessed in time (`committedInTime`). Exactly one exit is open at every index.
- A leg that lapses inside a live acceptance is re-prepared through `submitLeg`, one leg per call; a demand outlives its locks. A deadline and a timeout are strictly ahead of the index at filing.
- A lock is keyed by (attempt, holder); a release or withdrawal names the record it ends. A venue-naming attempt is named by the hash of its terms, `H(salt ‖ venue ‖ timeout ‖ parties)` (`attemptIdOf`), so one attempt carries one timeout across backings and operators; the salt is drawn at random by the party.
- An entry's identity is its signed message, plus — for a commit alone — its signatures (`opIdentityOfEntry`); one answer serves the receipt, the committed root and the rewritten-history comparison.

## What the parties must do, that no code here enforces

Rules the protocol cannot check but the reference must not leave unsaid. Each cites the specification rule it follows from.

1. **Restart in order** (C2.8): register every backing you serve, resume each from your own latest witnessed commitment, commit nothing until the venue's lag has passed, and only then let the commit timer run. Keep every committed state you published; a takeover step is paid with evidence only you may hold.
2. **One writer at a time, or a threshold key** (C2.5.8). Two live processes holding one operator key co-sign conflicting operations, and `fault.ts` proves that as if it were malice. A t-of-n threshold with t > n/2 removes the possibility rather than recording it.
3. **A threshold K, or theft is unbounded** (C2b.1). Revocation is a stop-loss, not a remedy.
4. **The payee keeps the signed request and the receipt** (C2b.4). During a gap the receipt is the only evidence outside the operator's log that an operation was accepted, and the request is what makes it resubmittable. Read the receipt's era: one naming a commitment below the record's, or an era before the operator's current seat, is stale on its face.
5. **Do not accept a claim while the operator is dark** (C2b.3–4). Nothing moves until the operator returns or a successor takes over; a payee that accepts anyway relies on the challenge window, which binds a careless double-spender and never a deliberate one. What the payee does get is a fault proof any stranger can check.
6. **Keep the last committed state, and its directory, that carries your backing** (C2.7.2, C2b.5). Every remedy against an operator that drops one backing runs through that state, and the party holding it has the motive not to serve it.
7. **A payment is final when witnessed, not when co-signed** (C2.9, C3). An operation accepted after the operator's last commitment lives only in its unpublished log and dies with it. A set is one act and dies as one; perform only against the witnessed whole.
8. **Handover conduct** (C2.6): commit at the first clock you can read a handover replacing you; co-sign nothing on that backing once the lag reaches its effective index; read a pending handover before treating a payment as final. The caution is yours; no door enforces it.
9. **Draw a fresh random salt per attempt** (§C3). A commit binds its id and nothing else, so an object you signed converts any later lock under that id whose parties you are among.
10. **Check your counterparty's lock stands under the attempt you agreed** before you sign the exchange object.

A receipt proves **acceptance, not a holding**: it attributes an act to the operator and never proves a value to a holder.

## Design rules

The invariants above say *what* must be true. These say *how* to build it. The goal is a reference implementation an auditor can read once and be convinced by: **smallest, then most secure, then fastest — in that order when they conflict, except that security never loses to size.**

**One mechanism per property.** If a property is enforced in three places, an auditor must check three places and a maintainer can break it in three ways. When a fix is needed, first ask whether an existing mechanism should be generalised. Never layer a second mechanism on a first to patch its gap; that is how a review finding becomes permanent complexity. This is Construction §C0a applied to code, and the specification holds itself to the same test.

**Say it plainly.** Names in code, comments and tests use Construction's words: commitment, directory, record, effective index, opening state, nullifier. No new metaphors. Cite rule numbers (`C2.5.3`) rather than quoting paragraphs.

**Bytes are framed, not concatenated.** Every field in a signed or hashed message is fixed-width and asserted to be, or length-prefixed. Two different values must never produce one byte string. Use `ByteWriter.key32` / `ByteWriter.fixed` for fixed-width fields.

**Validate once, at the boundary that owns the rule.** `makeBacking` owns backing well-formedness; the ledger or pool owns the law and funds; the sequencer owns routing and refusal. A layer does not re-check what a layer below will check, and does not pre-check in order to relabel an error.

**Copy on the way in, copy on the way out.** Bytes entering validated state are copied once at construction; every accessor returns a copy. `readonly` is erased at runtime and is not a boundary.

**Verifiers never throw.** Anything that answers a question about adversary-supplied data returns `false` or a typed rejection on any malformed input. A verifier that throws is a denial-of-service hole and tempts a caller to read "no exception" as "checked".

**But a venue's refusal is not malformed input.** A real venue holds a partial view and refuses what it was not synced for; answering `false` there states a fact about a party built out of not having looked. So `VenueError` propagates where everything else is caught, in one place — `answering` in `src/venue.ts` — and `venue-refusal.test.ts` holds every verifier that takes a `Venue` to it.

**An error names the boundary that refused.** `EncodingError`, `SigningError`, `LedgerError` (`NonceError`), `SequencerError`, `VenueError`, `PilotError`. Do not add one without a new boundary to name.

**Domain tags live in one file.** Every context string that separates one signed message type from another is declared in `src/contexts.ts`, and the prefix-free property is asserted at load. A tag collision is a signature-forgery class.

**Cryptography is hashes, signatures and the declared proof system, and nothing else.** `@noble/hashes`, `@noble/curves`, and the pinned circuit backend the pool declares in **E**. A new primitive is a decision, not a dependency bump.
