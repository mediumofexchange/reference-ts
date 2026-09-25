# Shielded-pool implementation map

Current component boundaries. The normative source is the
companion specification pinned in [README](../README.md). Build in this
order: specification, adversarial model, claim layer, sequencing/recovery,
wallet, external witness write adapter. [WORK](../WORK.md) owns the next task;
[production requirements](PRODUCTION_REQUIREMENTS.md) owns release gates. The
[v3 runtime plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
sets where v3 enters `src/pool/v3/` and when the v2 rows below retire.

## Active runtime

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`, `commitment.ts` | Canonical terms/naming, strict signatures, construction declaration and authenticated directory. | New construction versions must not reinterpret existing names or signatures. |
| Neutral core: `venue-records.ts`, `venue-error.ts`, `pool/proof-verifier.ts` with the shared primitives and Ergo modules | Kind 1–3 record bytes, signatures and the directory root; the venue refusal; proof verification over a construction's circuit table given as data. `test/neutral-core.test.ts` pins that its import closure reaches no transparent or v2 module. | `ergo.ts` keeps its transparent `Venue` face for v2 until v2 retires. |
| `src/pool/` claim layer | v2 fields, Poseidon2, private notes, note/spent/scope trees, canonical frames, finalized imports, admission and replay through supplied evidence. | Recovery statement/publication layouts and circuits belong to a later version. |
| `pool/circuits/`, `pool/barretenberg.ts` | Pinned v2 issue, two-input/two-output spend and burn circuits, bound as v2's table to `pool/proof-verifier.ts`; Barretenberg is an optional peer reached through the verifier interface. The successor four-output shape is separate experimental work. | Deployment assurance, setup provenance and target-device budgets. See [circuit guide](../src/pool/circuits/README.md) and [recorded v2 evidence](pool-v2-verification.json). |
| `pool/authority.ts`, `pool/schedule.ts` | Snapshot of signed terms/replacement chain; complete shared-scope authority, earliest term deadline, operator-wide in-flight commitment and restart lag. | Authority alone does not authenticate a header, establish finality or authorize service. |
| `pool/descent.ts`, `pool/checkpoint.ts` | Authenticated absence/whole-scope lapse, exact predecessor selection, transitive canonical import validation and replay. Earlier proven pre-revocation issuance remains importable. | Missing or invalid live evidence never permits fallback. Historical finality is not current spendability. |
| `pool/opening.ts` | Derives current scope and canonical openings before a child exists; validates dependencies and prepares an empty segment. Sequence derives from the durable signed counter, including failed publication. | Preparation reserves nothing and cannot authorize discard or signing. |
| `pool/receipt*.ts` | Acceptance signatures, exact evidence attestation, semantic history inclusion, repair and present record verdicts. See [receipt APIs](POOL_RECEIPTS.md). | A receipt is not a balance. Silence verdicts remain model-only; exact evidence attestation is not checkpoint proof binding. |
| `pool/store.ts`, `pool/store-codec.ts` | Node 24 journal for openings, admissions, original receipts, signed counter and outbox; restart fencing, revalidation and complete used canonical evidence retention. See [PoolStore](POOL_STORE.md). | Refuses silence clauses. Copied journals/rollback and coordinated backup custody remain open. |
| `pool/service-*.ts` | Local HTTP service and client for existing v2 submit/commit/publish semantics; bounded framing, operation credentials, caller-domain binding and fenced status without evidence construction. Separate-process retry/restart evidence in [service guide](POOL_SERVICE.md). | No evidence retrieval, independent witness authentication, public deployment or recovery interface. |
| `pool/wallet.ts`, `pool/wallet-store.ts`, `pool/wallet-payment.ts`, `pool/wallet-backup.ts`, `pool/wallet-pairing.ts`, `pool/wallet-delivery-{wire,http}.ts` | Local v2 derivation, durable requests, pending statements, reservations and historical invoice records. Ordinary local payment selects up to two verified unreserved notes. Receiver-owned note checks report spent/unspent at the exact verified checkpoint; saved fulfillment lookup reconciles lost replies without another write. [Wallet fixture](POOL_WALLET.md) connects real proofs, private HTTPS delivery with durable scoped capabilities/inbox, public audit, encrypted offline handoff with source freeze/exact restoration and abrupt crash recovery. | Protected local storage, an independently retained current recovery identity and one active copy are preconditions; device protection is not qualified. Known local venue; no latest-state assertion, rollback protection, qualified user pairing channel or deployed endpoint operation, imported-note selection, automatic consolidation, replacement or seed-only restoration. |
| `venue.ts` | Local witness; predecessor reads over sparse sequences. | Stands in for an external venue in local fixtures. |
| `ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`, `ergo-publisher.ts`, `record-range.ts` | The [selected Ergo venue profile](ERGO_VENUE_PROFILE.md#runtime-venue) as the runtime's `Venue`, publishing kind 1–3 records through an optional funding-key wallet that builds and signs its own transactions: headers verified from the anchor's context and sections by root from untrusted suppliers under per-supplier budgets, §13.3 reads by exhaustion and §13 answers from one snapshot published atomically, which reads use while a sync runs; a missing section stops the clock, a reorganization past the depth fails the view. | Persistence across restarts (the publisher's memory included), side-branch pruning, kind-4 runs. Not exported from the root barrel. |
| `pool/v3/` (candidate) | pool-v3's codecs, promoted from `model/` with their tests: records and publications (§§5–6); history, evidence, snapshot and receipt frames (§7); segment headers (§8); fault evidence (§9); served trails (§10); configuration and signed root terms (§11); evidence packages (§12). With them the compressed spent root (pool-spent C1.2.8–9) and receiver-prepared outputs, capsules and seed scanning (pool-delivery C4.2–C4.4, C4.6–C4.7). `test/neutral-core.test.ts` pins that v3 imports only the neutral core; the v3 scripts read it from `dist/`. | No state machine, admission, reader or record-venue interface yet (slice 1 M1), no journal, prover or candidate guard (M2), no adopted configuration. Not exported from the root barrel. |

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

The historical-silence decision is implemented in the model: a gap strictly
after the witnessed opening retires continuation and unfinished receipts,
even after an unrelated reset. Earlier finality and liability survive; new
adoption into a retired segment refuses, while historical replay and exact
receipt retry remain available. A fresh return adopts through its own index.
Production still needs authenticated complete interval retrieval.

## Retained evidence and retirement conditions

| Material | Why it remains | Remove when |
|---|---|---|
| `scripts/pool/v3/local-{replay,worker,check}.mjs`, `scripts/pool/v3/{fixture-venue,import-check}.mjs` | Real-proof issue/spend/burn replay and candidate note paths; checked candidate configuration and signed terms-derived issuer key, with a fresh seedless audit process. §13 fixture ranges establish replacement links, checkpoint prefixes and revocation. The original-segment walk reads last-valid continuity and the no-commitment clock (C2b.6.1, C2b.4.1). A selection with imports validates exact single-backing transitive predecessors through replacement, reappointment and restart, preserving spent state, roots, totals and original-tree wallet paths. Silence-bearing imports classify publication force, adopt the exact ordered block and preserve historical retirement; same-index fresh openings retain the canonical predecessor and inherited adoption index. Non-service reads share canonical state strictly before judgment. Multi-backing scopes use `scope-replay.mjs` and `scope-recovery.mjs` for whole-scope canonical imports, causal shared-event deduplication, per-backing adoption indices, ordered exact publication adoption and original-tree restoration through split/rejoin and continuation. Receipt reads share complete-scope classification, exact original/adopted inclusion and earliest original-scope boundaries. Non-service counts retain each selected backing's own clause, requests, imported roots and spent/lock state. | V3 runtime, approved configuration, a venue profile behind the range answers and finality. |
| `scripts/pool/spent-set/bench.mjs` | A22's measured per-insert replay cost of the v3 spent root against pinned v2. | v2 retires (slice 6). |
| `scripts/pool/v3/candidate.mjs` | The independently held candidate manifest: six artifact identities, the helper and toolchain pins, and the candidate configuration built from them. No runtime Backing or declaration capability. | The v3 entry points take their configuration from a manifest check the caller holds (slice 1 M2); adoption replaces the manifest with approved identities. |
| `experiments/ergo-range/replay-venue.mjs` | The [local replay adapter](ERGO_VENUE_PROFILE.md#local-replay-adapter): the runtime's Ergo profile code (`src/ergo-profile.ts`, `src/record-range.ts`) answers every real-proof local replay group from raw transaction bytes under separate synthetic headers. | A v3 runtime reads its ranges from `ErgoVenue`. |
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
