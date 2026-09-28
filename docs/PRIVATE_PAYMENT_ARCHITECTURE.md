# Shielded-pool implementation map

Current component boundaries. The normative source is the
companion specification pinned in [README](../README.md) and the component
pins in [implementation status](IMPLEMENTATION_STATUS.md).
[WORK](../WORK.md) owns the next task;
[production requirements](PRODUCTION_REQUIREMENTS.md) owns release gates. The
[v3 runtime plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
sets where v3 enters `src/pool/v3/` and when the v2 rows below retire. With
reference-venue publication, recovery, single-backing succession and bounded
process persistence implemented, remaining work includes v3
wallet/service integration and v2 retirement. Each follows its specification
and adversarial model; witness integration accompanies the runtime.

## Active runtime

V3 is the active candidate path. V2-specific pool, wallet and service modules
below are frozen until their cases pass on v3; neutral primitives remain shared.

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `pool/v3/wallet-request.ts`, `pool/v3/wallet-store.ts` | [C4.1–5 receiver](POOL_V3_WALLET.md): durable random exact requests, public payer validation, current canonical fulfillment with forced spend/lock checks, owner fencing and saved historical lookup. Package/terms retained before acknowledgment; used venue answers rechecked after proof callbacks. | Authenticated request channel, independent evidence retention, payer custody/fees, service, restoration, encrypted backup and qualified storage. No v2 retirement. |
| `backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`, `commitment.ts` | Canonical terms/naming, strict signatures, construction declaration and authenticated directory. | New construction versions must not reinterpret existing names or signatures. |
| Neutral core: `venue-records.ts`, `venue-error.ts`, `record-venue.ts`, `pool/proof-verifier.ts` with the shared primitives and Ergo modules | Kind 1–3 record bytes, signatures and the directory root; the venue refusal; `RecordVenue`, the §13 read side a v3 reader reads (`ErgoVenue`, and `FixtureVenue` answering from records its owner witnessed), and `RecordPublisher`, its publishing side (`FixtureVenue` witnesses each new record at the next index; its reference identity is `localVenueIdentity` under `moe/venue/local/reference`); proof verification over a construction's circuit table given as data; `ergo-synthetic.ts`, the synthetic reference chain and branch supplier for tests and the local replay. `test/neutral-core.test.ts` pins that its import closure reaches no transparent or v2 module. | `ergo.ts` keeps its transparent `Venue` face for v2 until v2 retires. |
| `src/pool/` claim layer | v2 fields, Poseidon2, private notes, note/spent/scope trees, canonical frames, finalized imports, admission and replay through supplied evidence. | Recovery statement/publication layouts and circuits belong to a later version. |
| `pool/circuits/`, `pool/barretenberg.ts` | Pinned v2 issue, two-input/two-output spend and burn circuits, bound as v2's table to `pool/proof-verifier.ts`; Barretenberg is an optional peer reached through the verifier interface. The successor four-output shape is separate experimental work. | Deployment assurance, setup provenance and target-device budgets. See [circuit guide](../src/pool/circuits/README.md) and [recorded v2 evidence](pool-v2-verification.json). |
| `pool/authority.ts`, `pool/schedule.ts` | Snapshot of signed terms/replacement chain; complete shared-scope authority, earliest term deadline, operator-wide in-flight commitment and restart lag. | Authority alone does not authenticate a header, establish finality or authorize service. |
| `pool/descent.ts`, `pool/checkpoint.ts` | Authenticated absence/whole-scope lapse, exact predecessor selection, transitive canonical import validation and replay. Earlier proven pre-revocation issuance remains importable. | Missing or invalid live evidence never permits fallback. Historical finality is not current spendability. |
| `pool/opening.ts` | Derives current scope and canonical openings before a child exists; validates dependencies and prepares an empty segment. Sequence derives from the durable signed counter, including failed publication. | Preparation reserves nothing and cannot authorize discard or signing. |
| `pool/receipt*.ts` | Acceptance signatures, exact evidence attestation, semantic history inclusion, repair and present record verdicts. See [receipt APIs](POOL_RECEIPTS.md). | A receipt is not a balance. Silence verdicts remain model-only; exact evidence attestation is not checkpoint proof binding. |
| `pool/store.ts`, `pool/store-codec.ts` | Node 24 journal for openings, admissions, original receipts, signed counter and outbox; restart fencing, revalidation and complete used canonical evidence retention. See [PoolStore](POOL_STORE.md). | Refuses silence clauses. Copied journals/rollback and coordinated backup custody remain open. |
| `pool/service-*.ts` | Local HTTP service and client for existing v2 submit/commit/publish semantics; bounded framing, operation credentials, caller-domain binding and fenced status without evidence construction. Separate-process retry/restart evidence in [service guide](POOL_SERVICE.md). | No evidence retrieval, independent witness authentication, public deployment or recovery interface. |
| `pool/wallet.ts`, `pool/wallet-store.ts`, `pool/wallet-payment.ts`, `pool/wallet-backup.ts`, `pool/wallet-pairing.ts`, `pool/wallet-delivery-{wire,http}.ts` | Local v2 derivation, durable requests, pending statements, reservations and historical invoice records. Ordinary local payment selects up to two verified unreserved notes. Receiver-owned note checks report spent/unspent at the exact verified checkpoint; saved fulfillment lookup reconciles lost replies without another write. [Wallet fixture](POOL_WALLET.md) connects real proofs, private HTTPS delivery with durable scoped capabilities/inbox, public audit, encrypted offline handoff with source freeze/exact restoration and abrupt crash recovery. | Protected local storage, an independently retained current recovery identity and one active copy are preconditions; device protection is not qualified. Known local venue; no latest-state assertion, rollback protection, qualified user pairing channel or deployed endpoint operation, imported-note selection, automatic consolidation, replacement or seed-only restoration. |
| `venue.ts` | Local witness for v2 and the transparent path; predecessor reads over sparse sequences. | Stands in for an external venue in local fixtures; v3 reads `RecordVenue`. |
| `ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`, `ergo-publisher.ts`, `ergo-store.ts`, `record-range.ts` | The [selected Ergo venue profile](ERGO_VENUE_PROFILE.md#runtime-venue) supplies the one verifying reader and kinds 1–4 publisher. Headers and section roots establish complete ranges and one atomic witnessed snapshot; missing sections stop the clock and deep reorganization fails the view. Optional [durable reference storage](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher) revalidates lossless evidence, preserves pin/failure, prunes completed deep side paths and protects incomplete fork continuation. The publisher saves exact signed retries, reservations and change in its owning journal's fenced outbox. | Full-history checkpoint rewrite/revalidation and memory; disk streaming, persistent supplier quotas, physical storage qualification and rollback protection remain. Not exported from the root barrel. |
| `pool/v3/` (candidate) | Codecs, commitments, trails, terms, evidence packages, note recovery and compressed spent root. Shared state transitions, single-backing complete ancestry, silence, force/adoption, receipts and request count use independent §13 answers. Both package readers accept dependency-resolved compact faults. Six candidate relations provide witnesses/proofs. The journal preserves admission, witnessed return/adoption, exact-link succession and the publisher outbox under one owner; imported evidence stays separate from its signed counter. The guard recomputes reference venue identities. See [acceptance and limits](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal). | [Live recovery](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json) is historical at `a72888b`; prior live kinds 1–3 at `2c6b20c`. Succession, compact orchestration and process persistence have local/synthetic evidence. No adopted configuration, wallet custody or qualified physical storage. Multi-backing stays in the harness; ancestry can exhaust limits. V2 remains until wallet/service migration. Not exported from the root barrel. |

Record readers are tied to the captured view. Refresh after record changes,
including same-index revocation; a previously valid snapshot is not current
permission to serve. Validation owns external bytes before callbacks.

## Executable models

| Model | Role and limit |
|---|---|
| `model/sequencing.ts` | Scheduling, inclusion/drop, replacement, restart and incomplete views over public backing labels. Timing oracle; does not establish privacy or shared-pool authority. |
| `model/pool-authority.ts` | Private scopes, whole-scope finality, canonical shared imports and receipt precedence with ideal cryptography. Runtime supplies v2 bytes and proofs. |
| `model/pool-schedule.ts` | Enumerated calendar oracle for the shared-scope scheduler. |
| `model/pool-recovery.ts` | Normative later-version presentation, count, clock, snapshot settlement, force, adoption and historical-silence retirement, with counterexample departures and a separate semantic observer. Not runtime support. |
| `model/pool-fault.ts`, `model/pool-evidence.ts` | Selected authenticated exclusion, snapshot clock and continuation from the last valid prefix; independent evidence snapshots and original-prefix revalidation. Exact proof/signature bytes are hashed into a separate chain and compared in receipts and adoption. Rejected policies live in the test-only historical helper. [Fault recovery](POOL_FAULT_RECOVERY.md) defines the ideal-oracle limits and remaining production layout/availability work. |

The historical-silence decision is implemented in the model and the guarded
single-backing v3 runtime: a gap strictly after the witnessed opening retires
continuation and unfinished receipts,
even after an unrelated reset. Earlier finality and liability survive; new
adoption into a retired segment refuses, while historical replay and exact
receipt retry remain available. A fresh return adopts through its own index.
Production still needs durable evidence availability and configuration adoption;
reference Ergo readers authenticate complete venue intervals within their budgets.

## Retained evidence and retirement conditions

| Material | Why it remains | Remove when |
|---|---|---|
| `scripts/pool/v3/local-{replay,worker,check}.mjs`, `scripts/pool/v3/{import-check,recovery-store-check}.mjs` | Real-proof fixtures, hostile cases and fresh-process reads over the promoted runtime: `reader.ts` and `import-reader.ts` classify single-backing ancestry and silence; `state.ts` supplies force and exact adoption; `receipt-state.ts` and `non-service.ts` supply receipt verdicts and canonical request counts. The recovery-store harness exercises `witness.ts`, `prover.ts`, the journal's witnessed return/adoption barrier and `package-reader.ts` on local and synthetic Ergo reference venues. Multi-backing orchestration remains in `scope-replay.mjs` and `scope-recovery.mjs`: whole-scope canonical imports, shared-event deduplication, per-backing adoption indices, original-tree restoration and receipt boundaries, using the same runtime transitions and count. Compact fault-package orchestration and note scanning also remain harness responsibilities. | Single-backing runtime promotion is implemented; local/synthetic real-proof recovery acceptance passed. Slice 7 promotes multi-backing orchestration. Fixtures establish neither live recovery nor configuration adoption, production finality, wallet custody or restart persistence. |
| `scripts/pool/spent-set/bench.mjs` | A22's measured per-insert replay cost of the v3 spent root against pinned v2. | v2 retires (slice 6). |
| `scripts/pool/v3/candidate.mjs` | The independently held candidate manifest: six artifact identities, the helper and toolchain pins, and the candidate configuration built from them. No runtime Backing or declaration capability. | The v3 entry points take their configuration from a manifest check the caller holds (slice 1 M2); adoption replaces the manifest with approved identities. |
| `scripts/pool/delivery/evidence-{reader,worker,check}.mjs` | Fresh-process capsule scanning over exact signed local v3 evidence, with independent fixture selection, historical/current mismatch and omission/substitution cases. Candidate notes remain unspendable; no replay or current-range claim. | V3 wallet and verified public-package reader take over the cases with full replay, certified paths and authenticated ranges. |
| `scripts/pool/v3/` | Reproducible six-relation proof conformance against the successor layouts, with synthetic domain and no adopted configuration. | Reviewed final v3 configuration and runtime take over the sources and all proof/range/hostile cases; do not duplicate production verifiers. |
| Transparent `ledger.ts`, `oplog.ts`, `messages.ts`, `sequencer.ts`, presentation/recovery/replacement/fault modules and tests | Frozen profile, differential oracle and adversarial case library. | Corresponding pool rules pass the ported cases. Never port the retired exhibit walk or signed opening claim. |
| `pilot-store.ts`, `pilot-http.ts`, `pilot-wire.ts`, pilot CLI | Durable-command pattern and process integration harness on the frozen path. [Pilot guide](PILOT.md). | A pool equivalent covers its integration behavior; retain useful persistence patterns. |
| `docs/pool-*-verification.json` and [deployment probes](POOL_DEPLOYMENT_PROBES.md) | Pinned observations and reproducible benchmark instructions. | Replaced by explicitly identified evidence; old measurements never establish a new version's properties. |
| `decisions/` and selected checked reviews in `decisions/archive/` | Durable choices, accepted costs and independent findings still relevant to open gates. | Superseded investigation/session drafts live in Git history, not alongside active guidance. |

No live-value migration is assumed. Later retirement of an implementation
used for real claims requires a successor backing and swap; deleting a
journal or changing a verifier under the same identity is not migration.

### Private-payment experiment case map

The duplicate host, journal, compiler, circuits and dependency tree were removed
after receiver checks joined the active pool path. The [historical contract](https://github.com/mediumofexchange/reference-ts/blob/af398eaf4506b39d41685218c3ab1717a37842f3/experiments/private-payment/RESEARCH.md)
and [measured report](https://github.com/mediumofexchange/reference-ts/blob/af398eaf4506b39d41685218c3ab1717a37842f3/experiments/private-payment/results/2026-09-05-windows.json)
remain evidence for that research profile only. Active equivalents are:

| Research behavior | Active verification |
|---|---|
| Private issue/pay/burn, real witnesses and hostile ownership/range/conservation/path cases | `scripts/pool/check.mjs`, `scripts/pool/wallet/check.mjs --real` |
| Admission, authorized issuance, shared nullifiers, duplicate outputs, anchors, replay and races | `test/pool-admission.test.ts`, `test/pool-store.test.ts` |
| Exact history, equal-output/different-spent histories, missing/corrupt/reordered proofs and independent supply | `test/pool-checkpoint.test.ts`, `test/pool-segment.test.ts`, `scripts/pool/wallet/audit.mjs` and real wallet acceptance |
| Receiver owner, positive value, inclusion and spent-note refusal | `test/pool-wallet.test.ts`, CLI `checkNote` before fulfillment and proof preparation |
| Withheld suffix/older-prefix limits | Wallet regressions for an older unspent checkpoint, later spent checkpoint and ignored unverified tail |
| Accept-once persistence, copies, lost reply, reopening and before/after commit failure | Wallet unit tests and `scripts/pool/wallet/crash.mjs`; `fulfillment` returns the saved original record, duplicate writes remain conflicts |

Protocol statement replay still returns its prior receipt. Wallet lookup never
authorizes a second external credit. Zero outputs remain valid padding, but are
not receiver payments. Note status is exact-checkpoint-scoped; neither framework
establishes latest external finality, supported custody or private transport.
Research-specific JSON journal formats and capacity knobs are not retained as
another product mechanism. The shared proving-parameter cache keeps its existing
`scratch/private-payment-crs` name; active pool tools still use it.

## Where to read next

- [Protocol rules](PROTOCOL_RULES.md): binding rules, code and tests.
- [Fault recovery](POOL_FAULT_RECOVERY.md): current unresolved protocol work.
- [v3 recovery map](POOL_V3_RECOVERY_MAP.md): candidate v3 objects, one complete trace, record ranges, resource assumptions and probes.
- [Deployment probes](POOL_DEPLOYMENT_PROBES.md): device, venue and restoration evidence.
- [Wallet direction](WALLET_DIRECTION.md): product direction and unselected fixed-creditor proposal.
