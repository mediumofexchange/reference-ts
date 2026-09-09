# Shielded-pool implementation map

Current component boundaries, 2026-09-08. The normative source is the
companion specification pinned in [README](../README.md). Build in this
order: specification, adversarial model, claim layer, sequencing/recovery,
wallet, external witness write adapter. [WORK](../WORK.md) owns the next task;
[production requirements](PRODUCTION_REQUIREMENTS.md) owns release gates.

## Active runtime

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`, `commitment.ts` | Canonical terms/naming, strict signatures, construction declaration and authenticated directory. | New construction versions must not reinterpret existing names or signatures. |
| `src/pool/` claim layer | v2 fields, Poseidon2, private notes, note/spent/scope trees, canonical frames, finalized imports, admission and replay through supplied evidence. | Recovery statement/publication layouts and circuits belong to a later version. |
| `pool/circuits/`, `pool/barretenberg.ts` | Pinned issue, two-input/two-output spend and burn circuits; Barretenberg is an optional peer reached through the verifier interface. | Deployment assurance, setup provenance and target-device budgets. See [circuit guide](../src/pool/circuits/README.md) and [recorded v2 evidence](pool-v2-verification.json). |
| `pool/authority.ts`, `pool/schedule.ts` | Snapshot of signed terms/replacement chain; complete shared-scope authority, earliest term deadline, operator-wide in-flight commitment and restart lag. | Authority alone does not authenticate a header, establish finality or authorize service. |
| `pool/descent.ts`, `pool/checkpoint.ts` | Authenticated absence/whole-scope lapse, exact predecessor selection, transitive canonical import validation and replay. Earlier proven pre-revocation issuance remains importable. | Missing or invalid live evidence never permits fallback. Historical finality is not current spendability. |
| `pool/opening.ts` | Derives current scope and canonical openings before a child exists; validates dependencies and prepares an empty segment. Sequence derives from the durable signed counter, including failed publication. | Preparation reserves nothing and cannot authorize discard or signing. |
| `pool/receipt*.ts` | Acceptance signatures, exact evidence attestation, semantic history inclusion, repair and present record verdicts. See [receipt APIs](POOL_RECEIPTS.md). | A receipt is not a balance. Silence verdicts remain model-only; exact evidence attestation is not checkpoint proof binding. |
| `pool/store.ts`, `pool/store-codec.ts` | Node 24 journal for openings, admissions, original receipts, signed counter and outbox; restart fencing, revalidation and complete used canonical evidence retention. See [PoolStore](POOL_STORE.md). | Refuses silence clauses. Copied journals/rollback, service transport and coordinated backup custody remain open. |
| `venue.ts`, `ergo.ts` | Local witness and read-only Ergo direction; predecessor reads over sparse sequences. Ergo refresh publishes a complete candidate snapshot atomically, refuses record reads during refresh, and retains the previous snapshot on failure. | External write adapter, pinned-node publication and stable commitment envelope. Ergo is not exported from the root barrel. |

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
| `model/pool-v3-trail.ts` | Served-trail transport and local event evidence authentication with byte/event budgets; opaque terms and imported state are not verified. | V3 runtime takes over the codec and hostile cases with complete dependencies, term validation and replay; no second production path. |
| `model/pool-v3-fault-evidence.ts` | Portable exact-byte fault-evidence frames and bounded authentication with explicit local budgets; no checkpoint verdict. | V3 runtime takes over the codec and hostile cases, together with authenticated certificate dependencies and replay. |
| `model/pool-v3-headers.ts` | Canonical successor segment-header byte/hash conformance, bounded decoding and signed-directory substitution cases. | Final v3 runtime takes over the codec and hostile cases; no complete opening or key authority is inferred from decoding. |
| `scripts/pool/v3/` | Reproducible six-relation proof conformance against the successor layouts, with synthetic domain and no adopted configuration. | Reviewed final v3 configuration and runtime take over the sources and all proof/range/hostile cases; do not duplicate production verifiers. |
| `model/pool-v3-records.ts` and `test/pool-v3-records.test.ts` | Canonical statement/authorization/publication byte conformance under pool-v3 §§5–6; synthetic domains and shape-only proof fixtures, with real signature-message tests. | Final v3 runtime takes over the codec and all vectors/hostile cases; it must still enforce proof validity, authority, state, time and semantic replay. |
| `model/pool-v3-commitments.ts` and its test | Pool-v3 §7 history/evidence/snapshot/receipt frames and suffix authentication, with committed bad authorization vs replica-substitution tests. | Final v3 runtime takes over these primitives and cases with authenticated directories, complete replay/classification and durable exact-evidence retention; no second production verifier. |
| `scripts/pool/spent-set/` | A22's selected compressed-root candidate, independent oracle and measured per-insert replay cost; v2 remains fixed. | v3 runtime implements the selected roots with atomic statement/import validation and takes over these cases and measurements. |
| Transparent `ledger.ts`, `oplog.ts`, `messages.ts`, `sequencer.ts`, presentation/recovery/replacement/fault modules and tests | Frozen profile, differential oracle and adversarial case library. | Corresponding pool rules pass the ported cases. Never port the retired exhibit walk or signed opening claim. |
| `pilot-store.ts`, `pilot-http.ts`, `pilot-wire.ts`, pilot CLI | Durable-command pattern and process integration harness on the frozen path. [Pilot guide](PILOT.md). | A pool equivalent covers its integration behavior; retain useful persistence patterns. |
| `experiments/private-payment/` | Frozen research fixture. Core circuit/admission and most journal cases are now covered by the pool. It still exercises receiver acceptance, accept-once invoice persistence, private-opening checks and a separate public-only audit process with real proofs. | Receiver/wallet and independent-audit boundaries, including their crash/retry cases, move to the pool path. Then remove the duplicate host/journal/circuit framework, preserving useful results and vectors. |
| `docs/pool-*-verification.json` and [deployment probes](POOL_DEPLOYMENT_PROBES.md) | Pinned observations and reproducible benchmark instructions. | Replaced by explicitly identified evidence; old measurements never establish a new version's properties. |
| `decisions/` and selected checked reviews in `decisions/archive/` | Durable choices, accepted costs and independent findings still relevant to open gates. | Superseded investigation/session drafts live in Git history, not alongside active guidance. |

No live-value migration is assumed. Later retirement of an implementation
used for real claims requires a successor backing and swap; deleting a
journal or changing a verifier under the same identity is not migration.

## Where to read next

- [Protocol rules](PROTOCOL_RULES.md): binding rules, code and tests.
- [Fault recovery](POOL_FAULT_RECOVERY.md): current unresolved protocol work.
- [v3 recovery map](POOL_V3_RECOVERY_MAP.md): candidate v3 objects, one complete trace, record ranges, resource assumptions and probes.
- [Deployment probes](POOL_DEPLOYMENT_PROBES.md): device, venue and restoration evidence.
- [Wallet direction](WALLET_DIRECTION.md): product direction and unselected fixed-creditor proposal.
- [Experiment contract](../experiments/private-payment/RESEARCH.md): historical feasibility relation; not v2's normative layouts.
