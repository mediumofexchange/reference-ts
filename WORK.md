# Current work

Updated: 2026-09-27

## Goal
Slice 2 of the [plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2),
branch `feat/v3-testnet-venue`, based on slice 1's merged `4c42bba` ([PR #22](https://github.com/mediumofexchange/reference-ts/pull/22)).
Implementation at `5ec0302`, [draft PR #23](https://github.com/mediumofexchange/reference-ts/pull/23).
Acceptance: recomputed testnet reference identity; journal publication and fresh seedless supply
verification on the live testnet; publisher check on that profile; hostile header cases, full
checks, affected report bindings and independent adversarial review. Stop before recovery kinds.
Evidence remains reference-only, no adoption or deployment. Node management authorized 2026-09-27;
Testnet `127.0.0.1:9052` restarted and synced. Live transaction acceptance awaits explicit
testnet spending/publication approval after automatic review rejected prior recorded permission.

## Status
- Slice 2: testnet rules/identity, publisher and real-proof journal harness implemented; design and
  integrated sensitive patch passed independent adversarial review. Live acceptance remains open.
- Pinned upstream `23aabead`: 45 s legacy predictor, no EIP-37 clamps, signed-Int prediction
  overflow and terminal difficulty reset; hostile fixtures pass. [Decision](decisions/2026-09.md#2026-09-27--read-the-reference-testnet-through-its-pinned-header-rules).
- All seven [CI jobs at 5ec0302](https://github.com/mediumofexchange/reference-ts/actions/runs/36317592025)
  passed (full checks, v2/v3 real proofs on Linux/Windows). No companion specification branch.
- Ergo ([guide](docs/ERGO_VENUE_PROFILE.md#runtime-venue), spec [01d8db2](https://github.com/mediumofexchange/money-from-first-principles/blob/01d8db2/venue-ergo.md)):
  `ErgoVenue` verifies headers and sections itself; `ErgoPublisher` publishes kinds
  1–3, one remembered transaction per record. Live publisher evidence is testnet-only; memory-only runtime.
- Own nodes: v6.0.6 mainnet snapshot (:9053) and testnet archive/index (:9052), `scratch/ergo-nodes/`.
  Approved launcher `experiments/ergo-range/nodes.mjs`: start/watch via WMI (terminal children die).
- Testnet wallet: `scratch/ergo-testnet/wallet.json` (~19,999.89 tERG; backed up); do not submit yet.

## Evidence
- Current: restoration, live runtime venue and full checks passed locally; testnet reader passed
  1,239 headers and ten recalculations: [testnet headers](docs/ergo-testnet-header-verification.json).
  Journal/replay refreshed from passing Linux CI; extended mainnet headers and framer passed.
  Report homes: [journal](docs/pool-v3-store-verification.json),
  [v3 replay](docs/pool-v3-local-replay-verification.json), [conformance](docs/pool-v3-conformance-verification.json),
  [v2](docs/pool-v2-verification.json), [restoration](docs/pool-restoration-evidence-verification.json),
  [runtime venue](docs/ergo-runtime-venue-verification.json), [publisher](docs/ergo-publisher-verification.json),
  [headers](docs/ergo-header-verification.json), [framer](docs/ergo-framer-hostile-equivalence-verification.json).
- Historical: publisher at `4c42bba` awaits live approval; retired probes at `1b4857a`: P4, P2, range profile, F3, F4, latency, own node.

## Next
[Plan](decisions/2026-09.md#2026-09-25--plan-the-v3-runtime-one-state-machine-and-one-reader-beside-a-frozen-v2)
(each slice's acceptance and stop): v3 beside a frozen v2, one moded state machine and one
reader over §13 answers; the candidate runs only on recomputed reference venue identities.

1. v3 core (one segment, local and synthetic Ergo): M0–M2b done.
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
8. Adoption, pool-v3 §1: identities with parameter provenance, ACIR identities and refusal checks via
   `constraints.mjs` (`v3/check.mjs:121`), certificates, replay/import rules, bounds, one-transaction
   condition, the proof curve's stated margin (BN254: ~100-bit discrete log). Mainnet needs funds.
9. Segment length: a served trail from the opening fits ~68 real-proof records in the reader's
   1 MiB budget (then RESOURCE); decide imports or a served suffix before slice 3's drills.
10. Hygiene when touching the files: the ~10 local byte predicates onto the `bytes.ts` intake (Ergo
   and `record-venue` ones read `.length`/`.buffer` and throw TypeError on a look-alike); the
   hand-parsed v3 codecs (`trail`, `package`, `fault-evidence`, `record-range`) onto ByteReader/
   ByteWriter; readers re-read `args.configuration`/
   `verifier`; `ErgoVenue` charges section bytes, not transactions; `applyRecord`'s history check
   follows its effects; `served-trail.ts` caches by caller trail object; `heldCommitments` hides a
   twin at a held sequence from the journal's CONFLICT check (slice 4). v2 items (`inspectNotes`,
   replay `statements.slice`, `activate`, `submit` reload, v1 store codec, `bytecode(k)` gzip,
   `encodeSpentProof` holes, lenient wallet-restore `BigInt`): check v3 successors.
11. Later, only when a decision or gate needs it: cancelling an abandoned publication, batched records,
   an index-free box source, a venue-moving record (C2.3.1), the slowest-supplier clock, a multi-entry
   extension fixture, Poseidon2 on Barretenberg, sponsored holder funding (devnet versions, faster
   Blake2b, a warmed verifier dropped).

## Retained boundaries and local state
- Configured v2: local real-proof payments, private delivery, public audit. [Device contract](docs/POOL_WALLET_DEVICE.md),
  [observations](docs/pool-wallet-device-verification.json): preflight fails; qualified hardware,
  theft/power-loss/backup drills and continuous recovery require separate provisioning authority.
- Retain the stopped contained-sync node’s detached 20 GiB image
  `scratch/node-source-sync/f2dc2b779ba7441eba7528b01928476d/control.vhd` with its tool caches
  (`node-startup/`, `sync-preparation/`); do not delete it or allocate another. Keep `private-payment-crs/`,
  `jdk/` (the framer probe's javac) and `ergo-headers/` (their report holds the digests).
- Until slice 2 acceptance, retain `scratch/testnet-*` probes, notes, cache, runners and logs.
  All detached verification jobs ended successfully; logs/exit files use `testnet-` prefixes.
  Own nodes remain running. `testnet-live-check.ps1` has never started; no testnet submissions.
- Preserve legacy Temp/moeclean. Configuration approval, device qualification and mainnet stay disabled.

## Open questions
- Await explicit seven-transaction testnet approval, then run publisher followed by journal
  (`scratch/testnet-live-check.ps1`); refresh publisher/journal evidence, finish docs and merge PR #23.

Roughly **55% done / 45% remaining**, plausible range **45–65%**, reassessed 2026-09-27 (M2b):
v3 journal publication and independent supply verification now share the real Ergo
publisher/reader on a synthetic reference chain. Testnet acceptance, runtime recovery, adoption,
persistence, wallet custody and mainnet still dominate; no release gate closed.
