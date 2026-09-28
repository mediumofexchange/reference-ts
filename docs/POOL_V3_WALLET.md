# V3 wallet

`src/pool/v3/wallet-store.ts` implements one local wallet seed that receives under
[pool-delivery C4.1–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-delivery.md)
and pays under [pool-fees C1.2.3–5](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md).
It uses the candidate configuration and recomputed reference venue guard. It is
not exported from the root barrel. Node 24 is required for the SQLite journal.

The caller opens `V3Wallet(path, readerOptions)` with its independently
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

## Paying

Holdings are never a local ledger. `sync(package, signedTerms)` and `prepare`
read the same complete canonical frontier as `fulfill` and scan every output of
that backing's history with the seed (C4.6–7, `holdings.ts`): one AEAD trial per
capsule and one owner derivation per lit settlement. Zero, spent and
force-spent notes are not holdings; notes under a standing demand are `locked`,
and inputs of a saved payment are `reserved`. The view covers one backing at
one witnessed index; it is not a global balance, and restoring from the seed
alone finds the same notes, including change.

`prepare(alias, { request, value, fee? }, package, signedTerms, prove)` checks
each exact request against the agreed domain, backing and amount, refuses a
request already in a saved payment or already in canonical outputs, then
selects the smallest single covering note or the least-total pair. A single
input is padded with a fresh zero note. The wallet adds its own change and
zero outputs under fresh request identifiers, shuffles the four positions and
builds the spend in the canonical segment, whose header it takes from the
package trail matching that segment's identity. The caller's `prove` runs
locally and receives spend secrets. The wallet requires the returned record to
be exactly the task and to verify under its own verifier, then saves it with
unique input-nullifier and output-commitment reservations, every output opening
and the zero input's request identifier in one transaction before returning it. A proof failure reserves nothing. An exact alias retry
returns the saved record without reading evidence or proving; the same alias
with another order refuses. A concurrent exact call adopts the first saved
record, and a competing alias over the same inputs refuses. Preparation also
refuses when the operator would refuse the statement: the canonical segment's
operator term has ended at the witnessed index (`CONFLICT`), or, where the
backing declares silence, a boundary is witnessed or the witnessing horizon
(index plus lag since the canonical checkpoint) exceeds the clock's duration
(`SILENCE`), the journal's own admission rule. A published handover not yet
effective is not predicted; such a payment is resolved by reproof.

A direct fee is the fee recipient's own exact request (pool-fees C1.2.4). That
recipient learns the backing, its fee output and its association with the
statement, as any payee does; omitting the fee is the sponsored mode. Selection
is advisory: the operator's admission and later replay judge spentness.

`submit(alias, service)` sends the saved exact bytes and keeps the first
receipt that the saved segment operator signs for the saved statement, proof
and authorization digests. After a lost reply the retry resends identical
bytes, and the journal returns the original receipt. A receipt is pending
operator liability, not finality. `sync` marks a payment `final` only when all
four of its outputs are in canonical history, including history imported into a
successor segment. Its own change and zero outputs are fresh, so no other
statement creates them. It marks a payment `failed` only when an input was
spent otherwise.

`reprove(alias, package, signedTerms, prove)` handles a payment that stays
`prepared` after its segment stopped being canonical, because the operator's
term ended or silence lapsed its unfinished tail (pool-fees C1.2.5, C4.4). It
reads the same frontier, resolves a payment already final or failed without
proving, and returns the payment unchanged while its record names the
canonical segment. Otherwise it rebuilds the saved statement in the canonical
segment: the same input nullifiers (the reserved notes, found again by the seed
scan in imported history, and the saved zero input), the same outputs,
capsules and order; only segment, scope and anchors change. Admission is
checked as for preparation, an input missing from canonical history refuses
`ABSENT` (for example a note created in the lapsed tail) and a locked input
refuses `LOCKED`. The new record replaces the saved one only if the saved
statement is still current, keeping the old record and any receipt under
`superseded`; the receipt remains evidence of that operator's acceptance, not
finality. A receipt returned for a record that a reproof replaced during
submission is refused. Both records spend the same nullifiers into the same
commitments, so at most one can enter canonical history and the payee's exact
request is paid once. A direct fee stays with its original recipient even when
another operator admits the reproof; paying the current operator instead is a
new spend (C1.2.5). Reservations stay until final or failed: release with
other outputs (cancellation), same-segment tail repair (C2.10.9a) and release
of never-admitted inputs are not implemented. Multi-backing payments and
cross-backing fees are refused. The wallet profile is `moe/wallet/v3/2`; a
first-profile payer database, which kept no output openings, is refused.

## Acceptance and remaining work

`test/pool-v3-wallet.test.ts` ports receiver cases with oracle proofs, including
four-output association, exact request retry, caller mutations, capsule
substitution, later spentness, incomplete old packages, forced demand/settlement,
same-index venue drift, owner fencing and competing fulfillment calls.
`test/pool-v3-payer.test.ts` ports the v2 payment cases: single/pair selection
and three-note refusal, agreed terms, repeated or already paid requests, prover
failure and substituted statements, concurrent retry, forged and lost receipts,
restart with fencing, final reconciliation with seed-found change, finality and
imported-note payment across operator takeover, changed alias orders, receipts
for another proof, earlier-profile databases, and failure
when a restored copy spends the reserved input. Its reproof cases cover a
pending payment lapsed by takeover and by silence return, the preserved
nullifiers/outputs/capsules, final settlement by the new operator and the
payee's fulfillment, substituted reproof statements, idempotent retries,
resolution without proving, a stale receipt racing a reproof, and `SILENCE`
refusal at the horizon and after the boundary.
`npm run check:pool:v3-wallet` exercises fresh processes at request, fulfillment,
payment and reproof commit boundaries with synthetic evidence. These are process-exit
tests, not physical power-loss or qualified-storage evidence.

The real-proof `scripts/pool/v3/store-check.mjs` obtains the payment request
from the receiver wallet. The payer wallet pays it and the operator's fee request
from its restored issued note, proves through the runtime prover and submits
through the [local service](POOL_V3_SERVICE.md). The payer reconciles the
payment final; the receiver fulfills from independently replayed public
evidence downloaded over HTTP. The source-bound
[journal report](pool-v3-store-verification.json) records that acceptance.
Reproof is oracle-tested only; a real-proof spend of inherited notes in a
successor segment is covered by the succession check.

Authenticated request transport, cancellation/release, multi-backing
payment, encrypted backup and restoration drills remain open. Existing v2
wallet/service code and checks remain until all their replacement cases pass.
This library establishes no mainnet readiness or physical custody qualification.
