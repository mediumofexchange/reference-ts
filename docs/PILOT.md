# Durable local payment pilot

The pilot runs the **frozen transparent path** across separate wallet and
service processes: one operator, one signed root backing with a constant
payout in an external thing, a local witness the receiver trusts. It is an
integration harness — it proves the protocol's durable-command, receipt,
commitment and verification layers work end to end across a process boundary —
and not a product. Its transport and CLI are retired when a pool equivalent
exists; its durable-journal pattern carries forward. The transparent claim
layer it runs is an [Extensions profile](https://github.com/mediumofexchange/money-from-first-principles/blob/8d5055ebd0ff1dbebf9f72d716735d3486e643e0/extensions.md#the-transparent-profile),
not the core.

Use Node.js 24 in a source checkout:

```sh
npm ci
npm run check
npm run pilot:demo
```

The demo creates disposable keys and a journal under ignored `scratch/`, issues
100 claims, transfers 40 between two wallets, checks pending and final evidence,
kills and restarts the service, retries the saved request, and redeems 40 claims.
It also terminates a writer at three transaction checkpoints. It removes its
files afterward. Node 20 checks the core and installed package; Node 24 also
checks SQLite and the process scenario.

## Profile

`transparent-pilot/v0-directory-v1`. One operator serves one signed root
backing: R is empty and P is a positive constant quantity of an external named
thing. E names the operator and one explicit local witness with immediate
finality. No replacement, non-service aggregate or silence clause is enabled.
Issuance, transfer, burn, demand, acceptance, release and withdrawal keep
Construction's signatures, nonces and conservation rules. Redemption in
external goods is acknowledged by the holder's release, not proven by the
computer. The root must be registered before the first witness record, and the
pilot does not add roots later.

Commitment signatures use the context `moe/commitment/v2` and authenticate a
version-1 directory (Construction §C0b, §C2.4.2): the root is SHA-256 of the
four ASCII bytes `MOED`, a one-byte version `1`, a big-endian u32 entry count,
and the sorted `(backing name, snapshot digest)` pairs, each 32 + 32 bytes,
names strictly increasing in unsigned byte order. A snapshot digest is SHA-256
of the backing name, a big-endian u32 operation count, and each operation's
canonical identity prefixed by its big-endian u32 byte length; the operation
identity includes the signer set where that set determines the operation's
effect. Log positions equal array positions. The directory is served flat;
absence from it proves omission, and a name present without its log is
unavailable evidence. Earlier experimental commitment signatures are
incompatible and have no migration.

## Trust and limits

The service hosts both the operator and the local witness. A receiver checks
signatures, authorization, lawful history and exact inclusion independently of
the operator's balance claims, but trusts the configured witness endpoint for
record completeness and order. A receipt has local finality only after the
durable witness record includes it and a receiver validates the lawful
committed history. This demonstrates recovery from process crashes on trusted
local storage. It does not recover against a hostile operator, prove EUR
delivery, or offer privacy; issuer creditworthiness remains outside software
evidence. An outage is recovered from durable local history; permanent loss of
that history remains loss. Software must identify these limits to users.

Registration and advancing the local witness require operator administration
authority. Wallet transport credentials permit signed submissions and reads;
they confer no issuance or spending authority.

The journal permits 10,000 commands; startup replays and compares every
response. Existing command IDs remain retryable at the limit. Growth is
deliberately bounded, with no pruning or migration; growth limits fail
explicitly rather than silently omitting history. Never empty a journal and
reuse its key.

## Durable execution

The implementation preserves the ordered canonical commands and exact
responses in a transactional journal. Replaying it reconstructs the same
ledger, nonces, receipts, commitment sequences and witness indices. A command
is exposed to a caller only after its transaction commits durably. A repeated
command identifier with identical content returns its original response;
different content under that identifier is rejected.

`PilotStore` uses SQLite WAL with FULL synchronization and verifies those
settings. The profile, operator key and venue are bound to the journal; a
different key or incompatible journal version is refused. `BEGIN IMMEDIATE`
serializes writers; transactions catch up with other writers before signing.
Failures discard speculative memory. Replay validates the commands and
compares their deterministic responses to the stored responses before the
service answers; no partially reconstructed state is served. Local witness
publication is part of the same transaction, so replay never broadcasts
historical records to an external venue. External publication will need a
durable outbox and signer reservation before broadcast; a local transaction
cannot make a remote write atomic.

| Event | Preconditions | Durable effect | Receiver evidence |
| --- | --- | --- | --- |
| Register | Canonical root terms; valid obligor signature; declared operator and venue | Retain signed terms | Canonical terms and signature |
| Submit | Supported signed operation; correct nonce and authorization; lawful transition | Append operation and exact operator receipt | Receipt proves acceptance, not finality |
| Witness | Operator state is current; next venue index | Advance local index and retain the signed commitment | Directory, relevant log, receipt and witness record |
| Retry | Same identifier and canonical content | No new operation | Identical stored response |
| Restart | Compatible journal and signing key | Replay and compare every committed response | Same witnessed state and outstanding receipts |
| Failed transaction | Storage or validation failure | No accepted new command | No success response |

Keep the signing key and journal together. Never use the same key with another
journal, restore an old snapshot under an active key, or delete a WAL to repair
an instance. Transactions cannot fence separate database copies or detect
rollback after all processes restart. A production signer needs independent
rollback protection and a remote publication outbox. Tests cover process death,
not every filesystem or power-loss behavior. Backups must use SQLite's
supported consistent backup procedure.

## Verification

The verifier binds the payment to the expected backing, recipient, amount and
signed request; verifies the obligor signature, operator receipt, commitment
and directory; checks the relevant history's authorization and conservation;
and establishes inclusion at a witnessed index from the configured venue view.
Results are `pending`, `final`, `invalid` or `unavailable`. A signed but
unwitnessed acceptance is pending, and pending is not permission to deliver
goods. Missing or malformed evidence is `unavailable`, never final. Final
proves this transfer's inclusion in lawful, locally witnessed history — not a
current balance, and not freshness for a new purchase. A receiving application
must pin acceptable terms independently and durably associate each accepted
transfer with one invoice before fulfilling it; reusing valid historical
evidence must not buy a second delivery.

## Run a persistent instance

Build with `npm run build`, then run:

```sh
node scripts/pilot.mjs init scratch/my-pilot 8787
node scripts/pilot.mjs wallet scratch/issuer.json
node scripts/pilot.mjs wallet scratch/alice.json
node scripts/pilot.mjs wallet scratch/bob.json
node scripts/pilot.mjs terms scratch/my-pilot/wallet-client.json scratch/issuer.json scratch/terms.json
node scripts/pilot.mjs serve scratch/my-pilot
```

Leave the server running. In another terminal register the terms:

```sh
node scripts/pilot.mjs register scratch/my-pilot/admin-client.json scratch/terms.json
```

`wallet` prints the public key and stores the private key locally. Example terms
promise EUR 1.00 per claim. Review and independently pin the signed terms.
Create `scratch/issue.json`, substituting Alice's printed public key:

```json
{ "kind": "issue", "recipient": "ALICE_PUBLIC_KEY_HEX", "quantity": "100" }
```

```sh
node scripts/pilot.mjs sign scratch/my-pilot/wallet-client.json scratch/issuer.json scratch/terms.json scratch/issue.json scratch/issue-request.json
node scripts/pilot.mjs send scratch/my-pilot/wallet-client.json scratch/issue-request.json scratch/issue-reply.json
node scripts/pilot.mjs witness scratch/my-pilot/admin-client.json issue-1
```

For payment create `scratch/transfer.json`:

```json
{ "kind": "transfer", "to": "BOB_PUBLIC_KEY_HEX", "quantity": "40" }
```

```sh
node scripts/pilot.mjs sign scratch/my-pilot/wallet-client.json scratch/alice.json scratch/terms.json scratch/transfer.json scratch/payment-request.json
node scripts/pilot.mjs send scratch/my-pilot/wallet-client.json scratch/payment-request.json scratch/payment-reply.json
node scripts/pilot.mjs witness scratch/my-pilot/admin-client.json payment-1
node scripts/pilot.mjs verify scratch/my-pilot/wallet-client.json scratch/terms.json scratch/payment-request.json scratch/payment-reply.json BOB_PUBLIC_KEY_HEX 40
```

`sign` fetches the nonce and syncs a canonical signed request to a new file before
submission. If a response is lost, `send` the same request file; do not
regenerate it with a new nonce. Output files are created exclusively; retry
without a reply filename or choose a new filename. Serialize signing for each
wallet to avoid nonce collisions.

For redemption the holder signs a `demand` with quantity and witnessed
`instant`/`deadline`, the issuer signs `acceptance` of the canonical demand hash,
and the holder signs `release` after external performance. The demo exercises
this path. Release returns claims to the issuer; only burn lowers outstanding.

## Transport and authority

The CLI binds to `127.0.0.1`. Separate random bearer credentials authorize wallet
access and administration. Only administrators register the root or advance the
witness. Wallet credentials permit reads/submissions; signatures still authorize
each operation. Keep directories and credentials private; file modes are not a
substitute for Windows account permissions. Do not expose the service publicly.

Optional package subpaths: `pilot-wire`, `pilot-store`, `pilot-http`. The core
import does not load SQLite. Transport uses bounded canonical hex for signed
records and decimal strings for integers. JSON is only an envelope.
`POST /commands` accepts `register`, `submit`, `witness` with stable IDs;
`GET /nonce?backing=…&signer=…` and `GET /view?backing=…` provide signing context
and selected history. The directory authenticates the complete committed set.

## Acceptance milestone (met)

Run distinct wallet and service processes over a local transport. Issue,
transfer, witness and independently verify; interrupt execution before and
after durable commit, retry lost responses, restart with the same journal, then
redeem. Also exercise competing writers, mismatched command identifiers, wrong
signing keys, malformed requests and altered payment evidence. `npm run
check:pilot` runs this scenario; `test/pilot-store.test.ts` holds the
store-level cases.
