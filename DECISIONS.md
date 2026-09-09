# Decisions

Dated design decisions for the protocol and reference implementation, indexed
newest first. Entries record what was chosen and why, including alternatives,
costs, evidence and links to specification changes.

The monthly records preserve the reasoning at the time. Some describe superseded
designs or completed investigations. Use the [architecture](docs/PRIVATE_PAYMENT_ARCHITECTURE.md)
for current component status, [protocol rules](docs/PROTOCOL_RULES.md) for binding
implementation requirements, and [WORK.md](WORK.md) for the active task.

## Recording a decision

Add an entry to the current month in [decisions/](decisions/) and one link to
the index. Write in neutral project language: record the choice and its basis,
without attributing authority to a person or model, quoting conversations, or
turning review rounds into a diary. Preserve substantive review findings and
evidence limits. Source/specification quotations are appropriate when needed
to identify an ambiguity. Git records authorship and change history.

Use the fields that apply; a routine progress update belongs in WORK.md.

```text
## YYYY-MM-DD — short title
**Status:** accepted, superseded (link), or deferred (condition).
**Question:** exact ambiguity or problem, with relevant rule references.
**Decision:** selected behavior and scope.
**Rationale:** alternatives, tradeoffs, invariants and accepted costs.
**Evidence:** tests, measurements, review findings/disposition and limits.
**Spec change:** immutable specification link, or "none needed".
```

Reopen a decision when new evidence or a missed requirement warrants it; link
the replacement so readers can follow the change without treating old proposals
as current instructions.

## Index

- `2026-09-09` [Check the range source before certificate packaging](decisions/2026-09.md#2026-09-09--check-the-range-source-before-certificate-packaging)
- `2026-09-09` [Frame served trails without granting opening validity](decisions/2026-09.md#2026-09-09--frame-served-trails-without-granting-opening-validity)
- `2026-09-09` [Carry exact target bytes in fault evidence](decisions/2026-09.md#2026-09-09--carry-exact-target-bytes-in-fault-evidence)
- `2026-09-09` [Reuse the segment header fields for v3](decisions/2026-09.md#2026-09-09--reuse-the-segment-header-fields-for-v3)
- `2026-09-09` [Bind successor snapshots and receipts to exact event evidence](decisions/2026-09.md#2026-09-09--bind-successor-snapshots-and-receipts-to-exact-event-evidence)
- `2026-09-09` [Fix canonical successor statement and publication records](decisions/2026-09.md#2026-09-09--fix-canonical-successor-statement-and-publication-records)
- `2026-09-09` [Fix the six successor proof layouts before configuration adoption](decisions/2026-09.md#2026-09-09--fix-the-six-successor-proof-layouts-before-configuration-adoption)

- `2026-09-09` [Pool demands authorize notes without identifying the demander](decisions/2026-09.md#2026-09-09--pool-demands-authorize-notes-without-identifying-the-demander)
- `2026-09-09` [Spent roots use a canonical compressed binary tree](decisions/2026-09.md#2026-09-09--spent-roots-use-a-canonical-compressed-binary-tree)
- `2026-09-09` [Fees are ordinary outputs in the successor spend](decisions/2026-09.md#2026-09-09--fees-are-ordinary-outputs-in-the-successor-spend)
- `2026-09-09` [Receiver-prepared outputs restore from bound public capsules](decisions/2026-09.md#2026-09-09--receiver-prepared-outputs-restore-from-bound-public-capsules)
- `2026-09-09` [The v3 recovery choices: the notice is the proof's public inputs, only settlement or withdrawal discharges a demand, and the release publishes no non-membership proof](decisions/2026-09.md#2026-09-09--the-v3-recovery-choices-the-notice-is-the-proofs-public-inputs-only-settlement-or-withdrawal-discharges-a-demand-and-the-release-publishes-no-non-membership-proof)
- `2026-09-08` [Adoption retains witnessed proof evidence](decisions/2026-09.md#2026-09-08--adoption-retains-witnessed-proof-evidence)
- `2026-09-08` [Authenticated faults preserve the last valid state and the clock reads its snapshot](decisions/2026-09.md#2026-09-08--authenticated-faults-preserve-the-last-valid-state-and-the-clock-reads-its-snapshot)
- `2026-09-08` [Intervening silence retires a pool segment and lapses its unfinished receipts](decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)
- `2026-09-07` [The pool's presentation and recovery contract: whole-note demands by tag, a lit settlement to the backer, force once at the venue, and the return as a new segment](decisions/2026-09.md#2026-09-07--the-pools-presentation-and-recovery-contract-whole-note-demands-by-tag-a-lit-settlement-to-the-backer-force-once-at-the-venue-and-the-return-as-a-new-segment)
- `2026-09-07` [Shielded recovery preserves finalized holdings without payee redirection](decisions/2026-09.md#2026-09-07--shielded-recovery-preserves-finalized-holdings-without-payee-redirection)
- `2026-09-07` [A carrying scope change decides a receipt: proven repair lapses it, an elective change abandons it](decisions/2026-09.md#2026-09-07--a-carrying-scope-change-decides-a-receipt-proven-repair-lapses-it-an-elective-change-abandons-it)
- `2026-09-07` [Proven failed-publication repair can lapse unfinalized receipts](decisions/2026-09.md#2026-09-07--proven-failed-publication-repair-can-lapse-unfinalized-receipts)
- `2026-09-06` [pool-v2 instantiates the authority contract: a domain-only configuration, a public scope tree, the segment in every statement, one anchor per input, and finalized import](decisions/2026-09.md#2026-09-06--pool-v2-instantiates-the-authority-contract-a-domain-only-configuration-a-public-scope-tree-the-segment-in-every-statement-one-anchor-per-input-and-finalized-import)
- `2026-09-06` [Private service scopes import only finalized shared history](decisions/2026-09.md#2026-09-06--private-service-scopes-import-only-finalized-shared-history)
- `2026-09-05` [The claim layer: E declares the construction as clause 0x05, the host hash is a pinned Poseidon2, and admission verifies the proof before one synchronous view](decisions/2026-09.md#2026-09-05--the-claim-layer-e-declares-the-construction-as-clause-0x05-the-host-hash-is-a-pinned-poseidon2-and-admission-verifies-the-proof-before-one-synchronous-view)
- `2026-09-05` [pool-v1 pins the shielded pool, and the sequencing model earns two rules](decisions/2026-09.md#2026-09-05--pool-v1-pins-the-shielded-pool-and-the-sequencing-model-earns-two-rules)
- `2026-09-05` [The finished protocol: the shielded pool is the core, the lit settings are profiles, and C2 is re-derived against the directory](decisions/2026-09.md#2026-09-05--the-finished-protocol-the-shielded-pool-is-the-core-the-lit-settings-are-profiles-and-c2-is-re-derived-against-the-directory)
- `2026-09-05` [One private product and real-proof feasibility](decisions/2026-09.md#2026-09-05--one-private-product-and-real-proof-feasibility)
- `2026-09-04` [Durable transparent pilot and named commitment directory](decisions/2026-09.md#2026-09-04--durable-transparent-pilot-and-named-commitment-directory)
- `2026-09-04` [Slice 39 verification: a venue answers an exact sequence; pending receipts remain non-final](decisions/2026-09.md#2026-09-04--slice-39-verification-a-venue-answers-an-exact-sequence-pending-receipts-remain-non-final)
- `2026-09-04` [Panel: the blind window — an operator serves the book its own signature put the record on, and a receipt names the commitment rather than the index](decisions/2026-09.md#2026-09-04--panel-the-blind-window--an-operator-serves-the-book-its-own-signature-put-the-record-on-and-a-receipt-names-the-commitment-rather-than-the-index)
- `2026-09-03` [Panel: the lead time — the floor is the venue's lag plus one, and a door reads force where an act signed now is first witnessed](decisions/2026-09.md#2026-09-03--panel-the-lead-time--the-floor-is-the-venues-lag-plus-one-and-a-door-reads-force-where-an-act-signed-now-is-first-witnessed)
- `2026-09-03` [Four recommendations, decided: the lead time now, the platform verifier and the root framing next, the count method and the drifting clock deferred](decisions/2026-09.md#2026-09-03--four-recommendations-decided-the-lead-time-now-the-platform-verifier-and-the-root-framing-next-the-count-method-and-the-drifting-clock-deferred)
- `2026-09-02` [Panel: the cold walk — a record is judged once, against the venue that answered it, and junk leaves nothing behind](decisions/2026-09.md#2026-09-02--panel-the-cold-walk--a-record-is-judged-once-against-the-venue-that-answered-it-and-junk-leaves-nothing-behind)
- `2026-09-02` [Panel: the walk — the book is what the record's descent reaches, the empty book is a signed claim, and currency is `serves`](decisions/2026-09.md#2026-09-02--panel-the-walk--the-book-is-what-the-records-descent-reaches-the-empty-book-is-a-signed-claim-and-currency-is-serves)
- `2026-09-01` [Panel: the resume — the pin is a floor, the raise is from a held seat, and the pin the seat keeps is the book's own](decisions/2026-09.md#2026-09-01--panel-the-resume--the-pin-is-a-floor-the-raise-is-from-a-held-seat-and-the-pin-the-seat-keeps-is-the-books-own)
- `2026-08-31` [Slice 35d: the book built, and what building it decided](decisions/2026-08.md#2026-08-31--slice-35d-the-book-built-and-what-building-it-decided)
- `2026-08-29` [Slice 35: the record is the backing's, and the grade names the incumbent](decisions/2026-08.md#2026-08-29--slice-35-the-record-is-the-backings-and-the-grade-names-the-incumbent)
- `2026-08-29` [The revocation count: the operator picks the number, deferred to its own slice](decisions/2026-08.md#2026-08-29--the-revocation-count-the-operator-picks-the-number-deferred-to-its-own-slice)
- `2026-08-29` [Panel: identity is the link, and it is already in the code](decisions/2026-08.md#2026-08-29--panel-identity-is-the-link-and-it-is-already-in-the-code)
- `2026-08-29` [Panel: the book is a possession with a provenance, and it only grows](decisions/2026-08.md#2026-08-29--panel-the-book-is-a-possession-with-a-provenance-and-it-only-grows)
- `2026-08-29` [Panel: the clock is the backing's, and identity is the term](decisions/2026-08.md#2026-08-29--panel-the-clock-is-the-backings-and-identity-is-the-term)
- `2026-08-29` [Slice 34b: commit scope, on a force rule that no longer moves](decisions/2026-08.md#2026-08-29--slice-34b-commit-scope-on-a-force-rule-that-no-longer-moves)
- `2026-08-29` [Slice 34: the force rule built, and the sweep it cost](decisions/2026-08.md#2026-08-29--slice-34-the-force-rule-built-and-the-sweep-it-cost)
- `2026-08-29` [The force rule: a replacement is co-signed, and takes effect at its effective index](decisions/2026-08.md#2026-08-29--the-force-rule-a-replacement-is-co-signed-and-takes-effect-at-its-effective-index)
- `2026-08-28` [Slice 32: an attempt is named by the hash of its terms](decisions/2026-08.md#2026-08-28--slice-32-an-attempt-is-named-by-the-hash-of-its-terms)
- `2026-08-28` [Slice 31: locks keyed by (attempt, holder), and the squat family ends](decisions/2026-08.md#2026-08-28--slice-31-locks-keyed-by-attempt-holder-and-the-squat-family-ends)
- `2026-08-27` [Venues: Ergo is queued, Bitcoin is the direction after it](decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it)
- `2026-08-27` [The reorganization: an org front door, a decision index, and CLAUDE.md cut back](decisions/2026-08.md#2026-08-27--the-reorganization-an-org-front-door-a-decision-index-and-claudemd-cut-back)
- `2026-08-25` [The domain-separation namespace is `moe/`, and the magic is `MOEB`](decisions/2026-08.md#2026-08-25--the-domain-separation-namespace-is-moe-and-the-magic-is-moeb)
- `2026-08-25` [Slice 28: unserved lock requests, and two set faults made provable](decisions/2026-08.md#2026-08-25---slice-28-unserved-lock-requests-and-two-set-faults-made-provable)
- `2026-08-25` [Slice 30: dishonour with a payout reserved is the holder's lapse](decisions/2026-08.md#2026-08-25---slice-30-dishonour-with-a-payout-reserved-is-the-holders-lapse)
- `2026-08-25` [Slice 29: a dead successor does not end the chain](decisions/2026-08.md#2026-08-25---slice-29-a-dead-successor-does-not-end-the-chain)
- `2026-08-24` [Slice 28b: the receipt names its era, and the era is the backing's own](decisions/2026-08.md#2026-08-24---slice-28b-the-receipt-names-its-era-and-the-era-is-the-backings-own)
- `2026-08-23` [Slice 28a: returning from silence is committing](decisions/2026-08.md#2026-08-23---slice-28a-returning-from-silence-is-committing)
- `2026-08-22` [Implementation audit findings and protocol questions](decisions/2026-08.md#2026-08-22---implementation-audit-findings-and-protocol-questions)
- `2026-08-22` [Slice 27: a demand outlives its locks, and a window is open when it is set](decisions/2026-08.md#2026-08-22---slice-27-a-demand-outlives-its-locks-and-a-window-is-open-when-it-is-set)
- `2026-08-22` [Slice 26: a payout paying in claims settles inside the settlement](decisions/2026-08.md#2026-08-22---slice-26-a-payout-paying-in-claims-settles-inside-the-settlement)
- `2026-08-21` [Slice 25: the n-party exchange, one object signed by all](decisions/2026-08.md#2026-08-21---slice-25-the-n-party-exchange-one-object-signed-by-all)
- `2026-08-21` [Slice 24c: the exits of a lock, on both sides of its timeout](decisions/2026-08.md#2026-08-21---slice-24c-the-exits-of-a-lock-on-both-sides-of-its-timeout)
- `2026-08-21` [Slice 24b: an atomic bundle commits on one witnessed object](decisions/2026-08.md#2026-08-21---slice-24b-an-atomic-bundle-commits-on-one-witnessed-object)
- `2026-08-21` [Slice 24a: the lock timeout, and the gap path it exposed](decisions/2026-08.md#2026-08-21---slice-24a-the-lock-timeout-and-the-gap-path-it-exposed)
- `2026-08-21` [Slice 23: a backer can read whether a demand is accompanied](decisions/2026-08.md#2026-08-21---slice-23-a-backer-can-read-whether-a-demand-is-accompanied)
- `2026-08-21` [Slice 22: a demand reserves its reliance legs](decisions/2026-08.md#2026-08-21---slice-22-a-demand-reserves-its-reliance-legs)
- `2026-08-21` [Slice 21: closure(S), and the reading its one example does not settle](decisions/2026-08.md#2026-08-21---slice-21-closures-and-the-reading-its-one-example-does-not-settle)
- `2026-08-21` [Slice 20: a venue's refusal is not a verdict, in one place](decisions/2026-08.md#2026-08-21---slice-20-a-venues-refusal-is-not-a-verdict-in-one-place)
- `2026-08-20` [Slice 19: revocation, and the boundary a stolen key draws](decisions/2026-08.md#2026-08-20---slice-19-revocation-and-the-boundary-a-stolen-key-draws)
- `2026-08-20` [Slice 18: the backing that vanished, and the remedy that could not be taken](decisions/2026-08.md#2026-08-20---slice-18-the-backing-that-vanished-and-the-remedy-that-could-not-be-taken)
- `2026-08-20` [Slice 17: Ergo as a venue, decided from the node rather than asked](decisions/2026-08.md#2026-08-20---slice-17-ergo-as-a-venue-decided-from-the-node-rather-than-asked)
- `2026-08-20` [Slice 16: non-service, the grade measured on service](decisions/2026-08.md#2026-08-20---slice-16-non-service-the-grade-measured-on-service)
- `2026-08-20` [Slice 15: a venue's records are bytes, and Venue is an interface](decisions/2026-08.md#2026-08-20---slice-15-a-venues-records-are-bytes-and-venue-is-an-interface)
- `2026-08-20` [Basis read in full: what we take, what we do not, and the curve](decisions/2026-08.md#2026-08-20---basis-read-in-full-what-we-take-what-we-do-not-and-the-curve)
- `2026-08-20` [Slice 14: the successor serves](decisions/2026-08.md#2026-08-20---slice-14-the-successor-serves)
- `2026-08-20` [Slice 13: the chain from the original terms is walkable](decisions/2026-08.md#2026-08-20---slice-13-the-chain-from-the-original-terms-is-walkable)
- `2026-08-20` [Slice 12: E's clauses are a list, not a tag per combination](decisions/2026-08.md#2026-08-20---slice-12-es-clauses-are-a-list-not-a-tag-per-combination)
- `2026-08-20` [Slice 11: what a receipt is worth, and what an operator cannot take back](decisions/2026-08.md#2026-08-20---slice-11-what-a-receipt-is-worth-and-what-an-operator-cannot-take-back)
- `2026-08-20` [Slice 10: E declares its venue and its witness interval](decisions/2026-08.md#2026-08-20---slice-10-e-declares-its-venue-and-its-witness-interval)
- `2026-08-20` [The challenge window's reach, and why no patch fits it](decisions/2026-08.md#2026-08-20---the-challenge-windows-reach-and-why-no-patch-fits-it)
- `2026-08-19` [Slice 9: the holder can be at fault too](decisions/2026-08.md#2026-08-19---slice-9-the-holder-can-be-at-fault-too)
- `2026-08-19` [Slice 8: the redemption legs are operations, published elsewhere](decisions/2026-08.md#2026-08-19---slice-8-the-redemption-legs-are-operations-published-elsewhere)
- `2026-08-19` [Aligning the decisions: the law is applied once](decisions/2026-08.md#2026-08-19---aligning-the-decisions-the-law-is-applied-once)
- `2026-08-19` [Design review: commit the log, and enforce presentability](decisions/2026-08.md#2026-08-19---design-review-commit-the-log-and-enforce-presentability)
- `2026-08-19` [Slice 7: committed state is self-authenticating](decisions/2026-08.md#2026-08-19---slice-7-committed-state-is-self-authenticating)
- `2026-08-19` [Slice 6: silence is a public fact, and the unspentness proof](decisions/2026-08.md#2026-08-19---slice-6-silence-is-a-public-fact-and-the-unspentness-proof)
- `2026-08-19` [The witnessed clock is the venue's, and one class of aliasing bug](decisions/2026-08.md#2026-08-19---the-witnessed-clock-is-the-venues-and-one-class-of-aliasing-bug)
- `2026-08-19` [Slice 5: presentation through the sequencer, and two holes it closed](decisions/2026-08.md#2026-08-19---slice-5-presentation-through-the-sequencer-and-two-holes-it-closed)
- `2026-08-19` [Slice 4 scoping: presentation and dishonour, single-phase](decisions/2026-08.md#2026-08-19---slice-4-scoping-presentation-and-dishonour-single-phase)
- `2026-08-19` [One framing rule, and the design rules it belongs to](decisions/2026-08.md#2026-08-19--one-framing-rule-and-the-design-rules-it-belongs-to)
- `2026-08-18` [Slice 3 scoping: the transparent sequencer](decisions/2026-08.md#2026-08-18--slice-3-scoping-the-transparent-sequencer)
- `2026-08-18` [Transparent-slice scoping: nonces, replay, the operation log, and inv 7/26](decisions/2026-08.md#2026-08-18--transparent-slice-scoping-nonces-replay-the-operation-log-and-inv-726)
- `2026-08-18` [A validated backing is frozen; raw key-byte mutation is unsupported](decisions/2026-08.md#2026-08-18--a-validated-backing-is-frozen-raw-key-byte-mutation-is-unsupported)
- `2026-08-18` [Obligor keys are validated as non-small-order points, and verification is strict (non-ZIP215)](decisions/2026-08.md#2026-08-18--obligor-keys-are-validated-as-non-small-order-points-and-verification-is-strict-non-zip215)
- `2026-08-18` [Signatures are over a domain-separated message, not the bare name](decisions/2026-08.md#2026-08-18--signatures-are-over-a-domain-separated-message-not-the-bare-name)
