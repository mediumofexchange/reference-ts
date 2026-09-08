# Invalid-checkpoint recovery: candidate rules and decision boundary

Status: research proposal after the
[checked design review](../decisions/archive/2026-09-08-whole-project-design-review-check.md).
No normative rule, verifier authority or runtime behavior is changed.

## The failure now reproduced

The specification's recovery contract C2b.6.1 says a clock-resetting commitment
“need not be valid: an invalid commitment is provable fault, not silence.”
C2b.3.1 says an invalid carrying checkpoint “is neither a snapshot nor a
licence to read an older one.” `model/pool-fault-boundary.test.ts` reproduces
both effects. It preserves a finalized payment while demonstrating that both
backings in the scope lose recovery and successor import after a forged proof.

This is a protocol liveness limitation, not permission to discard finalized
holdings. Fixing snapshot selection alone leaves the clock and other readers
blocked. The highest-priority remedy therefore needs one classification used
consistently by every affected reader.

## Candidate A: intrinsic authenticated exclusion

The first candidate to model is a construction that defines, from its start,
three outcomes for each required checkpoint: valid, excluded with authenticated
evidence, or unresolved. Classification is relative to the checkpoint's own
record prefix, never to the time a reader downloaded its evidence.

1. A fault witness authenticates the signed commitment, the relevant header,
   statement, history position and exact proof/signature bytes, then shows a
   deterministic contradiction under the declared rules. The binding must be
   established before testing validity. Corrupt bytes, missing preimages,
   unsupported verifiers and local programming failures establish no fault.
2. Excluded checkpoints supply no canonical state, import target or clock reset.
   They remain at their witnessed sequence and consume that signed sequence.
   Descent, snapshot, count, opening/repair, receipt status, gap and return use
   the same classification. Authenticated exclusions justify traversal; absence
   of evidence does not justify it.
3. A positive finality or recovery-force verdict needs valid or excluded
   classifications for every dependency affecting it. An unresolved dependency
   produces no verdict. In particular, unresolved must never mean “the release
   had no force” while a descendant omitting that release is accepted.
4. An earlier finalized prefix remains final. Repair/replacement opens a new
   segment on the exact canonical state reached through evidenced exclusions;
   it neither chooses an arbitrary old state nor rescues selected unwitnessed
   tail statements.
5. Publications have force according to their own record prefixes and indices.
   Descendants adopt precisely those effects, including the opening's own
   index. Late evidence may resolve an unresolved read; it cannot reverse a
   correctly established finality or force verdict.
6. These rules apply only to a construction declaring them. Existing immutable
   backing terms are not reinterpreted.

This avoids adding a new authoritative event to the passive venue, but adds
verification and availability dependencies to clock reads. Exact fault framing,
traversal evidence and the full transition model remain to be built. This
proposal is not evidence that the candidate is already correct or practical.

## The non-carrying commitment is the critical case

X has finalized state at index 3 and a silence duration of 5. At 8 its operator
publishes a commitment carrying only Y, with authenticated directory absence
for X and an invalid Y proof. X's demand and release are published at 9 and 10.
A new X segment opens at 11 and later tries to commit without adopting them.

If the bad commitment at 8 is excluded, it did not reset X's clock: those
publications may have force and the child must account for them. A reader
that used directory absence to avoid Y's history, counted 8 as a reset and
finalized the child would later discover that it accepted the wrong state.

Candidate A must refuse that early verdict. Directory absence establishes
carriage; it does not establish the validity of a clock reset. This can require
evidence from other scopes and even other constructions served by the operator.
It weakens verification locality and availability compartmentalization. That
cost must be measured and accepted explicitly, or another mechanism selected.

## Alternatives

| Candidate | Rule | Cost and limitation |
|---|---|---|
| A: intrinsic exclusion | Authenticated invalidity excludes a checkpoint at its historical position. Every dependent positive verdict waits for sufficient classification evidence. | Additional history/verifier dependencies, including non-carrying resets. No verdict from missing evidence. |
| B: prospective fault publication | Anyone publishes deterministic authenticated fault evidence; exclusion affects only reads after the event is witnessed. Each historical force judgment uses only prior events. | A new permanent publication frame and exclusion history. Earlier releases do not activate retrospectively. Fresh malicious commitments can require fresh exclusions; progress against a stream is not established. |
| C: venue validates before admission | Only a validated commitment satisfying a declared availability requirement can reset the clock or supply a canonical candidate. | Changes the passive venue's role. A validity proof alone does not make the reconstruction data available; full carriage or another explicit availability arrangement is needed. |

A and B both remain conditional on data availability. An arbitrary signed
digest whose preimage is unavailable supplies no authenticated invalid proof
to exhibit. Calling that absence invalidity would also permit rollback after
an honest replica failure. C only helps if its availability requirement is
concrete and enforced under declared assumptions.

## Next model and approval boundary

Model A first as a provisional candidate, with departures that expose:
non-carrying clock resets, delayed fault evidence, mistaken no-force verdicts,
prior finalized spends, same-index adoption, successive gaps, repeated bad
publications and completely unavailable digest preimages. Reuse the existing
authority and recovery models; do not add a parallel production reader.

Compare its evidence/verification cost with B before selecting a normative
rule. Selecting A's enlarged dependencies, B's new publication mechanism or
C's changed venue contract is a material protocol choice under AGENTS.md.
Approval of the investigation does not silently choose one. The companion
specification remains `main` at `3676757` until that choice is made concrete.
