# Implementation status and specification revisions

Current implementation evidence and version boundaries. For an introduction and
source setup, see the [README](../README.md). For the next development task,
see [WORK.md](../WORK.md). Update this guide when a component or its specification
pin changes; dated decisions retain the reasoning behind those changes.

**Experimental; the API and wire format can change.** Source is the supported
way to try the implementation. There is no published npm release, no
deployment, and no completed security audit.

The active implementation is the shielded pool in `src/pool/`: pinned v2
circuits and proofs, private notes, public supply replay, record-derived
authority and canonical history, receipt readers, and durable sequencing.
The [local service/client transport](POOL_SERVICE.md) exposes durable submission,
commitment and publication retry, with separate-process lost-response, fencing
and restart evidence. The [local wallet fixture](POOL_WALLET.md) retains receiver
requests, pending payments, private HTTPS inbox deliveries and verified local
fulfillment through restarts. Scoped durable capabilities and exact retry protect
inbox admission; checkpoint verification remains separate from acknowledgment.
The same flow uses pinned real v2 proofs with a separate public supply audit;
abrupt wallet-process tests cover eleven transaction boundaries. Encrypted offline
exports freeze the source and retain complete state and reservations; fresh
restores require the exact independently retained digest and record provenance.
Protected device storage and one active restore remain explicit preconditions.
Private TLS credentials and digest-authenticated invoice bindings now persist
with the wallet; rotation revokes capabilities and fences obsolete servers.
Independent digest authentication is modeled locally; a user authentication
channel and external venue remain unqualified. Receiver note checks distinguish spent/unspent at an exact
verified checkpoint; saved fulfillment lookup recovers historical records.
The [ordinary local operation](POOL_WALLET_OPERATION.md) accepts caller-selected
invoices, selects up to two verified unreserved notes, persists one payment per
authenticated alias and spends verified change in another payment. Both CLIs
share its builder. Historical status, reservations and fulfillment remain
distinct; imported-note selection and automatic consolidation remain open.
The [caller-configured local profile](POOL_LOCAL_PROFILE.md) supplies authenticated
signed terms and initial authority to holder, receiver and operator commands,
using the pinned real verifier. Holder processes have no fixture issuance keys.
Configured encrypted offline handoff freezes and restores both wallets with
independently retained profile/recovery digests; exact payment retry and receiver
credential rotation continue into another verified payment. No custody schema
or protocol bytes change; one active copy remains a precondition.
The [device custody profile](POOL_WALLET_DEVICE.md) selects Windows protected
storage and a manual current recovery record. Its read-only preflight refuses
adverse/unknown observations and never qualifies a device. Provisioned target
hardware, physical failure drills and continuous recovery remain open.
An exact segment constraint prevents another profile from fencing an existing
operator journal or signing another scope. Local ledger authentication, device
custody and continuous recovery remain deployment preconditions and open work.
Silence recovery is modeled but not implemented in the
runtime; usable wallet custody and an external witness write adapter remain open.

The frozen transparent implementation and its local pilot remain adversarial
and integration evidence. The duplicate private-payment experiment is retired;
its active case map and immutable historical report are in the architecture guide.

Use [the architecture map](PRIVATE_PAYMENT_ARCHITECTURE.md) for component
boundaries and retirement conditions, [production requirements](PRODUCTION_REQUIREMENTS.md)
for release gates, and [fault recovery](POOL_FAULT_RECOVERY.md) for the
selected rules and model limits of the companion's
[fault contract](https://github.com/mediumofexchange/money-from-first-principles/blob/23af0f5/pool-fault.md).
## Proof and deployment probes

`npm run check:pool` exercises the
pinned real circuits and multi-segment replay separately from the ordinary
test suite. With Node 24, `npm run check:pool:delivery` exercises the
[successor delivery/restoration probes](POOL_DEPLOYMENT_PROBES.md#delivery-and-seed-restoration):
seed-encrypted capsules, fresh-process recovery over synthetic public data,
real proof binding, and [candidate restoration from exact signed local evidence](POOL_DEPLOYMENT_PROBES.md#restoration-from-exact-local-evidence).
The latter authenticates local record bytes and refuses stale or substituted
packages against an independent fixture selection; all candidates remain
unspendable without full replay, authenticated ranges and certified paths.
The [conditional initial-segment replay](POOL_DEPLOYMENT_PROBES.md#conditional-initial-segment-replay)
adds real successor proof/signature checks, replayed roots/totals and local note
paths, with a fresh seedless audit process. It checks candidate configuration
and all six artifact identities plus canonical signed root terms under
[pool-v3 §11](https://github.com/mediumofexchange/money-from-first-principles/blob/916bffb/pool-v3.md#11-configuration-and-backing-evidence-before-adoption).
Adoption, terms force, complete current ranges, imports and recovery remain open.
`npm run check:pool:fees` compares the successor
[transfer shapes and ordinary fees](POOL_DEPLOYMENT_PROBES.md#transfer-shape-and-ordinary-fees)
with real proofs. These probes do not implement a pool wallet or v3 finality.
`npm run check:pool:spent` verifies the successor's
[canonical compressed spent-set candidate](POOL_DEPLOYMENT_PROBES.md#spent-set-replay)
against independent batch roots and hostile keys; `npm run bench:pool:spent`
compares per-insert replay cost with pinned v2. It is outside the runtime.

The [Ergo full-block probe](POOL_DEPLOYMENT_PROBES.md#full-block-commitment-feasibility)
reproduces real transaction roots and retains serializer counterexamples.
The [binary decoder corpus](POOL_DEPLOYMENT_PROBES.md#full-binary-decoder-feasibility)
recovers all 65 fixture outputs and exposes permissive parsing, with strict
round-trip rejection controls. Hard memory containment, supported node
equivalence and authenticated complete-range reads remain unimplemented.

## Successor record conformance

`model/pool-v3-records.ts` implements the successor's reviewed
[canonical record layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/ca727f6/pool-v3.md#5-canonical-statement-records).
`npm test` checks exact bytes, hostile parsing, delivery association and
signature-message binding. This codec is not exported or used for admission;
approved v3 configuration, finality and adoption remain undefined.
`model/pool-v3-commitments.ts` adds the reviewed history/evidence chains,
snapshot and receipt frames from [pool-v3 §7](https://github.com/mediumofexchange/money-from-first-principles/blob/4a58fdc/pool-v3.md#7-history-evidence-snapshots-and-receipts).
Its tests distinguish authenticated failing evidence from substituted bytes
using real signatures. Authentication alone supplies no checkpoint verdict.
`model/pool-v3-headers.ts` implements [v3 segment headers](https://github.com/mediumofexchange/money-from-first-principles/blob/061f87e/pool-v3.md#8-segment-headers)
with canonical scope/opening references and bounded strict decoding. Its
signed-directory and hostile-byte tests establish header conformance; complete
opening evidence, complete certificate formats and runtime adoption remain open.
`model/pool-v3-fault-evidence.ts` adds the [portable fault-evidence record](https://github.com/mediumofexchange/money-from-first-principles/blob/322bcae/pool-v3.md#9-fault-evidence-records):
exact raw target bytes and an evidence suffix, checked against an externally
authenticated snapshot with an explicit reader budget. Successful evidence
authentication is not an exclusion verdict or a complete served trail.
`model/pool-v3-trail.ts` implements [served-trail transport](https://github.com/mediumofexchange/money-from-first-principles/blob/7ea0ee8/pool-v3.md#10-served-trail-transport)
with explicit byte/event budgets and raw inner-byte retention. Its local
evidence helper authenticates the header and ordered event evidence against
an expected signed-directory snapshot, including capsule association for
decodable records. It does not authenticate scoped terms, replay history or
imports, resolve record ranges/adoption or establish a complete opening.
Opaque terms still require their own decoding, name/signature and force checks.

## Runtime pin and recovery models

The runtime follows specification revision
[`3676757a1c8ddc0df607352c6bddbb48f6d85a09`](https://github.com/mediumofexchange/money-from-first-principles/tree/3676757a1c8ddc0df607352c6bddbb48f6d85a09),
whose `pool-v2.md` pins the construction bit for bit and records the
implemented circuits and keys. `docs/PROTOCOL_RULES.md` maps each binding
rule to its specification rule, code and test, and marks what is frozen.
That revision's `pool-recovery.md` specifies presentation, the non-service
count, snapshot redemption at the venue and the return from silence over the
pool; `model/pool-recovery.ts` is its executable model with counterexamples.
Those objects belong to a later construction version and remain outside the
v2 runtime.

The recovery model follows the later [silence-retirement decision](../decisions/2026-09.md#2026-09-08--intervening-silence-retires-a-pool-segment-and-lapses-its-unfinished-receipts)
and specification revision [`c5f5464`](https://github.com/mediumofexchange/money-from-first-principles/commit/c5f5464).
An intervening silence gap retires old continuation and lapses unfinished
receipts even after an unrelated clock reset, preserving earlier finality and
liability. Return requires a new segment and complete recovery adoption.
The original double-spend counterexample remains under an explicit departure.
`model/pool-fault.ts` extends that model with the selected fault contract at
[`23af0f5`](https://github.com/mediumofexchange/money-from-first-principles/commit/23af0f5):
authenticated exclusion, a clock read from the snapshot, and continuation of
the last valid prefix. Rejected policies remain test-only historical controls.
The model hashes exact admitted proof/signature bytes into a separate chain,
compares receipt evidence and retains witnessed bytes through adoption. Proof
and signature verification remain ideal oracles. Production v3 records/configuration,
compact fault certificates and authenticated interval evidence remain open.

The later [presentment clarification](https://github.com/mediumofexchange/money-from-first-principles/commit/923ee46)
keeps pool demands authorized by their holding proofs. A fresh presenter key
authorizes release/withdrawal; the demand does not establish that key's
participation, its publisher's identity or a person's reputation. Focused
model cases cover copied evidence, field rebinding and lock/retry behavior;
they assume cryptographic authentication and do not implement v3 recovery.

## Successor proof layouts

The successor [proof layouts](https://github.com/mediumofexchange/money-from-first-principles/blob/d57ddb0/pool-v3.md)
fix six relations and public-input orders. `npm run check:pool:v3` compiles
and proves them together, including delivery on issue/burn, four spend
outputs, canonical demand padding, refresh binding and equal-count cross-key
rejection. See the [conformance suite](../scripts/pool/v3/README.md). V3 remains
an incomplete construction: no approved configuration hash or artifact pins,
backing adoption or runtime support is defined.
