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
The transparent path and its pilot retired against a
[case map](../decisions/2026-10.md#2026-10-03--retire-the-pilot-and-the-transparent-path-against-a-case-map-of-their-checks-slice-10-m10e1)
and remain at [8d207eb](https://github.com/mediumofexchange/reference-ts/tree/8d207eb).
Each component follows its specification and adversarial model; witness
integration accompanies the runtime.

## Active runtime

V3 is the only pool runtime, adopted (pool-v3 §11.4) and guarded to reference venues, over shared primitives.

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `pool/v3/wallet-request.ts`, `pool/v3/wallet-store.ts`, `pool/v3/wallet-backup.ts`, `pool/v3/holdings.ts` | [C4.1–7 and pool-fees C1.2.3–5 wallet](POOL_V3_WALLET.md): durable random exact requests exchanged as canonical frames authenticated by an independently obtained digest, public payer validation, current canonical fulfillment with forced spend/lock checks; seed-scanned holdings of one backing in any scope, one/two-note selection with own change/zero outputs, exact record and reservations saved before submission, authenticated first receipt, final/failed reconciliation, same-output reproof in the canonical successor with superseded receipts kept; owner fencing and saved historical lookup; seed-only restoration and an encrypted offline handoff of complete local state that freezes its source. Used venue answers rechecked before acknowledgments. | A qualified human authentication channel, independent evidence retention, cancellation/release, statements spending several backings, continuous backup, rollback protection and qualified storage. |
| `pool/v3/service-*.ts` | [Loopback service/client](POOL_V3_SERVICE.md): bounded submit/commit/publish and published-package transport, distinct operation credentials, independently pinned reply authority and inherited journal fencing. Receiver replay remains independent. | Local activation; no adoption receipt lookup, fee quotes, cancellation or public deployment. Payment requests pass between wallets, not through the service. Publish retries target the latest outbox. |
| `cli/` (the `moe` bin), `pool/parameter-files.ts` | One executable over role directories ([M10b decision](../decisions/2026-10.md#2026-10-02--install-one-moe-command-over-role-directories-on-ergo-venues-only-with-keys-in-files-and-funding-apart-from-the-wallet-slice-10-m10b)): a process lock per directory, owner-only key and token files, one JSON answer and coded exits; `wallet` (holder, and with `--backer` the obligor's issue, accept and burn; [commands](POOL_V3_WALLET.md#commands)), `reader` (init, terms, service, supply, presentation; its evidence and replay files kept, so a read verifies only what is new), `operator` (init, venue create, open, serve, return, adopt) and `relay` (init, publish) over each directory's own Ergo view (synced in bounded passes until caught up) and node clients; the proving parameters fetched and checked into each directory. Drilled with real proofs from a packed install on the synthetic node, past the old 67-statement ceiling and through an offline operator's return (`scripts/pool/v3/command-drill.mjs`), each process's peak RSS recorded; the same drill ran live on the own testnet node ([M10d](../decisions/2026-10.md#2026-10-06--drill-the-moe-commands-live-on-the-testnet-and-keep-the-testnet-context-without-a-difficulty-floor-slice-10-m10d), [report](pool-v3-command-testnet-verification.json)). | Windows ACLs; a network transport. |
| `pool/field.ts`, `pool/poseidon2.ts`, `pool/notes.ts`, `pool/note-tree.ts`, `pool/scope.ts`, `pool/schedule.ts`, `pool/circuits/vendor/` | Shared primitives v3 builds on: canonical fields and identifier limbs, host Poseidon2 pinned to the backend, note commitments and nullifiers, the depth-32 note tree, the depth-16 scope tree, the scope schedule (earliest term deadline, restart lag) and the vendored in-circuit Poseidon2 helper. | The circuits live with the v3 relations in `scripts/pool/v3/circuits/`; no configuration is adopted. |
| `bytes.ts`, `keys.ts`, `contexts.ts` | Canonical encoding, strict signatures and every domain tag, including the retired transparent profile's, kept declared so no later message reuses them. | New construction versions must not reinterpret existing names or signatures. |
| Neutral core: `venue-records.ts`, `venue-error.ts`, `record-venue.ts`, `pool/proof-verifier.ts` with the shared primitives and Ergo modules | Kind 1–3 record bytes, signatures and the directory root; the venue refusal; `RecordVenue`, the §13 read side a v3 reader reads (`ErgoVenue`, and `FixtureVenue` answering from records its owner witnessed), and `RecordPublisher`, its publishing side (`FixtureVenue` witnesses each new record at the next index; its reference identity is `localVenueIdentity` under `moe/venue/local/reference`); proof verification over a construction's circuit table given as data; `ergo-synthetic.ts`, the synthetic reference chain and branch supplier for tests and the local replay. `test/neutral-core.test.ts` pins that its import closure stays inside the core. | `ergo.ts` implements only `RecordVenue` and `RecordPublisher`. |
| `ergo.ts`, `ergo-headers.ts`, `ergo-profile.ts`, `ergo-supplier.ts`, `ergo-publisher.ts`, `ergo-store.ts`, `record-range.ts` | The [selected Ergo venue profile](ERGO_VENUE_PROFILE.md#runtime-venue) supplies the one verifying reader and kinds 1–4 publisher. Headers and section roots establish complete ranges and one atomic witnessed snapshot; missing sections stop the clock and deep reorganization fails the view. Optional [durable reference storage](ERGO_VENUE_PROFILE.md#durable-reference-view-and-publisher) revalidates lossless evidence, preserves pin/failure, prunes completed deep side paths and protects incomplete fork continuation. The publisher saves exact signed retries, reservations and change in its owning journal's fenced outbox. | Full-history checkpoint rewrite/revalidation and memory; disk streaming, persistent supplier quotas, physical storage qualification and rollback protection remain. Not exported from the root barrel. |
| `pool/v3/` | Codecs, commitments, trails, terms, evidence packages, note recovery and compressed spent root. Shared state transitions, complete single- and multi-backing ancestry (`scope-reader.ts`: whole-scope imports, per-backing adoption), silence, force/adoption, receipts and request count use independent §13 answers. Both package readers accept dependency-resolved compact faults. Six relations provide witnesses/proofs. The journal serves one- or multi-backing scopes and preserves admission, witnessed return/adoption, exact-link succession, scope changes at committed boundaries and the publisher outbox under one owner; imported evidence stays separate from its signed counter. Its database holds its admission state, records and served evidence, committed with each command, and it reopens from rows. The guard recomputes reference venue identities. Replay state lives in `replay-store.ts` (node:sqlite): namespaces by replay identity with append-only facts read at a position, imports by reference, savepoint rollback and incremental witnesses for the outputs a wallet scans as its own. See [acceptance and limits](POOL_DEPLOYMENT_PROBES.md#reference-operator-journal). | [Live recovery](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json) is historical at `a72888b`; prior live kinds 1–3 at `2c6b20c`. Succession, compact orchestration and process persistence have local/synthetic evidence. No wallet custody or qualified physical storage. Ancestry can exhaust limits. Not exported from the root barrel. |

Record readers are tied to the captured view. Refresh after record changes,
including same-index revocation; a previously valid snapshot is not current
permission to serve. Validation owns external bytes before callbacks.

## Lit construction (draft)

The transparent profile's construction, `moe/lit/v1` ([lit-v1](https://github.com/mediumofexchange/money-from-first-principles/blob/1bf5bfc/lit-v1.md),
a draft until adopted), is built in `src/lit/` beside the pool, through the pool's seams (WORK.md's slice 14).

| Component | Implemented boundary | Still outside it |
|---|---|---|
| `lit/configuration.ts`, `lit/notes.ts`, `lit/records.ts`, `lit/commitments.ts`, `lit/wallet-keys.ts` | §§2–5, 8–9 bytes: notes and derived outputs, the seven statements and records, signature and arithmetic checks of one statement, acceptance, release and publications, the history and evidence chains, snapshot and receipt, wallet key derivation; [conformance vectors](../test/fixtures/lit-v1-vectors.json). | A lit wallet and commands. |
| `lit/transport.ts`, `lit/fault-evidence.ts`, `lit/terms.ts` | §6's header, trail and package through pool-v3's codecs, each parameterized by construction (`segmentHeaderCodec`, `trailCodec`, `packageCodec`, `termsCodec`; pool-v3's exports bind its own profile); fault evidence with the evidence pair and compact intrinsic exclusion; §9's terms with the tag-6 silence clause. | Serving lit trails (`trailPart`, `wholePackage` take pool-v3's by default). |
| `lit/construction.ts` over `pool/v3/construction.ts` | §7: lit records judged by `state.ts`'s one machine in every mode through a construction view ([decision](../decisions/2026-10.md#2026-10-05--judge-lit-records-in-the-one-state-machine-through-a-construction-view-slice-14-m14c)): inputs live as outputs of the state (`INPUT`), the statement's arithmetic and owner signatures in the proof's place, derived outputs, a settlement's nullifiers and output from its stored demand, force reading inputs in the snapshot only; a lit namespace keeps no note tree. Its reader frames read lit packages through the one package reader and walk ([decision](../decisions/2026-10.md#2026-10-06--read-lit-packages-through-the-one-package-reader-and-walk-the-construction-a-read-option-slice-14-m14d)): `readPackage`/`readFrontier` with `construction: LIT`, no verifier, an evidence store bound to lit; receipts without a scope root, C2b.5.2 requests by owner signature, §6's compact intrinsic exclusion. | A lit wallet's scan and its `answers` (C3.5/C3.8 reads); the journal's lit admission. |

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
Production still needs durable evidence availability;
reference Ergo readers authenticate complete venue intervals within their budgets.

## Retained evidence and retirement conditions

| Material | Why it remains | Remove when |
|---|---|---|
| `scripts/pool/v3/local-{replay,worker,check}.mjs`, `scripts/pool/v3/{import-check,recovery-store-check}.mjs` | Real-proof fixtures, hostile cases and fresh-process reads over the promoted runtime: `reader.ts` replays trails and `scope-reader.ts` classifies ancestry and silence in every scope; `state.ts` supplies force and exact adoption; `receipt-state.ts` and `non-service.ts` supply receipt verdicts and canonical request counts. The recovery-store harness exercises `witness.ts`, `prover.ts`, the journal's witnessed return/adoption barrier and `package-reader.ts` on local and synthetic Ergo reference venues. Its multi-backing groups cover whole-scope imports, shared-event deduplication, per-backing adoption, original-tree restoration and receipt boundaries, and every group is read by `readPackage` (`local-replay.mjs` adds the harness's input shapes and report fields), the single-backing compact-fault groups also by `readFrontier` (`frontier-check.mjs`). Note scanning is `holdings.ts` during the replay. | Single- and multi-backing reads run in the runtime; local/synthetic real-proof recovery acceptance passed. The journal opens and changes multi-backing scopes and a wallet pays in one (`scope-store-check.mjs`), also live on the testnet (M8b). Fixtures establish neither production finality, wallet custody nor restart persistence (live recovery is historical at `a72888b`; the configuration is adopted, pool-v3 §11.4). |
| `scripts/pool/v3/manifest.mjs` | Checks the runtime's manifest of the adopted configuration (`src/pool/v3/configuration.ts`, pool-v3 §11.4) against the installed toolchain, the circuit sources and a build's artifacts and keys. The runtime proves and verifies only the shipped relations (`src/pool/v3/programs.json`, checked by `programs.ts` and `verifier.ts`); `programs.mjs` requires the sources to compile to them exactly. | Stays while the harnesses compile the relations for their own key files. |
| `scripts/pool/v3/` | Reproducible six-relation proof conformance: the build reproduces the adopted configuration's identities, and fixture statements carry a synthetic domain field. | The runtime takes over the sources and all proof/range/hostile cases; do not duplicate production verifiers. |
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
`scratch/private-payment-crs` name; pool tools read its checked leading bytes.

## Where to read next

- [Protocol rules](PROTOCOL_RULES.md): binding rules, code and tests.
- [Fault recovery](POOL_FAULT_RECOVERY.md): the fault contract, its model and v3 evidence frames.
- [Historical v3 recovery map](https://github.com/mediumofexchange/reference-ts/blob/fd8ce7e/docs/POOL_V3_RECOVERY_MAP.md): the pre-adoption design map; pool-v3 adopted its outcomes.
- [Deployment probes](POOL_DEPLOYMENT_PROBES.md): device, venue and restoration evidence.
- [Wallet direction](WALLET_DIRECTION.md): product direction and unselected fixed-creditor proposal.
