# Current work

Updated: 2026-09-27

## Goal
Slice 4 of the [v3 runtime plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2),
Succession implementation on `feat/v3-succession`, from `7ae61e6`.
Acceptance: distinct-key A→B takeover from signed terms, public packages and witnessed
replacement records alone; preserve exact finalized imports and spend an inherited note.
Prove old authority ends at force, pending replacements grant no authority, missing
evidence refuses, and empty-book handling follows C2.7.3. Witness the new opening and
adopt its exact block before service. Exercise hostile checkpoints, K revocation and
incumbent-self cancellation on local/synthetic Ergo venues with independent readers.
Obtain independent design and integrated adversarial review; run focused tests, full
checks and affected real-proof acceptance, then deliver through checked CI.
Stop: no second backing, persistence, wallet custody or configuration adoption.
Evidence limit: local/synthetic reference venues; earlier live allowances are exhausted.

## Status
- PR #25 merged as `7ae61e6`; seven PR checks and post-merge CI passed, verified
  against GitHub on 2026-09-27. The checkout was clean at startup.
- The signing-safety prerequisite is delivered; raw signed records remain separate
  from held selection. Previous report bindings need refreshing after the reader changes.
- Succession design review accepted the shared frontier and exact-link authority.
  Runtime and local/synthetic acceptance script are implemented; focused reader,
  journal and recovery tests pass. Integrated review found a checkpoint reservation
  missing the published-but-unwitnessed checkpoint; the reviewed fix covers admission,
  takeover, return and adoption. Boundary regressions and required CI remain.
  Local and synthetic Ergo real-proof succession passed; fresh public-only readers
  agree. No active local job or companion branch exists. Logs remain until delivery.

## Evidence
- Current succession: [local](docs/pool-v3-succession-store-verification.json) and
  [synthetic Ergo](docs/pool-v3-succession-store-ergo-verification.json). The real-proof
  drill adopts an empty block; focused tests cover nonempty adoption and term races.
- Delivered slice 3: shared ordinary/recovery transitions, complete bounded ancestry,
  single-backing demand/settlement, force, exact witnessed return/adoption, receipt reads,
  non-service counting and kind-4 Ergo publication. Independent review and real-proof
  local/synthetic/live acceptance passed at the [delivered revision](https://github.com/mediumofexchange/reference-ts/tree/a72888b).
- Prior reader reports, awaiting refreshed source bindings for this slice:
  [replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json) and
  [runtime venue](docs/ergo-runtime-venue-verification.json).
- Prior [journal](docs/pool-v3-store-verification.json),
  [local recovery](docs/pool-v3-recovery-store-verification.json),
  [synthetic Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json).
- Live recovery remains historical at [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json);
  prior slice-2 live journal/publisher reports remain historical at `2c6b20c`.
  No new live run is authorized. Testnet header evidence remains current and unchanged.

## Next
1. Finish boundary regressions, full CI and refreshed report bindings; deliver succession.
2. Finish slice 4's compact fault-package orchestration in the runtime. Full-trail
   hostile checkpoint classification now works through the journal/public reader;
   compact §9.1 exclusions remain harness-only. Port the corresponding `fault-check`
   cases without weakening complete-evidence requirements or selected envelopes.
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
- No unresolved signing-safety findings. Succession review and verification are owed.
- No normative specification change or companion branch is currently proposed.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27:
single-backing recovery shares reviewed runtime transitions and independent real-proof readers.
Replacement, configuration adoption, persistence, wallet custody and mainnet remain.
