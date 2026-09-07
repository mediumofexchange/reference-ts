# Shielded snapshot recovery and the unwitnessed tail

Status: proposal for maintainer decision, 2026-09-07. Construction and the
pinned `moe/pool/v2` construction are unchanged. This is a design gap in the
next construction, not a finding that v2 violates its declared scope.

## The exact rule that cannot be ported

[Construction C2b.3](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/construction.md#c2b-failure-silence-and-recovery)
says that during a challenge window anyone may publish:

> the holder-signed spend that consumed the named note; on publication the
> redemption pays the payee that spend names instead

A [pool-v2 spend](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/pool-v2.md#72-spend)
has two input nullifiers and two output commitments. Its proof establishes
knowledge of the input secrets. It has no holder signature, named payee or
public output amounts. An output's `owner` commits to a receiver secret; it is
not an external payout address. A receiver receives its own opening privately.

[Section 7.4](https://github.com/mediumofexchange/money-from-first-principles/blob/da80f85/pool-v2.md#74-redemption-and-what-this-version-does-not-carry)
already excludes presentation, snapshot redemption and venue-nullifier adoption
from v2. It requires those objects to be specified together for a later version.
The durable store therefore correctly refuses silence-clause backings today.

## Existing executable counterexamples

These are valid transaction shapes already exercised by the existing circuits,
not hypothetical malformed statements. The real-proof fixtures are in
[fixtures.mjs](../scripts/pool/fixtures.mjs), and
[check.mjs](../scripts/pool/check.mjs) proves the padded, same-backing and
cross-backing spends. Both Linux and Windows proof jobs passed in
[CI #46](https://github.com/mediumofexchange/reference-ts/actions/runs/34140840332)
at implementation commit `3711368`.

1. **Split: 100 becomes 40 and 60.** Suppose Bob owns the 40 output and Alice
   owns the 60 change. Redirecting Alice's entire snapshot redemption to Bob
   gives him 60 too much. The public statement does not label an output as
   payment or change. Opening Bob's output alone supplies neither authority
   nor payout instructions for Alice's 60. This split also runs through
   [pool admission](../test/pool-admission.test.ts), retaining both outputs
   and the consumed input's nullifier.
2. **Merge: 100 + 80 becomes 110 and 70.** A challenge against the 100 input
   alone cannot fund the 110 output. Paying only 100 introduces a partial
   settlement and leaves the rest to be defined. Applying both outputs requires
   atomically consuming the other 80 input and preventing its separate recovery.
   The conservation relation does not assign particular output units to one
   input. With two backings, both backing states and their recovery eligibility
   must participate; one backing's silence cannot authorize another's debit.
3. **A later unwitnessed spend needs its predecessor.** If Bob spends the 40
   onward to Carol before either transfer is finalized, Carol's note is absent
   from the snapshot. Bob's spend alone cannot prove that its input belongs
   to finalized state. Applying Alice's spend first creates Bob's output; it
   does not decide Carol's recovery. Continuing requires dependency evidence,
   which becomes a graph after merges. The model and
   [segment tests](../test/pool-segment.test.ts) already exclude unfinalized
   tails from ordinary import. No new tail-recovery path has been tested here.

Even with all openings supplied, two different valid spends may consume the
same snapshot input. Cryptographic validity does not decide which unwitnessed
spend wins. Selecting one by venue order adds a transfer-finalization mechanism;
an operator receipt does not itself provide that authority.

## Prior decision and proposed policy

The [August 20 decision](../decisions/2026-08.md#2026-08-20---the-challenge-windows-reach-and-why-no-patch-fits-it)
records the maintainer's instructions: the challenge window is not patched to
reach further, and the uncommitted tail is not rescued. A receipt attributes
an act to the operator and does not prove a holder's value. The decision also
rejects recovery through chains of holder provenance.

That decision does not itself delete C2b.3's remaining challenge promise. The
shielded construction therefore needs an explicit decision about its scope.

**Recommendation:** retire spend-based payee redirection and its associated
challenge window for the later shielded recovery construction. Retain the
transparent profile's existing behavior as historical/profile behavior, without
porting or extending it. Proposed wording for the shielded C2b.3 contract:

> Snapshot recovery recognizes holdings proven in the canonical finalized
> snapshot and valid recovery settlements witnessed afterward. An unwitnessed
> spend or receipt does not redirect another holder's recovery. Recovery does
> not finalize the discarded tail.

The deliberate cost is that a recipient who accepted an unwitnessed payment
cannot use that payment to take value from the payer's snapshot holding. The
receipt remains evidence of the operator's acceptance, subject to the existing
receipt verdict rules. Those rules do not guarantee external compensation.
Wallet policy must distinguish accepting that exposure from holding finalized
value. A statement that was finalized remains final through later silence or
replacement; it is never part of the discarded tail.

**Alternative:** rescue whole statements and their required dependencies. This
can conserve quantity only if all inputs are consumed and all outputs inserted
atomically, with complete evidence, conflict ordering and recovery eligibility.
It reopens the prior no-tail-rescue decision and needs a separate protocol
design. Public proof chains do not automatically reveal every holder identity,
but opening outputs for payout can disclose amounts and link payments. No
claim is made here that a private rescue construction is impossible.

## What approval would and would not establish

Approval would settle the loss allocation and remove the inherited redirection
requirement from the future shielded contract. It would not make v2 support
recovery or select new wire bytes. Before implementation, the later construction
must still define the following together under section 7.4:

- A proof of positive-value note inclusion, ownership and its immutable
  nullifier, with non-membership in the snapshot's spent set. Absence of an
  arbitrary nullifier is not proof that anyone owns a claim.
- Canonical snapshot selection across replacement and whole-scope finality,
  complete witnessed-record evidence, and the backing's silence clock.
- Demand, backer acceptance and holder release bound to one payout and one
  settlement. Proof requests must not authorize release. Payout performance
  needs the agreed evidence; a burn does not prove external payment.
- A supply-preserving recovery transition: redemption leaves outstanding
  unchanged and makes the backer a holder. Adopting nullifiers alone would
  consume value without creating the backer-owned notes. A burn is a separate
  authorized act, not an implicit meaning of redemption.
- Replay identity, duplicate-settlement refusal, witnessed gap adoption,
  return commitment and the first index at which service can resume. Include
  releases witnessed at the return commitment's own index when checking C2b.4.
- Multi-backing presentation, pending locks, atomic commit or abort, non-service
  evidence, and precisely what a recovery reveals. Venue and construction
  boundaries need an explicit support/refusal rule.

Reuse the current note and spent-set primitives, canonical checkpoint readers,
receipt evidence and durable journal pattern where their contracts fit. Do not
reinterpret the pinned v2 frames or enable the store's refused silence path.
Any new rule and construction must land in the specification first, then in an
adversarial model, then in the implementation with independent review.

## Review evidence and remaining decision

Independent design review confirmed the missing named-payee/holder-signature
objects, the split/merge/dependency counterexamples, and the prior decision's
bar against whole-tail rescue. It also identified the positive-inclusion proof
and backer-owned replacement-note requirements above. This was a read-only
review of the specification and existing sources, not a security proof or a
review of an implemented recovery mechanism.

Maintainer decision needed: approve the recommended finalized-snapshot policy
and retire spend-based redirection and its window for shielded recovery, or
explicitly reopen the design to rescue unwitnessed transactions.
