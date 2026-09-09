# Pool receipt record readers

`@mediumofexchange/reference/pool/receipt-record` exports two read-only helpers;
`pool/receipt-repair` classifies a supplied repair boundary and
`pool/receipt-status` reads the present verdict. All are also available from
the package root. They build on the canonical receipt
envelope, signed backing terms and whole-scope checkpoint validator. None
changes admission, signing, publication or the store's recovery restrictions.

## Record facts

`readPoolReceiptRecord({ configuration, venue, header, receipt, backings })`
authenticates the complete header through the receipt, verifies every backing's
signed terms and resolves the header's exact replacement links. Its result is
`invalid` or `record`, with the witnessed index, copied terms and two facts:

- `sequence`: `held` with the exact commitment and witnessed index,
  `not-reached`, or `moved-past` (C2.3.4, C2b.4). Several sequences may share
  one index; the exact lower sequence remains held. An unreached sequence has
  no distance bound. Zero and sequences before this segment's opening cannot
  be operational pool receipt eras (C2.10.9), although the raw envelope codec
  can sign and verify them.
- `scope`: `not-started`, `live`, or `ended`, read at the returned index from
  the intersection of the complete scope's term bounds. Announcements do not
  end terms early; an old link stays ended when its operator key returns.

These are separate facts. `held` does not prove that the commitment carries
this segment, that the scope was live at its witnessing, or that it includes
the receipt. The receipt has no signing timestamp. A live scope today cannot
prove when acceptance happened. An ended scope or moved-past sequence cannot
on its own excuse a receipt that was included or historically contradicted.

## Inclusion in an exact source checkpoint

`readPoolReceiptCheckpoint({ configuration, venue, header, receipt, checkpoint,
evidence, verifier })` runs whole-scope checkpoint validation with all required
canonical ancestry. It compares the receipt's position, statement identity and
history hash with the replayed admission records. The validator returns these
records as `accepted` for each requested checkpoint; it does not replay proofs
a second time or retain admission records for unrequested ancestors.

The result is `included`, `not-included`, `invalid`, or `unavailable`.
Successful inclusion reads include the checkpoint's witnessed index and the
view's current index. Supply a checkpoint of the receipt's own segment. When
a new segment imports its event, use the source checkpoint from that ancestry.

Different valid proof bytes preserve statement and history identity. Inclusion
does not claim that those replacement bytes were the original admitted
evidence; use `poolReceiptAttestsEvidence` for that separate question.
Inclusion survives replacement and missing/unreached `after` sequences.
Missing histories remain unavailable even after the scope ends. A receipt
outside the selected prefix is only `not-included` there: a later checkpoint
may include it, and an earlier checkpoint may predate its acceptance.

## Failed-publication repair

`readPoolReceiptRepair({ configuration, venue, header, receipt, backings,
repair, evidence, verifier })` implements C2.10.9a. Supply a held canonical
empty opening of a different segment that carries a backing of the receipt's
scope, reached after a hole: some sequence between the receipt's segment's
last held checkpoint (at least its held `after`) and the opening that the
record never held. The opening must be the first held carrying transition to
a different segment after that reference, with all original scope terms still
live at the repair's witnessed index. Held checkpoints carrying none of the
scope are passed over: they need directory evidence only, and each occupies
its sequence without being a hole or a transition.

The reader walks only this operator's held interval from `after` through the
supplied repair with bounded predecessor queries; it never enumerates holes.
It validates every checkpoint of the receipt's segment in that interval, the
repair and their required canonical ancestry in one batch. The `after`
checkpoint must authenticate the receipt's segment.

The result is `invalid`, `unavailable`, `not-applicable`, or `repair`.
`not-applicable` means this particular boundary does not satisfy this reader's
predicate; it is neither a fault accusation nor a global pending verdict.
`repair` returns the boundary, the read view's `witnessedIndex`, independent
`includedAt` and `contradictedAt` checkpoint facts, and `lapsed`. Inclusion
compares position, statement identity and history hash. An occupied conflicting
position at `after` is a contradiction; mere absence there is not. Any later
checkpoint in the original segment before repair must include the receipt.
Only neither inclusion nor contradiction permits lapse.

This verdict is **at the supplied repair boundary**, even if the venue's read
view is later. Unheld receipt references, actual scope endings and elective
transitions are the present verdict's below. The
[repair decision](../decisions/2026-09.md#2026-09-07--proven-failed-publication-repair-can-lapse-unfinalized-receipts) records the reproduced case and
the accepted cost.

## Present verdict

`readPoolReceiptStatus({ configuration, venue, header, receipt, backings,
evidence, verifier })` implements C2.10.9b: the receipt's verdict at the
venue's present index. It resolves the record facts above, then walks this
operator's held commitments in signed sequence order with bounded predecessor
reads. It first locates the receipt's segment checkpoint at `after`, which
must authenticate as the segment whatever its index, or otherwise the
segment's latest live checkpoint below `after`; then every held commitment
above `after`. The walk stops at the earliest witnessed end of an original
scope term, or at the first checkpoint of another segment that carries a
backing of the receipt's scope. Held checkpoints carrying none of the scope
are passed over with their directory alone.

The checkpoint at or below `after` is replayed first. Each held commitment
above is then related and, where it belongs to the segment, replayed, in
ascending order, and the read ends at the first inclusion. The transition is
replayed only where it decides between repair and abandonment: a held
reference with neither inclusion nor a proven contradiction before it.
Nothing is read from a checkpoint the validator did not accept. A checkpoint
the reader cannot relate or validate returns `unavailable` or `invalid`
carrying the `contradictedAt` facts already proven, rather than a verdict;
an inclusion already proven has already returned `final`.

The result is otherwise `status` with `witnessedIndex`, the record's
`sequence` and `scope` facts, the scope `boundary` where a term end is
witnessed, independent `includedAt` and `contradictedAt` facts, an
`abandonedAt` fact, a `lapse` where the status is lapsed, and the `status`:

- `final`: a live-scope canonical checkpoint of the segment includes the
  receipt's position, statement identity and history hash. Inclusion is read
  first and survives every later fact, including from the segment's latest
  live checkpoint below `after` whatever became of the reference.
- `contradicted`: such a checkpoint above a held `after` omits it before the
  transition, or such a checkpoint at or below `after` holds its position
  otherwise. Contradiction facts stay beside later inclusion. Omission above a
  moved-past `after` is that reference's lapse, not a contradiction.
- `abandoned`: the carrying transition is canonical, witnessed while every
  original term is live, and not a repair boundary: the operator changed scope
  without first witnessing the receipt (C2.10.9). Nothing can finalize the
  receipt afterwards, and nothing excuses it. A transition after inclusion is
  an ordinary scope change; after a proven contradiction it is not replayed.
  `abandonedAt` is present only with this status.
- `lapsed`, with `lapse.kind`: `moved-past` (C2b.4), `repair` with the
  boundary (C2.10.9a), or `scope-boundary` with the index (C2.10.9).
- `pending`: none of the above; the record may still finalize it.

Checkpoints witnessed at or after the boundary are lapsed for the whole scope
and neither finalize nor contradict. `final` is permanent; `abandoned` and
`lapsed` are terminal for this segment; a contradicted receipt can still
become final. The reader owns its inputs and callback references, propagates
venue refusals and changed views as `VenueError`, and reports an unchanged
verdict on exact re-reads. It authorizes no discard, resubmission, service or
recovery. Its cost is the directory of every held commitment of the operator
since `after` up to the decisive one, and one replay of each segment
checkpoint up to the first inclusion. A checkpoint above the facts already
proven that the reader cannot relate or validate leaves the receipt without
a verdict beyond those facts, which the failure carries.

## Recovery boundary

`included` establishes C2.10 checkpoint inclusion with C2b.1 prospective
revocation checked, not a current holding or complete recovery validity.
Every issuance must first appear in a canonical checkpoint witnessed strictly
before its obligor's revocation. Later checkpoints may preserve an already
validated prefix, and imported events keep their original finality. Required
earlier evidence must be available; a reader cannot assume a cutoff or remove
invalid issuance from a committed history. Same-index revocation changes
during verification cause a venue-view failure.

Silence redemption and venue-nullifier adoption remain outside pool-v2
(pool-v2 §7.4). The [store's restrictions](POOL_STORE.md#current-limits)
remain in force. No result authorizes tail discard, note resubmission, service
activation, or a complete fault or recovery verdict. The repair reader can
identify the specific historical receipt contradictions described above.

Recovery over these verdicts, and the later construction's silence objects,
remain next. Missing evidence cannot be interpreted as an absent payment. Venue
refusals and changing views throw `VenueError`; unexpected proof-backend
failures also propagate instead of becoming invalid external evidence.

C2.10.9a resolves the failed-checkpoint ambiguity; C2.10.9b
names the present verdicts. A new segment carrying none of the receipt's scope
proves nothing about it; one that carries a scope backing proves repair or
abandonment.
