# Durable pool store

`PoolStore` is the Node 24 storage entry point at
`@mediumofexchange/reference/pool/store`. It implements durable activation,
admission, commitment signing and publication retry over the pool's existing
record readers and `Segment`. It does not run a server or commit timer.

## Operations

Construct the store with a persistent database path, the pinned pool
configuration, the operator's signing secret, a `Venue` and a
`StatementVerifier`. The configuration hash, operator and venue identify the
journal. A different identity cannot reopen it.

- `activate(id, backings, evidence)` derives the canonical current opening,
  verifies its imported histories, and atomically records the empty local
  segment and its signed opening commitment. Supply checkpoint evidence with
  histories and snapshot preimages when it is not already retained locally.
- `publish()` sends the latest durable signed commitment to the venue. A lost
  reply can be retried with the exact same bytes. The signed sequence remains
  consumed even if publication fails or the venue never includes it.
- `submit(statement)` verifies and durably admits a statement before returning
  its receipt. The receipt's `after` names the last signed commitment. Retrying
  the same statement identity returns the original receipt, even with different
  proof bytes or after the segment retires.
- `commit(id)` signs the current whole-scope directory and journals it before
  returning. The caller then publishes it. Command identifiers are local retry
  keys; reusing one for different content fails.
- `view()` returns copied local history, the highest signed sequence, the latest
  commitment, local checkpoints and their retained imported ancestry. Receipts
  establish acceptance; this view does not classify spendability or recovery.
- `close()` closes the database and clears the store's copy of the signing key.

Publish the opening before requesting receipts. Subsequent operations recheck
current authority, the operator's record and the earliest scope deadline.
There is at most one unwitnessed signed commitment during the venue lag. An
expired stale state must be replaced through canonical opening construction.
An elective scope change first witnesses the complete live tail and latest
signed checkpoint; an actual scope ending or stale state permits the specified
forced reopening. Old receipts remain available as evidence.

## Durability and ownership

The database uses SQLite WAL and FULL synchronization. An append atomically
stores its command, signed response, journal tip and observed venue index.
The local JSON envelopes are strictly canonical encodings of existing protocol
frames; they introduce no signed wire format. Reload replays the exact supplied
histories and verifies every saved statement, receipt and commitment.

Opening an existing journal atomically takes ownership and fences earlier
handles. A resumed process observes a full venue lag before new admission or
signing; it can return existing replies and retry durable publication during
that wait. Every signed sequence and co-signed statement survives restart.
Concurrent operations on one handle receive `BUSY`; another process taking
ownership during proof verification prevents the earlier process from signing.

The operator must use exactly one journal per signing key on its venue. SQLite
ownership cannot fence a copied database, restored stale backup or another copy
of the key. Durable storage is a trusted local dependency; contiguous-journal
checks detect ordinary corruption and truncation, not a coordinated rollback of
the whole database. Backups and key custody remain a separate release task.

## Current limits

This is the first durable sequencing slice, not a complete pool service.
Receipt classification, silence recovery, recovery of revoked issuance,
presentation, delivery and wallet synchronization remain to be implemented.
Backings with silence clauses are refused in the requested scope and all
required shared ancestry, including backings outside the new scope. Their
venue redemption nullifiers require recovery validation. Revoked issuance cannot be newly
admitted or committed. Movement of locally witnessed pre-revocation issuance
continues; late witnessing cannot turn revoked issuance into valid value.

Import currently requires each ancestor containing issuance to have its own
checkpoint witnessed strictly before that issuance key's revocation. A later
checkpoint may carry issuance already finalized earlier in the same segment;
recognizing that case needs the forthcoming recovery reader. The store returns
`UNSUPPORTED` instead of admitting that history. Imported shared histories are
checked even for backings outside the new scope.

The synchronous venue must provide the complete record its index represents.
Record changes during verification or append abort the operation. This store
retains and replays local supplied ancestry; large-history storage and replay
costs still need measurement and compaction design.

## Verification

`test/pool-store.test.ts` covers restart, fencing, receipt replay, scope changes,
publication failure, record races, mutation, corruption and revocation.
`test/pool-store-codec.test.ts` checks the canonical persistence envelopes.
`npm run check:pool-store` runs child processes against the built package and
kills each operation before storage, inside its uncommitted transaction, and
after commit. It covers openings, receipts and checkpoints, then restarts and
checks exact retry and outbox bytes. Node 20 skips SQLite tests and this harness;
`npm run check` runs them on Node 24 after building the package.
