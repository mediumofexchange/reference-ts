# Local wallet operation

Status: implemented local profile under pool-v2 sections 3, 4, 7.2 and 9.
Independent design and source review cover the guards below. Current execution
evidence is retained in [wallet verification](pool-wallet-verification.json).
This keeps the pinned protocol, circuits, derivation and nine-table custody format.

The local command flow creates a caller-selected positive invoice, authenticates
its invitation with the existing independently trusted digest and exact terms,
prepares a payment, submits its durable bytes, delivers privately, and separately
verifies and records receipt. One accepted pairing alias is one payment command:
pairing updates already preserve its invoice. A retry uses that alias's saved
statement and checks its output against the durable invoice before any send.
It does not select new inputs or generate another proof after preparation.
Enrollment refuses another alias for the same receiver owner in the domain.
New preparation also refuses ambiguous legacy aliases or another prepared output
to that owner. Existing exact saved-command retries remain available.
Existing aliases can authenticate credential rotation without creating another
invoice, including historical duplicate aliases; new preparation stays refused.

Candidates are existing fulfilled notes, including separately verified change.
Read one exact checkpoint once and match each opening and owner against its saved
request. Report absent, spent, unspent and local reservation separately; missing
or invalid checkpoint evidence never becomes a zero balance. Results describe
the selected historical checkpoint, not latest spendability. A local reservation
remains excluded even if an older checkpoint reports unspent.

Select within one backing and one segment with no imports. Prefer the smallest
single available note covering the amount; otherwise the least-total pair that
covers it with u64 change, breaking ties by request ID. Sort real inputs by
nullifier before derivation. Reconstruct paths only from verified local events,
with deterministic padding for one input and a zero-valued second output for
exact payment. More than two required inputs is an explicit unsupported funding
shape, not evidence of a zero balance. Automatic consolidation is deferred.

A change request uses a deterministic local ID derived from the pairing alias
and canonically framed change amount. New ordinary invoices cannot use its reserved
`change_` namespace. A preexisting inbox, fulfillment or delivery capability at
that ID or another prepared output to its owner refuses reuse, including in
historical wallets. The final reservation transaction rechecks the same guards
and exact change request after proof creation.
Existing historical request IDs in that namespace still support exact API
replay and reject changed terms; the new command interface reserves the prefix.
Its positive amount and secret persist before proving. A proof failure may leave
an unused request; it never reserves inputs. Retry reuses that exact request;
changed selection with different change uses a distinct internal request under
the same alias. After proving, the existing prepare transaction reserves both nullifiers
and commits both outputs and the exact proof. A concurrent winner can make this
preparation fail; no reservation is silently released. Zero change needs no
positive request and is never counted as a holding.

Status and selection replay public history locally without per-note queries.
The current simple selector may examine all note pairs; bounded deployment
storage, replay and large-wallet costs remain unqualified. Receiver fulfillment
and change recording reuse existing evidence verification and lost-reply
reconciliation. No extra delivery acknowledgment grants fulfillment.

Alternatives: caller-chosen note IDs leave selection to fixture knowledge;
another inventory or operation table duplicates existing durable records and
expands backup compatibility; implicit retries with newly selected inputs can
pay twice. This profile deliberately keeps one immutable payment per alias.
Qualified device custody, human pairing, current external witness evidence,
continuous recovery and actual payout remain separate product gates.

Acceptance: arbitrary positive invoice terms; single-input change and exact
payment; two-input selection; insufficient two-note capacity; wrong backing,
missing/invalid evidence, reserved and spent inputs; changed invoice retries;
concurrent preparation and freeze during proof work; restart, private delivery,
verified receipt/change and a subsequent payment using that change. Exercise
the shared payment builder with pinned real proofs and public supply replay.

## Local developer commands

For caller-held signed terms, independently pinned settings and holder commands
without fixture issuance, use the [configured local profile](POOL_LOCAL_PROFILE.md).
The commands below remain the public-key acceptance fixtures; both use the same
ordinary payment operation implementation.

Build with `npm run build`, then invoke:

```sh
node scripts/pool/wallet/commands.mjs MODE DATABASE SERVICE_URL EVIDENCE_FILE LEDGER_FILE [COMPILED_DIRECTORY]
```

Supply one JSON object on stdin (maximum 64 KiB). The service/profile/venue
ledger are the existing local fixtures with public obligor keys. A compiled
directory selects the pinned real v2 prover/verifier. Evidence files use trusted
local serialization; they are not a network format or an authenticated venue.

| Mode | JSON input and result |
|---|---|
| `request` | `{"id":"order17","value":"7"}` creates an invoice for the fixture backing and returns its canonical public request string. |
| `enroll` | `alias`, private `invitation` string, independently authenticated `trustedDigest`, and canonical `expectedRequest` string. Rotation also supplies `previousDigest`. |
| `prepare` | `{"alias":"payment17"}` selects verified inputs and saves the complete payment. An exact saved retry requires neither evidence files nor the prover. |
| `submit` | `{"alias":"payment17"}` retries the exact saved statement; `accepted` means an authenticated receipt, not finality. |
| `deliver` | Same alias sends its accepted private opening over the paired HTTPS endpoint. `stored` is an inbox acknowledgment. |
| `receive` | `{"id":"order17"}` checks and records the inbox payment; exact retries reconcile its saved historical fulfillment. |
| `change` | Payment alias verifies and records positive payer change; zero change returns `none`. |
| `status` | `{}` returns checkpoint-scoped note states and local reservations, without secrets/openings. |
| `issue`, `record-issued` | Fixture funding only: issue accepts positive `id`/`value`, record accepts `id` and independently verifies the received issuance. |

Evidence-reading commands accept an optional `checkpoint` encoded commitment;
otherwise they use the bundle's selected checkpoint. Missing history reports
`unavailable`; invalid evidence reports `invalid`; an absent delivery or unknown
command is an explicit command error. A first receive/change/issuance record
requires unspentness; reconciliation reports historical fulfillment and never
rechecks it as a new credit. Status separately checks later spentness.

Use the existing credential/invitation APIs from the pairing profile to serve
and invite arbitrary invoices. The acceptance models digest authentication with
a receiver object held by its parent and uses fresh command processes for every
operation. It funds 4 and 6, pays 7, records change 3, then spends that change in
an exact second payment. `npm run check:pool-wallet-real` repeats this with pinned
proofs and a separate public audit after the original recovery/burn flow.
