# Check of the whole-project design review, 2026-09-08

This checks the [historical review](https://github.com/mediumofexchange/reference-ts/blob/f3ca8b4/decisions/archive/2026-09-08-whole-project-design-review.md).
Recommendations below are proposals, not protocol decisions. The
specification and implementation remain unchanged.

Checked against reference `53bcea0` and specification `3676757`: the stated
intent, Construction, the authority/recovery contracts, v2 layouts, relevant
runtime readers, models, and recorded proof evidence. Prior decisions were
not treated as justification. Two bounded independent readers checked the
product gaps and challenged the protocol remedies. No tests or benchmarks
were rerun; this is a design assessment, not a completed security audit.

The review is useful as a list of questions to settle before freezing v3.
Its factual gaps are stronger than several of its proposed solutions. Do not
approve F1–F5 as a package. The priority is a usable, recoverable private
payment under immutable terms, with evidence on the intended device and venue.

## Findings and recommendations

### F1 — Configuration coupling is real; mutable verifier authority is a new trust

Confirmed: `pool-v2.md` §§2–3 puts circuit/key identities in the backing name
and construction domain (`src/pool/statement.ts`, `configurationBytes` and
`configurationHash`). A changed configuration requires a successor. But an
available compiler/backend update does not itself change an existing backing:
the pinned artifacts can remain supported. “Re-issued at every toolchain
change” overstates the requirement.

The suggested verifier link is not the same trust as accepting the initial
configuration. Initial acceptance fixes a verifier; future discretionary
selection delegates continuing control over what counts as ownership and
conservation. A published registry needs an authority/update rule of its own.
Preserving commitments/nullifiers is necessary but does not prove two
verification relations equivalent or preserve their setup assumptions.

Recommendation: keep immutable verification semantics and artifact pins as the
default. Investigate separating claim identity from implementation artifacts
only with an explicit compatibility and historical-replay argument. Do not
give the replacement rule-holder open-ended verifier upgrade power. A change
to accepted semantics or trust still needs an explicit holder-authorized path.

### F2 — Serious recovery gap; authenticate faults, then model the complete remedy

Confirmed: v2 §9 binds evidence hashes in receipts, not the history hash;
`pool-recovery.md` C2b.3.1/C2b.5.2 block on invalid live checkpoints, and
`pool-authority.md` C2.10.3–4 blocks descent. Current tests deliberately retain
this boundary (`model/pool-authority.test.ts`, “never substitutes an older
valid checkpoint for present invalid or withheld history”).

Binding exact proof/signature bytes into history is a promising component.
It does not by itself authorize skipping a checkpoint. A mismatch between
alleged served bytes and a signed digest establishes unauthenticated evidence,
not operator fault. A corrupted replica does not permanently invalidate a
checkpoint if valid evidence survives elsewhere. An authenticated invalid
transcript is a different case. With a linear hash chain, inclusion evidence
can require a suffix or complete transcript; “compact, one verification” is
not established for the whole fault proof.

The proposed fix also misses the clock: C2b.6.1 explicitly lets invalid
commitments reset it. Repeated bad commitments can still prevent the gap from
opening even if snapshot/descent readers pass them. Changing that affects
when venue publications have force and what a returning segment must adopt.

Recommendation: highest-priority protocol investigation. Specify authenticated
fault evidence and model it together with descent, count, clock, recovery
force and adoption. Preserve every earlier finalized prefix and settlement;
exercise withheld fault evidence, differing reader knowledge, invalid suffixes,
later descendants and same-index ordering. Missing data must never authorize
rollback. Do not remove receipt evidence fields merely because history binding
is added; first demonstrate equivalent independent receipt verification.

### F3 — Require restoration; the encryption sketch is not yet a construction

Confirmed: v2 §3 privately delivers payer-derived openings; Construction §C4
says losing an opening loses the note. Seed-only note discovery is unspecified.
Require restoration from a seed plus available public evidence, and test it
with the payer and original operator gone.

Use a reviewed authenticated-encryption/address design, with discovery,
key separation, retry rules and output association specified. A bare
hash-derived keystream is not an adequately specified encryption scheme.
Adding X25519 for delivery does not explain how a sender derives a fresh
`owner = H(secret)` while only the receiver knows the spending secret.
Sharing one static receiving key also identifies the recipient to payers who
compare it; a payer-chosen diversifier does not erase that disclosure.
Do not assume this entire change stays outside circuits or costs 100 bytes.

[Zcash ZIP 32](https://zips.z.cash/zip-0032) and
[ZIP 307](https://zips.z.cash/zip-0307) are useful references for diversified
addresses and local note detection, not drop-in compatibility evidence.

### F4 — Fees need a realistic shape; reliance needs more than extra slots

Confirmed: v2 §7.2/§13 fixes 2×2. Payment, change and a separate fee need
three outputs in a single statement. This does not prove every separate-fee
or atomic-batch design impossible. Measure a direct three-output candidate
before selecting bounds; preserve per-backing conservation.

The recovery contract's demand is for one backing (§C3.2), and §8 excludes
reliance. Larger arity alone does not define multi-backing locks, settlement,
atomicity or cross-operator failure. The release contract already starts with
roots and no reliance. Keep that first slice explicit, but retain a separate
completion requirement for cover if the finished protocol claims to support it.

### F5 — Publication framing is missing; venue incompatibility is not established

Confirmed recorded proof size: 14,656 bytes (`docs/pool-v2-verification.json`).
Recovery release includes proof-bearing settlement and other evidence
(`pool-recovery.md` C3.6/C2b.3.2). The 4 KB box limit is corroborated by
[Ergo documentation](https://docs.ergoplatform.com/dev/protocol/eutxo/ergo_vs_cardano/).
A box limit is not a transaction limit: the upstream
[node configuration](https://github.com/ergoplatform/ergo/blob/master/src/main/resources/application.conf)
sets a separate 98,304-byte mempool transaction limit. These observations do
not establish acceptance on a pinned deployment; this check did not verify
the box constant against a pinned node/SDK version.

Recommendation: first prototype complete publication across multiple outputs
of one transaction, with canonical object identity, chunk count/order,
reassembly, byte limits and one effective venue index. Test incomplete,
conflicting and duplicate objects, fees, minimum box values and retrieval
after outputs are spent. Use multiple transactions only if needed, with their
completion rule specified. Budget the entire release, not just its proof.
Do not switch proof systems solely because one proof exceeds one box, or assume
a per-circuit setup is interchangeable with the current setup assumption.

### F6 — Correct the cold-start argument; retain one production implementation

Paper §§13–14 and the glossary conflict with the construction's direction.
Correct “both core settings” and explain what a small pool does and does not
hide. Small-set inference is not equivalent to publishing every transfer.
A transparent Extensions profile need not have a maintained implementation
in this repository. Recommend continuing the shielded production path and
the existing frozen oracle until its cases have replacements. Device evidence
could justify revisiting feasibility; text tension alone does not.

### F7 — Preserve independent exit; alternative B removes its own remedy

The complexity cost is real, but a line count is not a requirements argument.
Alternative A trades cross-backer pooling for a shared replacement authority;
that is an explicit privacy/authority trade, not free simplification. A first
deployment can use one backer's scope under the current rules. Sharing a key
alone does not enforce whole-scope replacement: that unit and its atomicity
would also need rules.

Reject B as written: Construction C2b.5 says non-service supports replacement
and does not open snapshot redemption. C2b.6 requires no commitment for that
remedy. A hostile operator can keep committing while refusing departure.
Removing forced replacement removes the remedy the non-service grade invokes.
B needs a separately derived forced exit, and receipt abandonment does not
automatically disappear: elective scope changes also produce it under
C2.10.9b. Recommend retaining independent replacement unless a simpler design
demonstrates comparable exit rights and failure containment.

### F8 — Agree with removing unsupported core refusal promises

C2.2.2 explicitly uses the state-reading extension; the card and C2.2.3 promise
an aggregate over signed refusals that the current pool does not implement.
Move those extension-specific promises together, including affected references
in C2b.6 and C4. Retain the explanation of the veto and the core's actual remedy.

### F9 — Measure the current construction; the review quotes older performance

No phone/browser measurement was found. Current v2 recorded `proveMs` values
are about 3.94 s for one real input plus padding, 3.93 s for two same-backing
inputs, and 4.82 s for two backings; some cases reach about 10.6 s. The review's
1.1–1.7 s and memory figure describe the earlier experiment, not a measured
mobile budget for v2. Whole-process desktop RSS is not a proved WebView limit.

Measure cold startup, repeated payment proving, verification, memory, download,
resync and restoration on a named low-end phone/browser with stated budgets.
Use current v2 as a baseline, then measure representative candidate changes.
One successful proof is a first experiment, not deployment acceptance.

### F10 — Require independently available verification data

The availability risk is real, but C0b already says backers pay for replication
and holders replicate. The missing part is a working, tested retention and
retrieval arrangement. The operator is not the only possible data holder.

Reject public-input-only publication as a complete solution. It reconstructs
asserted transitions, but an independent reader still needs proofs, issuance
signatures, terms and ancestry to establish that these are valid holdings.
Soundness is essential to recovery, not an optional reader preference. F3 also
requires recoverable ciphertexts. Chain publication needs archival retrieval
assumptions as well; an old spent box is not necessarily in a current UTXO view.

Recommendation: an explicit complete evidence-retention contract and a test
where a fresh reader verifies and restores after the operator disappears.
Compare full venue publication with independent replication using measured
costs. Do not default Ergo to an incomplete trail and call availability solved.

### F11 — Consolidate semantics after substantive choices

Agree with clearer normative organization and glossary repair. Cross-linked
contracts are fragmentation, not by themselves conflicting rules. Consolidate
semantic rules in Construction while retaining versioned encodings, circuit
relations and artifact identities together. Archive v1 without breaking links
or reinterpreting its historical bytes.

### F12 — Build a bounded vertical prototype before freezing layouts

No complete pool wallet/payment/redemption/venue path exists. Real-proof
claim-layer admission, import and replay do exist (`scripts/pool/check.mjs`).
The September 5 production gate table understates current model/runtime work.

A finished production redemption path cannot precede the specification of its
objects. Build a clearly provisional integration prototype and device/venue
probes to inform v3, then specify/model the production rules before implementing
them. Include interruption, restored wallet and operator disappearance; a happy
path alone will miss the main intent failures.

### F13 and F14 — Clarify carefully

F13: distinguish finalized holdings from provisional receipt liability in the
law's explanation. “Witnessed” alone is insufficient: an invalid checkpoint
may itself be witnessed and still finalize nothing.

F14: pin the payout's clock interpretation to its declared venue and leave
cross-venue continuity unsupported until specified. An index map alone does
not establish a safe bridge; ordering, finality, replay protection and recovery
rights must also survive. A successor remains the explicit default.

## Recommended next work

1. Set the prototype's acceptance contract: private root payment with realistic
   fee/change, receiver discovery, restoration, independent supply verification,
   and recovery without the original operator. Name device and resource budgets.
2. Run device and complete venue-publication probes; prototype delivery and
   restoration using available v2 objects and clearly provisional additions.
3. Resolve authenticated invalid-checkpoint handling as one modelled protocol
   change covering the clock and adopted recovery state. Keep verifier authority
   immutable unless a separate compatibility proposal clears the same bar.
4. Settle measured statement bounds, note delivery and complete availability;
   then freeze v3, consolidate semantic text, and implement against the model.

The governing recommendation is to bring feasibility and recovery evidence
forward without buying convenience through a new discretionary authority.
