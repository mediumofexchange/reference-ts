# Local pool wallet

The Node 24 `PoolWalletStore` retains v2 payment requests, complete pending
statements, receipts and one local fulfillment record per invoice. The local
acceptance CLI connects two wallet databases to the existing pool HTTP service.
It is a developer fixture with ideal proofs and a known local venue record.
It is not an end-user wallet or evidence of private payments with real proofs.

## Persistence and verification

A receiver creates a request for a positive quantity and a backing. Its fresh
spend secret and request commit to SQLite before the request is returned. The
payer receives the owner value, never that spend secret. Repeating the same
request ID and terms returns the same owner; changing its terms is refused.

The payer persists the complete canonical statement, including its proof and
any obligor signature, and the private delivery and change openings before
submitting it.
Input nullifiers are reserved in the same transaction. Another local command
cannot reserve those inputs. A lost service reply leaves the saved command
available for an explicit retry. Change stays in the payer's database; the
receiver's delivery contains only its opening, statement and receipt. Receipt
checks use caller-owned segment authority and the saved statement's identity;
acceptance is not finality.

The receiver checks the backing, exact positive amount, fresh owner and note
commitment against the requested payment and authenticated receipt. It runs
the existing checkpoint reader over caller-supplied configuration, verifier,
venue and complete evidence. Fulfillment requires the exact segment, receipt
position, statement identity and history hash in that verified checkpoint.
Missing evidence returns unavailable without recording fulfillment.

SQLite transactions record each invoice and payment commitment only once.
`received(id)` reads the saved opening after a restart or lost fulfillment
reply. Duplicate fulfillment is refused. This establishes one local record;
an external goods or payout system still needs its own idempotent delivery
integration. A received opening is historical payment evidence, not a claim
that the note remains unspent today.

## Local derivation

Pool-v2 §3 requires deterministic note randomness but leaves the wallet's
derivation algorithm local. `pool/wallet` uses HMAC-SHA256 with rejection
sampling to derive nonzero canonical fields. The fixed local frame separates
domain, purpose, output slot and ordered inputs. Requests use a durable
counter; issuance uses the obligor's root and receiver owner; spends and burns
use the holder's root and sorted real input nullifiers. Padding randomness
and secrets use separate purposes. Segment identities, anchors and proofs
do not enter this derivation, preserving outputs when only that context changes.

This reuses the project's HMAC mechanism with a distinct local wallet frame.
It does not implement successor C4 derivation, capsules or seed restoration,
and it changes no v2 protocol bytes. Restoring this wallet requires its
database, including the request counter and private delivery records.

## Run the acceptance

```sh
npm run build
npm run check:pool-wallet
```

The ordinary `npm run check` includes this acceptance on Node 24. The optional
SQLite module is imported through
`@mediumofexchange/reference/pool/wallet-store`; it is not in the Node 20 root
export. Derivation is available through `@mediumofexchange/reference/pool/wallet`.

The fixture issues 10 units, pays 7, verifies the receiver's payment and the
payer's 3-unit change after wallet restarts, then burns both holdings. It drops
an accepted service reply, compares the exact receipt on retry, exercises
changed-proof resubmission, withholds checkpoint history and refuses invoice
replay. The service observes only public statement frames; private change
openings stay out of the receiver delivery file.
The [verification record](pool-wallet-verification.json) pins the tested source,
full check result, independent review finding and evidence limits.

## Boundaries

The database, SQLite WAL and backups contain plaintext secrets. This slice
assumes trusted local storage and no copied or rolled-back wallet database.
It has no key custody service, seed-only restore, note selection, automatic
reservation release, lapse/replacement handling or external witness adapter.
The fixture transfers private delivery data through local files; a deployed
wallet still needs a private, authenticated delivery channel. Transport byte
limits do not bound wallet history replay, proof work or disk growth.

The [production requirements](PRODUCTION_REQUIREMENTS.md) and
[retirement map](PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions)
retain the missing real-proof receiver, independent-audit and crash evidence.
