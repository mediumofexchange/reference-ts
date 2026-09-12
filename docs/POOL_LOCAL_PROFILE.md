# Caller-configured local pool

Status: implementation profile under pool-v2 sections 2, 3, 6, 7 and 9.
No normative bytes change. Independent design/source review is closed with no
unresolved material finding. The full regression suite and configured real-proof
flow passed; [verification](pool-local-verification.json) pins the evidence.

The smallest configured flow accepts one signed constant-payout backing without
reliance or silence/non-service clauses, in its initial single-backing segment.
The caller supplies canonical backing bytes, its obligor signature and canonical
segment header in a bounded public JSON profile. The header must have sequence
one, no imports, and the original operator/link declared by the backing. Existing
decoders, signature verification and PoolAuthorityView validate these claims.
The configuration is the repository's pinned real v2 manifest; the file cannot
select code, a verifier, a key or an ideal-proof mode.

The caller independently retains the SHA-256 digest of the exact profile file.
Every command checks it before opening a wallet or operator journal. The digest
authenticates the chosen local settings, not checkpoint finality or an issuer's
creditworthiness. Merely hashing a downloaded profile is not authentication.
Wallet persistence continues to bind the exact segment authority. Profile files
contain no secrets or credentials; holder credentials arrive separately on stdin.
The configured holder entry point shares ordinary operation code with fixture
commands but cannot issue. The fixture issuer retains its own separate module.

The operator uses the same validated profile and caller-held operator secret and
distinct local operation credentials. Operator setup checks its public key before
opening storage, activates the exact initial scope and retains the existing
journal, fencing, submission and publication rules. No key generation, issuance
authority or network enrollment endpoint is added. Locally restored venue records
and serialized public evidence remain explicit trusted-local inputs; they are
not an external witness, a network evidence format or current-state attestation.

Alternatives: an executable configuration module executes untrusted code;
accepting arbitrary circuit identities cannot establish which verifier is being
used; embedding signing keys in a holder profile repeats fixture custody;
supporting replacement/imports adds authority discovery before its evidence
source is qualified. Reusing one operation implementation avoids a second payment
path. The fixed initial profile has no additional protocol storage or proof cost.
Its file authentication adds one bounded hash and existing canonical validation.

Acceptance uses fresh non-fixture issuer/operator keys, caller-supplied terms and
pinned real proofs. A separately configured operator admits funding prepared by
the test issuer; holder processes receive, verify, pay 7 from 4 + 6, record change
3 and spend that change. Changed digests, signatures, authority/configuration,
unsupported terms, issuer commands and wrong operator keys must fail before
journal creation. Existing journal/profile mismatch refuses before fencing or
signing, inside the ownership transaction. Every retained opening must match,
and activation compares the prepared header before signing. SQLite file access
and pragmas are not a promise of a byte-identical filesystem on refusal.
Exact saved payment retry remains possible without evidence
or compiled artifacts. Public replay independently checks supply.

Protected local files, independent profile/invitation authentication, a complete
current venue ledger and one active wallet remain preconditions. This does not
close device custody, continuous recovery, replacement, external publication,
redemption or live deployment gates.

## Local operation

Build with `npm run build`. Run `npm run check:pool-local-profile` for malformed
profile/path checks and `npm run check:pool-local-real` for the complete configured
flow with freshly generated test keys, pinned proofs and separate public audit.
The real check compiles its own artifacts under ignored scratch and removes its
owned files after all workers exit. It does not publish to an external venue.

Create the public profile with `encodeLocalProfile(signedTerms, initialHeader)`
from `scripts/pool/local/profile.mjs`. It returns exact JSON in this field order:

```json
{"version":1,"profile":"pool-local/v2","backing":"<canonical backing hex>","signature":"<128 hex>","header":"<canonical segment header hex>"}
```

Retain its exact digest through an independently trusted channel, together with
the terms it identifies. The encoder packages existing caller-held signed terms;
it does not create issuer credentials. Compiled artifacts for the commands below
can be prepared with `node scripts/pool/compile.mjs scratch/pool-build` after
`node scripts/pool/prepare-crs.mjs`.

```sh
node scripts/pool/local/operator.mjs DATABASE PROFILE DIGEST LEDGER EVIDENCE COMPILED [PORT]
node scripts/pool/local/holder.mjs MODE DATABASE PROFILE DIGEST SERVICE_URL EVIDENCE LEDGER [COMPILED]
node scripts/pool/local/receiver.mjs DATABASE PROFILE DIGEST REQUEST_ID [PORT]
```

The operator reads `{ "operatorSecret": "<64 hex>", "walletToken": "<64 hex>",
"adminToken": "<different 64 hex>" }` on stdin, starts on literal loopback and
prints `MOE_LOCAL_READY` with its service URL. It requires an existing complete
local JSON ledger; `[]` is appropriate only for a genuinely new local operator
identity. Never reuse a signing key with an erased journal. Checkpoint and
publication commands use the existing `PoolServiceClient` with the admin token.
On publication it saves public evidence for holder reads. Normal stop uses
SIGINT/SIGTERM; the acceptance supervisor also uses parent-owned IPC.

Holder stdin is `{ "walletToken": "<64 hex>", "command": { ... } }`. Modes and
inner command fields are those in [ordinary operation](POOL_WALLET_OPERATION.md):
`request`, `enroll`, `prepare`, `submit`, `deliver`, `receive`, `change`, `status`.
The configured command cannot issue or record fixture issuance. A separate issuer
submits authorized issuance and privately delivers the opening to an existing
holder invoice; the holder uses `receive` to independently verify and record it.
Only new proof/evidence work requires `COMPILED`; exact prepared retries and
historical fulfillment reconciliation remain available without those artifacts.

After creating an invoice, the receiver command installs private TLS credentials
if needed, serves that invoice and prints its private invitation, digest and
bound port. Keep that output private. The printed digest alone is not a payer's
trust anchor; authenticate it independently. Restart on the same port preserves
the endpoint and saved credentials. The optional sixth argument is the expected
current credential generation:

```sh
node scripts/pool/local/receiver.mjs DATABASE PROFILE DIGEST REQUEST_ID PORT EXPECTED_GENERATION
```

It compares the saved generation, installs a fresh private TLS key/certificate
and revokes all old invoice capabilities using the existing atomic rotation API.
The result includes the saved generation as a decimal string. Stop the obsolete
listener and restart on the same port; independently authenticate the new private
invitation. Payer `enroll` updates also require the previous accepted digest.
Saved statements and receipts survive rotation and exact payment retry.

Rotation commits before the listener opens. If the port is occupied or the ready
reply is lost, restart **without** `EXPECTED_GENERATION` and inspect the emitted
generation/invitation. Repeating the old expected generation refuses and cannot
rotate twice. This command generates credentials internally; its recovery is
readback/restart, while exact installation retry with retained credentials remains
available through the underlying API. No protocol or custody format changes.

Operator inputs/outputs must be distinct by filesystem identity, including
Windows case aliases, hard links and SQLite sidecars. Files and their parent
directories must be protected from concurrent path substitution. Ledger/evidence
writes flush a complete temporary file before replacement. This preserves the
old file if writing the replacement fails, but does not establish directory
durability, hostile rollback prevention or device-loss recovery. A local ledger
has a 100,000-commitment cap; beyond it publication refuses with its durable
outbox pending, while existing records remain readable and restartable. This is
an explicit local capacity limit, not an automatic venue migration mechanism.

## Encrypted offline handoff

Stop receiver listeners and quiesce all holder workflows before export. On a
protected local device, use a separately generated random 32-byte recovery key;
retain that key separately from the encrypted file. Keep the profile digest and
the latest exact export digest in an independently trusted recovery record.

```sh
node scripts/pool/local/custody.mjs export DATABASE PROFILE PROFILE_DIGEST BACKUP
node scripts/pool/local/custody.mjs restore NEW_DATABASE PROFILE PROFILE_DIGEST BACKUP
node scripts/pool/local/custody.mjs inspect DATABASE PROFILE PROFILE_DIGEST
```

Export stdin is `{ "key": "<64 lowercase hex>" }`; restore stdin adds
`"digest": "<independently retained export digest>"`. Keys never belong in
arguments or logs. Inspection requires no secret input and prints `frozen` and,
for a completed restore, `restoredFrom`. The source and inspection database must
already exist. Profile authentication and file-identity checks precede wallet
access. Restore requires a fresh destination and no SQLite sidecars; it never
overwrites or merges an existing wallet. No proof artifacts or operator service
are needed for these commands.

Export atomically freezes the source and retains the existing encrypted nine-table
snapshot before writing and flushing the output file. The source stays frozen
even if copying fails. A lost successful reply can be retried with the same key
and path, returning identical bytes/digest. An existing different or partial
output is preserved and refused; copy the frozen export to a fresh output path
and retain its same digest. This produces another encrypted file, not another
active wallet. File flush/readback is not a directory durability guarantee.

Restore retains requests, counters, pending payments, reservations, receipts,
inbox and fulfillment records, private transport credentials and accepted
pairings. After a lost restore reply, inspect the **same** destination and compare
`restoredFrom` with the independently retained digest. Do not blindly retry to
another destination. An absent/mismatching digest is unresolved recovery, not
permission to replace an existing wallet. Activate only one restored wallet;
never resume an older offline export after subsequent wallet activity.

Configured real-proof acceptance freezes/restores both wallets after delivery
of the first payment and before its checkpoint, reconciles the exact saved
statement/receipt/inbox, rotates receiver credentials, rejects stale delivery,
authenticates the new invitation, then verifies and spends change 3. Hostile
checks cover wrong profile/key/digest, altered ciphertext, existing files,
hard links, SQLite sidecars, partial export recovery and secret-free parse errors.
Protected device storage, independently authenticated digests and one active
copy remain preconditions. This is offline handoff, not continuous backup or
device-loss recovery.

The [device custody profile](POOL_WALLET_DEVICE.md) selects a Windows storage
boundary, current recovery-record procedure and target qualification drills.
Its read-only preflight reports partial observations; it never qualifies a device
or authorizes restore. Physical provisioning and continuous recovery remain open.
