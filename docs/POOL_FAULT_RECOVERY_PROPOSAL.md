# Invalid-checkpoint recovery: candidate rules, the modelled result, and the decision boundary

Status: research proposal after the
[checked design review](../decisions/archive/2026-09-08-whole-project-design-review-check.md),
now with an executable candidate in `model/pool-fault.ts` and its cases in
`model/pool-fault.test.ts`. No normative rule, verifier authority or runtime
behavior is changed. Selecting a rule below is a material protocol choice
under AGENTS.md and remains the maintainer's.

The [adversarial review](../decisions/archive/2026-09-08-pool-fault-review.md)
found a dependency on other scopes through silence lapse, incomplete evidence
checks, unresolved reads that cannot recover when evidence arrives, and
receipt paths that do not implement the proposed rule.
The [reader repair](POOL_FAULT_READERS.md) now separates witnessing from
evidence-dependent validation and covers the review's reader defects with
27 new regression cases. The corrected model exposes the cross-scope lapse
dependency instead of hiding it. The earlier recommendation to adopt A″
remains suspended pending that dependency analysis; its segment-fault and
receipt-precedence choices remain open.

## The failure reproduced

The specification's recovery contract C2b.6.1 says a clock-resetting
commitment "need not be valid: an invalid commitment is provable fault, not
silence." C2b.3.1 says an invalid carrying checkpoint "is neither a snapshot
nor a licence to read an older one," and C2b.5.2 blocks the count the same
way; C2.10.3–4 block descent. `model/pool-fault-boundary.test.ts` reproduces
the effect: one signed checkpoint with a forged proof makes both backings of
its scope unrecoverable, uncountable and impossible to take over, while the
payment finalized before it stays final. Recurring invalid commitments keep
the clock reset; stopping opens the gap but leaves the snapshot blocked.

This is a liveness limitation, not permission to discard finalized holdings.
Fixing snapshot selection alone leaves the clock and descent blocked, so the
remedy needs one classification used consistently by every affected reader.

## Candidate A: intrinsic authenticated exclusion

Each required checkpoint has one of three classifications, relative to its own
record prefix and never to when a reader obtained its evidence:

1. **Valid**: it passed C2.10.3–4 and, where it has an opening, C2b.4.2.
2. **Excluded**: the bytes its signed commitment binds are held and fail the
   declared rules deterministically. The binding is established before
   validity is tested. Corrupt or mismatching bytes, missing preimages,
   unsupported verifiers and local programming failures establish no fault.
3. **Unresolved**: the reader lacks some evidence needed for either verdict:
   the checkpoint's own bytes, its imported ancestry, or a carrying checkpoint
   its descent passed or its clock read.

The rules over that classification:

- An excluded checkpoint supplies no canonical state, no import target and no
  clock reset. It stays at its witnessed sequence and consumes it. Descent,
  the snapshot, the count, the clock, receipt classification, the gap and the
  return all pass it on its evidence. Absence of evidence never justifies a
  step.
- A positive verdict — finality, force, a clean count, a successor's opening —
  needs every dependency valid or excluded. An unresolved dependency yields no
  verdict. Late evidence resolves; it never reverses, because classification
  is a function of the bytes.
- An excluded checkpoint faults its segment: one segment identity binds one
  history (C2.10.6), so no later checkpoint of that segment is canonical.
  Repair is a new segment on the exact canonical state reached through the
  evidenced exclusions, by the same operator or a successor. The faulted tail
  is discarded as a unit and its receipts read as abandoned under C2.10.9b:
  the sequence is consumed, so there is no hole and no repair excuse, and the
  key that signed it answers for it.
- Publications keep force according to their own record prefixes. A return
  adopts exactly the block with force, including at the opening's own index;
  a checkpoint omitting it is excluded, not merely doubtful.
- An excluded commitment **carrying** the backing does not close its
  interval (C2b.6.1). A commitment carrying nothing for it closes it as today,
  whatever that commitment's validity.

The last rule is where the model departs from the first draft of this
proposal, which excluded non-carrying commitments too. The model calls the
draft **A** and the previously recommended form **A″**; the variant in which an excluded
carrying commitment still closes the interval is **A′**.

## What the model shows

`model/pool-fault.ts` subclasses the recovery model and changes only the
reads the rules above name. Its nine cases, all over the same fixture as the
boundary tests (a payment finalized at index 3, one request per backing):

| Case | Result |
|---|---|
| Evidenced exclusion | Snapshot, count and descent pass the forged checkpoint; the count fires against the operator; a successor opens on the last valid state; the payment stays final; no semantic violation. |
| Withheld bytes | Snapshot, recovery state, clock, count and descent all refuse with "unresolved"; nothing rolls back; a successor cannot open. Restoring the bytes gives the evidenced verdicts. |
| Faulted segment | The door refuses further service; a re-signed continuation is excluded; a repair naming the excluded checkpoint or an older one is refused as stale; the new segment opens on the canonical state; the tail's receipt reads abandoned. |
| The clock | An excluded carrying commitment does not close the interval: the gap opens five indices after the last valid commitment and a release in it has force. Under A′ the gap opens five indices after the excluded commitment and the release has none; only the count remains. |
| A stream of invalid commitments | Neither closes the gap nor blocks the count; later ones lapse under C2b.4.1; the return is a new segment that must adopt the block before serving. |
| Successive gaps | When the checkpoint adopting the first gap's block is itself excluded, the snapshot is the valid opening and its adoption index reaches back, so the settled note stays settled and the next return adopts the first release only. |
| Rule 3 and 5 counterexample | Reading an unresolved checkpoint as valid says "no gap" and then, when the bytes arrive, "gap": a reversed verdict. The candidate gives no verdict until then. |
| Rule 1 counterexample | Reading unavailable bytes as fault passes a valid checkpoint that spent a note and lets a release settle that note: `settled note spent again`. The candidate refuses the read. |
| The non-carrying case | Under A″, X's clock is closed by a Y-only commitment whether or not that commitment is valid, and X's reader needs no Y evidence. Under A, X's clock waits on Y's history, and a Y-only garbage commitment leaves X's gap open. A **valid** Y-only commitment closes X's interval under both, so A's stricter clock protects only against garbage an operator could replace with a valid commitment at the same cost. |

## Comparison

| Candidate | Rule | Verification and availability dependencies | What it leaves |
|---|---|---|---|
| A″ (previous recommendation; review open) | Intrinsic exclusion; excluded carrying commitments do not close the interval; non-carrying commitments close it unless lapsed. | Ordinary non-carrying steps need authenticated absence, not the other scope's history. But proving that a non-carrying checkpoint lapsed during silence can require that scope's fault evidence. Fault evidence must be retained: excluded checkpoints' bytes, or a certificate (below). | A withheld preimage is unresolved forever; the claimed isolation from other scopes is not established. |
| A (first draft) | As A″, but a non-carrying commitment closes the interval only where it classifies valid. | Adds the other scope's history, possibly another construction's, to every clock read of a dropped backing. | Same residue; the extra dependency buys nothing against a rational operator. |
| A′ | As A″, but an excluded carrying commitment still closes the interval (C2b.6.1 as written). | As A″. | A garbage stream keeps the gap shut forever; the only remedy is the count and E's replacement rule, which needs a live rule-holder or election. |
| B: prospective fault publication | Anyone publishes authenticated fault evidence at the venue; exclusion affects reads after that index; earlier force judgments use the record before it. | A new publication frame carrying the failing bytes (about 15 KB per proof, plus authentication/suffix or ancestry evidence); readers verify what the venue carries. Exclusion is a record fact, so readers agree without holding the trail. | Same residue. Each garbage commitment needs a fresh publication; the operator pays one commitment, the challenger the complete certificate. Releases judged before the publication stay without force. |
| C: venue validates before admission | Only a commitment satisfying a declared availability requirement can reset the clock or supply a snapshot. | Changes the passive venue's role or adds attestors; a validity proof alone does not make reconstruction data available. | The only family that addresses the residue, at the cost of a new party or a full-data venue. |

The residue is the same under today's rules: a commitment whose preimage
nobody serves blocks every read, and no reader can distinguish that from an
honest replica failure, so no intrinsic rule may pass it (the check's F2:
"missing data must never authorize rollback"). What A″ repairs is the case
the review found: an operator whose served bytes fail, by bug or by design.
The withheld case needs an availability arrangement, which is C's family or
full venue publication; F10's measured comparison feeds that choice.

## The fault certificate

The model treats fault evidence as ideal. For the bytes, F2's binding is the
enabling change: with `proofHash` and `signatureHash` bound into
`historyHash_i`, a proof failure is certified by the signed commitment, the
directory path to the backing's snapshot digest, the history chain from
position `i` to the committed length, the statement bytes and the proof bytes
that hash to the bound value. Later history hashes alone do not authenticate
an interior event: each step needs the other inputs to the hash recurrence.
The v2 recurrence needs `statementHash`, `noteRoot`, `spentRoot` and position
per later statement (104 bytes, or 96 if position is derived). Appending two
32-byte evidence hashes directly would make that 168 bytes, or 160 with a
derived position, before framing and the target event's evidence. These are
conditional sizes, not a specified v3 certificate format. A proof-failure
certificate then needs one proof check plus its authentication checks and
suffix hashing. A replay conflict or an
import fault is certified by the ancestry that exhibits it, which is the same
evidence today's validation needs. Neither format is specified here; v3's
layouts must fix them before A″ is a rule.

## Costs of A″ against today's contract

- Silence lapse is no longer necessarily a public record-only condition. A
  non-carrying checkpoint may have lapsed because its own scope's clock
  excluded an earlier fault. Passing it then requires that evidence from the
  other scope; see the review's R1. Avoiding that cost needs another rule
  choice, not merely a reader fix.
- Every reader keeps or can fetch the bytes of excluded checkpoints for as
  long as descent may pass them; a successor's opening depends on them as it
  depends on its imports.
- A backing's clock read depends on the classification of its carrying
  checkpoints. It already depended on them for the snapshot, so a reader that
  can recover can also read the clock, and one that cannot draws no verdict
  either way.
- The receipt reader gains one step: an excluded checkpoint of the receipt's
  segment consumes its sequence and includes nothing. Both the present and
  supplied-boundary repair readers now pass exclusions in every relevant
  selection branch, retaining held sequences when checking for a real hole.
- A faulted segment cannot be continued, even by the honest process that
  detects its own bug; it opens a new segment, as after a failed publication.

## Recommendation

Do not adopt A″ as currently justified. Retain intrinsic authenticated
exclusion as the direction to investigate, price its complete lapse
dependencies, and settle receipt precedence before choosing
a rule for v3. Availability remains a separate decision. The earlier reasons
for preferring A″, qualified by the review, are:

- A″ repairs the failure the review found, an operator whose served bytes
  fail, with reads the protocol already has. It adds no frame, party or venue
  cost. Its ordinary non-carrying step avoids replay of the other scope, but
  silence lapse can still require that scope's evidence. It lets holders
  reach venue redemption against a carrying garbage stream with only the
  backer alive, provided the required evidence is available. An operator can
  still close a dropped backing's interval with a non-carrying commitment;
  that case continues to need the non-service count and replacement rule.
- A′ keeps C2b.6.1's wording but leaves a garbage stream able to keep the gap
  shut forever. The count and E's replacement rule are then the only remedy,
  and that rule is inert where E names the backer and absent where it names
  none.
- B makes exclusion a record fact at the price of a new frame, about 15 KB
  for a proof plus its authentication and any required suffix or ancestry,
  paid by a challenger against one small commitment per round, and a watcher
  assumption. It answers the same failure as A″.
- C is the only family that addresses the residue, a commitment whose
  preimage nobody serves. It changes the venue's role or adds attestors, and
  full venue data prices every statement in venue bytes. It is complementary
  to A″ and can be decided after v3's layouts on F10's measured costs without
  undoing A″.

Nothing here reopens the September 7 finality boundary, independent
per-backing replacement or the confirmed presentation and recovery choices.
The recommendation was recorded on 2026-09-08. Reader corrections have passed
focused independent adversarial verification. The remaining design findings
and specification choices must be resolved before the rule is text; the
selection remains the maintainer's.

## Approval boundary

Selecting A″ amends pool-recovery.md C2b.3.1, C2b.5.2 and C2b.6.1,
pool-authority.md C2.10.3–4 and C2.10.9b, and v3's history binding. C2b.4.1's
claim that silence lapse is public must also account for the evidence the
new clock reads. V3 must specify how evidence-bound history continuity
coexists with C2.10.6's proof-independent event identity and exact-replay
admission. The corrected, reviewed model must earn its role as the oracle
for that text. Selecting A′ keeps C2b.6.1 and changes the rest.
Selecting B adds a publication frame and an exclusion history. Selecting C
changes the venue contract. Approval of this investigation chose none of
them. The companion specification remains `main` at `3676757`.

Two choices inside A″ need an explicit answer as well:

- Does an authenticated invalid checkpoint end its segment's future service
  even when a stale twin signed it after a valid checkpoint? The conservative
  recommendation is yes, preserving every earlier finalized prefix and
  requiring a new segment on the canonical state.
- At what record boundary does fault abandon a tail, and can a later missing
  sequence or term end excuse it? The current candidate gives `pending`
  immediately after fault and can later give `lapsed`, despite the proposal's
  unconditional abandonment language. Specify the boundary and precedence;
  do not infer them from the existing test's hole-free repair case.
