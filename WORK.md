# Current work

Updated: 2026-09-25

## Goal

Next 1, M1b (M0, M1a done), new branch: `src/pool/v3/state.ts` (one §5 step, the plan's
modes), `RecordVenue`, promoted `FixtureVenue` and single-segment reader (`replayTrail`,
`classifyCarrying`), which `local-replay.mjs` calls instead of its own, layering
imports/scopes/recovery until slices 3/7; drop the `CodecEncodingError` alias.
Acceptance: mode and promoted hostile cases pass, initial-segment groups re-record
through `src/` unchanged, venue refusals tested. Stop: no M2 journal/prover/guard.

## Status

- Ergo ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue), spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)):
  `ErgoVenue` verifies headers and sections itself; `ErgoPublisher` publishes kinds
  1–3, one remembered transaction per record. Testnet only; nothing persisted.
- [Neutral core](decisions/2026-09.md#2026-09-25--give-v3-a-construction-neutral-core-before-it-enters-src)
  (`venue-records.ts`, `venue-error.ts`, `pool/proof-verifier.ts`; synthetic reference
  context above a difficulty-1 anchor) and [v3 library](decisions/2026-09.md#2026-09-25--promote-v3s-codecs-spent-root-and-capsule-library-into-srcpoolv3)
  (`src/pool/v3/`: eight codecs, spent root, C4 capsules; scripts read `dist/`),
  pinned by `test/neutral-core.test.ts`. `check:evidence` lists moved bound files.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Vendored sigma-rust 2f840d3 release build for `publish.mjs`, fixture trees and cross-checks
  (Rust 1.87 + wasm-bindgen 0.2.128 in `~/.cargo`; keep `scratch/rust-toolchain`, `scratch/sigma-rust-src`).
- Testnet wallet: ignored `scratch/ergo-testnet/wallet.json` (~19,999.90 tERG, copy outside
  the repo), no approval needed; `--resume` on `run-framer.json` re-reads P2 unsubmitted.

## Evidence

- [Publisher on the testnet](docs/ergo-publisher-verification.json) (09-25): three records
  chained, corrupted proofs refused, a lost answer retried without a second transaction.
- [Runtime venue on the mainnet](docs/ergo-runtime-venue-verification.json) (09-25):
  300 real headers and 290 sections, same answers from a public node alone.
- Re-recorded 09-25, verdicts unchanged: [headers](docs/ergo-header-verification.json), [range](docs/ergo-range-profile-verification.json),
  [P4](docs/ergo-chain-cost-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json), [v2](docs/pool-v2-verification.json) (M0);
  [P2](docs/ergo-publication-verification.json), [v3 replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json), [restoration](docs/pool-restoration-evidence-verification.json) (M1a).

## Next

[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(each slice's acceptance and stop): v3 beside a frozen v2, one moded state machine and one
reader over §13 answers; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0, M1a (library) done; M1b
   state machine, `RecordVenue`, single-segment reader; M2 prover, journal.
   M2's guard accepts the candidate only through `ErgoVenue` or `FixtureVenue`,
   never on `ergoRangeVerifier`'s caller-selected headers alone.
2. Testnet venue: header rules (probe the own node first), identity
   `moe/venue/ergo-testnet/reference`, a live supply check; move the publisher
   check and P2 (venue-ergo's context over a testnet anchor today) onto it.
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
9. Hygiene when touching the files: `check:evidence` binds only file-named keys (P2's
   wasm hash, fees' `*Sha256`); `ByteReader`, `ByteWriter.fixed` and v3 `records.ts`
   `requireBytes` trust a subclass's `length`/iterator (the capsule digest lost that
   hardening in M1a; wallet capsules reach it in slice 6, which also retests a fresh
   request id after journal loss); local `npm test` hits vitest's "Timeout calling
   onTaskUpdate" while both nodes run (CI gates); readers re-read `args.configuration`/`verifier`. v2 items
   (`inspectNotes`, replay `statements.slice`, `activate`, `submit` journal
   reload, v1 store codec, `bytecode(k)` gzip): check v3 successors.
10. Later, off the release path: cancelling an abandoned publication, batched records, an
   index-free box source, a venue-moving record (C2.3.1), the slowest-supplier clock, devnet
   mid-epoch versions, faster Blake2b, a multi-entry extension fixture, Poseidon2 on
   Barretenberg, a warmed verifier, sponsored holder funding, retiring the F4 fee probe.

## Retained boundaries and local state

- Configured v2: local real-proof payments, private delivery, public audit. [Device contract](docs/POOL_WALLET_DEVICE.md), [observations](docs/pool-wallet-device-verification.json):
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

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed 2026-09-25
(direction check): the runtime reads and publishes on a witness it verifies itself; moving
claims, store and wallet to v3, recovery, adoption, persistence, custody and mainnet dominate.
