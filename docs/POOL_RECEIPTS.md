# Pool receipt record readers

`@mediumofexchange/reference/pool/receipt-record` exports two read-only helpers;
`pool/receipt-repair` adds classification at a supplied repair boundary. All
are also available from the package root. They build on the canonical receipt
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
empty opening of a different segment, whose immediately preceding sequence
is absent and greater than the receipt's held `after`. The opening must be
the first held transition to a different segment after that reference, with
all original scope terms still live at the repair's witnessed index.

The reader walks only this operator's held interval from `after` through the
supplied repair with bounded predecessor queries; it never enumerates holes.
It validates every checkpoint and its required canonical ancestry in one
batch. The `after` checkpoint must authenticate the receipt's segment.

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
view is later. It does not suppress inclusion proved in a subsequent checkpoint.
Unheld receipt references, actual scope endings and multiple segment
transitions need separate classification. A current global receipt classifier
remains future work. The [repair decision](POOL_RECEIPT_REPAIR_GAP.md) records
the reproduced case and the cost accepted by the maintainer.

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

The next classifier must check historical inclusion and historical live-scope
contradictions before lapse (C2.10.9), building on the revocation check and the
later construction's silence objects. Missing evidence cannot be interpreted as an absent payment. Venue
refusals and changing views throw `VenueError`; unexpected proof-backend
failures also propagate instead of becoming invalid external evidence.

The maintainer resolved the failed-checkpoint ambiguity in C2.10.9a. A later
new segment alone still cannot prove an illicit elective reset or receipt lapse.
