# Current work

Updated: 2026-09-27

## Goal
Slice 4's single-backing compact fault-package orchestration is complete at the
reference-venue boundary; delivery is [PR #27](https://github.com/mediumofexchange/reference-ts/pull/27).
Implementation `238b418`, acceptance corrections through `ededc97`, from `e8cf7e5`.
Both runtime package readers accept kind-7 evidence using the shared observer. Exact proof/issue-K
rejection can replace only a non-opening target trail after complete dependency
resolution; full and compact reads agree on state and classification, hostile/missing
evidence refuses, selected envelopes stay complete, and recovery/adoption boundaries
remain enforced. Independent design and integrated review passed.
Stop at the single-backing reference boundary: no persistence, second backing,
configuration adoption or new live runs.

## Status
- Succession delivered in [PR #26](https://github.com/mediumofexchange/reference-ts/pull/26)
  at `e8cf7e5`; all seven post-merge CI jobs passed.
- Typecheck and 19 focused frontier tests pass. Independent review found no runtime
  blocker; frontier negative recovery coverage and explicit single-backing scope
  refusals were added to acceptance and independently read back.
- All seven full reference and pool-v2/v3 proof jobs passed for `ededc97` in
  [CI](https://github.com/mediumofexchange/reference-ts/actions/runs/36347810739).
  Both public APIs pass local/synthetic real-proof import and recovery cases.
  A disposable oracle probe also passed; it is not proof evidence.
- Affected reports are refreshed from that passing Linux artifact; nine report
  binding checks pass. Final changes only retain reports and update documentation;
  runtime/check inputs reuse the passing baseline. No active local job or companion
  branch. Inspect PR #27 for its merge revision and post-merge CI when resuming.

## Evidence
- Current succession: [local](docs/pool-v3-succession-store-verification.json) and
  [synthetic Ergo](docs/pool-v3-succession-store-ergo-verification.json). The real-proof
  drill adopts an empty block; focused tests cover nonempty adoption and term races.
- Delivered slice 3: shared ordinary/recovery transitions, complete bounded ancestry,
  single-backing demand/settlement, force, exact witnessed return/adoption, receipt reads,
  non-service counting and kind-4 Ergo publication. Independent review and real-proof
  local/synthetic/live acceptance passed at the [delivered revision](https://github.com/mediumofexchange/reference-ts/tree/a72888b).
- Current reader reports (refreshed from the passing Linux CI artifact where affected):
  [replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json) and
  [runtime venue](docs/ergo-runtime-venue-verification.json).
- Current [journal](docs/pool-v3-store-verification.json),
  [local recovery](docs/pool-v3-recovery-store-verification.json),
  [synthetic Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json).
- Live recovery remains historical at [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json);
  prior slice-2 live journal/publisher reports remain historical at `2c6b20c`.
  No new live run is authorized. Testnet header evidence remains current and unchanged.

## Next
1. Persistence: begin with a synthetic venue restart probe that reproduces the exact
   witnessed view from retained headers/objects, then continues sync. Reuse the owning
   store's durable outbox for publisher state; exercise mid-sync/mid-publication restart
   and exact retry. Plan side-branch pruning, data beyond retainedBytes and a cursor
   retaining non-held records. Slice 5 stops before wallet redesign.
2. Keep compact multi-backing orchestration with the existing slice-7 scope port.
3. V3 wallet/service (C4.1–2 requests/funding disclosure), retire v2; then multi-backing.
4. Configuration adoption: parameter provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
5. Complete trails permit roughly 67 repeated spend-sized records in 1 MiB with existing
   dependencies (size-only probe); lifetime streaming verification remains a separate design.
6. On touching affected files: byte predicates/codecs → shared byte helpers; caller ownership;
   Ergo section-vs-transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache. Check v3 successors for v2 intake issues.
7. Only when a gate needs them: abandoned publication cancellation, batching, index-free box
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
- No unresolved compact-fault review findings.
- No normative specification change or companion branch is currently proposed.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-27:
Single-backing succession and compact fault orchestration share reviewed public proof readers.
Configuration adoption, persistence, wallet custody, multi-backing runtime and mainnet remain.
