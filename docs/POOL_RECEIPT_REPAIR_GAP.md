# Receipt classification after failed checkpoint repair

Status: resolved by the maintainer on 2026-09-07. C2.10.9a permits lapse at
a proven repair boundary, preserving independent inclusion and contradiction.
The bounded reader is documented in [Pool receipts](POOL_RECEIPTS.md#failed-publication-repair).

## Reproduced boundary

The regression `failed checkpoint repair can leave a live-scope receipt's after
sequence held` in [pool-store.test.ts](../test/pool-store.test.ts) executes the
existing durable store against a venue with lag 2:

| Witnessed index | Action | Held commitments |
|---|---|---|
| 0 | Sign and publish the empty opening of segment S1, sequence 1. | None |
| 2 | Witness sequence 1; admit a statement and return receipt R with `after = 1`; sign sequence 2 containing R's statement but do not publish it. | 1 |
| 4 | Sequence 2 has expired. Prepare and sign repair segment S2, sequence 3, importing the empty state at sequence 1; publish sequence 3. | 1 |
| 6 | Witness sequence 3. All original scope terms remain live. | 1, 3 |

The current implementation permits the repair. R's statement is absent from
the repaired state, while its exact `after` commitment is still held and its
scope is live. Restart preserves the original signed receipt.

This is not missing directory or history evidence: the venue affirmatively
reports that it moved past sequence 2 without holding it. It still holds
sequence 1. A reader given only held records cannot distinguish this repair
from an operator deliberately using the gap to abandon the same unfinalized
receipt.

## The rules that meet here

- [Construction C2.4.3](../../money-from-first-principles/construction.md#c24-commitments-and-the-directory)
  permits repair after an unwitnessed signed commitment expires: the operator
  can no longer assume that state, and its seat becomes stale.
- [C2.10.9](../../money-from-first-principles/pool-authority.md#4-receipts-handover-and-restart)
  prohibits elective scope changes from abandoning live receipts but permits
  discard with C2.7's evidence that the held state is stale.
- [C2b.4](../../money-from-first-principles/construction.md#c2b-failure-silence-and-recovery)
  describes receipt lapse where the venue moved past the commitment the
  receipt names. R names sequence 1, not the failed sequence 2.

Before C2.10.9a, these rules did not explicitly classify an earlier receipt
when a later failed commitment caused repair. Calling every subsequent new segment an elective
violation would accuse the existing permitted repair. Inferring lapse from
any signed-sequence gap would introduce a rule C2b.4 does not state.

The older [sequencing model](../model/sequencing.ts) checks contradiction only
when the exact next sequence after a receipt is held. That avoids this false
accusation but is not a complete lapse classifier. The private authority
model's former `open` guard also lacked the durable store's stale signed-state
repair case; the model now covers repair and classification at its boundary.

## Accepted clarification

Preserve failed-publication repair and explicitly allow its unfinalized
receipts to lapse even when their `after` remains held. C2.10.9a requires the
first held different-segment checkpoint after `after` to be a canonical empty
opening. Its immediately preceding sequence must be absent and greater than
`after`. All original terms must still be live at that boundary. Replay the
complete held interval: prior inclusion and proven live-scope contradictions
remain independent facts, and either prevents lapse. An occupied conflicting
position at `after` is a contradiction too; an absent position there is not.
Missing or invalid evidence never establishes lapse. The verdict is at the
repair, and cannot suppress later final inclusion.

This permits deliberate abandonment of unfinalized receipts by failing a
checkpoint; it does not reverse witnessed value. The current repair already
permits that behavior. The clarification makes the reader's verdict
agree with the service's permitted action.

The alternative is to forbid that discard and require continuity for receipts
issued after a held checkpoint. That changes the repair mechanism: preserving
an unwitnessed tail across a fresh segment needs a specified, verifiable rule,
and must not silently import unfinalized prefixes under pool-v2 §10.

The implementation adds the bounded `readPoolReceiptRepair` reader and model
cases, without changing store behavior, signed frames or circuits. The present
verdict, C2.10.9b, is [`readPoolReceiptStatus`](POOL_RECEIPTS.md#present-verdict);
later-version silence recovery remains separate work.
