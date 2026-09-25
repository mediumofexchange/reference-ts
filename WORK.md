# Current work

Updated: 2026-09-25

## Goal

Next 1, M2 (M0, M1a, M1b done), new branch, per the [plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)'s
slice 1: `src/pool/v3/prover.ts` (noir_js witness + bb.js, optional peers, reviewed pin), a
v3 operator journal `src/pool/v3/store.ts` on PoolStore's SQLite pattern (genesis opening
only; admits issue, 2-in/4-out spend with fee output and capsules, burn through
`state.ts`'s new admission mode; commits directories, snapshots, receipts; serves §12
packages), `RecordVenue.publishRecord` (kinds 1–3; `FixtureVenue`, `ErgoVenue`'s
publisher), and the candidate guard (identity recomputed under
`moe/venue/{local,ergo-synthetic}/reference`; mainnet refused). Acceptance: issue 10,
pay 7 with fee and change, burn, all through the store; a fresh seedless process verifies
supply from the package via `FixtureVenue` and `ErgoVenue` (synthetic, pinned); a harness
receiver restores from its seed; guard refusals tested. Stop: no imports or recovery kinds.

## Status

- [v3 state machine and reader](decisions/2026-09.md#2026-09-25--promote-the-v3-state-machine-and-single-segment-reader-and-read-ergo-only-through-ergovenue)
  in `src/pool/v3/` (`state.ts` replay/adoption modes, `reader.ts`, `recovery.ts`),
  `RecordVenue`/`FixtureVenue` in `src/record-venue.ts`; the harness layers imports,
  scopes, receipts, force and counts over them. One Ergo reader: `ErgoVenue` (the replay
  reads the synthetic chain, `src/ergo-synthetic.ts`, pinned by the reader).
- Ergo ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue), spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)):
  `ErgoVenue` verifies headers and sections itself; `ErgoPublisher` publishes kinds
  1–3, one remembered transaction per record. Testnet only; nothing persisted.
- Own nodes (approved): `nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Testnet wallet: ignored `scratch/ergo-testnet/wallet.json` (~19,999.89 tERG, copy outside
  the repo), no approval needed.

## Evidence

- Re-recorded 09-25 with M1b, verdicts unchanged: [v3 replay](docs/pool-v3-local-replay-verification.json) (227 checks, 65
  real proofs, Ergo groups through `ErgoVenue`), [runtime venue](docs/ergo-runtime-venue-verification.json), [publisher](docs/ergo-publisher-verification.json),
  [headers](docs/ergo-header-verification.json), [restoration](docs/pool-restoration-evidence-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json)
  (its owed re-run, nodes stopped). Unchanged since M0/M1a: [v2](docs/pool-v2-verification.json), [conformance](docs/pool-v3-conformance-verification.json).
- Historical (retired probes, sources at 1b4857a): P4, P2, range profile, F3, F4, latency, own node.

## Next

[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(each slice's acceptance and stop): v3 beside a frozen v2, one moded state machine and one
reader over §13 answers; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0, M1a, M1b done; M2 prover, journal,
   admission mode, `publishRecord`, guard (the Goal).
2. Testnet venue: header rules (probe the own node first), identity
   `moe/venue/ergo-testnet/reference`, a live supply check; move the publisher
   check (venue-ergo's context over a testnet anchor today) onto it.
3. Redemption and failure path, single backing: under service first, then
   silence, force (a `state.ts` mode; decide its check order), snapshot redemption,
   return/adoption, non-service count, kind-4 runs; testnet drills, holder's package only.
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
   onTaskUpdate" while both nodes run (CI gates); readers re-read `args.configuration`/`verifier`;
   `ErgoVenue` charges section bytes, not transaction count; `applyRecord`'s history check
   follows its effects; `served-trail.ts` caches by caller trail object. v2 items
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

None.

Roughly **50% done / 50% remaining**, plausible range **40–60%**, reassessed 2026-09-25
(direction check): the runtime reads and publishes on a witness it verifies itself; moving
claims, store and wallet to v3, recovery, adoption, persistence, custody and mainnet dominate.
