# Current work

Updated: 2026-09-27

## Goal
Slice 4 of the [v3 runtime plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2),
Signing-safety implementation `ce90145` on `feat/v3-hostile-operator`, from `a72888b`;
[PR #25](https://github.com/mediumofexchange/reference-ts/pull/25) records final CI and delivery.
First acceptance boundary: a journal detects every authentic commitment of its own key
outside its durable signing history, including a twin hidden by the held-record rule,
and refuses new signatures. Historical packages, existing outbox publication and exact
replies remain available. Exercise admission, checkpoint, return and adoption, including
conflict appearing during verification; obtain independent adversarial review.
This prerequisite is not completed succession. Next acceptance is distinct-key takeover
and hostile-checkpoint verdicts from public evidence on the synthetic Ergo chain.
Stop: no second backing, persistence, wallet custody or configuration adoption.
Evidence limit: local/synthetic reference venues; earlier live allowances are exhausted.

## Status
- PR #24 merged as `a72888b`; seven PR checks and post-merge CI passed. Its merged
  local and remote branches are removed; the checkout was clean at startup.
- Direction review retained succession → persistence → v3 wallet/service → multi-backing.
  Introductions and gate standings now distinguish candidate v3 runtime from frozen v2.
- The first probe reproduced receipt signing after a valid hidden same-sequence twin.
  The [reviewed design](decisions/2026-09.md#2026-09-27--check-the-complete-signing-history-before-succession)
  checks raw signed records separately from the unchanged held-record selection.
- The journal guard and regressions are implemented. Design review required a live-only
  stability check before each adoption receipt; historical replay retains exact replies.
  All 26 focused tests and typecheck passed; added restart assertions passed separately.
  Independent integrated adversarial review found no blockers.
- Source-bound synthetic journal and local/synthetic recovery acceptance passed;
  all three reports are refreshed. The seven current reports below pass source checks.
  Other drifted reports remain historical; no live evidence was re-recorded.
- Full checks and proof suites are merge gates in PR #25. Inspect its CI and
  merge state before resuming dependent work. No circuit change or local job remains.

## Evidence
- Delivered slice 3: shared ordinary/recovery transitions, complete bounded ancestry,
  single-backing demand/settlement, force, exact witnessed return/adoption, receipt reads,
  non-service counting and kind-4 Ergo publication. Independent review and real-proof
  local/synthetic/live acceptance passed at the [delivered revision](https://github.com/mediumofexchange/reference-ts/tree/a72888b).
- Current reader-only reports (sources unchanged by the journal guard):
  [replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json) and
  [runtime venue](docs/ergo-runtime-venue-verification.json).
- Refreshed current [journal](docs/pool-v3-store-verification.json),
  [local recovery](docs/pool-v3-recovery-store-verification.json),
  [synthetic Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json).
- Live recovery remains historical at [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json);
  prior slice-2 live journal/publisher reports remain historical at `2c6b20c`.
  No new live run is authorized. Testnet header evidence remains current and unchanged.

## Next
1. Verify the signing-safety PR's required CI and delivery state before dependent work;
   keep held selection separate from evidence of key conflict.
2. Succession: authorized replacement to a distinct key, exact takeover, earlier finality,
   old-key authority ending at force and unavailable-evidence refusal. Incumbent-self
   replacement cancels a pending handover; kind-3 revocation stops late K issuance.
   First probe: A→B with two journals, B reading only A's public package and the venue.
   Reuse the reader; retain imported ancestry, derive B's exact term and keep B's own
   signed counter. Review empty-book handling and pending-opening/adoption before coding.
   Port corresponding `import-check`/`fault-check` cases through the runtime reader.
3. Persistence: venue headers/objects beyond retainedBytes, prune side branches, publisher
   outbox, restart drills; replace full-range reads with a cursor retaining non-held records.
4. V3 wallet/service (C4.1–2 requests/funding disclosure), retire v2; then multi-backing.
5. Configuration adoption: parameter provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
6. Complete trails permit roughly 67 repeated spend-sized records in 1 MiB with existing
   dependencies (size-only probe); lifetime streaming verification remains a separate design.
7. On touching affected files: byte predicates/codecs → shared byte helpers; caller ownership;
   Ergo section-vs-transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache. Check v3 successors for v2 intake issues.
8. Only when a gate needs them: abandoned publication cancellation, batching, index-free box
   source, venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/`, `jdk/` and `ergo-headers/` under scratch.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Keep active verification logs until retained. Delete slice scratch only after delivery;
  preserve legacy Temp/moeclean. Node management remains authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous recovery
  need separate provisioning authority. Configuration approval and mainnet remain disabled.

## Open questions
- No unresolved signing-safety review findings; required CI/delivery is tracked by the PR.
- No normative specification change or companion branch is needed for this prerequisite.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27:
single-backing recovery shares reviewed runtime transitions and independent real-proof readers.
Replacement, configuration adoption, persistence, wallet custody and mainnet remain.
