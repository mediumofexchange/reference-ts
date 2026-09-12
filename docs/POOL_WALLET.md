# Local pool wallet

The Node 24 `PoolWalletStore` retains v2 payment requests, complete pending
statements, receipts, private inbox deliveries and one local fulfillment record
per invoice. The local acceptance CLI connects two wallet databases to the
existing pool HTTP service and delivers the receiver's opening over HTTPS.
It is a developer fixture with a known local venue record. The same CLI runs
with either an ideal verifier or the pinned real v2 circuits and verifier.
Real mode constructs private witnesses locally and sends only canonical
statements to the service. It is a developer fixture, not an end-user wallet.

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

`checkNote(id, opening, evidence)` is read-only. It matches the persisted request
and receiver secret, requires the note commitment in the verified event history,
and derives its nullifier locally to report `unspent` or `spent`. Its result names
the exact checkpoint and includes the verified history for proof preparation.
It checks imported events too, but requires the wallet's configured segment.
Writable sessions now pin the full domain, segment, operator and scope authority.
For reading imported history under another same-domain segment, open an explicit
`new PoolWalletStore(path, authority, { readOnly: true })` session. It uses SQLite's
read-only mode and cannot prepare, submit, fulfill, authorize delivery or export.
Legacy databases must first be opened with their original writable authority to
validate saved contextual records and install the custody metadata.
The CLI requires `unspent` before fulfillment and before preparing another spend.
This check does not authenticate the payer's receipt; fulfillment still does.
An older checkpoint can report unspent after a later spend. Neither this result
nor local reservations establish current spendability or latest external state.

SQLite transactions record each invoice and payment commitment only once.
`received(id)` reads the saved opening after a restart or lost fulfillment
reply. Duplicate fulfillment is refused. This establishes one local record;
an external goods or payout system still needs its own idempotent delivery
integration. A received opening is historical payment evidence, not a claim
that the note remains unspent today.
`fulfillment(id)` returns the original opening, receipt and checkpoint as owned
copies. After a lost reply, callers reconcile against that record rather than
crediting the invoice again. Historical `fulfill()` remains available even for
a subsequently spent note; applications requiring an unspent note must check it
before calling. A saved record never authorizes a second external delivery.

## Private HTTPS delivery

`pool/wallet-delivery-http` provides `WalletDeliveryClient` and
`createWalletDeliveryServer`. The endpoint is HTTPS `/delivery/<requestId>`.
TLS 1.3 and certificate chain/hostname verification authenticate the configured
endpoint. A durable random 256-bit bearer capability admits writes only to its
existing invoice; it does not identify the payer or authorize fulfillment.
`deliveryToken(id)` provisions it transactionally and returns the same token
after restart. The [local pairing profile](POOL_WALLET_PAIRING.md) binds endpoint,
exact certificate, capability, domain and invoice through an independently
authenticated invitation digest. `acceptPairing` persists that exact binding;
`pairedDeliveryClient` reads it and rechecks active custody after TLS negotiation.
`installDeliveryCredentials` atomically rotates a private key/certificate and
revokes existing capabilities. Servers pin their actual certificate and
generation, with authorization checked again inside the inbox transaction.
The acceptance generates private receiver credentials and models independent
digest authentication through parent-owned IPC. A usable human authentication
channel, discovery and deployed endpoint operation remain unqualified.

`pool/wallet-delivery-wire` defines the bounded canonical JSON envelope. It
contains the invoice ID, domain, canonical statement, receiver opening and
original receipt, with a 300,000-byte maximum. Duplicate/unknown keys, alternate
encodings, byte-order markers, malformed UTF-8 and wrong context are rejected.
No private change or receiver spend secret is transmitted. HTTP headers,
connections and reply sizes are bounded; each connection has an absolute
15-second deadline. The client refuses redirects and exposes no TLS bypass.

`receiveDelivery(id, delivery)` checks the exact request/output and authenticated
receipt, including its original proof/signature attestation, before saving an
immutable inbox frame. An alternate valid proof may receive the same receipt
on protocol resubmission, but cannot replace the originally attested delivery.
Exact transport replay returns the same frame hash; conflicting replay is
refused. The acknowledgment is emitted after the SQLite commit and means
**stored**, not verified, final or fulfilled. `inbox(id)` returns owned copies.
The receiver separately runs `checkNote` and `fulfill` with caller-owned
checkpoint evidence; missing history leaves the inbox unfulfilled.

The token, inbox, transport credential and pairing tables are additive to the wallet schema. Inbox
admission avoids proof work; it does not bound total storage or history replay.
Local database/WAL/host-backup secrecy remains a custody requirement. TLS also does
not hide endpoint identity, timing or message size from network observers.

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

## Encrypted offline handoff and recovery

The selected local custody profile uses one active wallet on a trusted device,
with user-controlled protected storage for the database, WAL, swap, crash dumps
and host backups. Encryption and access protection of that device are deployment
preconditions, not configured or demonstrated by this fixture. An encrypted
offline export can be stored outside that device; retain its random recovery key
separately and its exact digest in an independently trusted current recovery record.
The operator and backup storage provider receive no recovery authority.

`exportBackup(key)` captures all nine wallet tables in one write transaction,
including private TLS credentials and accepted invitation bindings. Historical
seven-table exports restore with empty transport/pairing state; new exports
require current binaries. The retained payment state includes:
root and request counter, requests and spend secrets, complete pending proofs,
both private openings, receipts, input reservations, fulfillment checkpoints,
delivery capabilities and inbox frames. It persists the encrypted bytes and a
frozen-source marker together before returning. All current-version writable
connections subsequently refuse mutation, including after restart. Repeating
export with the same key returns identical bytes, allowing a lost reply or
failed file copy to be retried. Reads still expose the owner's local secrets;
freezing does not erase or revoke them. There is no unfreeze operation.

`pool/wallet-backup` supplies `createWalletBackupKey()` and
`walletBackupDigest(bytes)`. Use a fresh random 32-byte key for each handoff,
not a password or a wallet spend/root secret. The `moe/wallet-offline/v1`
envelope uses AES-256-GCM with a random 12-byte nonce, a full 16-byte tag and
authenticated fixed version/authority bytes. Its ciphertext is bounded at
16 MiB including framing. The canonical logical state is encrypted in memory;
there is no plaintext staging file, and SQLite temporary sorting uses memory.
Size, timing and possession of a wallet export are not hidden. JavaScript strings,
process memory, and a compromised host are outside the secrecy guarantee.

The application performs this explicit sequence:

1. Stop receiver transport and quiesce wallet workflows. Export under the current
   authority. Store the returned ciphertext durably, read it back, and retain its
   exact digest independently along with the intended authority. Keep the recovery
   key separately. A failed export transaction leaves the source active; a lost
   successful export reply leaves it frozen with retrievable identical bytes.
2. Restore with `PoolWalletStore.restoreBackup(newPath, authority, bytes, key,
   expectedDigest)`. The digest must come from the trusted current handoff record,
   not be computed from whichever file a backup provider returns. Restoration
   refuses an existing destination or sidecar and refuses any state written by
   another connection during initialization. It never merges or overwrites wallets.
3. After a lost restore reply, reopen that same destination and inspect
   `custody().restoredFrom`. The exact expected digest establishes that this
   import committed; `custody().frozen` also shows whether it was later exported.
   A crash before import COMMIT may leave a distinct empty wallet with no import
   provenance. Inspect it before choosing a new destination. Do not blindly retry
   restoration into another path.
4. Resume only the single selected restored copy. Reconcile outstanding commands
   by their saved exact statement bytes; verify notes against caller-owned
   checkpoint evidence before preparing a spend. Saved reservations remain in
   force. A remote submission already in flight can land after local freeze;
   the pending command is retained for its idempotent retry. The freeze cannot
   cancel remote activity, establish finality or imply that a note is unspent.

An export is a controlled offline transfer, **not continuous backup**. It does
not restore requests or payments made after a later copy resumes. Keeping only
an old export cannot recover a subsequently lost active device safely. Ciphertext
authentication and a digest do not detect rollback of the trusted recovery record
itself; copied databases and two restored active copies cannot be prevented
without an additional coordination boundary. The holder must maintain the current
record and one active copy. Executables predating custody guards must not access
these wallets. Arbitrary key-holder-created snapshots, corrupted local databases
and future schemas are not supported migration inputs: restoration authenticates
this implementation's complete exports, not arbitrary wallet semantics.

This local format changes no v2 derivation, circuit, protocol frame or witness
rule. Seed-only restoration, successor capsules, continuous disaster recovery,
device provisioning and automatic rollback protection remain open.

## Run the acceptance

```sh
npm run build
npm run check:pool-wallet
npm run check:pool-wallet-real
npm run check:pool-wallet-crash
```

The ordinary `npm run check` includes ideal wallet and crash acceptance on
Node 24. Hosted CI also runs real-wallet acceptance on Linux and Windows.
Private localhost certificates require an installed OpenSSL 3 executable. The
helper discovers OpenSSL on PATH or standard Git for Windows paths; `MOE_OPENSSL`
can name an explicit executable. Keys remain in memory during provisioning,
then commit with the wallet. Certificate validity is 30 days; rotate before use
after expiry. This transport clock never controls protocol finality.
The optional
SQLite module is imported through
`@mediumofexchange/reference/pool/wallet-store`; it is not in the Node 20 root
export. Derivation is available through `@mediumofexchange/reference/pool/wallet`.

The fixture issues 10 units, pays 7, verifies the receiver's payment and the
payer's 3-unit change after wallet restarts, then burns both holdings. It drops
an accepted service reply, compares the exact receipt on retry, exercises
changed-proof resubmission, withholds checkpoint history and refuses invoice
replay. The receiver HTTPS process drops a committed inbox acknowledgment,
restarts with the same private credentials, capability and invitation, rotates
credentials, rejects the stale certificate and old invitation, then authenticates
the replacement and accepts the original payment's exact retry. A different real
proof cannot poison the inbox before the original delivery arrives. A
noncooperating test receiver is forcibly stopped and its exit observed; cleanup
attempts independent resources even when one fails. The service observes only
public statement frames; private change stays out of receiver delivery.
The [verification record](pool-wallet-verification.json) pins the tested source,
current acceptance, review findings and evidence limits.

## Real proofs, public audit and interruption

The payer exports after the service accepted its payment but the reply was lost;
a fresh process restores it before exact retry. The receiver stops, exports its
stored inbox, restores to a fresh database and resumes the same delivery
capability before verification and burning. Neither recovery key travels in
command arguments or operator requests. The custody worker receives it on stdin;
the test parent retains the expected digest independently of the encrypted file.

Real mode uses the existing isolated compiler and Barretenberg verifier, checks
source, toolchain, bytecode and verification-key pins, and constructs note and
scope paths from verified local events. An extra unverified served tail cannot
change the wallet's anchor. Repeated preparation retains the saved proof but
still checks the reconstructed recipient and outputs; changed requests fail.
The fixture currently supports one pinned segment with no imported events.

A separate audit process receives public history, a known local venue ledger,
compiled circuits and an expected exact commitment supplied separately from
the history. It derives public issued/burned/outstanding totals after replay.
Negative cases withhold history, corrupt a proof, reorder statements and
substitute a different valid proof/history with unchanged note outputs and
totals. The last case must fail the history binding even though its proof is
valid. Public-input/process separation is not an operating-system sandbox.

The crash harness exits child processes immediately before and after SQLite
COMMIT for request, pending statement, receipt, fulfillment, capability,
credential rotation, invitation mint, pairing import, inbox, export and import
(22 abrupt exits and 22 fresh recoveries). Fresh processes
check rollback or exact retained state, both input reservations, private change
and one local fulfillment. Test-only interception of SQLite calls keeps crash
hooks out of the runtime. This checks process interruption, not power loss,
storage corruption or database rollback. Export tests check freeze/export atomicity;
import tests check the whole state and provenance against an empty pre-commit
destination. Credential rotation checks that revocation and new credentials
commit together; invitation/import checks retain exact authenticated bindings
and lost-reply retries. Crash cases use ideal proof fixtures;
the real flow separately exercises complete proof persistence and lost replies.

## Boundaries

The database, SQLite WAL and host backups contain plaintext secrets; only the
explicit offline export is encrypted. The selected custody profile requires
protected local storage, trusted current binaries, an independent current recovery
record and one active copy. The fixture does not qualify device protection.
It has no key custody service, continuous backup, seed-only restore, note selection, automatic
reservation release, lapse/replacement handling or external witness adapter.
The fixture uses private per-wallet TLS keys and durable digest-checked pairing.
Supported deployment still needs a qualified independent authentication channel,
device protection and endpoint operation. The invitation file alone conveys no
trust; comparing a digest distributed with that same file is insufficient.
Transport byte limits do not bound wallet history replay, proof work or disk growth.

The [production requirements](PRODUCTION_REQUIREMENTS.md) and
[retirement map](PRIVATE_PAYMENT_ARCHITECTURE.md#retained-evidence-and-retirement-conditions)
retain supported custody and external-evidence work.
Invoice fulfillment records historical payment inclusion; it is not a new
claim of a note's current spendability. Checkpoint-scoped note verification is
separate from historical fulfillment and from receipt authentication.
