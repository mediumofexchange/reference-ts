# Invalid-checkpoint recovery: candidate rules, the modelled result, and the decision boundary

Status: research proposal after the
[checked design review](../decisions/archive/2026-09-08-whole-project-design-review-check.md),
now with an executable candidate in `model/pool-fault.ts` and its cases in
`model/pool-fault.test.ts`. No normative rule, verifier authority or runtime
behavior is changed. Selecting a rule below is a material protocol choice
under AGENTS.md and remains the maintainer's.

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
draft **A** and the recommended form **A″**; the variant in which an excluded
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
| A″ (recommended) | Intrinsic exclusion; excluded carrying commitments do not close the interval; non-carrying commitments close it as today. | A reader classifies the carrying checkpoints it already replays for the snapshot; no new dependency on other scopes. Fault evidence must be retained: excluded checkpoints' bytes, or a certificate (below). | A withheld preimage is unresolved forever. |
| A (first draft) | As A″, but a non-carrying commitment closes the interval only where it classifies valid. | Adds the other scope's history, possibly another construction's, to every clock read of a dropped backing. | Same residue; the extra dependency buys nothing against a rational operator. |
| A′ | As A″, but an excluded carrying commitment still closes the interval (C2b.6.1 as written). | As A″. | A garbage stream keeps the gap shut forever; the only remedy is the count and E's replacement rule, which needs a live rule-holder or election. |
| B: prospective fault publication | Anyone publishes authenticated fault evidence at the venue; exclusion affects reads after that index; earlier force judgments use the record before it. | A new publication frame carrying the failing bytes (about 15 KB per proof, F5's chunking); readers verify what the venue carries. Exclusion is a record fact, so readers agree without holding the trail. | Same residue. Each garbage commitment needs a fresh publication; the operator pays one commitment, the challenger one framed proof. Releases judged before the publication stay without force. |
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
position `i` to the committed length (thirty-two-byte links, one per later
statement), the statement bytes and the proof bytes that hash to the bound
value. Verification is one proof check plus hashing. A replay conflict or an
import fault is certified by the ancestry that exhibits it, which is the same
evidence today's validation needs. Neither format is specified here; v3's
layouts must fix them before A″ is a rule.

## Costs of A″ against today's contract

- Every reader keeps or can fetch the bytes of excluded checkpoints for as
  long as descent may pass them; a successor's opening depends on them as it
  depends on its imports.
- A backing's clock read depends on the classification of its carrying
  checkpoints. It already depended on them for the snapshot, so a reader that
  can recover can also read the clock, and one that cannot draws no verdict
  either way.
- The receipt reader gains one step: an excluded checkpoint of the receipt's
  segment consumes its sequence and includes nothing. `classifyRepair`, the
  older per-boundary reader, was not extended.
- A faulted segment cannot be continued, even by the honest process that
  detects its own bug; it opens a new segment, as after a failed publication.

## Recommendation

Adopt A″ for v3 and treat availability as a separate decision.

- A″ repairs the failure the review found, an operator whose served bytes
  fail, with reads the protocol already has. It adds no frame, party or venue
  cost, keeps a backing's clock local to its own evidence, and lets holders
  reach venue redemption against a garbage stream with only the backer alive.
- A′ keeps C2b.6.1's wording but leaves a garbage stream able to keep the gap
  shut forever. The count and E's replacement rule are then the only remedy,
  and that rule is inert where E names the backer and absent where it names
  none.
- B makes exclusion a record fact at the price of a new frame, about 15 KB of
  venue bytes per fault paid by a challenger against one small commitment per
  round, and a watcher assumption. It answers the same failure as A″.
- C is the only family that addresses the residue, a commitment whose
  preimage nobody serves. It changes the venue's role or adds attestors, and
  full venue data prices every statement in venue bytes. It is complementary
  to A″ and can be decided after v3's layouts on F10's measured costs without
  undoing A″.

Nothing here reopens the September 7 finality boundary, independent
per-backing replacement or the confirmed presentation and recovery choices.
The recommendation was recorded on 2026-09-08; the selection remains the
maintainer's, and adversarial review of the model is owed before the rule
is text.

## Approval boundary

Selecting A″ amends pool-recovery.md C2b.3.1, C2b.5.2 and C2b.6.1,
pool-authority.md C2.10.3–4 and C2.10.9b, and v3's history binding; the model
is the oracle for that text. Selecting A′ keeps C2b.6.1 and changes the rest.
Selecting B adds a publication frame and an exclusion history. Selecting C
changes the venue contract. Approval of this investigation chose none of
them. The companion specification remains `main` at `3676757`.
