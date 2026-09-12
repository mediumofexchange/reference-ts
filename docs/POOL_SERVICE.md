# Pool service transport

This is a bounded Node 24 transport for the existing `PoolStore` v2 journal.
The service is configured locally with its pool configuration, verifier, venue,
operator key and opening inputs before it starts. The wire layer cannot upload
keys, alter protocol authority, force recovery or claim witness finality.

`POST /commands` accepts versioned JSON envelopes for `submit`, `commit` and
`publish`. Statements are canonical lowercase hex and may be up to the pool's
131072-byte proof bound plus framing. `submit` has no client command ID: the
statement hash is the durable identity. `commit` has a bounded command ID and
exact ID reuse returns the original commitment; a conflicting ID is rejected.
`publish` always retries the current durable outbox commitment.

Wallet credentials may submit and read `GET /view`. An admin credential may
commit and publish. The view intentionally contains only the highest signed
sequence and latest commitment; `evidence: "omitted"` means unavailable data,
never an empty evidence set. Complete authenticated evidence retrieval belongs
to the later v3 source and recovery work.

Bind the server to `127.0.0.1`; it also refuses non-loopback remote addresses.
The client accepts only an HTTP URL on literal `127.0.0.1`, with no credentials,
path prefix, query or fragment in the URL. It refuses redirects and encoded
responses, bounds response bytes, and aborts stalled requests. Errors expose
stable codes without storage/verifier messages. Existing `PoolStore` validation,
durability, fencing, replay and venue checks remain authoritative. A transport
receipt must still be verified against the caller's segment authority; decoded
bytes alone prove nothing. The client binds returned receipts to its submitted
domain and statement identity, but does not authenticate the operator or witness.
An authenticated receipt establishes acceptance, not finality or current balance.

## Bounds and status

Requests are at most 300,000 bytes, responses 65,536 bytes, and headers 8,192
bytes. The server permits 16 connections, 32 headers, a 10-second header timeout
and a 15-second request timeout. The client uses a 10-second request deadline.
Both sides reject malformed UTF-8 and unexpected fields. These are transport
limits, not proof-worker or whole-process quotas; proof validation and initial
journal replay retain their existing costs. Status uses the fenced `summary()`
method and does not construct proof histories on each poll.

The service accepts only these command shapes:

```json
{"version":1,"profile":"pool-store/v2","kind":"submit","statement":"<canonical statement hex>"}
{"version":1,"profile":"pool-store/v2","kind":"commit","id":"checkpoint-1"}
{"version":1,"profile":"pool-store/v2","kind":"publish"}
```

Submit decodes the existing v2 frame and compares its domain with the store's
configuration before admission. Exact retries retain the original receipt,
including when proof bytes change without changing statement identity. A client
must explicitly retry after a lost reply; it must preserve the original commit
ID. There is no automatic retry, signing timer or remote activation endpoint.

## Use and acceptance

Node 24 service modules are separate package subpaths, preserving the root API's
Node 20 floor. Configure and activate the store locally, then:

```ts
import { createPoolService } from "@mediumofexchange/reference/pool/service-http";
import { PoolServiceClient } from "@mediumofexchange/reference/pool/service-client";

const server = createPoolService(store, { walletToken, adminToken });
server.listen(9031, "127.0.0.1");
const client = new PoolServiceClient("http://127.0.0.1:9031/", walletToken, adminToken);
const status = await client.view(); // Explicitly omits history/evidence.
```

Use distinct locally generated 32-byte hex operation credentials. They grant
access to service operations; protocol signatures and proofs still authorize
admission. No signing secret or private note opening is accepted by the wire API.

Run `npm run build` and `npm run check:pool-service` for the separate-process
acceptance. It verifies a lost completed-commit response followed by an exact
retry, changed-proof receipt replay, seven rejected requests, fencing of the
still-running old process, graceful restart and retained sequence/publication
through a persistent SQLite journal. Focused tests additionally cover status
without proof-history copying, copied summary data, request-bound receipts,
response limits, redirects and an actually stalled HTTP connection.

This evidence uses public fixture keys, an ideal proof verifier and a known
restored local venue ledger. It does not establish real-proof transport at
deployment scale, abrupt process-crash recovery, external finality, private
delivery or a usable wallet. Existing proof and store-crash checks remain
separate. No protocol bytes, proof circuits or normative rules change here.
The [verification record](pool-service-verification.json) pins the checked source
and records the complete local check result and independent review limits.
