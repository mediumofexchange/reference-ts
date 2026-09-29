# Current work

Updated: 2026-09-29

## Goal
Slice 8 (adoption), M3 source pin delivered (branch `feat/v3-source-pin`). Next run:
M4, complete certificates and kind-11 venue evidence (Next 1): state its acceptance here.

## Status
- M3 ([decision](decisions/2026-09.md#2026-09-29--pin-the-relation-sources-final-text)):
  the seven circuit sources carry final text, citing rules by document and section
  (no "candidate", "PROBE ONLY", "§2.6", "A5"); comments only, so bytecode, keys and
  the configuration are unchanged (local compile reproduced all six bytecode hashes).
  Manifest source hashes updated; manifest, `V3_SPECIFICATION` and the README runtime
  pin are spec `85655a5`, whose tree also names venue-ergo.md for Ergo reports (closes
  former Next 5(d)). One fresh review: nothing material; precision points applied.
  Reports re-recorded from CI run PENDING.
- M2 (PR #45): `startBackend` loads only hash-checked parameters
  ([decision](decisions/2026-09.md#2026-09-29--load-only-hash-checked-proving-parameters)).

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md),
  [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
  (full checkpoints still rewrite retained history; raw sections stay in memory).
- Current reports: [conformance](docs/pool-v3-conformance-verification.json), [journal](docs/pool-v3-store-verification.json),
  [replay](docs/pool-v3-local-replay-verification.json), [recovery](docs/pool-v3-recovery-store-verification.json),
  [Ergo recovery](docs/pool-v3-recovery-store-ergo-verification.json),
  [succession](docs/pool-v3-succession-store-verification.json), [Ergo succession](docs/pool-v3-succession-store-ergo-verification.json),
  [scope](docs/pool-v3-scope-store-verification.json) and [Ergo scope](docs/pool-v3-scope-store-ergo-verification.json).
  Live recovery is historical at
  [a72888b](https://github.com/mediumofexchange/reference-ts/blob/a72888b/docs/pool-v3-recovery-store-testnet-verification.json),
  live journal at `2c6b20c`; header and mainnet reader reports at `6e4cea8`.
  Pool-v2 and its guides/reports: [a020215](https://github.com/mediumofexchange/reference-ts/tree/a020215).

## Next
1. Slice 8, adoption, in the [decided order](decisions/2026-09.md#2026-09-29--order-configuration-adoption-and-state-its-proving-parameters).
   M4 certificates/kind-11, M5 replay/import rules and bounds, M6 Next 5(i), M7
   one-transaction condition, M8 adoption (one manifest holding §11.1's parameter
   identities too, now `BN254_PARAMETERS`), every report re-recorded, live two-backing
   drill. Mainnet needs separate authority.
2. Multi-backing leftovers: adding an original-term backing to a live scope; statements
   spending several backings from the wallet; single-backing openings over-reserve by |E|.
3. Complete trails fit roughly 67 repeated spend-sized records in 1 MiB with
   existing dependencies (size-only probe); lifetime streaming is separate design.
4. On touching affected files: `local-replay.mjs` candidates should call
   `holdings.ts` (re-records six reports); fold `fulfill` into `sync`; shared
   byte helpers/caller ownership; Ergo section versus transaction charging; applyRecord history check follows effects;
   served-trail caller-object cache; drop the explicit `vite` dev pin (served the
   retired browser probe) at the next dependency change. Untested on v3: a second
   commit refused while one is in flight (`store.ts` `ready`; a probe traced it holding);
   `IMPORT_RANK` holds by construction (held commitments arrive in order).
5. Review findings deferred 2026-09-28: (a) `guard.ts` accepts a testnet-context
   profile anchored on a mainnet header, which the header store follows until the next
   epoch boundary (<=127 blocks); `testnet.mjs` checks `/info` network, so only a new
   caller is exposed; fix by a difficulty bound like the synthetic one or a testnet
   context long enough to check its last boundary. (b) `store.ts` `package()` serves a
   published commitment never held after the lag (C2.4.3). (c) `store.ts` `submit` may
   return an old-segment receipt for an adopted forced record (traced only).
   (e) ErgoVenue's side-branch quota never resets. (f) Wallet `prepare`/`reprove` read
   `signed.terms` twice. (g) `journal-crash.mjs` covers only open, submit and commit. (h) Runtime
   package-reader refusals drop the receipt walk's proven contradictions and fault facts
   (the harness keeps them); attach them to the refusal if a runtime caller needs them.
   (i) For the recovery-contract audit (2026-09-29): a settlement publishes its output
   opening (C3.5), so a backer seeing it before witnessing can issue the same `cm_out` first;
   it is refused `OUTPUT` (`state.ts`) and the acceptance may read as the holder's lapse
   (C3.8). A retry needs a fresh `rho_out` and release; each pre-emption costs a visible
   issuance. The runtime wallet builds no settlements yet.
   (j) Verify-only parties could take key bytes checked against the configuration's key
   identities (as the reader workers do) instead of deriving keys, needing no G1 file.
6. Only when a gate needs them: cancellation, batching, index-free box source,
   venue-moving record, slowest-supplier clock, multi-entry extension fixture,
   Poseidon2 on Barretenberg and sponsored holder funding; operator fee quotes,
   a text/QR form of the request frame, receipt handoff for C4.5 pending
   acceptance, routing store-check's request through the frame, and same-segment
   repair/rescoping.

## Retained boundaries and local state
- Own v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052) nodes under
  `scratch/ergo-nodes/`; approved WMI launcher `experiments/ergo-range/nodes.mjs`.
- Keep `scratch/ergo-testnet/wallet.json` (backed up), public
  `pool-v3-testnet-reader/` and `pool-v3-recovery-testnet-reader/` bundles,
  `testnet-header-probe/`, `private-payment-crs/` (G1/G2 cache), `jdk/` and `ergo-headers/` under scratch.
- Retain stopped contained-sync node's 20 GiB
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and
  `node-startup/`, `sync-preparation/` caches; do not allocate another.
- The separate archive node (`C:\Users\Bob\ergo-node`, outside this project) keeps
  syncing as a background job: 3 GB heap, below-normal priority (2026-09-28).
- Keep active verification logs until retained. Delete slice scratch after delivery;
  preserve legacy Temp/moeclean. Node management remains authorized.
- Qualified hardware/device custody, theft/power-loss/backup drills and continuous
  recovery need separate provisioning authority. Configuration/mainnet remain disabled.

## Open questions
- No service delivery blocker remains. Server timeout followed by eventual
  journal completion has source review, without a direct timed acceptance case.
- Disk streaming and physical custody remain separate persistence boundaries.

Roughly **63% done / 37% remaining**, plausible range **53–73%**, reassessed 2026-09-28 (the
multi-backing reader, journal and wallet are in; configuration adoption, qualified storage, mainnet remain).
