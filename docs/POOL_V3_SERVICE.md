# V3 local service

`src/pool/v3/service-http.ts` wraps an already locally activated
`V3OperatorJournal` on Node 24. Bind the returned server to `127.0.0.1`.
It also rejects non-loopback peers. Operator keys, activation, recovery and
venue configuration stay with the local journal owner. This is a guarded
reference service, with no public deployment or production configuration claim.

Created without an admin credential (`createV3Service(journal, { walletToken })`), the service serves holders only:
submission and evidence, with sixteen connections of its own. `moe operator serve --onion <host>` runs one beside the
operator's own for a Tor onion service, whose every peer is the loopback Tor daemon, so the loopback check no longer
keeps the network out there; the admin credential never reaches that listener ([M12a](../decisions/2026-10.md#2026-10-07--reach-an-operator-as-an-onion-service-through-the-holders-own-proxy-and-serve-holders-on-a-listener-of-their-own-slice-12-m12a)).

`createV3Service(journal, { walletToken, adminToken })` requires distinct random
32-byte credentials encoded as lowercase hex. Exactly one `Authorization:
Bearer …` header is required. The wallet credential permits submission and
evidence retrieval; the admin credential additionally permits commit and publish.
Credentials grant local operations, never protocol authorization or finality.

| Endpoint | Request | Reply |
|---|---|---|
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "submit", record }` | `kind: "accepted"`, exact signed receipt |
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "commit", id }` | `kind: "committed"`, signed commitment |
| `POST /commands` | `{ version: 1, profile: "pool-store/v3", kind: "publish" }` | `kind: "published"`, signed commitment |
| `GET /evidence` | `?backing=` with 64 lowercase hex digits naming a backing the served commitment carries, then `&after=` with the decimal sequence the reader's evidence was served through (0 for none) | a byte stream: selection metadata naming that backing, the read's own package, then the evidence parts served after that sequence |

Every successful command reply also carries version 1 and the same profile. Byte fields
are lowercase hex. Commit identifiers match `[A-Za-z0-9._:-]{1,128}`. Records,
receipts and packages keep the canonical bytes of the journal's construction:
pool-v3's, or lit-v1's for a lit scope. One profile serves both, since each of
them names its configuration domain
([M14g3](../decisions/2026-10.md#2026-10-07--serve-a-lit-journal-through-the-one-service-wire-and-client-the-construction-an-option-slice-14-m14g3)).
Kind-7 requests are not segment admissions. Unexpected fields, malformed UTF-8,
compressed bodies and oversized envelopes refuse. The transport signs no JSON
and adds no protocol bytes.

The client is `V3ServiceClient(baseUrl, walletToken, expected, adminToken?)` from
`service-client.ts`. `expected` independently supplies the operator, the
reference venue preimage and the construction (pool-v3's by default, or
`LIT`). The domain is that construction's configuration. Only an HTTP `127.0.0.1` root URL is
accepted. Identity inputs and submitted bytes are copied. These modules are
subpath APIs, not root exports.

`submit(record)` checks the receipt signature, expected domain/operator, source
segment, scope (a lit receipt names none, lit-v1 §5) and statement identity under
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

`sync(backing, evidence)` brings the party's own `EvidenceStore` up to the
journal's latest published commitment
([pool-v3 §14, incremental retrieval](https://github.com/mediumofexchange/money-from-first-principles/blob/8d48b25/pool-v3.md#14-replay-retention-and-resource-bounds)).
The store records the sequence this service's evidence was kept through, and
the request names it. The journal then serves, from its rows:
- the directory and snapshots of each checkpoint signed after that sequence,
  and what an opening in that range took, in whole §12 packages of about 1 MiB;
- for each segment those snapshots name, its trail as §10's head and the
  records after the position its checkpoints through that sequence reached.
  A segment new to the reader is served whole, and a trail already served that
  far is left out.

The client checks the pinned context and that the read's own package carries
the named commitment under the expected operator's signature, so a sequence
it records is one that operator signed. It keeps each part as it arrives.
A stated position authenticates nothing: the store looks it up in its own
rows and continues its own evidence recurrence. Where the parts do not
assemble over what the store holds, the client fetches everything once more
from nothing. `{ full: true }` asks for that outright, which a reader uses
when a read over its kept evidence is unresolved: a resupplied copy replaces
an object that storage damaged. The result is the selection and the read's
own package (the configuration and the selected commitment), to pass to
`readPackage` with that store.

`package(backing)` collects the same stream, served from nothing, into one
§12 package held in memory. It is for a caller that reads a whole package:
the checks, and tests. A wallet syncs its own evidence file instead,
`wallet.supply(evidence => client.sync(backing, evidence))`, and reads with
the returned package
([M5b.5c](../decisions/2026-09.md#2026-09-29--keep-replay-state-in-each-partys-sqlite-storage-committed-at-keep-points)).
Every response closes its connection: a caller's verification blocks its event
loop between requests, so an idle connection the server has timed out would
otherwise be reused before the caller sees it closed.
Both methods return untrusted bytes and metadata. They expose the journal's
published state and exclude its unpublished tail. The receiver calls
`V3Wallet.fulfill` with the package and independently held signed root terms,
configuration, verifier and venue. The venue supplies the judging index and
complete range answers. Server metadata cannot select those inputs. Missing or
changed evidence refuses fulfillment, and receipts alone cannot fulfill a
request. See the [receiver obligations](POOL_V3_WALLET.md) and
[package rule](https://github.com/mediumofexchange/money-from-first-principles/blob/786f962/pool-v3.md#12-evidence-packages-and-dependency-retention).

## Bounds and interrupted operations

Request envelopes are capped at 300,000 bytes and command replies at 4,096
bytes. Headers are capped at 8,192 bytes and 32 fields; connections at 16.
Served evidence is a binary stream with no total cap, since a history has no
size to cap (§14): one package part is at most 4 MiB, a trail is bounded per
record, and the journal holds one part or one record in memory at a time
([probe](POOL_DEPLOYMENT_PROBES.md#serving-by-stream-and-incrementally-m5b5b2)).
The client bounds one response by the caller's byte budget (64 GiB by default
for `sync`, 256 MiB for `package`), and the evidence store's own quota
bounds the parts of one sync together. These are local limits, not protocol
bounds.

The client aborts a command after ten seconds, and a served stream ten seconds
after its last chunk. The server closes a pending command response after
fifteen seconds measured from the request callback, after headers arrive. A
served stream is closed fifteen seconds after its last write, or once its peer
has taken less than 64 KB per second beyond the first fifteen seconds. At most
eight streams are served at once (`BUSY` otherwise), so slow readers leave
connections for commands. Node's header/request receive timeouts apply
separately. Serving holds no journal
operation: its rows are never changed, so commands run while a stream is read.
A stream that fails after its headers ends short of its end mark, which the
client refuses; the server emits `evidenceError` with the cause. A trail is
read forward by position (an index on its kept rows), one lookup and one check
per record, giving up the process's turn every 256 records, so its first record
needs no walk and commands are answered meanwhile. A fork kept beside the
served trail, or a resumed position with two kept values, falls back to one
walk back over its kept links (about 7.5 µs per record served, giving up the
turn each 4,096 links). `sync` takes no
overall deadline or abort signal yet. Losing a response does not
cancel or roll back journal work. Recover an uncertain submit or commit by its
exact saved statement or command ID. Reopening the journal fences older owners
and reads its state from rows without verifying a proof again; it refuses
stored state that does not reproduce its own tip and the last signed snapshot.
Operation failures expose bounded codes rather than internal error text.

## Acceptance and remaining work

The three `test/pool-v3-service-*.test.ts` files cover strict framing, roles,
duplicate authorization, signed reply/context binding, changed-proof retries,
mutation isolation, wrong context, transport limits and stalled client response.
`test/pool-v3-store.test.ts` runs the journal behind this service: a second
sync fetches only the new checkpoint's objects and the records after the
first, a read over the kept evidence equals a read of the whole package, and
a store that lacks what its recorded sequence implies is served again.
`test/lit-service.test.ts` runs a lit journal behind this service: the client
reads lit-v1's receipts and packages, refuses forged receipts and the other
construction's records, receipts and evidence, and a lit wallet pays, syncs
and is credited through it.
The server timeout followed by eventual journal completion has source review,
but no direct timed acceptance case.

`npm run check:pool:v3-service` runs separate server/receiver processes. It drops
a completed commit reply, retries exact signed bytes, restarts service, fences
the old owner and fulfills from a downloaded package against an independently
restored fixture venue. The receiver also keeps an evidence file across its
processes and syncs it after each publication. Withheld/altered evidence cannot fulfill; unpublished
records stay excluded. Proofs are synthetic in this process test.

The real-proof `scripts/pool/v3/store-check.mjs` also submits issue, four-output
payment and burn over HTTP, commits/publishes, fetches the package and verifies
receiver fulfillment independently. Its evidence is retained in the
[journal report](pool-v3-store-verification.json). The payment is prepared,
saved and submitted by the [v3 wallet](POOL_V3_WALLET.md); issue, burn and the
hostile cases are still prepared by the harness. Payment requests pass between
wallets, not through this service. The encrypted handoff (`moe wallet handoff`,
`restore`) is drilled; qualified backup and restore drills remain open. No live
service or physical custody is qualified.
