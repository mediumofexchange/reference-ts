# Current work

Updated: 2026-09-25

## Goal

No slice is open. Take Next 1 (M0 first); copy its acceptance and stop from the plan entry here.

## Status

- Ergo (2026-09-25, [guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue)): `ErgoVenue`
  reads under the selected profile, verifying headers and sections itself
  ([decision](decisions/2026-09.md#2026-09-25--read-ergo-in-the-runtime-only-under-the-selected-profile),
  spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)),
  and publishes kind 1–3 records through `ErgoPublisher` (one funding key,
  one remembered transaction per record, proveDlog on `@noble/curves`)
  ([decision](decisions/2026-09.md#2026-09-25--publish-kind-13-records-on-ergo-from-the-runtimes-own-wallet)).
  Testnet only; nothing persisted across restarts.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Vendored sigma-rust 2f840d3 release build, only for `publish.mjs`, fixture
  trees and cross-checks (Windows-reproducible; Rust 1.87 + wasm-bindgen
  0.2.128 in `~/.cargo`, `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: key in ignored `scratch/ergo-testnet/wallet.json` (~19,999.97
  tERG, copy outside the repo); testnet transactions need no approval;
  `--resume` on `scratch/ergo-testnet/run-framer.json` re-reads P2 unsubmitted.

## Evidence

- [Publisher on the testnet](docs/ergo-publisher-verification.json) (09-25): three records
  chained, corrupted proofs refused, a lost answer retried without a second transaction.
- [Runtime venue on the mainnet](docs/ergo-runtime-venue-verification.json) (09-25):
  300 real headers and 290 sections, same answers from a public node alone.
- Re-recorded 09-25: [headers](docs/ergo-header-verification.json), [range](docs/ergo-range-profile-verification.json),
  [P4](docs/ergo-chain-cost-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json),
  [P2](docs/ergo-publication-verification.json), [v3 replay](docs/pool-v3-local-replay-verification.json), [v2](docs/pool-v2-verification.json).

## Next

[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(2026-09-25, each slice's acceptance and stop): v3 in `src/pool/v3/` beside a
frozen v2 (no fixes), one moded state machine and one reader over §13 answers
through `RecordVenue`; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0 neutral core
   (commitment/replacement/revocation codecs off frozen modules, a verifier
   that takes its identity table as data); M1 promote the codecs, spent root,
   C4.2–6 library, state machine and single-segment reader; M2 prover and v3
   operator journal. Proof: issue→pay (fee, capsules)→burn, a seedless reader.
2. Testnet venue: header rules (probe the own node first), identity
   `moe/venue/ergo-testnet/reference`, a live supply check.
3. Redemption and failure path, single backing: under service first, then
   silence, force, snapshot redemption, return/adoption, non-service count,
   kind-4 runs; testnet drills, the reader using only the holder's package.
4. Succession, hostile operator: replacement/takeover, equivocation, key compromise.
5. Persistence: `ErgoVenue` headers/objects (spill past `retainedBytes`, prune
   side branches below the clock); publisher memory in the owning outbox.
6. v3 wallet and service (C4.1–2 requests, funding disclosure); retire v2.
7. Multi-backing: scope classification/recovery, counts, receipts.
8. Adoption, pool-v3 §1: identities with parameter provenance, ACIR identities
   and refusal checks via `constraints.mjs` (`v3/check.mjs:121`,
   `fees/check.mjs:158`, `delivery/binding/check.mjs:89`), certificates,
   replay/import rules, bounds, one-transaction condition. Mainnet needs funds.
9. Hygiene when touching the files: `check:evidence` binds only file-named keys
   (P2's wasm hash), skips vanished files; generators should hash sources at
   start; own-node/replay-cost reports drift; `ByteReader` trusts a subclass's
   `length`; readers re-read `args.configuration`/`verifier`. v2 items
   (`inspectNotes`, replay `statements.slice`, `activate`, `submit` journal
   reload, v1 store codec, `bytecode(k)` gzip): check v3 successors.
10. Later, off the release path: cancelling an abandoned publication, batched
   records, an index-free box source, a venue-moving record (C2.3.1), the
   slowest-supplier clock, devnet mid-epoch versions, faster Blake2b, a
   multi-entry extension fixture, Poseidon2 on Barretenberg, a warmed
   verifier, sponsored holder publication funding.

## Retained boundaries and local state

- Configured v2 has local real-proof payments, private delivery and public audit;
  digest authentication is modeled; offline handoff freezes the source.
- [Device contract](docs/POOL_WALLET_DEVICE.md), [observations](docs/pool-wallet-device-verification.json):
  preflight fails; qualified hardware, theft/power-loss/backup drills and
  continuous recovery require separate provisioning authority.
- Retain the stopped contained-sync node’s detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches; do not delete it or allocate another. Keep the cached node
  responses of P4 (`scratch/ergo-chain/`) and headers (`scratch/ergo-headers/`); reports hold their digests.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and mainnet publication too.

## Open questions

None.

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed
2026-09-25 (direction check): the runtime reads and publishes on a witness it
verifies itself; moving claims, store and wallet to v3, runtime recovery,
adoption, persistence, custody and mainnet operation dominate.
