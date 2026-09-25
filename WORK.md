# Current work

Updated: 2026-09-25

## Goal

Next 1, **M2b** of the [plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)'s
slice 1 (M0–M2a done), new branch: `ErgoVenue` as a `RecordPublisher` for kinds 1–3 over the
synthetic chain (a mining mempool supplier in `src/ergo-synthetic.ts`), the journal publishing
there under `moe/venue/ergo-synthetic/reference` with its pinned block, and a fresh seedless
process verifying supply through `ErgoVenue`; the guard at the reader's entry (harness
fixtures on `localVenueIdentity` ids, replay report re-recorded once); AGENTS.md direction.
Acceptance: `store-check.mjs --ergo` runs the M2a flow on the synthetic chain; guard
refusals at the reader. Stop: no testnet (slice 2), no recovery kinds.

## Status

- [M2a](decisions/2026-09.md#2026-09-25--admit-commit-and-serve-v3-through-an-operator-journal-proving-in-the-runtime-on-reference-venues-only)
  merged: `src/pool/v3/` `witness.ts`, `prover.ts`, admission in `state.ts`, the journal
  `store.ts` and `guard.ts`; `FixtureVenue` publishes under `localVenueIdentity`.
- Ergo ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue), spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)):
  `ErgoVenue` verifies headers and sections itself; `ErgoPublisher` publishes kinds
  1–3, one remembered transaction per record. Testnet only; nothing persisted.
- Own nodes (approved): `experiments/ergo-range/nodes.mjs` runs official v6.0.6 mainnet (snapshot
  bootstrap, 127.0.0.1:9053) and testnet (archive + index, 127.0.0.1:9052)
  from `scratch/ergo-nodes/`; after a reboot run `nodes.mjs start` and `watch
  10` via WMI `Win32_Process.Create` (an app terminal's children die with it).
- Testnet wallet: ignored `scratch/ergo-testnet/wallet.json` (~19,999.89 tERG, copy outside
  the repo), no approval needed.

## Evidence

- Current: [journal](docs/pool-v3-store-verification.json) (new), and re-recorded with M2a,
  verdicts unchanged: [v3 replay](docs/pool-v3-local-replay-verification.json), [v2](docs/pool-v2-verification.json),
  [restoration](docs/pool-restoration-evidence-verification.json), [runtime venue](docs/ergo-runtime-venue-verification.json).
  Current, drifted only by the lockfile's noir_js peer entry: [publisher](docs/ergo-publisher-verification.json),
  [headers](docs/ergo-header-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json);
  unchanged: [conformance](docs/pool-v3-conformance-verification.json).
- Historical (retired probes, sources at 1b4857a): P4, P2, range profile, F3, F4, latency, own node.

## Next

[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(each slice's acceptance and stop): v3 beside a frozen v2, one moded state machine and one
reader over §13 answers; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0–M2a done; M2b (the Goal).
2. Testnet venue: header rules (probe the own node first), identity
   `moe/venue/ergo-testnet/reference`, a live supply check; move the publisher
   check (venue-ergo's context over a testnet anchor today) onto it.
3. Redemption and failure path, single backing: under service first, then
   silence, force (a `state.ts` mode; decide its check order), snapshot redemption,
   return/adoption, non-service count, kind-4 runs; testnet drills, holder's package only;
   recovery kinds in admission (doors at the horizon), silence terms in the journal.
4. Succession, hostile operator: replacement/takeover, equivocation, key compromise.
5. Persistence: `ErgoVenue` headers/objects (spill past `retainedBytes`, prune
   side branches below the clock); publisher memory in the owning outbox; restart
   drills for the journal; its full-range reads per operation become a cursor.
6. v3 wallet and service (C4.1–2 requests, funding disclosure); retire v2.
7. Multi-backing: scope classification/recovery, counts, receipts.
8. Adoption, pool-v3 §1: identities with parameter provenance, ACIR identities
   and refusal checks via `constraints.mjs` (`v3/check.mjs:121`), certificates,
   replay/import rules, bounds, one-transaction condition. Mainnet needs funds.
9. Segment length: a served trail from the opening fits ~68 real-proof records in the reader's
   1 MiB budget (then RESOURCE); decide imports or a served suffix before slice 3's drills.
10. Hygiene when touching the files: `ByteReader`, `ByteWriter.fixed` and v3 `records.ts`
   `requireBytes` trust a subclass's `length`/iterator; with both nodes running, run vitest
   with `--maxWorkers=2`; readers re-read
   `args.configuration`/`verifier`; `ErgoVenue` charges section bytes, not transaction
   count; `applyRecord`'s history check follows its effects; `served-trail.ts` caches by
   caller trail object; `heldCommitments` hides a twin at an already-held sequence from
   the journal's CONFLICT check (fault evidence, slice 4). v2 items (`inspectNotes`,
   replay `statements.slice`, `activate`, `submit` journal reload, v1 store codec,
   `bytecode(k)` gzip): check v3 successors.
11. Later, only when a decision or gate needs it: cancelling an abandoned publication,
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

Roughly **52% done / 48% remaining**, plausible range **42–62%**, reassessed 2026-09-25
(M2a): the operator now proves, admits, commits, publishes and serves v3 in the runtime,
and an independent process verifies supply from what it serves; the chain venue path,
claims recovery, adoption, persistence, custody and mainnet dominate.
