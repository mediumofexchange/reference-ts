# V3 local service

`src/pool/v3/service-http.ts` wraps an already locally activated
`V3OperatorJournal` on Node 24. Bind the returned server to `127.0.0.1`.
It also rejects non-loopback peers. Operator keys, activation, recovery and
venue configuration stay with the local journal owner. This is a guarded
reference service, with no public deployment or production configuration claim.

`createV3Service(journal, { walletToken, adminToken })` requires distinct random
32-byte credentials encoded as lowercase hex. Exactly one `Authorization:
Bearer …` header is required. The wallet credential permits submission and
package retrieval; the admin credential additionally permits commit and publish.
Credentials grant local operations, never protocol authorization or finality.

| Endpoint | Request | Reply |
|---|---|---|
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "submit", record }` | `kind: "accepted"`, exact signed receipt |
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "commit", id }` | `kind: "committed"`, signed commitment |
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "publish" }` | `kind: "published"`, signed commitment |
| `GET /package` | No parameters | `kind: "package"`, selection metadata and evidence bytes |

Every successful reply also carries version 1 and the same profile. Byte fields
are lowercase hex. Commit identifiers match `[A-Za-z0-9._:-]{1,128}`. Records
retain their canonical v3 encoding; segment-free kind-7 requests are not segment
admissions. Unexpected fields, malformed UTF-8, compressed bodies and oversized
envelopes refuse. The transport signs no JSON and adds no protocol bytes.

The client is `V3ServiceClient(baseUrl, walletToken, expected, adminToken?)` from
`service-client.ts`. `expected` independently supplies the configuration domain,
operator and reference venue preimage. Only an HTTP `127.0.0.1` root URL is
accepted. Identity inputs and submitted bytes are copied. These modules are
subpath APIs, not root exports; the wire/client modules can load on Node 20.

`submit(record)` checks the receipt signature, expected domain/operator, source
segment, scope and statement identity under
[pool-v3 §7.2](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#72-receipts-bind-the-exact-event-evidence).
An exact statement retry can supply a different valid proof and still receives
the original receipt. Its proof digest need not equal the retry's proof digest.
Adoption into another segment requires additional evidence; this ordinary-submit
client refuses that receipt mismatch. Adoption receipt lookup is outside this API.

`commit(id)` retries the saved command result. `publish()` targets the latest
outbox, so an intervening commit can change what a publication retry publishes.
Both client methods authenticate the expected operator's commitment signature;
neither establishes witnessing, inclusion or current spendability. Commit IDs
are local journal keys, not fields in the signed commitment.

`package(backing)` checks framing and pinned context, then returns untrusted
bytes and metadata. It exposes the journal's published package and excludes
its unpublished tail. The receiver calls `V3Wallet.fulfill` with the
bytes and independently held signed root terms, configuration, verifier and
venue. The venue supplies the judging index and complete range answers. Server
metadata cannot select those inputs. Missing or changed evidence refuses
fulfillment, and receipts alone cannot fulfill a request. See the
[receiver obligations](POOL_V3_WALLET.md) and
[package rule](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#12-evidence-packages-and-dependency-retention).

## Bounds and interrupted operations

Request envelopes are capped at 300,000 bytes, command replies at 4,096 bytes,
and package replies at 2,100,000 bytes for up to 1 MiB of binary evidence.
Headers are capped at 8,192 bytes and 32 fields; connections at 16. Hex transport
roughly doubles evidence bytes and buffers a complete package. These are local
limits, not a streaming or lifetime scalability claim.

The client aborts after ten seconds. The server closes a pending response after
fifteen seconds measured from the request callback, after headers arrive; Node's
header/request receive timeouts apply separately. Losing a response does not
cancel or roll back journal work. Recover an uncertain submit or commit by its
exact saved statement or command ID. Reopening the journal fences older owners;
operation failures expose bounded codes rather than internal error text.

## Acceptance and remaining work

The three `test/pool-v3-service-*.test.ts` files cover strict framing, roles,
duplicate authorization, signed reply/context binding, changed-proof retries,
mutation isolation, wrong context, transport limits and stalled client response.
The server timeout followed by eventual journal completion has source review,
but no direct timed acceptance case.

`npm run check:pool:v3-service` runs separate server/receiver processes. It drops
a completed commit reply, retries exact signed bytes, restarts service, fences
the old owner and fulfills from a downloaded package against an independently
restored fixture venue. Withheld/altered evidence cannot fulfill; unpublished
records stay excluded. Proofs are synthetic in this process test.

The real-proof `scripts/pool/v3/store-check.mjs` also submits issue, four-output
payment and burn over HTTP, commits/publishes, fetches the package and verifies
receiver fulfillment independently. Its evidence is retained in the
[journal report](pool-v3-store-verification.json). The payment is prepared,
saved and submitted by the [v3 wallet](POOL_V3_WALLET.md); issue, burn and the
hostile cases are still prepared by the harness. Payment requests pass between
wallets, not through this service. Restoration drills and encrypted backup remain
open. V2 checks stay until their remaining wallet
and service cases pass on v3. No live service or physical custody is qualified.
