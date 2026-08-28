# Decisions

Resolved questions about the spec and this implementation. Decisions here
can be reopened — with a good reason — but reopening one should be done
knowingly, with the earlier reasoning in view, not by forgetting it was ever
decided.

**This file is the index.** One line per decision, newest first. The entries
themselves live in [`decisions/`](decisions/), one file per month. Read the
index, then open only the entry you need — the full log is far too large to
read in one go, and reading it in one go is not the point.

Adding one: put the entry at the top of the current month's file (create it if
the month is new), and add its line at the top of the index below.

```
## YYYY-MM-DD — short title
**Question:** what was ambiguous, contradictory, or wrong (quote the spec).
**Decision:** what was decided, and by whom.
**Spec change:** link to the issue/commit on the paper repo, or "none needed".
```

---

## Index

- `2026-08-28` [Slice 31: locks keyed by (attempt, holder), and the squat family ends](decisions/2026-08.md#2026-08-28--slice-31-locks-keyed-by-attempt-holder-and-the-squat-family-ends)
- `2026-08-27` [Venues: Ergo is queued, Bitcoin is the direction after it](decisions/2026-08.md#2026-08-27--venues-ergo-is-queued-bitcoin-is-the-direction-after-it)
- `2026-08-27` [The reorganization: an org front door, a decision index, and CLAUDE.md cut back](decisions/2026-08.md#2026-08-27--the-reorganization-an-org-front-door-a-decision-index-and-claudemd-cut-back)
- `2026-08-25` [The domain-separation namespace is `moe/`, and the magic is `MOEB`](decisions/2026-08.md#2026-08-25--the-domain-separation-namespace-is-moe-and-the-magic-is-moeb)
- `2026-08-25` [Session close: the audit queue is done; what the next instance picks up](decisions/2026-08.md#2026-08-25---session-close-the-audit-queue-is-done-what-the-next-instance-picks-up)
- `2026-08-25` [Slice 28: unserved lock requests, and two set faults made provable](decisions/2026-08.md#2026-08-25---slice-28-unserved-lock-requests-and-two-set-faults-made-provable)
- `2026-08-25` [Slice 30: dishonour with a payout reserved is the holder's lapse](decisions/2026-08.md#2026-08-25---slice-30-dishonour-with-a-payout-reserved-is-the-holders-lapse)
- `2026-08-25` [Slice 29: a dead successor does not end the chain](decisions/2026-08.md#2026-08-25---slice-29-a-dead-successor-does-not-end-the-chain)
- `2026-08-24` [Slice 28b: the receipt names its era, and the era is the backing's own](decisions/2026-08.md#2026-08-24---slice-28b-the-receipt-names-its-era-and-the-era-is-the-backings-own)
- `2026-08-23` [Slice 28a: returning from silence is committing](decisions/2026-08.md#2026-08-23---slice-28a-returning-from-silence-is-committing)
- `2026-08-22` [The audit: six angles over the merged code, what was wrong, and what is the maintainer's to decide](decisions/2026-08.md#2026-08-22---the-audit-six-angles-over-the-merged-code-what-was-wrong-and-what-is-the-maintainers-to-decide)
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
