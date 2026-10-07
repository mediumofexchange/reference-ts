# V3 wallet

`src/pool/v3/wallet-store.ts` implements one local wallet seed that receives under
[pool-delivery C4.1–7](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-delivery.md)
and pays under [pool-fees C1.2.3–5](https://github.com/mediumofexchange/money-from-first-principles/blob/37cbd40/pool-fees.md).
It runs under the adopted configuration (pool-v3 §11.4) and the recomputed reference venue guard. It is
not exported from the root barrel. Node 24 is required for its SQLite storage, at 24.21.0 or later (24.6.0's `node:sqlite` binds a
zero-length blob read back as NULL and refuses a statement naming one numbered parameter twice, and its libuv crashes at a
command's exit on Windows).

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
  witness for each positive output of this seed, with its nullifier and
  opening. A later read verifies and scans only records it has not replayed,
  asks the venue only for indices past the last read's, and reads its unspent
  notes from the kept witnesses; it recovers a note from its output again only
  to spend it ([decision](../decisions/2026-10.md#2026-10-04--keep-each-witnessed-outputs-nullifier-and-opening-with-its-witness-and-leave-spent-ones-out-of-a-wallets-read-slice-11-m11b7-next-4x)). The
  verifier's circuit identities, which the wallet requires to be the adopted
  configuration's, name the kept state.

Neither file holds a secret or is part of a backup. Losing one costs a first
sync or a full read and nothing else. A kept replay file that fails its digest,
a kept class that fails a check, and kept state read through a later venue
clock than the one now shown are discarded and replayed, asking the venue for
everything. Evidence that no longer hashes reads as absent. An evidence file
that cannot be opened at all refuses `STORAGE` and is never replaced by the
wallet, since it may be the holder's only copy; the holder removes it. One
that another handle holds refuses `STORAGE` as in use. A
package handed to a read is kept even when the read refuses, and nothing prunes
the file ([decision](../decisions/2026-10.md#2026-10-01--add-no-certificate-encoding-keep-12-to-the-kinds-a-reader-reads-and-prune-no-retained-evidence-m4)).
A file a hostile supplier grew is replaced, never removed first: sync a new
file from another supplier, check that its reads resolve, then swap the
files. A read left `unresolved-evidence` over what the file holds is
answered by supplying again in full (`{ full: true }`). The replay file shows
which outputs are this seed's and each one's opening and nullifier (never its
spend secret), so it needs the database's protection; during a
read, SQLite's temporary files for it (savepoint journals past the page cache)
go to the system temporary directory and are deleted on close. Reads and
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
force-spent notes are not holdings; notes under a standing demand are `locked`
until it ends or its deadline passes (C3.7), and inputs of a saved payment or
burn, a prepared demand or a prepared settlement are `reserved`. Each holding
names the demands of this seed that present it (`presented`): those saved here
whose inputs name it, whatever their status, and those the record holds naming
its tag, ended or not, forced ones included. A seed-restored wallet misses a
demand refused at the door, published without force, or admitted only into a
segment the canonical one did not import. The view also
lists this seed's standing demands over its unspent notes (identity, quantity,
instant, deadline and the holdings each names); a demand one of whose notes was
spent is void and not listed. The view covers one backing at one witnessed
index; it is not a global balance, and restoring from the seed alone finds the
same notes, including change, and the same standing demands. A payment or act
is built only from a view at least as recent as every view the wallet has synced
or fulfilled at and every one a saved record was built or decided at (`CHANGED_VIEW`
otherwise), and an older view fails no saved record.

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
new spend (C1.2.5). Inputs stay reserved until the payment is final or
failed: a failed payment's other input is free again, as a failed act's notes
are. Failure means an input was spent by another statement, which canonical
history never undoes; should evidence ever show all four outputs, the payment
would go final, as an act does. Output reservations are permanent. Release
with other outputs (cancellation), same-segment tail repair (C2.10.9a) and
release of never-admitted inputs are not implemented. Multi-backing payments and
cross-backing fees are refused. Payments and acts are one kind of saved record
under one alias namespace. The wallet profile is `moe/wallet/v3/8`; a database
of an earlier profile (withdrawals and settlements naming a demand by alias,
payments and acts saved apart, no saved acts, no output openings, or a package
saved with each fulfillment, or no saved demand links) is refused.

## Redeeming and issuing

The same wallet holds the backer's and the holder's redemption acts
(pool-recovery C3, pool-v3 §3), each saved before it is returned, retried
exactly under its alias without evidence, proving or signing, refused under an
alias holding another act or a payment, sent by `submit` (or, in a gap,
`publish`) and resolved by `sync` (slice 9, M9a under service and M9b1 in a
gap, on the local venue).

- **Backer.** `issue` proves an issue to an exact payment request; K signs it
  through a caller `BackerSigner`, whose answer must verify strictly under the
  terms' obligor, so K's secret never enters the wallet. `accept` answers a
  demand standing over the backing with C4.7's owner derived from this seed,
  the demand and the acceptance deadline (distinct demands never share an
  owner, C3.4); the deadline is at or before the demand's and later than the
  horizon. The settled note is found by `sync` through that owner, and
  `burn` destroys a quantity from available notes with fresh change.
- **Holder.** `demand` presents whole notes: one of exactly the quantity or a
  pair summing to it (otherwise pay yourself that amount first, C3.3),
  unpresented ones first; failing those, the notes of one earlier demand of
  this seed (all or a subset), whose tags it then repeats, so it links to the
  demands presenting them (`repeats`), never notes of two earlier demands
  together nor a presented note beside an unpresented one (`FUNDS`). A
  re-demand keeps snapshot redemption (C2b.3.2) open where a fresh spend is
  refused (`SILENCE`, an ended term). `prepare` and `burn` select no presented
  note; `freshen(alias, demand, …)` spends the demand's available notes (one
  with a fresh zero input, or its pair) into one fresh note of their sum, a
  payment (kind 2) submitted, reproved and resolved as one, which links no two
  demands (§C1.5, C3.1; `LOCKED` while the demand stands). The
  instant at the read's witnessed index and the holder's deadline strictly
  ahead of the horizon. Its presenter key comes from the seed and the notice
  (tags, instant, deadline), and a one-note demand's zero padding from the
  seed and the note's nullifier, so a retry or a rebuilt wallet names the same
  demand. Its notes stay reserved while it is prepared; once it stands, its
  own lock holds them until it ends (withdrawn or settled, by whichever copy)
  or its deadline passes (C3.7).
  `settle(alias, acceptance, …)` settles the demand the acceptance names; it
  checks the acceptance against the obligor, the demand's deadline and the
  horizon, re-proves the demand's positions into one output to the
  acceptance's owner with `rho_out` derived from the seed, the input
  nullifiers, the segment and the disclosure count (C3.5), and signs the
  release. `withdraw(alias, demand, …)` signs the withdrawal of the demand
  with that identity for the canonical segment. Both read the demand's notice
  from the view, so they need it standing (admitted, or with force in a gap)
  and recognize it as this seed's by its presenter key, which only this seed
  derives (`UNKNOWN` otherwise); a demand a lost wallet made is settled or
  withdrawn from the seed alone, and its settlement is the record the lost
  wallet would have made at the same disclosure count. A prepared settlement
  reserves the demand's notes. It takes them even where another saved record
  reserves them (a payment a restored copy prepared before the demand stood):
  while the demand stands its lock refuses that spend at the door, and the
  settlement's admission fails it.

**In a gap** (C2b.3.2) the holder redeems with the operator offline. Where
the backing declares silence and the horizon is past the canonical
checkpoint by more than its duration, the operator would refuse
(`SILENCE`), and while no later checkpoint is witnessed the gap is open at
every index an act could first be witnessed at. `demand`, `withdraw` and
`settle` then bind their statement to that checkpoint, the snapshot, whoever's
term it fell in, and `publish(alias, publisher)` publishes the saved act at
the backing's venue, routed to its backing, exactly as saved; a retry
republishes the same publication. A gap demand's deadline must lie after
every index C3.3's window lets it be witnessed at (index + 2·lag). `sync`
reads the act final once its publication has force. The backer `accept`s a
demand with force as one admitted, and its settled note waits for the
operator's return to be adopted before it can be burnt; an issue, a burn or a
payment still refuses `SILENCE`. A publication outside an open gap has no
force, and a release published so discloses its output.

The disclosure count is read from the venue record. For `settle` and
`presentation` alone, the frontier read lists every acceptance the venue
witnessed for the backing (`answers`): alone (publication kind 2) or in a
release (kind 3), whether or not the terms declare silence, keeping a
release's segment, output, `rho_out`, signature and force verdict but not its
proof; other reads do not ask the venue for publications they do not need. The
count is the number of distinct outputs among the releases without force
naming the demand and the segment and signed by the demand's presenter key. So a settlement after a release without force
names an output nobody has seen, and any wallet of the seed, a restored one
included, reads the same count from the same record. A copy, or a "release" with a signature that does not verify, adds
nothing. An output disclosed only to an operator is not counted (C3.5).
Because `rho_out` reads no acceptance or owner, `settle` refuses (`CONFLICT`)
while another settlement of the demand is prepared at the same count: one
published release would otherwise let K compute the other's output for any
owner. Publish or resolve the prepared one first. For the same reason
`publish` refuses (`CONFLICT`) a settlement that has failed: it has no force
at any later index, and a later settlement at the same count names its output.
A release sent in time but witnessed only after a later settlement at its count
was built still discloses that settlement's output; C3.5's count reads only
witnessed releases ([review decision](../decisions/2026-10.md#2026-10-02--close-the-code-review-of-slices-910-the-publishers-readiness-race-a-failed-settlements-disclosure-serves-keep-alive-window-and-verifier-key-sets)).

Resolution: an act is final once its statement is in canonical history,
imports included, or (a demand, withdrawal or settlement) has force at the
venue; an output alone never decides, since a settlement's or issue's output
is public before admission and another statement can create it first (C3.8).
An act fails when it can no longer take effect as saved: its segment is no
longer canonical, a demand's instant has left C3.3's window for good
(witnessed index past instant + 2·lag, the latest a relayed publication
could still be witnessed in it), its output exists from another
statement (a settlement's also from one with force), a reserved input was
spent otherwise, its demand ended otherwise, or a settlement's acceptance
deadline has passed. A failed act's notes are free again; one that evidence
later shows admitted (an operator reading behind the wallet) becomes final. A
burn the operator refuses in a live segment stays reserved, as a refused
payment's inputs do, until it fails.

An act whose segment ended fails and is made again under a new alias; `reprove`
is the payments' alone. C2.10.8 rebuilds a statement for a new segment with a
new identity and fresh evidence anyway, and a payment's reproof exists to keep
outputs a payee was given (C1.2.5). An act's outputs are the request's (an
issue's, which its intent binds under any alias), its own (a burn's change) or
derived per segment (a settlement's), and its signatures are made again. The
backer's acceptance stands, since it names the demand and the demand keeps its
identity in the imported history.

**Dishonour** (C3.8). `presentation(demand, …)` reads one demand's outcome over
the terms' backing at the venue's index from public evidence alone, for the
holder, the backer or anyone; it writes nothing and decides no saved act
(`ABSENT` where the record holds no such demand of this backing). Each event
counts from the index it was witnessed at: a statement in history at the
earliest canonical checkpoint holding it, a publication with force at its own
index. The reading names the index the demand was first witnessed at; its end,
if any: its settlement, its withdrawal, or a void (one of its notes spent
otherwise than by its own settlement), from the index witnessed; and the
indices past its deadline at which it stood unended (`overdue`), read as the
backer's dishonour or, where a timely acceptance stood unreleased, the
holder's lapse. A later end does not erase those indices. A demand first
witnessed at or after its own deadline (an operator that admitted it and
checkpointed late) sets no term K could meet (`inTerm` false, C3.3) and
reads neither; a withdrawal or settlement admitted in time but witnessed
after the deadline leaves the indices before its witnessing as they stood. The acceptances it
lists are those the venue witnessed, alone or in a release, that K signed (in
lit, its owner key too, lit-v1 §7) and that are due no later than the demand; one is timely where its deadline is
later than its first witnessed index by more than the lag (C3.4), and one whose
release was taken (below) reads as released. So the backer publishes each
acceptance as it makes it (`publishAcceptance(alias, publisher)`, routed to the
demand's backing; a retry is the same publication): an acceptance nobody
published, and a settlement witnessed only after the deadline, leave the
indices past it reading as dishonour. A gap release refused only because its
output already exists as a settlement output of another demand is reported
`TAKEN` (force judges new nullifiers and outputs after every other check):
only K, naming one owner for two demands, can cause it, and it bears the
dishonour. A settle the operator refuses leaves the acceptance unreleased in
the record, the adopted limit. The reading is evidence about the record, not
proof of payment outside it (C3.3a).

## Backup and restoration

There are two paths, for two losses.

**Seed restoration** (C4.6) recovers money after the device and its local state
are lost. `V3Wallet.restoreSeed(path, options, seed)` creates a new wallet at a
new path from the backed-up seed. `sync` then finds the same positive unspent
notes, including change, from complete public evidence. No request, alias,
fulfillment or pending payment returns, because none is seed-recoverable (C4.2).
New requests draw fresh random identifiers, so nothing is reused. Standing demands
are found again by their presenter keys (`sync`'s `demands`), so the restored
wallet withdraws or settles them. A payment
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

## Commands

`moe wallet` wraps this library as one process per operation over a wallet directory
([M10b decision](../decisions/2026-10.md#2026-10-02--install-one-moe-command-over-role-directories-on-ergo-venues-only-with-keys-in-files-and-funding-apart-from-the-wallet-slice-10-m10b),
[M10c2b1](../decisions/2026-10.md#2026-10-02--run-the-wallet-and-relay-commands-over-the-library-with-kept-evidence-acceptance-files-and-a-status-read-slice-10-m10c2b1)).
The directory binds one venue and holds `wallet.db` (with the seed), its evidence and replay files, the kept terms,
a service file per operator and the package of its last sync per backing. `init --venue <file>` creates it with a
fresh seed; with `--backer` it also holds K (`backer.key`), and `venue create`, `terms create`, `issue`, `accept`
and `burn` are enabled (`publish-acceptance` signs nothing, so a backer's copy restored without K still
republishes its saved acceptances). Only `init`, a backer's `venue create`, `restore-seed` and `restore`
create a wallet database, so a lost one never comes back as a fresh seed. The directory holds no funding key.

| Command | Does |
|---|---|
| `request <alias> <backing> <value> [--out f]` | the exact request: its 246-byte frame (hex, and the file) and digest to hand on |
| `pay <alias> <backing> --request f --digest d --value n` | authenticates the frame by the digest, prepares the payment and submits it |
| `sync <backing>` | holdings (available, reserved or locked, with the demands presenting each), standing demands, the canonical checkpoint and whether the gap is open; resolves saved records. `available` totals what `pay` and `burn` can spend, `presented` the available notes a demand presented, which only `freshen` moves |
| `fulfill <alias> <backing>` / `fulfillment <alias>` | the request found paid; never replayed: a rerun exits 4 printing the saved fulfillment |
| `demand`, `withdraw`, `settle --acceptance f`, `freshen` | the acts above; `freshen` submits as `pay` does |
| `submit <alias> <backing>`, `status <alias>`, `reprove` | submits a saved record (a rerun prints the kept receipt); reads a saved record as the last sync resolved it; re-proves a payment in the canonical segment |
| `presentation <backing> <demand>` | C3.8's reading from public evidence |
| `publish <alias> <backing> --out f` | a demand, withdrawal or release as a publication file for `moe relay publish`; refused unless the read shows the gap open |
| backer: `issue`, `accept <alias> <backing> <demand> --deadline n --out f`, `burn`, `publish-acceptance` | `accept` writes the acceptance as its canonical publication bytes, which the holder's `settle --acceptance` reads |
| `seed --show`, `restore-seed`, `handoff --key k --out o`, `restore --key k --backup o --digest d` | the seed (the only secret printed); a new directory from the seed on stdin; the freezing export (its key written first and reused on rerun, both files new, outside the directory and on a file system with hard links; `o` is checked new before the wallet freezes); a new directory from the handoff, a rerun confirmed by its provenance. `--backer-key` copies K into a restored directory |

Each command that reads syncs the directory's Ergo view first, in bounded passes until it is caught up, with a
`syncing` event on stderr for each pass another follows. Every mutating command names the alias the library keys on, so a rerun after a crash or a lost reply is the exact
retry and prints the saved result; a deadline is a witnessed index, absolute or `+n` from the read, and a saved
demand prints its absolute deadline so a rerun can name it. Evidence comes from the operator's service, synced into
the evidence file, or from `--package f`; where the service does not answer, a read uses the package the last sync
kept and says so (`evidence: "kept"`), as a holder does in a gap. The first request or payment shows the request
channel, thin-interval and publication-funding explanations; each demand and `freshen` says what its tags link.
Output, refusals and exit codes follow the M10b decision (one JSON object on stdout; refusals exit 1, usage 2,
unexpected failures 3 with their stack).

A directory serves one construction, declared at `init --construction` and kept in config.json: `moe/pool/v3` by
default (and for any directory made before the flag), or `moe/lit/v1`, the adopted lit notes
([M14g4 decision](../decisions/2026-10.md#2026-10-07--run-lit-backings-through-the-moe-commands-each-directory-declaring-its-construction-slice-14-m14g4)).
Terms of the other construction refuse as `CONSTRUCTION`. A lit directory proves nothing, so it keeps no parameters
(`--parameters` is a usage error) and opens no verifier. Its `request` frame names a fresh owner key (lit-v1 §8), and
`fulfill` prints the output credited to it. `accept` names an acceptance key. `terms create` takes `--silence` without
`--challenge`. `move-window <alias> <backing>` moves a full owner-key window (a seed restoration needs it before its
first request). `freshen` refuses as `CONSTRUCTION`; `presentation` reads an acceptance as an answer only where K and its
owner key both signed it (lit-v1 §7), and a lit release discloses nothing. Everything a lit statement carries is public
(lit-v1 §11), and its explanations say so. The relay keeps no parameters and publishes either construction's
publications. `npm run check:lit:commands` drills a lit backing on the synthetic node, its gap route included.

### Transport

A holder reaches an operator that is not on its own machine as a Tor onion service
([M12a decision](../decisions/2026-10.md#2026-10-07--reach-an-operator-as-an-onion-service-through-the-holders-own-proxy-and-serve-holders-on-a-listener-of-their-own-slice-12-m12a)).
The operator runs `moe operator serve --dir <d> --interval <n> --onion <host> --holder-port <p>` with Tor's `HiddenServicePort 80 127.0.0.1:<p>`:
a second loopback listener serves holders only (submission and evidence, no admin credential, sixteen connections of
its own), and `holders.json` names `http://<host>/` with the wallet token, to hand to holders for `service add`.
Every `moe` command speaks HTTP through Node's `fetch`, so it takes Node's environment proxy:

```sh
NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://<isolation>:x@127.0.0.1:9080 NO_PROXY=127.0.0.1 moe wallet sync --dir w <backing>
```

with Tor's `HTTPTunnelPort 9080`. An onion URL refuses as `PROXY`, before any connection and so before any name lookup,
unless `fetch` will tunnel it through a loopback `http:` proxy: the environment proxy on (`NODE_USE_ENV_PROXY=1` or
`--use-env-proxy`), `http_proxy` (or, where it is unset, `HTTP_PROXY`) such a proxy, and `NO_PROXY` not exempting it;
a proxy that does not answer refuses as `PROXY` too. A remote proxy is refused because it could answer for the onion
and take the wallet token. A malformed `HTTP_PROXY` stops Node before `moe` runs. `NO_PROXY=127.0.0.1` keeps a local
node direct (Tor refuses connections to internal addresses); a remote node goes through the same proxy. `init` fetches
the proving parameters, so run it under the same environment or copy them with `--parameters`.

Tor gives each distinct proxy credential its own circuit (`IsolateSOCKSAuth`, on by default), and each command is one
process over one backing, so a fresh `<isolation>` per command keeps commands apart. Within one command the operator
still sees what one circuit carries: `pay`, `freshen` and `move-window` sync the backing and then submit, which shows
which backing the spend moves in a multi-backing scope. To part them, `sync` with one credential and then
`pay … --package <dir>/packages/<backing>` with another, at another time. A SOCKS-only proxy needs an HTTP tunnel in
front (Node's `socks5:` support is experimental and writes a warning to the stderr agents read). The onion listener's
sixteen connections are open to anyone who knows the name: Tor's `HiddenServicePoWDefensesEnabled` and
`HiddenServiceMaxStreams` are the operator's levers against a client that holds them.

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
Every suite runs on the kept path: a wallet refuses a verifier that does not
name the configuration's circuits.
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
`test/pool-v3-redemption.test.ts` runs issue → demand → accept → settle → burn through two wallets and a journal with
stand-in proofs: exact retries and alias conflicts, the seed's presenter and `rho_out`, reservation and its
release by a final withdrawal, a re-demand of freed notes; presented notes refused to payment and burn, a re-demand
of one earlier demand's notes preferred after unpresented ones and never mixed, `freshen` with its retry and its
`LOCKED`, `ABSENT` and alias refusals, and presented notes read alike by a seed-restored copy, a forced demand's
included; non-exact quantities, horizon deadlines, foreign
signers, forged or altered acceptances, settlement after withdrawal, and acts across an offline backup. In a gap
with the operator offline it demands, settles and withdraws by publication: issue, payment and burn refuse `SILENCE`,
a deadline inside C3.3's window refuses, and acts become final by force. A release
published after its acceptance deadline has no force, fails its act and counts, so the next settlement re-proves the
same nullifiers into a new output; a forged release to another output is witnessed and not counted. A release published
under terms without silence counts too, a second settlement at one count refuses, and only demands, withdrawals and
releases are published. Its C3.8 cases read, from any wallet: dishonour from the index after the deadline, kept
through a later withdrawal; a timely published acceptance left unreleased as the holder's lapse; a settlement and a
withdrawal in time with no failure; no count for an acceptance K did not sign, one due after the demand, one of another
demand or backing, or one witnessed with only the lag left; a void from the checkpoint of a spend after the deadline;
and a gap release taken by another demand's settlement under an acceptance naming the same owner (`TAKEN`), which
releases the holder's acceptance and leaves the backer's dishonour. Not covered: a release of the demand in another
segment, a gap across several backings, an ended term or a return, and a venue that witnesses an exact republication
again.
`command-drill.mjs` (in `check:pool:v3`; `npm run check:pool:v3-commands` alone) runs the commands from an `npm pack`
install in a fresh directory, with real proofs, in fresh processes on separate directories over the synthetic Ergo
node, and checks that no process proving nothing loads a `@noir-lang` module: a backer's terms, issue, payment, serve committing
on admission, fulfillment and its exit-4 rerun, a demand, the acceptance relayed, settlement and burn read final by sync
and the reader's supply, a withdrawn demand's notes refused to a payment and freshened, restore-seed and a handoff
restore; past the old 67-statement ceiling, 70 real-proof issues to the holder's seed (made through the library in the
drill's process) read by the holder's sync and the reader's supply; with the operator offline past silence, a payment
prepared as it went quiet, a demand and settlement published through the relay and read final by force, the operator's
return and adoption, and the lapsed payment proved again, final and fulfilled. It records each process's peak RSS
(at most about 470 MB for a proving wallet command over that history). With `--testnet --authorized-testnet` the same
checks ran over the own live testnet node ([M10d](../decisions/2026-10.md#2026-10-06--drill-the-moe-commands-live-on-the-testnet-and-keep-the-testnet-context-without-a-difficulty-floor-slice-10-m10d),
[report](pool-v3-command-testnet-verification.json)): each funding key paid from the retained testnet wallet and swept
back, a 30-block silence, two bulk notes instead of seventy.
`redemption-store-check.mjs` (in `check:pool:v3`; `npm run check:pool:v3-redemption` alone) runs the same path with real
proofs, each wallet operation in a fresh process that opens its database, proves with its own prover and syncs its kept
evidence from the operator's HTTP service: issue, payment and fulfillment, a demand, the backer's published acceptance,
the settlement (read settled by a third wallet, C3.8) and a burn, each act but the burn retried exactly in another
process with no evidence, prover or signer. With the operator offline past silence, an issue and a burn refuse
`SILENCE`, and the holder demands and settles by publication and reads both final by force; a holder-only reader in a
fresh process confirms supply and force. A wallet restored from the seed alone finds the holder's two standing
demands, settles one and withdraws the other; the lost wallet's settlement under the same acceptance is the same
statement and reads final from the restored one's admission. In the gap, a release published after its acceptance
deadline has no force (`DEADLINE`), fails its act and counts, so the next settlement spends the same notes under a new
`rho_out`; a copy of that settlement with a forged presenter signature, witnessed first and in time, has no force
(`SIGNATURE`, though its proof verifies), and the genuine one is final by force; a release
whose output a settlement of another demand under an acceptance naming the same owner created first is `TAKEN`, and
past the deadline its demand reads as the backer's dishonour ([local](pool-v3-redemption-store-verification.json),
[synthetic Ergo](pool-v3-redemption-store-ergo-verification.json)). The other hostile C3.4–C3.8 cases above (a lapse, a
void, a demand outside C3.3's window, a forged withdrawal, refusals under service) have stand-in proofs only.
`npm run check:pool:v3-wallet` exercises fresh processes at request, fulfillment,
payment, receipt, reproof, export and restore commit boundaries, and at the one commit of a demand, an acceptance,
a settlement, a withdrawal and a burn (before it, the act is made again: the same statement for the seed-derived acts, the same record with the
stand-in prover, a fresh change output for a burn; after it, an exact retry returns it with no evidence, prover or signer), with
synthetic evidence, and at a read's
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
ends, an adopted and withdrawn demand read once at a split opening, a demand of one backing refused under the
other's terms (withdrawal, acceptance, reading), reproof of each backing's pending
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
