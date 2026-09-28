# Current work

Updated: 2026-09-28

## Goal
Slice 6d on `feat/v3-request-exchange` (no companion branch or normative
change): a receiver's exact v3 payment request (pool-delivery C4.1) passes to
the payer as one canonical 246-byte frame (`moe/wallet/v3/request`), accepted
only when its SHA-256 equals a digest obtained independently from the
receiver. V3 needs no receiver endpoint, credential, capability or inbox: the
payee's output and capsule are public and `fulfill` finds the payment
([decision](decisions/2026-09.md#2026-09-28--exchange-v3-payment-requests-as-digest-authenticated-frames-without-a-receiver-endpoint)).
Acceptance: every single-byte change and noncanonical frame refuses; a
substituted well-formed request refuses against the receiver's digest; the
authenticated request is paid and fulfilled; v2 pairing/delivery cases are
mapped in the [wallet guide](docs/POOL_V3_WALLET.md#request-exchange). Stop
boundary: no network transport, signing identity, fee quotes, text/QR form,
receipt handoff for pending acceptance, backup or real-proof harness change.

## Status
- Commits `7b527c4` (frame, digest, tests), `56f1727` (docs, decision, case
  map) and the review-fix commit. Independent adversarial review found no
  blocker/major; four minor findings resolved: display reads return terms
  without the capsule (`prepare` refuses them, tested), and the guide states
  self-digest limits, full machine comparison, fee requests and first-payment
  griefing. The tag stays beside its codec (tested prefix-free against
  `contexts.ts`), so the six current reports keep their bound shared sources.
- Focused tests pass locally: 4 frame cases, 17 payer cases, typecheck. Only
  the journal report binds a changed source (`wallet-request.ts`); it is
  re-recorded from the Linux `--ergo` CI artifact before merge.

## Evidence
- Wallet API, custody preconditions, reproof and payment limits: [guide](docs/POOL_V3_WALLET.md).
  Published-but-not-yet-effective handovers are not predicted; reproof resolves them.
- Service API and interrupted-operation limits: [guide](docs/POOL_V3_SERVICE.md).
- Persistence design and scalability plan:
  [decision](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox);
  full checkpoints still rewrite retained history and raw sections stay in memory.
- Current reports: [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json),
  [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json) and
  [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json).
  Live recovery is historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal at `2c6b20c`; header and mainnet reader reports at `6e4cea8`.

## Next
1. Continue slice 6: encrypted v3 wallet backup and restoration drills; port the
   frozen v2 backup cases (v2 pairing/delivery cases are mapped). Same-segment
   tail repair (C2.10.9a resubmission) and release of never-admitted inputs stay
   with cancellation in item 6 until a gate needs them.
2. Retire v2 only after its wallet/service cases pass on v3; then
   multi-backing including compact fault orchestration (slice 7).
3. Configuration adoption: provenance, ACIR identities/certificates, replay/import
   bounds, one-transaction condition and BN254 margin. Mainnet needs separate authority.
4. Complete trails fit roughly 67 repeated spend-sized records in 1 MiB with
   existing dependencies (size-only probe); lifetime streaming is separate design.
5. On touching affected files: `local-replay.mjs` candidates should call
   `holdings.ts` (re-records six reports); fold `fulfill` into `sync`; shared
   byte helpers/caller ownership; Ergo section versus transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache. Check v3 successors for v2 intake issues.
6. Only when a gate needs them: cancellation, batching, index-free box source,
   venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding; operator fee quotes,
   a text/QR form of the request frame, receipt handoff for C4.5 pending
   acceptance, and routing store-check's request through the frame.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/`, `jdk/` and `ergo-headers/` under scratch.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- Keep active verification logs until retained. Delete slice scratch after delivery;
  preserve legacy Temp/moeclean. Node management remains authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous
  recovery need separate provisioning authority. Configuration/mainnet remain disabled.

## Open questions
- No service delivery blocker remains. Server timeout followed by eventual
  journal completion has source review, without a direct timed acceptance case.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **60% done / 40% remaining**, plausible range **50–70%**, reassessed 2026-09-28.
Payer custody and reproof add the ordinary payment path, within that rounding;
configuration adoption, transport/backup, multi-backing runtime,
qualified deployment storage and mainnet remain.
