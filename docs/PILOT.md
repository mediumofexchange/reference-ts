# Durable local payment pilot

This pilot makes the transparent payment path runnable across separate wallet
and service processes. One operator serves one signed root backing with a
constant payout in an external thing. Supported signed operations are issue,
transfer, burn, demand, acceptance, release and withdrawal.

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

## Trust and limits

The service hosts both the operator and the local witness. A receiver checks
signatures, authorization, lawful history and exact inclusion independently of
the operator's balance claims, but trusts the configured witness endpoint for
record completeness and order. This demonstrates recovery from process crashes
on trusted local storage. It does not recover against a hostile operator or
prove EUR delivery. Issuer creditworthiness remains outside software evidence.

Replacement, silence, non-service, cross-backing and privacy paths are excluded
from this profile. The wider reference library retains its experimental paths.
The journal permits 10,000 commands; startup replays and compares every response.
Existing command IDs remain retryable at the limit. Growth is deliberately
bounded, with no pruning or migration. Never empty a journal and reuse its key.

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
submission. If a response is lost, `send` the same request file. Do not regenerate
it with a new nonce. Output files are created exclusively; retry without a reply
filename or choose a new filename. Serialize signing for each wallet to avoid
nonce collisions.

The receiver supplies its own expected terms, key and amount to `verify`.
Results are `pending`, `final`, `invalid` or `unavailable`. Pending is not
permission to deliver goods. Final proves this transfer's inclusion in lawful
locally witnessed history, not a current balance or freshness for a new purchase.
A receiving application must durably deduplicate transfers and associate them
with invoices before fulfillment. This CLI checks evidence; it is not a checkout
application.

For redemption the holder signs a `demand` with quantity and witnessed
`instant`/`deadline`, the issuer signs `acceptance` of the canonical demand hash,
and the holder signs `release` after external performance. The demo exercises
this path. Release returns claims to the issuer; only burn lowers outstanding.

## Storage and authority

`PilotStore` uses SQLite WAL with FULL synchronization and verifies those actual
settings. The profile, operator key and venue are bound to the journal.
`BEGIN IMMEDIATE` serializes writers; transactions catch up with other writers
before signing. Commands and exact responses commit together before exposure.
Failures discard speculative memory. The local witness record is reconstructed
inside the same transaction; replay has no remote publication effects.

Keep the signing key and journal together. Never use the same key with another
journal, restore an old snapshot under an active key, or delete a WAL to repair
an instance. Transactions cannot fence separate database copies or detect
rollback after all processes restart. A production signer needs independent
rollback protection and a remote publication outbox. Tests cover process death,
not every filesystem or power-loss behavior. Backups must use SQLite's supported
consistent backup procedure.

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

Profile: `transparent-pilot/v0-directory-v1`. Commitment signatures use
`moe/commitment/v2`; roots hash version-1 `MOED` directories. Earlier experimental
commitment signatures are incompatible and have no automatic migration.
The companion spec branch is `spec/durable-transparent-pilot`; its exact revision
is pinned in the README.
