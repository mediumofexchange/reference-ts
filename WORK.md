# Current work

Updated: 2026-09-25

## Goal

Next 1, M1b (M0, M1a done), new branch: `src/pool/v3/state.ts` (one §5 step, the plan's
modes), `RecordVenue`, promoted `FixtureVenue` and single-segment reader (`replayTrail`,
`classifyCarrying`), called by `local-replay.mjs`, layering imports/scopes/recovery until
slices 3/7; drop `CodecEncodingError`. One Ergo reader: `--ergo` reads through `ErgoVenue`
over a verified difficulty-1 chain (builder shared with `test/ergo-chain.ts`); delete
`ergoRangeVerifier`, its evidence types, `replay-venue(-check)` and `replay-fixture.mjs`,
porting their hostile cases ([decision](decisions/2026-09.md#2026-09-25--retire-probes-whose-questions-are-answered)).
Acceptance: mode and promoted hostile cases pass, initial-segment groups re-record through
`src/` unchanged (Ergo groups under `underErgo`), venue refusals tested. Stop: no M2 work.

## Status

- Ergo ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue), spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)):
  `ErgoVenue` verifies headers and sections itself; `ErgoPublisher` publishes kinds
  1–3, one remembered transaction per record. Testnet only; nothing persisted.
- [Neutral core](decisions/2026-09.md#2026-09-25--give-v3-a-construction-neutral-core-before-it-enters-src)
  (`venue-records.ts`, `venue-error.ts`, `pool/proof-verifier.ts`; synthetic reference
  context above a difficulty-1 anchor) and [v3 library](decisions/2026-09.md#2026-09-25--promote-v3s-codecs-spent-root-and-capsule-library-into-srcpoolv3)
  (`src/pool/v3/`), pinned by `test/neutral-core.test.ts`; scripts and probes read `dist/`.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Testnet wallet: ignored `scratch/ergo-testnet/wallet.json` (~19,999.90 tERG, copy outside
  the repo), no approval needed.

## Evidence

- Re-recorded 09-25 after the probe retirement, verdicts unchanged: [v3 replay](docs/pool-v3-local-replay-verification.json) (229 groups, 65 real proofs),
  [runtime venue](docs/ergo-runtime-venue-verification.json), [publisher](docs/ergo-publisher-verification.json),
  [headers](docs/ergo-header-verification.json). [Framer](docs/ergo-framer-hostile-equivalence-verification.json):
  sources it checks unchanged; its re-run with the `dist/` harness is owed (a memory-pressure
  kill stopped it 09-25; run `hostile-equivalence.mjs` alone, nodes stopped). Unchanged since M0/M1a: [v2](docs/pool-v2-verification.json), [conformance](docs/pool-v3-conformance-verification.json), [restoration](docs/pool-restoration-evidence-verification.json).
- Historical (retired probes, sources at 1b4857a): P4, P2, range profile, F3, F4, latency, own node.

## Next

[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(each slice's acceptance and stop): v3 beside a frozen v2, one moded state machine and one
reader over §13 answers; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0, M1a (library) done; M1b state
   machine, `RecordVenue`, one reader; M2 prover, journal, guard (`ErgoVenue`/`FixtureVenue`).
2. Testnet venue: header rules (probe the own node first), identity
   `moe/venue/ergo-testnet/reference`, a live supply check; move the publisher
   check (venue-ergo's context over a testnet anchor today) onto it.
3. Redemption and failure path, single backing: under service first, then
   silence, force, snapshot redemption, return/adoption, non-service count,
   kind-4 runs; testnet drills, the reader using only the holder's package.
4. Succession, hostile operator: replacement/takeover, equivocation, key compromise.
5. Persistence: `ErgoVenue` headers/objects (spill past `retainedBytes`, prune
   side branches below the clock); publisher memory in the owning outbox.
6. v3 wallet and service (C4.1–2 requests, funding disclosure); retire v2.
7. Multi-backing: scope classification/recovery, counts, receipts.
8. Adoption, pool-v3 §1: identities with parameter provenance, ACIR identities
   and refusal checks via `constraints.mjs` (`v3/check.mjs:121`), certificates,
   replay/import rules, bounds, one-transaction condition. Mainnet needs funds.
9. Hygiene when touching the files: `ByteReader`, `ByteWriter.fixed` and v3 `records.ts`
   `requireBytes` trust a subclass's `length`/iterator (the capsule digest lost that
   hardening in M1a; wallet capsules reach it in slice 6, which also retests a fresh
   request id after journal loss); local `npm test` hits vitest's "Timeout calling
   onTaskUpdate" while both nodes run (CI gates); readers re-read `args.configuration`/`verifier`. v2 items
   (`inspectNotes`, replay `statements.slice`, `activate`, `submit` journal
   reload, v1 store codec, `bytecode(k)` gzip): check v3 successors.
10. Later, only when a decision or gate needs it: cancelling an abandoned publication,
   batched records, an index-free box source, a venue-moving record (C2.3.1), the
   slowest-supplier clock, a multi-entry extension fixture, Poseidon2 on Barretenberg,
   sponsored holder funding (devnet versions, faster Blake2b, a warmed verifier dropped).

## Retained boundaries and local state

- Configured v2: local real-proof payments, private delivery, public audit. [Device contract](docs/POOL_WALLET_DEVICE.md), [observations](docs/pool-wallet-device-verification.json):
  preflight fails; qualified hardware, theft/power-loss/backup drills and
  continuous recovery require separate provisioning authority.
- Retain the stopped contained-sync node’s detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` and verified
  parameter/tool caches; do not delete it or allocate another. Keep the cached header
  responses (`scratch/ergo-headers/`); their report holds the digests.
- Preserve the legacy Temp/moeclean worktree (another checkout). Configuration
  approval stays disabled; device qualification and mainnet publication too.

## Open questions

- 2026-09-25, non-blocking: scratch left by the retired probes (their reports keep the
  digests; scripts at 1b4857a). Approve deleting `scratch/ergo-chain/` (P4 responses,
  166 MB), `scratch/sigma-rust-src/` (491 MB), `scratch/rust-toolchain/` (137 MB),
  `scratch/ergo-latency/`, `scratch/ergo-publication/`, and every file in
  `scratch/ergo-testnet/` except `wallet.json`; optionally Rust 1.87 and wasm-bindgen
  in `~/.cargo`. Nothing waits on it.

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed 2026-09-25
(direction check): the runtime reads and publishes on a witness it verifies itself; moving
claims, store and wallet to v3, recovery, adoption, persistence, custody and mainnet dominate.
