# V3 receiver wallet

`src/pool/v3/wallet-store.ts` implements one local receiving capability under
[pool-delivery C4.1–5](https://github.com/mediumofexchange/money-from-first-principles/blob/02d911c/pool-delivery.md).
It uses the candidate configuration and recomputed reference venue guard. It is
not exported from the root barrel. Node 24 is required for the SQLite journal.

The caller opens `V3ReceiverWallet(path, readerOptions)` with its independently
held configuration, proof verifier, venue and reference identity preimage. The
wallet generates a random seed on creation. `recoverySeed()` returns a copy for
secure offline backup; the seed must never reach a payer, operator or replica.
The database, WAL and local backups contain secrets and require protected storage.
Reopening increments an ownership fence so previous handles cannot acknowledge
requests or fulfillments. Copied databases and malicious rollback remain outside
this fence; one active copy is a precondition.

`request(alias, backing, value)` saves a fresh random 32-byte request identifier
and exact positive parameters before returning the public domain, opening,
commitment and capsule. Exact retries read that record, including after restart;
changed parameters under the same alias refuse. The public request contains no
spend secret, seed, nullifier or local alias. `copyPaymentRequest` checks the
payer's agreed domain, backing and amount, recomputes the commitment and checks
capsule framing. The receiver authenticates the capsule itself; the payer cannot
prove that it decrypts. The caller must authenticate the intended recipient on
the request channel. A request is neither payment nor an invoice signature.

`fulfill(alias, packageBytes, signedRootTerms)` reads the complete canonical
single-backing frontier through the venue's current witnessed index. It accepts
only the saved exact positive output and capsule in verified finalized history,
with no current nullifier spend or standing demand lock. Valid force publications
after the canonical adoption index contribute their spend/lock effects. A receipt
alone cannot fulfill. Missing ranges, withheld ancestry, wrong terms, invalid
proofs, changed capsules and spent/locked notes cannot create a fulfillment.

Proof verification is asynchronous. The wallet owns its input bytes, records the
independent venue answers used by replay, then synchronously rechecks every answer
and the venue identity, lag and index before writing. This catches same-index
changes as well as index advancement. It reuses the existing reader and performs
no second proof verification. The recheck costs another read of each used range;
the transcript consumes memory within the reader's existing bounded workload.

The accepted package, signed terms, canonical checkpoint and judging index are
saved with the fulfillment in one WAL/FULL transaction before acknowledgment.
The caller must also arrange independent retention of the complete public evidence
and authenticated venue evidence. A saved package does not prove permanent
availability, and stored range answers are not a substitute for venue authority.
An uncertain write poisons the handle; reopening reads the committed state.

`fulfillment(alias)` retrieves the original historical result after a lost reply.
A second `fulfill` call conflicts even if identical. Lookup never authorizes a
second external credit, and the saved historical result never asserts current
spendability. Local aliases and accounting acknowledgments need their own backup.

## Acceptance and remaining work

`test/pool-v3-wallet.test.ts` ports receiver cases with oracle proofs, including
four-output association, exact request retry, caller mutations, capsule
substitution, later spentness, incomplete old packages, forced demand/settlement,
same-index venue drift, owner fencing and competing fulfillment calls.
`npm run check:pool:v3-wallet` exercises fresh processes at request/fulfillment
commit boundaries with synthetic evidence. These are process-exit tests, not
physical power-loss or qualified-storage evidence.

The existing real-proof `scripts/pool/v3/store-check.mjs` now obtains the payment
request from the receiver wallet, gives the payer only public output bytes,
proves the four-output payment, submits it through the [local service](POOL_V3_SERVICE.md),
and fulfills from independently replayed public evidence downloaded over HTTP.
The source-bound [journal report](pool-v3-store-verification.json)
records that acceptance. Payer inputs, fee/change requests and
proof preparation in this fixture still belong to the harness.

Authenticated request transport, payer pending statements/reservations, automatic
four-output selection and fee disclosure, holder recovery,
seed restoration and encrypted backup remain later slice-6 milestones. Existing
v2 wallet/service code and checks remain until all their replacement cases pass.
This library establishes no mainnet readiness or physical custody qualification.
