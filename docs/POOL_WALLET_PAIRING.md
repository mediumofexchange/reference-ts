# Local wallet credential and pairing profile

Status: selected after independent design review. This application profile
uses existing v2 private delivery and does not change protocol bytes or proofs.

The receiver stores a private TLS key and its self-signed certificate in the
wallet database. A bounded OpenSSL provisioning helper generates private keys
without writing a plaintext temporary key file. Standard TLS chain, hostname
and certificate validity checks remain enabled; clients also pin the exact leaf.
Certificate time is transport policy, never protocol time. Expired credentials
remain recoverable and rotatable; validity checks apply to provisioning and use.

An invitation binds the domain, immutable invoice (ID, backing, positive value,
owner), receiver credential generation, HTTPS endpoint, capability and certificate
in bounded canonical JSON. Its full SHA-256 digest must be obtained independently
from the intended receiver, for example by scanning its displayed digest. The
invitation must travel privately because it contains a bearer capability. A
digest supplied beside untrusted invitation bytes does not authenticate them.
This profile supplies enrollment APIs; camera UI and remote discovery are outside
its acceptance. It does not establish a civil identity.

The payer compares the independently obtained digest and expected invoice terms
before persisting the invitation under a caller-selected local alias. Exact
reimport is idempotent. Updates preserve the domain and invoice, require a newer
generation, a newly authenticated digest and compare-and-swap of the previous
digest. Payment code reads the durable binding and checks the complete request
against the output before making a network connection.
Ordinary payment operation assigns one command to that alias. Enrollment refuses
another alias for the same receiver owner in the domain; new preparation also
refuses ambiguous historical aliases or another pending output to that owner.
Already-saved exact payment retries remain available.

Credential rotation compares the stored generation, atomically installs a fresh
key/certificate and revokes existing capabilities. A receiver process is fenced
to its credential generation, including inside the inbox write transaction;
streaming across rotation cannot commit with either old credentials or an old
server instance. Restart reuses the same private credentials and endpoint.
Changing endpoint also requires a new generation and authenticated enrollment.
Rotation never changes the invoice, its received evidence or fulfillment record.
Pairing and inbox acknowledgments never authorize fulfillment. Invitation
creation snapshots credentials, invoice and capability in one transaction.
The server binding includes the actual certificate digest as well as generation.
Rotation requires a different public key. Payer sends recheck active custody and
the persisted pairing after the TLS handshake, before releasing application data.
Rotation cannot retract private data already sent on an authenticated connection.

Transport credentials and accepted pairings join the complete encrypted offline
snapshot. Seven-table historical snapshots restore with empty transport state;
new snapshots carry nine tables and require current binaries. Frozen/read-only
wallets cannot enroll, rotate or serve. The existing protected device storage,
independently retained latest recovery digest and single active restore
preconditions still apply. This adds no rollback detection or continuous backup.

Alternatives: public fixture credentials do not support privacy; Web PKI alone
does not bind invoice terms; first-contact trust does not authenticate a receiver;
a new signing identity/contact directory adds keys and lifecycle obligations.
An independently checked exact digest reuses the offline recovery trust pattern,
needs one local record per accepted invoice and requires fresh authentication
on rotation. It deliberately does not automate trust in a replacement key.

Acceptance must falsify wrong/stale/cross-invoice/cross-domain bindings, exact
certificate substitution, concurrent rotation and streamed requests, lost
rotation/import replies, independent handles, frozen readers and complete backup
restoration. The real two-wallet flow must preserve payment and public supply
verification with the new transport boundary. Independent design review required
the atomic server/invitation guards, fresh public keys, post-handshake custody
guards and expired-credential recovery. Independent actual-source review resolved
nonstring invoice IDs and self-issued certificate checks. The discriminating
pin regression first accepts a different leaf through ordinary TLS, then refuses
it through the paired client. No material review finding remains within this
local profile; execution results are pinned in [wallet evidence](pool-wallet-verification.json).

## Application integration

The receiver provisions `installDeliveryCredentials({key, cert}, 0n)`, starts
`createWalletDeliveryServer(receiver, receiver.deliveryCredentials())`, then
creates `deliveryInvitation(invoiceId, exactHttpsEndpoint)`. Deliver its bytes
privately; authenticate `walletPairingDigest(invitation)` on the independent
channel. Never derive the payer's trusted digest from the received invitation.

The payer calls `acceptPairing(localAlias, invitation, independentlyTrustedDigest,
expectedRequest)`. Before proof creation, read `decodeWalletPairing(pairing(alias))`
and compare its invoice with the intended output. After acceptance by the pool,
use `pairedDeliveryClient(alias).deliver(domain, delivery)`; it enforces the same
terms again before connecting. It cannot authenticate how the application
obtained its expected request or digest.

For rotation, retain the proposed new private credentials until the install
result is reconciled. Call `installDeliveryCredentials(newTls, priorGeneration)`;
an exact retry returns the already-installed generation. Read back the current
credentials and start the new server. New invitations require new independent
authentication. Payer updates also supply the previous accepted digest; exact
reimport is safe after a lost reply. Stop obsolete listeners for resource cleanup
even though their application writes are fenced. Backup restore retains this
state; it does not restore an OS listener, DNS or a reachable network endpoint.
