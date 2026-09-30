# V3 wallet

`src/pool/v3/wallet-store.ts` implements one local wallet seed that receives under
[pool-delivery C4.1–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-delivery.md)
and pays under [pool-fees C1.2.3–5](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md).
It uses the candidate configuration and recomputed reference venue guard. It is
not exported from the root barrel. Node 24 is required for its SQLite storage.

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

### Request exchange

`encodePaymentRequest` writes one canonical 246-byte frame: the
`moe/wallet/v3/request` tag, domain, backing, `u64` value, owner, rho and the
89-byte capsule; the commitment is recomputed, not carried. The receiver shows
`paymentRequestDigest(frame)`, the SHA-256 of those exact bytes, on the channel
by which the payer authenticates it (for example a displayed code the payer
scans). The frame itself may travel any private way. The payer calls
`authenticatePaymentRequest(frame, trustedDigest)`, which hashes and decodes one
private copy and refuses unless the digest matches; `prepare` then checks the
agreed domain, backing and amount. The trusted digest must never come from the
frame's own carrier: hashing the received frame to obtain the digest
authenticates it only when those exact bytes themselves arrived over the
authenticated channel. The digest is compared in full by machine (scanned or
pasted), never by a person checking a prefix or suffix, which a substituted
request can be ground to match. `readPaymentRequest` decodes strictly for
display and authenticates nothing; it returns the domain, backing, value and
commitment without the capsule, so `prepare` refuses its result. An exact
request retry, also after restart, yields the same frame and digest.

The frame contains no secret, but it links its output commitment and value to
whoever holds it, so it travels privately. Anyone holding it can also pay it
first, at the full amount, after which the intended payer's `prepare` refuses it
as already paid. It carries no endpoint, credential, expiry, label or receiver
identity key: a stable signing key would link a receiver's requests, which C4.3
avoids, and the payer learns nothing else it needs. V3 has no payer-to-receiver
delivery. The payee's output and capsule are in the public statement, and the
receiver finds the payment with `fulfill` from public evidence (C4.5, C4.8).
Until operator fee quotes exist, an operator's fee request is authenticated the
same way; a quote signed under the operator's already pinned key would be a new
signed message and is left for that work.

The retired v2 [pairing](https://github.com/mediumofexchange/reference-ts/blob/a020215/docs/POOL_WALLET_PAIRING.md) and delivery cases mapped to v3 as
follows. Canonical bounded framing, malformed fields, independent exact digest,
domain and every invoice term, and mismatch refusal before any network or proof
use are covered by `test/pool-v3-request.test.ts` and the payer's request
exchange case. One alias per receiver output corresponds to `prepare` refusing a
request already saved or already paid. Credential install, rotation and
compare-and-swap, capability revocation, leaf pinning, generation fencing,
post-handshake custody checks, the HTTPS inbox (TLS version, plaintext, headers,
bodies, redirects, acknowledgments, deadlines) and the delivery envelope have no
v3 counterpart, because v3 has no receiver endpoint, credential or private
delivery. Restoration of wallet state belongs to encrypted backup.

## Evidence and kept state

Every read (`fulfill`, `sync`, `prepare`, `reprove`) is the reader's frontier
read ([package reader](../src/pool/v3/package-reader.ts)) over the wallet's own
files, so it costs what is new, not the history
([M5b.5c](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)):

- `<path>.evidence` is the wallet's copy of the public evidence (pool-v3 §14).
  `supply(transport)` runs the caller's transport into it, for example
  `evidence => client.sync(backing, evidence)` ([service](POOL_V3_SERVICE.md)),
  which fetches only what came after the sequence the file was served through.
  The package a read is then given carries only that read's own items: the
  configuration and, where a read needs them, fault evidence. A whole package
  from any source works the same way; the wallet keeps what it carries. What
  the file holds is authenticated when a read uses it and selects nothing.
- `<path>.replay`, with its digest `<path>.replay.sha256`, keeps the classes,
  replay state and venue answers of the wallet's reads, and an incremental
  witness for each positive output of this seed. A later read verifies and
  scans only records it has not replayed, asks the venue only for indices past
  the last read's, and takes its notes' paths from the kept witnesses. It is
  kept where the verifier declares its circuits, which name kept state;
  otherwise each read replays in memory.

Neither file holds a secret or is part of a backup. Losing one costs a first
sync or a full read and nothing else. A kept replay file that fails its digest,
a kept class that fails a check, and kept state read through a later venue
clock than the one now shown are discarded and replayed, asking the venue for
everything. Evidence that no longer hashes reads as absent. An evidence file
that cannot be opened at all refuses `STORAGE` and is never replaced by the
wallet, since it may be the holder's only copy; the holder removes it. A
package handed to a read is kept even when the read refuses, and nothing prunes
the file. A read left `unresolved-evidence` over what the file holds is
answered by supplying again in full (`{ full: true }`). The replay file shows
which outputs are this seed's, so it needs the database's protection. Reads and
supplies of one wallet take turns. The holder remains responsible for retaining
the public evidence (C2.10.13): the evidence file is that retention only as
long as it is kept.

`fulfill(alias, package, signedRootTerms)` reads the complete canonical
frontier of the terms' backing, in any scope (C2.10.3–7), through the venue's current witnessed index. It accepts
only the saved exact positive output and capsule in verified finalized history,
with no current nullifier spend or standing demand lock. Valid force publications
after the canonical adoption index contribute their spend/lock effects. A receipt
alone cannot fulfill. Missing ranges, withheld ancestry, wrong terms, invalid
proofs, changed capsules and spent/locked notes cannot create a fulfillment.

Proof verification is asynchronous. The wallet owns its input bytes and holds
the venue's view at the witnessed index it read. Before every write or proof it
checks synchronously that the venue's identity, lag and witnessed index are
still those (`CHANGED_VIEW` otherwise). An answer through a witnessed index is
final (pool-v3 §13.1–13.2), so a clock that has not moved means every answer
the read used still stands, and no range is asked twice. A record a local
venue's owner witnesses at an index already read is outside that rule and is
not seen, as for the journal.

The signed terms, canonical checkpoint and judging index are saved with the
fulfillment in one WAL/FULL transaction before acknowledgment. The evidence it
was read from is what the evidence file retains; the caller must also arrange
independent retention of the complete public evidence and authenticated venue
evidence. A kept copy does not prove permanent availability, and kept range
answers are not a substitute for venue authority.
An uncertain write poisons the handle; reopening reads the committed state.

`fulfillment(alias)` retrieves the original historical result after a lost reply.
A second `fulfill` call conflicts even if identical. Lookup never authorizes a
second external credit, and the saved historical result never asserts current
spendability. Local aliases and accounting acknowledgments need their own backup
(C4.5); see [backup and restoration](#backup-and-restoration).

## Paying

Holdings are never a local ledger. `sync(package, signedTerms)` and `prepare`
read the same complete canonical frontier as `fulfill`. The seed scans each output of
that backing's history once, as its record is replayed (C4.6–7, `holdings.ts`): one AEAD trial per
capsule and one owner derivation per lit settlement; a later read scans only
new records and reads this seed's notes from their kept witnesses. Zero, spent and
force-spent notes are not holdings; notes under a standing demand are `locked`,
and inputs of a saved payment are `reserved`. The view covers one backing at
one witnessed index; it is not a global balance, and restoring from the seed
alone finds the same notes, including change.

The canonical segment may scope several backings (C2.10.2). Its history, spent
set and roots are shared, so one package serves each scoped backing, but each
view holds only that backing's notes. A statement spends and creates notes of
the one backing named by the terms; the spend proves each input's path to that
backing's own scope entry. One scoped backing's ended term ends the segment for
all of them (C2.10.9), so preparation compares every scoped backing's current
link and operator with its entry (the scope reader reports each chain); a
same-operator reappointment also ends the term. Forced publications count past
the backing's own adoption index, since a scope opening merges several. After a split or rejoin, the notes of each backing are found in
the segments they were created in, and pay under those original roots.

`prepare(alias, { request, value, fee? }, package, signedTerms, prove)` checks
each exact request against the agreed domain, backing and amount, refuses a
request already in a saved payment or already in canonical outputs, then
selects the smallest single covering note or the least-total pair. A single
input is padded with a fresh zero note. The wallet adds its own change and
zero outputs under fresh request identifiers, shuffles the four positions and
builds the spend in the canonical segment, whose header is the one the read
authenticated for the canonical checkpoint. The caller's `prove` runs
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
effective is not predicted; such a payment is resolved by reproof. The venue
view behind these decisions is checked before proving, so a venue that
advances during the read refuses `CHANGED_VIEW` with nothing reserved; callers
on a live venue retry. Two orders that each read the same note free both prove;
the second to save refuses `CONFLICT`, and an order read after that save finds
the note reserved.

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
reads the same frontier, refusing `CHANGED_VIEW` at an index older than the
one the saved record was built from (a dead segment never becomes canonical
again, but a lagging venue view could show it so), and resolves a payment
already final or failed without proving. While the record names the canonical
segment it returns the payment unchanged if that segment can admit it, and
otherwise refuses with the admission code (`CONFLICT` for an ended term with
no successor yet, `SILENCE` for a clock that closes admission), so a stuck
payment is distinguishable from a live one. Otherwise, after checking the
venue view, it rebuilds the saved statement in the canonical segment: the same input nullifiers (the reserved notes, found again by the seed
scan in imported history, and the saved zero input), the same outputs,
capsules and order; only segment, scope and anchors change. Admission is
checked as for preparation, an input missing from canonical history refuses
`ABSENT` (for example a note created in the lapsed tail) and a locked input
refuses `LOCKED`. The new record replaces the saved one only if the saved
statement is still current, keeping the old record and any receipt under
`superseded`; the receipt remains evidence of that operator's acceptance, not
finality. A receipt returned for a record that a reproof replaced during
submission is kept on that superseded record and the call refuses `CONFLICT`.
After a return opening the wallet may reprove before the operator has adopted
the return block; submission is then refused until adoption, and a retry
resends the same record. Both records spend the same nullifiers into the same
commitments, so at most one can enter canonical history and the payee's exact
request is paid once. A direct fee stays with its original recipient even when
another operator admits the reproof; paying the current operator instead is a
new spend (C1.2.5). Reservations are permanent: a failed payment's other
input stays reserved although it is unspent, so a copy that breaks the
one-active-copy rule can strand it until the seed is restored into a new
wallet. Release with other outputs (cancellation), same-segment tail repair
(C2.10.9a) and release of never-admitted inputs are not implemented. Multi-backing payments and
cross-backing fees are refused. The wallet profile is `moe/wallet/v3/3`; a
database of an earlier profile (no output openings, or a package saved with
each fulfillment) is refused.

## Backup and restoration

There are two paths, for two losses.

**Seed restoration** (C4.6) recovers money after the device and its local state
are lost. `V3Wallet.restoreSeed(path, options, seed)` creates a new wallet at a
new path from the backed-up seed. `sync` then finds the same positive unspent
notes, including change, from complete public evidence. No request, alias,
fulfillment or pending payment returns, because none is seed-recoverable (C4.2).
New requests draw fresh random identifiers, so nothing is reused. A payment
another copy prepared but never finished is unknown here: its inputs show as
available until it settles or they are spent, and a new payment over them
fails if the old one wins. A request the lost wallet issued, once paid,
appears as an ordinary holding, but it cannot be fulfilled against its lost
alias. Losing labels therefore loses accounting, never money, and cannot credit
anything twice.

**Encrypted offline handoff** moves the complete local state to one new
database: seed, aliases, unfulfilled requests, fulfillments,
payments with records, reservations, output openings, receipts and superseded
records. `exportBackup(key)` takes a random 32-byte key (for example from
`createWalletBackupKey()`). One transaction reads every state row, seals the
snapshot and marks the source frozen, so no later request, reservation or
fulfillment can be missing from the backup. From then on no handle of the
source, before or after a restart, can request, fulfill, sync, prepare,
reprove or submit (`FENCED`). A preparation or reproof still reading evidence
at the freeze refuses before proving; a submission or fulfillment in flight
fails when it tries to save its result. Saved results stay readable. A
repeated export, including after restart for a lost reply, returns the same
bytes, and only to the same key. The holder keeps the key and
`walletBackupDigest(bytes)` separately from the encrypted bytes.

`V3Wallet.restoreBackup(path, options, bytes, key, digest)` requires the exact
digest, the key and the same configuration and venue. The envelope's associated
data binds the tag `moe/wallet/v3/backup`, the domain and the venue. The
restore writes the state rows in their original order, in one transaction,
with the digest as `custody().restoredFrom`. SQLite's strict column types,
uniqueness, status and reference constraints refuse rows that do not fit the
schema. Beyond that, the authenticated content is trusted as the holder's own
state; the wallet's usual checks (request reproduction, reproof output
reproduction) apply when each row is used. Export compares the stored table
definitions with the wallet's own, so a database of any other shape refuses
before freezing rather than exporting a backup that could not be restored.

The destination must be new. An existing file (the source included),
`:memory:` and leftover `-wal`/`-shm` files are refused. The wallet is built in
an exclusively created staging file beside `path`, checkpointed, closed and
then hard-linked to `path`, which fails if anything appeared there meanwhile.
So `path` either does not exist or holds the complete restore, and a
destination another process created first is never touched. A refused or
interrupted restore leaves nothing at `path` and is simply retried there; after
a lost reply, an existing `path` with `custody().restoredFrom` equal to the
digest confirms success. Only a crash can leave the staging file
(`<path>.restore-<hex>`). It holds plaintext wallet state, possibly a complete
restore, so delete it and never open it: opening it beside a retried restore
would make two active copies. The destination's file system must support hard
links; FAT/exFAT and some network or synced folders refuse with `STORAGE`. The
restored wallet continues the saved work.
Exact retries return the saved records. Reservations hold. A receipt lost to
the freeze is recovered by resubmitting the identical bytes, which the journal
answers with its original receipt. `sync` and `reprove` resolve the rest.

The envelope is AES-256-GCM with a random 96-bit nonce under Node's crypto,
capped at 64 MiB: export and restore hold the whole plaintext in memory. An
unsupported schema or an oversized wallet refuses export before freezing. There
is no password derivation, continuous backup or rollback protection. The
decoded plaintext is bounded but materializes its rows. Only a holder of the
key can supply it, and that holder also holds the seed. The handoff is a
controlled transfer between devices, the v2 custody pattern on v3's domain and
venue ([decision](../decisions/2026-09.md#2026-09-28--restore-the-v3-wallet-from-its-seed-or-an-encrypted-handoff-that-freezes-its-source)).
Activating two restores of one backup, or keeping a seed-restored wallet beside
the original, breaks the one-active-copy precondition. Freezing cannot recall
a submission already sent, so quiesce operations before exporting.

## Acceptance and remaining work

`test/pool-v3-wallet.test.ts` ports receiver cases with oracle proofs, including
four-output association, exact request retry, caller mutations, capsule
substitution, later spentness, incomplete old packages, forced demand/settlement,
a venue clock that moves during verification, owner fencing and competing fulfillment calls.
`test/pool-v3-wallet-kept.test.ts` covers the kept files: a sync past the old
one-megabyte package over HTTP, a second sync that fetches, verifies and asks
the venue only for what is new, a seed-restored wallet's equal view, a restart,
and the fallbacks for a damaged replay file, a venue view older than the kept
witnesses, a venue behind the kept answers and lost or unreadable evidence.
The receiver and multi-backing suites run on the kept path; the payer and
backup suites run without declared circuits, in memory.
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
resolution without proving, a stale receipt racing a reproof (kept as
superseded evidence), a lagging venue view, an ended term without successor,
and `SILENCE` refusal at the horizon, after the boundary and in a returned
segment past its own horizon.
`test/pool-v3-wallet-backup.test.ts` ports the v2 offline-handoff cases: complete
round trip with every state row compared, freeze across handles and restart,
exact re-export, wrong key, digest, domain and venue, corruption, state no
wallet could write, occupied destinations, unsupported schema and oversize
without freezing, submit and fulfillment completions racing the freeze, an
interleaved destination, continuation of pending work including reproof after
takeover, and seed restoration of holdings with change.
`npm run check:pool:v3-wallet` exercises fresh processes at request, fulfillment,
payment, receipt, reproof, export and restore commit boundaries with synthetic evidence, and at a read's
commits to its evidence file and its kept replay file (before either, the kept state stands; between the
replay commit and its digest, the file is discarded and replayed). These are process-exit
tests, not physical power-loss or qualified-storage evidence.

The real-proof `scripts/pool/v3/store-check.mjs` obtains the payment request
from the receiver wallet. The payer wallet pays it and the operator's fee request
from its restored issued note, proves through the runtime prover and submits
through the [local service](POOL_V3_SERVICE.md). The payer reconciles the
payment final; the receiver fulfills from independently replayed public
evidence downloaded over HTTP. The source-bound
[journal report](pool-v3-store-verification.json) records that acceptance.
`history-store-check.mjs` runs the wallet on its kept files with real proofs
past the old one-package ceiling: it pays from kept witnesses, refuses to
prepare under silence, and after the operator's return proves its lapsed
payment again in the returned segment ([report](pool-v3-history-store-verification.json)).
A real-proof spend of inherited notes after a takeover is covered by the
succession check.

That harness hands the request object across directly; the request frame and
digest are oracle-tested. A human authentication channel is not qualified.
`test/pool-v3-scope-wallet.test.ts` covers two backings in one scope: separate
views and payments of each from one package, both refused once either term
ends, an adopted and withdrawn demand read once at a split opening, reproof of each backing's pending
payment into its own segment after a split, a split package that does not
establish the other backing, payment under imported roots after a rejoin, a
same-operator reappointment ending the segment's term, and one silence clock
closing both. `scope-store-check.mjs` pays one wallet request with a real proof
in the rejoined scope from a note created in the split segment
([local](pool-v3-scope-store-verification.json), [synthetic Ergo](pool-v3-scope-store-ergo-verification.json)).
A statement spending two backings' notes is outside the wallet.
Cancellation/release remain open; backup and
restoration are oracle and process tested, not physical-loss drills. The v2
wallet and service retired against a [case map](../decisions/2026-09.md#2026-09-28--retire-v2-against-a-case-map-of-its-checks).
This library establishes no mainnet readiness or physical custody qualification.
