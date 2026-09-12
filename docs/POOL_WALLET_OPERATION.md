# Local wallet operation

Status: selected after independent design review under pool-v2 sections 3, 4,
7.2 and 9. Implementation review and execution evidence remain required.
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
and canonically framed change amount. Ordinary invoices cannot use its reserved
`change_` namespace. A preexisting inbox, fulfillment or delivery capability at
that ID refuses reuse, including in historical wallets.
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
