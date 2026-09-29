# Current work

Updated: 2026-09-29

## Goal
Slice 8 (adoption), reordered by the
[direction check](decisions/2026-09.md#2026-09-29--decide-lifetime-evidence-before-adoption-then-ship-installable-commands).
Next run: M5 lifetime evidence and resource bounds (Next 1); state its acceptance here.

## Status
- M3 (PR #46, [decision](decisions/2026-09.md#2026-09-29--pin-the-relation-sources-final-text)):
  circuit sources carry final text (comments only; bytecode, keys and configuration
  unchanged); manifest, `V3_SPECIFICATION` and README pin spec `85655a5`. M2 (PR #45):
  `startBackend` loads only hash-checked parameters. Reports from CI run 36519561119.
- Direction check (docs only): every reader holds one complete package in memory under
  fixed 1 MiB limits, so a pool serves about 67 spend-sized statements over its life;
  deciding that model can add a relation, so it now precedes the pin. No `bin` exists.

## Evidence
- Guides: [wallet](docs/POOL_V3_WALLET.md), [service](docs/POOL_V3_SERVICE.md), [persistence](decisions/2026-09.md#2026-09-27--persist-reproducing-venue-evidence-and-the-owning-journals-publication-outbox)
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
1. Slice 8, adoption, [reordered](decisions/2026-09.md#2026-09-29--decide-lifetime-evidence-before-adoption-then-ship-installable-commands):
   **M5 first**: declare a target scale and per-party budgets (operator, reader,
   wallet first sync/steady state, holder recovery package); decide complete replay
   behind a streaming disk-backed reader/journal with resumed verification versus a
   succinct history relation (a configuration change, so built before M8); record
   bounds and the replay/import consolidation. Probe only numbers the cost model lacks.
   Then M6 Next 5(i) (confirm a host rule), M4 certificates/kind-11 fitted to the
   retention model, M7 one-transaction condition, M8 adoption (one manifest holding
   §11.1's parameter identities too, now `BN254_PARAMETERS`), every report
   re-recorded, live two-backing drill. Mainnet needs separate authority.
2. Slice 9, installable commands on the testnet: holder wallet, operator service and
   supply reader from a packed install (`bin`), fresh processes and data directories,
   issue → pay → receive → fulfill → redeem and an offline-operator recovery past the
   67-statement ceiling. Close Next 5 (a)–(c), (e) before its drill. Retire the pilot CLI
   and, against a case map, the transparent path in or right after it.
3. Multi-backing leftovers: adding an original-term backing to a live scope; statements
   spending several backings from the wallet; single-backing openings over-reserve by |E|.
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
   package-reader refusals drop the receipt walk's contradictions and fault facts.
   (i) (M6) A settlement publishes its output opening (C3.5), so a backer seeing it before
   witnessing can issue the same `cm_out` first; it is refused `OUTPUT` (`state.ts`) and the
   acceptance may read as the holder's lapse (C3.8). A retry needs a fresh `rho_out` and
   release; each pre-emption costs a visible issuance. The wallet builds no settlements yet.
   (j) Verify-only parties could take identity-checked key bytes, needing no G1 file.
6. Only when a gate needs them: cancellation, batching, index-free box source, venue-moving
   record, slowest-supplier clock, multi-entry extension fixture, Poseidon2 on Barretenberg,
   sponsored holder funding, operator fee quotes, a text/QR request frame, C4.5 pending-
   acceptance receipt handoff, store-check's request through the frame, same-segment rescoping.

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
- No service delivery blocker remains. Server timeout followed by eventual journal
  completion has source review, without a direct timed acceptance case.
- Physical custody remains a separate boundary (disk streaming is now Next 1–2).

Roughly **55% done / 45% remaining**, range **45–65%**, reassessed 2026-09-29 (lifetime evidence
and installable commands were missing from the remainder; adoption, qualified storage, mainnet remain).
