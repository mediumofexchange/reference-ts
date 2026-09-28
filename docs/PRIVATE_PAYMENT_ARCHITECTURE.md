# Shielded-pool implementation map

Current component boundaries. The normative source is the
companion specification pinned in [README](../README.md) and the component
pins in [implementation status](IMPLEMENTATION_STATUS.md).
[WORK](../WORK.md) owns the next task;
[production requirements](PRODUCTION_REQUIREMENTS.md) owns release gates. The
[v3 runtime plan](../decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
set where v3 enters `src/pool/v3/`; pool-v2 retired against a
[case map of its checks](../decisions/2026-09.md#2026-09-28--retire-v2-against-a-case-map-of-its-checks)
and remains at [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).
Each component follows its specification and adversarial model; witness
integration accompanies the runtime.

## Active runtime

V3 is the only pool runtime, a guarded candidate over shared primitives.

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `pool/v3/wallet-request.ts`, `pool/v3/wallet-store.ts`, `pool/v3/wallet-backup.ts`, `pool/v3/holdings.ts` | [C4.1–7 and pool-fees C1.2.3–5 wallet](POOL_V3_WALLET.md): durable random exact requests exchanged as canonical frames authenticated by an independently obtained digest, public payer validation, current canonical fulfillment with forced spend/lock checks; seed-scanned single-backing holdings, one/two-note selection with own change/zero outputs, exact record and reservations saved before submission, authenticated first receipt, final/failed reconciliation, same-output reproof in the canonical successor with superseded receipts kept; owner fencing and saved historical lookup; seed-only restoration and an encrypted offline handoff of complete local state that freezes its source. Used venue answers rechecked before acknowledgments. | A qualified human authentication channel, independent evidence retention, cancellation/release, multi-backing payment, continuous backup, rollback protection and qualified storage. |
| `pool/v3/service-*.ts` | [Loopback service/client](POOL_V3_SERVICE.md): bounded submit/commit/publish and published-package transport, distinct operation credentials, independently pinned reply authority and inherited journal fencing. Receiver replay remains independent. | Local activation; no adoption receipt lookup, fee quotes, cancellation or public deployment. Payment requests pass between wallets, not through the service. Publish retries target the latest outbox. |
| `pool/field.ts`, `pool/poseidon2.ts`, `pool/notes.ts`, `pool/note-tree.ts`, `pool/scope.ts`, `pool/schedule.ts`, `pool/circuits/vendor/` | Shared primitives v3 builds on: canonical fields and identifier limbs, host Poseidon2 pinned to the backend, note commitments and nullifiers, the depth-32 note tree, the depth-16 scope tree, the scope schedule (earliest term deadline, restart lag) and the vendored in-circuit Poseidon2 helper. | The circuits live with the v3 relations in `scripts/pool/v3/circuits/`; no configuration is adopted. |
| `backing.ts`, `bytes.ts`, `keys.ts`, `contexts.ts`, `commitment.ts` | Canonical terms/naming, strict signatures, construction declaration and authenticated directory. | New construction versions must not reinterpret existing names or signatures. |
| Neutral core: `venue-records.ts`, `venue-error.ts`, `record-venue.ts`, `pool/proof-verifier.ts` with the shared primitives and Ergo modules | Kind 1–3 record bytes, signatures and the directory root; the venue refusal; `RecordVenue`, the §13 read side a v3 reader reads (`ErgoVenue`, and `FixtureVenue` answering from records its owner witnessed), and `RecordPublisher`, its publishing side (`FixtureVenue` witnesses each new record at the next index; its reference identity is `localVenueIdentity` under `moe/venue/local/reference`); proof verification over a construction's circuit table given as data; `ergo-synthetic.ts`, the synthetic reference chain and branch supplier for tests and the local replay. `test/neutral-core.test.ts` pins that its import closure reaches no transparent module. | `ergo.ts` implements only `RecordVenue` and `RecordPublisher`. |
| `venue.ts` | Local witness for the transparent path; predecessor reads over sparse sequences. | Frozen with the transparent path; v3 reads `RecordVenue`. |
| `ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`, `ergo-publisher.ts`, `ergo-store.ts`, `record-range.ts` | The [selected Ergo venue profile](ERGO_VENUE_PROFILE.md#runtime-venue) supplies the one verifying reader and kinds 1–4 publisher. Headers and section roots establish complete ranges and one atomic witnessed snapshot; missing sections stop the clock and deep reorganization fails the view. Optional [durable reference storage](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher) revalidates lossless evidence, preserves pin/failure, prunes completed deep side paths and protects incomplete fork continuation. The publisher saves exact signed retries, reservations and change in its owning journal's fenced outbox. | Full-history checkpoint rewrite/revalidation and memory; disk streaming, persistent supplier quotas, physical storage qualification and rollback protection remain. Not exported from the root barrel. |
| `pool/v3/` (candidate) | Codecs, commitments, trails, terms, evidence packages, note recovery and compressed spent root. Shared state transitions, complete single- and multi-backing ancestry (`scope-reader.ts`: whole-scope imports, per-backing adoption), silence, force/adoption, receipts and request count use independent §13 answers. Both package readers accept dependency-resolved compact faults. Six candidate relations provide witnesses/proofs. The journal preserves admission, witnessed return/adoption, exact-link succession and the publisher outbox under one owner; imported evidence stays separate from its signed counter. The guard recomputes reference venue identities. See [acceptance and limits](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal). | [Live recovery](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json) is historical at `a72888b`; prior live kinds 1–3 at `2c6b20c`. Succession, compact orchestration and process persistence have local/synthetic evidence. No adopted configuration, wallet custody or qualified physical storage. The journal opens only single-backing segments; ancestry can exhaust limits. Not exported from the root barrel. |

Record readers are tied to the captured view. Refresh after record changes,
including same-index revocation; a previously valid snapshot is not current
permission to serve. Validation owns external bytes before callbacks.

## Executable models

| Model | Role and limit |
|---|---|
| `model/sequencing.ts` | Scheduling, inclusion/drop, replacement, restart and incomplete views over public backing labels. Timing oracle; does not establish privacy or shared-pool authority. |
| `model/pool-authority.ts` | Private scopes, whole-scope finality, canonical shared imports and receipt precedence with ideal cryptography. |
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
| `scripts/pool/v3/local-{replay,worker,check}.mjs`, `scripts/pool/v3/{import-check,recovery-store-check}.mjs` | Real-proof fixtures, hostile cases and fresh-process reads over the promoted runtime: `reader.ts` and `import-reader.ts` classify single-backing ancestry and silence; `state.ts` supplies force and exact adoption; `receipt-state.ts` and `non-service.ts` supply receipt verdicts and canonical request counts. The recovery-store harness exercises `witness.ts`, `prover.ts`, the journal's witnessed return/adoption barrier and `package-reader.ts` on local and synthetic Ergo reference venues. `scope-reader.ts` reads the multi-backing groups (whole-scope imports, shared-event deduplication, per-backing adoption, original-tree restoration, receipt boundaries), and `scope-runtime-check.mjs` compares `readPackage` with each. Note scanning and the report's audit fields remain harness responsibilities. | Single- and multi-backing reads run in the runtime; local/synthetic real-proof recovery acceptance passed. Operator activation of multi-backing segments is slice 7's next milestone. Fixtures establish neither live recovery nor configuration adoption, production finality, wallet custody or restart persistence. |
| `scripts/pool/v3/candidate.mjs` | The independently held candidate manifest: six artifact identities, the helper and toolchain pins, and the candidate configuration built from them. No runtime Backing or declaration capability. | The v3 entry points take their configuration from a manifest check the caller holds (slice 1 M2); adoption replaces the manifest with approved identities. |
| `scripts/pool/v3/evidence-reader.mjs` | Local evidence authentication, codecs, limits and capsule scanning the v3 harnesses share; `import-check.mjs` inspects restoration evidence through it. Its fresh-process restoration experiment retired with v2, the v3 wallet having taken over the cases. | Retires with the harnesses that import it. |
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
| Private issue/pay/burn, real witnesses and hostile ownership/range/conservation/path cases | `scripts/pool/v3/check.mjs` (six relations, range and type-escape attacks), `scripts/pool/v3/store-check.mjs` |
| Admission, authorized issuance, shared nullifiers, duplicate outputs, anchors, replay and races | `test/pool-v3-state.test.ts` (named refusals), `test/pool-v3-store.test.ts` |
| Exact history, missing/corrupt/reordered proofs and independent supply | `test/pool-v3-state.test.ts`, `test/pool-v3-trail.test.ts`, the seedless audit in `scripts/pool/v3/local-check.mjs` |
| Receiver owner, positive value, inclusion and spent-note refusal | `test/pool-v3-wallet.test.ts` fulfillment cases |
| Withheld suffix/older-prefix limits | `test/pool-v3-wallet.test.ts`: complete current history is required and a note spent after the payment checkpoint is refused |
| Accept-once persistence, copies, lost reply, reopening and before/after commit failure | `test/pool-v3-wallet.test.ts`, `test/pool-v3-payer.test.ts` and `scripts/pool/v3/wallet-crash.mjs`; historical lookup returns the saved record, competing fulfillments credit once |

Protocol statement replay still returns its prior receipt. Wallet lookup never
authorizes a second external credit. Zero outputs remain valid padding, but are
not receiver payments. Fulfillment is judged against current canonical replay;
neither framework establishes supported custody or private transport.
Research-specific JSON journal formats and capacity knobs are not retained as
another product mechanism. The shared proving-parameter cache keeps its existing
`scratch/private-payment-crs` name; active pool tools still use it.

## Where to read next

- [Protocol rules](PROTOCOL_RULES.md): binding rules, code and tests.
- [Fault recovery](POOL_FAULT_RECOVERY.md): current unresolved protocol work.
- [v3 recovery map](POOL_V3_RECOVERY_MAP.md): candidate v3 objects, one complete trace, record ranges, resource assumptions and probes.
- [Deployment probes](POOL_DEPLOYMENT_PROBES.md): device, venue and restoration evidence.
- [Wallet direction](WALLET_DIRECTION.md): product direction and unselected fixed-creditor proposal.
